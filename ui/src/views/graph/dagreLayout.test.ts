import { describe, expect, it } from 'vitest'
import { computeRankedLayout } from './dagreLayout'

describe('computeRankedLayout', () => {
  it('returns an empty layout for no nodes', () => {
    const result = computeRankedLayout([], [], [])
    expect(result.positions.size).toBe(0)
    expect(result.width).toBeGreaterThan(0)
    expect(result.height).toBeGreaterThan(0)
  })

  it('positions every node, even with no edges', () => {
    const nodes = [{ id: 1, width: 120 }, { id: 2, width: 120 }]
    const result = computeRankedLayout(nodes, [], [])
    expect(result.positions.size).toBe(2)
    expect(result.positions.get(1)).toBeDefined()
    expect(result.positions.get(2)).toBeDefined()
  })

  it('drops self-loop edges rather than passing them to dagre', () => {
    const nodes = [{ id: 1, width: 120 }]
    // dagre throws on self-loop edges; if the self-loop filter were removed,
    // this call would throw instead of returning a layout.
    expect(() => computeRankedLayout(nodes, [{ fromId: 1, toId: 1 }], [])).not.toThrow()
  })

  it('ignores edges that reference an unknown node id', () => {
    const nodes = [{ id: 1, width: 120 }]
    const result = computeRankedLayout(nodes, [{ fromId: 1, toId: 999 }], [])
    expect(result.positions.size).toBe(1)
  })

  it('places a lower-layer node below a higher-layer node it points to (rankdir BT)', () => {
    const nodes = [
      { id: 1, width: 120, layer: 'core' },
      { id: 2, width: 120, layer: 'ui' },
    ]
    const result = computeRankedLayout(nodes, [{ fromId: 1, toId: 2 }], ['core', 'ui'])
    const posCore = result.positions.get(1)!
    const posUi = result.positions.get(2)!
    expect(posCore.y).toBeGreaterThan(posUi.y)
  })
})
