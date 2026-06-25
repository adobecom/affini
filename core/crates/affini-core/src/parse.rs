/// Extract import specifiers from a single TypeScript / JavaScript source file.
///
/// Returns a list of (specifier, is_reexport) tuples.
/// Bare specifiers (no leading `.` or `/`) are returned as-is and resolved
/// as "external" by the caller.
use anyhow::Result;
use streaming_iterator::StreamingIterator;
use tree_sitter::{Parser, Query, QueryCursor};

/// Lazily-initialised languages.
fn ts_language() -> tree_sitter::Language {
    tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()
}

fn tsx_language() -> tree_sitter::Language {
    tree_sitter_typescript::LANGUAGE_TSX.into()
}

fn js_language() -> tree_sitter::Language {
    tree_sitter_javascript::LANGUAGE.into()
}

/// Which grammar to use for a file extension.
fn language_for(path: &str) -> Option<tree_sitter::Language> {
    let ext = path.rsplit('.').next()?;
    match ext {
        "ts" => Some(ts_language()),
        "tsx" => Some(tsx_language()),
        "js" | "mjs" | "cjs" => Some(js_language()),
        "jsx" => Some(js_language()),
        _ => None,
    }
}

/// A named binding from an import statement.
/// Used by the call-graph resolver to map local names to source modules.
#[derive(Debug, Clone)]
pub struct ImportBinding {
    /// The local identifier used in this file.
    pub local_name: String,
    /// The original export name; "default" for default imports; "*" for namespace imports.
    pub imported_name: String,
    /// The raw module specifier (same as in ImportEdge).
    pub specifier: String,
}

/// Parse all import bindings (named + default + namespace) from a source file.
pub fn extract_import_bindings(path: &str, source: &str) -> Result<Vec<ImportBinding>> {
    let language = match language_for(path) {
        Some(l) => l,
        None => return Ok(vec![]),
    };

    let mut parser = Parser::new();
    parser.set_language(&language)?;

    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => return Ok(vec![]),
    };

    let bytes = source.as_bytes();
    let root = tree.root_node();
    let mut bindings = Vec::new();

    // Walk top-level import_statement nodes.
    for i in 0..root.named_child_count() {
        let stmt = match root.named_child(i) {
            Some(n) => n,
            None => continue,
        };
        if stmt.kind() != "import_statement" {
            continue;
        }

        // Get the specifier string from the `source` field.
        let specifier = match stmt.child_by_field_name("source") {
            Some(src_node) => src_node
                .utf8_text(bytes)
                .unwrap_or("")
                .trim()
                .trim_matches(|c| c == '"' || c == '\'' || c == '`')
                .to_string(),
            None => continue,
        };

        if specifier.is_empty() {
            continue;
        }

        // Walk the import_clause to collect bindings.
        let clause = match stmt.child_by_field_name("import_clause") {
            Some(c) => c,
            None => continue,
        };

        walk_import_clause(clause, bytes, &specifier, &mut bindings);
    }

    Ok(bindings)
}

fn walk_import_clause(clause: tree_sitter::Node, bytes: &[u8], specifier: &str, out: &mut Vec<ImportBinding>) {
    for i in 0..clause.named_child_count() {
        let child = match clause.named_child(i) {
            Some(n) => n,
            None => continue,
        };

        match child.kind() {
            "identifier" => {
                // Default import: `import Foo from '...'`
                let local = child.utf8_text(bytes).unwrap_or("").to_string();
                if !local.is_empty() {
                    out.push(ImportBinding {
                        local_name: local,
                        imported_name: "default".to_string(),
                        specifier: specifier.to_string(),
                    });
                }
            }
            "namespace_import" => {
                // Namespace import: `import * as ns from '...'`
                // The identifier is the last named child.
                for j in 0..child.named_child_count() {
                    if let Some(id) = child.named_child(j) {
                        if id.kind() == "identifier" {
                            let local = id.utf8_text(bytes).unwrap_or("").to_string();
                            if !local.is_empty() {
                                out.push(ImportBinding {
                                    local_name: local,
                                    imported_name: "*".to_string(),
                                    specifier: specifier.to_string(),
                                });
                            }
                        }
                    }
                }
            }
            "named_imports" => {
                // Named imports: `import { A, B as C } from '...'`
                for j in 0..child.named_child_count() {
                    let spec = match child.named_child(j) {
                        Some(n) if n.kind() == "import_specifier" => n,
                        _ => continue,
                    };

                    let name_node = spec.child_by_field_name("name");
                    let alias_node = spec.child_by_field_name("alias");

                    let imported = name_node
                        .and_then(|n| n.utf8_text(bytes).ok())
                        .unwrap_or("")
                        .to_string();
                    let local = alias_node
                        .and_then(|n| n.utf8_text(bytes).ok())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| imported.clone());

                    if !local.is_empty() {
                        out.push(ImportBinding {
                            local_name: local,
                            imported_name: imported,
                            specifier: specifier.to_string(),
                        });
                    }
                }
            }
            _ => {}
        }
    }
}

/// One discovered import edge from a source file.
#[derive(Debug, Clone)]
pub struct ImportEdge {
    /// The raw specifier as written: `'./foo'`, `'react'`, etc.
    pub specifier: String,
    /// True when `export ... from '...'` (re-export), false for plain import.
    pub is_reexport: bool,
}

/// Parse `source` (content of a file at `path`) and return all import edges.
pub fn extract_imports(path: &str, source: &str) -> Result<Vec<ImportEdge>> {
    let language = match language_for(path) {
        Some(l) => l,
        None => return Ok(vec![]),
    };

    let mut parser = Parser::new();
    parser.set_language(&language)?;

    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => return Ok(vec![]),
    };

    // Query captures both `import ... from '...'` and `export ... from '...'`
    // as well as `require('...')` / `import('...')` call expressions.
    let query_src = r#"
        (import_statement
            source: (string) @import.source)

        (export_statement
            source: (string) @reexport.source)

        (call_expression
            function: (identifier) @fn
            (#eq? @fn "require")
            arguments: (arguments (string) @require.source))

        (call_expression
            function: (import)
            arguments: (arguments (string) @dynamic.source))
    "#;

    let query = Query::new(&language, query_src)
        .map_err(|e| anyhow::anyhow!("bad query: {e}"))?;

    let import_idx = query.capture_index_for_name("import.source").unwrap_or(u32::MAX);
    let reexport_idx = query.capture_index_for_name("reexport.source").unwrap_or(u32::MAX);
    let require_idx = query.capture_index_for_name("require.source").unwrap_or(u32::MAX);
    let dynamic_idx = query.capture_index_for_name("dynamic.source").unwrap_or(u32::MAX);

    let mut cursor = QueryCursor::new();
    let bytes = source.as_bytes();
    let root = tree.root_node();

    let mut edges = Vec::new();

    let mut matches_iter = cursor.matches(&query, root, bytes);
    while let Some(m) = matches_iter.next() {
        for cap in m.captures {
            let idx = cap.index;
            if idx == import_idx || idx == reexport_idx || idx == require_idx || idx == dynamic_idx {
                let raw = cap.node.utf8_text(bytes).unwrap_or("");
                // Strip surrounding quotes/backticks
                let specifier = raw
                    .trim()
                    .trim_matches(|c| c == '"' || c == '\'' || c == '`')
                    .to_string();
                if specifier.is_empty() {
                    continue;
                }
                let is_reexport = idx == reexport_idx;
                edges.push(ImportEdge { specifier, is_reexport });
            }
        }
    }

    Ok(edges)
}
