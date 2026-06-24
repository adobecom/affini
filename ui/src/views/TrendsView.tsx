import { useEffect, useState, useCallback } from 'react'
import { fetchTrends, fetchBaseline, postBaseline, type TrendPoint, type Baseline } from '../api'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  ReferenceLine,
} from 'recharts'
import { Info, BookOpen } from 'lucide-react'

export default function TrendsView() {
  const [points, setPoints] = useState<TrendPoint[]>([])
  const [baseline, setBaseline] = useState<Baseline | null>(null)
  const [loading, setLoading] = useState(true)
  const [markingRead, setMarkingRead] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [pts, bl] = await Promise.all([fetchTrends(), fetchBaseline()])
      setPoints(pts)
      setBaseline(bl)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const markRead = async () => {
    setMarkingRead(true)
    try {
      await postBaseline('workdir')
      await load()
    } finally {
      setMarkingRead(false)
    }
  }

  const current = points[points.length - 1] ?? null

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 4 }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Erosion Trends</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            Coupling/cohesion metrics across saved snapshots.{' '}
            <code style={{ background: 'var(--surface2)', padding: '1px 4px', borderRadius: 3, fontSize: 11 }}>
              affini scan --snapshot &lt;label&gt;
            </code>{' '}
            to add a point.
          </p>
        </div>
        <MarkReadButton onMark={markRead} loading={markingRead} />
      </div>

      {loading ? (
        <Placeholder msg="loading…" />
      ) : points.length <= 1 ? (
        <EmptyTrends />
      ) : (
        <TrendChart points={points} baseline={baseline} />
      )}

      {!loading && current && <CurrentStats point={current} baseline={baseline} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Mark as read button
// ---------------------------------------------------------------------------

function MarkReadButton({
  onMark, loading,
}: { onMark: () => void; loading: boolean }) {
  return (
    <button
      onClick={onMark}
      disabled={loading}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '8px 14px', borderRadius: 8,
        background: 'var(--accent-dim)', border: 'none',
        color: '#fff', fontSize: 12, fontFamily: 'inherit',
        cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1,
        flexShrink: 0,
      }}
    >
      <BookOpen size={13} />
      {loading ? 'saving…' : 'Mark as read'}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------

function TrendChart({ points, baseline }: { points: TrendPoint[]; baseline: Baseline | null }) {
  const baselineLabel = baseline?.label ?? null

  // Find x index of baseline point for reference line
  const baselineIdx = baselineLabel
    ? points.findIndex(p => p.label === baselineLabel)
    : -1

  const chartData = points.map(p => ({
    ...p,
    label: p.label.length > 12 ? p.label.slice(-10) : p.label,
    avg_coupling_pct: p.avg_coupling,
  }))

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 10, padding: 20, marginTop: 20, marginBottom: 24,
    }}>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
        Fan-in/out and coupling % over time
        {baseline && (
          <span style={{ marginLeft: 12, color: 'var(--accent)', fontSize: 11 }}>
            — baseline: {baseline.label}
          </span>
        )}
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2e3250" />
          <XAxis dataKey="label" tick={{ fill: '#8892aa', fontSize: 10 }} />
          <YAxis tick={{ fill: '#8892aa', fontSize: 11 }} />
          <Tooltip
            contentStyle={{ background: '#1a1d27', border: '1px solid #2e3250', borderRadius: 6 }}
            labelStyle={{ color: '#e2e8f0' }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {baselineIdx >= 0 && (
            <ReferenceLine
              x={chartData[baselineIdx]?.label}
              stroke="var(--accent)"
              strokeDasharray="4 2"
              label={{ value: 'baseline', fill: 'var(--accent)', fontSize: 10 }}
            />
          )}
          <Line type="monotone" dataKey="avg_fan_out" name="avg fan-out" stroke="#6366f1" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="avg_fan_in"  name="avg fan-in"  stroke="#34d399" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="avg_coupling_pct" name="coupling %" stroke="#fbbf24" strokeWidth={2} dot={false} />
          {chartData[0]?.violation_count !== null && (
            <Line type="monotone" dataKey="violation_count" name="violations" stroke="#f87171" strokeWidth={1.5} strokeDasharray="4 2" dot={false} />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Current snapshot stats
// ---------------------------------------------------------------------------

function CurrentStats({ point, baseline }: { point: TrendPoint; baseline: Baseline | null }) {
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 10, padding: 20,
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 12, color: 'var(--text-muted)' }}>
        Current (workdir)
        {baseline && (
          <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--accent)' }}>
            baseline: {baseline.label}
          </span>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 16 }}>
        <Metric label="Files"        value={point.file_count} />
        <Metric label="Import edges" value={point.edge_count} />
        <Metric label="Avg fan-in"   value={point.avg_fan_in} />
        <Metric label="Avg fan-out"  value={point.avg_fan_out} />
        <Metric label="Avg coupling" value={`${point.avg_coupling}%`} />
        {point.violation_count !== null && (
          <Metric
            label="Violations"
            value={point.violation_count}
            color={point.violation_count > 0 ? 'var(--error)' : 'var(--ok)'}
          />
        )}
      </div>
    </div>
  )
}

function Metric({ label, value, color = 'var(--accent)' }: { label: string; value: number | string; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{label}</span>
      <span style={{ fontSize: 20, fontWeight: 700, color }}>{value}</span>
    </div>
  )
}

function Placeholder({ msg }: { msg: string }) {
  return <div style={{ color: 'var(--text-muted)', padding: '20px 0' }}>{msg}</div>
}

function EmptyTrends() {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 12,
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
      padding: 20, marginTop: 20, marginBottom: 24, color: 'var(--text-muted)', fontSize: 13,
    }}>
      <Info size={16} style={{ flexShrink: 0, marginTop: 2 }} />
      <div>
        <strong style={{ color: 'var(--text)' }}>No historical snapshots yet.</strong>
        <br />
        Run{' '}
        <code style={{ background: 'var(--surface2)', padding: '1px 4px', borderRadius: 3 }}>
          affini scan --snapshot &lt;label&gt;
        </code>{' '}
        after meaningful changes to build the erosion timeline.
      </div>
    </div>
  )
}
