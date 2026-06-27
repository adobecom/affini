/**
 * Deterministic layered layout for the FlowGraph.
 * Nodes = functions (keyed module|name|order), column = call depth.
 * No force sim — positions are stable so the animated dot travels predictably.
 */

import type { Flow, FunctionId } from '../../api'

// ── layout constants ──────────────────────────────────────────────────────────

export const COL_W  = 200   // horizontal gap between depth columns
export const ROW_H  = 90    // vertical gap between siblings in a column
export const NODE_W = 148   // node rectangle width
export const NODE_H_FLOW = 44 // node rectangle height (shorter than ForceGraph's 62)
export const PAD    = 48    // canvas padding on all sides

// ── types ─────────────────────────────────────────────────────────────────────

export interface FlowNode {
  key: string
  label: string    // function name shown in the node
  module: number   // used for hue assignment
  depth: number    // column index
  x: number        // center X
  y: number        // center Y
}

export interface FlowGraphEdge {
  stepIndex: number
  fromKey: string
  toKey: string
  isSelfLoop: boolean
}

export interface FlowLayout {
  nodes: Map<string, FlowNode>
  edges: FlowGraphEdge[]
  width: number
  height: number
}

// ── helpers ───────────────────────────────────────────────────────────────────

export function nodeKey(fid: FunctionId): string {
  return `${fid.module}|${fid.name}|${fid.order}`
}

/**
 * Map a module id to a CSS hue (0-360) so each module gets a stable accent color.
 * Simple multiplicative hash — no collision guarantees needed, just visual variety.
 */
export function moduleHue(moduleId: number): number {
  return (moduleId * 137.508) % 360
}

// ── layout engine ─────────────────────────────────────────────────────────────

export function computeFlowLayout(flow: Flow): FlowLayout {
  const { steps } = flow

  if (steps.length === 0) {
    return { nodes: new Map(), edges: [], width: PAD * 2 + NODE_W, height: PAD * 2 + NODE_H_FLOW }
  }

  // --- 1. Build ordered node list (first-appearance wins key/depth assignment)
  const nodeOrder: Array<{ key: string; fid: FunctionId; depth: number }> = []
  const seen = new Set<string>()

  function ensureNode(fid: FunctionId, depth: number) {
    const k = nodeKey(fid)
    if (!seen.has(k)) {
      seen.add(k)
      nodeOrder.push({ key: k, fid, depth: Math.max(0, depth) })
    }
  }

  for (const step of steps) {
    ensureNode(step.from, step.depth)
    ensureNode(step.to,   step.depth + 1)
  }

  // --- 2. Assign row-within-column (first-appearance order)
  const colRows = new Map<number, string[]>() // depth → [key...]
  for (const { key, depth } of nodeOrder) {
    if (!colRows.has(depth)) colRows.set(depth, [])
    colRows.get(depth)!.push(key)
  }

  const maxCol  = Math.max(...colRows.keys())
  const maxRows = Math.max(...[...colRows.values()].map(r => r.length))

  // --- 3. Compute coordinates
  const nodes = new Map<string, FlowNode>()
  for (const { key, fid, depth } of nodeOrder) {
    const col       = colRows.get(depth)!
    const rowInCol  = col.indexOf(key)
    const colCount  = col.length

    const x = PAD + depth * COL_W + NODE_W / 2
    // Center this column's nodes vertically against the tallest column
    const totalColH  = colCount  * ROW_H - (ROW_H - NODE_H_FLOW)
    const totalMaxH  = maxRows   * ROW_H - (ROW_H - NODE_H_FLOW)
    const topOffset  = (totalMaxH - totalColH) / 2
    const y = PAD + topOffset + rowInCol * ROW_H + NODE_H_FLOW / 2

    nodes.set(key, {
      key,
      label: fid.name,
      module: fid.module,
      depth,
      x,
      y,
    })
  }

  // --- 4. Build edges (one per step)
  const edges: FlowGraphEdge[] = steps.map((step, i) => {
    const fromKey = nodeKey(step.from)
    const toKey   = nodeKey(step.to)
    return {
      stepIndex: i,
      fromKey,
      toKey,
      isSelfLoop: fromKey === toKey,
    }
  })

  const width  = PAD * 2 + (maxCol + 1) * COL_W
  const height = PAD * 2 + maxRows * ROW_H

  return { nodes, edges, width, height }
}
