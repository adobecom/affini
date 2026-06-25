import type { TypeShape, TypeField } from '../../api'

interface Props {
  shape: TypeShape
  inline?: boolean   // render compactly on one line (for union members, array elem, etc.)
}

export function TypeShapeView({ shape, inline = false }: Props) {
  switch (shape.kind) {
    case 'primitive': {
      const danger = shape.name === 'any' || shape.name === 'unknown'
      return (
        <span style={{
          fontFamily: 'var(--mono)',
          color: danger ? 'var(--error)' : 'var(--accent)',
          fontWeight: danger ? 700 : 400,
        }}>
          {shape.name}
        </span>
      )
    }

    case 'literal':
      return (
        <span style={{ fontFamily: 'var(--mono)', color: 'var(--warning, #fbbf24)' }}>
          {shape.value}
        </span>
      )

    case 'ref':
      return (
        <span style={{
          fontFamily: 'var(--mono)',
          color: shape.external ? 'var(--text-muted)' : 'var(--text)',
          fontStyle: shape.external ? 'italic' : undefined,
        }}>
          {shape.name}
          {shape.args.length > 0 && (
            <>
              {'<'}
              {shape.args.map((a, i) => (
                <span key={i}>
                  {i > 0 && <span style={{ color: 'var(--text-muted)' }}>, </span>}
                  <TypeShapeView shape={a} inline />
                </span>
              ))}
              {'>'}
            </>
          )}
        </span>
      )

    case 'unknown':
      return (
        <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-muted)', fontStyle: 'italic' }}>
          {shape.raw || '…'}
        </span>
      )

    case 'array':
      return (
        <span style={{ fontFamily: 'var(--mono)' }}>
          <TypeShapeView shape={shape.of} inline />
          <span style={{ color: 'var(--text-muted)' }}>[]</span>
        </span>
      )

    case 'tuple':
      return (
        <span style={{ fontFamily: 'var(--mono)' }}>
          <span style={{ color: 'var(--text-muted)' }}>[</span>
          {shape.of.map((s, i) => (
            <span key={i}>
              {i > 0 && <span style={{ color: 'var(--text-muted)' }}>, </span>}
              <TypeShapeView shape={s} inline />
            </span>
          ))}
          <span style={{ color: 'var(--text-muted)' }}>]</span>
        </span>
      )

    case 'union':
      return (
        <span style={{ fontFamily: 'var(--mono)' }}>
          {shape.of.map((s, i) => (
            <span key={i}>
              {i > 0 && <span style={{ color: 'var(--text-muted)' }}> | </span>}
              <TypeShapeView shape={s} inline />
            </span>
          ))}
        </span>
      )

    case 'object':
      if (inline) {
        return (
          <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-muted)' }}>
            {'{ '}
            {shape.fields.map((f, i) => (
              <span key={i}>
                {i > 0 && ', '}
                <FieldInline field={f} />
              </span>
            ))}
            {' }'}
          </span>
        )
      }
      return <ObjectBlock fields={shape.fields} />

    default:
      return <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-muted)' }}>?</span>
  }
}

function FieldInline({ field }: { field: TypeField }) {
  return (
    <>
      <span style={{ color: 'var(--text)' }}>{field.name}</span>
      {field.optional && <span style={{ color: 'var(--warning, #fbbf24)' }}>?</span>}
      <span style={{ color: 'var(--text-muted)' }}>: </span>
      <TypeShapeView shape={field.shape} inline />
    </>
  )
}

function ObjectBlock({ fields }: { fields: TypeField[] }) {
  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 6,
      overflow: 'hidden',
      fontFamily: 'var(--mono)',
      fontSize: 12,
    }}>
      {fields.map((f, i) => (
        <div key={i} style={{
          display: 'flex', alignItems: 'baseline', gap: 4,
          padding: '3px 8px',
          borderBottom: i < fields.length - 1 ? '1px solid var(--border)' : undefined,
          background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)',
        }}>
          <span style={{ color: 'var(--text)', flexShrink: 0 }}>{f.name}</span>
          {f.optional && (
            <span style={{ color: 'var(--warning, #fbbf24)', flexShrink: 0 }}>?</span>
          )}
          <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>:</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <TypeShapeView shape={f.shape} inline />
          </span>
        </div>
      ))}
      {fields.length === 0 && (
        <div style={{ padding: '3px 8px', color: 'var(--text-muted)' }}>{'{ }'}</div>
      )}
    </div>
  )
}
