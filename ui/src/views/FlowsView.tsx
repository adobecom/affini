import { useEffect, useState, useCallback } from 'react'
import { Play, Pause, SkipForward, SkipBack, RotateCcw, Workflow } from 'lucide-react'
import { fetchFlows, fetchFlow, type FlowSummary, type Flow, type FragilitySummary } from '../api'
import { FlowTimeline } from './flows/FlowTimeline'
import { StepContractPanel } from './flows/StepContractPanel'

// ── helpers ───────────────────────────────────────────────────────────────────

function kindColor(kind: string): string {
  switch (kind) {
    case 'Handler':    return 'var(--accent)'
    case 'Route':      return '#34d399'
    case 'Cli':        return '#fbbf24'
    case 'PublicApi':  return '#a78bfa'
    default:           return 'var(--text-muted)'
  }
}

function FragilityBar({ s }: { s: FragilitySummary }) {
  const pct = s.total_steps > 0 ? Math.round((s.fragile_steps / s.total_steps) * 100) : 0
  const color = s.max_severity === 'Error'   ? 'var(--error)'
              : s.max_severity === 'Warning' ? 'var(--warning, #fbbf24)'
              : 'var(--text-muted)'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
      <div style={{
        width: 48, height: 3, borderRadius: 2,
        background: 'var(--border)',
        overflow: 'hidden',
      }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 2 }} />
      </div>
      <span style={{ color, fontWeight: 600 }}>
        {s.fragile_steps}/{s.total_steps}
      </span>
      {s.metric_flags > 0 && <span style={{ color: 'var(--error)', fontFamily: 'var(--mono)' }}>M:{s.metric_flags}</span>}
      {s.type_flags   > 0 && <span style={{ color: 'var(--warning, #fbbf24)', fontFamily: 'var(--mono)' }}>T:{s.type_flags}</span>}
      {s.churn_flags  > 0 && <span style={{ color: 'var(--accent)', fontFamily: 'var(--mono)' }}>C:{s.churn_flags}</span>}
    </div>
  )
}

// ── main view ─────────────────────────────────────────────────────────────────

export default function FlowsView() {
  const [summaries, setSummaries] = useState<FlowSummary[]>([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState<string | null>(null)

  const [selectedId, setSelectedId]   = useState<string | null>(null)
  const [flow, setFlow]               = useState<Flow | null>(null)
  const [flowLoading, setFlowLoading] = useState(false)

  const [stepIndex, setStepIndex] = useState(0)
  const [playing, setPlaying]     = useState(false)

  // setStepIndex also accepts an updater function (from rAF tick in FlowTimeline)
  const handleStepChange = useCallback((indexOrUpdater: number | ((prev: number) => number)) => {
    setStepIndex(indexOrUpdater as number)
  }, [])

  // load summaries on mount
  useEffect(() => {
    setLoading(true)
    setError(null)
    fetchFlows()
      .then(setSummaries)
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])

  // load full flow when selectedId changes
  useEffect(() => {
    if (!selectedId) return
    setFlowLoading(true)
    setFlow(null)
    setStepIndex(0)
    setPlaying(false)
    fetchFlow(selectedId)
      .then(setFlow)
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setFlowLoading(false))
  }, [selectedId])

  // playback controls
  const canBack    = !!flow && stepIndex > 0
  const canForward = !!flow && stepIndex < flow.steps.length - 1

  function handlePlay()    { setPlaying(p => !p) }
  function handleBack()    { setPlaying(false); setStepIndex(i => Math.max(0, i - 1)) }
  function handleForward() { setPlaying(false); setStepIndex(i => Math.min((flow?.steps.length ?? 1) - 1, i + 1)) }
  function handleReset()   { setPlaying(false); setStepIndex(0) }

  const activeStep = flow?.steps[stepIndex] ?? null

  return (
    <div style={{
      display: 'flex', height: '100%', overflow: 'hidden',
    }}>
      <style>{`
        @keyframes pulse-dot {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.4; }
        }
      `}</style>

      {/* ── Left panel: feature list ──────────────────────────────────────── */}
      <div style={{
        width: 280, flexShrink: 0,
        borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}>
        <div style={{
          padding: '12px 14px 8px',
          borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 7,
        }}>
          <Workflow size={13} color="var(--accent)" />
          <span style={{ fontWeight: 600, fontSize: 13 }}>Feature Flows</span>
          {!loading && (
            <span style={{
              marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)',
              fontFamily: 'var(--mono)',
            }}>
              {summaries.length}
            </span>
          )}
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '6px 0' }}>
          {loading && <CenterMsg>Deriving flows…</CenterMsg>}
          {error   && <CenterMsg color="var(--error)">{error}</CenterMsg>}
          {!loading && !error && summaries.length === 0 && (
            <CenterMsg>No flows found — is this a TS/JS repo?</CenterMsg>
          )}
          {summaries.map(s => (
            <div
              key={s.id}
              onClick={() => setSelectedId(s.id)}
              style={{
                padding: '8px 14px',
                cursor: 'pointer',
                background: selectedId === s.id ? 'rgba(99,102,241,0.12)' : 'transparent',
                borderLeft: selectedId === s.id
                  ? '2px solid var(--accent)'
                  : '2px solid transparent',
                transition: 'background 0.1s',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
                <span style={{ fontWeight: 600, fontSize: 12, flex: 1, overflow: 'hidden',
                  textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.name}
                </span>
                <span style={{
                  fontSize: 10, fontWeight: 600,
                  color: kindColor(s.kind),
                  background: 'rgba(0,0,0,0.2)',
                  padding: '1px 5px', borderRadius: 4,
                  flexShrink: 0,
                }}>
                  {s.kind}
                </span>
              </div>
              <div style={{
                fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--mono)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                marginBottom: 4,
              }}>
                {s.entry_module_path}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {s.step_count} steps
                </span>
                <FragilityBar s={s.fragility_summary} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Center panel: timeline ────────────────────────────────────────── */}
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        overflow: 'hidden', minWidth: 0,
      }}>
        {/* playback bar */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '8px 12px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface)',
        }}>
          {flow && (
            <>
              <span style={{ fontWeight: 600, fontSize: 13, marginRight: 8, flex: 1,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {flow.name}
              </span>
              {playing && (
                <span style={{
                  width: 7, height: 7, borderRadius: '50%',
                  background: 'var(--accent)',
                  display: 'inline-block', marginRight: 4,
                  animation: 'pulse-dot 1s ease-in-out infinite',
                }} />
              )}
              <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--mono)',
                marginRight: 12 }}>
                {stepIndex + 1} / {flow.steps.length}
              </span>
            </>
          )}
          <PlayBtn onClick={handleReset}   title="Reset"   disabled={!flow}><RotateCcw size={13} /></PlayBtn>
          <PlayBtn onClick={handleBack}    title="Back"    disabled={!canBack}><SkipBack size={13} /></PlayBtn>
          <PlayBtn onClick={handlePlay}    title={playing ? 'Pause' : 'Play'} disabled={!flow}
            accent={playing}>
            {playing ? <Pause size={13} /> : <Play size={13} />}
          </PlayBtn>
          <PlayBtn onClick={handleForward} title="Forward" disabled={!canForward}><SkipForward size={13} /></PlayBtn>
        </div>

        {/* timeline body */}
        <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
          {!selectedId && (
            <CenterMsg>Select a feature flow from the list</CenterMsg>
          )}
          {selectedId && flowLoading && (
            <CenterMsg>Loading flow…</CenterMsg>
          )}
          {flow && (
            <FlowTimeline
              flow={flow}
              stepIndex={stepIndex}
              playing={playing}
              onStepChange={handleStepChange}
              onPlayingChange={setPlaying}
            />
          )}
        </div>
      </div>

      {/* ── Right panel: contract ─────────────────────────────────────────── */}
      <div style={{
        width: 300, flexShrink: 0,
        borderLeft: '1px solid var(--border)',
        overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--border)',
          fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
          textTransform: 'uppercase', color: 'var(--text-muted)',
        }}>
          Contract
        </div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <StepContractPanel step={activeStep} />
        </div>
      </div>
    </div>
  )
}

// ── tiny shared primitives ────────────────────────────────────────────────────

function CenterMsg({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <div style={{
      height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24, textAlign: 'center',
      fontSize: 13, color: color ?? 'var(--text-muted)',
    }}>
      {children}
    </div>
  )
}

function PlayBtn({
  children, onClick, title, disabled, accent,
}: {
  children: React.ReactNode
  onClick: () => void
  title?: string
  disabled?: boolean
  accent?: boolean
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 28, borderRadius: 6,
        background: accent ? 'var(--accent)' : 'transparent',
        border: '1px solid var(--border)',
        color: disabled ? 'var(--text-muted)' : accent ? '#fff' : 'var(--text)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        transition: 'background 0.1s',
        padding: 0,
      }}
    >
      {children}
    </button>
  )
}
