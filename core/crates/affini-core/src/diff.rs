/// Structural delta between two model snapshots.
use crate::model::{Edge, Model, Module};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Serialize, Deserialize)]
pub struct ModelDiff {
    pub from_commit: String,
    pub to_commit: String,

    pub modules_added: Vec<Module>,
    pub modules_removed: Vec<Module>,

    pub edges_added: Vec<EdgeDesc>,
    pub edges_removed: Vec<EdgeDesc>,

    /// Summary sentence suitable for CLI output.
    pub summary: String,
}

/// A human-readable edge description (uses paths, not opaque ids).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgeDesc {
    pub from: String,
    pub to: String,
    pub kind: String,
    pub specifier: String,
}

pub fn diff(a: &Model, b: &Model) -> ModelDiff {
    let a_paths: HashSet<&str> = a.modules.iter().map(|m| m.path.as_str()).collect();
    let b_paths: HashSet<&str> = b.modules.iter().map(|m| m.path.as_str()).collect();

    let modules_added: Vec<Module> = b
        .modules
        .iter()
        .filter(|m| !a_paths.contains(m.path.as_str()))
        .cloned()
        .collect();

    let modules_removed: Vec<Module> = a
        .modules
        .iter()
        .filter(|m| !b_paths.contains(m.path.as_str()))
        .cloned()
        .collect();

    // Build path maps for edge descriptions
    let a_id_to_path: HashMap<u32, &str> =
        a.modules.iter().map(|m| (m.id, m.path.as_str())).collect();
    let b_id_to_path: HashMap<u32, &str> =
        b.modules.iter().map(|m| (m.id, m.path.as_str())).collect();

    let edge_key = |id_map: &HashMap<u32, &str>, e: &Edge| -> Option<String> {
        let from = id_map.get(&e.from)?;
        let to = id_map.get(&e.to)?;
        Some(format!("{}→{}", from, to))
    };

    let a_edges: HashSet<String> = a
        .edges
        .iter()
        .filter_map(|e| edge_key(&a_id_to_path, e))
        .collect();

    let b_edges: HashSet<String> = b
        .edges
        .iter()
        .filter_map(|e| edge_key(&b_id_to_path, e))
        .collect();

    let edges_added: Vec<EdgeDesc> = b
        .edges
        .iter()
        .filter(|e| {
            edge_key(&b_id_to_path, e)
                .map(|k| !a_edges.contains(&k))
                .unwrap_or(false)
        })
        .map(|e| EdgeDesc {
            from: b_id_to_path
                .get(&e.from)
                .unwrap_or(&"?")
                .to_string(),
            to: b_id_to_path
                .get(&e.to)
                .unwrap_or(&"?")
                .to_string(),
            kind: format!("{:?}", e.kind),
            specifier: e.specifier.clone(),
        })
        .collect();

    let edges_removed: Vec<EdgeDesc> = a
        .edges
        .iter()
        .filter(|e| {
            edge_key(&a_id_to_path, e)
                .map(|k| !b_edges.contains(&k))
                .unwrap_or(false)
        })
        .map(|e| EdgeDesc {
            from: a_id_to_path
                .get(&e.from)
                .unwrap_or(&"?")
                .to_string(),
            to: a_id_to_path
                .get(&e.to)
                .unwrap_or(&"?")
                .to_string(),
            kind: format!("{:?}", e.kind),
            specifier: e.specifier.clone(),
        })
        .collect();

    let summary = format!(
        "{} file(s) added, {} removed | {} import edges added, {} removed",
        modules_added.len(),
        modules_removed.len(),
        edges_added.len(),
        edges_removed.len(),
    );

    ModelDiff {
        from_commit: a.commit.clone(),
        to_commit: b.commit.clone(),
        modules_added,
        modules_removed,
        edges_added,
        edges_removed,
        summary,
    }
}
