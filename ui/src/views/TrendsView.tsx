import { useEffect, useState } from 'react'
import { fetchModel, fetchSnapshots, type Model } from '../api'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { Info } from 'lucide-react'

interface MetricPoint {
  label: string
  avgFanIn: number
  avgFanOut: number
  avgCoupling: number
  edgeCount: number
  fileCount: number
}

function modelToPoint(label: string, m: Model): MetricPoint {
  const vals = Object.values(m.metrics)
  const avg = (fn: (v: { fan_in: number; fan_out: number; coupling: number }) => number) =>
    vals.length ? vals.reduce((s, v) => s + fn(v), 0) / vals.length : 0

  return {
    label,
    avgFanIn: +avg(v => v.fan_in).toFixed(2),
    avgFanOut: +avg(v => v.fan_out).toFixed(2),
    avgCoupling: +avg(v => v.coupling * 100).toFixed(2),
    edgeCount: m.edges.length,
    fileCount: m.modules.length,
  }
}

export default function TrendsView() {
  const [points, setPoints] = useState<MetricPoint[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchSnapshots().then(async _snaps => {
      // Current workdir model as the latest point
      const current = await fetchModel()
      const pts: MetricPoint[] = [modelToPoint('workdir', current)]
      setPoints(pts)
    }).catch(console.error).finally(() => setLoading(false))
  }, [])

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto' }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Erosion Trends</h2>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 24 }}>
        Coupling/cohesion metrics across saved snapshots. Save more snapshots with{' '}
        <code style={{ background: 'var(--surface2)', padding: '1px 4px', borderRadius: 3 }}>
          affini scan --snapshot &lt;label&gt;
        </code>
      </p>

      {loading ? (
        <div style={{ color: 'var(--text-muted)' }}>loading…</div>
      ) : points.length <= 1 ? (
        <EmptyTrends />
      ) : (
        <TrendChart points={points} />
      )}

      {!loading && (
        <CurrentStats point={points[0]} />
      )}
    </div>
  )
}

function TrendChart({ points }: { points: MetricPoint[] }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 20, marginBottom: 24 }}>
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={points}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2e3250" />
          <XAxis dataKey="label" tick={{ fill: '#8892aa', fontSize: 11 }} />
          <YAxis tick={{ fill: '#8892aa', fontSize: 11 }} />
          <Tooltip
            contentStyle={{ background: '#1a1d27', border: '1px solid #2e3250', borderRadius: 6 }}
            labelStyle={{ color: '#e2e8f0' }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line type="monotone" dataKey="avgFanOut" name="avg fan-out" stroke="#6366f1" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="avgFanIn" name="avg fan-in" stroke="#34d399" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="avgCoupling" name="coupling %" stroke="#fbbf24" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function CurrentStats({ point }: { point: MetricPoint }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 20 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: 'var(--text-muted)' }}>
        Current snapshot (workdir)
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 16 }}>
        <Metric label="Files" value={point.fileCount} />
        <Metric label="Import edges" value={point.edgeCount} />
        <Metric label="Avg fan-in" value={point.avgFanIn} />
        <Metric label="Avg fan-out" value={point.avgFanOut} />
        <Metric label="Avg coupling" value={`${point.avgCoupling}%`} />
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{label}</span>
      <span style={{ fontSize: 20, fontWeight: 700, color: 'var(--accent)' }}>{value}</span>
    </div>
  )
}

function EmptyTrends() {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 12,
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
      padding: 20, marginBottom: 24, color: 'var(--text-muted)', fontSize: 13,
    }}>
      <Info size={16} style={{ flexShrink: 0, marginTop: 1 }} />
      <div>
        <strong style={{ color: 'var(--text)' }}>No historical snapshots yet.</strong>
        <br />
        Run <code style={{ background: 'var(--surface2)', padding: '1px 4px', borderRadius: 3 }}>
          affini scan --snapshot &lt;commit-sha-or-label&gt;
        </code> after each meaningful change to build the erosion timeline.
      </div>
    </div>
  )
}
