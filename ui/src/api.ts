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

const BASE = '/api'

export async function fetchModel(): Promise<Model> {
  const res = await fetch(`${BASE}/model`)
  if (!res.ok) throw new Error(`/api/model: ${res.status}`)
  return res.json()
}

export async function fetchViolations(): Promise<Violation[]> {
  const res = await fetch(`${BASE}/check`)
  if (!res.ok) throw new Error(`/api/check: ${res.status}`)
  return res.json()
}

export async function fetchSnapshots(): Promise<string[]> {
  const res = await fetch(`${BASE}/snapshots`)
  if (!res.ok) throw new Error(`/api/snapshots: ${res.status}`)
  return res.json()
}
