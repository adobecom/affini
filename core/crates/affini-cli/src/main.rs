use affini_core::{
    diff::diff,
    dupes::{find_dupes, DEFAULT_THRESHOLD},
    graph::scan,
    intent::{self, Severity},
    model::Model,
    snapshot::SnapshotStore,
};
use anyhow::{bail, Context, Result};
use axum::{
    extract::{Query as AxumQuery, State},
    http::StatusCode,
    response::{IntoResponse, Json},
    routing::get,
    Router,
};
use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
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
        #[arg(default_value = ".")]
        path: PathBuf,
        /// Save as a named snapshot.
        #[arg(long)]
        snapshot: Option<String>,
        #[arg(long, short)]
        output: Option<PathBuf>,
    },
    /// Diff two model snapshots (JSON files or snapshot labels).
    Diff {
        /// First snapshot: JSON file path or snapshot label.
        a: String,
        /// Second snapshot (default: fresh workdir scan).
        b: Option<String>,
        #[arg(long, default_value = ".")]
        root: PathBuf,
    },
    /// Check a repository against the intent rules in affini.toml.
    Check {
        #[arg(default_value = ".")]
        path: PathBuf,
        #[arg(long)]
        intent: Option<PathBuf>,
    },
    /// Infer a first-draft affini.toml from the existing module graph.
    IntentInit {
        #[arg(default_value = ".")]
        path: PathBuf,
        #[arg(long, default_value = "affini.toml")]
        output: PathBuf,
    },
    /// Start the HTTP server that feeds the web UI.
    Serve {
        #[arg(default_value = ".")]
        path: PathBuf,
        #[arg(long, default_value_t = 7070)]
        port: u16,
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
        Cmd::Scan { path, snapshot, output } => {
            cmd_scan(&path, snapshot.as_deref(), output.as_deref()).await
        }
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
    eprintln!("  {} files, {} import edges", model.modules.len(), model.edges.len());

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

fn load_model_arg(arg: &str, root: &Path) -> Result<Model> {
    let p = Path::new(arg);
    if p.exists() && p.extension().map(|e| e == "json").unwrap_or(false) {
        let json = std::fs::read_to_string(p)?;
        Ok(serde_json::from_str(&json)?)
    } else {
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
        bail!(
            "affini.toml not found at {}. Run `affini intent-init` to create one.",
            intent_file.display()
        );
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
    eprintln!(
        "{} violation(s): {} error(s), {} warning(s)",
        violations.len(),
        errors,
        warnings
    );
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
// intent-init
// ---------------------------------------------------------------------------

async fn cmd_intent_init(path: &Path, output: &Path) -> Result<()> {
    let model = scan(path)?;
    let mut boundary_dirs: std::collections::BTreeMap<String, Vec<String>> =
        std::collections::BTreeMap::new();
    for m in &model.modules {
        let top = m.path.split('/').next().unwrap_or("root");
        boundary_dirs
            .entry(top.to_string())
            .or_default()
            .push(format!("{}/**", top));
    }
    for v in boundary_dirs.values_mut() {
        v.sort();
        v.dedup();
    }

    if output == Path::new("affini.toml") && output.exists() {
        bail!(
            "affini.toml already exists. Delete it first or specify --output to a different path."
        );
    }
    std::fs::write(output, render_intent_toml(&boundary_dirs, &model.root))?;
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
    out.push_str("# Generated by `affini intent-init`. Review and ratify.\n");
    out.push_str(&format!("# Root: {root}\n\n"));
    out.push_str("[boundaries]\n");
    for (name, globs) in dirs {
        let gs: Vec<String> = globs.iter().map(|g| format!("\"{g}\"")).collect();
        out.push_str(&format!("{name} = [{}]\n", gs.join(", ")));
    }
    out.push_str("\n[rules]\n");
    out.push_str("# forbidden = [\n");
    out.push_str("#   { from = \"ui\", to = \"core\", reason = \"...\" },\n");
    out.push_str("# ]\n\n");
    let ls: Vec<String> = dirs.keys().map(|k| format!("\"{k}\"")).collect();
    out.push_str(&format!("# layers = [{}]\n", ls.join(", ")));
    out
}

// ---------------------------------------------------------------------------
// serve — HTTP API for the web UI
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
        .route("/api/model",     get(handler_model))
        .route("/api/check",     get(handler_check))
        .route("/api/snapshots", get(handler_snapshots))
        .route("/api/trends",    get(handler_trends))
        .route("/api/diff",      get(handler_diff))
        .route("/api/baseline",  get(handler_baseline_get).post(handler_baseline_post))
        .route("/api/dupes",     get(handler_dupes))
        .layer(cors)
        .with_state(state);

    let addr: SocketAddr = format!("127.0.0.1:{port}").parse()?;
    eprintln!("affini serving on http://{addr}");
    eprintln!("  repo: {}", path.display());

    let listener = TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

async fn handler_model(State(s): State<AppState>) -> impl IntoResponse {
    match scan(&s.root) {
        Ok(m) => json_ok(m),
        Err(e) => err500(e),
    }
}

async fn handler_check(State(s): State<AppState>) -> impl IntoResponse {
    let intent_path = resolve_intent(&s);
    if !intent_path.exists() {
        return (
            StatusCode::NOT_FOUND,
            "affini.toml not found — run `affini intent-init` first",
        )
            .into_response();
    }
    match (intent::load(&intent_path), scan(&s.root)) {
        (Ok(intent), Ok(model)) => json_ok(intent::check(&model, &intent)),
        (Err(e), _) | (_, Err(e)) => err500(e),
    }
}

async fn handler_snapshots(State(s): State<AppState>) -> impl IntoResponse {
    match SnapshotStore::open(&s.root).and_then(|st| st.list()) {
        Ok(list) => json_ok(list),
        Err(e) => err500(e),
    }
}

// GET /api/trends
// Returns time-series metrics for all saved snapshots + current workdir.
#[derive(Serialize)]
struct TrendPoint {
    label: String,
    saved_at_unix: u64,
    file_count: usize,
    edge_count: usize,
    avg_fan_in: f32,
    avg_fan_out: f32,
    avg_coupling: f32,
    violation_count: Option<usize>,
}

async fn handler_trends(State(s): State<AppState>) -> impl IntoResponse {
    let store = match SnapshotStore::open(&s.root) {
        Ok(st) => st,
        Err(e) => return err500(e),
    };

    let intent = load_intent_opt(&s);
    let metas = match store.list_chronological() {
        Ok(m) => m,
        Err(e) => return err500(e),
    };

    let mut points: Vec<TrendPoint> = Vec::new();

    for meta in &metas {
        if let Ok(Some(model)) = store.load(&meta.label) {
            let pt = model_to_trend_point(&meta.label, meta.saved_at_unix, &model, intent.as_ref());
            points.push(pt);
        }
    }

    // Append current workdir as the latest point — only if no snapshot is
    // already labelled "workdir" (which would produce a duplicate data point).
    let has_workdir_snapshot = metas.iter().any(|m| m.label == "workdir");
    if !has_workdir_snapshot {
        if let Ok(model) = scan(&s.root) {
            use std::time::{SystemTime, UNIX_EPOCH};
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            points.push(model_to_trend_point("workdir", now, &model, intent.as_ref()));
        }
    }

    json_ok(points)
}

fn model_to_trend_point(
    label: &str,
    saved_at_unix: u64,
    model: &Model,
    intent: Option<&intent::IntentFile>,
) -> TrendPoint {
    let vals: Vec<_> = model.metrics.values().collect();
    let n = vals.len() as f32;
    let avg = |f: fn(&affini_core::model::ModuleMetrics) -> f32| -> f32 {
        if n == 0.0 { 0.0 } else { vals.iter().map(|m| f(m)).sum::<f32>() / n }
    };

    let violation_count = intent.map(|i| intent::check(model, i).len());

    TrendPoint {
        label: label.to_string(),
        saved_at_unix,
        file_count: model.modules.len(),
        edge_count: model.edges.len(),
        avg_fan_in: round2(avg(|m| m.fan_in as f32)),
        avg_fan_out: round2(avg(|m| m.fan_out as f32)),
        avg_coupling: round2(avg(|m| m.coupling * 100.0)),
        violation_count,
    }
}

fn round2(v: f32) -> f32 {
    (v * 100.0).round() / 100.0
}

// GET /api/diff?from=<label>&to=<label>
// Both default: from=baseline (or first snapshot), to=workdir.
#[derive(Deserialize)]
struct DiffParams {
    from: Option<String>,
    to: Option<String>,
}

async fn handler_diff(
    State(s): State<AppState>,
    AxumQuery(params): AxumQuery<DiffParams>,
) -> impl IntoResponse {
    let store = match SnapshotStore::open(&s.root) {
        Ok(st) => st,
        Err(e) => return err500(e),
    };

    let model_b = match params.to.as_deref() {
        Some("workdir") | None => scan(&s.root).context("workdir scan"),
        Some(label) => match store.load(label) {
            Ok(Some(m)) => Ok(m),
            Ok(None) => Err(anyhow::anyhow!("snapshot '{label}' not found")),
            Err(e) => Err(e),
        },
    };
    let model_b = match model_b {
        Ok(m) => m,
        Err(e) => return err500(e),
    };

    // Resolve "from": baseline → first snapshot label → error
    let from_label = params.from.as_deref().map(|s| s.to_string()).or_else(|| {
        store
            .load_baseline()
            .ok()
            .flatten()
            .map(|b| b.label)
    });

    let model_a = match from_label.as_deref() {
        Some("workdir") => scan(&s.root).ok(),
        Some(label) => store.load(label).ok().flatten(),
        None => store
            .list_chronological()
            .ok()
            .and_then(|list| list.into_iter().next())
            .and_then(|meta| store.load(&meta.label).ok().flatten()),
    };

    match model_a {
        None => (StatusCode::NOT_FOUND, "no 'from' snapshot available; save one with `affini scan --snapshot <label>`").into_response(),
        Some(a) => json_ok(diff(&a, &model_b)),
    }
}

// GET /api/baseline
async fn handler_baseline_get(State(s): State<AppState>) -> impl IntoResponse {
    match SnapshotStore::open(&s.root).and_then(|st| st.load_baseline()) {
        Ok(Some(b)) => json_ok(b),
        Ok(None) => (StatusCode::NO_CONTENT, "").into_response(),
        Err(e) => err500(e),
    }
}

// POST /api/baseline  body: { "label": "workdir" | "<snapshot-label>" }
#[derive(Deserialize)]
struct BaselineBody {
    label: String,
}

async fn handler_baseline_post(
    State(s): State<AppState>,
    Json(body): Json<BaselineBody>,
) -> impl IntoResponse {
    match SnapshotStore::open(&s.root) {
        Ok(store) => {
            // If label is "workdir", save current scan as a snapshot first.
            if body.label == "workdir" {
                use std::time::{SystemTime, UNIX_EPOCH};
                let ts = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                let label = format!("seen_{ts}");
                if let Ok(model) = scan(&s.root) {
                    let _ = store.save(&label, &model);
                    if let Err(e) = store.save_baseline(&label) {
                        return err500(e);
                    }
                    return json_ok(serde_json::json!({ "label": label }));
                }
            }
            // Validate that the snapshot actually exists before pointing the
            // baseline at it — otherwise the diff endpoint silently falls back
            // to the oldest snapshot and the caller gets a misleading "ok".
            if !store.exists(&body.label) {
                return (
                    StatusCode::NOT_FOUND,
                    format!("snapshot '{}' not found; save it first with `affini scan --snapshot <label>`", body.label),
                ).into_response();
            }
            match store.save_baseline(&body.label) {
                Ok(()) => (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response(),
                Err(e) => err500(e),
            }
        }
        Err(e) => err500(e),
    }
}

// GET /api/dupes?threshold=0.6
// Returns structural similarity clusters across all file modules.
#[derive(Deserialize)]
struct DupesParams {
    threshold: Option<f32>,
}

async fn handler_dupes(
    State(s): State<AppState>,
    AxumQuery(params): AxumQuery<DupesParams>,
) -> impl IntoResponse {
    let threshold = params
        .threshold
        .map(|t| t.clamp(0.1, 1.0))
        .unwrap_or(DEFAULT_THRESHOLD);
    match scan(&s.root) {
        Ok(model) => json_ok(find_dupes(&model, &s.root, threshold)),
        Err(e) => err500(e),
    }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

fn resolve_intent(s: &AppState) -> PathBuf {
    s.intent_path
        .clone()
        .unwrap_or_else(|| s.root.join("affini.toml"))
}

fn load_intent_opt(s: &AppState) -> Option<intent::IntentFile> {
    let p = resolve_intent(s);
    if p.exists() { intent::load(&p).ok() } else { None }
}

fn json_ok<T: serde::Serialize>(val: T) -> axum::response::Response {
    (StatusCode::OK, Json(serde_json::to_value(val).unwrap())).into_response()
}

fn err500(e: impl std::fmt::Display) -> axum::response::Response {
    (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response()
}
