// Draw a region on the ground, name it, and ask about it later.
//
// Landmarks are points, which is the wrong shape for most of what you want to
// talk about: a retaining wall is a run, a planting bed is a region, "this
// corner" is an area. Marking those as pairs of pins makes the user describe a
// shape by its corners, and then nothing downstream can reason about the
// inside of it.
//
// So this is a LASSO, not a pin-placer: hold the button and drag across the
// terrain, and every sample lands on the real scanned surface via the same
// raycast the measuring tools use. The outline is simplified on release, so a
// 400-point drag becomes a dozen honest vertices rather than a blob of noise.
//
// Areas live in site.json as user ground truth — never model-generated, never
// inferred from a name. A future session finds them by name.
import * as THREE from "three";

/** Perpendicular distance from p to the segment a-b, in the ground plane. */
function segDist(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const wx = p[0] - a[0], wy = p[1] - a[1];
  const L = vx * vx + vy * vy;
  const t = L === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / L));
  return Math.hypot(p[0] - (a[0] + vx * t), p[1] - (a[1] + vy * t));
}

/**
 * Ramer-Douglas-Peucker. A hand-drawn lasso is hundreds of samples of a shaky
 * hand; what the user MEANT is a dozen points. Simplifying at draw time keeps
 * site.json readable and keeps every downstream polygon test cheap.
 */
export function simplify(pts, tol = 0.25) {
  if (pts.length < 3) return pts.slice();
  let worst = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = segDist(pts[i], pts[0], pts[pts.length - 1]);
    if (d > worst) { worst = d; idx = i; }
  }
  if (worst <= tol) return [pts[0], pts[pts.length - 1]];
  return [...simplify(pts.slice(0, idx + 1), tol).slice(0, -1),
          ...simplify(pts.slice(idx), tol)];
}

export function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

export function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, n = poly.length; i < n; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % n];
    if ((y1 > py) !== (y2 > py) &&
        px < (x2 - x1) * (py - y1) / (y2 - y1) + x1) inside = !inside;
  }
  return inside;
}

/**
 * Live lasso state. `push` is called per pointermove with an ENU point picked
 * off the terrain; `finish` returns the simplified closed outline or null when
 * the drag was too small to be a deliberate shape.
 */
export class Lasso {
  constructor() { this.pts = []; }
  get length() { return this.pts.length; }

  push(x, y) {
    const last = this.pts[this.pts.length - 1];
    // thin as we go: sub-10 cm moves are hand tremor, not intent
    if (last && Math.hypot(x - last[0], y - last[1]) < 0.1) return false;
    this.pts.push([x, y]);
    return true;
  }

  finish(tol = 0.25) {
    if (this.pts.length < 3) return null;
    const poly = simplify(this.pts, tol);
    if (poly.length < 3) return null;
    // drop a duplicated closing vertex; the polygon is implicitly closed
    if (poly.length > 3) {
      const [a, b] = [poly[0], poly[poly.length - 1]];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < tol) poly.pop();
    }
    return polygonArea(poly) < 0.5 ? null : poly;   // a stray click is not an area
  }

  reset() { this.pts = []; }
}

const AREA_COLOR = 0x4dd2ff;      // same cyan as landmarks: both are owner truth

/**
 * A draped translucent overlay for one area, plus its outline.
 * Uses the terrain height so it lies ON the ground rather than through it.
 */
export function areaMesh(polygon, heightAt, enuToWorld, { live = false } = {}) {
  const group = new THREE.Group();
  if (polygon.length < 3) return group;

  const shape = new THREE.Shape(polygon.map(([x, y]) => new THREE.Vector2(x, y)));
  const geo = new THREE.ShapeGeometry(shape).toNonIndexed();
  const pos = geo.attributes.position;
  const v = [];
  for (let i = 0; i < pos.count; i++) {
    const w = enuToWorld(pos.getX(i), pos.getY(i), 0);
    const h = heightAt(w.x, w.z);
    v.push(w.x, (Number.isFinite(h) ? h : 0) + 0.05, w.z);
  }
  const fill = new THREE.BufferGeometry();
  fill.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  fill.computeVertexNormals();
  group.add(new THREE.Mesh(fill, new THREE.MeshBasicMaterial({
    color: AREA_COLOR, transparent: true, opacity: live ? 0.22 : 0.16,
    depthWrite: false, side: THREE.DoubleSide })));

  // the outline carries the shape; the fill only says "this region"
  const ring = [];
  for (let i = 0; i <= polygon.length; i++) {
    const [x, y] = polygon[i % polygon.length];
    const w = enuToWorld(x, y, 0);
    const h = heightAt(w.x, w.z);
    ring.push(w.x, (Number.isFinite(h) ? h : 0) + 0.07, w.z);
  }
  const line = new THREE.BufferGeometry();
  line.setAttribute("position", new THREE.Float32BufferAttribute(ring, 3));
  group.add(new THREE.Line(line, new THREE.LineBasicMaterial({
    color: AREA_COLOR, transparent: true, opacity: live ? 0.95 : 0.7 })));
  return group;
}


/**
 * EVERY DESIGN OBJECT WHOSE FOOTPRINT FALLS INSIDE A DRAWN LOOP.
 *
 * Mass selection: the user selects a group and hides a section of assets to
 * focus on one thing. It lives HERE rather than in main.js
 * because the loop and the point test are already this file's job, and because a
 * rule this fiddly has to be runnable by a test without a browser.
 *
 * A plant and a garden object are POINTS, so the test is the point. A bed, path,
 * patio, edge or flight of steps is a RUN or a POLYGON, and it comes with you
 * only when it is WHOLLY inside: half a path is not a thing the user can hide, and
 * catching a whole walk because one vertex clipped the loop is the
 * behaviour that makes a marquee infuriating.
 *
 * `locked` is the set of ids belonging to locked groups. Locking is how the user stops
 * a thing being grabbed, and a loop thrown across the yard that ignored it would
 * make the lock worthless exactly when it matters.
 */
export function idsInsidePolygon(design, poly, kinds, locked = new Set()) {
  if (!poly?.length) return [];
  const out = [];
  for (const [key, kind] of kinds ?? []) {
    for (const o of design?.[key] ?? []) {
      if (locked.has(o.id)) continue;
      const pts = kind === "plant" || kind === "object"
        ? [o.position]
        : (o.polygon ?? o.spline ?? []);
      const good = pts.filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (!good.length) continue;
      if (good.every(p => pointInPolygon(p[0], p[1], poly))) out.push(o.id);
    }
  }
  return out;
}
