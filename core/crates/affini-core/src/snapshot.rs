/// Lightweight JSON snapshot store under `.affini/snapshots/`.
///
/// Snapshots are labelled JSON files (the serialised Model).
/// Baseline tracking records which snapshot was last "ratified" per repo,
/// enabling the "since you last looked" diff.
use crate::model::Model;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub struct SnapshotStore {
    dir: PathBuf,
    /// Parent `.affini/` dir (used for baseline file).
    affini_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotMeta {
    pub label: String,
    /// Unix epoch seconds (from file mtime).
    pub saved_at_unix: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Baseline {
    pub label: String,
    pub saved_at_unix: u64,
}

impl SnapshotStore {
    pub fn open(root: &Path) -> Result<Self> {
        let affini_dir = root.join(".affini");
        let dir = affini_dir.join("snapshots");
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("cannot create snapshot dir {}", dir.display()))?;
        Ok(Self { dir, affini_dir })
    }

    // -------------------------------------------------------------------------
    // Snapshots
    // -------------------------------------------------------------------------

    /// Write a model snapshot.  Label is typically a commit SHA or short name.
    pub fn save(&self, label: &str, model: &Model) -> Result<PathBuf> {
        let path = self.dir.join(encode_label(label));
        let json = serde_json::to_string_pretty(model)?;
        std::fs::write(&path, json)?;
        Ok(path)
    }

    /// Load a snapshot by label (returns None if it doesn't exist).
    pub fn load(&self, label: &str) -> Result<Option<Model>> {
        let path = self.dir.join(encode_label(label));
        if !path.exists() {
            return Ok(None);
        }
        let json = std::fs::read_to_string(&path)
            .with_context(|| format!("cannot read snapshot {}", path.display()))?;
        Ok(Some(serde_json::from_str(&json)?))
    }

    /// Returns true when a snapshot with this label exists on disk.
    pub fn exists(&self, label: &str) -> bool {
        self.dir.join(encode_label(label)).exists()
    }

    /// List saved snapshots with mtime, **oldest-first** (good for trend charts).
    pub fn list_chronological(&self) -> Result<Vec<SnapshotMeta>> {
        let mut entries = self.read_snapshot_entries()?;
        entries.sort_by_key(|e| e.saved_at_unix);
        Ok(entries)
    }

    /// List saved snapshot labels, newest-first (for the snapshots index endpoint).
    pub fn list(&self) -> Result<Vec<String>> {
        let mut entries = self.read_snapshot_entries()?;
        entries.sort_by_key(|e| std::cmp::Reverse(e.saved_at_unix));
        Ok(entries.into_iter().map(|e| e.label).collect())
    }

    fn read_snapshot_entries(&self) -> Result<Vec<SnapshotMeta>> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&self.dir)? {
            let e = entry?;
            let filename = e.file_name().to_string_lossy().to_string();
            // Only pick up *.json files (baseline.json lives in the parent dir,
            // so it can never appear here).
            if !filename.ends_with(".json") {
                continue;
            }
            let saved_at_unix = e
                .metadata()?
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            // Decode the percent-encoded filename back to the original label.
            let encoded = filename.trim_end_matches(".json");
            let label = decode_label(encoded);
            out.push(SnapshotMeta { label, saved_at_unix });
        }
        Ok(out)
    }

    // -------------------------------------------------------------------------
    // Baseline
    // -------------------------------------------------------------------------

    /// Mark a snapshot label as the current "you have seen up to here" baseline.
    pub fn save_baseline(&self, label: &str) -> Result<()> {
        let baseline = Baseline {
            label: label.to_string(),
            saved_at_unix: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        };
        let path = self.affini_dir.join("baseline.json");
        std::fs::write(path, serde_json::to_string_pretty(&baseline)?)?;
        Ok(())
    }

    /// Load the current baseline, if one has been set.
    pub fn load_baseline(&self) -> Result<Option<Baseline>> {
        let path = self.affini_dir.join("baseline.json");
        if !path.exists() {
            return Ok(None);
        }
        let json = std::fs::read_to_string(&path)?;
        Ok(Some(serde_json::from_str(&json)?))
    }
}

// ---------------------------------------------------------------------------
// Label encoding
//
// We need a reversible mapping from an arbitrary label string to a valid
// filename.  Percent-encode the characters that are illegal or ambiguous in
// filenames on common filesystems.
// ---------------------------------------------------------------------------

/// Characters safe to use verbatim in a filename on macOS/Linux/Windows.
fn is_safe(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~')
}

/// Encode `label` to a filename-safe string (no extension).
fn encode_label(label: &str) -> String {
    let mut out = String::with_capacity(label.len() + 8);
    for b in label.bytes() {
        let c = b as char;
        if is_safe(c) {
            out.push(c);
        } else {
            out.push('%');
            out.push_str(&format!("{b:02X}"));
        }
    }
    out.push_str(".json");
    out
}

/// Reverse `encode_label` (strips the `.json` suffix first).
fn decode_label(encoded: &str) -> String {
    let mut out = String::with_capacity(encoded.len());
    let mut chars = encoded.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '%' {
            let h = chars.next().unwrap_or('0');
            let l = chars.next().unwrap_or('0');
            if let Ok(b) = u8::from_str_radix(&format!("{h}{l}"), 16) {
                out.push(b as char);
                continue;
            }
            // fallback: keep verbatim
            out.push('%');
            out.push(h);
            out.push(l);
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_round_trip() {
        for label in &["v1", "v1/fix", "v1_fix", "feat: my feature", "sha:abc123"] {
            let encoded = encode_label(label);
            let decoded = decode_label(encoded.trim_end_matches(".json"));
            assert_eq!(decoded, *label, "round-trip failed for {label:?}");
        }
    }

    #[test]
    fn distinct_labels_distinct_filenames() {
        let a = encode_label("v1/fix");
        let b = encode_label("v1_fix");
        assert_ne!(a, b, "v1/fix and v1_fix must produce different filenames");
    }
}
