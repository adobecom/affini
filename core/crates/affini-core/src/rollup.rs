/// Graph-projection: partition modules into groups and aggregate edges between them.
///
/// Supports three grouping strategies:
///   • Directory — group by the first N path components (configurable `depth`).
///   • Layer     — group by the affini.toml layer assignment.
///   • Scc       — leave singletons as individual nodes; cluster multi-member SCCs.
///
/// The resulting `GroupedGraph` can be laid out with dagre on the frontend.
use crate::intent::Violation;
use crate::model::{Model, NodeId};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::collections::HashSet;

// ── grouping strategy ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GroupBy {
    Directory,
    Layer,
    Scc,
}

// ── output types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupNode {
    /// Sequential id assigned to this group (0-based stable within one rollup call).
    pub id: u32,
    /// Stable key: directory prefix, layer name, "scc:<id>", or file path for singletons.
    pub key: String,
    /// Human-readable label for display.
    pub label: String,
    /// Module NodeIds that belong to this group.
    pub member_ids: Vec<NodeId>,
    /// Sum of lines-of-code across all members.
    pub loc: u32,
    /// Number of files in this group.
    pub file_count: u32,
    /// True for multi-member SCC clusters; false everywhere else.
    pub is_cluster: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupEdge {
    /// Id of the source GroupNode.
    pub from: u32,
    /// Id of the target GroupNode.
    pub to: u32,
    /// Number of underlying file-level import edges that collapse here.
    pub weight: u32,
    /// True if any underlying edge is flagged as a violation.
    pub violation: bool,
    /// True if the source is in a lower (more stable) layer than the target.
    pub cross_layer_up: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupedGraph {
    pub nodes: Vec<GroupNode>,
    pub edges: Vec<GroupEdge>,
    /// Serialised GroupBy variant for the UI.
    pub group_by: String,
    /// Layer order (from `model.layer_order`), preserved for ranked layout.
    pub layer_order: Vec<String>,
}

// ── main entry point ──────────────────────────────────────────────────────────

/// Partition the flat module graph into groups and return the aggregated graph.
///
/// * `depth` — only applies to `Directory` grouping; how many leading path segments
///   to use as the group key (default 1).
/// * `violations` — used to flag inter-group edges that cross forbidden boundaries.
pub fn rollup(
    model: &Model,
    group_by: GroupBy,
    depth: Option<u32>,
    violations: &[Violation],
) -> GroupedGraph {
    // Pre-build a set of (from_path, to_path) violation pairs for O(1) lookup.
    let violation_set: HashSet<(&str, &str)> = violations
        .iter()
        .map(|v| (v.from_path.as_str(), v.to_path.as_str()))
        .collect();

    // Build a path → layer-index map for cross_layer_up detection.
    let layer_index: HashMap<&str, usize> = build_layer_index(model);

    // ── 1. Map every module to its group key ────────────────────────────────
    let module_to_group: HashMap<NodeId, String> = match &group_by {
        GroupBy::Directory => {
            let d = depth.unwrap_or(1).max(1) as usize;
            model
                .modules
                .iter()
                .map(|m| {
                    let key: String = m
                        .path
                        .split('/')
                        .take(d)
                        .collect::<Vec<_>>()
                        .join("/");
                    let key = if key.is_empty() { "root".to_string() } else { key };
                    (m.id, key)
                })
                .collect()
        }
        GroupBy::Layer => model
            .modules
            .iter()
            .map(|m| {
                let layer = model
                    .layers
                    .get(&m.id)
                    .cloned()
                    .unwrap_or_else(|| "(unassigned)".to_string());
                (m.id, layer)
            })
            .collect(),
        GroupBy::Scc => model
            .modules
            .iter()
            .map(|m| {
                let metrics = model.metrics.get(&m.id);
                let scc_size = metrics.map(|mx| mx.scc_size).unwrap_or(1);
                let scc_id = metrics.map(|mx| mx.scc_id).unwrap_or(0);
                if scc_size > 1 {
                    (m.id, format!("scc:{}", scc_id))
                } else {
                    // Singleton: use the file path as its own unique key.
                    (m.id, m.path.clone())
                }
            })
            .collect(),
    };

    // ── 2. Collect members per group key ─────────────────────────────────────
    let mut group_map: HashMap<String, Vec<NodeId>> = HashMap::new();
    for (id, key) in &module_to_group {
        group_map.entry(key.clone()).or_default().push(*id);
    }

    // ── 3. Determine stable group key ordering ────────────────────────────────
    let mut group_keys: Vec<String> = group_map.keys().cloned().collect();
    match &group_by {
        GroupBy::Layer if !model.layer_order.is_empty() => {
            // Preserve declared layer order; unlayered group goes last.
            group_keys.sort_by_key(|k| {
                model
                    .layer_order
                    .iter()
                    .position(|l| l == k)
                    .unwrap_or(usize::MAX)
            });
        }
        _ => group_keys.sort(),
    }

    // ── 4. Build GroupNode list ───────────────────────────────────────────────
    let mut key_to_gid: HashMap<String, u32> = HashMap::new();
    let mut nodes: Vec<GroupNode> = Vec::new();

    for (gid, key) in group_keys.iter().enumerate() {
        let member_ids = group_map[key].clone();
        let loc: u32 = member_ids
            .iter()
            .filter_map(|id| model.metrics.get(id))
            .map(|m| m.loc)
            .sum();

        let is_cluster = matches!(&group_by, GroupBy::Scc) && key.starts_with("scc:");

        let label = match &group_by {
            GroupBy::Scc if is_cluster => {
                format!("cycle cluster ({} files)", member_ids.len())
            }
            GroupBy::Scc => {
                // Singleton SCC: show basename.
                key.split('/').next_back().unwrap_or(key).to_string()
            }
            _ => key.clone(),
        };

        key_to_gid.insert(key.clone(), gid as u32);
        nodes.push(GroupNode {
            id: gid as u32,
            key: key.clone(),
            label,
            file_count: member_ids.len() as u32,
            member_ids,
            loc,
            is_cluster,
        });
    }

    // ── 5. Aggregate edges ────────────────────────────────────────────────────
    // (from_gid, to_gid) → (weight, violation, cross_layer_up)
    let mut edge_map: HashMap<(u32, u32), (u32, bool, bool)> = HashMap::new();

    for edge in &model.edges {
        let from_key = match module_to_group.get(&edge.from) {
            Some(k) => k,
            None => continue,
        };
        let to_key = match module_to_group.get(&edge.to) {
            Some(k) => k,
            None => continue,
        };

        // Drop intra-group edges.
        if from_key == to_key {
            continue;
        }

        let from_gid = key_to_gid[from_key];
        let to_gid = key_to_gid[to_key];

        let from_path = model
            .module_by_id(edge.from)
            .map(|m| m.path.as_str())
            .unwrap_or("");
        let to_path = model
            .module_by_id(edge.to)
            .map(|m| m.path.as_str())
            .unwrap_or("");

        let is_violation = violation_set.contains(&(from_path, to_path));

        // cross_layer_up: source is in a lower-index (more stable) layer
        // importing a higher-index (less stable) layer.
        let cross_layer_up =
            if let (Some(&fi), Some(&ti)) =
                (layer_index.get(from_path), layer_index.get(to_path))
            {
                fi < ti
            } else {
                false
            };

        let entry = edge_map.entry((from_gid, to_gid)).or_insert((0, false, false));
        entry.0 += 1;
        if is_violation {
            entry.1 = true;
        }
        if cross_layer_up {
            entry.2 = true;
        }
    }

    let edges: Vec<GroupEdge> = edge_map
        .into_iter()
        .map(|((from, to), (weight, violation, cross_layer_up))| GroupEdge {
            from,
            to,
            weight,
            violation,
            cross_layer_up,
        })
        .collect();

    GroupedGraph {
        nodes,
        edges,
        group_by: format!("{:?}", group_by).to_lowercase(),
        layer_order: model.layer_order.clone(),
    }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/// Build a mapping from module path → layer index (0 = most stable).
/// Only modules present in `model.layers` are included.
fn build_layer_index(model: &Model) -> HashMap<&str, usize> {
    let mut map: HashMap<&str, usize> = HashMap::new();
    for (id, layer_name) in &model.layers {
        if let Some(idx) = model.layer_order.iter().position(|l| l == layer_name) {
            if let Some(m) = model.module_by_id(*id) {
                map.insert(m.path.as_str(), idx);
            }
        }
    }
    map
}
