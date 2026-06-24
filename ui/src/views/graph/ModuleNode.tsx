/**
 * Module card — visual encoding:
 *  - Left border tint  → architectural layer (core/cli/ui)
 *  - Background fill   → instability on a cool→warm ramp (SDP visualisation)
 *  - Node width        → lines-of-code (larger = more code)
 *  - Red dashed border → participates in a dependency cycle (scc_size > 1)
 *  - Badges (up to 3) → ↻ cycle  ★ hub  ⚠ violation  ⎘ duplicate
 *  - Dim / outline     → selection / neighbourhood highlighting
 *  - Green/red tint    → added / removed since baseline
 */
import type { Module, ModuleMetrics } from '../../api'

// ─── layer palette (matches index.css variables) ────────────────────────────

export const LAYER_COLORS: Record<string, string> = {
  core: '#6366f1',  // --accent
  cli:  '#fbbf24',  // --warning
  ui:   '#34d399',  // --ok
}

export function layerColor(layer?: string): string {
  if (!layer) return '#2e3250'  // --border
  return LAYER_COLORS[layer] ?? '#8892aa'  // --text-muted fallback
}

// ─── instability fill colour (cool stable → warm unstable) ──────────────────

function instabilityBg(I: number): string {
  // I=0 → cool indigo (#6366f1) at 12% alpha
  // I=1 → warm red   (#f87171) at 12% alpha
  const r = Math.round(99  + (248 - 99)  * I)
  const g = Math.round(102 + (113 - 102) * I)
  const b = Math.round(241 + (113 - 241) * I)
  return `rgba(${r},${g},${b},0.14)`
}

// ─── data shape ─────────────────────────────────────────────────────────────

export interface ModuleSignals {
  instability: number
  isHub: boolean
  isOrphan: boolean
  isCycle: boolean
  isViolationSrc: boolean
  isDupe: boolean
  changeStatus: 'added' | 'removed' | null
  loc: number
  layer: string | undefined
}

export interface ModuleNodeData {
  module: Module
  metrics: ModuleMetrics
  signals: ModuleSignals
  isSelected: boolean
  isDimmed: boolean
  width: number
  height: number
}

// ─── component ──────────────────────────────────────────────────────────────

export function ModuleNode({ data }: { data: ModuleNodeData }) {
  const { module: m, metrics, signals, isSelected, isDimmed, width } = data
  const { instability, isHub, isOrphan, isCycle, isViolationSrc, isDupe, changeStatus, loc, layer } = signals

  const lc = layerColor(layer)

  const bg =
    changeStatus === 'added'   ? 'rgba(52,211,153,0.12)' :
    changeStatus === 'removed' ? 'rgba(248,113,113,0.12)' :
    isOrphan                   ? 'rgba(136,146,170,0.07)' :
    instabilityBg(instability)

  const borderColor = isCycle ? '#f87171' : isHub ? '#fbbf24' : lc
  const borderStyle = isCycle ? 'dashed' : 'solid'
  const changeOutline =
    changeStatus === 'added'   ? '2px solid rgba(52,211,153,0.7)'  :
    changeStatus === 'removed' ? '2px solid rgba(248,113,113,0.7)' :
    isSelected                 ? `2px solid ${lc}`                 :
    'none'

  const baseName = m.path.split('/').pop() ?? m.path
  const dir = m.path.includes('/') ? m.path.substring(0, m.path.lastIndexOf('/')) : ''

  // Instability label colour
  const iColor =
    instability > 0.7 ? '#f87171' :
    instability < 0.3 ? '#34d399' :
    '#fbbf24'

  // Badges — cap at 3
  const badges: React.ReactNode[] = []
  if (isCycle)        badges.push(<span key="cy" title="Dependency cycle (circular imports)" style={{ color: '#f87171' }}>↻</span>)
  if (isHub)          badges.push(<span key="hu" title="Hub module — top 10% fan-in" style={{ color: '#fbbf24' }}>★</span>)
  if (isViolationSrc) badges.push(<span key="vl" title="Architectural violation source" style={{ color: '#f87171' }}>⚠</span>)
  else if (isDupe)    badges.push(<span key="dp" title="Near-duplicate code cluster" style={{ color: '#8892aa' }}>⎘</span>)

  return (
    <div
      style={{
        background: bg,
        border: `1px ${borderStyle} ${borderColor}`,
        borderLeft: `3px ${borderStyle} ${lc}`,
        borderRadius: 7,
        padding: '5px 9px 6px',
        width,
        opacity: isDimmed ? 0.15 : isOrphan ? 0.65 : 1,
        outline: changeOutline,
        outlineOffset: 2,
        transition: 'opacity 0.15s',
        boxSizing: 'border-box',
        color: 'var(--text)',
        userSelect: 'none',
        height: '100%',
      }}
    >
      {/* filename + badges */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
        <div
          style={{
            fontWeight: 700,
            fontSize: 11,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={baseName}
        >
          {baseName}
        </div>
        {badges.length > 0 && (
          <div style={{ display: 'flex', gap: 2, fontSize: 11, flexShrink: 0 }}>
            {badges}
          </div>
        )}
      </div>

      {/* directory path */}
      <div
        style={{
          color: 'var(--text-muted)',
          fontSize: 9,
          marginTop: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={m.path}
      >
        {dir}
      </div>

      {/* metrics row */}
      <div style={{ display: 'flex', gap: 7, fontSize: 10, marginTop: 4, color: 'var(--text-muted)' }}>
        <span title="Fan-in (imported by)">↙{metrics.fan_in}</span>
        <span title="Fan-out (imports)">↗{metrics.fan_out}</span>
        <span title="Instability: fan_out/(fan_in+fan_out)" style={{ color: iColor }}>
          I:{(instability * 100).toFixed(0)}%
        </span>
        {loc > 0 && <span title="Lines of code" style={{ marginLeft: 'auto', opacity: 0.6 }}>{loc}L</span>}
      </div>
    </div>
  )
}
