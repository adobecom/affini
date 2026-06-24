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

    // --- extract edges and collect LOC ---
    let mut edges: Vec<Edge> = Vec::new();
    let mut loc_map: HashMap<NodeId, u32> = HashMap::new();

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

        // Count lines of code while we have the source in hand (zero extra I/O).
        loc_map.insert(from_id, source.lines().count() as u32);

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
    let n = modules.len();
    let total = n as f32;

    let mut fan_in: HashMap<NodeId, u32> = HashMap::new();
    let mut fan_out: HashMap<NodeId, u32> = HashMap::new();

    for e in &edges {
        *fan_out.entry(e.from).or_insert(0) += 1;
        *fan_in.entry(e.to).or_insert(0) += 1;
    }

    // Build adjacency list (index by NodeId = sequential 0..n) for Tarjan SCC.
    let mut adj: Vec<Vec<usize>> = vec![Vec::new(); n];
    for e in &edges {
        adj[e.from as usize].push(e.to as usize);
    }
    let scc_data = tarjan_scc(n, &adj);

    let mut metrics: HashMap<NodeId, ModuleMetrics> = HashMap::new();
    for m in &modules {
        let fo = *fan_out.get(&m.id).unwrap_or(&0);
        let fi = *fan_in.get(&m.id).unwrap_or(&0);
        let (scc_id, scc_size) = scc_data[m.id as usize];
        let loc = *loc_map.get(&m.id).unwrap_or(&0);
        let instability = if fi + fo > 0 { fo as f32 / (fi + fo) as f32 } else { 0.0 };
        metrics.insert(
            m.id,
            ModuleMetrics {
                fan_in: fi,
                fan_out: fo,
                coupling: if total > 0.0 { fo as f32 / total } else { 0.0 },
                loc,
                scc_id,
                scc_size,
                instability,
            },
        );
    }

    Ok(Model {
        root: root_abs.to_string_lossy().to_string(),
        commit: "workdir".to_string(),
        modules,
        edges,
        metrics,
        layers: Default::default(),
        layer_order: Default::default(),
    })
}

/// Iterative Tarjan SCC — avoids stack overflow on large repos.
/// Returns a Vec indexed by NodeId of (scc_id, scc_size).
/// Nodes with scc_size > 1 participate in a dependency cycle.
fn tarjan_scc(n: usize, adj: &[Vec<usize>]) -> Vec<(u32, u32)> {
    let mut next_index: u32 = 0;
    let mut tarjan_stack: Vec<usize> = Vec::new(); // Tarjan's S set
    let mut on_stack = vec![false; n];
    let mut indices = vec![u32::MAX; n];
    let mut lowlinks = vec![0u32; n];
    let mut scc_id = vec![0u32; n];
    let mut scc_sz = vec![0u32; n];
    let mut scc_count: u32 = 0;

    // DFS work-stack: (node, next-child-index-into-adj[node])
    let mut work: Vec<(usize, usize)> = Vec::new();

    for start in 0..n {
        if indices[start] != u32::MAX {
            continue;
        }

        // Push the start node
        indices[start] = next_index;
        lowlinks[start] = next_index;
        next_index += 1;
        tarjan_stack.push(start);
        on_stack[start] = true;
        work.push((start, 0));

        while !work.is_empty() {
            let (v, ei) = *work.last().unwrap();

            if ei < adj[v].len() {
                let w = adj[v][ei];
                work.last_mut().unwrap().1 += 1; // advance child iterator

                if indices[w] == u32::MAX {
                    // Tree edge: visit w
                    indices[w] = next_index;
                    lowlinks[w] = next_index;
                    next_index += 1;
                    tarjan_stack.push(w);
                    on_stack[w] = true;
                    work.push((w, 0));
                } else if on_stack[w] {
                    // Back edge: update lowlink
                    if indices[w] < lowlinks[v] {
                        lowlinks[v] = indices[w];
                    }
                }
            } else {
                // All neighbours of v processed — pop and propagate lowlink.
                work.pop();
                if let Some(&(parent, _)) = work.last() {
                    if lowlinks[v] < lowlinks[parent] {
                        lowlinks[parent] = lowlinks[v];
                    }
                }

                // Check if v is the root of an SCC.
                if lowlinks[v] == indices[v] {
                    let mut members: Vec<usize> = Vec::new();
                    loop {
                        let w = tarjan_stack.pop().unwrap();
                        on_stack[w] = false;
                        scc_id[w] = scc_count;
                        members.push(w);
                        if w == v {
                            break;
                        }
                    }
                    let sz = members.len() as u32;
                    for &m in &members {
                        scc_sz[m] = sz;
                    }
                    scc_count += 1;
                }
            }
        }
    }

    scc_id.into_iter().zip(scc_sz).collect()
}

fn is_source_file(p: &Path) -> bool {
    match p.extension().and_then(|e| e.to_str()) {
        Some("ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs") => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::tarjan_scc;

    #[test]
    fn test_scc_simple_cycle() {
        // 0→1→2→0 forms a 3-cycle; 3→0 does not participate.
        let adj = vec![
            vec![1],    // 0→1
            vec![2],    // 1→2
            vec![0],    // 2→0
            vec![0],    // 3→0 (no cycle for 3)
        ];
        let result = tarjan_scc(4, &adj);
        // Nodes 0, 1, 2 should all have scc_size == 3
        assert_eq!(result[0].1, 3);
        assert_eq!(result[1].1, 3);
        assert_eq!(result[2].1, 3);
        // Nodes 0, 1, 2 should share the same scc_id
        assert_eq!(result[0].0, result[1].0);
        assert_eq!(result[1].0, result[2].0);
        // Node 3 is a singleton (no cycle)
        assert_eq!(result[3].1, 1);
        assert_ne!(result[3].0, result[0].0);
    }

    #[test]
    fn test_scc_dag() {
        // Pure DAG: 0→1→2, 0→2.  No cycles.
        let adj = vec![vec![1, 2], vec![2], vec![]];
        let result = tarjan_scc(3, &adj);
        for (_, sz) in &result {
            assert_eq!(*sz, 1, "all nodes should be singleton SCCs in a DAG");
        }
    }
}
