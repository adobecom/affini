/**
 * Presentational scrubber strip — pure step list with click-to-seek.
 * Auto-advance timer lives in FlowsView (single source of truth).
 */
import type { Flow, FlowStep } from '../../api'

interface Props {
  flow: Flow
  stepIndex: number
  compact?: boolean
  onStepChange: (index: number) => void
}

export function FlowTimeline({ flow, stepIndex, compact, onStepChange }: Props) {
  const steps = flow.steps
  const pad   = compact ? '6px 10px' : '10px 14px'

  if (steps.length === 0) {
    return (
      <div style={{
        height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-muted)', fontSize: 13,
      }}>
        No steps recorded
      </div>
    )
  }

  return (
    <div style={{
      height: '100%', overflow: 'auto',
      padding: pad,
    }}>
      {steps.map((step, i) => (
        <StepRow
          key={i}
          step={step}
          index={i}
          active={i === stepIndex}
          past={i < stepIndex}
          compact={compact}
          onClick={() => onStepChange(i)}
        />
      ))}
      {flow.truncated && (
        <div style={{
          fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic',
          padding: '8px 12px', textAlign: 'center',
        }}>
          Flow truncated at {steps.length} steps (MAX_STEPS limit)
        </div>
      )}
    </div>
  )
}

interface RowProps {
  step: FlowStep
  index: number
  active: boolean
  past: boolean
  compact?: boolean
  onClick: () => void
}

function StepRow({ step, index, active, past, compact, onClick }: RowProps) {
  const indent = step.depth * (compact ? 12 : 18)
  const errorCount   = step.fragility.filter(f => f.severity === 'Error').length
  const warningCount = step.fragility.filter(f => f.severity === 'Warning').length

  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        marginBottom: compact ? 2 : 3,
        padding: compact ? '4px 6px' : '6px 8px',
        paddingLeft: (compact ? 6 : 8) + indent,
        borderRadius: 6,
        cursor: 'pointer',
        transition: 'background 0.15s, box-shadow 0.15s',
        background: active
          ? 'rgba(99,102,241,0.15)'
          : past
            ? 'rgba(255,255,255,0.025)'
            : 'transparent',
        boxShadow: active ? '0 0 0 1px var(--accent)' : undefined,
        opacity: past && !active ? 0.7 : 1,
      }}
    >
      {/* depth rail */}
      {step.depth > 0 && (
        <div style={{
          position: 'absolute',
          left: (compact ? 6 : 8) + (step.depth - 1) * (compact ? 12 : 18) + 9,
          width: 1,
          height: 22,
          background: active ? 'var(--accent)' : 'var(--border)',
          pointerEvents: 'none',
          marginTop: -3,
        }} />
      )}

      {/* index badge */}
      <span style={{
        fontSize: 10, fontFamily: 'var(--mono)',
        color: active ? 'var(--accent)' : 'var(--text-muted)',
        minWidth: 18, textAlign: 'right', flexShrink: 0,
      }}>
        {index + 1}
      </span>

      {/* labels */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap',
          fontSize: compact ? 11 : 12, fontFamily: 'var(--mono)',
        }}>
          <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>
            {step.from.name}
          </span>
          <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>→</span>
          <span style={{
            color: active ? 'var(--text)' : 'var(--text-muted)',
            fontWeight: active ? 600 : 400,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {step.callee_text || step.to.name}
          </span>
        </div>
      </div>

      {/* badges */}
      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
        {step.recursion && <Badge label="↺" color="var(--warning, #fbbf24)" title="Recursive call" />}
        {step.branchy   && <Badge label="⑂" color="var(--text-muted)"       title="Inside branch/loop" />}
        {errorCount   > 0 && <Badge label={String(errorCount)}   color="var(--error)"             title={`${errorCount} error flag(s)`} />}
        {warningCount > 0 && <Badge label={String(warningCount)} color="var(--warning, #fbbf24)"  title={`${warningCount} warning(s)`} />}
      </div>
    </div>
  )
}

function Badge({ label, color, title }: { label: string; color: string; title?: string }) {
  return (
    <span
      title={title}
      style={{
        fontSize: 10, fontWeight: 700,
        color, border: `1px solid ${color}`,
        borderRadius: 4, padding: '1px 4px',
        lineHeight: 1.4,
      }}
    >
      {label}
    </span>
  )
}
