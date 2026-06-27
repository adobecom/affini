import { useEffect, useState } from 'react'
import { fetchViolations, type Violation } from '../api'
import { AlertTriangle, XCircle, CheckCircle, Loader } from 'lucide-react'
import { InfoTip } from '../components/InfoTip'
import { METRIC_HELP } from '../metricHelp'

export default function ScorecardView() {
  const [violations, setViolations] = useState<Violation[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchViolations()
      .then(setViolations)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <Status icon={<Loader size={16} />} msg="checking…" />
  if (error) return <Status icon={<AlertTriangle size={16} color="var(--warning)" />} msg={error} />

  const errors = violations!.filter(v => v.severity === 'Error')
  const warnings = violations!.filter(v => v.severity === 'Warning')

  return (
    <div style={{ padding: 24, overflow: 'auto', height: '100%' }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Conformance Scorecard</h2>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 24, display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
        {'Violations of declared intent in'} <code style={{ background: 'var(--surface2)', padding: '1px 4px', borderRadius: 3 }}>affini.toml</code>
        <InfoTip title={METRIC_HELP.violations.label}>{METRIC_HELP.violations.body}</InfoTip>
      </p>

      {violations!.length === 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--ok)', fontWeight: 600 }}>
          <CheckCircle size={20} />
          Design intent is intact — no violations detected.
        </div>
      ) : (
        <>
          <SummaryBar errors={errors.length} warnings={warnings.length} total={violations!.length} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 20 }}>
            {errors.map((v, i) => <ViolationCard key={i} v={v} />)}
            {warnings.map((v, i) => <ViolationCard key={`w${i}`} v={v} />)}
          </div>
        </>
      )}
    </div>
  )
}

function SummaryBar({ errors, warnings, total }: { errors: number; warnings: number; total: number }) {
  return (
    <div style={{
      display: 'flex', gap: 16,
      padding: '12px 16px',
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
    }}>
      <Stat label="Total" value={total} color="var(--text)" />
      <Stat label="Errors" value={errors} color="var(--error)" />
      <Stat label="Warnings" value={warnings} color="var(--warning)" />
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 60 }}>
      <span style={{ fontSize: 22, fontWeight: 700, color }}>{value}</span>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</span>
    </div>
  )
}

function ViolationCard({ v }: { v: Violation }) {
  const isError = v.severity === 'Error'
  return (
    <div style={{
      background: 'var(--surface)', border: `1px solid ${isError ? 'var(--error)' : 'var(--warning)'}22`,
      borderRadius: 8, padding: '12px 16px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        {isError
          ? <XCircle size={14} color="var(--error)" />
          : <AlertTriangle size={14} color="var(--warning)" />}
        <span style={{ fontWeight: 600, fontSize: 13 }}>{v.message}</span>
      </div>
      <PathRow label="From" path={v.from_path} />
      <PathRow label="To" path={v.to_path} />
      <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 4 }}>rule: {v.rule}</div>
    </div>
  )
}

function PathRow({ label, path }: { label: string; path: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 12, marginBottom: 2 }}>
      <span style={{ color: 'var(--text-muted)', width: 32, flexShrink: 0 }}>{label}</span>
      <code style={{ color: 'var(--accent)', fontSize: 11 }}>{path}</code>
    </div>
  )
}

function Status({ icon, msg }: { icon: React.ReactNode; msg: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 24, color: 'var(--text-muted)' }}>
      {icon} {msg}
    </div>
  )
}
