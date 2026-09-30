// Paint what is TRUE onto what is VISIBLE.
//
// The renders the design model sees show geometry only — the same photograph a
// person would take. Every measurement arrives separately, as numbers in a text
// block it must remember to ask for and then fuse with the image in its head. So
// without this, "do not build past the scan" is a rule obeyed blindly rather than a
// boundary it can see, and a path crossing a 25% face looks exactly like one crossing 5%.
//
// The model should see everything and act like a real designer. A real designer
// standing on a site cannot read grade as a number either — they feel it underfoot
// and know it from experience. We HAVE the measurements. Putting them in the eye lets the model see
// MORE than a person can, which is the whole advantage of designing on a survey.
//
// Nothing here measures anything new. Every number already existed in
// terrain_scan.json; this is only a way of showing it.
import * as THREE from "three";
import { enuToWorld } from "./design.js";

// The SAME thresholds validate() judges on. Deliberately imported-by-value rather
// than re-chosen: if what the model sees and what it is judged on can drift, the
// picture becomes a second opinion instead of a preview of the verdict.
export const WALK_GRADE = 0.08;      // comfortable ramp
export const MAX_GRADE = 0.20;       // a walk may not exceed this; steps instead

const BANDS = {
  walkable:    [0.36, 0.62, 0.40],   // green: you can stroll it
  steep:       [0.86, 0.72, 0.30],   // amber: legal, not comfortable
  needs_steps: [0.78, 0.34, 0.28],   // red: a walk here is rejected
};

export function band(grade) {
  const g = Math.abs(grade);
  if (g <= WALK_GRADE) return "walkable";
  if (g <= MAX_GRADE) return "steep";
  return "needs_steps";
}

/** Height at an ENU point from the raycast grid, or null where nothing was scanned. */
function at(grid, x, y) {
  const c = Math.round((x - grid.x0) / grid.cell_m);
  const r = Math.round((grid.y1 - y) / grid.cell_m);
  const row = grid.rows[r];
  if (!row) return null;
  const v = row[c];
  return v === null || v === undefined ? null : v;
}

/**
 * Steepest fall at a point, or null if any neighbour is unmeasured.
 *
 * Null rather than a guess at the edge: interpolating across the boundary of
 * coverage is how the filled height field invented ground, and painting an
 * invented grade would be the same mistake wearing a colour.
 */
export function gradeAt(grid, x, y) {
  const h = at(grid, x, y);
  if (h === null) return null;
  const d = grid.cell_m;
  const e = at(grid, x + d, y), w = at(grid, x - d, y);
  const n = at(grid, x, y + d), s = at(grid, x, y - d);
  if ([e, w, n, s].every(v => v === null)) return null;
  const dx = e !== null && w !== null ? (e - w) / (2 * d)
           : e !== null ? (e - h) / d : w !== null ? (h - w) / d : 0;
  const dy = n !== null && s !== null ? (n - s) / (2 * d)
           : n !== null ? (n - h) / d : s !== null ? (h - s) / d : 0;
  return Math.hypot(dx, dy);
}

/**
 * Where the measured ground stops.
 *
 * The single most useful thing to draw. A scan edge is invisible in a render —
 * ground simply stops being ground — and this is where a design overreaches: a
 * patio far off the scan that still validates clean, a terrace past the mesh, an
 * edge that looks buildable and does not exist.
 */
export function coverageEdge(grid) {
  const out = [];
  for (let r = 0; r < grid.rows.length; r++) {
    const row = grid.rows[r];
    for (let c = 0; c < row.length; c++) {
      if (row[c] === null || row[c] === undefined) continue;
      // A neighbour OUTSIDE the grid is not an unscanned neighbour — it is a
      // question nobody asked. Counting it would draw a red box around the whole
      // query extent, which says "the raycast stopped here", not "the ground
      // stops here", and the second is the only one worth seeing.
      const nb = [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]];
      const edge = nb.some(([rr, cc]) => {
        const rw = grid.rows[rr];
        if (!rw || cc < 0 || cc >= rw.length) return false;   // off-grid: unknown
        return rw[cc] === null || rw[cc] === undefined;       // in-grid: unscanned
      });
      if (edge) out.push([grid.x0 + c * grid.cell_m, grid.y1 - r * grid.cell_m]);
    }
  }
  return out;
}

/**
 * The ground, coloured by what it can carry.
 *
 * Only over cells the raycast actually hit — unscanned ground is left unpainted
 * rather than shaded a reassuring colour, so the hole in the data reads as a hole.
 */
export function slopeLayer(grid, { cell = grid.cell_m, lift = 0.06 } = {}) {
  const verts = [], colors = [], idx = [];
  const quad = (x, y) => {
    const g = gradeAt(grid, x, y);
    if (g === null) return;
    // every corner, not just the origin: a quad anchored on the last measured
    // cell still reaches one cell PAST the edge, and painting that is inventing
    // ground with a colour instead of a number
    for (const [dx, dy] of [[0, 0], [cell, 0], [0, cell], [cell, cell]])
      if (at(grid, x + dx, y + dy) === null) return;
    const [r, gr, b] = BANDS[band(g)];
    const base = verts.length / 3;
    for (const [dx, dy] of [[0, 0], [cell, 0], [0, cell], [cell, cell]]) {
      const h = at(grid, x + dx, y + dy);
      const w = enuToWorld(x + dx, y + dy, (h ?? 0) + lift);
      verts.push(w.x, w.y, w.z);
      colors.push(r, gr, b);
    }
    idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  };
  for (let y = grid.y0; y < grid.y1; y += cell)
    for (let x = grid.x0; x < grid.x1; x += cell) quad(x, y);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.45,
    depthWrite: false, side: THREE.DoubleSide }));
  m.name = "diag:slope";
  return m;
}

/** The coverage boundary as a line the camera can see from any angle. */
export function edgeLayer(grid, { lift = 0.12 } = {}) {
  const pts = [];
  for (const [x, y] of coverageEdge(grid)) {
    const h = at(grid, x, y) ?? 0;
    const w = enuToWorld(x, y, h + lift);
    pts.push(w.x, w.y, w.z, w.x, w.y + 0.5, w.z);      // a short post per edge cell
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  const m = new THREE.LineSegments(geo,
    new THREE.LineBasicMaterial({ color: 0xff4d4d, transparent: true, opacity: 0.85 }));
  m.name = "diag:edge";
  return m;
}
