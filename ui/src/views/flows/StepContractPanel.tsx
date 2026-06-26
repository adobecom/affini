import type { FlowStep, FragilityFlag } from '../../api'
import { TypeShapeView } from './TypeShapeView'
import { InfoTip } from '../../components/InfoTip'
import { METRIC_HELP } from '../../metricHelp'

interface Props {
  step: FlowStep | null
}

const SOURCE_COLOR: Record<string, string> = {
  Metric: 'var(--error)',
  Type:   'var(--warning, #fbbf24)',
  Churn:  'var(--accent)',
}

function FragilityCard({ flag }: { flag: FragilityFlag }) {
  const color = SOURCE_COLOR[flag.source] ?? 'var(--text-muted)'
  return (
    <div style={{
      border: `1px solid ${color}`,
      borderLeft: `3px solid ${color}`,
      borderRadius: 6,
      padding: '7px 10px',
      marginBottom: 6,
      background: 'rgba(0,0,0,0.15)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
        <span style={{
          fontSize: 10, fontWeight: 700, letterSpacing: '0.05em',
          color, textTransform: 'uppercase',
          display: 'flex', alignItems: 'center',
        }}>
          {flag.source}
          {flag.source === 'Metric' && (
            <InfoTip title={METRIC_HELP.fragility_metric.label}>{METRIC_HELP.fragility_metric.body}</InfoTip>
          )}
          {flag.source === 'Type' && (
            <InfoTip title={METRIC_HELP.fragility_type.label}>{METRIC_HELP.fragility_type.body}</InfoTip>
          )}
          {flag.source === 'Churn' && (
            <InfoTip title={METRIC_HELP.fragility_churn.label}>{METRIC_HELP.fragility_churn.body}</InfoTip>
          )}
        </span>
        <span style={{
          fontSize: 10,
          color: flag.severity === 'Error' ? 'var(--error)' : 'var(--warning, #fbbf24)',
          fontWeight: 600,
        }}>
          {flag.severity}
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>
          {flag.code}
        </span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text)' }}>{flag.message}</div>
    </div>
  )
}

export function StepContractPanel({ step }: Props) {
  if (!step) {
    return (
      <div style={{
        height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-muted)', fontSize: 13,
      }}>
        Select a step to inspect its contract
      </div>
    )
  }

  const callLabel = step.callee_text || step.to.name

  return (
    <div style={{
      height: '100%', overflow: 'auto',
      padding: '14px 16px',
      display: 'flex', flexDirection: 'column', gap: 14,
    }}>
      {/* header */}
      <div>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 2, fontFamily: 'var(--mono)' }}>
          {callLabel}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>
          depth {step.depth}
          {step.recursion && <span style={{ color: 'var(--warning, #fbbf24)', marginLeft: 8 }}>↺ recursive</span>}
          {step.branchy  && <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>⑂ branchy</span>}
        </div>
      </div>

      {/* params */}
      {step.params.length > 0 && (
        <section>
          <SectionLabel>Params</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {step.params.map((p, i) => (
              <div key={i} style={{
                display: 'flex', flexDirection: 'column', gap: 3,
                padding: '6px 8px',
                background: 'rgba(255,255,255,0.03)',
                borderRadius: 5, border: '1px solid var(--border)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                  <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>{p.name}</span>
                  {p.optional && (
                    <span style={{ fontFamily: 'var(--mono)', color: 'var(--warning, #fbbf24)' }}>?</span>
                  )}
                  {step.arg_texts[i] !== undefined && (
                    <span style={{
                      marginLeft: 'auto', fontFamily: 'var(--mono)',
                      color: 'var(--text-muted)', fontSize: 11,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      maxWidth: 120,
                    }}>
                      ← {step.arg_texts[i]}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, paddingLeft: 2 }}>
                  <TypeShapeView shape={p.shape} />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* return */}
      <section>
        <SectionLabel>Returns</SectionLabel>
        <div style={{
          padding: '6px 8px',
          background: 'rgba(255,255,255,0.03)',
          borderRadius: 5, border: '1px solid var(--border)',
          fontSize: 12,
        }}>
          <TypeShapeView shape={step.return_shape} />
        </div>
      </section>

      {/* fragility */}
      {step.fragility.length > 0 && (
        <section>
          <SectionLabel color="var(--error)">
            Fragility ({step.fragility.length})
          </SectionLabel>
          {step.fragility.map((f, i) => <FragilityCard key={i} flag={f} />)}
        </section>
      )}
    </div>
  )
}

function SectionLabel({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
      textTransform: 'uppercase',
      color: color ?? 'var(--text-muted)',
      marginBottom: 6,
    }}>
      {children}
    </div>
  )
}
