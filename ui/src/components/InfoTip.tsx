/**
 * Reusable info-icon popover for metric model explanations.
 * Click the ⓘ icon to toggle; dismiss with outside-click or Escape.
 * Opens upward by default; flips downward when too close to the top of the viewport.
 */
import { useEffect, useRef, useState } from 'react'
import { Info } from 'lucide-react'

export interface InfoTipProps {
  title: string
  formula?: string
  children: React.ReactNode
}

const POPOVER_H_ESTIMATE = 160 // conservative estimate of popover height in px

export function InfoTip({ title, formula, children }: InfoTipProps) {
  const [open, setOpen]         = useState(false)
  const [flipped, setFlipped]   = useState(false) // true = opens downward
  const containerRef = useRef<HTMLSpanElement>(null)
  const btnRef       = useRef<HTMLButtonElement>(null)

  // When opening, decide whether to flip based on available space above the button
  function handleToggle(e: React.MouseEvent) {
    e.stopPropagation()
    if (!open && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      setFlipped(rect.top < POPOVER_H_ESTIMATE + 16)
    }
    setOpen(v => !v)
  }

  // Dismiss on outside-click
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  // Dismiss on Escape
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const popoverStyle: React.CSSProperties = flipped
    ? { top: '100%', marginTop: 6, bottom: undefined, marginBottom: undefined }
    : { bottom: '100%', marginBottom: 6, top: undefined, marginTop: undefined }

  const arrowStyle: React.CSSProperties = flipped
    ? {
        position: 'absolute',
        bottom: '100%', left: '50%',
        transform: 'translateX(-50%)',
        width: 0, height: 0,
        borderLeft: '6px solid transparent',
        borderRight: '6px solid transparent',
        borderBottom: '6px solid var(--border, #333)',
      }
    : {
        position: 'absolute',
        top: '100%', left: '50%',
        transform: 'translateX(-50%)',
        width: 0, height: 0,
        borderLeft: '6px solid transparent',
        borderRight: '6px solid transparent',
        borderTop: '6px solid var(--border, #333)',
      }

  return (
    <span ref={containerRef} style={{ position: 'relative', display: 'inline-flex', verticalAlign: 'middle' }}>
      <button
        ref={btnRef}
        onClick={handleToggle}
        title={`How "${title}" is modelled`}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 14, height: 14,
          background: 'transparent',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          color: open ? 'var(--accent, #6366f1)' : 'var(--text-muted, #888)',
          opacity: open ? 1 : 0.7,
          transition: 'color 0.1s, opacity 0.1s',
          marginLeft: 3,
          flexShrink: 0,
        }}
        aria-label={`Info about ${title}`}
      >
        <Info size={12} />
      </button>

      {open && (
        <span
          style={{
            position: 'absolute',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 9999,
            width: 260,
            background: 'var(--surface, #1a1a2e)',
            border: '1px solid var(--border, #333)',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            padding: '10px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            pointerEvents: 'all',
            ...popoverStyle,
          }}
          onClick={e => e.stopPropagation()}
        >
          <span style={arrowStyle} />

          <span style={{
            fontWeight: 700, fontSize: 12,
            color: 'var(--text, #e0e0e0)',
            lineHeight: 1.3,
          }}>
            {title}
          </span>

          {formula && (
            <span style={{
              fontFamily: 'var(--mono, monospace)',
              fontSize: 11,
              color: 'var(--accent, #6366f1)',
              background: 'rgba(99,102,241,0.1)',
              borderRadius: 4,
              padding: '3px 6px',
            }}>
              {formula}
            </span>
          )}

          <span style={{
            fontSize: 12, lineHeight: 1.55,
            color: 'var(--text-muted, #aaa)',
          }}>
            {children}
          </span>
        </span>
      )}
    </span>
  )
}
