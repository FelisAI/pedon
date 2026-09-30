// Geometry-first structure detection: find the things standing on the yard, so
// the naming model has real candidates to label instead of inventing them.
//
// Everything above the fitted ground is binned into 0.5 m columns, the occupied
// columns are grouped into connected blobs, and each blob is described by shape
// statistics (area, height, how thin it is, whether it has flat levels). The
// shape gives a coarse kind; a vision pass names it afterwards.

const CELL = 0.5;
const MIN_ABOVE = 0.2;    // below this is ground noise
const MAX_ABOVE = 8.0;    // above this is canopy/sky/roofline
const MIN_CELLS = 4;      // 1 m^2 of evidence before a blob counts

// 20, not 14: elongated structures take two slots (one per end), and at 14 the
// staircases fall off the end of the list.
export function detectStructures(points, heightAt, { maxCandidates = 20 } = {}) {
  const n = points.length / 3;
  if (!n) return [];

  // 1. above-ground points only
  const cols = new Map();          // "cx,cz" -> heights above ground
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = points[i * 3], y = points[i * 3 + 1], z = points[i * 3 + 2];
    const ah = y - heightAt(x, z);
    if (ah < MIN_ABOVE || ah > MAX_ABOVE) continue;
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    const k = cx + "," + cz;
    let c = cols.get(k);
    if (!c) { c = { cx, cz, hs: [], sx: 0, sz: 0 }; cols.set(k, c); }
    c.hs.push(ah);
    c.sx += x; c.sz += z;      // true means, not cell centres (see below)
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  for (const [k, c] of cols) {
    if (c.hs.length < 3) { cols.delete(k); continue; }
    c.top = Math.max(...c.hs);
  }
  if (!cols.size) return [];

  // 2. connected components over the occupied columns (8-neighbour), but only
  //    across columns of similar height — otherwise an overhanging tree bridges
  //    to the house and to the fence, and the whole yard floods into one blob
  // 0.35 m: comfortably above a stair riser (~0.15 m) so a staircase stays one
  // blob, tight enough that a canopy gradient can't walk across the whole yard.
  // Measured on a real capture: at 0.8 the house+trees+fences fuse into a
  // single 243 m2 blob; at 0.35 the largest is 35 m2.
  const STEP_TOL = 0.35;
  const seen = new Set();
  const blobs = [];
  for (const k0 of cols.keys()) {
    if (seen.has(k0)) continue;
    const stack = [k0];
    seen.add(k0);
    const members = [];
    while (stack.length) {
      const k = stack.pop();
      const c = cols.get(k);
      members.push(c);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        if (!dx && !dz) continue;
        const nk = (c.cx + dx) + "," + (c.cz + dz);
        if (seen.has(nk)) continue;
        const nc = cols.get(nk);
        if (!nc || Math.abs(nc.top - c.top) > STEP_TOL) continue;
        seen.add(nk); stack.push(nk);
      }
    }
    if (members.length >= MIN_CELLS) blobs.push(members);
  }

  // 3. describe + classify
  const out = [];
  for (const members of blobs) {
    // Count enclosed holes as part of the footprint. A solid deck or patio has
    // no bare ground inside it, so the height field takes its top surface AS
    // the ground and only the rim registers as "above ground" — leaving the
    // biggest hardscape in the yard scored at a fraction of its real size,
    // which then loses the top-N ranking and misreports its area to the model.
    const occupied = new Set(members.map(c => c.cx + "," + c.cz));
    let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
    for (const c of members) {
      if (c.cx < bx0) bx0 = c.cx; if (c.cx > bx1) bx1 = c.cx;
      if (c.cz < bz0) bz0 = c.cz; if (c.cz > bz1) bz1 = c.cz;
    }
    const outside = new Set();
    const q = [];
    for (let x = bx0 - 1; x <= bx1 + 1; x++) {
      for (const z of [bz0 - 1, bz1 + 1]) { const k = x + "," + z; if (!outside.has(k)) { outside.add(k); q.push([x, z]); } }
    }
    for (let z = bz0 - 1; z <= bz1 + 1; z++) {
      for (const x of [bx0 - 1, bx1 + 1]) { const k = x + "," + z; if (!outside.has(k)) { outside.add(k); q.push([x, z]); } }
    }
    while (q.length) {
      const [x, z] = q.pop();
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz;
        if (nx < bx0 - 1 || nx > bx1 + 1 || nz < bz0 - 1 || nz > bz1 + 1) continue;
        const k = nx + "," + nz;
        if (outside.has(k) || occupied.has(k)) continue;
        outside.add(k); q.push([nx, nz]);
      }
    }
    let filled = members.length;
    for (let x = bx0; x <= bx1; x++) for (let z = bz0; z <= bz1; z++) {
      const k = x + "," + z;
      if (!occupied.has(k) && !outside.has(k)) filled++;
    }
    const area = filled * CELL * CELL;
    // Centroid from the actual points, not cell centres: snapping to a 0.5 m
    // lattice biases positions by up to ~0.5 m on a real capture.
    let sx = 0, sz = 0, top = 0, nPts = 0;
    const allH = [];
    for (const c of members) {
      sx += c.sx; sz += c.sz;
      nPts += c.hs.length;
      for (const h of c.hs) { allH.push(h); if (h > top) top = h; }
    }
    const cx = sx / nPts, cz = sz / nPts;

    // planar extents via 2D PCA on the column centres
    let vxx = 0, vxz = 0, vzz = 0;
    for (const c of members) {
      const dx = (c.cx + 0.5) * CELL - cx, dz = (c.cz + 0.5) * CELL - cz;
      vxx += dx * dx; vxz += dx * dz; vzz += dz * dz;
    }
    vxx /= members.length; vxz /= members.length; vzz /= members.length;
    const tr = vxx + vzz, det = vxx * vzz - vxz * vxz;
    const disc = Math.max(0, tr * tr / 4 - det);
    const l1 = Math.sqrt(Math.max(0, tr / 2 + Math.sqrt(disc)));
    const l2 = Math.sqrt(Math.max(0, tr / 2 - Math.sqrt(disc)));
    const elongation = l2 > 1e-6 ? l1 / l2 : 99;   // long+thin => large

    // How far the blob runs along its own long axis, and where its ends are.
    // A fence or a flight of steps can be 7-18 m long, so one pin at the
    // centre can sit 9 m from the end you actually meant ("the end of the
    // stairs"). Elongated structures get their ends marked instead.
    const ang = 0.5 * Math.atan2(2 * vxz, vxx - vzz);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    let tMin = Infinity, tMax = -Infinity;
    for (const c of members) {
      const t = ((c.cx + 0.5) * CELL - cx) * ca + ((c.cz + 0.5) * CELL - cz) * sa;
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
    }
    const span = tMax - tMin;
    // inset from the very tip so the marker still sits on the structure
    const endAt = t => [cx + ca * t, cz + sa * t];
    const ends = (elongation > 2.5 && span > 3)
      ? [endAt(tMin + span * 0.12), endAt(tMax - span * 0.12)]
      : null;

    // height structure: how much of the mass sits on flat levels, and whether
    // those levels are evenly stacked (a staircase)
    allH.sort((a, b) => a - b);
    const bin = 0.08;
    const hist = new Map();
    for (const h of allH) {
      const b = Math.round(h / bin);
      hist.set(b, (hist.get(b) ?? 0) + 1);
    }
    const peaks = [...hist.entries()]
      .filter(([, v]) => v > nPts * 0.05)
      .sort((a, b) => a[0] - b[0])
      .map(([b, v]) => ({ h: b * bin, v }));
    // A staircase is a RUN of consecutive risers of similar height. Collecting
    // every in-range gap regardless of adjacency invents staircases out of
    // unrelated levels that happen to sit a riser apart, so only consecutive
    // runs count.
    let evenSteps = 0;
    if (peaks.length >= 3) {
      let runStart = 0;
      for (let i = 1; i <= peaks.length; i++) {
        const gap = i < peaks.length ? peaks[i].h - peaks[i - 1].h : Infinity;
        if (gap >= 0.10 && gap <= 0.30) continue;      // run continues
        const runGaps = [];
        for (let j = runStart + 1; j < i; j++) runGaps.push(peaks[j].h - peaks[j - 1].h);
        if (runGaps.length >= 2) {
          const mean = runGaps.reduce((a, b) => a + b, 0) / runGaps.length;
          const spread = Math.max(...runGaps) - Math.min(...runGaps);
          if (spread < mean * 0.5) evenSteps = Math.max(evenSteps, runGaps.length + 1);
        }
        runStart = i;
      }
    }
    const topBand = allH.filter(h => h > top - 0.15).length / allH.length;

    let kind = "object";
    if (evenSteps >= 3) kind = "steps";
    else if (elongation > 3.5 && top > 0.7) kind = "wall_or_fence";
    else if (top < 0.8 && topBand > 0.35 && area >= 1.5) kind = "low_structure";
    else if (top >= 0.8 && topBand > 0.30 && area >= 3) kind = "platform";
    else if (top > 1.2 && topBand < 0.20) kind = "vegetation";

    const common = {
      kind,
      height_m: +top.toFixed(2),
      area_m2: +area.toFixed(1),
      elongation: +elongation.toFixed(1),
      span_m: +span.toFixed(1),
      levels: evenSteps,
      points: nPts,
      rank: area * Math.max(0.5, top),
    };
    const at = (px, pz, part) => ({
      ...common, part,
      x: +px.toFixed(2), y: +(-pz).toFixed(2),        // ENU: north = -z
      world: [+px.toFixed(2), +pz.toFixed(2)],
    });
    if (ends) {
      // both ends of a run; "middle of the fence" is rarely the thing you mean
      out.push(at(ends[0][0], ends[0][1], "end A"), at(ends[1][0], ends[1][1], "end B"));
    } else {
      out.push(at(cx, cz, "centre"));
    }
  }

  // biggest, most substantial things first
  out.sort((a, b) => b.rank - a.rank);
  return out.slice(0, maxCandidates).map((c, i) => {
    const { rank, ...rest } = c;
    return { id: i + 1, ...rest };
  });
}
