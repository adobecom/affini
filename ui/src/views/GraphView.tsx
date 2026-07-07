/**
 * Module Graph — architect's view of the dependency structure.
 *
 * Five view modes (segmented selector):
 *   Files       — per-file force layout (original)
 *   Directories — directory rollup, ranked dagre layout
 *   Layers      — boundary/layer rollup, ranked
 *   Cycles      — SCC cluster rollup, ranked
 *   Call graph  — function-level call graph, ranked
 *
 * Signals visualised:
 *  - Layer membership & illegal cross-layer edges (from affini.toml intent)
 *  - Dependency cycles (Tarjan SCC, computed server-side)
 *  - Coupling / instability (Martin's stable-dependency metric)
 *  - Hub / god-module detection (top-10% fan-in)
 *  - Orphan / unreachable files
 *  - Near-duplicate code clusters
 *  - Change since baseline (added / removed modules)
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Loader, AlertCircle, X, Target, RotateCcw,
  ChevronDown, ChevronRight,
} from 'lucide-react'
import {
  fetchModel, fetchViolations, fetchDupes, fetchDiff, fetchGroupedGraph, fetchCallGraph,
  type Module, type ModuleMetrics, type Violation,
  type DupesReport, type ModelDiff, type Model,
  type GroupedGraph, type GroupNode, type GroupEdge,
  type CallGraphReport,
  type GroupBy,
} from '../api'
import { ForceGraph, type FGNode, type FGEdge } from './graph/ForceGraph'
import { buildLayerColors, layerColor } from './graph/layers'
import { type ModuleSignals } from './graph/ModuleNode'
import { InfoTip } from '../components/InfoTip'
import { METRIC_HELP } from '../metricHelp'

// ─── graph mode ──────────────────────────────────────────────────────────────

type GraphMode = 'files' | 'directory' | 'layer' | 'scc' | 'callgraph'

const MODE_LABELS: { id: GraphMode; label: string; title: string }[] = [
  { id: 'files',     label: 'Files',       title: 'Per-file dependency graph (force layout)' },
  { id: 'directory', label: 'Directories', title: 'Directory-level rollup (ranked)' },
  { id: 'layer',     label: 'Layers',      title: 'Architectural layer groups (ranked)' },
  { id: 'scc',       label: 'Cycles',      title: 'Dependency cycle / SCC clusters (ranked)' },
  { id: 'callgraph', label: 'Call graph',  title: 'Function-level call graph (ranked)' },
]

// ─── default signals (null object) ───────────────────────────────────────────

const DEFAULT_SIGNALS: ModuleSignals = {
  instability: 0, isHub: false, isOrphan: false, isCycle: false,
  isViolationSrc: false, isDupe: false, changeStatus: null, loc: 0, layer: undefined,
}

// ─── per-file signal computation ─────────────────────────────────────────────

function computeSignals(
  model: Model,
  violations: Violation[],
  dupes: DupesReport | null,
  diff: ModelDiff | null,
): Record<number, ModuleSignals> {
  const layers = model.layers ?? {}

  const fanIns = model.modules.map(m => model.metrics[m.id]?.fan_in ?? 0).sort((a, b) => a - b)
  const p90 = fanIns[Math.floor(fanIns.length * 0.9)] ?? 1
  const hubThreshold = Math.max(2, p90)

  const violSrcPaths = new Set(violations.filter(v => v.severity === 'Error').map(v => v.from_path))
  const dupePaths = new Set<string>()
  if (dupes) for (const c of dupes.clusters) for (const f of c.files) dupePaths.add(f)

  const addedPaths   = new Set(diff?.modules_added.map(m => m.path)   ?? [])
  const removedPaths = new Set(diff?.modules_removed.map(m => m.path) ?? [])

  const result: Record<number, ModuleSignals> = {}
  for (const m of model.modules) {
    const met = model.metrics[m.id]
    const fi = met?.fan_in ?? 0, fo = met?.fan_out ?? 0
    result[m.id] = {
      instability: fi + fo > 0 ? fo / (fi + fo) : 0,
      isHub:          fi >= hubThreshold,
      isOrphan:       fi === 0 && fo === 0,
      isCycle:        (met?.scc_size ?? 0) > 1,
      isViolationSrc: violSrcPaths.has(m.path),
      isDupe:         dupePaths.has(m.path),
      changeStatus:   addedPaths.has(m.path) ? 'added' : removedPaths.has(m.path) ? 'removed' : null,
      loc:            met?.loc ?? 0,
      layer:          layers[m.id],
    }
  }
  return result
}

function buildAdjacency(edges: { from: number; to: number }[]) {
  const out = new Map<number, number[]>()
  const ins = new Map<number, number[]>()
  for (const e of edges) {
    if (!out.has(e.from)) out.set(e.from, [])
    if (!ins.has(e.to))   ins.set(e.to, [])
    out.get(e.from)!.push(e.to)
    ins.get(e.to)!.push(e.from)
  }
  return { out, ins }
}

// ─── filter state ────────────────────────────────────────────────────────────

interface FilterState {
  search: string
  cyclesOnly: boolean
  violationsOnly: boolean
  hubsOnly: boolean
  orphansOnly: boolean
  changedOnly: boolean
}

const DEFAULT_FILTER: FilterState = {
  search: '', cyclesOnly: false, violationsOnly: false,
  hubsOnly: false, orphansOnly: false, changedOnly: false,
}

function nodeWidth(loc: number): number {
  return Math.round(Math.max(148, Math.min(224, 148 + (loc / 400) * 76)))
}

// ─── GroupNode / CallGraphNode → FGNode adapters ─────────────────────────────

function groupNodesToFG(
  gnodes: GroupNode[],
  gedges: GroupEdge[],
  selectedId: number | null,
): FGNode[] {
  // Build adjacency for neighbourhood highlight
  const out = new Map<number, number[]>()
  const ins  = new Map<number, number[]>()
  for (const e of gedges) {
    if (!out.has(e.from)) out.set(e.from, [])
    if (!ins.has(e.to))   ins.set(e.to, [])
    out.get(e.from)!.push(e.to)
    ins.get(e.to)!.push(e.from)
  }
  const hood: Set<number> | null = selectedId !== null
    ? new Set([selectedId, ...(out.get(selectedId) ?? []), ...(ins.get(selectedId) ?? [])])
    : null

  return gnodes.map(gn => ({
    id: gn.id,
    path: gn.label,
    width: nodeWidth(gn.loc),
    layer: gn.key,
    signals: {
      instability: 0,
      isHub: false,
      isOrphan: gedges.every(e => e.from !== gn.id && e.to !== gn.id),
      isCycle: gn.is_cluster,
      isViolationSrc: gedges.some(e => (e.from === gn.id || e.to === gn.id) && e.violation),
      isDupe: false,
      changeStatus: null,
      loc: gn.loc,
      layer: gn.key,
    } satisfies ModuleSignals,
    metrics: {
      fan_in:   gedges.filter(e => e.to   === gn.id).reduce((s, e) => s + e.weight, 0),
      fan_out:  gedges.filter(e => e.from === gn.id).reduce((s, e) => s + e.weight, 0),
      coupling: 0,
      loc: gn.loc,
    } satisfies ModuleMetrics,
    isSelected: gn.id === selectedId,
    isDimmed: hood !== null && !hood.has(gn.id),
  }))
}

function groupEdgesToFG(gedges: GroupEdge[]): FGEdge[] {
  return gedges.map((e, i) => ({
    id: `ge${i}`,
    fromId: e.from,
    toId: e.to,
    color: e.violation ? '#f87171' : e.cross_layer_up ? '#fbbf24' : '#4338ca',
    strokeWidth: e.violation ? 2.5 : 1.5,
    dashed: e.cross_layer_up && !e.violation,
    dimmed: false,
  }))
}

/** Map a FunctionId to a stable numeric id for FGNode. */
function fidToId(fid: { module: number; order: number }): number {
  return fid.module * 10000 + fid.order
}

function callgraphToFG(
  report: CallGraphReport,
  selectedId: number | null,
): { nodes: FGNode[]; edges: FGEdge[] } {
  const out = new Map<number, number[]>()
  const ins  = new Map<number, number[]>()
  for (const e of report.edges) {
    const fk = fidToId(e.from)
    const tk = fidToId(e.to)
    if (!out.has(fk)) out.set(fk, [])
    if (!ins.has(tk)) ins.set(tk, [])
    out.get(fk)!.push(tk)
    ins.get(tk)!.push(fk)
  }
  const hood: Set<number> | null = selectedId !== null
    ? new Set([selectedId, ...(out.get(selectedId) ?? []), ...(ins.get(selectedId) ?? [])])
    : null

  const fgNodes: FGNode[] = report.nodes.map(n => {
    const nk = fidToId(n.id)
    return {
      id: nk,
      path: `${n.module_path}#${n.label}`,
      width: 160,
      signals: { ...DEFAULT_SIGNALS, layer: undefined },
      metrics: {
        fan_in:  ins.get(nk)?.length ?? 0,
        fan_out: out.get(nk)?.length ?? 0,
        coupling: 0,
      },
      isSelected: nk === selectedId,
      isDimmed: hood !== null && !hood.has(nk),
    }
  })

  const fgEdges: FGEdge[] = report.edges.map((e, i) => {
    const fk = fidToId(e.from)
    const tk = fidToId(e.to)
    return {
      id: `cge${i}`,
      fromId: fk,
      toId: tk,
      color: e.branchy ? '#fbbf24' : '#4338ca',
      strokeWidth: 1.5,
      dashed: e.branchy,
      dimmed: false,
    }
  })

  return { nodes: fgNodes, edges: fgEdges }
}

// ─── main component ───────────────────────────────────────────────────────────

export default function GraphView() {
  const [graphMode, setGraphMode] = useState<GraphMode>('files')

  // Files-mode data
  const [model, setModel]           = useState<Model | null>(null)
  const [violations, setViolations] = useState<Violation[]>([])
  const [dupes, setDupes]           = useState<DupesReport | null>(null)
  const [diff, setDiff]             = useState<ModelDiff | null>(null)

  // Grouped / callgraph data
  const [groupedGraph, setGroupedGraph]     = useState<GroupedGraph | null>(null)
  const [callgraphReport, setCallgraph]     = useState<CallGraphReport | null>(null)
  const [groupedLoading, setGroupedLoading] = useState(false)

  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [filter, setFilter]         = useState<FilterState>(DEFAULT_FILTER)
  const [focusId, setFocusId]       = useState<number | null>(null)
  const [legendOpen, setLegendOpen] = useState(false)

  // ── fetch base data (files mode) ──────────────────────────────────────────
  useEffect(() => {
    Promise.all([
      fetchModel(),
      fetchViolations().catch(() => [] as Violation[]),
      fetchDupes().catch(() => null as DupesReport | null),
      fetchDiff().catch(() => null as ModelDiff | null),
    ])
      .then(([m, v, d, df]) => { setModel(m); setViolations(v); setDupes(d); setDiff(df) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  // ── fetch grouped/callgraph data on mode switch ───────────────────────────
  useEffect(() => {
    if (graphMode === 'files') return
    setGroupedLoading(true)
    setSelectedId(null)

    if (graphMode === 'callgraph') {
      setCallgraph(null)
      fetchCallGraph()
        .then(setCallgraph)
        .catch(e => setError(e.message))
        .finally(() => setGroupedLoading(false))
    } else {
      setGroupedGraph(null)
      const by: GroupBy = graphMode as GroupBy
      fetchGroupedGraph(by)
        .then(setGroupedGraph)
        .catch(e => setError(e.message))
        .finally(() => setGroupedLoading(false))
    }
  }, [graphMode])

  // ── derived data (files mode) ─────────────────────────────────────────────
  const signalsMap = useMemo(
    () => model ? computeSignals(model, violations, dupes, diff) : {},
    [model, violations, dupes, diff],
  )

  const adjacency = useMemo(
    () => model ? buildAdjacency(model.edges) : { out: new Map<number, number[]>(), ins: new Map<number, number[]>() },
    [model],
  )

  const layerOrder = useMemo(() => model?.layer_order ?? [], [model?.layer_order])
  const layerColors = useMemo(() => buildLayerColors(layerOrder), [layerOrder])

  const neighborhood = useMemo<Set<number> | null>(() => {
    if (selectedId === null || !model || graphMode !== 'files') return null
    const hood = new Set<number>([selectedId])
    for (const n of adjacency.out.get(selectedId) ?? []) hood.add(n)
    for (const n of adjacency.ins.get(selectedId) ?? []) hood.add(n)
    return hood
  }, [selectedId, adjacency, model, graphMode])

  // ── visible modules (files mode) ─────────────────────────────────────────
  const visibleModules = useMemo(() => {
    if (!model || graphMode !== 'files') return []
    let mods = model.modules

    if (focusId !== null) {
      const hood = new Set<number>([focusId])
      for (const n of adjacency.out.get(focusId) ?? []) hood.add(n)
      for (const n of adjacency.ins.get(focusId) ?? []) hood.add(n)
      mods = mods.filter(m => hood.has(m.id))
    }

    const { search, cyclesOnly, violationsOnly, hubsOnly, orphansOnly, changedOnly } = filter
    if (search)         mods = mods.filter(m => m.path.toLowerCase().includes(search.toLowerCase()))
    if (cyclesOnly)     mods = mods.filter(m => signalsMap[m.id]?.isCycle)
    if (violationsOnly) mods = mods.filter(m => signalsMap[m.id]?.isViolationSrc)
    if (hubsOnly)       mods = mods.filter(m => signalsMap[m.id]?.isHub)
    if (orphansOnly)    mods = mods.filter(m => signalsMap[m.id]?.isOrphan)
    if (changedOnly)    mods = mods.filter(m => !!signalsMap[m.id]?.changeStatus)

    return mods
  }, [model, signalsMap, adjacency, focusId, filter, graphMode])

  // ── FGNode / FGEdge arrays ────────────────────────────────────────────────

  const violEdgeKeys = useMemo(
    () => new Set(violations.map(v => `${v.from_path}|${v.to_path}`)),
    [violations],
  )

  // Files mode
  const filesFgNodes = useMemo<FGNode[]>(() => {
    if (!model || graphMode !== 'files') return []
    return visibleModules.map(m => {
      const metrics  = model.metrics[m.id] ?? { fan_in: 0, fan_out: 0, coupling: 0 }
      const signals  = signalsMap[m.id] ?? DEFAULT_SIGNALS
      return {
        id:         m.id,
        path:       m.path,
        width:      nodeWidth(signals.loc),
        layer:      signals.layer,
        signals,
        metrics,
        isSelected: m.id === selectedId,
        isDimmed:   neighborhood !== null && !neighborhood.has(m.id),
      }
    })
  }, [model, visibleModules, signalsMap, selectedId, neighborhood, graphMode])

  const filesFgEdges = useMemo<FGEdge[]>(() => {
    if (!model || graphMode !== 'files') return []
    const visibleIds = new Set(visibleModules.map(m => m.id))
    return model.edges
      .filter(e => visibleIds.has(e.from) && visibleIds.has(e.to))
      .map((e, i) => {
        const fromPath = model.modules.find(m => m.id === e.from)?.path ?? ''
        const toPath   = model.modules.find(m => m.id === e.to)?.path ?? ''
        const isViol   = violEdgeKeys.has(`${fromPath}|${toPath}`)
        const fromMet  = model.metrics[e.from]
        const toMet    = model.metrics[e.to]
        const isCycleEdge =
          (fromMet?.scc_size ?? 0) > 1 &&
          (toMet?.scc_size ?? 0) > 1 &&
          fromMet?.scc_id === toMet?.scc_id
        const isActive =
          neighborhood === null ||
          (neighborhood.has(e.from) && neighborhood.has(e.to))

        let color = e.kind === 'Reexports' ? '#fbbf24' : '#4338ca'
        if (isViol)           color = '#f87171'
        else if (isCycleEdge) color = '#ef4444'

        return {
          id:          `e${i}`,
          fromId:      e.from,
          toId:        e.to,
          color,
          strokeWidth: isViol ? 2.5 : 1.5,
          dashed:      isCycleEdge,
          dimmed:      !isActive,
        }
      })
  }, [model, visibleModules, violEdgeKeys, neighborhood, graphMode])

  // Grouped modes
  const groupFgNodes = useMemo<FGNode[]>(() => {
    if (!groupedGraph || graphMode === 'files' || graphMode === 'callgraph') return []
    return groupNodesToFG(groupedGraph.nodes, groupedGraph.edges, selectedId)
  }, [groupedGraph, selectedId, graphMode])

  const groupFgEdges = useMemo<FGEdge[]>(() => {
    if (!groupedGraph || graphMode === 'files' || graphMode === 'callgraph') return []
    return groupEdgesToFG(groupedGraph.edges)
  }, [groupedGraph, graphMode])

  // Callgraph mode
  const cgFg = useMemo(() => {
    if (!callgraphReport || graphMode !== 'callgraph') return { nodes: [], edges: [] }
    return callgraphToFG(callgraphReport, selectedId)
  }, [callgraphReport, selectedId, graphMode])

  // Active FGNodes/FGEdges depending on mode
  const fgNodes = graphMode === 'files' ? filesFgNodes
    : graphMode === 'callgraph' ? cgFg.nodes
    : groupFgNodes

  const fgEdges = graphMode === 'files' ? filesFgEdges
    : graphMode === 'callgraph' ? cgFg.edges
    : groupFgEdges

  const isRanked = graphMode !== 'files'

  // ── selection handlers ────────────────────────────────────────────────────
  const handleNodeClick = useCallback((id: number) => {
    setSelectedId(prev => prev === id ? null : id)
  }, [])

  const handlePaneClick = useCallback(() => setSelectedId(null), [])
  const exitFocus = useCallback(() => { setFocusId(null); setSelectedId(null) }, [])

  // ── selected module details (files mode only) ─────────────────────────────
  const selectedModule   = graphMode === 'files' && selectedId !== null ? (model?.modules.find(m => m.id === selectedId) ?? null) : null
  const selectedMetrics  = selectedId !== null ? (model?.metrics[selectedId] ?? null) : null
  const selectedSignals  = selectedId !== null ? (signalsMap[selectedId] ?? null) : null
  const selectedViolations = violations.filter(
    v => selectedModule && (v.from_path === selectedModule.path || v.to_path === selectedModule.path),
  )
  const deps  = (adjacency.out.get(selectedId ?? -1) ?? []).map(id => model?.modules.find(m => m.id === id)).filter(Boolean) as Module[]
  const depOf = (adjacency.ins.get(selectedId ?? -1) ?? []).map(id => model?.modules.find(m => m.id === id)).filter(Boolean) as Module[]

  // ── aggregate stats ───────────────────────────────────────────────────────
  const cycleCount = model
    ? new Set(
        model.modules
          .filter(m => (model.metrics[m.id]?.scc_size ?? 0) > 1)
          .map(m => model.metrics[m.id]?.scc_id)
          .filter((id): id is number => id !== undefined),
      ).size
    : 0
  const violCount = violations.filter(v => v.severity === 'Error').length

  if (loading) return <Spinner />
  if (error)   return <ErrorMsg msg={error} />

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ height: '100%', position: 'relative', overflow: 'hidden' }}>

      {/* ── mode selector (top-center) ─────────────────────────────────── */}
      <div style={{
        position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)',
        zIndex: 15, display: 'flex', gap: 2,
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 8, padding: 3,
      }}>
        {MODE_LABELS.map(m => (
          <button
            key={m.id}
            title={m.title}
            onClick={() => setGraphMode(m.id)}
            style={{
              padding: '4px 10px', borderRadius: 6, fontSize: 11,
              background: graphMode === m.id ? 'var(--accent)' : 'transparent',
              border: 'none',
              color: graphMode === m.id ? '#fff' : 'var(--text-muted)',
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Loading overlay for grouped fetch */}
      {groupedLoading && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 5,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.3)',
          color: 'var(--text-muted)', fontSize: 13,
        }}>
          <Loader size={16} style={{ animation: 'spin 1s linear infinite', marginRight: 8 }} />
          building {graphMode} view…
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      <ForceGraph
        nodes={fgNodes}
        edges={fgEdges}
        layerOrder={layerOrder}
        onNodeClick={handleNodeClick}
        onPaneClick={handlePaneClick}
        layoutMode={isRanked ? 'ranked' : 'force'}
      />

      {/* ── search + filter bar (files mode only, top-left) ────────────── */}
      {graphMode === 'files' && (
        <div style={{
          position: 'absolute', top: 12, left: 12, zIndex: 10,
          display: 'flex', flexDirection: 'column', gap: 6,
          pointerEvents: 'all',
        }}>
          <input
            value={filter.search}
            onChange={e => setFilter(f => ({ ...f, search: e.target.value }))}
            placeholder="Search files…"
            style={{
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 6, padding: '5px 10px', fontSize: 12,
              color: 'var(--text)', width: 200, outline: 'none',
            }}
          />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {([
              ['cyclesOnly',     '↻ Cycles'],
              ['violationsOnly', '⚠ Violations'],
              ['hubsOnly',       '★ Hubs'],
              ['orphansOnly',    '◌ Orphans'],
              ['changedOnly',    '△ Changed'],
            ] as [keyof FilterState, string][]).map(([key, label]) => (
              <FilterPill
                key={key}
                label={label}
                active={filter[key] as boolean}
                onClick={() => setFilter(f => ({ ...f, [key]: !f[key] }))}
              />
            ))}
            {Object.values(filter).some(Boolean) && (
              <FilterPill label="✕ Clear" active={false} onClick={() => setFilter(DEFAULT_FILTER)} muted />
            )}
          </div>
          {focusId !== null && (
            <button
              onClick={exitFocus}
              style={{
                background: 'var(--surface)', border: '1px solid var(--warning)',
                borderRadius: 6, padding: '4px 10px', fontSize: 11,
                color: 'var(--warning)', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 5,
              }}
            >
              <RotateCcw size={11} /> Exit focus
            </button>
          )}
        </div>
      )}

      {/* ── grouped mode info (top-left) ───────────────────────────────── */}
      {graphMode !== 'files' && groupedGraph && (
        <div style={{
          position: 'absolute', top: 52, left: 12, zIndex: 10,
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 6, padding: '5px 10px', fontSize: 11,
          color: 'var(--text-muted)',
        }}>
          {groupedGraph.nodes.length} groups · {groupedGraph.edges.length} edges
        </div>
      )}
      {graphMode === 'callgraph' && callgraphReport && (
        <div style={{
          position: 'absolute', top: 52, left: 12, zIndex: 10,
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 6, padding: '5px 10px', fontSize: 11,
          color: 'var(--text-muted)',
        }}>
          {callgraphReport.nodes.length} fns · {callgraphReport.resolved_calls} resolved
          · {callgraphReport.unresolved_calls} unresolved
        </div>
      )}

      {/* ── stats card (bottom-left) ───────────────────────────────────── */}
      {model && graphMode === 'files' && (
        <div style={{
          position: 'absolute', bottom: 16, left: 12, zIndex: 10,
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 8, padding: '8px 14px', fontSize: 11,
          color: 'var(--text-muted)',
        }}>
          <span style={{ color: 'var(--text)', fontWeight: 600 }}>{model.modules.length}</span> files
          &nbsp;·&nbsp;
          <span style={{ color: 'var(--text)', fontWeight: 600 }}>{model.edges.length}</span> edges
          {cycleCount > 0 && (
            <>&nbsp;·&nbsp;<span style={{ color: '#f87171', fontWeight: 600 }}>{cycleCount} cycle{cycleCount > 1 ? 's' : ''}</span></>
          )}
          {violCount > 0 && (
            <>&nbsp;·&nbsp;<span style={{ color: 'var(--error)', fontWeight: 600 }}>{violCount} violation{violCount > 1 ? 's' : ''}</span></>
          )}
          {visibleModules.length < model.modules.length && (
            <>&nbsp;·&nbsp;<span style={{ color: 'var(--accent)' }}>{visibleModules.length} shown</span></>
          )}
        </div>
      )}

      {/* ── legend (bottom-right, files mode only) ────────────────────── */}
      {graphMode === 'files' && (
        <div style={{
          position: 'absolute', bottom: 16, right: 12, zIndex: 10,
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 8, fontSize: 11, color: 'var(--text-muted)',
          overflow: 'hidden', minWidth: 160,
        }}>
          <button
            onClick={() => setLegendOpen(o => !o)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              width: '100%', padding: '7px 12px', background: 'none', border: 'none',
              color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11,
            }}
          >
            <span style={{ fontWeight: 600 }}>Legend</span>
            {legendOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
          {legendOpen && (
            <div style={{ padding: '0 12px 10px', display: 'flex', flexDirection: 'column', gap: 5 }}>
              <LegendSection title="Layers (left border)">
                {layerOrder.map(name => (
                  <LegendRow key={name} swatch={layerColors[name] ?? '#8892aa'} label={name} />
                ))}
              </LegendSection>
              <LegendSection title="Fill colour (instability)">
                <span style={{ fontSize: 10, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', marginBottom: 4 }}>
                  fan_out / (fan_in + fan_out)
                  <InfoTip title={METRIC_HELP.instability.label} formula={METRIC_HELP.instability.formula}>{METRIC_HELP.instability.body}</InfoTip>
                </span>
                <LegendRow swatch="#6366f1" label="stable (I ≈ 0)" />
                <LegendRow swatch="#fbbf24" label="balanced" />
                <LegendRow swatch="#f87171" label="unstable (I ≈ 1)" />
              </LegendSection>
              <LegendSection title="Badges">
                <LegendRow swatch="↻" label="dependency cycle" text extra={<InfoTip title={METRIC_HELP.cycle.label}>{METRIC_HELP.cycle.body}</InfoTip>} />
                <LegendRow swatch="★" label="hub (top-10% fan-in)" text extra={<InfoTip title={METRIC_HELP.hub.label}>{METRIC_HELP.hub.body}</InfoTip>} />
                <LegendRow swatch="⚠" label="violation source" text extra={<InfoTip title={METRIC_HELP.violations.label}>{METRIC_HELP.violations.body}</InfoTip>} />
                <LegendRow swatch="⎘" label="near-duplicate" text extra={<InfoTip title={METRIC_HELP.similarity.label} formula={METRIC_HELP.similarity.formula}>{METRIC_HELP.similarity.body}</InfoTip>} />
              </LegendSection>
              <LegendSection title="Edges">
                <LegendRow swatch="#4338ca" label="import" />
                <LegendRow swatch="#fbbf24" label="re-export / branch" />
                <LegendRow swatch="#f87171" label="violation / cycle" />
              </LegendSection>
            </div>
          )}
        </div>
      )}

      {/* ── grouped mode legend ───────────────────────────────────────── */}
      {graphMode !== 'files' && (
        <div style={{
          position: 'absolute', bottom: 16, right: 12, zIndex: 10,
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 8, padding: '8px 12px', fontSize: 11,
          color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          <LegendRow swatch="#4338ca" label="dependency" />
          <LegendRow swatch="#fbbf24" label="upward (cross-layer)" />
          <LegendRow swatch="#f87171" label="violation" />
          {graphMode === 'scc' && <LegendRow swatch="#ef4444" label="SCC cluster node" />}
        </div>
      )}

      {/* ── detail panel (files mode, right side) ─────────────────────── */}
      {graphMode === 'files' && selectedModule && selectedMetrics && selectedSignals && (
        <DetailPanel
          module={selectedModule}
          metrics={selectedMetrics}
          signals={selectedSignals}
          violations={selectedViolations}
          deps={deps}
          depOf={depOf}
          layerColors={layerColors}
          onSelect={id => setSelectedId(id)}
          onFocus={() => { setFocusId(selectedId); setSelectedId(null) }}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  )
}

// ─── filter pill ─────────────────────────────────────────────────────────────

function FilterPill({
  label, active, onClick, muted = false,
}: { label: string; active: boolean; onClick: () => void; muted?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? 'var(--accent)' : 'var(--surface)',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 12, padding: '3px 9px', fontSize: 11,
        color: active ? '#fff' : muted ? 'var(--text-muted)' : 'var(--text)',
        cursor: 'pointer', whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  )
}

// ─── detail panel (files mode) ───────────────────────────────────────────────

function DetailPanel({
  module: m, metrics, signals, violations, deps, depOf, layerColors, onSelect, onFocus, onClose,
}: {
  module: Module
  metrics: ModuleMetrics
  signals: ModuleSignals
  violations: Violation[]
  deps: Module[]
  depOf: Module[]
  layerColors: Record<string, string>
  onSelect: (id: number) => void
  onFocus: () => void
  onClose: () => void
}) {
  const baseName = m.path.split('/').pop() ?? m.path
  const lc = layerColor(signals.layer, layerColors)
  const sdpLabel =
    signals.instability < 0.25 ? 'stable — depended upon by many'
    : signals.instability > 0.75 ? 'unstable — depends on many others'
    : 'balanced'

  return (
    <div style={{
      position: 'absolute', top: 12, right: 12, zIndex: 10,
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 8, padding: '12px 14px',
      width: 270, maxHeight: 'calc(100vh - 120px)',
      overflowY: 'auto', fontSize: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13, wordBreak: 'break-word' }}>{baseName}</div>
          <code style={{ fontSize: 9, color: 'var(--text-muted)', wordBreak: 'break-all', display: 'block' }}>
            {m.path}
          </code>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 2, flexShrink: 0 }}>
          <X size={14} />
        </button>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 12 }}>
        {signals.layer && <Tag label={signals.layer} color={lc} />}
        {signals.isCycle   && <Tag label="↻ cycle"     color="var(--error)" />}
        {signals.isHub     && <Tag label="★ hub"        color="var(--warning)" />}
        {signals.isOrphan  && <Tag label="◌ orphan"     color="var(--text-muted)" />}
        {signals.isDupe    && <Tag label="⎘ duplicate"  color="var(--text-muted)" />}
        {signals.changeStatus === 'added'   && <Tag label="+ added"   color="var(--ok)" />}
        {signals.changeStatus === 'removed' && <Tag label="− removed" color="var(--error)" />}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 12px', marginBottom: 12 }}>
        <Metric label="Fan-in"  value={metrics.fan_in}  helpKey="fan_in" />
        <Metric label="Fan-out" value={metrics.fan_out} helpKey="fan_out" />
        <Metric
          label="Instability"
          value={`${(signals.instability * 100).toFixed(0)}%`}
          sub={sdpLabel}
          color={signals.instability > 0.7 ? 'var(--error)' : signals.instability < 0.3 ? 'var(--ok)' : 'var(--warning)'}
          helpKey="instability"
        />
        <Metric label="LOC"      value={signals.loc > 0 ? signals.loc : '—'} helpKey="loc" />
        <Metric label="Coupling" value={`${(metrics.coupling * 100).toFixed(1)}%`} helpKey="coupling" />
      </div>

      {violations.length > 0 && (
        <Section title={`Violations (${violations.length})`}>
          {violations.map((v, i) => (
            <div key={i} style={{
              background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.3)',
              borderRadius: 5, padding: '5px 8px',
              marginBottom: 5, fontSize: 11,
            }}>
              <div style={{ color: 'var(--error)', fontWeight: 600, marginBottom: 3 }}>{v.message}</div>
              <div style={{ color: 'var(--text-muted)' }}>rule: {v.rule}</div>
            </div>
          ))}
        </Section>
      )}

      <Section title={`Imports (${deps.length})`}>
        {deps.length === 0 ? <Muted>none</Muted> : deps.map(d => (
          <ModuleLink key={d.id} module={d} onClick={() => onSelect(d.id)} />
        ))}
      </Section>

      <Section title={`Imported by (${depOf.length})`}>
        {depOf.length === 0 ? <Muted>none</Muted> : depOf.map(d => (
          <ModuleLink key={d.id} module={d} onClick={() => onSelect(d.id)} />
        ))}
      </Section>

      <button
        onClick={onFocus}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          marginTop: 8, width: '100%',
          background: 'var(--surface2)', border: '1px solid var(--border)',
          borderRadius: 6, padding: '6px 10px', fontSize: 11,
          color: 'var(--text-muted)', cursor: 'pointer',
        }}
      >
        <Target size={12} /> Focus — show neighbourhood only
      </button>
    </div>
  )
}

// ─── small reusables ─────────────────────────────────────────────────────────

function Metric({ label, value, sub, color, helpKey }: { label: string; value: number | string; sub?: string; color?: string; helpKey?: string }) {
  const help = helpKey ? METRIC_HELP[helpKey] : undefined
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', color: 'var(--text-muted)', fontSize: 10 }}>
        {label}
        {help && (
          <InfoTip title={help.label} formula={help.formula}>{help.body}</InfoTip>
        )}
      </div>
      <div style={{ fontWeight: 700, fontSize: 14, color: color ?? 'var(--text)' }}>{value}</div>
      {sub && <div style={{ color: 'var(--text-muted)', fontSize: 9, lineHeight: 1.3, marginTop: 1 }}>{sub}</div>}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ color: 'var(--text-muted)', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5 }}>
        {title}
      </div>
      {children}
    </div>
  )
}

function Tag({ label, color }: { label: string; color: string }) {
  return (
    <span style={{ padding: '2px 7px', borderRadius: 10, fontSize: 10, background: `${color}22`, border: `1px solid ${color}55`, color }}>
      {label}
    </span>
  )
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ color: 'var(--text-muted)', fontSize: 11, fontStyle: 'italic' }}>{children}</div>
}

function ModuleLink({ module: m, onClick }: { module: Module; onClick: () => void }) {
  return (
    <button
      onClick={onClick} title={m.path}
      style={{
        display: 'block', width: '100%', textAlign: 'left',
        background: 'none', border: 'none', cursor: 'pointer',
        padding: '2px 0', color: 'var(--accent)', fontSize: 11,
        fontFamily: 'var(--mono)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}
    >
      {m.path}
    </button>
  )
}

function LegendSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {title}
      </div>
      {children}
    </div>
  )
}

function LegendRow({ swatch, label, text, extra }: { swatch: string; label: string; text?: boolean; extra?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
      {text
        ? <span style={{ width: 14, textAlign: 'center', fontSize: 12 }}>{swatch}</span>
        : <span style={{ width: 14, height: 10, borderRadius: 2, background: swatch, flexShrink: 0 }} />}
      <span>{label}</span>
      {extra}
    </div>
  )
}

function Spinner() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, color: 'var(--text-muted)' }}>
      <Loader size={18} style={{ animation: 'spin 1s linear infinite' }} />
      scanning…
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}

function ErrorMsg({ msg }: { msg: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, color: 'var(--error)' }}>
      <AlertCircle size={18} />
      {msg}
    </div>
  )
}
