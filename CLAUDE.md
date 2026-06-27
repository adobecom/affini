# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Build everything (Rust binary + UI bundle)
npm run build

# Dev mode: Rust server on :7070 + Vite HMR on :5173
npm run dev

# Dev mode pointed at a different repo (e.g. ../mypa)
npm run dev:mypa

# Rust only
cd core && cargo build --release

# UI only
npm run ui                     # or: cd ui && npm run dev

# Run affini against the current repo
./core/target/release/affini scan
./core/target/release/affini check
./core/target/release/affini serve .

# Check architectural conformance
./core/target/release/affini check --intent affini.toml
```

There is no test suite.

## Architecture

Affini is an **architectural drift instrument** — it scans a repository's import graph, checks it against declared design intent, and visualises the results in a browser UI.

### Process layout

```
affini serve <repo-path>          (Rust binary, :7070)
  ↕ HTTP JSON API (/api/*)
Vite dev server (:5173)           (proxies /api → :7070)
  └─ React SPA (ui/src/)
```

In production the Vite build output (`ui/dist/`) is served statically. In dev, `npm run dev` runs both processes concurrently via `concurrently`.

### Rust workspace (`core/`)

Two crates:

| Crate | Role |
|---|---|
| `affini-core` | Pure library: scanning, parsing, graph, metrics, flows, intent, diffing |
| `affini-cli`  | Binary: CLI (`clap`), Axum HTTP server, AI integration |

The scan pipeline inside `affini-core`:
1. **`graph::scan`** — walks the file tree, calls `parse::extract_imports` on each source file, resolves specifiers via `resolve`, builds `Model` (modules + edges + metrics)
2. **`intent::load` / `intent::check`** — parses `affini.toml`, evaluates forbidden edges and layer violations
3. **`flows::compute_flows_full`** — extracts function bodies (`funcs`), builds a call graph (`callgraph`), DFS-walks from public entry points up to `MAX_DEPTH=6` / `MAX_STEPS=40`, annotates steps with fragility flags
4. **`diff::diff`** — compares two `Model` snapshots, emits added/removed modules and edges
5. **`snapshot::SnapshotStore`** — persists/loads named model snapshots under `.affini/snapshots/`

### HTTP API (`affini-cli/src/main.rs`)

All routes share `AppState { root, intent_path }` and re-scan on every request (no in-memory cache).

| Route | Handler |
|---|---|
| `GET /api/model` | Full module graph + layer assignments |
| `GET /api/check` | Intent violations from `affini.toml` |
| `GET /api/snapshots` | Saved snapshot labels |
| `GET /api/trends` | Time-series metrics across all snapshots |
| `GET /api/diff?from=&to=` | Structural diff between two snapshots |
| `GET /api/baseline` / `POST /api/baseline` | Read/set baseline snapshot |
| `GET /api/dupes?threshold=` | Structural duplicate clusters |
| `GET /api/flows` | Flow summaries (all detected feature flows) |
| `GET /api/flows/:id` | Full flow with step-level fragility detail |
| `POST /api/flows/:id/explain` | AI risk assessment (requires `ANTHROPIC_API_KEY`) |
| `GET /api/ai/status` | Whether AI is available |

### UI (`ui/src/`)

Single-page React app with six tab views rendered in `App.tsx`:

- **Graph** (`GraphView`) — force-directed module dependency graph with layer bands
- **Scorecard** (`ScorecardView`) — per-module fan-in/fan-out/coupling/instability table
- **Diff** (`DiffView`) — added/removed modules and edges between two snapshots
- **Trends** (`TrendsView`) — time-series chart of aggregate metrics across snapshots
- **Dupes** (`DupesView`) — structurally similar file clusters
- **Feature Flows** (`FlowsView`) — animated call sequence explorer with fragility popovers

`ui/src/api.ts` is the typed client for the HTTP API. The TypeScript types in `api.ts` mirror the Rust structs in `affini-core/src/model.rs` and `flows.rs` — keep them in sync when changing the data model.

### `affini.toml`

Declares architectural intent for the repo under analysis. Three constructs:

```toml
[boundaries]
core = ["core/crates/affini-core/**"]   # name → file glob(s)

[rules]
forbidden = [{ from = "core", to = "cli", reason = "..." }]
layers    = ["core", "cli", "ui"]       # lower index = more stable
```

`affini.toml` in this repo enforces affini's own architecture (core ↛ cli ↛ ui).

### AI feature

Optional. Set `ANTHROPIC_API_KEY` to enable `POST /api/flows/:id/explain`. The key is read from the environment at call time — no rebuild required. The call is made directly to the Anthropic Messages API in `affini-cli/src/ai.rs` (model: `claude-sonnet-4-6`).

## Documentation maintenance

> **Rule: any code change that affects the API shape or data model MUST keep both sides in sync in the same commit.**

| When you change… | Also update… |
|---|---|
| Rust structs in `affini-core/src/model.rs` or `flows.rs` | TypeScript types in `ui/src/api.ts` |
| HTTP routes in `affini-cli/src/main.rs` | `ui/src/api.ts` fetch functions |
| `affini.toml` schema (new fields in `intent.rs`) | `affini.toml` in this repo + update the Architecture section above |
| CLI subcommands | The Commands section above |
| New UI view / tab | `App.tsx` tab list + the UI section above |
