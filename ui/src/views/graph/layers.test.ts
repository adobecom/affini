import { describe, expect, it } from 'vitest'
import { buildLayerColors, layerColor, LAYER_PALETTE } from './layers'

describe('buildLayerColors', () => {
  it('maps each layer name to its positional palette color', () => {
    const colors = buildLayerColors(['core', 'cli', 'ui'])
    expect(colors).toEqual({
      core: LAYER_PALETTE[0],
      cli: LAYER_PALETTE[1],
      ui: LAYER_PALETTE[2],
    })
  })

  it('wraps around the palette for more layers than colors', () => {
    const names = Array.from({ length: LAYER_PALETTE.length + 2 }, (_, i) => `layer${i}`)
    const colors = buildLayerColors(names)
    expect(colors[`layer${LAYER_PALETTE.length}`]).toBe(LAYER_PALETTE[0])
  })
})

describe('layerColor', () => {
  const colors = buildLayerColors(['core', 'ui'])

  it('returns the border color for an undefined layer', () => {
    expect(layerColor(undefined, colors)).toBe('#2e3250')
  })

  it('returns the palette color for a known layer', () => {
    expect(layerColor('core', colors)).toBe(LAYER_PALETTE[0])
  })

  it('returns the muted fallback for an unknown layer name', () => {
    expect(layerColor('mystery', colors)).toBe('#8892aa')
  })
})
