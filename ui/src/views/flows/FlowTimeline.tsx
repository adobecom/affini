/**
 * Presentational scrubber strip — step list with click-to-seek and collapsible branch groups.
 */
import { useState } from 'react'
import { ChevronRight, ChevronDown } from 'lucide-react'
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

  // Track which branch_group ids are collapsed (keyed as string)
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())

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

  function toggleGroup(groupId: number) {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }

  // Build rendering plan: inject branch-group headers when a new group starts
  type RenderItem =
    | { kind: 'step'; step: FlowStep; index: number }
    | { kind: 'group-header'; groupId: number; count: number; firstIndex: number }

  const items: RenderItem[] = []
  // Track which branch_group ids we've already emitted a header for, so interleaved
  // groups (A, B, A, ...) don't produce duplicate headers.
  const emittedHeaders = new Set<number>()

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const bg = step.branch_group

    // Emit a header on the first encounter of each branch group
    if (bg !== null && !emittedHeaders.has(bg)) {
      emittedHeaders.add(bg)
      const count = steps.filter(s => s.branch_group === bg).length
      items.push({ kind: 'group-header', groupId: bg, count, firstIndex: i })
    }

    // Skip steps in a collapsed group
    if (bg !== null && collapsed.has(bg)) continue

    items.push({ kind: 'step', step, index: i })
  }

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: pad }}>
      {items.map((item) => {
        if (item.kind === 'group-header') {
          const isCollapsed = collapsed.has(item.groupId)
          const hasActive = !isCollapsed
            ? false
            : steps.some((s, i) => s.branch_group === item.groupId && i === stepIndex)
          return (
            <button
              key={`bg-${item.groupId}`}
              onClick={() => toggleGroup(item.groupId)}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                width: '100%', textAlign: 'left',
                background: hasActive ? 'rgba(251,191,36,0.12)' : 'transparent',
                border: 'none',
                borderLeft: `2px solid ${hasActive ? 'var(--warning, #fbbf24)' : 'rgba(251,191,36,0.3)'}`,
                borderRadius: 4,
                padding: compact ? '3px 6px' : '4px 8px',
                marginBottom: 2,
                cursor: 'pointer',
                color: 'var(--warning, #fbbf24)',
                fontSize: compact ? 10 : 11,
                fontFamily: 'inherit',
              }}
            >
              {isCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
              <span>⑂</span>
              <span style={{ flex: 1, textAlign: 'left' }}>
                branch block ({item.count} call{item.count !== 1 ? 's' : ''})
              </span>
              {hasActive && (
                <span style={{ fontSize: 9, opacity: 0.7 }}>▶ active</span>
              )}
            </button>
          )
        }

        const { step, index } = item
        const indent = step.branch_group !== null ? (step.depth + 1) * (compact ? 12 : 18) : step.depth * (compact ? 12 : 18)
        return (
          <StepRow
            key={index}
            step={step}
            index={index}
            active={index === stepIndex}
            past={index < stepIndex}
            compact={compact}
            indent={indent}
            onClick={() => onStepChange(index)}
          />
        )
      })}
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

// ─── step row ─────────────────────────────────────────────────────────────────

interface RowProps {
  step: FlowStep
  index: number
  active: boolean
  past: boolean
  compact?: boolean
  indent: number
  onClick: () => void
}

function StepRow({ step, index, active, past, compact, indent, onClick }: RowProps) {
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
        {step.recursion   && <Badge label="↺" color="var(--warning, #fbbf24)" title="Recursive call" />}
        {errorCount   > 0 && <Badge label={String(errorCount)}   color="var(--error)"            title={`${errorCount} error flag(s)`} />}
        {warningCount > 0 && <Badge label={String(warningCount)} color="var(--warning, #fbbf24)" title={`${warningCount} warning(s)`} />}
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
