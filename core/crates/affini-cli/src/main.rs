use affini_core::{
    diff::diff,
    graph::scan,
    intent::{self, Severity},
    snapshot::SnapshotStore,
};
use anyhow::{bail, Context, Result};
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Json},
    routing::get,
    Router,
};
use clap::{Parser, Subcommand};
use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
};
use tokio::net::TcpListener;
use tower_http::cors::{Any, CorsLayer};

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------

#[derive(Parser)]
#[command(name = "affini", about = "Architectural drift instrument for agentic codebases")]
struct Cli {
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Scan a repository and emit the living model as JSON.
    Scan {
        /// Directory to scan (defaults to current directory).
        #[arg(default_value = ".")]
        path: PathBuf,
        /// Save as a named snapshot (label, e.g. a commit SHA).
        #[arg(long)]
        snapshot: Option<String>,
        /// Write JSON output to a file instead of stdout.
        #[arg(long, short)]
        output: Option<PathBuf>,
    },
    /// Diff two model snapshots (JSON files or snapshot labels).
    Diff {
        /// First snapshot: a JSON file path or a snapshot label saved under .affini/.
        a: String,
        /// Second snapshot (defaults to a fresh workdir scan).
        b: Option<String>,
        /// Repo root when using snapshot labels (defaults to current directory).
        #[arg(long, default_value = ".")]
        root: PathBuf,
    },
    /// Check a repository against the intent rules in affini.toml.
    Check {
        /// Directory to scan (defaults to current directory).
        #[arg(default_value = ".")]
        path: PathBuf,
        /// Path to affini.toml (defaults to <path>/affini.toml).
        #[arg(long)]
        intent: Option<PathBuf>,
    },
    /// Infer a first-draft affini.toml from the existing module graph.
    IntentInit {
        /// Directory to scan.
        #[arg(default_value = ".")]
        path: PathBuf,
        /// Where to write the inferred intent file (default: ./affini.toml).
        #[arg(long, default_value = "affini.toml")]
        output: PathBuf,
    },
    /// Start the HTTP server that feeds the web UI.
    Serve {
        /// Directory to scan.
        #[arg(default_value = ".")]
        path: PathBuf,
        /// Port (default 7070).
        #[arg(long, default_value_t = 7070)]
        port: u16,
        /// Path to affini.toml (defaults to <path>/affini.toml).
        #[arg(long)]
        intent: Option<PathBuf>,
    },
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("error: {e:#}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Cmd::Scan { path, snapshot, output } => cmd_scan(&path, snapshot.as_deref(), output.as_deref()).await,
        Cmd::Diff { a, b, root } => cmd_diff(&a, b.as_deref(), &root).await,
        Cmd::Check { path, intent } => cmd_check(&path, intent.as_deref()).await,
        Cmd::IntentInit { path, output } => cmd_intent_init(&path, &output).await,
        Cmd::Serve { path, port, intent } => cmd_serve(&path, port, intent.as_deref()).await,
    }
}

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

async fn cmd_scan(path: &Path, snapshot_label: Option<&str>, output: Option<&Path>) -> Result<()> {
    eprintln!("scanning {}…", path.display());
    let model = scan(path).context("scan failed")?;
    eprintln!(
        "  {} files, {} import edges",
        model.modules.len(),
        model.edges.len()
    );

    if let Some(label) = snapshot_label {
        let store = SnapshotStore::open(path)?;
        let saved = store.save(label, &model)?;
        eprintln!("  snapshot saved → {}", saved.display());
    }

    let json = serde_json::to_string_pretty(&model)?;
    if let Some(out_path) = output {
        std::fs::write(out_path, &json)?;
        eprintln!("  model written → {}", out_path.display());
    } else {
        println!("{json}");
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

async fn cmd_diff(a_str: &str, b_str: Option<&str>, root: &Path) -> Result<()> {
    let model_a = load_model_arg(a_str, root)?;
    let model_b = match b_str {
        Some(b) => load_model_arg(b, root)?,
        None => scan(root).context("workdir scan failed")?,
    };

    let d = diff(&model_a, &model_b);
    eprintln!("{}", d.summary);
    println!("{}", serde_json::to_string_pretty(&d)?);
    Ok(())
}

fn load_model_arg(arg: &str, root: &Path) -> Result<affini_core::model::Model> {
    let p = Path::new(arg);
    if p.exists() && p.extension().map(|e| e == "json").unwrap_or(false) {
        let json = std::fs::read_to_string(p)?;
        Ok(serde_json::from_str(&json)?)
    } else {
        // Try snapshot label
        let store = SnapshotStore::open(root)?;
        store
            .load(arg)?
            .with_context(|| format!("no snapshot '{arg}' found under .affini/snapshots/"))
    }
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

async fn cmd_check(path: &Path, intent_path: Option<&Path>) -> Result<()> {
    let intent_file = intent_path
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| path.join("affini.toml"));

    if !intent_file.exists() {
        bail!("affini.toml not found at {}. Run `affini intent init` to create one.", intent_file.display());
    }

    let intent = intent::load(&intent_file)?;
    let model = scan(path)?;
    let violations = intent::check(&model, &intent);

    if violations.is_empty() {
        eprintln!("no violations — design intent is intact.");
        return Ok(());
    }

    let errors = violations.iter().filter(|v| v.severity == Severity::Error).count();
    let warnings = violations.iter().filter(|v| v.severity == Severity::Warning).count();

    eprintln!("{} violation(s): {} error(s), {} warning(s)", violations.len(), errors, warnings);
    for v in &violations {
        let prefix = match v.severity {
            Severity::Error => "ERROR",
            Severity::Warning => "WARN",
        };
        eprintln!("[{prefix}] {}", v.message);
        eprintln!("  rule:  {}", v.rule);
        eprintln!("  from:  {}", v.from_path);
        eprintln!("  to:    {}", v.to_path);
    }

    if errors > 0 {
        std::process::exit(1);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// intent init
// ---------------------------------------------------------------------------

async fn cmd_intent_init(path: &Path, output: &Path) -> Result<()> {
    let model = scan(path)?;

    // Infer top-level directories as boundaries
    let mut boundary_dirs: std::collections::BTreeMap<String, Vec<String>> =
        std::collections::BTreeMap::new();

    for m in &model.modules {
        let top = m.path.split('/').next().unwrap_or("root");
        boundary_dirs
            .entry(top.to_string())
            .or_default()
            .push(format!("{}/**", top));
    }
    // Dedup globs
    for v in boundary_dirs.values_mut() {
        v.sort();
        v.dedup();
    }

    // Find top-level directories that only have outgoing edges (likely "leaf" = ui layer)
    // This is a heuristic — the architect should ratify.
    let toml_content = render_intent_toml(&boundary_dirs, &model.root);

    if output == Path::new("affini.toml") && output.exists() {
        bail!("affini.toml already exists. Delete it first or specify --output to a different path.");
    }

    std::fs::write(output, &toml_content)?;
    eprintln!("inferred intent written to {}", output.display());
    eprintln!("review and ratify the boundaries and rules before running `affini check`.");
    Ok(())
}

fn render_intent_toml(
    dirs: &std::collections::BTreeMap<String, Vec<String>>,
    root: &str,
) -> String {
    let mut out = String::new();
    out.push_str("# affini.toml — architectural intent for this repository\n");
    out.push_str("# Generated by `affini intent init`. Review and ratify.\n");
    out.push_str(&format!("# Root: {root}\n\n"));

    out.push_str("[boundaries]\n");
    for (name, globs) in dirs {
        let glob_list: Vec<String> = globs.iter().map(|g| format!("\"{g}\"")).collect();
        out.push_str(&format!("{name} = [{}]\n", glob_list.join(", ")));
    }

    out.push_str("\n[rules]\n");
    out.push_str("# Uncomment and edit to enforce forbidden import edges:\n");
    out.push_str("# forbidden = [\n");
    out.push_str("#   { from = \"ui\", to = \"core\", reason = \"UI must go through the API layer\" },\n");
    out.push_str("# ]\n\n");
    out.push_str("# Layer ordering (higher index = higher level; lower must not import higher):\n");
    let layer_names: Vec<String> = dirs.keys().map(|k| format!("\"{k}\"")).collect();
    out.push_str(&format!("# layers = [{}]\n", layer_names.join(", ")));

    out
}

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct AppState {
    root: PathBuf,
    intent_path: Option<PathBuf>,
}

async fn cmd_serve(path: &Path, port: u16, intent_path: Option<&Path>) -> Result<()> {
    let state = AppState {
        root: path.canonicalize()?,
        intent_path: intent_path.map(|p| p.to_path_buf()),
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/api/model", get(handler_model))
        .route("/api/check", get(handler_check))
        .route("/api/snapshots", get(handler_snapshots))
        .layer(cors)
        .with_state(state);

    let addr: SocketAddr = format!("127.0.0.1:{port}").parse()?;
    eprintln!("affini serving on http://{addr}");
    eprintln!("  repo: {}", path.display());

    let listener = TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

async fn handler_model(State(s): State<AppState>) -> impl IntoResponse {
    match scan(&s.root) {
        Ok(m) => (StatusCode::OK, Json(serde_json::to_value(m).unwrap())).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn handler_check(State(s): State<AppState>) -> impl IntoResponse {
    let intent_path = s
        .intent_path
        .clone()
        .unwrap_or_else(|| s.root.join("affini.toml"));

    if !intent_path.exists() {
        return (
            StatusCode::NOT_FOUND,
            "affini.toml not found — run `affini intent init` first",
        )
            .into_response();
    }

    let intent = match intent::load(&intent_path) {
        Ok(i) => i,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };

    let model = match scan(&s.root) {
        Ok(m) => m,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    };

    let violations = intent::check(&model, &intent);
    (StatusCode::OK, Json(serde_json::to_value(violations).unwrap())).into_response()
}

async fn handler_snapshots(State(s): State<AppState>) -> impl IntoResponse {
    match SnapshotStore::open(&s.root).and_then(|st| st.list()) {
        Ok(list) => (StatusCode::OK, Json(serde_json::to_value(list).unwrap())).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}
