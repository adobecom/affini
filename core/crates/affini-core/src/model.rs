use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub type NodeId = u32;

/// A logical module — a file or a directory treated as a unit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Module {
    pub id: NodeId,
    /// Relative path from repo root (e.g. "src/main/services").
    pub path: String,
    /// True when this is a single file (leaf); false for a directory group.
    pub is_file: bool,
    /// Exported symbol names collected from this file/directory (best-effort).
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
    /// Metrics computed from the graph (fan-in, fan-out, coupling).
    pub metrics: HashMap<NodeId, ModuleMetrics>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModuleMetrics {
    /// How many other modules import this one.
    pub fan_in: u32,
    /// How many other modules this one imports.
    pub fan_out: u32,
    /// fan_out / total_modules — 0–1 coupling ratio.
    pub coupling: f32,
}

impl Model {
    pub fn module_by_path(&self, path: &str) -> Option<&Module> {
        self.modules.iter().find(|m| m.path == path)
    }

    pub fn module_by_id(&self, id: NodeId) -> Option<&Module> {
        self.modules.iter().find(|m| m.id == id)
    }
}
