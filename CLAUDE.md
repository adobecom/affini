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
./core/target/release/affini serve . --port 7070 --token <secret>   # opt-in auth on mutating routes

# Check architectural conformance
./core/target/release/affini check --intent affini.toml

# Diff two snapshots (JSON files or snapshot labels)
./core/target/release/affini diff <a> [b]

# Infer a first-draft affini.toml from the existing module graph
./core/target/release/affini intent-init

# Derive feature flows and print the report as JSON
./core/target/release/affini flows

# Rust tests
cd core && cargo test --workspace
```

`affini-core` has a `cargo test` unit test suite (parsing, resolution, intent checks,
type-shape normalization, snapshot round-trips). `affini-cli` (the HTTP layer) has no
automated tests yet.

## Architecture

Affini is an **architectural drift instrument** — it scans a repository's import graph, checks it against declared design intent, and visualises the results in a browser UI.

### Process layout

```
affini serve <repo-path>          (Rust binary, :7070)
  ↕ HTTP JSON API (/api/*)
Vite dev server (:5173)           (proxies /api → :7070)
  └─ React SPA (ui/src/)
```

In production, `affini serve` detects `ui/dist/` next to its own binary (i.e. `<repo>/ui/dist`, resolved relative to `core/target/release/affini`) and serves it as a SPA fallback — no separate process needed. In dev, `npm run dev` runs both processes concurrently via `concurrently`, and Vite proxies `/api/*` to the Rust server.

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

All routes share `AppState { root, intent_path, fs_root, token }` and re-scan on every
request (no in-memory cache). CORS is restricted to the known dev/prod origins
(`http://localhost:5173`, `http://127.0.0.1:5173`, `http://localhost:<port>`) — not
wide open. `serve --token <t>` (or `AFFINI_TOKEN`) optionally requires
`Authorization: Bearer <t>` on the three mutating/costly routes marked 🔒 below; when
unset, those routes are open (today's default behavior).

| Route | Handler |
|---|---|
| `GET /api/model` | Full module graph + layer assignments |
| `GET /api/check` | Intent violations from `affini.toml` |
| `GET /api/snapshots` | Saved snapshot labels |
| `GET /api/trends` | Time-series metrics across all snapshots |
| `GET /api/diff?from=&to=` | Structural diff between two snapshots |
| `GET /api/baseline` / `POST /api/baseline` 🔒 | Read/set baseline snapshot |
| `GET /api/dupes?threshold=` | Structural duplicate clusters |
| `GET /api/flows` | Flow summaries (all detected feature flows) |
| `GET /api/flows/:id` | Full flow with step-level fragility detail |
| `POST /api/flows/:id/explain` 🔒 | AI risk assessment (requires `ANTHROPIC_API_KEY`) |
| `GET /api/ai/status` | Whether AI is available |
| `GET /api/graph/grouped?by=&depth=` | Modules collapsed by directory/layer/SCC (`rollup.rs`) |
| `GET /api/callgraph` | Full function-level call graph (`callgraph.rs`) |
| `GET /api/fs/list?path=` | Lists child directories, sandboxed to `fs_root` (for the root picker) |
| `POST /api/root` 🔒 | Switch the scanned repo root at runtime, sandboxed to `fs_root` |

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

Declares architectural intent for the repo under analysis. Four constructs:

```toml
[boundaries]
core = ["core/crates/affini-core/**"]   # name → file glob(s)

[rules]
forbidden  = [{ from = "core", to = "cli", reason = "..." }]
layers     = ["core", "cli", "ui"]      # lower index = more stable
canonical  = [{ concept = "**/date*.ts", path = "src/utils/date.ts" }]
# ^ flags every other file matching `concept`'s glob as a duplicate of the
# canonical implementation at `path`. Emits Warning-severity violations.
```

`affini.toml` in this repo enforces affini's own architecture (core ↛ cli ↛ ui) —
**but only for the languages the scanner understands.** `graph::scan` only parses
`.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs` files; it does not parse Rust. Since `core` and
`cli` are entirely Rust, those boundaries currently match zero files, so `affini check`
against this repo's own `affini.toml` only meaningfully enforces the `ui` boundary
today. `affini check --intent affini.toml` reporting "no violations" does not mean the
Rust-side layering is actually being verified — there's simply nothing for the scanner
to see there yet.

### AI feature

Optional. Set `ANTHROPIC_API_KEY` to enable `POST /api/flows/:id/explain`. The key is read from the environment at call time — no rebuild required. The call is made directly to the Anthropic Messages API in `affini-cli/src/ai.rs`, using a shared client with a 30s timeout. Model defaults to `claude-sonnet-4-6`, overridable via `ANTHROPIC_MODEL` without a rebuild.

## Documentation maintenance

> **Rule: any code change that affects the API shape or data model MUST keep both sides in sync in the same commit.**

| When you change… | Also update… |
|---|---|
| Rust structs in `affini-core/src/model.rs` or `flows.rs` | TypeScript types in `ui/src/api.ts` |
| HTTP routes in `affini-cli/src/main.rs` | `ui/src/api.ts` fetch functions |
| `affini.toml` schema (new fields in `intent.rs`) | `affini.toml` in this repo + update the Architecture section above |
| CLI subcommands | The Commands section above |
| New UI view / tab | `App.tsx` tab list + the UI section above |
