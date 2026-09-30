import * as THREE from "three";

// RANSAC plane fit on Float32Array positions (xyz triplets).
// Returns { normal: THREE.Vector3, d, inlierRatio } with n·p + d = 0,
// normal oriented so the majority of points are on the +n side (above ground).
export function ransacPlane(positions, iters = 600, thresh = 0.06) {
  const n = positions.length / 3;
  const p = i => new THREE.Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
  let best = null, bestCount = -1;
  let seed = 42;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let it = 0; it < iters; it++) {
    const a = p(Math.floor(rand() * n)), b = p(Math.floor(rand() * n)), c = p(Math.floor(rand() * n));
    const nrm = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (nrm.lengthSq() < 1e-12) continue;
    nrm.normalize();
    const d = -nrm.dot(a);
    let count = 0;
    for (let i = 0; i < n; i += 1) {
      const dist = Math.abs(nrm.x * positions[i * 3] + nrm.y * positions[i * 3 + 1] + nrm.z * positions[i * 3 + 2] + d);
      if (dist < thresh) count++;
    }
    if (count > bestCount) { bestCount = count; best = { normal: nrm.clone(), d }; }
  }
  // orient: majority of points above plane
  let above = 0;
  for (let i = 0; i < n; i++) {
    const s = best.normal.x * positions[i * 3] + best.normal.y * positions[i * 3 + 1] + best.normal.z * positions[i * 3 + 2] + best.d;
    if (s > 0) above++;
  }
  if (above < n / 2) { best.normal.negate(); best.d = -best.d; }
  return { ...best, inlierRatio: bestCount / n };
}

// Gravity-aware ground fit. ARKit-based captures (Scaniverse, Polycam) export
// gravity-aligned frames: true "up" is a coordinate axis even when the terrain
// slopes. Leveling to the terrain plane on a sloped yard tilts the whole scene
// (house, trees) the other way — so instead: peel several planes off with
// RANSAC, let horizontal-ish structure (lawn, roofs, decks) vote for the axis
// it clusters around, and snap "up" to that axis. The grid height comes from
// the biggest ground plane's median height. Falls back to the raw dominant
// plane when no axis has support (hand-rotated or cropped clouds).
export function fitGroundAuto(positions, { rounds = 6, axisTolDeg = 25, thresh = 0.06 } = {}) {
  const total = positions.length / 3;
  const planes = [];
  let rest = positions;
  for (let r = 0; r < rounds; r++) {
    const cnt = rest.length / 3;
    if (cnt < Math.max(2000, total * 0.03)) break;
    const { normal, d } = ransacPlane(rest, 600, thresh);
    const inl = new Float32Array(rest.length);
    const out = new Float32Array(rest.length);
    let ik = 0, ok = 0;
    for (let i = 0; i < cnt; i++) {
      const x = rest[i * 3], y = rest[i * 3 + 1], z = rest[i * 3 + 2];
      if (Math.abs(normal.x * x + normal.y * y + normal.z * z + d) < thresh) {
        inl[ik * 3] = x; inl[ik * 3 + 1] = y; inl[ik * 3 + 2] = z; ik++;
      } else {
        out[ok * 3] = x; out[ok * 3 + 1] = y; out[ok * 3 + 2] = z; ok++;
      }
    }
    planes.push({ normal, d, count: ik, pts: inl.slice(0, ik * 3) });
    rest = out.slice(0, ok * 3);
  }
  if (!planes.length) throw new Error("ground fit: no planes found");

  const cosTol = Math.cos(axisTolDeg * Math.PI / 180);
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const axisDot = (p, a) => p.normal.x * a[0] + p.normal.y * a[1] + p.normal.z * a[2];
  const weights = axes.map(a =>
    planes.reduce((w, p) => Math.abs(axisDot(p, a)) > cosTol ? w + p.count : w, 0));
  let bestAxis = 0;
  for (let i = 1; i < 3; i++) if (weights[i] > weights[bestAxis]) bestAxis = i;

  const biggest = planes[0];
  if (weights[bestAxis] < total * 0.08) {
    const bn = { x: biggest.normal.x, y: biggest.normal.y, z: biggest.normal.z };
    return { normal: bn, groundNormal: bn,
      d: biggest.d, snapped: false, slopeDeg: 0, inlierRatio: biggest.count / total };
  }
  const a = axes[bestAxis];
  const contrib = planes.filter(p => Math.abs(axisDot(p, a)) > cosTol);
  // Rank the horizontal planes by FOOTPRINT, not point count: a densely
  // scanned roof, deck or pool floor easily out-counts the lawn, but the
  // ground is what covers the site. Footprint = 2 m cells the inliers occupy.
  const [uu, vv] = [0, 1, 2].filter(i => i !== bestAxis);
  const footprintCells = p => {
    const c = new Set();
    for (let i = 0; i < p.count; i++)
      c.add(Math.round(p.pts[i * 3 + uu] / 2) + "," + Math.round(p.pts[i * 3 + vv] / 2));
    return c.size;
  };
  const foots = contrib.map(footprintCells);
  const widest = Math.max(...foots);
  const gi = foots.indexOf(widest);

  // Which way is up? Decide by scene occupancy against that widest plane, not
  // by the planes' own normals — ransacPlane orients a plane by the majority
  // of the points REMAINING in its peel round, which points a densely scanned
  // roof downward and would flip the whole frame. Above the ground there is a
  // house and trees; below it there is nothing.
  // Compare the two sides by FOOTPRINT again, not point count: what sits above
  // the ground (house, trees, fences) is spread across the whole site, while
  // what sits below it (a pool floor, a window well) is confined to a patch —
  // even when the patch is densely scanned.
  const ref = contrib[gi];
  let refProj = 0;
  for (let i = 0; i < ref.count; i++) refProj += ref.pts[i * 3 + bestAxis] / ref.count;
  const band = 0.5;
  const aboveCells = new Set(), belowCells = new Set();
  for (let i = 0; i < total; i++) {
    const dv = positions[i * 3 + bestAxis] - refProj;
    if (Math.abs(dv) < band) continue;                       // on the plane: no vote
    const cellKey = Math.round(positions[i * 3 + uu] / 2) + "," + Math.round(positions[i * 3 + vv] / 2);
    (dv > 0 ? aboveCells : belowCells).add(cellKey);
  }
  const s = aboveCells.size >= belowCells.size ? 1 : -1;
  const up = { x: a[0] * s, y: a[1] * s, z: a[2] * s };

  const medianHeight = p => {
    const hs = [];
    for (let i = 0; i < p.count; i++)
      hs.push(up.x * p.pts[i * 3] + up.y * p.pts[i * 3 + 1] + up.z * p.pts[i * 3 + 2]);
    hs.sort((q, w) => q - w);
    return hs[Math.floor(hs.length / 2)];
  };
  // among comparably-wide planes take the lowest (a sunken patio still reads
  // as ground; a roof does not)
  const minFoot = widest * 0.5;
  let ground = contrib[gi], h = medianHeight(ground);
  for (let i = 0; i < contrib.length; i++) {
    if (i === gi || foots[i] < minFoot) continue;
    const ph = medianHeight(contrib[i]);
    if (ph < h) { ground = contrib[i]; h = ph; }
  }
  // ransacPlane orients each plane so the majority of that round's remaining
  // points sit on its +n side, which points a shallow roof (or a patio cover
  // scanned from below) DOWNWARD — flip it so groundNormal's horizontal
  // component reliably points downhill.
  if (ground.normal.x * up.x + ground.normal.y * up.y + ground.normal.z * up.z < 0) {
    ground.normal.negate();
    ground.d = -ground.d;
  }
  const dotUp = ground.normal.x * up.x + ground.normal.y * up.y + ground.normal.z * up.z;
  return {
    normal: up, d: -h, snapped: true,
    // the main ground plane's own normal (stage frame) — its horizontal
    // component points downhill
    groundNormal: { x: ground.normal.x, y: ground.normal.y, z: ground.normal.z },
    slopeDeg: Math.acos(Math.min(1, Math.abs(dotUp))) * 180 / Math.PI,
    axisName: `${s > 0 ? "+" : "-"}${"xyz"[bestAxis]}`,
    inlierRatio: ground.count / total,
  };
}

// Quaternion + offset that maps the fitted plane onto world y=0 (three.js y-up).
// 2D similarity (Umeyama) mapping src -> dst, arrays of [x, z] ground coords.
// Returns { s, theta, tx, tz, residuals } with dst ~ s*R(theta)@src + t.
export function umeyama2d(src, dst, withScale = false) {
  const n = src.length;
  const mean = pts => pts.reduce((a, p) => [a[0] + p[0] / n, a[1] + p[1] / n], [0, 0]);
  const ms = mean(src), md = mean(dst);
  let sxx = 0, sxz = 0, szx = 0, szz = 0, varS = 0;
  for (let i = 0; i < n; i++) {
    const a = [src[i][0] - ms[0], src[i][1] - ms[1]];
    const b = [dst[i][0] - md[0], dst[i][1] - md[1]];
    sxx += b[0] * a[0]; sxz += b[0] * a[1]; szx += b[1] * a[0]; szz += b[1] * a[1];
    varS += a[0] * a[0] + a[1] * a[1];
  }
  // rotation via atan2 of the 2x2 covariance (proper rotation, no reflection)
  const theta = Math.atan2(szx - sxz, sxx + szz);
  const cos = Math.cos(theta), sin = Math.sin(theta);
  let s = 1;
  if (withScale) {
    // trace(D S) equivalent: project covariance onto rotation
    s = ((sxx + szz) * cos + (szx - sxz) * sin) / varS;
  }
  const tx = md[0] - s * (cos * ms[0] - sin * ms[1]);
  const tz = md[1] - s * (sin * ms[0] + cos * ms[1]);
  const residuals = src.map((p, i) => {
    const mx = s * (cos * p[0] - sin * p[1]) + tx;
    const mz = s * (sin * p[0] + cos * p[1]) + tz;
    return Math.hypot(mx - dst[i][0], mz - dst[i][1]);
  });
  return { s, theta, tx, tz, residuals };
}
