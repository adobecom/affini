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
}

export interface Model {
  root: string
  commit: string
  modules: Module[]
  edges: Edge[]
  metrics: Record<number, ModuleMetrics>
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
