import { useEffect, useState, useCallback, useRef } from 'react'
import { fetchDiff, fetchSnapshots, fetchBaseline, postBaseline, type ModelDiff } from '../api'
import { FilePlus, FileMinus, ArrowRight, BookOpen, Loader, AlertCircle, CheckCircle, Info } from 'lucide-react'

export default function DiffView() {
  const [diff, setDiff] = useState<ModelDiff | null>(null)
  const [snapshots, setSnapshots] = useState<string[]>([])
  const [noSnapshotsYet, setNoSnapshotsYet] = useState(false)
  const [from, setFrom] = useState<string>('')
  const [to, setTo] = useState<string>('workdir')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [markingRead, setMarkingRead] = useState(false)
  const [markedReadMsg, setMarkedReadMsg] = useState<string | null>(null)

  // Generation counter — prevents stale fetches from overwriting newer results.
  const genRef = useRef(0)

  const load = useCallback(async (f?: string, t?: string) => {
    const gen = ++genRef.current
    setLoading(true)
    setError(null)
    setDiff(null)
    try {
      const [snaps, bl] = await Promise.all([fetchSnapshots(), fetchBaseline()])
      if (gen !== genRef.current) return

      setSnapshots(snaps)

      if (snaps.length === 0 && !bl) {
        setNoSnapshotsYet(true)
        return
      }
      setNoSnapshotsYet(false)

      const resolvedFrom = f ?? bl?.label ?? snaps[snaps.length - 1] ?? ''
      setFrom(resolvedFrom)

      if (!resolvedFrom) return   // nothing to diff against

      const d = await fetchDiff(resolvedFrom, t ?? 'workdir')
      if (gen !== genRef.current) return
      setDiff(d)
    } catch (e: unknown) {
      if (gen !== genRef.current) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (gen === genRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const markRead = async () => {
    setMarkingRead(true)
    setMarkedReadMsg(null)
    try {
      const result = await postBaseline('workdir') as { label?: string }
      const newLabel = result.label ?? 'workdir'
      setMarkedReadMsg(`Baseline set to ${newLabel}`)
      await load(newLabel, 'workdir')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setMarkingRead(false)
    }
  }

  return (
    <div style={{ padding: 24, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Architectural Diff</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            Structural delta between two points in time.
          </p>
        </div>
        <button
          onClick={markRead}
          disabled={markingRead || noSnapshotsYet}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 14px', borderRadius: 8,
            background: 'var(--accent-dim)', border: 'none',
            color: '#fff', fontSize: 12, fontFamily: 'inherit',
            cursor: (markingRead || noSnapshotsYet) ? 'not-allowed' : 'pointer',
            opacity: (markingRead || noSnapshotsYet) ? 0.6 : 1,
            flexShrink: 0,
          }}
        >
          <BookOpen size={13} />
          {markingRead ? 'saving…' : 'Mark as read'}
        </button>
      </div>

      {/* Controls — only shown when snapshots exist */}
      {!noSnapshotsYet && !loading && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20,
          padding: '12px 16px', background: 'var(--surface)',
          border: '1px solid var(--border)', borderRadius: 8,
        }}>
          <SnapshotPicker
            label="From"
            value={from}
            options={snapshots}
            onChange={v => { setFrom(v); load(v, to) }}
          />
          <ArrowRight size={16} color="var(--text-muted)" />
          <SnapshotPicker
            label="To"
            value={to}
            options={['workdir', ...snapshots]}
            onChange={v => { setTo(v); load(from, v) }}
          />
        </div>
      )}

      {markedReadMsg && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--ok)', fontSize: 13, marginBottom: 16 }}>
          <CheckCircle size={14} /> {markedReadMsg}
        </div>
      )}

      {loading && <Status icon={<Loader size={16} />} msg="loading diff…" />}
      {error   && <Status icon={<AlertCircle size={16} color="var(--error)" />} msg={error} />}

      {noSnapshotsYet && !loading && <NoSnapshotsGuide />}

      {!loading && !error && !noSnapshotsYet && diff && (
        <>
          <SummaryBanner diff={diff} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 20 }}>
            <Section
              title="Files Added"
              icon={<FilePlus size={14} color="var(--ok)" />}
              items={diff.modules_added.map(m => m.path)}
              color="var(--ok)"
              empty="No new files"
            />
            <Section
              title="Files Removed"
              icon={<FileMinus size={14} color="var(--error)" />}
              items={diff.modules_removed.map(m => m.path)}
              color="var(--error)"
              empty="No removed files"
            />
          </div>
          <div style={{ marginTop: 16 }}>
            <EdgeSection title="New Import Edges" edges={diff.edges_added} color="var(--ok)" />
          </div>
          <div style={{ marginTop: 12 }}>
            <EdgeSection title="Removed Import Edges" edges={diff.edges_removed} color="var(--error)" />
          </div>
        </>
      )}

      {!loading && !error && !noSnapshotsYet && !diff && (
        <Status icon={<AlertCircle size={16} color="var(--warning)" />} msg="Diff unavailable." />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function NoSnapshotsGuide() {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 12,
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
      padding: 20, color: 'var(--text-muted)', fontSize: 13,
    }}>
      <Info size={16} style={{ flexShrink: 0, marginTop: 2 }} />
      <div>
        <strong style={{ color: 'var(--text)' }}>No snapshots yet.</strong>
        <br />
        Save one to enable diffing:{' '}
        <code style={{ background: 'var(--surface2)', padding: '1px 4px', borderRadius: 3 }}>
          affini scan --snapshot &lt;label&gt;
        </code>
      </div>
    </div>
  )
}

function SnapshotPicker({
  label, value, options, onChange,
}: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>{label}</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          background: 'var(--surface2)', border: '1px solid var(--border)',
          borderRadius: 6, padding: '4px 8px', color: 'var(--text)',
          fontSize: 12, fontFamily: 'inherit', cursor: 'pointer',
        }}
      >
        {options.map(o => <option key={o} value={o}>{o}</option>)}
        {!options.includes(value) && value && <option value={value}>{value}</option>}
      </select>
    </div>
  )
}

function SummaryBanner({ diff }: { diff: ModelDiff }) {
  return (
    <div style={{
      padding: '12px 16px', background: 'var(--surface)',
      border: '1px solid var(--border)', borderRadius: 8,
      fontSize: 13, color: 'var(--text-muted)',
    }}>
      <span style={{ color: 'var(--text)', fontWeight: 600 }}>{diff.summary}</span>
      <span style={{ marginLeft: 16, fontSize: 11 }}>
        {diff.from_commit} → {diff.to_commit}
      </span>
    </div>
  )
}

function Section({
  title, icon, items, color, empty,
}: { title: string; icon: React.ReactNode; items: string[]; color: string; empty: string }) {
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 16,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, fontWeight: 600, fontSize: 13 }}>
        {icon} {title}
        <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 4 }}>({items.length})</span>
      </div>
      {items.length === 0 ? (
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{empty}</span>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {items.map((p, i) => (
            <li key={i} style={{ fontSize: 11, fontFamily: 'var(--mono)', color }}>
              {p}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function EdgeSection({
  title, edges, color,
}: { title: string; edges: { from: string; to: string; kind: string }[]; color: string }) {
  if (edges.length === 0) return null
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 16,
    }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>
        {title} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({edges.length})</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {edges.map((e, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontFamily: 'var(--mono)' }}>
            <span style={{ color }}>{e.from}</span>
            <ArrowRight size={10} color="var(--text-muted)" />
            <span style={{ color: 'var(--text-muted)' }}>{e.to}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>[{e.kind}]</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Status({ icon, msg }: { icon: React.ReactNode; msg: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-muted)', fontSize: 13 }}>
      {icon} {msg}
    </div>
  )
}
