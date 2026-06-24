/**
 * Dagre-powered layered layout for the module graph.
 *
 * Convention:
 *   - Layer index 0 (e.g. "core") → BOTTOM of the diagram (highest y)
 *   - Layer index N-1 (e.g. "ui") → TOP of the diagram (y = 0)
 *
 * This mirrors the standard dependency diagram: the most-stable layer (core,
 * imported by everything) is at the bottom; the least-stable (ui, importing
 * everything) is at the top.  Healthy arrows point downward; layer violations
 * visually point upward, making them immediately obvious.
 *
 * dagre computes horizontal (x) positions via the Sugiyama algorithm; we snap
 * vertical (y) positions to fixed layer bands so that all nodes in the same
 * architectural layer share the same row.
 */
import dagre from '@dagrejs/dagre'
import type { Node as FlowNode, Edge as FlowEdge } from '@xyflow/react'

export const NODE_H = 62

export function layoutWithDagre(
  nodes: FlowNode[],
  edges: FlowEdge[],
  /** Returns layer index (0 = lowest) for a given node id, or -1 if unknown. */
  layerIdxOf: (nodeId: string) => number,
  layerCount: number,
): FlowNode[] {
  if (nodes.length === 0) return nodes

  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  // TB = top-to-bottom; dagre places nodes with many outgoing edges (importers)
  // at the top, matching the architecture diagram convention above.
  g.setGraph({ rankdir: 'TB', ranksep: 80, nodesep: 40, marginx: 40, marginy: 40 })

  const nodeSet = new Set(nodes.map(n => n.id))

  for (const node of nodes) {
    const w = (node.data?.width as number | undefined) ?? 160
    g.setNode(node.id, { width: w, height: NODE_H })
  }
  for (const edge of edges) {
    if (nodeSet.has(edge.source) && nodeSet.has(edge.target)) {
      g.setEdge(edge.source, edge.target)
    }
  }

  dagre.layout(g)

  // BAND_HEIGHT is the vertical distance between successive layer rows.
  // Must be large enough to avoid node + edge overlap between layers.
  const BAND_HEIGHT = 220

  // y for layer index L (0 = bottom, n-1 = top):
  //   screenY = (numLayers - 1 - L) * BAND_HEIGHT
  const bandY = (layerIdx: number) =>
    (layerCount - 1 - layerIdx) * BAND_HEIGHT

  return nodes.map(node => {
    const pos = g.node(node.id)
    if (!pos) return node

    const w = (node.data?.width as number | undefined) ?? 160
    const layerIdx = layerIdxOf(node.id)

    const x = pos.x - w / 2
    const y =
      layerIdx >= 0
        ? bandY(layerIdx)
        : layerCount > 0
          ? bandY(-1)   // unlayered files go below all named layers
          : pos.y - NODE_H / 2

    return { ...node, position: { x, y } }
  })
}
