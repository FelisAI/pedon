/**
 * Snapping, so things line up.
 *
 * Without it a path that should meet a terrace edge lands four centimetres off,
 * and four centimetres is invisible on screen — the owner finds out later, when
 * the validator complains or the render looks subtly wrong. Every 3D editor has
 * this and it is the difference between placing things and drawing them.
 *
 * TOLERANCE is the whole design. Snap always and nothing can be placed off-grid;
 * snap never and nothing lines up. So every function here takes a tolerance in
 * METRES (or degrees), a zero tolerance means OFF, and the caller decides — the
 * owner has an explicit switch, because a snap that cannot be turned off is a
 * rule, and taste must never become a rule.
 *
 * Pure: no THREE, no DOM. main.js only wires it, and does not grow its own copy
 * of the arithmetic — copies of one lookup drift apart and each goes wrong in its
 * own way.
 */

// The stored centimetre, as everywhere — and `+ 0` to kill negative zero, which
// Math.round produces for anything in [-0.5, 0) and which reaches disk as `-0`.
const r2 = (v) => Math.round(v * 100) / 100 + 0;

/** Pull a point onto a `step` grid if it is within `tol` metres of one. */
export function toGrid(pt, step = 0.5, tol = 0.08) {
  const [x, y] = pt ?? [];
  if (!Number.isFinite(x) || !Number.isFinite(y) || !(step > 0) || !(tol > 0)) return pt;
  const gx = Math.round(x / step) * step;
  const gy = Math.round(y / step) * step;
  return [Math.abs(gx - x) <= tol ? r2(gx) : x,
          Math.abs(gy - y) <= tol ? r2(gy) : y];
}

/**
 * Snap to the nearest of `others` first, then to the grid.
 *
 * Order matters and is the interesting decision: meeting the terrace corner
 * EXACTLY matters more than sitting on a round number, and doing the grid first
 * would quietly pull the point a few centimetres off the very thing it was
 * meant to meet.
 */
export function toNearest(pt, others, step = 0.5, tol = 0.08) {
  const [x, y] = pt ?? [];
  if (!Number.isFinite(x) || !Number.isFinite(y)) return pt;
  let best = null, bestD = Infinity;
  for (const o of others ?? []) {
    if (!Array.isArray(o) || o.length < 2) continue;
    const d = Math.hypot(o[0] - x, o[1] - y);
    if (d < bestD) { bestD = d; best = o; }
  }
  if (best && tol > 0 && bestD <= tol) return [r2(best[0]), r2(best[1])];
  return toGrid(pt, step, tol);
}

/** Pull an angle in DEGREES onto a `step` multiple if it is within `tol` degrees. */
export function toAngle(deg, step = 15, tol = 5) {
  if (!Number.isFinite(deg) || !(step > 0) || !(tol > 0)) return deg;
  const snapped = Math.round(deg / step) * step;
  return Math.abs(snapped - deg) <= tol ? snapped + 0 : deg;
}
