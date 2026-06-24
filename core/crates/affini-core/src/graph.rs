/// Build a model from a repo directory tree and compute metrics.
use crate::model::{Edge, EdgeKind, Model, Module, ModuleMetrics, NodeId};
use crate::parse::extract_imports;
use crate::resolve::resolve;
use anyhow::Result;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

const IGNORED_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "target",
    ".cache",
    "__pycache__",
    ".affini",
];

/// Scan a repository root and produce a Model.
pub fn scan(root: &Path) -> Result<Model> {
    let root_abs = root.canonicalize()?;

    // --- collect all source files ---
    let mut files: Vec<PathBuf> = Vec::new();
    for entry in WalkDir::new(&root_abs)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            !IGNORED_DIRS
                .iter()
                .any(|d| e.file_name().to_str() == Some(d))
        })
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file() {
            let p = entry.into_path();
            if is_source_file(&p) {
                files.push(p);
            }
        }
    }

    // --- assign node ids, build path→id map ---
    let mut modules: Vec<Module> = Vec::new();
    let mut path_to_id: HashMap<String, NodeId> = HashMap::new();

    for (idx, abs_path) in files.iter().enumerate() {
        let rel = abs_path
            .strip_prefix(&root_abs)
            .unwrap()
            .to_string_lossy()
            .to_string();
        let id = idx as NodeId;
        path_to_id.insert(rel.clone(), id);
        modules.push(Module {
            id,
            path: rel,
            is_file: true,
            exports: vec![],
        });
    }

    // --- extract edges ---
    let mut edges: Vec<Edge> = Vec::new();

    for file_abs in &files {
        let source = match std::fs::read_to_string(file_abs) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let rel_str = file_abs
            .strip_prefix(&root_abs)
            .unwrap()
            .to_string_lossy()
            .to_string();
        let from_id = match path_to_id.get(&rel_str) {
            Some(&id) => id,
            None => continue,
        };

        let import_edges = extract_imports(&rel_str, &source).unwrap_or_default();

        for imp in import_edges {
            if let Some(resolved_rel) = resolve(&root_abs, file_abs, &imp.specifier) {
                let resolved_str = resolved_rel.to_string_lossy().to_string();
                if let Some(&to_id) = path_to_id.get(&resolved_str) {
                    edges.push(Edge {
                        from: from_id,
                        to: to_id,
                        kind: if imp.is_reexport {
                            EdgeKind::Reexports
                        } else {
                            EdgeKind::Imports
                        },
                        specifier: imp.specifier,
                    });
                }
            }
        }
    }

    // Dedup edges (same from/to/kind may appear if a file has multiple imports of the same thing)
    edges.sort_by_key(|e| (e.from, e.to, e.kind == EdgeKind::Reexports));
    edges.dedup_by_key(|e| (e.from, e.to));

    // --- compute metrics ---
    let total = modules.len() as f32;
    let mut fan_in: HashMap<NodeId, u32> = HashMap::new();
    let mut fan_out: HashMap<NodeId, u32> = HashMap::new();

    for e in &edges {
        *fan_out.entry(e.from).or_insert(0) += 1;
        *fan_in.entry(e.to).or_insert(0) += 1;
    }

    let mut metrics: HashMap<NodeId, ModuleMetrics> = HashMap::new();
    for m in &modules {
        let fo = *fan_out.get(&m.id).unwrap_or(&0);
        let fi = *fan_in.get(&m.id).unwrap_or(&0);
        metrics.insert(
            m.id,
            ModuleMetrics {
                fan_in: fi,
                fan_out: fo,
                coupling: if total > 0.0 { fo as f32 / total } else { 0.0 },
            },
        );
    }

    Ok(Model {
        root: root_abs.to_string_lossy().to_string(),
        commit: "workdir".to_string(),
        modules,
        edges,
        metrics,
    })
}

fn is_source_file(p: &Path) -> bool {
    match p.extension().and_then(|e| e.to_str()) {
        Some("ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs") => true,
        _ => false,
    }
}
