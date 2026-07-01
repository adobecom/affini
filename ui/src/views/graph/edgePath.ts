/** Shared bezier-path helper for drawing edges between rectangular nodes. */

export const NODE_H = 62
const ARROW = 8

/**
 * Compute an SVG quadratic-bezier path string from the center of a source
 * node to the border of a target node, with a slight perpendicular bend.
 *
 * @param sx  source center X
 * @param sy  source center Y
 * @param tx  target center X
 * @param ty  target center Y
 * @param tw  target node width
 * @param th  target node height (defaults to NODE_H = 62; pass NODE_H_FLOW = 44 for flow nodes)
 */
export function edgePath(
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  tw: number,
  th: number = NODE_H,
): string {
  const dx = tx - sx, dy = ty - sy
  const len = Math.sqrt(dx * dx + dy * dy) || 1
  const ux = dx / len, uy = dy / len
  const hw = tw / 2 + ARROW + 3
  const hh = th / 2 + ARROW + 3
  const tBorder = Math.min(
    Math.abs(ux) > 1e-9 ? hw / Math.abs(ux) : Infinity,
    Math.abs(uy) > 1e-9 ? hh / Math.abs(uy) : Infinity,
  )
  const ex = tx - ux * tBorder
  const ey = ty - uy * tBorder
  const bend = Math.min(len * 0.08, 22)
  const cx = (sx + ex) / 2 - uy * bend
  const cy = (sy + ey) / 2 + ux * bend
  return `M${sx.toFixed(1)},${sy.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}`
}
