/// Parse `affini.toml` and evaluate conformance rules against a Model.
use crate::model::{Model, NodeId};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

// ---------------------------------------------------------------------------
// Schema (affini.toml)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct IntentFile {
    #[serde(default)]
    pub boundaries: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub rules: Rules,
}

#[derive(Debug, Deserialize, Default)]
pub struct Rules {
    /// Edges that must not exist.
    #[serde(default)]
    pub forbidden: Vec<ForbiddenRule>,
    /// Canonical implementations — flags if >1 file matches a concept glob.
    #[serde(default)]
    pub canonical: Vec<CanonicalRule>,
    /// Ordered layers: later entries may not import earlier entries.
    #[serde(default)]
    pub layers: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct ForbiddenRule {
    /// Boundary name (from `[boundaries]`) or glob that the edge source matches.
    pub from: String,
    /// Boundary name or glob that the edge target matches.
    pub to: String,
    #[serde(default)]
    pub reason: String,
}

#[derive(Debug, Deserialize)]
pub struct CanonicalRule {
    pub concept: String,
    /// The single authoritative file path (relative to root).
    pub path: String,
}

// ---------------------------------------------------------------------------
// Violation output
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Violation {
    pub rule: String,
    pub severity: Severity,
    pub from_path: String,
    pub to_path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

pub fn load(intent_path: &Path) -> Result<IntentFile> {
    let text = std::fs::read_to_string(intent_path)
        .with_context(|| format!("cannot read {}", intent_path.display()))?;
    toml::from_str(&text).with_context(|| "malformed affini.toml")
}

/// Check `model` against `intent` and return all violations.
pub fn check(model: &Model, intent: &IntentFile) -> Vec<Violation> {
    let mut violations = Vec::new();

    // Pre-expand boundaries: name → set of matching module paths
    let boundary_files = expand_boundaries(model, &intent.boundaries);

    // --- forbidden edge rules ---
    for rule in &intent.rules.forbidden {
        let from_set = resolve_boundary_or_glob(&boundary_files, &rule.from);
        let to_set = resolve_boundary_or_glob(&boundary_files, &rule.to);

        for edge in &model.edges {
            let from_path = model
                .module_by_id(edge.from)
                .map(|m| m.path.as_str())
                .unwrap_or("");
            let to_path = model
                .module_by_id(edge.to)
                .map(|m| m.path.as_str())
                .unwrap_or("");

            if from_set.contains(from_path) && to_set.contains(to_path) {
                let reason = if rule.reason.is_empty() {
                    format!("'{}' must not import '{}'", rule.from, rule.to)
                } else {
                    rule.reason.clone()
                };
                violations.push(Violation {
                    rule: format!("forbidden: {} → {}", rule.from, rule.to),
                    severity: Severity::Error,
                    from_path: from_path.to_string(),
                    to_path: to_path.to_string(),
                    message: reason,
                });
            }
        }
    }

    // --- layer rules ---
    // Layers are ordered: layers[0] is lowest. A module in a higher layer
    // must not be imported by a module in a lower layer.
    // Equivalently: if from is in layer i and to is in layer j where j < i, violation.
    let layers = &intent.rules.layers;
    if layers.len() > 1 {
        let layer_idx: HashMap<String, usize> = layers
            .iter()
            .enumerate()
            .map(|(i, l)| (l.clone(), i))
            .collect();

        let module_layer = |path: &str| -> Option<usize> {
            for (name, idx) in &layer_idx {
                let set = resolve_boundary_or_glob(&boundary_files, name);
                if set.contains(path) {
                    return Some(*idx);
                }
            }
            None
        };

        for edge in &model.edges {
            let from_path = model
                .module_by_id(edge.from)
                .map(|m| m.path.as_str())
                .unwrap_or("");
            let to_path = model
                .module_by_id(edge.to)
                .map(|m| m.path.as_str())
                .unwrap_or("");

            if let (Some(fi), Some(ti)) = (module_layer(from_path), module_layer(to_path)) {
                // from is in higher layer importing a lower layer: ok.
                // from is in lower layer importing a higher layer: violation.
                if fi < ti {
                    violations.push(Violation {
                        rule: format!("layer: {} < {}", layers[fi], layers[ti]),
                        severity: Severity::Error,
                        from_path: from_path.to_string(),
                        to_path: to_path.to_string(),
                        message: format!(
                            "'{}' (layer '{}') must not import '{}' (layer '{}')",
                            from_path, layers[fi], to_path, layers[ti]
                        ),
                    });
                }
            }
        }
    }

    violations
}

/// Return a mapping from NodeId to layer name for every module that matches a
/// declared layer.  Modules not covered by any layer are omitted.
pub fn assign_layers(model: &Model, intent: &IntentFile) -> HashMap<NodeId, String> {
    let layers = &intent.rules.layers;
    if layers.is_empty() {
        return HashMap::new();
    }

    let boundary_files = expand_boundaries(model, &intent.boundaries);
    let mut result: HashMap<NodeId, String> = HashMap::new();

    for m in &model.modules {
        for layer_name in layers {
            let set = resolve_boundary_or_glob(&boundary_files, layer_name);
            if set.contains(m.path.as_str()) {
                result.insert(m.id, layer_name.clone());
                break;
            }
        }
    }

    result
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn expand_boundaries<'a>(
    model: &'a Model,
    boundaries: &HashMap<String, Vec<String>>,
) -> HashMap<String, Vec<&'a str>> {
    let mut out: HashMap<String, Vec<&str>> = HashMap::new();
    for (name, globs) in boundaries {
        let mut paths = Vec::new();
        for m in &model.modules {
            for glob_pat in globs {
                if glob_match(glob_pat, &m.path) {
                    paths.push(m.path.as_str());
                    break;
                }
            }
        }
        out.insert(name.clone(), paths);
    }
    out
}

fn resolve_boundary_or_glob<'a>(
    boundary_files: &'a HashMap<String, Vec<&'a str>>,
    name: &str,
) -> std::collections::HashSet<&'a str> {
    if let Some(paths) = boundary_files.get(name) {
        paths.iter().copied().collect()
    } else {
        // Treat as a glob against all modules in the map
        boundary_files
            .values()
            .flatten()
            .filter(|p| glob_match(name, p))
            .copied()
            .collect()
    }
}

/// Minimal glob matching: `**` matches any path component sequence,
/// `*` matches within a single component.
fn glob_match(pattern: &str, path: &str) -> bool {
    // Use the `glob` crate's pattern matching by building a Pattern.
    // Fall back to simple prefix/contains check.
    if let Ok(pat) = glob::Pattern::new(pattern) {
        pat.matches(path)
    } else {
        path.contains(pattern)
    }
}
