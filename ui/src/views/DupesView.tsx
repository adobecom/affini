import { useEffect, useState, useCallback } from 'react'
import { fetchDupes, type DupesReport, type DupeCluster } from '../api'
import { Copy, AlertTriangle, Info, ChevronDown, ChevronRight } from 'lucide-react'
import { InfoTip } from '../components/InfoTip'
import { METRIC_HELP } from '../metricHelp'

const THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.9]
const DEFAULT_THRESHOLD = 0.6

export default function DupesView() {
  const [report, setReport] = useState<DupesReport | null>(null)
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (t: number) => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetchDupes(t)
      setReport(r)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(threshold) }, [load, threshold])

  const changeThreshold = (t: number) => {
    setThreshold(t)
    // Effect on [load, threshold] will fire load() — no direct call needed.
  }

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Divergence Radar</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            Structurally similar files — candidates for consolidation or intentional divergence.
          </p>
        </div>
        <ThresholdPicker value={threshold} onChange={changeThreshold} />
      </div>

      {loading && (
        <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '20px 0' }}>
          Scanning for duplicates…
        </div>
      )}

      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--error)', fontSize: 13 }}>
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {!loading && !error && report && (
        <>
          <SummaryRow report={report} />
          {report.clusters.length === 0 ? (
            <NoClusters threshold={report.threshold} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 20 }}>
              {report.clusters.map((c, i) => (
                <ClusterCard
                  key={c.files.slice().sort().join('|')}
                  cluster={c}
                  rank={i + 1}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ThresholdPicker({ value, onChange }: { value: number; onChange: (t: number) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
      <span style={{ display: 'flex', alignItems: 'center', fontSize: 11, color: 'var(--text-muted)' }}>
        Similarity threshold
        <InfoTip title={METRIC_HELP.similarity.label} formula={METRIC_HELP.similarity.formula}>
          {METRIC_HELP.similarity.body}
        </InfoTip>
      </span>
      <div style={{ display: 'flex', gap: 2 }}>
        {THRESHOLDS.map(t => (
          <button
            key={t}
            onClick={() => onChange(t)}
            style={{
              padding: '4px 10px',
              borderRadius: 6,
              border: 'none',
              fontSize: 11,
              fontFamily: 'inherit',
              cursor: 'pointer',
              background: value === t ? 'var(--accent)' : 'var(--surface2)',
              color: value === t ? '#fff' : 'var(--text-muted)',
            }}
          >
            {Math.round(t * 100)}%
          </button>
        ))}
      </div>
    </div>
  )
}

function SummaryRow({ report }: { report: DupesReport }) {
  const total_files_in_clusters = report.clusters.reduce((s, c) => s + c.files.length, 0)
  return (
    <div style={{
      display: 'flex', gap: 24, padding: '12px 16px',
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
      fontSize: 13,
    }}>
      <Stat label="Files analyzed" value={report.files_analyzed} />
      <Stat label="Clusters found" value={report.clusters.length}
        color={report.clusters.length > 0 ? 'var(--warning)' : 'var(--ok)'} />
      <Stat label="Files in clusters" value={total_files_in_clusters}
        color={total_files_in_clusters > 0 ? 'var(--warning)' : 'var(--ok)'} />
      <Stat label="Threshold" value={`${Math.round(report.threshold * 100)}%`} />
    </div>
  )
}

function Stat({ label, value, color = 'var(--accent)' }: { label: string; value: number | string; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </span>
      <span style={{ fontSize: 18, fontWeight: 700, color }}>{value}</span>
    </div>
  )
}

function NoClusters({ threshold }: { threshold: number }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 12,
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
      padding: 20, marginTop: 20, color: 'var(--text-muted)', fontSize: 13,
    }}>
      <Info size={16} style={{ flexShrink: 0, marginTop: 2 }} />
      <div>
        <strong style={{ color: 'var(--text)' }}>No structural duplicates found.</strong>
        <br />
        No file pairs exceed {Math.round(threshold * 100)}% structural similarity.
        Lower the threshold to surface more candidates, or celebrate a clean codebase.
      </div>
    </div>
  )
}

function ClusterCard({ cluster, rank }: { cluster: DupeCluster; rank: number }) {
  const [expanded, setExpanded] = useState(rank <= 3)
  const pct = Math.round(cluster.similarity * 100)
  const severity = pct >= 85 ? 'var(--error)' : pct >= 70 ? 'var(--warning)' : 'var(--accent)'

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden',
    }}>
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 12,
          padding: '12px 16px', background: 'none', border: 'none',
          cursor: 'pointer', textAlign: 'left', color: 'var(--text)',
        }}
      >
        {expanded ? <ChevronDown size={13} color="var(--text-muted)" /> : <ChevronRight size={13} color="var(--text-muted)" />}
        <Copy size={13} color={severity} />
        <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>
          Cluster {rank} — {cluster.files.length} files
        </span>
        <SimilarityBadge pct={pct} color={severity} />
      </button>

      {expanded && (
        <div style={{ padding: '0 16px 14px 44px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <SimilarityBar pct={pct} color={severity} />
          {cluster.files.map((f, i) => (
            <div key={i} style={{
              fontSize: 11, fontFamily: 'var(--mono)',
              color: 'var(--text-muted)', padding: '2px 0',
            }}>
              {f}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SimilarityBadge({ pct, color }: { pct: number; color: string }) {
  const help = METRIC_HELP.similarity
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 2,
      fontSize: 11, fontWeight: 700, color,
      background: `color-mix(in srgb, ${color} 15%, transparent)`,
      padding: '2px 8px', borderRadius: 12, flexShrink: 0,
    }}>
      {pct}% similar
      <InfoTip title={help.label} formula={help.formula}>{help.body}</InfoTip>
    </span>
  )
}

function SimilarityBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div style={{
      height: 4, background: 'var(--surface2)', borderRadius: 2,
      marginBottom: 8, overflow: 'hidden',
    }}>
      <div style={{
        height: '100%', width: `${pct}%`,
        background: color, borderRadius: 2,
        transition: 'width 0.3s ease',
      }} />
    </div>
  )
}
