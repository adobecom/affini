import { describe, expect, it } from 'vitest'
import { edgePath, NODE_H } from './edgePath'

describe('edgePath', () => {
  it('draws a horizontal edge stopping short of the target border', () => {
    const path = edgePath(0, 0, 100, 0, 40, 20)
    expect(path).toBe('M0.0,0.0 Q34.5,8.0 69.0,0.0')
  })

  it('defaults target height to NODE_H when omitted', () => {
    const withDefault = edgePath(0, 0, 100, 0, 40)
    const withExplicit = edgePath(0, 0, 100, 0, 40, NODE_H)
    expect(withDefault).toBe(withExplicit)
  })

  it('does not divide by zero when source and target coincide', () => {
    expect(() => edgePath(5, 5, 5, 5, 40, 20)).not.toThrow()
    const path = edgePath(5, 5, 5, 5, 40, 20)
    expect(path).toMatch(/^M5\.0,5\.0/)
  })
})
