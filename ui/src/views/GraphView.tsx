import { useEffect, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge as FlowEdge,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { fetchModel, type Model } from '../api'
import { Loader, AlertCircle } from 'lucide-react'

function modelToFlow(model: Model): { nodes: Node[]; edges: FlowEdge[] } {
  const COLS = Math.ceil(Math.sqrt(model.modules.length))
  const GAP_X = 220
  const GAP_Y = 90

  const nodes: Node[] = model.modules.map((m, i) => {
    const metrics = model.metrics[m.id] ?? { fan_in: 0, fan_out: 0, coupling: 0 }
    // Colour by fan-in (high fan-in = hot = more architectural weight)
    const intensity = Math.min(1, metrics.fan_in / 10)
    const r = Math.round(99 + intensity * 149)
    const g = Math.round(102 + (1 - intensity) * 80)
    const b = Math.round(241 - intensity * 180)

    return {
      id: String(m.id),
      position: { x: (i % COLS) * GAP_X, y: Math.floor(i / COLS) * GAP_Y },
      data: {
        label: (
          <div style={{ fontSize: 11, lineHeight: 1.3 }}>
            <div style={{ fontWeight: 600, wordBreak: 'break-all' }}>
              {m.path.split('/').pop()}
            </div>
            <div style={{ color: '#8892aa', fontSize: 10 }}>
              {m.path.includes('/') ? m.path.substring(0, m.path.lastIndexOf('/')) : ''}
            </div>
            <div style={{ color: '#8892aa', fontSize: 10, marginTop: 2 }}>
              in:{metrics.fan_in} out:{metrics.fan_out}
            </div>
          </div>
        ),
      },
      style: {
        background: `rgba(${r},${g},${b},0.12)`,
        border: `1px solid rgba(${r},${g},${b},0.5)`,
        borderRadius: 8,
        color: '#e2e8f0',
        padding: '8px 10px',
        minWidth: 140,
        fontSize: 12,
      },
    }
  })

  const edges: FlowEdge[] = model.edges.map((e, i) => ({
    id: `e${i}`,
    source: String(e.from),
    target: String(e.to),
    style: {
      stroke: e.kind === 'Reexports' ? '#fbbf24' : '#4338ca',
      strokeWidth: 1.5,
    },
    animated: e.kind === 'Reexports',
  }))

  return { nodes, edges }
}

export default function GraphView() {
  const [model, setModel] = useState<Model | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([])

  useEffect(() => {
    fetchModel()
      .then(m => {
        setModel(m)
        const { nodes, edges } = modelToFlow(m)
        setNodes(nodes)
        setEdges(edges)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <Spinner />
  if (error) return <ErrorMsg msg={error} />

  return (
    <div style={{ height: '100%', position: 'relative' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#2e3250" gap={20} />
        <Controls />
        <MiniMap
          nodeColor={() => '#4338ca'}
          maskColor="rgba(0,0,0,0.6)"
          style={{ background: '#1a1d27', border: '1px solid #2e3250' }}
        />
      </ReactFlow>
      {model && (
        <div style={{
          position: 'absolute', top: 12, left: 12, zIndex: 10,
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 8, padding: '10px 14px', fontSize: 12,
          color: 'var(--text-muted)',
        }}>
          <strong style={{ color: 'var(--text)' }}>{model.modules.length}</strong> files &nbsp;|&nbsp;
          <strong style={{ color: 'var(--text)' }}>{model.edges.length}</strong> import edges
          <br />
          <span style={{ fontSize: 11 }}>commit: {model.commit}</span>
        </div>
      )}
    </div>
  )
}

function Spinner() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, color: 'var(--text-muted)' }}>
      <Loader size={18} style={{ animation: 'spin 1s linear infinite' }} />
      scanning…
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}

function ErrorMsg({ msg }: { msg: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, color: 'var(--error)' }}>
      <AlertCircle size={18} />
      {msg}
    </div>
  )
}
