// ─── architectural layer palette ─────────────────────────────────────────────
//
// Colors are assigned by position in layer_order (index 0 = lowest/most-stable).
// The first three entries preserve the original core/cli/ui colors exactly.

/** Visually distinct hex colors for up to 6+ architectural layers. */
export const LAYER_PALETTE: string[] = [
  '#6366f1',  // indigo   (index 0 — most stable, e.g. core)
  '#fbbf24',  // amber    (index 1 — e.g. cli)
  '#34d399',  // emerald  (index 2 — e.g. ui)
  '#f472b6',  // pink     (index 3)
  '#38bdf8',  // sky      (index 4)
  '#a78bfa',  // violet   (index 5)
]

/**
 * Build a name→color map from the ordered layer list.
 * layerOrder[i] maps to LAYER_PALETTE[i % LAYER_PALETTE.length].
 */
export function buildLayerColors(layerOrder: string[]): Record<string, string> {
  const colors: Record<string, string> = {}
  layerOrder.forEach((name, i) => {
    colors[name] = LAYER_PALETTE[i % LAYER_PALETTE.length]
  })
  return colors
}

/**
 * Resolve the display color for a single layer name.
 * - No layer → '#2e3250'  (--border)
 * - Known layer → palette color
 * - Unknown name → '#8892aa'  (--text-muted fallback)
 */
export function layerColor(layer: string | undefined, colors: Record<string, string>): string {
  if (!layer) return '#2e3250'
  return colors[layer] ?? '#8892aa'
}
