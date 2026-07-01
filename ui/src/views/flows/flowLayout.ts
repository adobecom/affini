/**
 * Tree layout for the FlowGraph using dagre LR (left-to-right by call depth).
 *
 * Key design decisions vs the old column-by-depth layout:
 *  1. Nodes are keyed by **step id** (not FunctionId), so a function called in two
 *     different branches appears as two separate nodes — the tree never collapses.
 *  2. The entry function is a special "entry" root node with no incoming edge.
 *  3. Parent-link data (step.parent) builds the tree structure; dagre handles spacing.
 *  4. isSelfLoop is taken from step.recursion (not from key equality).
 */
import { graphlib, layout } from '@dagrejs/dagre'
import type { Flow, FunctionId } from '../../api'

// ── layout constants ──────────────────────────────────────────────────────────

export const NODE_W      = 152   // node rectangle width
export const NODE_H_FLOW = 46    // node rectangle height
export const PAD         = 48    // canvas padding

// ── types ─────────────────────────────────────────────────────────────────────

export interface FlowNode {
  key: string
  label: string     // function name
  module: number    // used for hue assignment
  x: number         // center X
  y: number         // center Y
  stepId: number | null  // null for the entry root node
}

export interface FlowGraphEdge {
  /** Index into flow.steps (for `stepIndex` matching during playback). */
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

/** Key for a step node: "step_{id}" */
export function stepNodeKey(stepId: number): string {
  return `step_${stepId}`
}

/** The entry root always uses this key. */
export const ENTRY_KEY = 'entry'

/**
 * Map a module id to a CSS hue (0-360) for a stable accent color.
 * Simple multiplicative hash — good enough for visual variety.
 */
export function moduleHue(moduleId: number): number {
  return (moduleId * 137.508) % 360
}

/**
 * @deprecated Use stepNodeKey() — kept only for backward compat with old consumers.
 */
export function nodeKey(fid: FunctionId): string {
  return `${fid.module}|${fid.name}|${fid.order}`
}

// ── layout engine ─────────────────────────────────────────────────────────────

export function computeFlowLayout(flow: Flow): FlowLayout {
  const { steps, entry } = flow

  if (steps.length === 0) {
    return {
      nodes: new Map(),
      edges: [],
      width:  PAD * 2 + NODE_W,
      height: PAD * 2 + NODE_H_FLOW,
    }
  }

  // ── 1. Build dagre graph ────────────────────────────────────────────────────
  const g = new graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({
    rankdir: 'LR',
    ranksep: 80,
    nodesep: 44,
    marginx: PAD,
    marginy: PAD,
  })

  // Root node: the entry function
  g.setNode(ENTRY_KEY, { width: NODE_W, height: NODE_H_FLOW, label: entry.name })

  // One node per step (keyed by step id)
  for (const step of steps) {
    g.setNode(stepNodeKey(step.id), { width: NODE_W, height: NODE_H_FLOW, label: step.to.name })
  }

  // Tree edges (skip self-loops — dagre can't handle them)
  for (const step of steps) {
    if (step.recursion) continue
    const fromKey = step.parent === null ? ENTRY_KEY : stepNodeKey(step.parent)
    const toKey   = stepNodeKey(step.id)
    g.setEdge(fromKey, toKey)
  }

  layout(g)

  // ── 2. Extract node positions ───────────────────────────────────────────────
  const nodes = new Map<string, FlowNode>()

  const entryPos = g.node(ENTRY_KEY) as { x: number; y: number } | undefined
  if (entryPos) {
    nodes.set(ENTRY_KEY, {
      key:    ENTRY_KEY,
      label:  entry.name,
      module: entry.module,
      x:      entryPos.x,
      y:      entryPos.y,
      stepId: null,
    })
  }

  for (const step of steps) {
    const k   = stepNodeKey(step.id)
    const pos = g.node(k) as { x: number; y: number } | undefined
    // Self-loops: place next to their parent if dagre didn't give them a position
    if (!pos) {
      const parentKey = step.parent === null ? ENTRY_KEY : stepNodeKey(step.parent)
      const parentPos = nodes.get(parentKey)
      nodes.set(k, {
        key:    k,
        label:  step.to.name,
        module: step.to.module,
        x:      parentPos ? parentPos.x + NODE_W + 40 : PAD + NODE_W / 2,
        y:      parentPos ? parentPos.y : PAD + NODE_H_FLOW / 2,
        stepId: step.id,
      })
    } else {
      nodes.set(k, {
        key:    k,
        label:  step.to.name,
        module: step.to.module,
        x:      pos.x,
        y:      pos.y,
        stepId: step.id,
      })
    }
  }

  // ── 3. Build edge list (one per step, preserving stepIndex for playback) ────
  const edges: FlowGraphEdge[] = steps.map((step, i) => {
    const fromKey = step.parent === null ? ENTRY_KEY : stepNodeKey(step.parent)
    const toKey   = stepNodeKey(step.id)
    return {
      stepIndex: i,
      fromKey,
      toKey,
      isSelfLoop: step.recursion,
    }
  })

  const ginfo = g.graph() as { width?: number; height?: number }
  return {
    nodes,
    edges,
    width:  (ginfo.width  ?? 800) + PAD * 2,
    height: (ginfo.height ?? 400) + PAD * 2,
  }
}
