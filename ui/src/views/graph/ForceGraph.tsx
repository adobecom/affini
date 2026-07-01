import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import {
  forceSimulation, forceLink, forceManyBody, forceCollide, forceY, forceX,
  zoom as d3zoom, zoomIdentity, select,
  type SimulationNodeDatum, type SimulationLinkDatum, type ZoomTransform,
} from 'd3'
import { ModuleNode } from './ModuleNode'
import { buildLayerColors, layerColor } from './layers'
import { edgePath, NODE_H } from './edgePath'
import { computeRankedLayout } from './dagreLayout'
import type { ModuleMetrics } from '../../api'
import type { ModuleSignals } from './ModuleNode'

// ─── simulation types ─────────────────────────────────────────────────────────

interface SimNode extends SimulationNodeDatum {
  id: number
  path: string
  width: number
  layer?: string
  signals: ModuleSignals
  metrics: ModuleMetrics
  isSelected: boolean
  isDimmed: boolean
}

interface SimEdge extends SimulationLinkDatum<SimNode> {
  edgeId: string
  color: string
  strokeWidth: number
  dashed: boolean
  dimmed: boolean
}

// ─── exported prop types ──────────────────────────────────────────────────────

export interface FGNode {
  id: number
  path: string
  width: number
  layer?: string
  signals: ModuleSignals
  metrics: ModuleMetrics
  isSelected: boolean
  isDimmed: boolean
}

export interface FGEdge {
  id: string
  fromId: number
  toId: number
  color: string
  strokeWidth: number
  dashed: boolean
  dimmed: boolean
}

export interface ForceGraphProps {
  nodes: FGNode[]
  edges: FGEdge[]
  layerOrder: string[]
  onNodeClick: (id: number) => void
  onPaneClick: () => void
  /** 'force' uses the D3 sim; 'ranked' uses a static dagre BT layout. Default: 'force'. */
  layoutMode?: 'force' | 'ranked'
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function layerTargetY(layer: string | undefined, order: string[], H: number): number {
  if (!order.length || !layer) return H / 2
  const idx = order.indexOf(layer)
  if (idx === -1) return H / 2
  // idx 0 (core, most stable) → bottom,  idx n-1 (ui) → top
  const margin = 90
  const bandH = (H - margin * 2) / order.length
  return H - margin - (idx + 0.5) * bandH
}

const EDGE_COLORS = ['#4338ca', '#fbbf24', '#f87171', '#ef4444'] as const

function markerId(color: string): string {
  return `fg-arrow-${color.replace('#', '')}`
}

// ─── component ────────────────────────────────────────────────────────────────

export function ForceGraph({
  nodes, edges, layerOrder, onNodeClick, onPaneClick, layoutMode = 'force',
}: ForceGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef       = useRef<SVGSVGElement>(null)
  const gRef         = useRef<SVGGElement>(null)
  const simRef       = useRef<ReturnType<typeof forceSimulation<SimNode, SimEdge>> | null>(null)
  const graphNodesRef = useRef<SimNode[]>([])
  const graphEdgesRef = useRef<SimEdge[]>([])
  const zoomRef      = useRef<ZoomTransform>(zoomIdentity)
  const rafRef       = useRef<number | null>(null)
  const [, forceUpdate] = useReducer(x => x + 1, 0)

  // Layer colors derived from declared order (index-based, not name-based).
  const layerColors = useMemo(() => buildLayerColors(layerOrder), [layerOrder])

  // Only layers that have at least one visible node — bands tile these, not the full declared set.
  const populatedOrder = useMemo(
    () => layerOrder.filter(name => nodes.some(n => n.layer === name)),
    [nodes, layerOrder],
  )

  // Ranked layout positions (only computed in ranked mode)
  const rankedLayout = useMemo(() => {
    if (layoutMode !== 'ranked') return null
    return computeRankedLayout(
      nodes.map(n => ({ id: n.id, width: n.width, layer: n.layer })),
      edges.map(e => ({ fromId: e.fromId, toId: e.toId })),
      layerOrder,
    )
  }, [layoutMode, nodes, edges, layerOrder])

  // ── zoom setup (force mode only — ranked mode uses native container scroll) ──
  useEffect(() => {
    const svgEl = svgRef.current
    if (!svgEl) return
    if (layoutMode === 'ranked') {
      // Remove any previously attached zoom handler when switching to ranked.
      select(svgEl).on('.zoom', null)
      return
    }
    const zb = d3zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.05, 5])
      .filter(ev =>
        !(ev.target instanceof Element && ev.target.closest?.('foreignObject')),
      )
      .on('zoom', ev => {
        zoomRef.current = ev.transform
        gRef.current?.setAttribute('transform', String(ev.transform))
      })
    select(svgEl).call(zb)
    return () => { select(svgEl).on('.zoom', null) }
  }, [layoutMode])

  // ── simulation rebuild on data change (force mode only) ───────────────────
  useEffect(() => {
    if (layoutMode === 'ranked') {
      // Populate graphNodesRef from dagre positions so the render path below works.
      if (!rankedLayout) return
      graphNodesRef.current = nodes.map(n => {
        const pos = rankedLayout.positions.get(n.id)
        return { ...n, x: pos?.x ?? 0, y: pos?.y ?? 0 } as SimNode
      })
      graphEdgesRef.current = edges
        .filter(e => nodes.some(n => n.id === e.fromId) && nodes.some(n => n.id === e.toId))
        .map(e => ({
          edgeId: e.id,
          source: e.fromId,
          target: e.toId,
          color: e.color,
          strokeWidth: e.strokeWidth,
          dashed: e.dashed,
          dimmed: e.dimmed,
        }))
      forceUpdate()
      return
    }

    const container = containerRef.current
    const W = container?.clientWidth  ?? 900
    const H = container?.clientHeight ?? 650

    // Carry over settled positions for nodes that survived a filter change
    const prevPos = new Map(
      graphNodesRef.current.map(n => [n.id, { x: n.x, y: n.y }]),
    )

    const simNodes: SimNode[] = nodes.map(n => {
      const prev = prevPos.get(n.id)
      return {
        ...n,
        x: prev?.x ?? W / 2 + (Math.random() - 0.5) * 160,
        y: prev?.y ?? layerTargetY(n.layer, populatedOrder, H) + (Math.random() - 0.5) * 50,
      }
    })

    const simEdges: SimEdge[] = edges
      .filter(e => simNodes.some(n => n.id === e.fromId) && simNodes.some(n => n.id === e.toId))
      .map(e => ({
        edgeId: e.id,
        source: e.fromId,
        target: e.toId,
        color: e.color,
        strokeWidth: e.strokeWidth,
        dashed: e.dashed,
        dimmed: e.dimmed,
      }))

    simRef.current?.stop()
    graphNodesRef.current = simNodes
    graphEdgesRef.current = simEdges

    const sim = forceSimulation<SimNode, SimEdge>(simNodes)
      .force('link',
        forceLink<SimNode, SimEdge>(simEdges)
          .id(d => d.id)
          .distance(220)
          .strength(0.07),
      )
      .force('charge', forceManyBody<SimNode>().strength(-430))
      .force('collide',
        forceCollide<SimNode>(n => n.width / 2 + 18).strength(0.85),
      )
      .force('y',
        forceY<SimNode>(n => layerTargetY(n.layer, populatedOrder, H)).strength(0.32),
      )
      .force('x', forceX<SimNode>(W / 2).strength(0.025))
      .alphaDecay(0.018)
      .velocityDecay(0.38)

    // Pre-warm so initial render is already spread out
    sim.tick(90)

    sim.on('tick', () => {
      if (rafRef.current !== null) return
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        forceUpdate()
      })
    })

    simRef.current = sim
    forceUpdate()

    return () => {
      sim.stop()
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, layerOrder, layoutMode])

  // ── node drag (force mode only) ───────────────────────────────────────────
  const handleNodeMouseDown = useCallback((e: React.MouseEvent, nodeId: number) => {
    if (layoutMode === 'ranked') return
    e.stopPropagation()
    e.nativeEvent.stopPropagation()

    const node = graphNodesRef.current.find(n => n.id === nodeId)
    if (!node) return

    const scale  = zoomRef.current.k
    const sx0 = e.clientX, sy0 = e.clientY
    const nx0 = node.x ?? 0, ny0 = node.y ?? 0

    node.fx = nx0
    node.fy = ny0
    simRef.current?.alphaTarget(0.25).restart()

    const onMove = (ev: MouseEvent) => {
      node.fx = nx0 + (ev.clientX - sx0) / scale
      node.fy = ny0 + (ev.clientY - sy0) / scale
      if (rafRef.current !== null) return
      rafRef.current = requestAnimationFrame(() => { rafRef.current = null; forceUpdate() })
    }
    const onUp = () => {
      simRef.current?.alphaTarget(0)
      node.fx = null
      node.fy = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [layoutMode])

  const handleNodeClick = useCallback((e: React.MouseEvent, nodeId: number) => {
    e.stopPropagation()
    onNodeClick(nodeId)
  }, [onNodeClick])

  // ── layer band data (force mode bands only) ───────────────────────────────
  const H = containerRef.current?.clientHeight ?? 650
  const margin = 90
  const layerBands = layoutMode === 'force' ? populatedOrder.map(name => {
    const yC    = layerTargetY(name, populatedOrder, H)
    const bandH = populatedOrder.length > 0 ? (H - margin * 2) / populatedOrder.length : H
    const color = layerColors[name] ?? '#8892aa'
    return { name, yTop: yC - bandH / 2, height: bandH, color }
  }) : []

  const graphNodes = graphNodesRef.current
  const graphEdges = graphEdgesRef.current

  // Ranked mode: SVG is scrollable with dagre dimensions
  const svgWidth  = layoutMode === 'ranked' ? (rankedLayout?.width  ?? 800) : undefined
  const svgHeight = layoutMode === 'ranked' ? (rankedLayout?.height ?? 600) : undefined

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%', height: '100%', position: 'relative',
        overflow: layoutMode === 'ranked' ? 'auto' : 'hidden',
      }}
    >
      <svg
        ref={svgRef}
        width={svgWidth ?? '100%'}
        height={svgHeight ?? '100%'}
        style={{ display: 'block', cursor: layoutMode === 'ranked' ? 'default' : 'grab' }}
        onClick={onPaneClick}
      >
        {/* ── defs: arrowhead markers + glow filter ────────────────────── */}
        <defs>
          {EDGE_COLORS.map(c => (
            <marker
              key={c}
              id={markerId(c)}
              viewBox="0 0 10 10"
              refX="8" refY="5"
              markerWidth="5" markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={c} />
            </marker>
          ))}
          <filter id="fg-glow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="2.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* ── zoom/pan group ────────────────────────────────────────────── */}
        <g ref={gRef}>

          {/* architectural layer bands (force mode only) */}
          {layerBands.map(band => (
            <g key={band.name}>
              <rect
                x={-10000} y={band.yTop}
                width={20000} height={band.height}
                fill={`${band.color}0c`}
                stroke={`${band.color}22`}
                strokeWidth={1}
              />
            </g>
          ))}

          {/* dependency edges */}
          {graphEdges.map(e => {
            const src = e.source
            const tgt = e.target
            if (typeof src !== 'object' || typeof tgt !== 'object') return null
            const s = src as SimNode
            const t = tgt as SimNode
            if (s.x == null || t.x == null) return null
            const d = edgePath(s.x, s.y!, t.x, t.y!, t.width)
            const isHot = e.color === '#f87171' || e.color === '#ef4444'
            return (
              <path
                key={e.edgeId}
                d={d}
                fill="none"
                stroke={e.color}
                strokeWidth={e.strokeWidth}
                strokeDasharray={e.dashed ? '5 3' : undefined}
                opacity={e.dimmed ? 0.06 : 0.72}
                markerEnd={`url(#${markerId(e.color)})`}
                filter={isHot && !e.dimmed ? 'url(#fg-glow)' : undefined}
                style={{ transition: 'opacity 0.12s' }}
              />
            )
          })}

          {/* module nodes via foreignObject */}
          {graphNodes.map(n => (
            <foreignObject
              key={n.id}
              x={(n.x ?? 0) - n.width / 2}
              y={(n.y ?? 0) - NODE_H / 2}
              width={n.width}
              height={NODE_H}
              overflow="visible"
              onMouseDown={ev => handleNodeMouseDown(ev, n.id)}
              onClick={ev => handleNodeClick(ev, n.id)}
              style={{ cursor: layoutMode === 'ranked' ? 'pointer' : 'pointer' }}
            >
              <ModuleNode
                data={{
                  module: { id: n.id, path: n.path, is_file: true, exports: [] },
                  metrics: n.metrics,
                  signals: n.signals,
                  isSelected: n.isSelected,
                  isDimmed: n.isDimmed,
                  width: n.width,
                  height: NODE_H,
                  layerColor: layerColor(n.layer, layerColors),
                }}
              />
            </foreignObject>
          ))}
        </g>
      </svg>
    </div>
  )
}
