/**
 * Measure the real ground: how far across, how far along, how much fall.
 *
 * The only decision that really matters is WHICH LENGTH. On sloping ground the
 * distance across the map and the distance you walk are different numbers:
 *
 *   * paving, gravel, decomposed granite and turf are sold by PLAN area — the
 *     shadow the shape casts on the map;
 *   * you WALK, and you buy edging, hose and wall by the length along the ground.
 *
 * A tool that silently picks one is wrong for half the jobs it is used for. On a
 * 25% grade it is wrong by about 3% — enough to be short of stone, not enough to
 * notice until you are. So both are reported, and `describe()` names them.
 *
 * Pure: no THREE, no DOM. `heightAt` is passed in, and may return a non-finite
 * value off the scan — the filled height field can invent a cliff of several
 * hundred percent there, so an unmeasured stretch is COUNTED AND REPORTED rather
 * than given a fabricated rise.
 */
import { polygonArea } from "./areas.js";

const SAMPLE_M = 0.5;   // the same 0.5 m stride agent.path_grades walks a route at

/**
 * @param pts      [[x, y], ...] in ENU metres
 * @param heightAt (x, y) -> ground height, or a non-finite value if unmeasured
 */
export function measure(pts, heightAt) {
  const p = Array.isArray(pts) ? pts.filter(q => Array.isArray(q) && q.length >= 2) : [];
  const out = { points: p.length, plan_m: 0, slope_m: 0, fall_m: 0, rise_m: 0,
                grade_pct: 0, steepest_pct: 0, unmeasured_m: 0, area_m2: null };
  if (p.length < 2) return out;

  let up = 0, down = 0;
  for (let i = 0; i < p.length - 1; i++) {
    const [ax, ay] = p[i], [bx, by] = p[i + 1];
    const run = Math.hypot(bx - ax, by - ay);
    out.plan_m += run;
    if (run < 1e-9) continue;
    // Walk the segment rather than reading its two ends: a wall declared 0.7 m
    // can stand 2.59 m tall where the ground dips BETWEEN two points, and a
    // vertex-only check passes it.
    const n = Math.max(1, Math.round(run / SAMPLE_M));
    let prev = null;
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const h = heightAt(ax + (bx - ax) * t, ay + (by - ay) * t);
      const d = run / n;
      if (k > 0) {
        if (prev == null || !Number.isFinite(h)) {
          out.unmeasured_m += d;
          out.slope_m += d;                 // the ground is at least this long
        } else {
          const dz = h - prev;
          out.slope_m += Math.hypot(d, dz);
          if (dz > 0) up += dz; else down -= dz;
          const g = Math.abs(100 * dz / d);
          if (g > out.steepest_pct) out.steepest_pct = g;
        }
      }
      prev = Number.isFinite(h) ? h : null;
    }
  }
  out.rise_m = up;
  out.fall_m = down;
  // net, signed the way a person reads it: end minus start
  const h0 = heightAt(p[0][0], p[0][1]);
  const h1 = heightAt(p[p.length - 1][0], p[p.length - 1][1]);
  if (Number.isFinite(h0) && Number.isFinite(h1)) {
    out.fall_m = Math.abs(h1 - h0);
    out.grade_pct = out.plan_m > 0 ? Math.abs(100 * (h1 - h0) / out.plan_m) : 0;
  }
  // PLAN area, not draped: a supplier quotes the footprint, and inflating it by
  // the slope would over-order every time.
  if (p.length >= 3) out.area_m2 = Math.abs(polygonArea(p));
  return out;
}

const m1 = v => (Math.round(v * 10) / 10).toFixed(1);

/** The readout, naming each number so "12.4 m" is never ambiguous. */
export function describe(r) {
  if (!r || r.points < 2) return "click two points on the ground to measure";
  const bits = [`${m1(r.plan_m)} m across`];
  // On flat ground the two lengths are identical and printing both is noise.
  if (Math.abs(r.slope_m - r.plan_m) >= 0.05) bits.push(`${m1(r.slope_m)} m along the ground`);
  if (r.fall_m >= 0.05) bits.push(`${m1(r.fall_m)} m fall (${Math.round(r.grade_pct)}%)`);
  if (r.area_m2 != null) bits.push(`${m1(r.area_m2)} m² in plan`);
  if (r.unmeasured_m >= 0.5) bits.push(`${m1(r.unmeasured_m)} m off the scan — not measured`);
  return bits.join(" · ");
}
