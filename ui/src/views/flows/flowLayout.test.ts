import { describe, expect, it } from 'vitest'
import { computeFlowLayout, ENTRY_KEY, stepNodeKey } from './flowLayout'
import type { Flow, FlowStep, FunctionId } from '../../api'

function fn(name: string, order = 0): FunctionId {
  return { module: 0, name, order }
}

function step(overrides: Partial<FlowStep> & { id: number; parent: number | null }): FlowStep {
  return {
    branch_group: null,
    from: fn('caller'),
    to: fn('callee'),
    call_site_order: 0,
    callee_text: 'callee()',
    params: [],
    return_shape: { kind: 'unknown', raw: '' },
    arg_texts: [],
    fragility: [],
    depth: 1,
    recursion: false,
    branchy: false,
    ...overrides,
  }
}

function flow(steps: FlowStep[]): Flow {
  return {
    id: 'flow-1',
    name: 'Test flow',
    entry_module_path: 'src/entry.ts',
    kind: 'route',
    step_count: steps.length,
    fragility_summary: {
      total_steps: steps.length,
      fragile_steps: 0,
      metric_flags: 0,
      type_flags: 0,
      churn_flags: 0,
      max_severity: null,
    },
    declared: false,
    feature_name: null,
    entry: fn('entryFn'),
    steps,
    truncated: false,
  }
}

describe('computeFlowLayout', () => {
  it('returns an empty layout for a flow with no steps', () => {
    const result = computeFlowLayout(flow([]))
    expect(result.nodes.size).toBe(0)
    expect(result.edges).toHaveLength(0)
  })

  it('builds one node per step plus the entry root, and one edge per step', () => {
    const steps = [
      step({ id: 0, parent: null }),
      step({ id: 1, parent: 0 }),
    ]
    const result = computeFlowLayout(flow(steps))

    expect(result.nodes.has(ENTRY_KEY)).toBe(true)
    expect(result.nodes.has(stepNodeKey(0))).toBe(true)
    expect(result.nodes.has(stepNodeKey(1))).toBe(true)
    expect(result.nodes.size).toBe(3)

    expect(result.edges).toHaveLength(2)
    expect(result.edges[0]).toMatchObject({ fromKey: ENTRY_KEY, toKey: stepNodeKey(0), stepIndex: 0 })
    expect(result.edges[1]).toMatchObject({ fromKey: stepNodeKey(0), toKey: stepNodeKey(1), stepIndex: 1 })
  })

  it('still positions a recursive (self-loop) step next to its parent', () => {
    const steps = [
      step({ id: 0, parent: null }),
      step({ id: 1, parent: 0, recursion: true }),
    ]
    const result = computeFlowLayout(flow(steps))

    const parentNode = result.nodes.get(stepNodeKey(0))!
    const selfLoopNode = result.nodes.get(stepNodeKey(1))!
    expect(selfLoopNode).toBeDefined()
    expect(selfLoopNode.y).toBe(parentNode.y)
    expect(selfLoopNode.x).toBeGreaterThan(parentNode.x)

    // Self-loop still appears in the edge list (for playback), flagged accordingly.
    expect(result.edges[1]).toMatchObject({ isSelfLoop: true, toKey: stepNodeKey(1) })
  })

  it('branches: two children of the same parent both get distinct nodes', () => {
    const steps = [
      step({ id: 0, parent: null }),
      step({ id: 1, parent: 0 }),
      step({ id: 2, parent: 0 }),
    ]
    const result = computeFlowLayout(flow(steps))
    expect(result.nodes.size).toBe(4) // entry + 3 steps
    const a = result.nodes.get(stepNodeKey(1))!
    const b = result.nodes.get(stepNodeKey(2))!
    expect(a.x).toBe(b.x) // same rank (both direct children of entry)
    expect(a.y).not.toBe(b.y) // separated within the rank
  })
})
