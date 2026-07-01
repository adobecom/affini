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
    /// Explicitly declared feature entry-points (optional).
    /// Syntax in affini.toml:
    /// ```toml
    /// [[features]]
    /// name  = "User signup"
    /// entry = "src/routes/auth.ts#handleSignup"
    /// kind  = "route"   # optional
    /// ```
    #[serde(default)]
    pub features: Vec<FeatureDecl>,
}

/// A user-declared feature entry-point in affini.toml.
#[derive(Debug, Clone, Deserialize)]
pub struct FeatureDecl {
    /// Display name for the feature (e.g. "User signup").
    pub name: String,
    /// "<relative-path>#<function-name>" pointing at the feature's entry function.
    pub entry: String,
    /// Optional kind override (route | cli | handler | public_api | exported_entry).
    #[serde(default)]
    pub kind: Option<String>,
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
        // Precompute each layer's path set once in declared order, then build a
        // path→layer-index map for O(1) per-edge lookup (avoids re-resolving
        // glob sets inside the edge loop).
        let layer_sets: Vec<std::collections::HashSet<&str>> = layers
            .iter()
            .map(|name| resolve_boundary_or_glob(&boundary_files, name))
            .collect();

        let mut path_to_layer: HashMap<&str, usize> = HashMap::new();
        for m in &model.modules {
            for (i, set) in layer_sets.iter().enumerate() {
                if set.contains(m.path.as_str()) {
                    path_to_layer.insert(m.path.as_str(), i);
                    break; // first-match-wins, same as assign_layers
                }
            }
        }

        for edge in &model.edges {
            let from_path = model
                .module_by_id(edge.from)
                .map(|m| m.path.as_str())
                .unwrap_or("");
            let to_path = model
                .module_by_id(edge.to)
                .map(|m| m.path.as_str())
                .unwrap_or("");

            if let (Some(&fi), Some(&ti)) = (path_to_layer.get(from_path), path_to_layer.get(to_path)) {
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

    // Precompute each layer's path set once in declared order.  First-match-wins
    // semantics are preserved; the inner break exits as soon as a layer matches.
    let layer_sets: Vec<(&String, std::collections::HashSet<&str>)> = layers
        .iter()
        .map(|name| (name, resolve_boundary_or_glob(&boundary_files, name)))
        .collect();

    let mut result: HashMap<NodeId, String> = HashMap::new();
    for m in &model.modules {
        for (layer_name, set) in &layer_sets {
            if set.contains(m.path.as_str()) {
                result.insert(m.id, (*layer_name).clone());
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Edge, EdgeKind, Model, Module};

    fn make_module(id: u32, path: &str) -> Module {
        Module { id, path: path.to_string(), is_file: true, exports: vec![] }
    }

    fn make_edge(from: u32, to: u32) -> Edge {
        Edge { from, to, kind: EdgeKind::Imports, specifier: String::new() }
    }

    fn make_intent(layers: Vec<&str>, boundaries: Vec<(&str, Vec<&str>)>) -> IntentFile {
        IntentFile {
            boundaries: boundaries
                .into_iter()
                .map(|(k, vs)| (k.to_string(), vs.into_iter().map(|s| s.to_string()).collect()))
                .collect(),
            rules: Rules {
                layers: layers.into_iter().map(|s| s.to_string()).collect(),
                forbidden: vec![],
                canonical: vec![],
            },
        }
    }

    // ── assign_layers ─────────────────────────────────────────────────────────

    #[test]
    fn assign_layers_basic() {
        let model = Model {
            modules: vec![
                make_module(1, "core/src/lib.rs"),
                make_module(2, "ui/src/app.tsx"),
                make_module(3, "cli/src/main.rs"),
            ],
            ..Default::default()
        };
        let intent = make_intent(
            vec!["core", "cli", "ui"],
            vec![
                ("core", vec!["core/**"]),
                ("cli",  vec!["cli/**"]),
                ("ui",   vec!["ui/**"]),
            ],
        );
        let result = assign_layers(&model, &intent);
        assert_eq!(result.get(&1).map(|s| s.as_str()), Some("core"));
        assert_eq!(result.get(&2).map(|s| s.as_str()), Some("ui"));
        assert_eq!(result.get(&3).map(|s| s.as_str()), Some("cli"));
    }

    #[test]
    fn assign_layers_first_match_wins() {
        // Module matches both "core" and "shared" globs; "core" is declared first.
        let model = Model {
            modules: vec![make_module(1, "core/shared/util.rs")],
            ..Default::default()
        };
        let intent = make_intent(
            vec!["core", "shared"],
            vec![
                ("core",   vec!["core/**"]),
                ("shared", vec!["core/shared/**"]),
            ],
        );
        let result = assign_layers(&model, &intent);
        assert_eq!(result.get(&1).map(|s| s.as_str()), Some("core"));
    }

    #[test]
    fn assign_layers_unmatched_module_omitted() {
        let model = Model {
            modules: vec![
                make_module(1, "core/src/lib.rs"),
                make_module(2, "scripts/generate.py"),  // matches no layer
            ],
            ..Default::default()
        };
        let intent = make_intent(
            vec!["core"],
            vec![("core", vec!["core/**"])],
        );
        let result = assign_layers(&model, &intent);
        assert!(result.contains_key(&1));
        assert!(!result.contains_key(&2), "unmatched module must be omitted");
    }

    #[test]
    fn assign_layers_empty_layers_returns_empty() {
        let model = Model {
            modules: vec![make_module(1, "core/src/lib.rs")],
            ..Default::default()
        };
        let intent = make_intent(vec![], vec![("core", vec!["core/**"])]);
        let result = assign_layers(&model, &intent);
        assert!(result.is_empty());
    }

    #[test]
    fn assign_layers_raw_glob_name() {
        // Layer name that is itself a glob pattern (no matching boundary key).
        // The fallback in resolve_boundary_or_glob matches against paths that were
        // already expanded from *named* boundaries, so both modules must be reachable
        // via at least one named boundary for the raw-glob path to exercise them.
        let model = Model {
            modules: vec![
                make_module(1, "core/lib.rs"),
                make_module(2, "core/util.rs"),
            ],
            ..Default::default()
        };
        // "sources" is a named boundary that covers both modules. The layer name
        // "core/**" is not a boundary key, so it falls back to glob-matching the
        // already-expanded path set.
        let intent = make_intent(
            vec!["core/**"],
            vec![("sources", vec!["core/**"])],
        );
        let result = assign_layers(&model, &intent);
        assert_eq!(result.get(&1).map(|s| s.as_str()), Some("core/**"));
        assert_eq!(result.get(&2).map(|s| s.as_str()), Some("core/**"));
    }

    // ── layer violation check ─────────────────────────────────────────────────

    #[test]
    fn check_lower_imports_higher_is_violation() {
        // core (layer 0) imports ui (layer 2) → violation
        let model = Model {
            modules: vec![
                make_module(1, "core/lib.rs"),
                make_module(2, "ui/app.tsx"),
            ],
            edges: vec![make_edge(1, 2)],
            ..Default::default()
        };
        let intent = make_intent(
            vec!["core", "cli", "ui"],
            vec![
                ("core", vec!["core/**"]),
                ("cli",  vec!["cli/**"]),
                ("ui",   vec!["ui/**"]),
            ],
        );
        let violations = check(&model, &intent);
        assert_eq!(violations.len(), 1);
        assert_eq!(violations[0].severity, Severity::Error);
        assert!(violations[0].rule.contains("core"));
        assert!(violations[0].rule.contains("ui"));
    }

    #[test]
    fn check_higher_imports_lower_is_ok() {
        // ui (layer 2) imports core (layer 0) → ok
        let model = Model {
            modules: vec![
                make_module(1, "core/lib.rs"),
                make_module(2, "ui/app.tsx"),
            ],
            edges: vec![make_edge(2, 1)],
            ..Default::default()
        };
        let intent = make_intent(
            vec!["core", "cli", "ui"],
            vec![
                ("core", vec!["core/**"]),
                ("cli",  vec!["cli/**"]),
                ("ui",   vec!["ui/**"]),
            ],
        );
        let violations = check(&model, &intent);
        assert!(violations.is_empty());
    }

    #[test]
    fn check_same_layer_import_is_ok() {
        let model = Model {
            modules: vec![
                make_module(1, "core/a.rs"),
                make_module(2, "core/b.rs"),
            ],
            edges: vec![make_edge(1, 2)],
            ..Default::default()
        };
        let intent = make_intent(
            vec!["core", "ui"],
            vec![
                ("core", vec!["core/**"]),
                ("ui",   vec!["ui/**"]),
            ],
        );
        let violations = check(&model, &intent);
        assert!(violations.is_empty());
    }

    #[test]
    fn check_unlayered_modules_produce_no_violations() {
        // Edge between modules outside any declared layer → no violation
        let model = Model {
            modules: vec![
                make_module(1, "scripts/a.py"),
                make_module(2, "scripts/b.py"),
            ],
            edges: vec![make_edge(1, 2)],
            ..Default::default()
        };
        let intent = make_intent(
            vec!["core", "ui"],
            vec![
                ("core", vec!["core/**"]),
                ("ui",   vec!["ui/**"]),
            ],
        );
        let violations = check(&model, &intent);
        assert!(violations.is_empty());
    }
}
