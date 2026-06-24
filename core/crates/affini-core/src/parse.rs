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
