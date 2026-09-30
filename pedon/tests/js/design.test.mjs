// node --test tests/js/
//
// What this file is for: design.js paints ground surfaces with a generated
// grain texture, and a texture only reads as ground if one tile is the same
// REAL SIZE everywhere. bedMesh, patioMesh and pathMesh must share tiling in
// metres: on walk_dining_to_firepit (10.95 m long, 1.1 m wide), tiles measuring
// 1.430 m across and 0.989 m along mean a 1.45x stretch on the surface you
// walk closest to. Execute the mesh builders to measure the texture scale.
import { needsSite, HAS_SITE } from "./lib/site.mjs";   // about a real site
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataPath } from "../../viewer/project_paths.js";   // the active site's files

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// design.js draws its grain into a 2D canvas. node has no DOM, so stand in a
// recorder rather than a no-op: keeping the fillRect calls is what lets a test
// read back the base colour a surface was painted with, which is the only way
// to tell a real material from the fallback grey without a GPU.
globalThis.document = {
  createElement() {
    const ops = [];
    const ctx = { fillStyle: "#000000", fillRect: (x, y, w, h) => ops.push({ style: ctx.fillStyle, x, y, w, h }) };
    return { width: 0, height: 0, ops, getContext: () => ctx };
  },
};

const design = await import(path.join(ROOT, "viewer", "src", "design.js"));
const flat = () => 0;                       // tests measure PLAN metres, so keep ground level
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "schema", "design.schema.json"), "utf8"));
// The PINNED fixture, not data/design.json. This file measures the UVs of a
// specific path by id, and data/design.json is the owner's working file, where
// paths can be renamed. A pinned input keeps these tests about stretched
// textures rather than changes to the working design. Same fixture the
// python arrangement tests use, so both suites reason about one known design.
const liveDesign = JSON.parse(fs.readFileSync(
  path.join(ROOT, "tests", "fixtures", "scattered_design.json"), "utf8"));

/** The colour a surface was painted with: groundTexture's first full-canvas fill. */
function baseHex(mesh) {
  const ops = mesh.material.map?.image?.ops ?? [];
  const fill = ops.find(o => o.x === 0 && o.y === 0 && o.w === o.h && o.w > 1);
  return fill ? fill.style.replace("#", "").toLowerCase() : null;
}

/**
 * Every triangle of a mesh as three vertex records, indexed or not.
 *
 * One iterator, because every measurement below walks the same triples.
 * Shared indexing prevents copies from disagreeing about row order.
 * A geometry with no uv reports u=v=0, which the caller can assert on
 * rather than crashing.
 */
function* triVerts(mesh) {
  const g = mesh.geometry, pos = g.attributes.position, uv = g.attributes.uv, idx = g.index;
  const n = idx ? idx.count : pos.count;
  const at = j => ({ x: pos.getX(j), y: pos.getY(j), z: pos.getZ(j),
                     u: uv ? uv.getX(j) : 0, v: uv ? uv.getY(j) : 0 });
  for (let i = 0; i + 2 < n; i += 3)
    yield [0, 1, 2].map(k => at(idx ? idx.getX(i + k) : i + k));
}

/**
 * Metres of real ground per texture tile, along each UV axis.
 *
 * Per triangle, solve the affine map from UV to POSITION and take the two
 * column magnitudes: |dP/du| is metres per UV unit across, |dP/dv| along.
 * Tiles per UV unit is the texture's repeat, so m/tile = |dP/duv| / repeat.
 * Doing it from the Jacobian rather than from a known vertex layout means the
 * same measurement works on a draped polygon and on a swept ribbon.
 *
 * All three axes, not plan: a wall face is VERTICAL, so its dP/dv has no plan
 * projection at all and a plan-only Jacobian reports the stone wall at 0.000
 * metres per tile up the face — a division by zero expressed as a stretch of
 * Infinity. On ground the two agree to the cosine of the slope.
 */
function tileMetres(mesh) {
  assert.ok(mesh.geometry.attributes.uv, "geometry carries no uv attribute — nothing can tile correctly");
  const rep = mesh.material.map.repeat;
  const us = [], vs = [];
  for (const p of triVerts(mesh)) {
    const du1 = p[1].u - p[0].u, dv1 = p[1].v - p[0].v;
    const du2 = p[2].u - p[0].u, dv2 = p[2].v - p[0].v;
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-12) continue;
    const d1 = sub(p[1], p[0]), d2 = sub(p[2], p[0]);
    const col = (a, b) => Math.hypot((d1.x * a + d2.x * b) / det,
                                     (d1.y * a + d2.y * b) / det,
                                     (d1.z * a + d2.z * b) / det);
    us.push(col(dv2, -dv1) / rep.x);
    vs.push(col(-du2, du1) / rep.y);
  }
  assert.ok(us.length, "no non-degenerate triangles to measure");
  const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  return { u: med(us), v: med(vs), uMin: Math.min(...us), uMax: Math.max(...us),
           vMin: Math.min(...vs), vMax: Math.max(...vs), tris: us.length };
}

/**
 * A swept ribbon's vertices, grouped into stations: one row per cross-section,
 * left edge to right edge.
 *
 * pathMesh emits `cols` vertices per station and cols follows the path's width
 * — a 1.1 m walk gets 3, a 2.4 m terrace walk 5 — so nothing may assume the
 * one-vertex-per-edge layout. u restarts at 0 on each station, which is
 * what identifies a row boundary.
 */
function ribbonRows(mesh) {
  const g = mesh.geometry, pos = g.attributes.position, uv = g.attributes.uv;
  let cols = 1;
  while (cols < pos.count && uv.getX(cols) !== 0) cols++;
  assert.ok(cols >= 2 && pos.count % cols === 0,
    `${pos.count} ribbon vertices do not divide into stations of ${cols}`);
  const rows = [];
  for (let i = 0; i + cols - 1 < pos.count; i += cols)
    rows.push(Array.from({ length: cols }, (_, k) => ({
      x: pos.getX(i + k), y: pos.getY(i + k), z: pos.getZ(i + k),
      u: uv.getX(i + k), v: uv.getY(i + k) })));
  return { cols, rows };
}

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

const skew = m => Math.abs(m.u - m.v) / ((m.u + m.v) / 2);

test("a path tiles at the same real size across as along", () => {
  const p = liveDesign.paths.find(x => x.id === "walk_dining_to_firepit");
  assert.ok(p, "data/design.json no longer has walk_dining_to_firepit");
  const m = tileMetres(design.pathMesh(p, flat));
  console.log(`  walk_dining_to_firepit (${p.width_m} m ${p.material}, ${p.spline.length} pts): ` +
    `${m.u.toFixed(3)} m/tile across vs ${m.v.toFixed(3)} m/tile along ` +
    `= ${(m.u / m.v).toFixed(3)}x  [along varies ${m.vMin.toFixed(3)}-${m.vMax.toFixed(3)}: ` +
    `this spline turns at 0.832 m radius, so its inner and outer edges run 0.34-1.66x the centreline]`);
  assert.ok(skew(m) < 0.01, `path grain stretched ${(m.u / m.v).toFixed(3)}x: ` +
    `${m.u.toFixed(3)} m/tile across, ${m.v.toFixed(3)} m/tile along`);
});

test("a path's UVs are metres of real ground, not curve parameter", () => {
  // The median check above only pins the AVERAGE scale, so on its own a
  // parameter-based v with a luckier constant would still pass while the grain
  // stretched 3.4x between control points (CatmullRomCurve3 is not arc-length
  // parameterised: the same t step covers 0.0695 m in one place on this spline
  // and 0.2397 m in another). This pins the scale station by station.
  const p = liveDesign.paths.find(x => x.id === "walk_dining_to_firepit");
  const { cols, rows } = ribbonRows(design.pathMesh(p, flat));
  let worst = 0, prev = null;
  rows.forEach((r, n) => {
    for (const q of r) assert.equal(q.v, r[0].v, `station ${n}: a vertex sits at a different station`);
    for (let k = 1; k < cols; k++)
      assert.ok(r[k].u > r[k - 1].u, `station ${n}: u does not advance across the ribbon`);
    const across = r[cols - 1].u - r[0].u;
    assert.ok(Math.abs(across - p.width_m) < 1e-6,
      `station ${n}: u spans ${across} for a ${p.width_m} m path`);
    const c = { x: (r[0].x + r[cols - 1].x) / 2, z: (r[0].z + r[cols - 1].z) / 2 };
    if (prev) worst = Math.max(worst,
      Math.abs((r[0].v - prev.v) - Math.hypot(c.x - prev.x, c.z - prev.z)));
    prev = { ...c, v: r[0].v };
  });
  // 0.1 mm: positions come back through a Float32BufferAttribute, so ~1e-5 m of
  // rounding is unavoidable at an 11 m station. A parameter-based v would be
  // out by up to 0.09 m here, 900x this.
  console.log(`  v advances with the centreline to within ${worst.toExponential(1)} m`);
  assert.ok(worst < 1e-4, `v drifts ${worst} m from real arc length`);
});

test("a long thin patio and bed tile squarely", () => {
  // 8 x 2 m: if UVs came from the outline rather than from metres, a 4:1
  // rectangle is where it shows
  const poly = [[0, 0], [8, 0], [8, 2], [0, 2]];
  for (const [what, mesh] of [
    ["patio", design.patioMesh({ id: "t", polygon: poly, material: "flagstone" }, flat)],
    ["bed", design.bedMesh({ id: "t", polygon: poly }, flat)],
  ]) {
    const m = tileMetres(mesh);
    console.log(`  ${what} 8x2 m: ${m.u.toFixed(3)} across / ${m.v.toFixed(3)} along ` +
      `(spread ${m.uMin.toFixed(3)}-${m.uMax.toFixed(3)})`);
    assert.ok(skew(m) < 0.01, `${what} grain stretched ${(m.u / m.v).toFixed(3)}x`);
  }
});

test("the same material tiles and colours the same whichever op drew it", () => {
  // decomposed_granite is decomposed_granite: a walk and a terrace laid in it
  // must not read as two different surfaces where they meet
  const asPath = design.pathMesh(
    { id: "a", spline: [[0, 0], [0, 10]], width_m: 1.2, material: "decomposed_granite" }, flat);
  const asPatio = design.patioMesh(
    { id: "b", polygon: [[0, 0], [6, 0], [6, 6], [0, 6]], material: "decomposed_granite" }, flat);
  const a = tileMetres(asPath), b = tileMetres(asPatio);
  console.log(`  decomposed_granite: path ${a.u.toFixed(3)} m/tile, patio ${b.u.toFixed(3)} m/tile; ` +
    `colour #${baseHex(asPath)} vs #${baseHex(asPatio)}`);
  assert.equal(baseHex(asPath), baseHex(asPatio), "same material, different grain texture");
  assert.ok(Math.abs(a.u - b.u) / b.u < 0.01,
    `same material tiled at ${a.u.toFixed(3)} m as a path and ${b.u.toFixed(3)} m as a patio`);
});

test("every surface material in the schema resolves to its own ground surface", () => {
  // A colour-only check can accept a missing material: without `lawn` in the
  // table, its fallback is bark brown rather than grey, but still wrong.
  // Assert the identity: a schema material must resolve to the entry of its
  // own name, never to a substitute.
  const kinds = [
    ["paths", m => design.pathMesh({ id: "p", spline: [[0, 0], [0, 6]], width_m: 1.2, material: m }, flat)],
    ["patios", m => design.patioMesh({ id: "q", polygon: [[0, 0], [5, 0], [5, 5], [0, 5]], material: m }, flat)],
  ];
  //
  // Material is FREE TEXT: the library must not cap the design or prevent a
  // brick path, a stone-sett nobedan or a pebble-mosaic court. The schema NAMES
  // the modelled materials in its description instead of fencing the field.
  // A material we advertise as modelled must draw as itself.
  const named = (key) => {
    const f = schema.properties[key].items.properties.material;
    assert.ok(!f.enum, `${key}.material must remain free text so the library does not cap the design`);
    const found = Object.keys(design.GROUND_SURFACES).filter(m => (f.description ?? "").includes(m));
    assert.ok(found.length >= 5, `the schema names only ${found.length} modelled ${key} materials`);
    return found;
  };
  const bad = [];
  for (const [key, build] of kinds) {
    for (const material of named(key)) {
      const got = build(material).material.userData.surface;
      if (got !== material) bad.push(`${key}:${material} -> ${got}`);
    }
  }
  assert.deepEqual(bad, [], `schema materials with no ground surface of their own: ${bad.join(", ")}`);
});

test("a material nobody modelled still draws, and does not draw as a lie", () => {
  // Free-text materials must render. A brick path must RENDER — falling over
  // or vanishing would make free text worse than the enum — but it must not
  // silently claim to be the surface it borrowed, or the want list has nothing to
  // report and the owner is shown a substitution as if it were their design.
  for (const material of ["brick", "stone_sett", "pebble_mosaic", "timber_boardwalk"]) {
    const mesh = design.pathMesh(
      { id: "p", spline: [[0, 0], [0, 6]], width_m: 1.2, material }, flat);
    assert.ok(mesh?.geometry?.attributes?.position?.count > 6,
      `a ${material} path renders no geometry at all`);
    assert.notEqual(mesh.material.userData.surface, material,
      `${material} claims to be its own modelled surface — then it is not a want`);
    assert.ok(design.GROUND_SURFACES[mesh.material.userData.surface],
      `${material} fell back to "${mesh.material.userData.surface}", which is not a real surface`);
  }
});

test("a gravel-mulched bed does not render as dark bark", () => {
  // bed.mulch is a free-text string the model writes; the live designs contain
  // "3/8 in crushed granite fines" and "shredded cedar bark" side by side, and
  // rendering both as 0x4a3423 bark loses the whole distinction
  const bark = baseHex(design.bedMesh({ id: "a", polygon: [[0, 0], [4, 0], [4, 4], [0, 4]], mulch: "shredded cedar bark" }, flat));
  const grit = baseHex(design.bedMesh({ id: "b", polygon: [[0, 0], [4, 0], [4, 4], [0, 4]], mulch: "3/8 in crushed granite fines" }, flat));
  console.log(`  mulch: bark #${bark}, crushed granite #${grit}`);
  assert.notEqual(grit, bark, "every mulch renders as the same dark brown");
});

test("ground textures are anisotropically filtered", () => {
  // a walk seen down its length is the worst case for a mipmapped ground
  // texture: at grazing angles isotropic filtering blurs the grain to mud
  const meshes = {
    bed: design.bedMesh({ id: "a", polygon: [[0, 0], [4, 0], [4, 4], [0, 4]] }, flat),
    patio: design.patioMesh({ id: "b", polygon: [[0, 0], [4, 0], [4, 4], [0, 4]], material: "flagstone" }, flat),
    path: design.pathMesh({ id: "c", spline: [[0, 0], [0, 8]], width_m: 1.2, material: "gravel" }, flat),
  };
  for (const [what, m] of Object.entries(meshes))
    assert.ok(m.material.map.anisotropy > 1, `${what} texture anisotropy is ${m.material.map.anisotropy}`);
});

test("all three ground meshes come from the one material factory", () => {
  // the DRY guard: makeGroundMaterial stamps the resolved surface name, so a
  // future hand-rolled ground material is detectable rather than merely
  // slightly different-looking
  const meshes = {
    bed: design.bedMesh({ id: "a", polygon: [[0, 0], [4, 0], [4, 4], [0, 4]] }, flat),
    patio: design.patioMesh({ id: "b", polygon: [[0, 0], [4, 0], [4, 4], [0, 4]], material: "deck" }, flat),
    path: design.pathMesh({ id: "c", spline: [[0, 0], [0, 8]], width_m: 1.2, material: "paver" }, flat),
  };
  for (const [what, m] of Object.entries(meshes))
    assert.ok(m.material.userData.surface, `${what} material was not made by makeGroundMaterial`);
  assert.equal(meshes.patio.material.userData.surface, "deck");
  assert.equal(meshes.path.material.userData.surface, "paver");
});

test("every surface the saved designs actually name resolves without a warning", needsSite, () => {
  // bed.mulch is free text, so the only honest coverage check is the corpus the
  // model has already written: 25 distinct strings across the saved variants,
  // from "shredded cedar bark" to "washed river cobble and pale gravel, raked
  // as a dry watercourse". Anything that falls through warns, and a warning
  // here means a bed rendering as the wrong ground.
  const files = [dataPath("design.json"),
    ...fs.readdirSync(dataPath("designs")).filter(f => f.endsWith(".json"))
        .map(f => dataPath("designs", f))];
  const warned = [];
  const realWarn = console.warn;
  console.warn = msg => warned.push(String(msg));
  let n = 0;
  try {
    for (const f of files) {
      const d = JSON.parse(fs.readFileSync(f, "utf8"));
      for (const b of d.beds ?? []) { design.bedMesh(b, flat); n++; }
      for (const q of d.patios ?? []) { design.patioMesh(q, flat); n++; }
      for (const w of d.paths ?? []) { design.pathMesh(w, flat); n++; }
    }
  } finally { console.warn = realWarn; }
  console.log(`  ${n} ground surfaces across ${files.length} saved designs, ${warned.length} unresolved`);
  assert.deepEqual([...new Set(warned)], []);
});

// ── draping onto real ground ───────────────────────────────────────────────
//
// The second thing a ground surface has to get right, after tiling: it has to
// BE where the ground is. A 1.5 m max edge in drapedPolygon is coarser than the
// 0.75 m cells of the height field terrain.js builds — every vertex can sit
// exactly on the ground while the surface between them cuts the chord, which
// no vertex-based check can see. Measurements against data/terrain_scan.json
// (603 scanned cells, bilinear through tools/agent.scan_at, 4000 random spans
// per length, all three points strictly inside coverage; the error is the
// span's midpoint against the mean of its two ends):
//
//     span 3.000 m   mean 8.13 cm   p90 23.97 cm
//     span 1.500 m   mean 3.74 cm   p90 10.66 cm   <- coarser than the field
//     span 0.750 m   mean 1.19 cm   p90  3.07 cm   <- the height field's cell
//     span 0.375 m   mean 0.32 cm   p90  0.72 cm
//
// The 1.5 m max edge loses ~9 cm of measured relief at p90.
// The thresholds below (mean 2 cm, p90 5 cm) come from those two rows: they
// sit between what a 1.5 m span costs on this ground and what a 0.75 m one
// costs, so they are a statement about the terrain, not about the code.
//
// pathMesh also needs samples across its width: TWO vertices per station, one
// per edge, make a path of any width a single chord across its own cross-slope
// with no interior sample. More stations along the path cannot fix that.

const scan = HAS_SITE ? JSON.parse(fs.readFileSync(dataPath("terrain_scan.json"), "utf8")) : null;   // the owner's ground, used as terrain (skipped without a site)

/**
 * The source of a top-level `function NAME(...) {...}` in a file.
 *
 * Used to borrow main.js's own scanHeight() rather than duplicating the
 * height-field indexing and risking reversed row order. main.js cannot be
 * imported (it builds a WebGLRenderer at module scope).
 * tests/js/clean_scene.test.mjs lifts withCleanScene() out of the same file
 * the same way.
 */
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `main.js no longer defines ${name}() — this test must fail, not skip`);
  let depth = 0;
  for (let j = src.indexOf("{", start); j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`${name}() has no closing brace`);
}

const mainSrc = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const scanHeight = scan && new Function("scanGrid",
  `${extractFn(mainSrc, "scanHeight")}\nreturn scanHeight;`)(scan);

// main.js's heightAt closure, minus its BFS fallback: the mesh builders are
// handed WORLD (x, z) and the scan is indexed in ENU, where y = -z. Anything
// off the scan is a broken fixture, not a result — say so loudly rather than
// draping onto NaN.
function ground(x, z) {
  const h = scanHeight(x, -z);
  assert.ok(h !== null && h !== undefined, `test surface runs off the scan at ${x}, ${z}`);
  return h;
}

// A 7x7 m window of the scan with every cell measured, ENU x 3..9, y 5..11.
// Picked for CURVATURE, not slope: chord error is a second difference, so the
// steepest fully-scanned patch on this site (3.58 m of relief at 11.5, 6.5) is
// a near-planar ramp that a 3 m edge would drape correctly. This one has the
// highest mean |discrete Laplacian| of any fully-scanned window, 0.696 m.
const TEST_BED = [[3.5, 5.5], [8.5, 5.5], [8.5, 10.5], [3.5, 10.5]];   // 25 m2
const TEST_SPLINE = [[4, 6], [6, 8], [8, 10]];                          // 5.7 m diagonal

const stats = a => {
  const s = [...a].sort((x, y) => x - y);
  return { n: s.length, mean: s.reduce((t, v) => t + v, 0) / s.length,
           p50: s[Math.floor(s.length * 0.5)], p90: s[Math.floor(s.length * 0.9)], max: s[s.length - 1] };
};

/**
 * How far a built surface departs from the ground it was draped onto, sampled
 * INSIDE each triangle.
 *
 * Sampling at vertices proves nothing — a vertex is exact by construction at
 * any subdivision, so even a 1.5 m drape can pass a vertex-only check.
 * The samples are each triangle's centroid and its three edge midpoints;
 * an edge midpoint is literally the span-midpoint error derived above.
 *
 * The builders lift a surface a few cm clear of the terrain (0.02-0.03 m).
 * That lift is read back off the mesh's own vertices rather than copied from
 * design.js, so this cannot drift out of step with it.
 */
function drapeError(mesh, groundAt) {
  const BARY = [[1 / 3, 1 / 3, 1 / 3], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5]];
  const lifts = [], samples = [];
  let longestEdge = 0, tris = 0;
  for (const p of triVerts(mesh)) {
    for (let e = 0; e < 3; e++) {
      const q = p[(e + 1) % 3];
      longestEdge = Math.max(longestEdge, Math.hypot(p[e].x - q.x, p[e].z - q.z));
    }
    if (Math.abs((p[1].x - p[0].x) * (p[2].z - p[0].z) -
                 (p[2].x - p[0].x) * (p[1].z - p[0].z)) < 1e-9) continue;   // degenerate
    tris++;
    for (const q of p) lifts.push(q.y - groundAt(q.x, q.z));
    for (const [a, b, c] of BARY) {
      const x = a * p[0].x + b * p[1].x + c * p[2].x;
      const z = a * p[0].z + b * p[1].z + c * p[2].z;
      samples.push({ y: a * p[0].y + b * p[1].y + c * p[2].y, h: groundAt(x, z) });
    }
  }
  assert.ok(tris, "no non-degenerate triangles to measure");
  const lift = stats(lifts).p50;
  return { ...stats(samples.map(s => Math.abs(s.y - s.h - lift))), lift, tris, longestEdge };
}

const show = (what, e) => console.log(`  ${what}: ${e.tris} tris, longest edge ${e.longestEdge.toFixed(2)} m, ` +
  `lift ${(e.lift * 100).toFixed(1)} cm; off the scanned ground by mean ${(e.mean * 100).toFixed(2)} cm, ` +
  `p50 ${(e.p50 * 100).toFixed(2)}, p90 ${(e.p90 * 100).toFixed(2)}, max ${(e.max * 100).toFixed(2)}`);

// max is deliberately not asserted anywhere below: the scan is bilinear over a
// 1 m grid, so it has creases at cell boundaries, and a triangle straddling one
// cannot follow it however fine it gets. Measured, max stays 10-18 cm at ANY
// subdivision — asserting on it would be asserting on the interpolant.
const follows = (what, e) => {
  assert.ok(e.mean < 0.02, `${what} averages ${(e.mean * 100).toFixed(1)} cm off the ground it drapes onto`);
  assert.ok(e.p90 < 0.05, `${what} is ${(e.p90 * 100).toFixed(1)} cm off at p90`);
};

test("a draped bed and patio follow the real ground between their vertices", needsSite, () => {
  for (const [what, mesh] of [
    ["bed", design.bedMesh({ id: "t", polygon: TEST_BED }, ground)],
    ["patio", design.patioMesh({ id: "t", polygon: TEST_BED, material: "flagstone" }, ground)],
  ]) {
    const e = drapeError(mesh, ground);
    show(what, e);
    follows(what, e);
  }
});

test("a path follows the ground across its own width", needsSite, () => {
  // 2.4 m is about the corpus's widest (terrace_pad, 2.2 m); 1.1 m is the
  // width of nearly every walk in it, including walk_dining_to_firepit
  for (const width_m of [2.4, 1.1]) {
    const e = drapeError(design.pathMesh(
      { id: "t", spline: TEST_SPLINE, width_m, material: "gravel" }, ground), ground);
    show(`${width_m} m path`, e);
    follows(`${width_m} m path`, e);
  }
});

test("a path crossing a ridge is not a chord over the crest", () => {
  // The unmissable case, analytic so the answer is exact: a smooth ridge whose
  // crest runs ALONG the path, so every cross-section is a peak. With one
  // vertex per edge the ribbon is a straight chord from edge to edge and the
  // crest stands up through the middle of the paving — no amount of stations
  // along the path helps, because the missing samples are across it.
  const ridge = (x, z) => 0.5 * Math.exp(-(x * x) / (2 * 1.2 * 1.2));
  for (const width_m of [2.4, 1.1]) {
    const e = drapeError(design.pathMesh(
      { id: "t", spline: [[0, -6], [0, 0], [0, 6]], width_m, material: "gravel" }, ridge), ridge);
    const chord = ridge(0, 0) - ridge(width_m / 2, 0);   // exact error of a 2-vertex station
    console.log(`  ${width_m} m path over a 0.5 m ridge: max ${(e.max * 100).toFixed(1)} cm, ` +
      `${e.tris} tris (a single edge-to-edge chord buries the crest by ${(chord * 100).toFixed(1)} cm)`);
    // analytic ground, no interpolant creases, so max IS assertable here
    assert.ok(e.max < 0.05, `${width_m} m path is ${(e.max * 100).toFixed(1)} cm off the ridge it crosses`);
  }
});

test("every ground surface samples at the height field's own resolution", needsSite, () => {
  // The structural requirement, stated on the geometry rather than on
  // a constant: terrain.js builds the field at 0.75 m cells, so a surface that
  // spans more than that between samples is interpolating across data it could
  // have asked for.
  const CELL_M = 0.75;
  const bad = [];
  const check = (what, got) => { console.log(`  ${what}: ${got.toFixed(2)} m`); if (got > CELL_M + 1e-6) bad.push(`${what} ${got.toFixed(2)} m`); };

  for (const [what, mesh] of [
    ["bed, longest triangle edge", design.bedMesh({ id: "a", polygon: TEST_BED }, ground)],
    ["patio, longest triangle edge", design.patioMesh({ id: "b", polygon: TEST_BED, material: "flagstone" }, ground)],
  ]) check(what, drapeError(mesh, ground).longestEdge);

  // A ribbon is a grid, so check spacing both across its width and along its
  // stations. One span across the width misses interior ground. Along the run,
  // spacing based on control-point COUNT gets coarser on longer, straighter
  // paths: a 24-division floor on the 2-point 56 m traverse below samples every
  // 2.36 m. The saved corpus tops out at 0.58 m, so this also checks longer runs.
  const spacing = mesh => {
    const { cols, rows } = ribbonRows(mesh);
    let across = 0, along = 0;
    rows.forEach((r, n) => {
      for (let k = 1; k < cols; k++)
        across = Math.max(across, Math.hypot(r[k].x - r[k - 1].x, r[k].z - r[k - 1].z));
      if (n) along = Math.max(along, Math.abs(r[0].v - rows[n - 1][0].v));
    });
    return { cols, across, along };
  };
  for (const p of [{ id: "c", spline: TEST_SPLINE, width_m: 2.4, material: "gravel" },
                   { id: "d", spline: TEST_SPLINE, width_m: 1.1, material: "gravel" }]) {
    const r = spacing(design.pathMesh(p, ground));
    check(`${p.width_m} m path, across (${r.cols} vertices per station)`, r.across);
    check(`${p.width_m} m path, along`, r.along);
  }
  const long = spacing(design.pathMesh(
    { id: "e", spline: [[-20, -20], [20, 20]], width_m: 1.0, material: "gravel" }, () => 0));
  check("2-point 56 m traverse, along", long.along);

  assert.deepEqual(bad, [], `sampled coarser than the ${CELL_M} m field: ${bad.join("; ")}`);
});

test("the drape stays affordable — triangle budget across every saved design", needsSite, () => {
  // Count the cost of finer draping, even on an 11-43 m2 bed. Halving the max
  // edge uses 4x the triangles: 690,096 -> 2,749,728 over the measured corpus;
  // worst single surface bed_west_grove
  // (masterplan.json, 691 m2) 30,720 -> 122,880; worst single design
  // masterplan.json 71,616 -> 285,312, and only one design is ever loaded at a
  // time. The bounds below allow ~25% headroom over the finer drape.
  //
  // The waste is real but is NOT the max edge: subdivision is uniform, so one
  // long chord in the fan triangulation of a Chaikin-smoothed outline splits
  // every small triangle with it. Adaptive per-edge subdivision would fix that
  // without T-junctions.
  const files = [dataPath("design.json"),
    ...fs.readdirSync(dataPath("designs")).filter(f => f.endsWith(".json"))
        .map(f => dataPath("designs", f))];
  const count = m => (m.geometry.index?.count ?? m.geometry.attributes.position.count) / 3;
  let total = 0, n = 0, worst = { tris: 0 }, worstFile = { tris: 0 };
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    let here = 0;
    for (const [kind, list, build] of [
      ["bed", d.beds ?? [], b => design.bedMesh(b, flat)],
      ["patio", d.patios ?? [], q => design.patioMesh(q, flat)],
      ["path", d.paths ?? [], w => design.pathMesh(w, flat)],
    ]) for (const item of list) {
      const tris = count(build(item));
      total += tris; here += tris; n++;
      if (tris > worst.tris) worst = { tris, kind, id: item.id, file: path.basename(f) };
    }
    if (here > worstFile.tris) worstFile = { tris: here, file: path.basename(f) };
  }
  console.log(`  ${total} triangles over ${n} ground surfaces in ${files.length} designs; ` +
    `worst surface ${worst.kind} ${worst.id} (${worst.file}) ${worst.tris}; ` +
    `worst design ${worstFile.file} ${worstFile.tris}`);
  assert.ok(worst.tris < 155000, `one surface is ${worst.tris} triangles`);
  assert.ok(worstFile.tris < 360000, `${worstFile.file} is ${worstFile.tris} triangles`);
});

// ── hardscape: a wall that reads as BUILT ──────────────────────────────────
//
// edgeMesh must build a solid with a material map. Representing the 5.23 m
// wall_firepit_uphill stone retaining wall as a zero-thickness strip of
// 96 triangles in flat #9a958a loses the features that make it read as stone:
// thickness keeps it visible edge-on and lights its sides separately; a top
// distinguishes a wall from a fence panel; courses show the stone units.
// Execute edgeMesh to measure these features.
//
// What a wall has to BE, and how each half is measured here — all of it off
// the built mesh, none of it off the table that fed it:
//   thickness  the mesh's extent across its own run equals the material's
//   a top      up-facing triangle area equals run length x thickness
//   closure    signed volume is positive (wound outwards, so it can be a solid
//              rather than a DoubleSide sheet) and equals L x t x h. A paper
//              ribbon encloses exactly nothing.
//   courses    metres of real wall per texture tile / bands drawn into it =
//              the height the unit is actually sold in
//   a foot     no base vertex above the ground under IT rather than under the
//              centreline — sample the whole shape, including its width

/** Each triangle's unit normal, area, and its share of the enclosed volume. */
function faces(mesh) {
  const out = [];
  for (const [a, b, c] of triVerts(mesh)) {
    const n = cross(sub(b, a), sub(c, a));
    const len = Math.hypot(n.x, n.y, n.z);
    if (len < 1e-12) continue;                                  // degenerate
    out.push({ area: len / 2, n: { x: n.x / len, y: n.y / len, z: n.z / len },
               vol: dot(a, cross(b, c)) / 6 });
  }
  return out;
}

const axis = { x: (p, i) => p.getX(i), y: (p, i) => p.getY(i), z: (p, i) => p.getZ(i) };
function extent(mesh, which) {
  const pos = mesh.geometry.attributes.position;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const v = axis[which](pos, i);
    lo = Math.min(lo, v); hi = Math.max(hi, v);
  }
  return { lo, hi, span: hi - lo, n: pos.count };
}

// A 6 m wall running due north. Its cross-section then lies on the world x
// axis (side = up x tangent), so "how thick is it" is just the x extent.
const wall = (over = {}) => ({ id: "w", spline: [[0, 0], [0, 6]], height_m: 0.7, material: "stone", ...over });
// Every schema edge material EXCEPT the ones that are laid rather than built.
// `boulder` is set stone armouring a slope toe: irregular by design, not a closed
// solid, and not a constant thickness — so the wall assertions below are not
// merely inconvenient for it, they are the wrong questions. Its own shape is
// checked in tests/js/edging.test.mjs. Derived from design.js's own ROCK_EDGES
// and asserted non-empty, so a material cannot quietly escape the wall checks by
// being added to that set: doing so moves it to a suite, not out of testing.
const LAID = design.ROCK_EDGES ?? new Set();
// The MODELLED wall materials, minus the laid ones. Read from design.js's own
// table rather than a schema enum: edge material is free text because the
// library must not cap the design — a gabion is a real retaining system. So
// the schema names what is modelled instead of fencing the field. What these
// tests check is that a wall we claim to model is built of something
// real and renders at its stated thickness.
const WALL_MATERIALS = Object.keys(design.WALL_SURFACES).filter(m => !LAID.has(m));

test("laid materials are excluded from the wall checks on purpose, not by omission", needsSite, () => {
  assert.ok(LAID.size > 0, "design.js publishes no ROCK_EDGES set");
  const field = schema.properties.edges.items.properties.material;
  assert.ok(!field.enum, "edge material must remain free text so the library does not cap the design");
  for (const m of LAID) {
    assert.ok((field.description ?? "").includes(m),
      `${m} is treated as laid stone and the schema does not name it as modelled`);
    assert.ok(design.WALL_SURFACES[m], `${m} has no surface, so it renders as the fallback`);
  }
  assert.ok(WALL_MATERIALS.length >= 5, `only ${WALL_MATERIALS.length} built wall materials`);
});
const LIVE_WALL = liveDesign.edges.find(e => e.id === "wall_firepit_uphill");
// chord length of its 4 control points; the centripetal Catmull-Rom through
// them is a little longer, never shorter
const LIVE_WALL_CHORD = LIVE_WALL.spline.slice(1).reduce(
  (s, p, i) => s + Math.hypot(p[0] - LIVE_WALL.spline[i][0], p[1] - LIVE_WALL.spline[i][1]), 0);
const uphill = (x) => 0.4 * x;                  // a 40% slope rising to the east

const REAL_THICK_MM = { stone: [200, 500], brick: [90, 350], timber: [90, 300],
                        concrete: [100, 300], corten_steel: [3, 20], aluminium: [3, 20],
                        // a dry stone wall carries its load by mass and friction,
                        // so it is thick — roughly two-thirds of its height, and
                        // never the 100 mm a mortared wall can get away with
                        dry_stone: [250, 900] };

test("a wall is a solid as thick as the material it is built from", () => {
  assert.ok(design.WALL_SURFACES, "design.js publishes no wall material table");
  assert.deepEqual([...WALL_MATERIALS].sort(), Object.keys(REAL_THICK_MM).sort(),
    "a schema edge material has no stated real-world thickness here");
  const bad = [];
  for (const material of WALL_MATERIALS) {
    const s = design.WALL_SURFACES[material];
    assert.ok(s, `no wall surface for the schema material ${material}`);
    const got = extent(design.edgeMesh(wall({ material }), flat), "x").span;
    console.log(`  ${material.padEnd(13)} ${s.thickness_m.toFixed(3)} m declared, ${got.toFixed(3)} m rendered`);
    if (Math.abs(got - s.thickness_m) > 1e-3) bad.push(`${material} renders ${got.toFixed(3)} m thick, declared ${s.thickness_m}`);
    // The half of this that is about the world rather than about the table
    // agreeing with itself. A wall is built out of something real: stone and
    // block are stacked in units a person can lift, a poured wall is formed,
    // and steel and aluminium edging are rolled plate — 6 mm is not a typo,
    // and 200 mm would be.
    const [min, max] = REAL_THICK_MM[material];
    if (!(s.thickness_m * 1000 >= min && s.thickness_m * 1000 <= max))
      bad.push(`${material} is built ${s.thickness_m * 1000} mm thick, outside ${min}-${max}`);
    // a texture tile that is not a whole number of courses breaks the course
    // at every tile seam, which is worse than no courses at all
    if (s.course_m > 0 && Math.abs(s.tile_m - s.course_m * s.courses) > 1e-9)
      bad.push(`${material} tiles at ${s.tile_m} m, not ${s.courses} x ${s.course_m}`);
  }
  assert.deepEqual(bad, [], bad.join("; "));
  const override = extent(design.edgeMesh(wall({ thickness_m: 0.62 }), flat), "x").span;
  assert.ok(Math.abs(override - 0.62) < 1e-3,
    `edge.thickness_m = 0.62 rendered ${override.toFixed(3)} m — the field does not reach the geometry`);
});

test("a wall has a top, and encloses the volume a wall of that size has", () => {
  const t = 0.4, L = 6;
  const mesh = design.edgeMesh(wall({ thickness_m: t }), flat);
  const f = faces(mesh);
  const cap = f.filter(q => q.n.y > 0.99).reduce((s, q) => s + q.area, 0);
  const h = extent(mesh, "y").span;
  const vol = f.reduce((s, q) => s + q.vol, 0);
  console.log(`  ${L} x ${t} m wall, ${h.toFixed(2)} m tall: ${f.length} triangles, ` +
    `top cap ${cap.toFixed(3)} m2 (a ${L} x ${t} m wall has ${(L * t).toFixed(3)}), ` +
    `encloses ${vol.toFixed(4)} m3 (a solid of that size is ${(L * t * h).toFixed(4)})`);
  assert.ok(Math.abs(cap - L * t) < 0.02 * L * t,
    `the top of the wall is ${cap.toFixed(3)} m2, not the ${(L * t).toFixed(3)} m2 it stands on`);
  assert.ok(vol > 0, `the wall is wound inside-out (encloses ${vol.toFixed(4)} m3), so a solid-sided material shows nothing`);
  assert.ok(Math.abs(vol - L * t * h) < 0.02 * L * t * h,
    `encloses ${vol.toFixed(4)} m3, not the ${(L * t * h).toFixed(4)} m3 of a ${L} x ${t} x ${h.toFixed(2)} m wall — it is not closed`);

  // Closure and orientation on the TOPOLOGY, not on the arithmetic: every edge
  // must be walked once in each direction. The volume sum alone can pass with
  // an end cap wound inside-out: the end in the plane z = 0 has a degenerate
  // cone from the origin, so reversing it leaves the total at 1.8000 m3.
  // An edge count detects that reversal and also catches a missing face.
  const dirs = new Map();
  const key = q => `${q.x.toFixed(6)},${q.y.toFixed(6)},${q.z.toFixed(6)}`;
  for (const tri of triVerts(mesh))
    for (let e = 0; e < 3; e++) {
      const a = key(tri[e]), b = key(tri[(e + 1) % 3]);
      const [k, d] = a < b ? [`${a}|${b}`, 1] : [`${b}|${a}`, -1];
      dirs.set(k, (dirs.get(k) ?? 0) + d);
    }
  const open = [...dirs.values()].filter(v => v !== 0).length;
  console.log(`  ${dirs.size} distinct edges, ${open} not walked once in each direction`);
  assert.equal(open, 0, `${open} of ${dirs.size} edges are unpaired or same-handed: ` +
    "the wall is open, or a face is wound inside-out");
});

test("courses are laid at the height the unit actually comes in", () => {
  // Measured through the render path rather than read off the table: metres of
  // real wall per texture tile (the UV Jacobian) divided by the number of
  // course lines drawn into that tile. A material laid in no courses at all —
  // a poured wall, a steel plate — must draw NONE, or every wall is striped
  // like stone, which is the same failure as `lawn` rendering as concrete.
  // dry_stone is laid in units too — smaller than mortared stone, because every
  // one has to be hand-set and wedged rather than bedded.
  const REAL_MM = { stone: [150, 300], brick: [60, 90], timber: [140, 300],
                    dry_stone: [100, 300] };
  const bad = [];
  for (const material of WALL_MATERIALS) {
    const mesh = design.edgeMesh(wall({ material }), flat);
    const ops = mesh.material.map?.image?.ops;
    assert.ok(ops?.length, `a ${material} wall carries no texture map at all`);
    const S = ops.find(o => o.x === 0 && o.y === 0 && o.w === o.h && o.w > 1).w;
    // a course line is the only full-width band drawn: the speckle is < 6 px
    // wide and the vertical joints are 2 px
    const n = new Set(ops.filter(o => o.x === 0 && o.w === S && o.h < S).map(o => o.y)).size;
    const perTile = tileMetres(mesh).v;
    const pitch = n ? perTile / n : 0;
    console.log(`  ${material.padEnd(13)} ${String(n).padStart(2)} courses per ${perTile.toFixed(2)} m tile = ` +
      `${n ? Math.round(pitch * 1000) + " mm" : "laid in no courses"}`);
    const want = REAL_MM[material];
    if (!want) { if (n) bad.push(`${material} is drawn coursed but is not laid in units`); continue; }
    if (!n) bad.push(`${material} draws no courses`);
    else if (pitch * 1000 < want[0] || pitch * 1000 > want[1])
      bad.push(`${material} courses at ${Math.round(pitch * 1000)} mm, not ${want[0]}-${want[1]}`);
  }
  assert.deepEqual(bad, [], bad.join("; "));
});

test("a wall's grain is metres of real wall, from the one material factory", () => {
  const mesh = design.edgeMesh(wall(), flat);
  assert.equal(mesh.material.userData.surface, "stone",
    "the wall material did not come from the shared surface factory");
  assert.ok(mesh.material.map.anisotropy > 1,
    `wall texture anisotropy is ${mesh.material.map.anisotropy} — grazing views are the whole point of a wall`);
  const m = tileMetres(mesh);
  const tile = design.WALL_SURFACES.stone.tile_m;
  console.log(`  stone wall: ${m.u.toFixed(3)} m/tile along the run, ${m.v.toFixed(3)} m/tile up the face ` +
    `(spread ${m.uMin.toFixed(3)}-${m.uMax.toFixed(3)} and ${m.vMin.toFixed(3)}-${m.vMax.toFixed(3)} over ${m.tris} triangles)`);
  assert.ok(skew(m) < 0.01,
    `wall grain stretched ${(m.u / m.v).toFixed(3)}x: ${m.u.toFixed(3)} m/tile along, ${m.v.toFixed(3)} m/tile up`);
  // EVERY triangle, not the median. A straight wall is a prism swept at a
  // constant offset, so all four of its faces tile identically — unlike a
  // curved path ribbon, whose inner and outer edges legitimately run 0.34-1.66x
  // the centreline. The median alone can pass with the outer face's v based on
  // curve parameter, because that face is only a quarter of the triangles and
  // does not move the middle of the spread.
  for (const [what, lo, hi] of [["along the run", m.uMin, m.uMax], ["up the face", m.vMin, m.vMax]])
    assert.ok(Math.abs(lo - tile) < 0.01 * tile && Math.abs(hi - tile) < 0.01 * tile,
      `some face of the wall tiles at ${lo.toFixed(3)}-${hi.toFixed(3)} m ${what}, not ${tile} m`);
});

test("a wall's foot follows the ground under IT, not under its centreline", () => {
  // Sample the whole width of the wall. A 0.6 m wall on a 40% slope drops 24 cm
  // between its two faces, so a base taken from the centre-line ground leaves
  // the downhill face standing 12 cm clear of the dirt — twice the embedment
  // that is supposed to hide the joint.
  const mesh = design.edgeMesh(
    wall({ spline: [[0, -3], [0, 3]], thickness_m: 0.6, level_m: 0.8 }), uphill);
  const pos = mesh.geometry.attributes.position;
  const top = extent(mesh, "y").hi;
  // stated, because without it this test is vacuous: a zero-thickness
  // ribbon puts every vertex ON the centreline, where centre-line ground is
  // trivially right and nothing can float. There has to be a face out here to
  // get the ground wrong under.
  assert.ok(extent(mesh, "x").span > 0.6 - 1e-3,
    `the wall has no width to sample across (x extent ${extent(mesh, "x").span.toFixed(3)} m)`);
  let worst = -Infinity, at = null;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y > top - 1e-6) continue;                    // a coping corner, at the retained level by construction
    const gap = y - uphill(pos.getX(i));
    if (gap > worst) { worst = gap; at = [pos.getX(i).toFixed(2), y.toFixed(3)]; }
  }
  console.log(`  0.6 m wall on a 40% slope: worst foot vertex sits ${(worst * 100).toFixed(1)} cm ` +
    `relative to the ground under it (must be at or below 0)`);
  assert.ok(worst <= 1e-6, `a foot vertex floats ${(worst * 100).toFixed(1)} cm above its own ground at x=${at?.[0]}, y=${at?.[1]}`);
});

test("a retaining wall leans into the ground it holds; on the level it stands plumb", () => {
  // Masonry batters INTO the fill, so the top offsets toward the UPHILL side.
  // Which side that is is a fact about the terrain: edge.retains says what the
  // wall does, not where the hill is.
  const leanOf = (edge, groundAt) => {
    const pos = design.edgeMesh(edge, groundAt).geometry.attributes.position;
    let top = -Infinity;
    for (let i = 0; i < pos.count; i++) top = Math.max(top, pos.getY(i));
    let ts = 0, tn = 0, bs = 0, bn = 0;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > top - 1e-6) { ts += pos.getX(i); tn++; } else { bs += pos.getX(i); bn++; }
    }
    return ts / tn - bs / bn;
  };
  const s = design.WALL_SURFACES.stone;
  const w = wall({ spline: [[0, -3], [0, 3]], level_m: 0.8, retains: "uphill" });
  const want = Math.tan(s.batter_deg * Math.PI / 180) * 0.8;   // 0.8 m exposed at the centreline
  const got = leanOf(w, uphill);
  console.log(`  stone batters ${s.batter_deg} deg: top stands ${(got * 100).toFixed(1)} cm uphill of the foot ` +
    `(a ${s.batter_deg} deg batter over 0.80 m is ${(want * 100).toFixed(1)} cm)`);
  assert.ok(got > 0, `the top leans ${(-got * 100).toFixed(1)} cm DOWNHILL, out of the ground it retains`);
  assert.ok(Math.abs(got - want) < 0.005, `leans ${(got * 100).toFixed(1)} cm, not the ${(want * 100).toFixed(1)} cm of a ${s.batter_deg} deg batter`);
  assert.ok(Math.abs(leanOf(w, flat)) < 1e-6, "a wall on level ground does not stand plumb");
  assert.ok(Math.abs(leanOf({ ...w, batter_deg: 0 }, uphill)) < 1e-6, "edge.batter_deg = 0 still leans");
});

test("the live stone retaining wall renders as built hardscape", needsSite, () => {
  const t = design.WALL_SURFACES[LIVE_WALL.material].thickness_m;
  const mesh = design.edgeMesh(LIVE_WALL, ground);
  const f = faces(mesh);
  const cap = f.filter(q => q.n.y > 0.99).reduce((s, q) => s + q.area, 0);
  console.log(`  wall_firepit_uphill (${LIVE_WALL.material}, ${LIVE_WALL_CHORD.toFixed(2)} m of chord, ` +
    `retains to ${LIVE_WALL.level_m} m): ${f.length} triangles, top cap ${cap.toFixed(2)} m2 ` +
    `(${LIVE_WALL_CHORD.toFixed(2)} m x ${t} m = ${(LIVE_WALL_CHORD * t).toFixed(2)})`);
  assert.ok(cap > LIVE_WALL_CHORD * t * 0.98 && cap < LIVE_WALL_CHORD * t * 1.15,
    `the wall's top is ${cap.toFixed(2)} m2 for a ${LIVE_WALL_CHORD.toFixed(2)} m run of ${t} m coping`);

  // and it stays affordable. Every ground surface in the corpus already runs
  // to 285k triangles in one design; hardscape must not join that.
  let total = 0, n = 0;
  for (const e of liveDesign.edges) {
    const g = design.edgeMesh(e, flat).geometry;
    total += (g.index?.count ?? g.attributes.position.count) / 3; n++;
  }
  console.log(`  ${total} triangles over ${n} walls in data/design.json`);
  assert.ok(total < 4000, `${total} triangles of edging`);
});

test("an unmodelled PAVING material falls back to paving, not to mulch", () => {
  // Free text needs a plausible fallback. Bark is right for a bed whose mulch
  // nobody modelled and wrong for a path: a brick walk rendering as dark brown
  // mulch reads to the owner as a flower bed where their path should be.
  // The fallback has to know what it is standing in for.
  const paved = new Set(["flagstone", "paver", "gravel", "decomposed_granite",
                         "concrete", "stepping_stones", "aggregate", "deck"]);
  for (const material of ["brick", "stone_sett", "pebble_mosaic", "cobble"]) {
    const asPath = design.pathMesh(
      { id: "p", spline: [[0, 0], [0, 6]], width_m: 1.2, material }, flat);
    assert.ok(paved.has(asPath.material.userData.surface),
      `a ${material} path falls back to "${asPath.material.userData.surface}" — not a paving`);
    const asPatio = design.patioMesh(
      { id: "q", polygon: [[0, 0], [5, 0], [5, 5], [0, 5]], material }, flat);
    assert.ok(paved.has(asPatio.material.userData.surface),
      `a ${material} patio falls back to "${asPatio.material.userData.surface}"`);
  }
  // and a bed's unmodelled mulch still falls back to mulch, not to concrete
  const bed = design.bedMesh(
    { id: "b", polygon: [[0, 0], [5, 0], [5, 5], [0, 5]], mulch: "cocoa hulls" }, flat);
  assert.equal(bed.material.userData.surface, "bark",
    "an unmodelled mulch stopped falling back to bark");
});
