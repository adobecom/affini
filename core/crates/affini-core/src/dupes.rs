/// Duplication / divergence radar.
///
/// Finds pairs (and clusters) of files that are structurally similar — typical
/// output of copy-paste-then-tweak or of agents independently implementing the
/// same concept.
///
/// Algorithm
/// ---------
/// 1. For each file, strip comments + string/number literals, then produce a
///    stream of normalized tokens.
/// 2. Build a set of k-shingles (N-grams of token hashes).
/// 3. Compute pairwise Jaccard similarity between shingle sets.
/// 4. Group files above `threshold` into clusters via union-find.
///
/// Complexity is O(files²) in shingle-comparison, which is fine for the repo
/// sizes affini targets.  MinHash/LSH can be added later if needed.
use crate::model::Model;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    hash::{Hash, Hasher},
    collections::hash_map::DefaultHasher,
    path::Path,
};

pub const DEFAULT_THRESHOLD: f32 = 0.60;
const SHINGLE_N: usize = 4;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DupeCluster {
    /// Relative file paths (repo-root-relative), sorted.
    pub files: Vec<String>,
    /// Average pairwise Jaccard similarity within this cluster (0–1).
    pub similarity: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DupesReport {
    pub clusters: Vec<DupeCluster>,
    pub files_analyzed: usize,
    pub threshold: f32,
}

pub fn find_dupes(model: &Model, root: &Path, threshold: f32) -> DupesReport {
    let file_paths: Vec<&str> = model
        .modules
        .iter()
        .filter(|m| m.is_file)
        .map(|m| m.path.as_str())
        .collect();

    let files_analyzed = file_paths.len();

    // Build shingle sets for each readable file.
    let indexed: Vec<(&str, HashSet<u64>)> = file_paths
        .iter()
        .filter_map(|&p| {
            let src = std::fs::read_to_string(root.join(p)).ok()?;
            let set = shingle_source(&src);
            if set.is_empty() { return None; }
            Some((p, set))
        })
        .collect();

    let n = indexed.len();
    let mut uf = UnionFind::new(n);
    let mut pairs: Vec<(usize, usize, f32)> = Vec::new();

    for i in 0..n {
        for j in (i + 1)..n {
            let sim = jaccard(&indexed[i].1, &indexed[j].1);
            if sim >= threshold {
                uf.union(i, j);
                pairs.push((i, j, sim));
            }
        }
    }

    // Group indices by union-find representative.
    let mut groups: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..n {
        groups.entry(uf.find(i)).or_default().push(i);
    }

    let mut clusters: Vec<DupeCluster> = groups
        .into_iter()
        .filter(|(_, members)| members.len() > 1)
        .map(|(_, members)| {
            let member_set: HashSet<usize> = members.iter().copied().collect();
            let pair_sims: Vec<f32> = pairs
                .iter()
                .filter(|(i, j, _)| member_set.contains(i) && member_set.contains(j))
                .map(|(_, _, s)| *s)
                .collect();
            let avg_sim = if pair_sims.is_empty() {
                threshold
            } else {
                pair_sims.iter().copied().sum::<f32>() / pair_sims.len() as f32
            };
            let mut files: Vec<String> =
                members.iter().map(|&i| indexed[i].0.to_string()).collect();
            files.sort();
            DupeCluster { files, similarity: round2(avg_sim) }
        })
        .collect();

    // Largest clusters first, then by highest similarity.
    clusters.sort_by(|a, b| {
        b.files.len().cmp(&a.files.len()).then(
            b.similarity
                .partial_cmp(&a.similarity)
                .unwrap_or(std::cmp::Ordering::Equal),
        )
    });

    DupesReport { clusters, files_analyzed, threshold }
}

// ---------------------------------------------------------------------------
// Shingling
// ---------------------------------------------------------------------------

fn shingle_source(src: &str) -> HashSet<u64> {
    let tokens = tokenize_source(src);
    if tokens.len() < SHINGLE_N {
        return HashSet::new();
    }
    tokens.windows(SHINGLE_N).map(hash_window).collect()
}

fn hash_window(window: &[u64]) -> u64 {
    let mut h = DefaultHasher::new();
    window.hash(&mut h);
    h.finish()
}

/// Produce a normalized token stream from JS/TS source.
///
/// - Comments stripped (line and block).
/// - String/template literals → SENTINEL_STR.
/// - Number literals → SENTINEL_NUM.
/// - Identifiers lowercased and hashed (structure preserved; names normalised).
/// - Operators / punctuation kept as raw char code.
fn tokenize_source(src: &str) -> Vec<u64> {
    const SENTINEL_STR: u64 = 0xFFFF_0001;
    const SENTINEL_NUM: u64 = 0xFFFF_0002;
    const SENTINEL_RE:  u64 = 0xFFFF_0003;

    let stripped = strip_noise(src);
    let mut tokens = Vec::new();
    let mut word = String::new();

    for ch in stripped.chars() {
        if ch.is_alphanumeric() || ch == '_' || ch == '$' {
            word.push(ch);
        } else {
            if !word.is_empty() {
                let tok = match word.as_str() {
                    "__LITSTR__"   => SENTINEL_STR,
                    "__LITNUM__"   => SENTINEL_NUM,
                    "__LITREGEX__" => SENTINEL_RE,
                    _ => hash_str(&word.to_lowercase()),
                };
                tokens.push(tok);
                word.clear();
            }
            if !ch.is_whitespace() {
                tokens.push(ch as u64);
            }
        }
    }
    if !word.is_empty() {
        let tok = match word.as_str() {
            "__LITSTR__"   => SENTINEL_STR,
            "__LITNUM__"   => SENTINEL_NUM,
            "__LITREGEX__" => SENTINEL_RE,
            _ => hash_str(&word.to_lowercase()),
        };
        tokens.push(tok);
    }
    tokens
}

/// Strip single-line + block comments, string literals, and number literals.
/// Placeholders use `__LITSTR__` / `__LITNUM__` so `tokenize_source` can
/// recognise them as single distinct token types without re-scanning.
fn strip_noise(src: &str) -> String {
    let chars: Vec<char> = src.chars().collect();
    let n = chars.len();
    let mut out = String::with_capacity(n);
    let mut i = 0;

    while i < n {
        // Line comment: // ...
        if i + 1 < n && chars[i] == '/' && chars[i + 1] == '/' {
            while i < n && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }

        // Block comment: /* ... */
        if i + 1 < n && chars[i] == '/' && chars[i + 1] == '*' {
            i += 2;
            while i + 1 < n && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            if i + 1 < n { i += 2; }  // skip */ only if terminator was found
            out.push(' ');
            continue;
        }

        // Regex literals: /pattern/flags
        // Heuristic: if the previous non-whitespace char is NOT a value-terminator
        // (identifier char, ), ], number), treat / as the start of a regex.
        // This prevents embedded quotes inside a regex from hijacking string
        // stripping.  Not 100% accurate for `typeof /x/` but covers the common cases.
        if chars[i] == '/'
            && i + 1 < n
            && chars[i + 1] != '/'
            && chars[i + 1] != '*'
            && !is_after_value(&chars, i)
        {
            i += 1;
            while i < n {
                if chars[i] == '\\' {
                    i += 2;
                    continue;
                }
                if chars[i] == '[' {
                    // character class — `]` inside does not close the regex
                    i += 1;
                    while i < n {
                        if chars[i] == '\\' { i += 2; }
                        else if chars[i] == ']' { i += 1; break; }
                        else { i += 1; }
                    }
                    continue;
                }
                if chars[i] == '/' { i += 1; break; }
                if chars[i] == '\n' { break; } // unterminated regex — stop at newline
                i += 1;
            }
            // skip flags (g, i, m, s, u, d, v)
            while i < n && chars[i].is_ascii_alphabetic() { i += 1; }
            out.push_str(" __LITREGEX__ ");
            continue;
        }

        // String / template literals: ", ', `
        if chars[i] == '"' || chars[i] == '\'' || chars[i] == '`' {
            let delim = chars[i];
            i += 1;
            while i < n {
                if chars[i] == '\\' {
                    i += 2;
                } else if chars[i] == delim {
                    i += 1;
                    break;
                } else {
                    i += 1;
                }
            }
            out.push_str(" __LITSTR__ ");
            continue;
        }

        // Number literals (digit-leading tokens)
        if chars[i].is_ascii_digit() {
            while i < n
                && (chars[i].is_ascii_alphanumeric() || chars[i] == '.' || chars[i] == '_')
            {
                i += 1;
            }
            out.push_str(" __LITNUM__ ");
            continue;
        }

        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Returns true when the character at `pos` likely follows a value expression
/// (identifier, `)`, `]`, number) — i.e., the `/` is division, not regex start.
fn is_after_value(chars: &[char], pos: usize) -> bool {
    let mut j = pos;
    while j > 0 {
        j -= 1;
        if chars[j].is_whitespace() { continue; }
        return chars[j].is_alphanumeric()
            || chars[j] == '_'
            || chars[j] == '$'
            || chars[j] == ')'
            || chars[j] == ']';
    }
    false
}

fn hash_str(s: &str) -> u64 {
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

fn jaccard(a: &HashSet<u64>, b: &HashSet<u64>) -> f32 {
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    let intersection = a.intersection(b).count();
    let union = a.len() + b.len() - intersection;
    if union == 0 { 1.0 } else { intersection as f32 / union as f32 }
}

fn round2(v: f32) -> f32 {
    (v * 100.0).round() / 100.0
}

// ---------------------------------------------------------------------------
// Union-Find with path compression + union-by-rank
// ---------------------------------------------------------------------------

struct UnionFind {
    parent: Vec<usize>,
    rank: Vec<u8>,
}

impl UnionFind {
    fn new(n: usize) -> Self {
        Self { parent: (0..n).collect(), rank: vec![0; n] }
    }

    fn find(&mut self, x: usize) -> usize {
        // Iterative path-halving: avoids stack overflow on deep chains.
        let mut x = x;
        while self.parent[x] != x {
            self.parent[x] = self.parent[self.parent[x]]; // path halving
            x = self.parent[x];
        }
        x
    }

    fn union(&mut self, x: usize, y: usize) {
        let rx = self.find(x);
        let ry = self.find(y);
        if rx == ry { return; }
        match self.rank[rx].cmp(&self.rank[ry]) {
            std::cmp::Ordering::Less    => self.parent[rx] = ry,
            std::cmp::Ordering::Greater => self.parent[ry] = rx,
            std::cmp::Ordering::Equal   => { self.parent[ry] = rx; self.rank[rx] += 1; }
        }
    }
}
