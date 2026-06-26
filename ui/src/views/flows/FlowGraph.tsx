import { useEffect, useMemo, useRef } from 'react'
import type { Flow } from '../../api'
import { TypeShapeView } from './TypeShapeView'
import {
  computeFlowLayout,
  moduleHue,
  NODE_W,
  NODE_H_FLOW,
  PAD,
} from './flowLayout'
import { edgePath } from '../graph/edgePath'

// ── self-loop arc helper ───────────────────────────────────────────────────────

/**
 * SVG arc for a self-loop: starts and ends at the same point (top-center of node)
 * so the animated dot has no discontinuous jump between iterations.
 */
function selfLoopPath(cx: number, cy: number): string {
  const ty = cy - NODE_H_FLOW / 2
  const r = 30
  // Start and end at the same point (cx, ty); sweep a full ellipse above via two arcs
  return (
    `M${cx.toFixed(1)},${ty.toFixed(1)} ` +
    `A${r},${r} 0 0 1 ${(cx + r * 2).toFixed(1)},${ty.toFixed(1)} ` +
    `A${r},${r} 0 0 1 ${cx.toFixed(1)},${ty.toFixed(1)}`
  )
}

/** Point at progress t∈[0,1] along the self-loop arc. */
function selfLoopPoint(cx: number, cy: number, t: number): { x: number; y: number } {
  // Two 180-degree arcs; map t 0→0.5 to first arc, 0.5→1 to second
  const ty = cy - NODE_H_FLOW / 2
  const r = 30
  const angle = t * 2 * Math.PI // 0 → 2π (full circle traversal)
  return {
    x: cx + r + r * Math.cos(Math.PI + angle),
    y: ty - r * Math.sin(angle),
  }
}

// ── component ─────────────────────────────────────────────────────────────────

export interface FlowGraphProps {
  flow: Flow
  stepIndex: number
  playing: boolean
  stepDurationMs: number
  onStepSelect: (i: number) => void
}

export function FlowGraph({ flow, stepIndex, playing, stepDurationMs, onStepSelect }: FlowGraphProps) {
  const layout = useMemo(() => computeFlowLayout(flow), [flow.id])

  // Imperative refs for the animated dot + package card (no setState per frame)
  const dotRef     = useRef<SVGCircleElement>(null)
  const pkgRef     = useRef<SVGForeignObjectElement>(null)
  const rafRef     = useRef<number | null>(null)

  const step = flow.steps[stepIndex] ?? null

  // ── rAF dot animation ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!step) return
    const edge = layout.edges[stepIndex]
    if (!edge) return

    const fromNode = layout.nodes.get(edge.fromKey)
    const toNode   = layout.nodes.get(edge.toKey)
    if (!fromNode || !toNode) return

    const dotEl = dotRef.current
    const pkgEl = pkgRef.current
    if (!dotEl || !pkgEl) return

    // Build path to measure
    let totalLen = 1
    let pathEl: SVGPathElement | null = null

    if (!edge.isSelfLoop) {
      pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      pathEl.setAttribute('d', edgePath(fromNode.x, fromNode.y, toNode.x, toNode.y, NODE_W))
      document.body.appendChild(pathEl) // needed for getTotalLength
      totalLen = pathEl.getTotalLength() || 1
    }

    const start = performance.now()

    function tick(now: number) {
      const elapsed = now - start
      const progress = playing
        ? Math.min(1, elapsed / stepDurationMs)
        : 1  // paused: dot rests at target (callee)

      let pt: { x: number; y: number }
      if (edge.isSelfLoop) {
        pt = selfLoopPoint(fromNode!.x, fromNode!.y, progress)
      } else {
        const p = pathEl!.getPointAtLength(progress * totalLen)
        pt = { x: p.x, y: p.y }
      }

      if (dotEl) {
        dotEl.setAttribute('cx', pt.x.toFixed(1))
        dotEl.setAttribute('cy', pt.y.toFixed(1))
      }
      if (pkgEl) {
        // Float the card above-right of the dot
        pkgEl.setAttribute('x',  (pt.x + 8).toFixed(1))
        pkgEl.setAttribute('y',  (pt.y - 88).toFixed(1))
      }

      if (playing && progress < 1) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        rafRef.current = null
      }
    }

    rafRef.current = requestAnimationFrame(tick)

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      if (pathEl && document.body.contains(pathEl)) {
        document.body.removeChild(pathEl)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex, playing, flow.id, stepDurationMs])

  // ── empty state ───────────────────────────────────────────────────────────
  if (layout.nodes.size === 0) {
    return (
      <div style={{
        height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-muted)', fontSize: 13,
      }}>
        No steps to visualize
      </div>
    )
  }

  const nodes = [...layout.nodes.values()]
  const edges  = layout.edges
  const activeEdge = edges[stepIndex] ?? null

  const activeFromKey = activeEdge?.fromKey ?? ''
  const activeToKey   = activeEdge?.toKey   ?? ''

  // Max severity of the active step (for package card border color)
  const fragility = step?.fragility ?? []
  const hasError   = fragility.some(f => f.severity === 'Error')
  const hasWarning = fragility.some(f => f.severity === 'Warning')
  const pkgBorder  = hasError ? 'var(--error)' : hasWarning ? 'var(--warning, #fbbf24)' : 'var(--border)'

  // Initial dot position: rest at the TO node (paused = "arrived at callee").
  // This avoids a one-frame flash at the from position before the first rAF fires.
  const initTo   = activeEdge ? layout.nodes.get(activeEdge.toKey) : null
  const dotInitX = initTo?.x ?? PAD + NODE_W / 2
  const dotInitY = initTo?.y ?? PAD + NODE_H_FLOW / 2

  return (
    <div style={{ width: '100%', height: '100%', overflow: 'auto', position: 'relative' }}>
      <style>{`
        @keyframes dot-pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.55; }
        }
      `}</style>
      <svg
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ display: 'block', minWidth: '100%', minHeight: '100%' }}
      >
        {/* ── defs ────────────────────────────────────────────────────── */}
        <defs>
          <filter id="fgw-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <marker
            id="fgw-arrow"
            viewBox="0 0 10 10"
            refX="8" refY="5"
            markerWidth="5" markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent, #6366f1)" />
          </marker>
          <marker
            id="fgw-arrow-dim"
            viewBox="0 0 10 10"
            refX="8" refY="5"
            markerWidth="5" markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#555" />
          </marker>
        </defs>

        {/* ── all edges (faint base layer) ─────────────────────────── */}
        {edges.map((e, i) => {
          const fn = layout.nodes.get(e.fromKey)
          const tn = layout.nodes.get(e.toKey)
          if (!fn || !tn) return null
          const isPast   = i < stepIndex
          const isActive = i === stepIndex
          if (isActive) return null // drawn separately below

          const d = e.isSelfLoop
            ? selfLoopPath(fn.x, fn.y)
            : edgePath(fn.x, fn.y, tn.x, tn.y, NODE_W)

          return (
            <path
              key={i}
              d={d}
              fill="none"
              stroke={isPast ? 'var(--accent, #6366f1)' : 'var(--border, #333)'}
              strokeWidth={isPast ? 1.5 : 1}
              opacity={isPast ? 0.45 : 0.18}
              strokeDasharray={e.isSelfLoop ? undefined : undefined}
              markerEnd={`url(#${isPast ? 'fgw-arrow' : 'fgw-arrow-dim'})`}
              style={{ cursor: 'pointer' }}
              onClick={() => onStepSelect(i)}
            />
          )
        })}

        {/* ── active edge (accent + glow) ───────────────────────────── */}
        {activeEdge && (() => {
          const fn = layout.nodes.get(activeEdge.fromKey)
          const tn = layout.nodes.get(activeEdge.toKey)
          if (!fn || !tn) return null
          const d = activeEdge.isSelfLoop
            ? selfLoopPath(fn.x, fn.y)
            : edgePath(fn.x, fn.y, tn.x, tn.y, NODE_W)
          return (
            <path
              d={d}
              fill="none"
              stroke="var(--accent, #6366f1)"
              strokeWidth={2}
              opacity={1}
              filter="url(#fgw-glow)"
              markerEnd="url(#fgw-arrow)"
            />
          )
        })()}

        {/* ── nodes ────────────────────────────────────────────────── */}
        {nodes.map(n => {
          const isFrom   = n.key === activeFromKey
          const isTo     = n.key === activeToKey
          const isActive = isFrom || isTo
          const hue      = moduleHue(n.module)

          return (
            <g
              key={n.key}
              style={{ cursor: 'pointer' }}
              onClick={() => {
                const idx = edges.findIndex(e => e.toKey === n.key)
                if (idx !== -1) onStepSelect(idx)
              }}
            >
              {/* module-color stripe (left border) */}
              <rect
                x={n.x - NODE_W / 2}
                y={n.y - NODE_H_FLOW / 2}
                width={4}
                height={NODE_H_FLOW}
                rx={3}
                fill={`hsl(${hue},60%,55%)`}
                opacity={isActive ? 1 : 0.45}
              />
              {/* node body */}
              <rect
                x={n.x - NODE_W / 2 + 4}
                y={n.y - NODE_H_FLOW / 2}
                width={NODE_W - 4}
                height={NODE_H_FLOW}
                rx={6}
                fill={isActive ? 'rgba(99,102,241,0.12)' : 'var(--surface, #1a1a2e)'}
                stroke={isActive ? 'var(--accent, #6366f1)' : 'var(--border, #333)'}
                strokeWidth={isActive ? 1.5 : 1}
                filter={isActive ? 'url(#fgw-glow)' : undefined}
                opacity={isActive ? 1 : 0.55}
              />
              {/* function label */}
              <text
                x={n.x + 6}
                y={n.y - 4}
                fontSize={11}
                fontFamily="var(--mono, monospace)"
                fill={isActive ? 'var(--text, #e0e0e0)' : 'var(--text-muted, #888)'}
                textAnchor="middle"
                dominantBaseline="auto"
                style={{ pointerEvents: 'none', userSelect: 'none' }}
              >
                {n.label.length > 18 ? n.label.slice(0, 17) + '…' : n.label}
              </text>
              {/* module path hint */}
              <text
                x={n.x + 6}
                y={n.y + 10}
                fontSize={9}
                fontFamily="var(--mono, monospace)"
                fill={`hsl(${hue},50%,60%)`}
                textAnchor="middle"
                dominantBaseline="auto"
                opacity={isActive ? 0.9 : 0.45}
                style={{ pointerEvents: 'none', userSelect: 'none' }}
              >
                mod:{n.module}
              </text>
              {/* ↺ recursive badge */}
              {activeEdge?.isSelfLoop && isFrom && (
                <text
                  x={n.x + NODE_W / 2 - 6}
                  y={n.y - NODE_H_FLOW / 2 + 12}
                  fontSize={10}
                  fill="var(--warning, #fbbf24)"
                  textAnchor="middle"
                  style={{ pointerEvents: 'none' }}
                >
                  ↺
                </text>
              )}
            </g>
          )
        })}

        {/* ── glowing dot ───────────────────────────────────────────── */}
        <circle
          ref={dotRef}
          cx={dotInitX}
          cy={dotInitY}
          r={7}
          fill="var(--accent, #6366f1)"
          filter="url(#fgw-glow)"
          style={{
            animation: playing ? 'dot-pulse 0.9s ease-in-out infinite' : undefined,
          }}
        />

        {/* ── floating package card ─────────────────────────────────── */}
        {step && (
          <foreignObject
            ref={pkgRef}
            x={dotInitX + 8}
            y={dotInitY - 120}
            width={220}
            height={116}
            overflow="visible"
            style={{ pointerEvents: 'none' }}
          >
            <div style={{
              background: 'var(--surface, #1a1a2e)',
              border: `1.5px solid ${pkgBorder}`,
              borderRadius: 8,
              padding: '6px 10px',
              fontSize: 11,
              fontFamily: 'var(--mono, monospace)',
              boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
              maxWidth: 220,
              overflow: 'hidden',
            }}>
              {/* callee name */}
              <div style={{
                fontWeight: 700,
                color: 'var(--text, #e0e0e0)',
                fontSize: 12,
                marginBottom: 4,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {step.callee_text || step.to.name}
              </div>
              {/* params compact */}
              {step.params.length > 0 && (
                <div style={{
                  color: 'var(--text-muted, #888)',
                  fontSize: 10,
                  marginBottom: 2,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {'('}
                  {step.params.map((p, i) => (
                    <span key={i}>
                      {i > 0 && <span>, </span>}
                      <span style={{ color: 'var(--text, #e0e0e0)' }}>{p.name}</span>
                      {p.optional && <span style={{ color: 'var(--warning, #fbbf24)' }}>?</span>}
                      <span style={{ color: 'var(--text-muted, #888)' }}>: </span>
                      <TypeShapeView shape={p.shape} inline />
                    </span>
                  ))}
                  {')'}
                </div>
              )}
              {/* return type */}
              <div style={{ fontSize: 10, color: 'var(--text-muted, #888)' }}>
                <span>→ </span>
                <TypeShapeView shape={step.return_shape} inline />
              </div>
            </div>
          </foreignObject>
        )}
      </svg>
    </div>
  )
}
