/// Resolve an import specifier relative to its importer to an actual file path
/// within the repo root.
///
/// Resolution rules (v1, TypeScript/JS convention):
///   1. Bare specifiers (no leading `.` / `/`) → `None` (external).
///   2. Relative (`.` / `..`) → try exact, then +ext, then /index+ext.
///   3. Absolute from root (`/`) → same as relative from root.
///
/// Returns the resolved path relative to `root`, or `None` for externals /
/// unresolvable.
use std::path::{Path, PathBuf};

const EXTENSIONS: &[&str] = &["ts", "tsx", "js", "jsx", "mjs", "cjs"];

pub fn resolve(
    root: &Path,
    importer: &Path, // absolute path of the importing file
    specifier: &str,
) -> Option<PathBuf> {
    if specifier.is_empty() {
        return None;
    }

    // Bare specifier → external
    let first = specifier.chars().next()?;
    if first != '.' && first != '/' {
        return None;
    }

    let base = if first == '/' {
        root.to_path_buf()
    } else {
        importer.parent()?.to_path_buf()
    };

    let candidate = base.join(specifier);

    // 1. Exact path
    if candidate.exists() && candidate.is_file() {
        return make_relative(root, &candidate);
    }

    // 2. Try known extensions
    for ext in EXTENSIONS {
        let with_ext = candidate.with_extension(ext);
        if with_ext.exists() {
            return make_relative(root, &with_ext);
        }
    }

    // 3. Try as directory index
    for ext in EXTENSIONS {
        let index = candidate.join(format!("index.{ext}"));
        if index.exists() {
            return make_relative(root, &index);
        }
    }

    None
}

fn make_relative(root: &Path, path: &Path) -> Option<PathBuf> {
    // Both sides must be canonicalized: on macOS /var/folders is a symlink
    // to /private/var/folders, so strip_prefix fails without canonicalizing root.
    let canon = path.canonicalize().ok()?;
    let canon_root = root.canonicalize().ok()?;
    canon.strip_prefix(&canon_root).ok().map(|p| p.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn resolves_relative_ts() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("src/a")).unwrap();
        fs::write(root.join("src/a/b.ts"), "").unwrap();

        let importer = root.join("src/a/main.ts");
        let result = resolve(root, &importer, "./b");
        assert_eq!(result, Some(PathBuf::from("src/a/b.ts")));
    }

    #[test]
    fn bare_specifier_is_none() {
        let tmp = TempDir::new().unwrap();
        let result = resolve(tmp.path(), &tmp.path().join("src/main.ts"), "react");
        assert!(result.is_none());
    }
}
