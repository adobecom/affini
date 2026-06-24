import { useState } from 'react'
import { GitBranch, Network, AlertTriangle, TrendingUp, GitCompare, Copy } from 'lucide-react'
import GraphView from './views/GraphView'
import ScorecardView from './views/ScorecardView'
import TrendsView from './views/TrendsView'
import DiffView from './views/DiffView'
import DupesView from './views/DupesView'

type Tab = 'graph' | 'scorecard' | 'diff' | 'trends' | 'dupes'

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'graph',     label: 'Module Graph', icon: <Network size={14} /> },
  { id: 'scorecard', label: 'Scorecard',    icon: <AlertTriangle size={14} /> },
  { id: 'diff',      label: 'Diff',         icon: <GitCompare size={14} /> },
  { id: 'trends',    label: 'Trends',       icon: <TrendingUp size={14} /> },
  { id: 'dupes',     label: 'Dupes',        icon: <Copy size={14} /> },
]

export default function App() {
  const [tab, setTab] = useState<Tab>('graph')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <Header />
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
        {tab === 'graph'     && <GraphView />}
        {tab === 'scorecard' && <ScorecardView />}
        {tab === 'diff'      && <DiffView />}
        {tab === 'trends'    && <TrendsView />}
        {tab === 'dupes'     && <DupesView />}
      </main>
    </div>
  )
}

function Header() {
  return (
    <header style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '12px 20px',
      background: 'var(--surface)', borderBottom: '1px solid var(--border)',
    }}>
      <GitBranch size={18} color="var(--accent)" />
      <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: '-0.02em' }}>affini</span>
      <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 4 }}>
        architectural drift instrument
      </span>
    </header>
  )
}
