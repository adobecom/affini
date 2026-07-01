import { useEffect, useState } from 'react'
import { GitBranch, Network, AlertTriangle, TrendingUp, GitCompare, Copy, Workflow, FolderOpen } from 'lucide-react'
import { fetchModel } from './api'
import { RootPicker } from './components/RootPicker'
import GraphView from './views/GraphView'
import ScorecardView from './views/ScorecardView'
import TrendsView from './views/TrendsView'
import DiffView from './views/DiffView'
import DupesView from './views/DupesView'
import FlowsView from './views/FlowsView'

type Tab = 'graph' | 'scorecard' | 'diff' | 'trends' | 'dupes' | 'flows'

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'graph',     label: 'Module Graph',   icon: <Network size={14} /> },
  { id: 'scorecard', label: 'Scorecard',      icon: <AlertTriangle size={14} /> },
  { id: 'diff',      label: 'Diff',           icon: <GitCompare size={14} /> },
  { id: 'trends',    label: 'Trends',         icon: <TrendingUp size={14} /> },
  { id: 'dupes',     label: 'Dupes',          icon: <Copy size={14} /> },
  { id: 'flows',     label: 'Feature Flows',  icon: <Workflow size={14} /> },
]

export default function App() {
  const [tab, setTab] = useState<Tab>('graph')

  // Current project root path (for header display)
  const [currentRoot, setCurrentRoot] = useState<string>('')

  // Version counter — bumped on root change to remount all views and re-run their fetches
  const [rootVersion, setRootVersion] = useState(0)

  // RootPicker modal visibility
  const [showPicker, setShowPicker] = useState(false)

  // Fetch the initial root from the model response
  useEffect(() => {
    fetchModel().then(m => setCurrentRoot(m.root)).catch(() => {})
  }, [])

  function handleRootConfirm(newRoot: string) {
    setCurrentRoot(newRoot)
    setRootVersion(v => v + 1)
    setShowPicker(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <Header
        root={currentRoot}
        onChangeFolder={() => setShowPicker(true)}
      />
      <nav style={{
        display: 'flex', gap: 2, padding: '0 20px',
        borderBottom: '1px solid var(--border)', background: 'var(--surface)',
      }}>
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '10px 14px',
              background: 'none', border: 'none',
              color: tab === t.id ? 'var(--accent)' : 'var(--text-muted)',
              borderBottom: tab === t.id ? '2px solid var(--accent)' : '2px solid transparent',
              cursor: 'pointer', fontSize: 13, fontFamily: 'inherit',
              marginBottom: -1,
            }}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </nav>
      <main style={{ flex: 1, overflow: 'hidden' }}>
        {/* key={rootVersion} forces the active view to remount when root changes */}
        {tab === 'graph'     && <GraphView     key={rootVersion} />}
        {tab === 'scorecard' && <ScorecardView key={rootVersion} />}
        {tab === 'diff'      && <DiffView      key={rootVersion} />}
        {tab === 'trends'    && <TrendsView    key={rootVersion} />}
        {tab === 'dupes'     && <DupesView     key={rootVersion} />}
        {tab === 'flows'     && <FlowsView     key={rootVersion} />}
      </main>

      <RootPicker
        open={showPicker}
        onClose={() => setShowPicker(false)}
        onConfirm={handleRootConfirm}
      />
    </div>
  )
}

// ─── header ───────────────────────────────────────────────────────────────────

function Header({ root, onChangeFolder }: { root: string; onChangeFolder: () => void }) {
  // Show just the last two path segments for brevity
  const displayRoot = root
    ? root.split('/').filter(Boolean).slice(-2).join('/') || root
    : ''

  return (
    <header style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 20px',
      background: 'var(--surface)', borderBottom: '1px solid var(--border)',
    }}>
      <GitBranch size={18} color="var(--accent)" />
      <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: '-0.02em' }}>affini</span>
      <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 4 }}>
        architectural drift instrument
      </span>

      {displayRoot && (
        <>
          <span style={{ color: 'var(--border)', margin: '0 6px' }}>·</span>
          <span
            title={root}
            style={{
              color: 'var(--text-muted)', fontSize: 11,
              fontFamily: 'var(--mono)',
              maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            {displayRoot}
          </span>
        </>
      )}

      <div style={{ marginLeft: 'auto' }}>
        <button
          onClick={onChangeFolder}
          title="Switch project folder"
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '5px 12px', borderRadius: 6, fontSize: 12,
            background: 'transparent',
            border: '1px solid var(--border)',
            color: 'var(--text-muted)', cursor: 'pointer',
            fontFamily: 'inherit',
            transition: 'color 0.1s, border-color 0.1s',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--accent)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--accent)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)' }}
        >
          <FolderOpen size={13} />
          Change folder…
        </button>
      </div>
    </header>
  )
}
