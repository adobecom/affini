/// Feature-flow derivation: entry-point detection, DFS flow walk, fragility computation.
use crate::callgraph::{CallGraph, CallResolution, FileData, FunctionId, build_call_graph};
use crate::funcs::{extract_functions, RawFunction};
use crate::intent::{Severity, Violation};
use crate::model::{Model, NodeId};
use crate::parse::extract_import_bindings;
use crate::typeshape::{extract_type_decls, normalize, NormCtx, TypeShape, TypeTable};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::Path;

const MAX_DEPTH: u32 = 6;
const MAX_STEPS: u32 = 40;
const MAX_FLOWS: usize = 30;

// ── public API types ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParamShape {
    pub name: String,
    pub optional: bool,
    pub shape: TypeShape,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FragilitySource {
    Metric,
    Type,
    Churn,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FragilityFlag {
    pub source: FragilitySource,
    pub code: String,
    pub message: String,
    pub severity: Severity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowStep {
    pub from: FunctionId,
    pub to: FunctionId,
    pub call_site_order: u32,
    pub callee_text: String,
    /// Contract: the callee's params with normalized types.
    pub params: Vec<ParamShape>,
    /// Contract: the callee's normalized return type.
    pub return_shape: TypeShape,
    pub arg_texts: Vec<String>,
    pub fragility: Vec<FragilityFlag>,
    pub depth: u32,
    pub recursion: bool,
    pub branchy: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FragilitySummary {
    pub total_steps: u32,
    pub fragile_steps: u32,
    pub metric_flags: u32,
    pub type_flags: u32,
    pub churn_flags: u32,
    pub max_severity: Option<Severity>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FlowKind {
    Route,
    Cli,
    Handler,
    PublicApi,
    ExportedEntry,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Flow {
    pub id: String,
    pub name: String,
    pub entry: FunctionId,
    pub entry_module_path: String,
    pub kind: FlowKind,
    pub steps: Vec<FlowStep>,
    pub fragility_summary: FragilitySummary,
    pub truncated: bool,
}

/// Thin summary (returned by /api/flows; full flow by /api/flows/:id).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowSummary {
    pub id: String,
    pub name: String,
    pub entry_module_path: String,
    pub kind: String,
    pub step_count: u32,
    pub fragility_summary: FragilitySummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowsReport {
    pub flows: Vec<FlowSummary>,
    /// Total functions extracted across the repo.
    pub functions: usize,
    /// Total resolved call edges.
    pub resolved_calls: usize,
    /// Total unresolved call edges.
    pub unresolved_calls: usize,
    pub language: String,
}

/// Full report including step details per flow.
#[derive(Debug, Clone, Serialize)]
pub struct FullFlowsReport {
    pub summaries: FlowsReport,
    pub flows: Vec<Flow>,
}


// ── entry-point detection ────────────────────────────────────────────────────

fn detect_entry_points(
    cg: &CallGraph,
    _model: &Model,
    _files: &[FileData],
) -> Vec<(FunctionId, FlowKind)> {
    let mut entries: Vec<(FunctionId, FlowKind, usize)> = Vec::new();

    // Build fan-in for functions (how many resolved edges point to each fn)
    let mut fn_fan_in: HashMap<FunctionId, usize> = HashMap::new();
    for edge in &cg.edges {
        if let CallResolution::Resolved { target } = &edge.callee {
            *fn_fan_in.entry(target.clone()).or_insert(0) += 1;
        }
    }

    // Count resolved outgoing calls per function (flow size proxy)
    let mut fn_out_size: HashMap<FunctionId, usize> = HashMap::new();
    for f in cg.functions.values() {
        let out = cg.resolved_edges_from(&f.id).len();
        fn_out_size.insert(f.id.clone(), out);
    }

    let test_patterns = ["test", "spec", "__tests__", ".test.", ".spec.", "_test.", "_spec."];

    for f in cg.functions.values() {
        // Exclude test files / declaration files
        let path = &f.module_path;
        if test_patterns.iter().any(|p| path.contains(p)) { continue; }
        if path.ends_with(".d.ts") { continue; }

        // Must be exported to be a feature entry point
        if !f.exported { continue; }

        // Must have at least 1 resolved call (otherwise nothing to animate)
        let out = fn_out_size.get(&f.id).copied().unwrap_or(0);
        if out == 0 { continue; }

        let name = &f.display_name;
        let kind = classify_entry(name, path);

        // Score: prefer entries with more resolved outgoing calls (bigger subtree)
        entries.push((f.id.clone(), kind, out));
    }

    // Sort by subtree size descending
    entries.sort_by(|a, b| b.2.cmp(&a.2));

    // Deduplicate: keep top N, prefer one entry per module
    let mut seen_modules: HashSet<NodeId> = HashSet::new();
    let mut result: Vec<(FunctionId, FlowKind)> = Vec::new();

    for (fid, kind, _) in entries {
        // Allow up to 3 entries per module, total cap enforced later
        let count = seen_modules.iter().filter(|&&m| m == fid.module).count();
        if count >= 3 { continue; }
        seen_modules.insert(fid.module);
        result.push((fid, kind));
    }

    result
}

fn classify_entry(name: &str, path: &str) -> FlowKind {
    let name_lower = name.to_lowercase();
    let path_lower = path.to_lowercase();

    if name_lower.contains("route") || name_lower.contains("router")
        || path_lower.contains("route") || path_lower.contains("handler")
        || name_lower.ends_with("handler") || name_lower.ends_with("controller")
    {
        return FlowKind::Route;
    }

    if name == "main" || path_lower.contains("/cli/") || path_lower.contains("/bin/") {
        return FlowKind::Cli;
    }

    if name_lower.contains("handler") {
        return FlowKind::Handler;
    }

    FlowKind::ExportedEntry
}

fn sorted_resolved_edges(
    cg: &CallGraph,
    fid: &FunctionId,
) -> Vec<(u32, FunctionId, String, Vec<String>, bool)> {
    let mut edges: Vec<_> = cg.edges_from(fid)
        .into_iter()
        .filter_map(|e| {
            if let CallResolution::Resolved { target } = &e.callee {
                Some((e.call_site_order, target.clone(), e.callee_text.clone(), e.arg_texts.clone(), e.branchy))
            } else {
                None
            }
        })
        .collect();
    edges.sort_by_key(|(order, _, _, _, _)| *order);
    edges
}

fn flow_id(entry: &FunctionId) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    entry.module.hash(&mut h);
    entry.name.hash(&mut h);
    format!("{:016x}", h.finish())
}

fn derive_flow_name(f: &crate::callgraph::Function) -> String {
    // Convert camelCase / PascalCase / snake_case to human readable
    let name = &f.display_name;
    // Strip class prefix for methods
    let short = name.split('.').last().unwrap_or(name);
    camel_to_words(short)
}

fn camel_to_words(s: &str) -> String {
    let mut words = String::new();
    let mut last_was_upper = false;
    for (i, ch) in s.char_indices() {
        if ch == '_' || ch == '-' {
            words.push(' ');
            last_was_upper = false;
        } else if ch.is_uppercase() {
            if i > 0 && !last_was_upper {
                words.push(' ');
            }
            words.push(ch.to_ascii_lowercase());
            last_was_upper = true;
        } else {
            words.push(ch);
            last_was_upper = false;
        }
    }
    // Capitalize first letter
    let mut chars = words.chars();
    match chars.next() {
        None => String::new(),
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
    }
}

// ── contract shape building ───────────────────────────────────────────────────

fn build_contract_shapes_from_raw(
    rf: &RawFunction,
    module_path: &str,
    module_type_tables: &HashMap<String, TypeTable>,
    module_import_maps: &HashMap<String, HashMap<String, (Option<String>, String)>>,
) -> (Vec<ParamShape>, TypeShape) {
    let empty_types = TypeTable::new();
    let empty_imports = HashMap::new();
    let local_types = module_type_tables.get(module_path).unwrap_or(&empty_types);
    let import_map: HashMap<String, (Option<String>, String)> = module_import_maps
        .get(module_path)
        .unwrap_or(&empty_imports)
        .clone();
    // Convert to the NormCtx import_map format
    let norm_import_map: HashMap<String, (Option<String>, String)> = import_map;

    let ctx = NormCtx::new(local_types, module_type_tables, &norm_import_map);

    let params: Vec<ParamShape> = rf.params.iter().map(|p| {
        let shape = match &p.type_annotation {
            Some(ann) => normalize(ann, &ctx),
            None => TypeShape::Unknown { raw: String::new() },
        };
        ParamShape { name: p.name.clone(), optional: p.optional, shape }
    }).collect();

    let return_shape = match &rf.return_type {
        Some(rt) => normalize(rt, &ctx),
        None => TypeShape::Unknown { raw: String::new() },
    };

    (params, return_shape)
}

// ── fragility computation ─────────────────────────────────────────────────────

fn compute_fragility(
    caller_id: &FunctionId,
    callee_id: &FunctionId,
    params: &[ParamShape],
    return_shape: &TypeShape,
    cg: &CallGraph,
    model: &Model,
    violation_edges: &HashSet<(String, String)>,
    changed_paths: &HashSet<String>,
) -> Vec<FragilityFlag> {
    let mut flags: Vec<FragilityFlag> = Vec::new();

    let from_path = cg.functions.get(caller_id).map(|f| f.module_path.as_str()).unwrap_or("");
    let to_path = cg.functions.get(callee_id).map(|f| f.module_path.as_str()).unwrap_or("");

    let from_id = caller_id.module;
    let to_id = callee_id.module;

    // ── (a) Metric-based ─────────────────────────────────────────────────────

    // SCC cycle: both modules in same SCC with size > 1
    if let (Some(from_m), Some(to_m)) = (model.metrics.get(&from_id), model.metrics.get(&to_id)) {
        if from_m.scc_id == to_m.scc_id && from_m.scc_size > 1 {
            flags.push(FragilityFlag {
                source: FragilitySource::Metric,
                code: "scc_cycle".to_string(),
                message: "This call crosses a circular dependency — both modules are in the same import cycle.".to_string(),
                severity: Severity::Error,
            });
        }

        if to_m.instability > 0.75 {
            flags.push(FragilityFlag {
                source: FragilitySource::Metric,
                code: "high_instability".to_string(),
                message: format!(
                    "Target module instability is {:.0}% — highly unstable modules change often.",
                    to_m.instability * 100.0
                ),
                severity: Severity::Warning,
            });
        }
    }

    // Intent violation crossing this edge
    if violation_edges.contains(&(from_path.to_string(), to_path.to_string())) {
        flags.push(FragilityFlag {
            source: FragilitySource::Metric,
            code: "violation".to_string(),
            message: "This call crosses a boundary declared forbidden in affini.toml.".to_string(),
            severity: Severity::Error,
        });
    }

    // ── (b) Type / contract ───────────────────────────────────────────────────

    for param in params {
        if param.shape.is_untyped() {
            flags.push(FragilityFlag {
                source: FragilitySource::Type,
                code: "any_payload".to_string(),
                message: format!(
                    "Parameter '{}' is typed as `any` or `unknown` — no contract enforcement.",
                    param.name
                ),
                severity: Severity::Warning,
            });
        } else if param.shape.is_missing() {
            flags.push(FragilityFlag {
                source: FragilitySource::Type,
                code: "untyped_boundary".to_string(),
                message: format!(
                    "Parameter '{}' has no type annotation — contract is implicit.",
                    param.name
                ),
                severity: Severity::Warning,
            });
        }
    }

    if return_shape.is_untyped() {
        flags.push(FragilityFlag {
            source: FragilitySource::Type,
            code: "any_return".to_string(),
            message: "Return type is `any` or `unknown`.".to_string(),
            severity: Severity::Warning,
        });
    }

    // ── (c) Churn ─────────────────────────────────────────────────────────────

    if !from_path.is_empty() && changed_paths.contains(from_path) {
        flags.push(FragilityFlag {
            source: FragilitySource::Churn,
            code: "churn_caller".to_string(),
            message: "The calling module has changed since the baseline snapshot.".to_string(),
            severity: Severity::Warning,
        });
    }

    if !to_path.is_empty() && changed_paths.contains(to_path) {
        flags.push(FragilityFlag {
            source: FragilitySource::Churn,
            code: "churn_callee".to_string(),
            message: "The called module has changed since the baseline snapshot.".to_string(),
            severity: Severity::Warning,
        });
    }

    flags
}

fn summarize_fragility(steps: &[FlowStep]) -> FragilitySummary {
    let total = steps.len() as u32;
    let mut fragile = 0u32;
    let mut metric = 0u32;
    let mut type_ = 0u32;
    let mut churn = 0u32;
    let mut max_sev: Option<Severity> = None;

    for step in steps {
        if !step.fragility.is_empty() {
            fragile += 1;
        }
        for f in &step.fragility {
            match f.source {
                FragilitySource::Metric => metric += 1,
                FragilitySource::Type => type_ += 1,
                FragilitySource::Churn => churn += 1,
            }
            match &f.severity {
                Severity::Error => max_sev = Some(Severity::Error),
                Severity::Warning => {
                    if max_sev.is_none() {
                        max_sev = Some(Severity::Warning);
                    }
                }
            }
        }
    }

    FragilitySummary {
        total_steps: total,
        fragile_steps: fragile,
        metric_flags: metric,
        type_flags: type_,
        churn_flags: churn,
        max_severity: max_sev,
    }
}

// ── second pass: enrich flow steps with real contract shapes ─────────────────
// We build a raw function map AFTER constructing CallGraph to populate params/return.

pub fn compute_flows_full(
    model: &Model,
    root: &Path,
    violations: &[Violation],
    changed_paths: &HashSet<String>,
) -> FullFlowsReport {
    // ── 1. Re-extract per-file function data ─────────────────────────────────
    let mut file_data: Vec<FileData> = Vec::new();
    let mut module_type_tables: HashMap<String, TypeTable> = HashMap::new();
    // raw_fn_map: (module_id, fn_name, fn_order) → RawFunction
    let mut raw_fn_map: HashMap<(NodeId, String, u32), RawFunction> = HashMap::new();

    for module in &model.modules {
        if !module.is_file { continue; }
        let abs = root.join(&module.path);
        let source = match std::fs::read_to_string(&abs) {
            Ok(s) => s,
            Err(_) => continue,
        };

        let functions = extract_functions(&module.path, &source).unwrap_or_default();
        let bindings = extract_import_bindings(&module.path, &source).unwrap_or_default();
        let types = extract_type_decls(&source);

        for rf in &functions {
            raw_fn_map.insert((module.id, rf.name.clone(), rf.order), rf.clone());
        }

        module_type_tables.insert(module.path.clone(), types);

        file_data.push(FileData {
            module_id: module.id,
            path: module.path.clone(),
            functions,
            bindings,
        });
    }

    // ── 2. Build call graph ───────────────────────────────────────────────────
    let cg = build_call_graph(root, &file_data, model);

    // ── 3. Import maps for type normalization ─────────────────────────────────
    let module_import_maps: HashMap<String, HashMap<String, (Option<String>, String)>> =
        file_data.iter().map(|fd| {
            let import_map: HashMap<String, (Option<String>, String)> = fd.bindings.iter()
                .map(|b| {
                    let target_path = crate::resolve::resolve(root, &root.join(&fd.path), &b.specifier)
                        .map(|p| p.to_string_lossy().into_owned());
                    (b.local_name.clone(), (target_path, b.imported_name.clone()))
                })
                .collect();
            (fd.path.clone(), import_map)
        }).collect();

    // ── 4. Violation edge set ─────────────────────────────────────────────────
    let violation_edges: HashSet<(String, String)> = violations
        .iter()
        .map(|v| (v.from_path.clone(), v.to_path.clone()))
        .collect();

    // ── 5. Entry points ──────────────────────────────────────────────────────
    let entries = detect_entry_points(&cg, model, &file_data);

    // ── 6. Walk flows with proper contract shapes ────────────────────────────
    let mut flows: Vec<Flow> = Vec::new();

    for (entry_id, kind) in entries.into_iter().take(MAX_FLOWS) {
        let flow = derive_flow_with_contracts(
            &entry_id,
            &kind,
            &cg,
            model,
            &violation_edges,
            changed_paths,
            &module_type_tables,
            &module_import_maps,
            &raw_fn_map,
        );
        flows.push(flow);
    }

    // ── 7. Summaries ─────────────────────────────────────────────────────────
    let total_fns = file_data.iter().map(|f| f.functions.len()).sum();
    let resolved_calls = cg.edges.iter()
        .filter(|e| matches!(e.callee, CallResolution::Resolved { .. }))
        .count();
    let unresolved_calls = cg.edges.len() - resolved_calls;

    let summaries_vec: Vec<FlowSummary> = flows.iter().map(|f| FlowSummary {
        id: f.id.clone(),
        name: f.name.clone(),
        entry_module_path: f.entry_module_path.clone(),
        kind: format!("{:?}", f.kind).to_lowercase(),
        step_count: f.steps.len() as u32,
        fragility_summary: f.fragility_summary.clone(),
    }).collect();

    FullFlowsReport {
        summaries: FlowsReport {
            flows: summaries_vec,
            functions: total_fns,
            resolved_calls,
            unresolved_calls,
            language: "ts/js".to_string(),
        },
        flows,
    }
}

fn derive_flow_with_contracts(
    entry: &FunctionId,
    kind: &FlowKind,
    cg: &CallGraph,
    model: &Model,
    violation_edges: &HashSet<(String, String)>,
    changed_paths: &HashSet<String>,
    module_type_tables: &HashMap<String, TypeTable>,
    module_import_maps: &HashMap<String, HashMap<String, (Option<String>, String)>>,
    raw_fn_map: &HashMap<(NodeId, String, u32), RawFunction>,
) -> Flow {
    let entry_fn = match cg.functions.get(entry) {
        Some(f) => f,
        None => return make_empty_flow(entry, kind),
    };

    let name = derive_flow_name(entry_fn);
    let entry_path = entry_fn.module_path.clone();

    let mut steps: Vec<FlowStep> = Vec::new();
    let mut visited: HashSet<FunctionId> = HashSet::new();
    visited.insert(entry.clone());
    let mut truncated = false;

    // Stack: (caller_id, remaining_edges, depth)
    let mut stack: Vec<(FunctionId, Vec<(u32, FunctionId, String, Vec<String>, bool)>, u32)> = Vec::new();
    stack.push((entry.clone(), sorted_resolved_edges(cg, entry), 0));

    while let Some((caller_id, mut remaining, depth)) = stack.pop() {
        if remaining.is_empty() { continue; }

        let (call_order, callee_id, callee_text, arg_texts, branchy) = remaining.remove(0);
        if !remaining.is_empty() {
            stack.push((caller_id.clone(), remaining, depth));
        }

        if steps.len() as u32 >= MAX_STEPS {
            truncated = true;
            break;
        }

        let is_recursion = visited.contains(&callee_id);

        // Build contract shapes from raw function data
        let (params, return_shape) = if let Some(rf) = raw_fn_map.get(&(callee_id.module, callee_id.name.clone(), callee_id.order)) {
            let callee_module_path = cg.functions.get(&callee_id)
                .map(|f| f.module_path.as_str())
                .unwrap_or("");
            build_contract_shapes_from_raw(rf, callee_module_path, module_type_tables, module_import_maps)
        } else {
            (vec![], TypeShape::Unknown { raw: String::new() })
        };

        let fragility = compute_fragility(
            &caller_id,
            &callee_id,
            &params,
            &return_shape,
            cg,
            model,
            violation_edges,
            changed_paths,
        );

        steps.push(FlowStep {
            from: caller_id.clone(),
            to: callee_id.clone(),
            call_site_order: call_order,
            callee_text,
            params,
            return_shape,
            arg_texts,
            fragility,
            depth,
            recursion: is_recursion,
            branchy,
        });

        if !is_recursion && depth + 1 < MAX_DEPTH {
            visited.insert(callee_id.clone());
            let callee_edges = sorted_resolved_edges(cg, &callee_id);
            if !callee_edges.is_empty() {
                stack.push((callee_id, callee_edges, depth + 1));
            }
        }
    }

    let fragility_summary = summarize_fragility(&steps);

    Flow {
        id: flow_id(entry),
        name,
        entry: entry.clone(),
        entry_module_path: entry_path,
        kind: kind.clone(),
        steps,
        fragility_summary,
        truncated,
    }
}

fn make_empty_flow(entry: &FunctionId, kind: &FlowKind) -> Flow {
    Flow {
        id: flow_id(entry),
        name: entry.name.clone(),
        entry: entry.clone(),
        entry_module_path: String::new(),
        kind: kind.clone(),
        steps: vec![],
        fragility_summary: FragilitySummary {
            total_steps: 0, fragile_steps: 0,
            metric_flags: 0, type_flags: 0, churn_flags: 0,
            max_severity: None,
        },
        truncated: false,
    }
}

