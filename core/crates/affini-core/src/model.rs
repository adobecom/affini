use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub type NodeId = u32;

/// A logical module — currently always a single scanned source file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Module {
    pub id: NodeId,
    /// Relative path from repo root (e.g. "src/main/services").
    pub path: String,
    /// Always `true` today. Reserved for a future directory-grouping feature
    /// (`rollup.rs` currently produces its own `GroupNode` type for that
    /// instead of directory-level `Module`s) — no code path sets this `false`.
    pub is_file: bool,
    /// Always empty today. Reserved for a future export-tracking feature —
    /// no code path currently populates this.
    pub exports: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum EdgeKind {
    /// One file/module imports from another.
    Imports,
    /// One file re-exports from another (export ... from '...').
    Reexports,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Edge {
    pub from: NodeId,
    pub to: NodeId,
    pub kind: EdgeKind,
    /// The raw specifier string as written in source.
    pub specifier: String,
}

/// The full living model of a repository at a point in time.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Model {
    /// Scanned root (absolute path, so snapshots are self-describing).
    pub root: String,
    /// Commit SHA or "workdir" if scanned from working tree.
    pub commit: String,
    pub modules: Vec<Module>,
    pub edges: Vec<Edge>,
    /// Metrics computed from the graph (fan-in, fan-out, coupling, etc.).
    pub metrics: HashMap<NodeId, ModuleMetrics>,
    /// NodeId → layer name, populated from affini.toml boundaries when available.
    #[serde(default)]
    pub layers: HashMap<NodeId, String>,
    /// Ordered layer names (index 0 = lowest/most-stable).  Empty if no affini.toml.
    #[serde(default)]
    pub layer_order: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModuleMetrics {
    /// How many other modules import this one.
    pub fan_in: u32,
    /// How many other modules this one imports.
    pub fan_out: u32,
    /// fan_out / total_modules — 0–1 coupling ratio.
    pub coupling: f32,
    /// Lines of code in this file.
    #[serde(default)]
    pub loc: u32,
    /// Tarjan SCC identifier — nodes sharing the same id form a cycle when scc_size > 1.
    #[serde(default)]
    pub scc_id: u32,
    /// Size of this node's strongly-connected component.  >1 means the node is in a cycle.
    #[serde(default)]
    pub scc_size: u32,
    /// Instability (Martin's metric): fan_out / (fan_in + fan_out).  0 = stable, 1 = unstable.
    #[serde(default)]
    pub instability: f32,
}

impl Model {
    pub fn module_by_path(&self, path: &str) -> Option<&Module> {
        self.modules.iter().find(|m| m.path == path)
    }

    pub fn module_by_id(&self, id: NodeId) -> Option<&Module> {
        self.modules.iter().find(|m| m.id == id)
    }
}
