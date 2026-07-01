// Typed API client for affini serve (http://localhost:7070)

export interface Module {
  id: number
  path: string
  is_file: boolean
  exports: string[]
}

export interface Edge {
  from: number
  to: number
  kind: 'Imports' | 'Reexports'
  specifier: string
}

export interface ModuleMetrics {
  fan_in: number
  fan_out: number
  coupling: number
  /** Lines of code in this file (0 if not yet computed). */
  loc?: number
  /** Tarjan SCC id — nodes sharing this id with scc_size > 1 are in a cycle. */
  scc_id?: number
  /** SCC size — >1 means this node participates in a dependency cycle. */
  scc_size?: number
  /** Martin's instability: fan_out / (fan_in + fan_out).  0 = stable, 1 = unstable. */
  instability?: number
}

export interface Model {
  root: string
  commit: string
  modules: Module[]
  edges: Edge[]
  metrics: Record<number, ModuleMetrics>
  /** NodeId → layer name, from affini.toml boundaries (empty if no affini.toml). */
  layers?: Record<number, string>
  /** Ordered layer names, index 0 = lowest/most-stable (e.g. ["core","cli","ui"]). */
  layer_order?: string[]
}

export interface Violation {
  rule: string
  severity: 'Error' | 'Warning'
  from_path: string
  to_path: string
  message: string
}

export interface TrendPoint {
  label: string
  saved_at_unix: number
  file_count: number
  edge_count: number
  avg_fan_in: number
  avg_fan_out: number
  avg_coupling: number
  violation_count: number | null
}

export interface EdgeDesc {
  from: string
  to: string
  kind: string
  specifier: string
}

export interface ModelDiff {
  from_commit: string
  to_commit: string
  modules_added: Module[]
  modules_removed: Module[]
  edges_added: EdgeDesc[]
  edges_removed: EdgeDesc[]
  summary: string
}

export interface Baseline {
  label: string
  saved_at_unix: number
}

export interface DupeCluster {
  files: string[]
  similarity: number
}

export interface DupesReport {
  clusters: DupeCluster[]
  files_analyzed: number
  threshold: number
}

const BASE = '/api'

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, opts)
  if (res.status === 204) return null as T
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${path}: ${res.status} — ${text}`)
  }
  return res.json()
}

export const fetchModel       = ()                  => request<Model>('/model')
export const fetchViolations  = ()                  => request<Violation[]>('/check')
export const fetchSnapshots   = ()                  => request<string[]>('/snapshots')
export const fetchTrends      = ()                  => request<TrendPoint[]>('/trends')
export const fetchBaseline    = ()                  => request<Baseline | null>('/baseline')
export const postBaseline     = (label: string)     =>
  request<{ ok: boolean } | { label: string }>('/baseline', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  })

export const fetchDiff = (from?: string, to?: string) => {
  const params = new URLSearchParams()
  if (from) params.set('from', from)
  if (to)   params.set('to', to)
  const qs = params.toString()
  return request<ModelDiff | null>(`/diff${qs ? `?${qs}` : ''}`)
}

export const fetchDupes = (threshold?: number) => {
  const qs = threshold !== undefined ? `?threshold=${threshold}` : ''
  return request<DupesReport>(`/dupes${qs}`)
}

// ── Feature Flows types ────────────────────────────────────────────────────

export type TypeShape =
  | { kind: 'primitive'; name: string }
  | { kind: 'literal'; value: string }
  | { kind: 'object'; fields: TypeField[] }
  | { kind: 'array'; of: TypeShape }
  | { kind: 'union'; of: TypeShape[] }
  | { kind: 'tuple'; of: TypeShape[] }
  | { kind: 'ref'; name: string; args: TypeShape[]; external: boolean }
  | { kind: 'unknown'; raw: string }

export interface TypeField {
  name: string
  optional: boolean
  shape: TypeShape
}

export interface ParamShape {
  name: string
  optional: boolean
  shape: TypeShape
}

export interface FunctionId {
  module: number
  name: string
  order: number
}

export type FragilitySource = 'Metric' | 'Type' | 'Churn'

export interface FragilityFlag {
  source: FragilitySource
  code: string
  message: string
  severity: 'Error' | 'Warning'
}

export interface FlowStep {
  /** Sequential id within the flow (0-based); stable node key for branch-tree layout. */
  id: number
  /** Id of the parent step; null means direct child of entry. */
  parent: number | null
  /** Steps sharing the same caller + enclosing branch block have the same branch_group. */
  branch_group: number | null
  from: FunctionId
  to: FunctionId
  call_site_order: number
  callee_text: string
  params: ParamShape[]
  return_shape: TypeShape
  arg_texts: string[]
  fragility: FragilityFlag[]
  depth: number
  recursion: boolean
  branchy: boolean
}

export interface FragilitySummary {
  total_steps: number
  fragile_steps: number
  metric_flags: number
  type_flags: number
  churn_flags: number
  max_severity: 'Error' | 'Warning' | null
}

export interface FlowSummary {
  id: string
  name: string
  entry_module_path: string
  kind: string
  step_count: number
  fragility_summary: FragilitySummary
  /** True when this flow was explicitly declared in affini.toml [[features]]. */
  declared: boolean
  feature_name: string | null
}

export interface Flow extends FlowSummary {
  entry: FunctionId
  steps: FlowStep[]
  truncated: boolean
}

export const fetchFlows = () => request<FlowSummary[]>('/flows')
export const fetchFlow  = (id: string) => request<Flow>(`/flows/${encodeURIComponent(id)}`)

// ── AI (optional) ──────────────────────────────────────────────────────────

export const fetchAiStatus = () => request<{ enabled: boolean }>('/ai/status')
export const explainFlow   = (id: string) =>
  request<{ explanation: string }>(`/flows/${encodeURIComponent(id)}/explain`, { method: 'POST' })

// ── Grouped graph (rollup views) ───────────────────────────────────────────

export interface GroupNode {
  id: number
  key: string
  label: string
  member_ids: number[]
  loc: number
  file_count: number
  /** True for multi-file SCC clusters. */
  is_cluster: boolean
}

export interface GroupEdge {
  from: number
  to: number
  weight: number
  violation: boolean
  /** True when this edge goes from a lower-stability layer to a higher-stability one (bad direction). */
  cross_layer_up: boolean
}

export interface GroupedGraph {
  nodes: GroupNode[]
  edges: GroupEdge[]
  group_by: string
  layer_order: string[]
}

export type GroupBy = 'directory' | 'layer' | 'scc'

export const fetchGroupedGraph = (by: GroupBy, depth?: number) => {
  const params = new URLSearchParams({ by })
  if (depth !== undefined) params.set('depth', String(depth))
  return request<GroupedGraph>(`/graph/grouped?${params}`)
}

// ── Function-level call graph ──────────────────────────────────────────────

export interface CallGraphNode {
  id: FunctionId
  label: string
  module: number
  module_path: string
  exported: boolean
}

export interface CallGraphEdge {
  from: FunctionId
  to: FunctionId
  call_count: number
  branchy: boolean
}

export interface CallGraphReport {
  nodes: CallGraphNode[]
  edges: CallGraphEdge[]
  resolved_calls: number
  unresolved_calls: number
}

export const fetchCallGraph = (entry?: string) => {
  const qs = entry ? `?entry=${encodeURIComponent(entry)}` : ''
  return request<CallGraphReport>(`/callgraph${qs}`)
}

// ── File-system browser (for in-app root picker) ───────────────────────────

export interface FsEntry {
  name: string
  path: string
  is_dir: boolean
  /** Whether affini.toml exists directly inside this directory. */
  has_affini: boolean
}

export interface FsListing {
  cwd: string
  parent: string | null
  entries: FsEntry[]
}

export const fetchFsList = (path?: string) => {
  const qs = path ? `?path=${encodeURIComponent(path)}` : ''
  return request<FsListing>(`/fs/list${qs}`)
}

export const postRoot = (path: string) =>
  request<{ ok: boolean; root: string }>('/root', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
