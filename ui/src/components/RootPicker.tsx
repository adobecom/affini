/**
 * In-app directory browser modal.
 * Uses /api/fs/list to browse the server filesystem (sandboxed to the parent of the
 * launch directory), and /api/root (POST) to switch the scanned project.
 */
import { useCallback, useEffect, useState } from 'react'
import { fetchFsList, postRoot, type FsListing, type FsEntry } from '../api'
import { X, Folder, FolderOpen, ChevronRight, AlertCircle, Loader } from 'lucide-react'

export interface RootPickerProps {
  open: boolean
  onClose: () => void
  onConfirm: (newRoot: string) => void
}

export function RootPicker({ open, onClose, onConfirm }: RootPickerProps) {
  const [listing, setListing]   = useState<FsListing | null>(null)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  const navigate = useCallback((path?: string) => {
    setLoading(true)
    setError(null)
    fetchFsList(path)
      .then(l => { setListing(l); setSelectedPath(l.cwd) })
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])

  // Fetch listing on open
  useEffect(() => {
    if (open) navigate()
  }, [open, navigate])

  const handleOpen = useCallback(async () => {
    if (!selectedPath) return
    setApplying(true)
    setError(null)
    try {
      const res = await postRoot(selectedPath)
      onConfirm(res.root)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setApplying(false)
    }
  }, [selectedPath, onConfirm])

  if (!open) return null

  const dirs = listing?.entries.filter(e => e.is_dir) ?? []

  return (
    // Backdrop
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        width: 520,
        maxHeight: '70vh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '14px 16px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}>
          <FolderOpen size={15} color="var(--accent)" />
          <span style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>Change project folder</span>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Breadcrumb + current path */}
        <div style={{
          padding: '8px 16px',
          borderBottom: '1px solid var(--border)',
          fontSize: 11,
          color: 'var(--text-muted)',
          fontFamily: 'var(--mono)',
          display: 'flex', alignItems: 'center', gap: 6,
          flexShrink: 0,
          background: 'var(--surface2, rgba(255,255,255,0.03))',
          flexWrap: 'wrap',
          minHeight: 34,
        }}>
          {listing ? (
            <>
              {listing.parent !== null && (
                <button
                  onClick={() => navigate(listing.parent ?? undefined)}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--accent)', fontFamily: 'var(--mono)', fontSize: 11, padding: '0 2px',
                  }}
                  title="Go up"
                >
                  ..
                </button>
              )}
              {listing.parent !== null && <ChevronRight size={10} />}
              <span style={{ color: 'var(--text)' }}>
                {listing.cwd.split('/').pop() || listing.cwd}
              </span>
              <span style={{ marginLeft: 4, opacity: 0.5, fontSize: 10, wordBreak: 'break-all' }}>
                {listing.cwd}
              </span>
            </>
          ) : (
            <span style={{ opacity: 0.5 }}>—</span>
          )}
        </div>

        {/* Directory listing */}
        <div style={{ flex: 1, overflow: 'auto', padding: '4px 8px' }}>
          {loading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 20, color: 'var(--text-muted)', fontSize: 13 }}>
              <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} />
              Loading…
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          )}

          {!loading && dirs.length === 0 && !error && (
            <div style={{ padding: 20, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
              No subdirectories
            </div>
          )}

          {!loading && dirs.map(entry => (
            <DirRow
              key={entry.path}
              entry={entry}
              selected={selectedPath === entry.path}
              onSelect={() => setSelectedPath(entry.path)}
              onNavigate={() => navigate(entry.path)}
            />
          ))}
        </div>

        {/* Error */}
        {error && (
          <div style={{
            padding: '8px 16px',
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 12, color: 'var(--error)',
            borderTop: '1px solid var(--border)',
            background: 'rgba(248,113,113,0.07)',
            flexShrink: 0,
          }}>
            <AlertCircle size={14} />
            {error}
          </div>
        )}

        {/* Footer */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '12px 16px',
          borderTop: '1px solid var(--border)',
          flexShrink: 0,
        }}>
          <span style={{ flex: 1, fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--mono)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selectedPath ?? '—'}
          </span>
          <button
            onClick={onClose}
            style={{
              padding: '6px 14px', borderRadius: 6, fontSize: 12,
              background: 'transparent', border: '1px solid var(--border)',
              color: 'var(--text-muted)', cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleOpen}
            disabled={!selectedPath || applying}
            style={{
              padding: '6px 16px', borderRadius: 6, fontSize: 12,
              background: !selectedPath || applying ? 'rgba(99,102,241,0.3)' : 'var(--accent)',
              border: 'none',
              color: '#fff',
              cursor: !selectedPath || applying ? 'not-allowed' : 'pointer',
              opacity: !selectedPath || applying ? 0.6 : 1,
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            {applying && <Loader size={12} style={{ animation: 'spin 1s linear infinite' }} />}
            Open folder
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── single row ───────────────────────────────────────────────────────────────

function DirRow({
  entry, selected, onSelect, onNavigate,
}: {
  entry: FsEntry
  selected: boolean
  onSelect: () => void
  onNavigate: () => void
}) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 8px', borderRadius: 6,
        cursor: 'pointer',
        background: selected ? 'rgba(99,102,241,0.15)' : 'transparent',
        boxShadow: selected ? '0 0 0 1px var(--accent)' : undefined,
        transition: 'background 0.1s',
        userSelect: 'none',
      }}
      onClick={onSelect}
      onDoubleClick={onNavigate}
    >
      <Folder size={14} color={selected ? 'var(--accent)' : 'var(--text-muted)'} />
      <span style={{
        flex: 1, fontSize: 13, fontFamily: 'var(--mono)',
        color: selected ? 'var(--text)' : 'var(--text-muted)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {entry.name}
      </span>
      {entry.has_affini && (
        <span style={{
          fontSize: 10, padding: '1px 6px', borderRadius: 4,
          background: 'rgba(52,211,153,0.15)',
          border: '1px solid rgba(52,211,153,0.4)',
          color: '#34d399',
          flexShrink: 0,
        }}>
          affini.toml
        </span>
      )}
      {/* Navigate arrow (single click selects, double click navigates — this button navigates on single click) */}
      <button
        onClick={e => { e.stopPropagation(); onNavigate() }}
        title="Open folder"
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--text-muted)', padding: '0 2px', flexShrink: 0,
          display: 'flex', alignItems: 'center',
          opacity: 0.6,
        }}
      >
        <ChevronRight size={13} />
      </button>
    </div>
  )
}
