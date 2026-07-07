/// Normalize TypeScript type annotations into structured shapes.
///
/// Limitations (v1):
/// - No type checker — purely syntactic expansion.
/// - Expands type aliases / interfaces up to 2 hops deep.
/// - Generics, conditional/mapped types, template literals → Ref / Unknown.
/// - node_modules / unresolvable types → Ref { external: true }.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── public shape type ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TypeShape {
    Primitive { name: String },
    Literal   { value: String },
    Object    { fields: Vec<Field> },
    Array     { of: Box<TypeShape> },
    Union     { of: Vec<TypeShape> },
    Tuple     { of: Vec<TypeShape> },
    Ref       { name: String, args: Vec<TypeShape>, external: bool },
    Unknown   { raw: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Field {
    pub name: String,
    pub optional: bool,
    pub shape: TypeShape,
}

impl TypeShape {
    /// Returns true when this shape is `any` or `unknown` — a fragility signal.
    pub fn is_untyped(&self) -> bool {
        matches!(self, TypeShape::Primitive { name } if name == "any" || name == "unknown")
    }

    /// Returns true when this is Unknown (no annotation at all).
    pub fn is_missing(&self) -> bool {
        matches!(self, TypeShape::Unknown { raw } if raw.is_empty())
    }
}

// ── type declarations extracted from a source file ──────────────────────────

#[derive(Debug, Clone)]
pub struct TypeDecl {
    pub name: String,
    /// The raw RHS text of a type alias or the interface body text.
    pub body: String,
    /// Whether this is an `interface` (true) or `type` alias (false).
    pub is_interface: bool,
    pub exported: bool,
}

pub type TypeTable = HashMap<String, TypeDecl>;

/// Extract all type alias and interface declarations from a source file.
pub fn extract_type_decls(source: &str) -> TypeTable {
    let mut table = TypeTable::new();
    extract_type_decls_inner(source, &mut table);
    table
}

fn extract_type_decls_inner(source: &str, table: &mut TypeTable) {
    // Simple line-scanning approach — handles the common cases without
    // needing a full tree-sitter pass for types.
    let lines: Vec<&str> = source.lines().collect();
    let mut i = 0;

    while i < lines.len() {
        let line = lines[i].trim();
        let exported = line.starts_with("export ");
        let rest = if exported { line.trim_start_matches("export").trim() } else { line };

        if rest.starts_with("type ") {
            // type Foo = ...;  or  type Foo<T> = ...;
            if let Some(body) = collect_type_body_alias(rest, &lines, &mut i) {
                let name = type_alias_name(rest);
                if !name.is_empty() {
                    table.insert(name.clone(), TypeDecl { name, body, is_interface: false, exported });
                }
            } else {
                i += 1; // no '=' on this line (e.g. import type specifier) — skip it
            }
        } else if rest.starts_with("interface ") {
            // interface Foo { ... }
            if let Some(body) = collect_interface_body(rest, &lines, &mut i) {
                let name = interface_name(rest);
                if !name.is_empty() {
                    table.insert(name.clone(), TypeDecl { name, body, is_interface: true, exported });
                }
            } else {
                i += 1; // no matching '}' found — skip this line
            }
        } else {
            i += 1;
        }
    }
}

fn type_alias_name(line: &str) -> String {
    // `type Foo = ...` or `type Foo<T> = ...`
    let rest = line.trim_start_matches("type").trim();
    rest.split(['=', '<', ' '])
        .next()
        .unwrap_or("")
        .trim()
        .to_string()
}

fn interface_name(line: &str) -> String {
    let rest = line.trim_start_matches("interface").trim();
    rest.split(|c: char| c == '<' || c == '{' || c.is_whitespace())
        .next()
        .unwrap_or("")
        .trim()
        .to_string()
}

fn collect_type_body_alias(line: &str, lines: &[&str], i: &mut usize) -> Option<String> {
    // Everything after `= ` on the current and following lines until `;`
    let eq_pos = line.find('=')?;
    let mut body = line[eq_pos + 1..].trim().to_string();

    // If it doesn't end with `;`, accumulate more lines
    let mut j = *i + 1;
    while !body.ends_with(';') && j < lines.len() {
        body.push(' ');
        body.push_str(lines[j].trim());
        j += 1;
        if j - *i > 20 { break; } // safety cap
    }

    *i = j;
    Some(body.trim_end_matches(';').trim().to_string())
}

fn collect_interface_body(first_line: &str, lines: &[&str], i: &mut usize) -> Option<String> {
    // Collect everything between `{` ... `}`.
    let mut depth = 0i32;
    let mut body = String::new();

    let start_line = *i;
    let mut j = *i;

    while j < lines.len() {
        let line_text = if j == start_line { first_line } else { lines[j].trim() };
        for ch in line_text.chars() {
            if ch == '{' {
                // Only push braces that are nested *inside* the outermost
                // pair — the outer opening brace itself is a delimiter, not
                // body content.
                if depth > 0 {
                    body.push(ch);
                }
                depth += 1;
            } else if ch == '}' {
                depth -= 1;
                if depth == 0 {
                    *i = j + 1;
                    return Some(body.trim().to_string());
                }
                body.push(ch);
            } else if depth > 0 {
                body.push(ch);
            }
        }
        body.push('\n');
        j += 1;
    }

    None
}

// ── normalizer ───────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct NormCtx<'a> {
    /// Type table for the current module.
    pub local_types: &'a TypeTable,
    /// Per-module type tables keyed by module path.
    pub module_types: &'a HashMap<String, TypeTable>,
    /// Import bindings: local_name → (target_module_path, imported_name).
    pub import_map: &'a HashMap<String, (Option<String>, String)>,
    /// Remaining expansion depth.
    pub depth: u8,
    /// Names being currently expanded (prevents recursion).
    pub visiting: Vec<String>,
}

impl<'a> NormCtx<'a> {
    pub fn new(
        local_types: &'a TypeTable,
        module_types: &'a HashMap<String, TypeTable>,
        import_map: &'a HashMap<String, (Option<String>, String)>,
    ) -> Self {
        Self { local_types, module_types, import_map, depth: 2, visiting: vec![] }
    }

    fn descend(&self) -> NormCtx<'a> {
        NormCtx { depth: self.depth.saturating_sub(1), visiting: self.visiting.clone(), ..*self }
    }

    fn with_visiting(&self, name: &str) -> NormCtx<'a> {
        let mut v = self.visiting.clone();
        v.push(name.to_string());
        NormCtx { visiting: v, ..*self }
    }
}

/// Normalize a raw type annotation string into a TypeShape.
pub fn normalize(raw: &str, ctx: &NormCtx) -> TypeShape {
    let t = raw.trim();
    if t.is_empty() {
        return TypeShape::Unknown { raw: String::new() };
    }
    parse_type(t, ctx)
}

fn parse_type(t: &str, ctx: &NormCtx) -> TypeShape {
    let t = t.trim();

    // Union type: split on top-level `|`
    let parts = split_top_level(t, '|');
    if parts.len() > 1 {
        let of: Vec<TypeShape> = parts.iter().map(|p| parse_type(p.trim(), ctx)).collect();
        // Flatten single-variant unions
        if of.len() == 1 { return of.into_iter().next().unwrap(); }
        return TypeShape::Union { of };
    }

    // Intersection `&` — treat as first part (simplified)
    let parts = split_top_level(t, '&');
    if parts.len() > 1 {
        return parse_type(parts[0].trim(), ctx);
    }

    // Primitive types
    match t {
        "string" | "number" | "boolean" | "void" | "any" | "unknown"
        | "null" | "undefined" | "never" | "object" | "symbol" | "bigint" => {
            return TypeShape::Primitive { name: t.to_string() };
        }
        _ => {}
    }

    // String literal: "foo" or 'foo'
    if (t.starts_with('"') && t.ends_with('"'))
        || (t.starts_with('\'') && t.ends_with('\''))
    {
        return TypeShape::Literal { value: t.to_string() };
    }

    // Number / boolean literal
    if t == "true" || t == "false" || t.parse::<f64>().is_ok() {
        return TypeShape::Literal { value: t.to_string() };
    }

    // Array shorthand: T[]
    if let Some(inner) = t.strip_suffix("[]") {
        return TypeShape::Array { of: Box::new(parse_type(inner, ctx)) };
    }

    // Tuple type: [A, B, C]
    if t.starts_with('[') && t.ends_with(']') {
        let inner = &t[1..t.len() - 1];
        let parts = split_top_level(inner, ',');
        let of: Vec<TypeShape> = parts.iter().map(|p| parse_type(p.trim(), ctx)).collect();
        return TypeShape::Tuple { of };
    }

    // Object type: { a: T; b?: U }
    if t.starts_with('{') && t.ends_with('}') {
        let inner = &t[1..t.len() - 1];
        let fields = parse_object_fields(inner, ctx);
        return TypeShape::Object { fields };
    }

    // Generic: Name<T, U>
    if let Some(open) = t.find('<') {
        if t.ends_with('>') {
            let name = &t[..open];
            let args_str = &t[open + 1..t.len() - 1];

            // Special handling for Array<T>
            if name == "Array" {
                let arg = parse_type(args_str.trim(), ctx);
                return TypeShape::Array { of: Box::new(arg) };
            }

            // Promise<T> / Record<K, V> / etc. — expand one type arg for display
            let args: Vec<TypeShape> = split_top_level(args_str, ',')
                .iter()
                .map(|a| parse_type(a.trim(), ctx))
                .collect();
            return TypeShape::Ref { name: name.trim().to_string(), args, external: false };
        }
    }

    // Named reference — try to expand via local type table
    let name = t.to_string();

    if ctx.visiting.contains(&name) {
        // Recursion guard
        return TypeShape::Ref { name, args: vec![], external: false };
    }

    if ctx.depth > 0 {
        // Try local type table first
        if let Some(decl) = ctx.local_types.get(&name) {
            let inner_ctx = ctx.descend().with_visiting(&name);
            if decl.is_interface {
                let fields = parse_object_fields(&decl.body, &inner_ctx);
                return TypeShape::Object { fields };
            } else {
                return parse_type(&decl.body, &inner_ctx);
            }
        }

        // Try imported type (one hop)
        if let Some((module_path_opt, imported_name)) = ctx.import_map.get(&name) {
            if let Some(module_path) = module_path_opt {
                if let Some(mod_types) = ctx.module_types.get(module_path) {
                    if let Some(decl) = mod_types.get(imported_name) {
                        let inner_ctx = ctx.descend().with_visiting(&name);
                        if decl.is_interface {
                            let fields = parse_object_fields(&decl.body, &inner_ctx);
                            return TypeShape::Object { fields };
                        } else {
                            return parse_type(&decl.body, &inner_ctx);
                        }
                    }
                }
            }
            // Import didn't resolve → external
            return TypeShape::Ref { name, args: vec![], external: true };
        }
    }

    // Unknown named reference
    TypeShape::Ref { name, args: vec![], external: false }
}

fn parse_object_fields(body: &str, ctx: &NormCtx) -> Vec<Field> {
    let mut fields = Vec::new();
    // Split on `;` or `,` or newlines (top-level only)
    let parts = split_object_members(body);
    for part in parts {
        let part = part.trim();
        if part.is_empty() || part.starts_with("//") || part.starts_with("/*") {
            continue;
        }
        // Skip index signatures: [key: T]: U
        if part.starts_with('[') {
            continue;
        }
        // Method signatures: foo(a: T): U — skip
        if part.contains('(') {
            continue;
        }
        // readonly modifier
        let part = part.trim_start_matches("readonly").trim();

        if let Some(colon_pos) = find_colon_pos(part) {
            let key_part = part[..colon_pos].trim();
            let val_part = part[colon_pos + 1..].trim().trim_end_matches(';').trim_end_matches(',').trim();

            let optional = key_part.ends_with('?');
            let name = key_part.trim_end_matches('?').trim().to_string();

            if !name.is_empty() && !name.contains(' ') {
                let shape = parse_type(val_part, ctx);
                fields.push(Field { name, optional, shape });
            }
        }
    }
    fields
}

/// Find the first `:` that is at depth 0 (not inside angle brackets, parens, etc.)
fn find_colon_pos(s: &str) -> Option<usize> {
    let mut depth = 0i32;
    for (i, c) in s.char_indices() {
        match c {
            '<' | '(' | '[' | '{' => depth += 1,
            '>' | ')' | ']' | '}' => depth -= 1,
            ':' if depth == 0 => return Some(i),
            _ => {}
        }
    }
    None
}

/// Split `s` on top-level occurrences of `delimiter` (not inside angle brackets / parens / braces).
fn split_top_level(s: &str, delimiter: char) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut start = 0;

    for (i, c) in s.char_indices() {
        match c {
            '<' | '(' | '[' | '{' => depth += 1,
            '>' | ')' | ']' | '}' => depth -= 1,
            d if d == delimiter && depth == 0 => {
                parts.push(&s[start..i]);
                start = i + delimiter.len_utf8();
            }
            _ => {}
        }
    }
    parts.push(&s[start..]);
    parts
}

/// Split object body into member declarations on top-level `;` or `,` or newlines.
fn split_object_members(body: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut start = 0;

    let mut i = 0;
    while i < body.len() {
        let c = body[i..].chars().next().unwrap_or('\0');
        match c {
            '<' | '(' | '[' | '{' => depth += 1,
            '>' | ')' | ']' | '}' => { if depth > 0 { depth -= 1; } }
            ';' | ',' | '\n' if depth == 0 => {
                let part = &body[start..i];
                if !part.trim().is_empty() {
                    parts.push(part);
                }
                start = i + 1;
            }
            _ => {}
        }
        i += c.len_utf8();
    }

    let last = &body[start..];
    if !last.trim().is_empty() {
        parts.push(last);
    }
    parts
}

// ── tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_ctx() -> (TypeTable, HashMap<String, TypeTable>, HashMap<String, (Option<String>, String)>) {
        (TypeTable::new(), HashMap::new(), HashMap::new())
    }

    #[test]
    fn primitive_types() {
        let (lt, mt, im) = empty_ctx();
        let ctx = NormCtx::new(&lt, &mt, &im);
        assert_eq!(normalize("string", &ctx), TypeShape::Primitive { name: "string".into() });
        assert_eq!(normalize("any", &ctx), TypeShape::Primitive { name: "any".into() });
    }

    #[test]
    fn array_shorthand() {
        let (lt, mt, im) = empty_ctx();
        let ctx = NormCtx::new(&lt, &mt, &im);
        let shape = normalize("string[]", &ctx);
        assert!(matches!(shape, TypeShape::Array { .. }));
    }

    #[test]
    fn union_type() {
        let (lt, mt, im) = empty_ctx();
        let ctx = NormCtx::new(&lt, &mt, &im);
        let shape = normalize("string | null", &ctx);
        assert!(matches!(shape, TypeShape::Union { .. }));
    }

    #[test]
    fn object_fields() {
        let (lt, mt, im) = empty_ctx();
        let ctx = NormCtx::new(&lt, &mt, &im);
        let shape = normalize("{ id: number; name?: string }", &ctx);
        if let TypeShape::Object { fields } = shape {
            assert_eq!(fields.len(), 2);
            assert_eq!(fields[0].name, "id");
            assert!(!fields[0].optional);
            assert_eq!(fields[1].name, "name");
            assert!(fields[1].optional);
        } else {
            panic!("expected Object, got {:?}", shape);
        }
    }

    #[test]
    fn interface_expansion() {
        let src = "interface User { id: number; email?: string }";
        let table = extract_type_decls(src);
        let (mt, im) = (HashMap::new(), HashMap::new());
        let ctx = NormCtx::new(&table, &mt, &im);
        let shape = normalize("User", &ctx);
        if let TypeShape::Object { fields } = shape {
            assert_eq!(fields.len(), 2);
        } else {
            panic!("expected Object, got {:?}", shape);
        }
    }

    #[test]
    fn recursion_guard() {
        // Recursive type: type T = { child?: T }
        // Should expand once then stop.
        let mut table = TypeTable::new();
        table.insert("T".into(), TypeDecl {
            name: "T".into(),
            body: "{ child?: T }".into(),
            is_interface: false,
            exported: false,
        });
        let (mt, im) = (HashMap::new(), HashMap::new());
        let ctx = NormCtx::new(&table, &mt, &im);
        // Should not panic/stack overflow
        let shape = normalize("T", &ctx);
        assert!(matches!(shape, TypeShape::Object { .. }));
    }

    #[test]
    fn is_untyped() {
        assert!(TypeShape::Primitive { name: "any".into() }.is_untyped());
        assert!(TypeShape::Primitive { name: "unknown".into() }.is_untyped());
        assert!(!TypeShape::Primitive { name: "string".into() }.is_untyped());
    }

    #[test]
    fn extract_type_decls_basic() {
        let src = "export interface Foo { a: string; b?: number }\ntype Bar = string | null;";
        let table = extract_type_decls(src);
        assert!(table.contains_key("Foo"));
        assert!(table.contains_key("Bar"));
        assert!(table["Foo"].is_interface);
        assert!(!table["Bar"].is_interface);
    }
}
