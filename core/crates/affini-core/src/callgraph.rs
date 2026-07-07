/// Build a function-level call graph from per-module extracted data.
///
/// Resolution v1 scope:
///   • Same-file top-level function names → Resolved
///   • Direct named/default/namespace imports (1 hop) → Resolved if target exports the name
///   • One re-export hop via EdgeKind::Reexports
///   • Everything else → typed unresolved variant (not traversed but recorded)
use crate::funcs::{RawCall, RawFunction};
use crate::model::{EdgeKind, Model, NodeId};
use crate::parse::ImportBinding;
use crate::resolve::resolve;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

// ── public types ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct FunctionId {
    pub module: NodeId,
    /// "Foo.method" for class methods, plain name otherwise.
    pub name: String,
    /// Source-order index within the module (tie-breaker for name collisions).
    pub order: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Function {
    pub id: FunctionId,
    pub module: NodeId,
    pub module_path: String,
    pub display_name: String,
    pub exported: bool,
    pub is_method: bool,
    pub class_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CallResolution {
    /// Resolved to a known function in this or another module.
    Resolved { target: FunctionId },
    /// Callee name is a local variable/param, not a known top-level function.
    UnresolvedLocal,
    /// Callee came from an import but the target module/export wasn't found.
    UnresolvedImported,
    /// Bare specifier (node_modules / external library).
    External,
    /// Computed member / dynamic dispatch.
    Dynamic,
    /// Method call on a value whose type we don't track.
    Method,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallEdge {
    pub caller: FunctionId,
    pub callee: CallResolution,
    pub callee_text: String,
    pub call_site_order: u32,
    pub arg_texts: Vec<String>,
    pub branchy: bool,
    /// Index of the most-specific enclosing branch block within the caller's body.
    /// Matches `RawCall.branch_id`.  Two calls sharing the same `branch_id` are
    /// siblings inside the same conditional/loop block.
    #[serde(default)]
    pub branch_id: Option<u32>,
}

#[derive(Debug, Clone, Default)]
pub struct CallGraph {
    pub functions: HashMap<FunctionId, Function>,
    pub edges: Vec<CallEdge>,
}

// ── per-file input ────────────────────────────────────────────────────────────

pub struct FileData {
    pub module_id: NodeId,
    pub path: String,
    pub functions: Vec<RawFunction>,
    pub bindings: Vec<ImportBinding>,
}

// ── builder ──────────────────────────────────────────────────────────────────

pub fn build_call_graph(root: &Path, files: &[FileData], model: &Model) -> CallGraph {
    // 1. Global exported-function index: (module_id, export_name) → FunctionId
    let mut exported_index: HashMap<(NodeId, String), FunctionId> = HashMap::new();
    let mut all_fns: HashMap<FunctionId, Function> = HashMap::new();

    for file in files {
        let mid = file.module_id;
        for rf in &file.functions {
            let fid = FunctionId { module: mid, name: rf.name.clone(), order: rf.order };
            all_fns.insert(fid.clone(), Function {
                id: fid.clone(),
                module: mid,
                module_path: file.path.clone(),
                display_name: rf.name.clone(),
                exported: rf.exported,
                is_method: rf.is_method,
                class_name: rf.class_name.clone(),
            });

            if rf.exported {
                exported_index.insert((mid, rf.name.clone()), fid.clone());
                // Method short-name: "UserService.create" → also index as "create"
                if rf.is_method {
                    if let Some(short) = rf.name.split('.').next_back() {
                        exported_index
                            .entry((mid, short.to_string()))
                            .or_insert_with(|| fid.clone());
                    }
                }
                if rf.is_default_export {
                    exported_index.insert((mid, "default".to_string()), fid.clone());
                }
            }
        }
    }

    // 2. Path → NodeId for resolve()
    let path_to_id: HashMap<String, NodeId> = files
        .iter()
        .map(|f| (f.path.clone(), f.module_id))
        .collect();

    // 3. Re-export forward table: from_mid → Vec<to_mid>
    let mut reexport_table: HashMap<NodeId, Vec<NodeId>> = HashMap::new();
    for edge in &model.edges {
        if edge.kind == EdgeKind::Reexports {
            reexport_table.entry(edge.from).or_default().push(edge.to);
        }
    }

    // 4. Resolve calls per file
    let mut all_edges: Vec<CallEdge> = Vec::new();

    for file in files {
        let mid = file.module_id;
        let abs_path = root.join(&file.path);

        // Local symbol table: fn_name → FunctionId
        let local_fns: HashMap<String, FunctionId> = file
            .functions
            .iter()
            .map(|rf| (rf.name.clone(), FunctionId { module: mid, name: rf.name.clone(), order: rf.order }))
            .collect();

        // Import binding table: local_name → (resolved_module_id_opt, imported_name)
        let mut import_table: HashMap<String, (Option<NodeId>, String)> = HashMap::new();
        for binding in &file.bindings {
            let target_mid = resolve(root, &abs_path, &binding.specifier)
                .and_then(|rel| path_to_id.get(rel.to_string_lossy().as_ref()).copied());
            import_table.insert(
                binding.local_name.clone(),
                (target_mid, binding.imported_name.clone()),
            );
        }

        for rf in &file.functions {
            let caller_id = FunctionId { module: mid, name: rf.name.clone(), order: rf.order };

            for rc in &rf.raw_calls {
                let resolution = resolve_call(
                    rc,
                    &local_fns,
                    &import_table,
                    &exported_index,
                    &reexport_table,
                );
                all_edges.push(CallEdge {
                    caller: caller_id.clone(),
                    callee: resolution,
                    callee_text: rc.callee_text.clone(),
                    call_site_order: rc.call_order,
                    arg_texts: rc.arg_texts.clone(),
                    branchy: rc.branchy,
                    branch_id: rc.branch_id,
                });
            }
        }
    }

    CallGraph { functions: all_fns, edges: all_edges }
}

// ── call resolution ───────────────────────────────────────────────────────────

fn resolve_call(
    rc: &RawCall,
    local_fns: &HashMap<String, FunctionId>,
    import_table: &HashMap<String, (Option<NodeId>, String)>,
    exported_index: &HashMap<(NodeId, String), FunctionId>,
    reexport_table: &HashMap<NodeId, Vec<NodeId>>,
) -> CallResolution {
    let root_name = &rc.callee_root;

    // ── plain call: foo() ────────────────────────────────────────────────────
    if rc.member_path.is_empty() {
        // a) same-file local function
        if let Some(fid) = local_fns.get(root_name) {
            return CallResolution::Resolved { target: fid.clone() };
        }

        // b) imported identifier
        if let Some((target_mid_opt, imported_name)) = import_table.get(root_name) {
            match target_mid_opt {
                Some(target_mid) => {
                    let lookup = if imported_name == "default" { "default" } else { imported_name.as_str() };
                    if let Some(fid) = exported_index.get(&(*target_mid, lookup.to_string())) {
                        return CallResolution::Resolved { target: fid.clone() };
                    }
                    // One re-export hop
                    if let Some(re_targets) = reexport_table.get(target_mid) {
                        for &re_mid in re_targets {
                            if let Some(fid) = exported_index.get(&(re_mid, lookup.to_string())) {
                                return CallResolution::Resolved { target: fid.clone() };
                            }
                        }
                    }
                    return CallResolution::UnresolvedImported;
                }
                None => return CallResolution::External, // bare specifier
            }
        }

        return CallResolution::UnresolvedLocal;
    }

    // ── member call: obj.method() ────────────────────────────────────────────
    if root_name == "this" {
        return CallResolution::Method;
    }

    // Namespace import: `import * as svc from './svc'` → svc.foo()
    if let Some((target_mid_opt, imported_name)) = import_table.get(root_name) {
        if imported_name == "*" {
            if let Some(target_mid) = target_mid_opt {
                let method = rc.member_path.last().map(|s| s.as_str()).unwrap_or("");
                if let Some(fid) = exported_index.get(&(*target_mid, method.to_string())) {
                    return CallResolution::Resolved { target: fid.clone() };
                }
                return CallResolution::UnresolvedImported;
            }
        }
    }

    CallResolution::Method
}

// ── helpers ───────────────────────────────────────────────────────────────────

impl CallGraph {
    pub fn edges_from(&self, fid: &FunctionId) -> Vec<&CallEdge> {
        self.edges.iter().filter(|e| &e.caller == fid).collect()
    }

    pub fn resolved_edges_from(&self, fid: &FunctionId) -> Vec<(&CallEdge, &FunctionId)> {
        self.edges_from(fid)
            .into_iter()
            .filter_map(|e| {
                if let CallResolution::Resolved { target } = &e.callee {
                    Some((e, target))
                } else {
                    None
                }
            })
            .collect()
    }
}
