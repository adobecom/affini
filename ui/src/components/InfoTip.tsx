/**
 * Reusable info-icon popover for metric model explanations.
 * Click the ⓘ icon to toggle; dismiss with outside-click or Escape.
 * Opens upward by default; flips downward when too close to the top of the viewport.
 *
 * The popover is rendered into a React portal on document.body with position:fixed
 * so it escapes any overflow:hidden / overflowY:auto ancestor (e.g. the DetailPanel
 * overlay and the outer graph container).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Info } from 'lucide-react'

export interface InfoTipProps {
  title: string
  formula?: string
  children: React.ReactNode
}

const POPOVER_W      = 260  // popover width in px
const POPOVER_H_EST  = 160  // conservative height estimate for flip detection
const MARGIN         = 8    // min gap from viewport edge

interface Coords {
  top: number
  left: number        // center of popover in viewport coords (after clamping)
  arrowOffset: number // how far arrow center is from popover center (px)
  flipped: boolean    // true → opens downward
  maxHeight: number   // available vertical space in the chosen direction
}

export function InfoTip({ title, formula, children }: InfoTipProps) {
  const [open, setOpen]       = useState(false)
  const [coords, setCoords]   = useState<Coords | null>(null)
  const containerRef = useRef<HTMLSpanElement>(null)
  const btnRef       = useRef<HTMLButtonElement>(null)
  const popoverRef   = useRef<HTMLSpanElement>(null)

  // Compute (or re-compute) the fixed position from the button's bounding rect.
  const reposition = useCallback(() => {
    if (!btnRef.current) return
    const rect    = btnRef.current.getBoundingClientRect()
    const centerX = rect.left + rect.width / 2

    // Clamp so the popover doesn't overflow the viewport horizontally.
    const half    = POPOVER_W / 2
    const minLeft = half + MARGIN
    const maxLeft = window.innerWidth - half - MARGIN
    const left    = Math.max(minLeft, Math.min(centerX, maxLeft))

    // Arrow correction: keep the arrow pointing at the actual button center.
    const arrowOffset = centerX - left

    // Flip downward when there's not enough room above.
    const flipped = rect.top < POPOVER_H_EST + 16

    // Vertical anchor: open upward from the top of the button, or downward from the bottom.
    const top = flipped ? rect.bottom + 6 : rect.top - 6

    // Cap popover height to the available space in the chosen direction.
    const maxHeight = flipped
      ? window.innerHeight - top - MARGIN
      : top - MARGIN

    setCoords({ top, left, arrowOffset, flipped, maxHeight: Math.max(maxHeight, 80) })
  }, [])

  function handleToggle(e: React.MouseEvent) {
    e.stopPropagation()
    if (!open) {
      reposition()
      setOpen(true)
    } else {
      setOpen(false)
    }
  }

  // Reposition on scroll or resize while open.
  useEffect(() => {
    if (!open) return
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, { capture: true })
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, { capture: true })
    }
  }, [open, reposition])

  // Dismiss on outside-click (the popover is now outside containerRef via portal).
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      const inContainer = containerRef.current?.contains(e.target as Node)
      const inPopover   = popoverRef.current?.contains(e.target as Node)
      if (!inContainer && !inPopover) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  // Dismiss on Escape.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  // --- Arrow styles (border-trick triangle) ---
  function arrowStyle(flipped: boolean, arrowOffset: number): React.CSSProperties {
    return flipped
      ? {
          position: 'absolute',
          bottom: '100%',
          left: `calc(50% + ${arrowOffset}px)`,
          transform: 'translateX(-50%)',
          width: 0, height: 0,
          borderLeft: '6px solid transparent',
          borderRight: '6px solid transparent',
          borderBottom: '6px solid var(--border, #333)',
        }
      : {
          position: 'absolute',
          top: '100%',
          left: `calc(50% + ${arrowOffset}px)`,
          transform: 'translateX(-50%)',
          width: 0, height: 0,
          borderLeft: '6px solid transparent',
          borderRight: '6px solid transparent',
          borderTop: '6px solid var(--border, #333)',
        }
  }

  const popover = open && coords
    ? createPortal(
        <span
          ref={popoverRef}
          style={{
            position:  'fixed',
            left:      coords.left,
            top:       coords.top,
            transform: coords.flipped ? 'translateX(-50%)' : 'translate(-50%, -100%)',
            zIndex:    9999,
            width:     POPOVER_W,
            background:   'var(--surface, #1a1a2e)',
            border:       '1px solid var(--border, #333)',
            borderRadius: 8,
            boxShadow:    '0 8px 24px rgba(0,0,0,0.5)',
            padding:      '10px 12px',
            display:      'flex',
            flexDirection:'column',
            gap:           6,
            pointerEvents:'all',
            maxHeight:     coords.maxHeight,
            overflowY:    'auto',
          }}
          onClick={e => e.stopPropagation()}
        >
          <span style={arrowStyle(coords.flipped, coords.arrowOffset)} />

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
        </span>,
        document.body,
      )
    : null

  return (
    <>
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
      </span>
      {popover}
    </>
  )
}
