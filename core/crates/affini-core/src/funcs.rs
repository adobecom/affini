/// Extract function declarations and call-sites from TypeScript / JavaScript source.
use anyhow::Result;
use serde::{Deserialize, Serialize};
use streaming_iterator::StreamingIterator;
use tree_sitter::{Node, Parser, Query, QueryCursor};

// ── language helpers (mirrors parse.rs) ─────────────────────────────────────

fn ts_language() -> tree_sitter::Language {
    tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()
}
fn tsx_language() -> tree_sitter::Language {
    tree_sitter_typescript::LANGUAGE_TSX.into()
}
fn js_language() -> tree_sitter::Language {
    tree_sitter_javascript::LANGUAGE.into()
}
fn language_for(path: &str) -> Option<tree_sitter::Language> {
    match path.rsplit('.').next()? {
        "ts" => Some(ts_language()),
        "tsx" => Some(tsx_language()),
        "js" | "mjs" | "cjs" | "jsx" => Some(js_language()),
        _ => None,
    }
}

// ── public types ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Param {
    pub name: String,
    pub type_annotation: Option<String>,
    pub optional: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawCall {
    pub callee_text: String,
    /// Leftmost identifier of the callee ("foo" in "svc.foo", "foo" in "foo").
    pub callee_root: String,
    /// Property chain after root (["foo"] in "svc.foo").
    pub member_path: Vec<String>,
    pub call_order: u32,
    pub arg_texts: Vec<String>,
    /// True when this call site is inside a conditional/loop/catch.
    pub branchy: bool,
    /// Index into the enclosing function's `branchy_ranges` list for the
    /// most-specific (smallest) enclosing branch block.  Two calls inside the
    /// same `if`/`for`/`switch` body share the same `branch_id`.
    #[serde(default)]
    pub branch_id: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawFunction {
    pub name: String,
    pub order: u32,
    pub exported: bool,
    pub is_default_export: bool,
    pub is_method: bool,
    pub class_name: Option<String>,
    pub params: Vec<Param>,
    pub return_type: Option<String>,
    pub start_byte: usize,
    pub end_byte: usize,
    pub raw_calls: Vec<RawCall>,
}

// ── internal intermediate ────────────────────────────────────────────────────

#[derive(Debug)]
struct FnSpan {
    name: String,
    exported: bool,
    is_default_export: bool,
    is_method: bool,
    class_name: Option<String>,
    params: Vec<Param>,
    return_type: Option<String>,
    start_byte: usize,
    end_byte: usize,
}

#[derive(Debug, Clone)]
struct RawCallInfo {
    callee_text: String,
    callee_root: String,
    member_path: Vec<String>,
    arg_texts: Vec<String>,
}

// ── public entry point ───────────────────────────────────────────────────────

pub fn extract_functions(path: &str, source: &str) -> Result<Vec<RawFunction>> {
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

    // 1. Collect all function-like spans by recursively walking the tree.
    let mut spans: Vec<FnSpan> = Vec::new();
    collect_fns(root, bytes, false, false, None, &mut spans);
    spans.sort_by_key(|s| s.start_byte);

    // 2. Collect all call expressions via query.
    let all_calls = collect_calls(&language, root, bytes).unwrap_or_default();

    // 3. Collect branchy node ranges (for the branchy flag).
    let branchy_ranges = collect_branchy_ranges(&language, root, bytes).unwrap_or_default();

    // 4. Attribute each call to the innermost enclosing function.
    //    "Innermost" = largest fn.start_byte that still contains the call.
    let fn_ranges: Vec<(usize, usize, usize)> = spans
        .iter()
        .enumerate()
        .map(|(i, s)| (s.start_byte, s.end_byte, i))
        .collect();

    // fn_index → Vec<(start_byte, RawCallInfo)>
    let mut fn_call_map: Vec<Vec<(usize, RawCallInfo)>> = vec![Vec::new(); spans.len()];

    for (call_start, info) in &all_calls {
        let innermost = fn_ranges
            .iter()
            .filter(|(fs, fe, _)| *call_start >= *fs && *call_start < *fe)
            .max_by_key(|(fs, _, _)| *fs);
        if let Some((_, _, fn_idx)) = innermost {
            fn_call_map[*fn_idx].push((*call_start, info.clone()));
        }
    }

    // 5. Build final RawFunction list.
    let mut result: Vec<RawFunction> = Vec::new();
    for (order, (span, mut calls)) in spans.into_iter().zip(fn_call_map).enumerate() {
        let fn_start = span.start_byte;
        let fn_end = span.end_byte;

        calls.sort_by_key(|(start, _)| *start);

        let raw_calls = calls
            .into_iter()
            .enumerate()
            .map(|(call_idx, (call_start, info))| {
                // Find the most-specific (smallest span) enclosing branchy block
                // that is also entirely inside this function body.
                let branch_id = branchy_ranges
                    .iter()
                    .enumerate()
                    .filter(|(_, (bs, be))| {
                        call_start >= *bs
                            && call_start < *be
                            && *bs >= fn_start
                            && *be <= fn_end
                    })
                    .min_by_key(|(_, (bs, be))| be - bs)
                    .map(|(i, _)| i as u32);
                let branchy = branch_id.is_some();
                RawCall {
                    callee_text: info.callee_text,
                    callee_root: info.callee_root,
                    member_path: info.member_path,
                    call_order: call_idx as u32,
                    arg_texts: info.arg_texts,
                    branchy,
                    branch_id,
                }
            })
            .collect();

        result.push(RawFunction {
            name: span.name,
            order: order as u32,
            exported: span.exported,
            is_default_export: span.is_default_export,
            is_method: span.is_method,
            class_name: span.class_name,
            params: span.params,
            return_type: span.return_type,
            start_byte: fn_start,
            end_byte: fn_end,
            raw_calls,
        });
    }

    Ok(result)
}

// ── tree walk for function collection ────────────────────────────────────────

/// Recursively walk `node`, collecting function-like spans into `out`.
/// `exported` / `is_default` propagate downward through export_statement nodes.
fn collect_fns(
    node: Node,
    bytes: &[u8],
    exported: bool,
    is_default: bool,
    class_name: Option<&str>,
    out: &mut Vec<FnSpan>,
) {
    match node.kind() {
        "function_declaration" | "function_expression" | "generator_function_declaration" => {
            let name = node
                .child_by_field_name("name")
                .and_then(|n| n.utf8_text(bytes).ok())
                .map(|s| s.to_string())
                .unwrap_or_else(|| if is_default { "default".to_string() } else { "anonymous".to_string() });

            let params = node
                .child_by_field_name("parameters")
                .map(|n| extract_params(n, bytes))
                .unwrap_or_default();

            let return_type = node
                .child_by_field_name("return_type")
                .and_then(|n| n.utf8_text(bytes).ok())
                .map(strip_type_prefix);

            out.push(FnSpan {
                name,
                exported,
                is_default_export: is_default,
                is_method: class_name.is_some(),
                class_name: class_name.map(|s| s.to_string()),
                params,
                return_type,
                start_byte: node.start_byte(),
                end_byte: node.end_byte(),
            });

            // Recurse into body for nested functions (mark non-exported).
            if let Some(body) = node.child_by_field_name("body") {
                for i in 0..body.named_child_count() {
                    if let Some(child) = body.named_child(i) {
                        collect_fns(child, bytes, false, false, None, out);
                    }
                }
            }
        }

        "variable_declarator" => {
            // Capture: const/let foo = () => ...  or  const foo = function() { ... }
            if let Some(value) = node.child_by_field_name("value") {
                if value.kind() == "arrow_function" || value.kind() == "function_expression" || value.kind() == "generator_function" {
                    let name = node
                        .child_by_field_name("name")
                        .and_then(|n| n.utf8_text(bytes).ok())
                        .unwrap_or("anonymous")
                        .to_string();

                    // Arrow functions: params field might be formal_parameters or identifier.
                    let params = value
                        .child_by_field_name("parameters")
                        .map(|n| {
                            if n.kind() == "formal_parameters" {
                                extract_params(n, bytes)
                            } else if n.kind() == "identifier" {
                                // Single-param shorthand: x => ...
                                vec![Param {
                                    name: n.utf8_text(bytes).unwrap_or("_").to_string(),
                                    type_annotation: None,
                                    optional: false,
                                }]
                            } else {
                                vec![]
                            }
                        })
                        .unwrap_or_default();

                    let return_type = value
                        .child_by_field_name("return_type")
                        .and_then(|n| n.utf8_text(bytes).ok())
                        .map(strip_type_prefix);

                    out.push(FnSpan {
                        name,
                        exported,
                        is_default_export: is_default,
                        is_method: false,
                        class_name: None,
                        params,
                        return_type,
                        start_byte: value.start_byte(),
                        end_byte: value.end_byte(),
                    });

                    // Recurse into body.
                    if let Some(body) = value.child_by_field_name("body") {
                        for i in 0..body.named_child_count() {
                            if let Some(child) = body.named_child(i) {
                                collect_fns(child, bytes, false, false, None, out);
                            }
                        }
                    }
                } else {
                    // Value is something else; recurse in case there are nested fns.
                    for i in 0..value.named_child_count() {
                        if let Some(child) = value.named_child(i) {
                            collect_fns(child, bytes, false, false, None, out);
                        }
                    }
                }
            }
        }

        "method_definition" => {
            let name_node = node.child_by_field_name("name");
            let raw_name = name_node
                .and_then(|n| n.utf8_text(bytes).ok())
                .unwrap_or("anonymous")
                .to_string();

            let qualified = match class_name {
                Some(cls) => format!("{}.{}", cls, raw_name),
                None => raw_name,
            };

            let params = node
                .child_by_field_name("parameters")
                .map(|n| extract_params(n, bytes))
                .unwrap_or_default();

            let return_type = node
                .child_by_field_name("return_type")
                .and_then(|n| n.utf8_text(bytes).ok())
                .map(strip_type_prefix);

            out.push(FnSpan {
                name: qualified,
                exported,
                is_default_export: false,
                is_method: true,
                class_name: class_name.map(|s| s.to_string()),
                params,
                return_type,
                start_byte: node.start_byte(),
                end_byte: node.end_byte(),
            });

            if let Some(body) = node.child_by_field_name("body") {
                for i in 0..body.named_child_count() {
                    if let Some(child) = body.named_child(i) {
                        collect_fns(child, bytes, false, false, None, out);
                    }
                }
            }
        }

        "export_statement" => {
            let has_default = (0..node.child_count())
                .filter_map(|i| node.child(i))
                .any(|c| c.kind() == "default");

            for i in 0..node.named_child_count() {
                if let Some(child) = node.named_child(i) {
                    collect_fns(child, bytes, true, has_default, class_name, out);
                }
            }
        }

        "class_declaration" | "class_expression" => {
            let cls_name = node
                .child_by_field_name("name")
                .and_then(|n| n.utf8_text(bytes).ok())
                .map(|s| s.to_string());

            if let Some(body) = node.child_by_field_name("body") {
                for i in 0..body.named_child_count() {
                    if let Some(child) = body.named_child(i) {
                        collect_fns(child, bytes, exported, false, cls_name.as_deref(), out);
                    }
                }
            }
        }

        // Containers — recurse but reset export context (export_statement handled above).
        "program" | "statement_block" | "module" => {
            for i in 0..node.named_child_count() {
                if let Some(child) = node.named_child(i) {
                    collect_fns(child, bytes, false, false, class_name, out);
                }
            }
        }

        // Everything else — recurse with same context (handles lexical_declaration,
        // expression_statement, etc. that wrap things we care about).
        _ => {
            for i in 0..node.named_child_count() {
                if let Some(child) = node.named_child(i) {
                    collect_fns(child, bytes, exported, is_default, class_name, out);
                }
            }
        }
    }
}

// ── param extraction ─────────────────────────────────────────────────────────

fn extract_params(formal_params: Node, bytes: &[u8]) -> Vec<Param> {
    let mut params = Vec::new();

    for i in 0..formal_params.named_child_count() {
        let child = match formal_params.named_child(i) {
            Some(n) => n,
            None => continue,
        };

        match child.kind() {
            "required_parameter" => {
                params.push(parse_param(child, bytes, false));
            }
            "optional_parameter" => {
                params.push(parse_param(child, bytes, true));
            }
            "rest_parameter" => {
                let inner = child.named_child(0);
                let name = inner
                    .and_then(|n| if n.kind() == "identifier" { n.utf8_text(bytes).ok() } else { None })
                    .unwrap_or("args")
                    .to_string();
                let type_text = child
                    .child_by_field_name("type")
                    .and_then(|n| n.utf8_text(bytes).ok())
                    .map(strip_type_prefix);
                params.push(Param { name: format!("...{name}"), type_annotation: type_text, optional: true });
            }
            "identifier" | "shorthand_property_identifier_pattern" => {
                // Plain JS param (no type)
                let name = child.utf8_text(bytes).unwrap_or("_").to_string();
                params.push(Param { name, type_annotation: None, optional: false });
            }
            _ => {} // skip assignment_pattern, destructuring_pattern, etc.
        }
    }

    params
}

fn parse_param(node: Node, bytes: &[u8], optional: bool) -> Param {
    // pattern field = the name/destructuring
    let name_node = node
        .child_by_field_name("pattern")
        .or_else(|| node.named_child(0));
    let name = name_node
        .and_then(|n| n.utf8_text(bytes).ok())
        .unwrap_or("_")
        .to_string();

    // type field = the type annotation
    let type_text = node
        .child_by_field_name("type")
        .and_then(|n| n.utf8_text(bytes).ok())
        .map(strip_type_prefix)
        .filter(|s| !s.is_empty());

    // Also check: is it optional due to `?` or having a default value?
    let is_optional = optional
        || (0..node.child_count())
            .filter_map(|i| node.child(i))
            .any(|c| c.kind() == "?");

    Param { name, type_annotation: type_text, optional: is_optional }
}

// ── call-expression collection ───────────────────────────────────────────────

fn collect_calls(
    language: &tree_sitter::Language,
    root: Node,
    bytes: &[u8],
) -> Result<Vec<(usize, RawCallInfo)>> {
    let query = Query::new(language, "(call_expression) @call")
        .map_err(|e| anyhow::anyhow!("call query error: {e}"))?;

    let call_idx = query.capture_index_for_name("call").unwrap_or(0);
    let mut cursor = QueryCursor::new();
    let mut calls = Vec::new();

    let mut it = cursor.matches(&query, root, bytes);
    while let Some(m) = it.next() {
        for cap in m.captures {
            if cap.index != call_idx { continue; }
            let call_node = cap.node;
            let fn_node = match call_node.child_by_field_name("function") {
                Some(n) => n,
                None => continue,
            };
            let (callee_text, callee_root, member_path) = callee_info(fn_node, bytes);
            let arg_texts = call_node
                .child_by_field_name("arguments")
                .map(|n| extract_arg_texts(n, bytes))
                .unwrap_or_default();

            calls.push((call_node.start_byte(), RawCallInfo { callee_text, callee_root, member_path, arg_texts }));
        }
    }

    Ok(calls)
}

fn callee_info(node: Node, bytes: &[u8]) -> (String, String, Vec<String>) {
    let callee_text = node.utf8_text(bytes).unwrap_or("").to_string();
    match node.kind() {
        "identifier" | "property_identifier" => {
            (callee_text.clone(), callee_text, vec![])
        }
        "member_expression" => {
            let obj = node.child_by_field_name("object");
            let prop = node.child_by_field_name("property");
            if let (Some(o), Some(p)) = (obj, prop) {
                let prop_text = p.utf8_text(bytes).unwrap_or("").to_string();
                let (_, root, mut path) = callee_info(o, bytes);
                path.push(prop_text);
                (callee_text, root, path)
            } else {
                (callee_text.clone(), callee_text, vec![])
            }
        }
        _ => (callee_text.clone(), callee_text, vec![]),
    }
}

fn extract_arg_texts(args_node: Node, bytes: &[u8]) -> Vec<String> {
    let mut texts = Vec::new();
    for i in 0..args_node.named_child_count() {
        if let Some(child) = args_node.named_child(i) {
            if let Ok(text) = child.utf8_text(bytes) {
                texts.push(text.to_string());
            }
        }
    }
    texts
}

// ── branchy range collection ─────────────────────────────────────────────────

fn collect_branchy_ranges(
    language: &tree_sitter::Language,
    root: Node,
    bytes: &[u8],
) -> Result<Vec<(usize, usize)>> {
    let query_src = "[
        (if_statement)
        (for_statement)
        (for_in_statement)
        (while_statement)
        (do_statement)
        (switch_statement)
        (try_statement)
        (catch_clause)
        (ternary_expression)
    ] @branchy";

    let query = match Query::new(language, query_src) {
        Ok(q) => q,
        Err(_) => return Ok(vec![]),
    };

    let b_idx = query.capture_index_for_name("branchy").unwrap_or(0);
    let mut cursor = QueryCursor::new();
    let mut ranges = Vec::new();

    let mut it = cursor.matches(&query, root, bytes);
    while let Some(m) = it.next() {
        for cap in m.captures {
            if cap.index == b_idx {
                ranges.push((cap.node.start_byte(), cap.node.end_byte()));
            }
        }
    }

    Ok(ranges)
}

// ── helpers ──────────────────────────────────────────────────────────────────

/// Strip leading `: ` from a type annotation text.
fn strip_type_prefix(s: &str) -> String {
    s.trim().trim_start_matches(':').trim().to_string()
}

// ── tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_function_declaration() {
        let src = r#"
            export function createUser(name: string, email: string): Promise<User> {
                return db.insert(name, email);
            }
        "#;
        let fns = extract_functions("test.ts", src).unwrap();
        assert_eq!(fns.len(), 1);
        let f = &fns[0];
        assert_eq!(f.name, "createUser");
        assert!(f.exported);
        assert!(!f.is_default_export);
        assert_eq!(f.params.len(), 2);
        assert_eq!(f.params[0].name, "name");
        assert_eq!(f.params[0].type_annotation.as_deref(), Some("string"));
        assert!(!f.params[0].optional);
        assert!(f.return_type.is_some());
    }

    #[test]
    fn extracts_arrow_const() {
        let src = r#"
            export const getUser = async (id: number): Promise<User> => {
                return cache.get(id);
            };
        "#;
        let fns = extract_functions("test.ts", src).unwrap();
        assert_eq!(fns.len(), 1);
        assert_eq!(fns[0].name, "getUser");
        assert!(fns[0].exported);
        assert_eq!(fns[0].params.len(), 1);
    }

    #[test]
    fn extracts_class_method() {
        let src = r#"
            class UserService {
                createUser(name: string): User {
                    return { name };
                }
            }
        "#;
        let fns = extract_functions("test.ts", src).unwrap();
        assert_eq!(fns.len(), 1);
        assert_eq!(fns[0].name, "UserService.createUser");
        assert!(fns[0].is_method);
        assert_eq!(fns[0].class_name.as_deref(), Some("UserService"));
    }

    #[test]
    fn attributes_calls_to_innermost_function() {
        let src = r#"
            function outer() {
                function inner() {
                    foo();
                }
                bar();
            }
        "#;
        let fns = extract_functions("test.ts", src).unwrap();
        // Should have 2 functions: outer and inner
        assert_eq!(fns.len(), 2);
        let outer = fns.iter().find(|f| f.name == "outer").unwrap();
        let inner = fns.iter().find(|f| f.name == "inner").unwrap();
        // bar() is in outer (not inside inner), foo() is in inner
        assert_eq!(outer.raw_calls.len(), 1);
        assert_eq!(outer.raw_calls[0].callee_text, "bar");
        assert_eq!(inner.raw_calls.len(), 1);
        assert_eq!(inner.raw_calls[0].callee_text, "foo");
    }

    #[test]
    fn call_on_member_expression() {
        let src = r#"
            function run() {
                svc.save(data);
            }
        "#;
        let fns = extract_functions("test.ts", src).unwrap();
        assert_eq!(fns[0].raw_calls[0].callee_root, "svc");
        assert_eq!(fns[0].raw_calls[0].member_path, vec!["save"]);
    }

    #[test]
    fn js_file_no_types() {
        let src = r#"
            function hello(name) {
                console.log(name);
            }
        "#;
        let fns = extract_functions("test.js", src).unwrap();
        assert_eq!(fns.len(), 1);
        assert_eq!(fns[0].params[0].type_annotation, None);
    }
}
