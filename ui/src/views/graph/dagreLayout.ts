/**
 * Dagre-based ranked layout for the module / group graph.
 * Uses rankdir:'BT' so core (stable) nodes settle at the bottom and UI at the top —
 * matching the existing layer-band convention in ForceGraph.
 */
import { graphlib, layout } from '@dagrejs/dagre'
import { NODE_H } from './edgePath'

export interface RankedPos {
  x: number
  y: number
}

export interface RankedLayoutResult {
  positions: Map<number, RankedPos>
  width: number
  height: number
}

/**
 * Compute a bottom-to-top (BT) dagre layout for a flat list of nodes/edges.
 *
 * @param nodes       Nodes to lay out; `layer` is stored for potential future rank constraints.
 * @param edges       Directed edges; self-loops are dropped (dagre doesn't support them).
 * @param _layerOrder Available for rank-constraint use; unused in v1.
 */
export function computeRankedLayout(
  nodes: Array<{ id: number; width: number; layer?: string }>,
  edges: Array<{ fromId: number; toId: number }>,
  _layerOrder: string[],
): RankedLayoutResult {
  if (nodes.length === 0) {
    return { positions: new Map(), width: 200, height: 200 }
  }

  const g = new graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({
    rankdir: 'BT',
    ranksep: 90,
    nodesep: 50,
    marginx: 60,
    marginy: 60,
  })

  for (const n of nodes) {
    g.setNode(String(n.id), { width: n.width, height: NODE_H })
  }

  const nodeSet = new Set(nodes.map(n => n.id))
  for (const e of edges) {
    if (e.fromId !== e.toId && nodeSet.has(e.fromId) && nodeSet.has(e.toId)) {
      g.setEdge(String(e.fromId), String(e.toId))
    }
  }

  layout(g)

  const positions = new Map<number, RankedPos>()
  for (const n of nodes) {
    const pos = g.node(String(n.id)) as { x: number; y: number } | undefined
    if (pos) positions.set(n.id, { x: pos.x, y: pos.y })
  }

  const ginfo = g.graph() as { width?: number; height?: number }
  return {
    positions,
    width:  (ginfo.width  ?? 800) + 120,
    height: (ginfo.height ?? 600) + 120,
  }
}
