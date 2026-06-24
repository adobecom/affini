/// Lightweight JSON snapshot store under `.affini/snapshots/`.
///
/// v1 keeps it simple: each snapshot is a JSON file named by commit/label.
/// Future versions will migrate to SQLite for trend queries.
use crate::model::Model;
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

pub struct SnapshotStore {
    dir: PathBuf,
}

impl SnapshotStore {
    pub fn open(root: &Path) -> Result<Self> {
        let dir = root.join(".affini").join("snapshots");
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("cannot create snapshot dir {}", dir.display()))?;
        Ok(Self { dir })
    }

    /// Write a model snapshot.  The label is typically a commit SHA or "workdir".
    pub fn save(&self, label: &str, model: &Model) -> Result<PathBuf> {
        let safe = label.replace(['/', '\\', ':'], "_");
        let path = self.dir.join(format!("{safe}.json"));
        let json = serde_json::to_string_pretty(model)?;
        std::fs::write(&path, json)?;
        Ok(path)
    }

    /// Load a snapshot by label (returns None if it doesn't exist).
    pub fn load(&self, label: &str) -> Result<Option<Model>> {
        let safe = label.replace(['/', '\\', ':'], "_");
        let path = self.dir.join(format!("{safe}.json"));
        if !path.exists() {
            return Ok(None);
        }
        let json = std::fs::read_to_string(&path)
            .with_context(|| format!("cannot read snapshot {}", path.display()))?;
        let model: Model = serde_json::from_str(&json)?;
        Ok(Some(model))
    }

    /// List all saved snapshot labels, newest-first (by mtime).
    pub fn list(&self) -> Result<Vec<String>> {
        let mut entries: Vec<(std::time::SystemTime, String)> = Vec::new();
        for entry in std::fs::read_dir(&self.dir)? {
            let e = entry?;
            let name = e.file_name().to_string_lossy().to_string();
            if name.ends_with(".json") {
                let mtime = e.metadata()?.modified().unwrap_or(std::time::UNIX_EPOCH);
                let label = name.trim_end_matches(".json").to_string();
                entries.push((mtime, label));
            }
        }
        entries.sort_by(|a, b| b.0.cmp(&a.0));
        Ok(entries.into_iter().map(|(_, l)| l).collect())
    }
}
