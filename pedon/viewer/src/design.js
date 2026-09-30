// Build a THREE.Group from design.json + site.json (ENU meters, x=east y=north).
// three.js frame: x=east, y=up, z=-north.  enu [x,y] -> (x, h, -y)
import * as THREE from "three";
import { PIN_LIFT } from "./landmarks.js";
import { groundTexture } from "./grain.js";
import { objectMesh, seatObject } from "./objects.js";
import { objectModelReady } from "./assets.js";
import { getLoader } from "./loader.js";
import { buildPlant, rngFrom, fastModelKey } from "./plants.js";
import { restoreModels } from "./plant_store.js";
import { insideRing } from "./carve.js";

export { getLoader };

export const enuToWorld = (x, y, h = 0) => new THREE.Vector3(x, h, -y);


// Label textures are cached by their text and never disposed. Repeatedly
// disposing and recreating CanvasTextures desynchronises three's WebGL
// unpack-state cache and re-uploads later labels 180 deg rotated (reproducible:
// run "Detect structures" twice in one session). Reusing them sidesteps that
// entirely, and these are a few small canvases.
const labelTextures = new Map();
export function labelTexture(text, draw, size) {
  let tex = labelTextures.get(text);
  if (tex) return tex;
  const c = document.createElement("canvas");
  c.width = size[0]; c.height = size[1];
  draw(c.getContext("2d"), c);
  tex = new THREE.CanvasTexture(c);
  labelTextures.set(text, tex);
  return tex;
}

// Text labels are HTML overlays, not canvas-texture sprites: repeatedly
// creating and disposing CanvasTextures desynchronises three's WebGL
// unpack-state cache and re-uploads them 180 deg rotated. DOM text cannot
// mirror, stays crisp at any distance, and can carry buttons. This returns an
// empty anchor object; the viewer positions a <div> at its world position.
export function textLabel(text, kind = "plain") {
  const anchor = new THREE.Object3D();
  anchor.userData.label = text;
  anchor.userData.labelKind = kind;
  return anchor;
}

/**
 * How far apart a ground surface may sample the terrain, in metres.
 *
 * It is terrain.js's own cell size. Sampling coarser than the field throws
 * away measured relief for nothing, and every surface in this file — draped
 * polygon, path ribbon, edging — answers to the same number, because they all
 * read the same field. Measured on a scanned site's terrain field (bilinear,
 * 4000 random spans per length, error of the span's midpoint against
 * the mean of its ends): a 1.5 m span costs mean 3.7 cm / p90 10.7 cm, a
 * 0.75 m span 1.2 cm / 3.1 cm.
 */
export const FIELD_CELL_M = 0.75;

/**
 * Round a closed outline by corner-cutting (Chaikin).
 *
 * Beds arrive as polygons and the model overwhelmingly returns four vertices, so
 * a bed renders as a hard-edged rectangle — the single biggest reason a design
 * looks rigid rather than natural. Chaikin is the right smoother here
 * because every generated point is a convex combination of two originals, so the
 * result stays strictly inside the original polygon: a smoothed bed can never
 * bulge across a boundary the validator already approved.
 */
function smoothClosed(points, iterations = 3) {
  let pts = points;
  for (let it = 0; it < iterations; it++) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      out.push([ax + (bx - ax) * 0.25, ay + (by - ay) * 0.25],
               [ax + (bx - ax) * 0.75, ay + (by - ay) * 0.75]);
    }
    pts = out;
  }
  return pts;
}

/**
 * Triangulate a ground polygon and drape it on the terrain.
 *
 * A polygon only has vertices at its corners, so seating it at one height —
 * or even tilting it through its corners — leaves the interior flat. That is
 * invisible on a 5x5 m bed and badly wrong on a whole-yard one: a 691 m2 bed
 * across 11 m of relief floats metres above the ground at its middle. So subdivide until every edge is short relative to the terrain grid,
 * then sample the height field per vertex.
 *
 * Midpoint subdivision on a non-indexed mesh duplicates vertices along shared
 * edges, but both copies are computed from the same two endpoints and so land
 * on the same height — no cracks. It is also uniform: one long chord in the
 * fan triangulation splits every small triangle with it, which is where the
 * triangle count comes from (a 691 m2 bed is 122,880 triangles). Adaptive
 * per-edge subdivision would fix that without T-junctions, and is a separate
 * change — the cost is measured in tests/js/design.test.mjs and is affordable.
 */
function drapedPolygon(polygon, heightAt, lift, maxEdge = FIELD_CELL_M, maxPasses = 6) {
  const shape = new THREE.Shape(polygon.map(([x, y]) => new THREE.Vector2(x, y)));
  const flat = new THREE.ShapeGeometry(shape).toNonIndexed().attributes.position;
  let tris = [];
  for (let i = 0; i < flat.count; i += 3)
    tris.push([[flat.getX(i), flat.getY(i)],
               [flat.getX(i + 1), flat.getY(i + 1)],
               [flat.getX(i + 2), flat.getY(i + 2)]]);

  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  for (let pass = 0; pass < maxPasses; pass++) {
    let longest = 0;
    for (const t of tris)
      for (let e = 0; e < 3; e++)
        longest = Math.max(longest, Math.hypot(t[e][0] - t[(e + 1) % 3][0],
                                               t[e][1] - t[(e + 1) % 3][1]));
    if (longest <= maxEdge) break;
    const next = [];
    for (const [a, b, c] of tris) {
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      next.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
    }
    tris = next;
  }

  const v = [], uv = [];
  for (const t of tris)
    for (const [x, y] of t) {
      const w = enuToWorld(x, y, 0);
      v.push(w.x, heightAt(w.x, w.z) + lift, w.z);
      // planar UVs straight from world metres: a ground surface has no natural
      // parameterisation, and this makes one texture metre equal one real metre
      // wherever the bed sits, so grain never stretches with bed size
      uv.push(w.x, w.z);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

/**
 * Every ground surface a design can specify, in one table.
 *
 * bedMesh, patioMesh and pathMesh need the SAME texture and tile size for each
 * material. Decomposed granite tiled at 1.3 m as a walk and 1.5 m as a terrace,
 * with different grain, reads as two surfaces where they meet along an edge.
 * A shared lookup also prevents omissions: `lawn` is a legal patio material
 * (design.schema.json) and must not fall through to flat #aaaaaa concrete.
 *
 * tile_m is the real size of one texture tile. It belongs to the material — a
 * paving unit is the size it is — not to the op that laid it.
 */
// `courses` and `units` are the JOINTS, in the same shape WALL_SURFACES uses.
// Only surfaces that are LAID in pieces get them: a flagstone patio is stones
// with gaps between them and a deck is boards, while gravel and decomposed
// granite have no unit at all. Without them a flagstone patio is speckle and
// nothing else: what makes masonry read as masonry is the joint.
//
// Counts are per TILE, and tile_m is 1.4 m: 3 courses of 3 is a 0.47 m flag, 5 x 5
// a 0.28 m paver, and a deck is 10 boards of 0.14 m with no cross joint (units 1).
export const GROUND_SURFACES = {
  flagstone:          { hex: 0x8a8577, grain: 0.13, coarse: 3.5, tile_m: 1.4, rough: 0.90,
                        courses: 3, units: 3 },
  paver:              { hex: 0x9c8f7f, grain: 0.13, coarse: 3.5, tile_m: 1.4, rough: 0.90,
                        courses: 5, units: 5 },
  concrete:           { hex: 0xb5b2ac, grain: 0.10, coarse: 3.5, tile_m: 1.4, rough: 0.90,
                        courses: 2, units: 2 },
  // No bond: a stepping stone path has no COURSES, it has stones and gaps, and a
  // running bond on an unbroken ribbon makes it read as paving.
  stepping_stones:    { hex: 0x8a8577, grain: 0.20, coarse: 2.6, tile_m: 1.4, rough: 0.90,
                        steppers: true },
  gravel:             { hex: 0xb0a89a, grain: 0.25, coarse: 1.8, tile_m: 1.4, rough: 0.95,
                        chips: true },
  decomposed_granite: { hex: 0xc2a878, grain: 0.25, coarse: 1.8, tile_m: 1.4, rough: 0.95,
                        chips: true },
  deck:               { hex: 0x8f6f4f, grain: 0.12, coarse: 3.6, tile_m: 0.9, rough: 0.75,
                        courses: 7, units: 1 },
  lawn:               { hex: 0x5d7a43, grain: 0.28, coarse: 1.4, tile_m: 0.8, rough: 1.00 },
  bark:               { hex: 0x4a3423, grain: 0.30, coarse: 2.6, tile_m: 1.1, rough: 1.00,
                        strands: true },
  aggregate:          { hex: 0xa89880, grain: 0.28, coarse: 2.0, tile_m: 1.1, rough: 1.00,
                        chips: true },
};

// A bed's mulch is free text the model writes, not an enum: the saved designs
// hold "shredded cedar bark", "3/8 in crushed granite fines" and "washed river
// cobble and pale gravel, raked as a dry watercourse". So it cannot be a
// lookup. Order matters, first match wins, and the aggregate words are tested
// first because the gravel beds also say "cobble"/"rockery".
const MULCH_WORDS = [
  [/gravel|granite|crushed|rock|cobble|stone|shale|pebble|grit|limestone/, "aggregate"],
  [/bark|shred|mulch|compost|leaf|wood|straw|moss|chip|humus|pine|cedar|redwood/, "bark"],
];

const surfaceKey = name => String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

const unknownSurfaces = new Set();
/** Resolve a schema material or a free-text mulch to one GROUND_SURFACES entry. */
/**
 * Resolve a free-text material or mulch to one GROUND_SURFACES entry.
 *
 * `fallback` is what this SURFACE IS FOR, and it matters. Material is free
 * text so the library does not cap the design, and one fallback for everything
 * cannot represent every use: a brick path resolving to `bark` renders a dark
 * brown mulch strip where the owner's
 * walk should be, which reads as a flower bed. A bed whose mulch nobody models
 * still wants bark.
 */
function groundSurface(name, fallback = "bark") {
  const key = surfaceKey(name);
  if (GROUND_SURFACES[key]) return [key, GROUND_SURFACES[key]];
  for (const [re, surface] of MULCH_WORDS)
    if (re.test(key)) return [surface, GROUND_SURFACES[surface]];
  // say so, rather than silently painting an unknown material the fallback grey
  if (!unknownSurfaces.has(`ground:${key}`)) {
    unknownSurfaces.add(`ground:${key}`);
    console.warn(`design.js: no ground surface for "${name}" — using ${fallback}`);
  }
  return [fallback, GROUND_SURFACES[fallback]];
}

/**
 * A granular ground texture, generated once per (colour, grain) combination.
 *
 * A bed rendered as flat #4a3423 and a walk as flat #c2a878 are the most
 * obviously computer-generated things in any frame — real mulch, gravel and
 * decomposed granite all read as GRAIN at walking distance, and grain is what
 * a flat colour cannot fake. This scatters specks around the base hue at two
 * scales (coarse aggregate, fine fill) and tiles it, which costs one 128px
 * canvas per material and changes the read completely.
 */

// Ground is nearly always seen at a grazing angle — walking a path you look
// down its length — and that is exactly where isotropic mipmapping smears the
// grain to mud. WebGLRenderer clamps this to the GPU's own maximum.
const GROUND_ANISOTROPY = 8;

/**
 * The material for ANY ground surface: one grain texture, tiled in METRES.
 *
 * Every ground geometry in this file puts its UVs in metres — a draped polygon
 * takes them straight from world x/z, a path ribbon from its real width and its
 * arc length — so repeat is simply tiles per metre and one tile is the same
 * real size on a bed, a terrace and a walk. UVs running 0..1 across and
 * t*divisions*0.2 along distort the scale: a 10.95 m x 1.1 m path then tiles
 * 1.430 m across against 0.989 m along.
 *
 * Pass metresPerTile only to override the material's own tile size.
 */
function surfaceMaterial(name, s, tile, bond = null, metalness = 0, side = THREE.DoubleSide) {
  const map = groundTexture(s.hex, s.grain, s.coarse, bond, !!s.chips, !!s.steppers,
                            !!s.strands).clone();
  map.needsUpdate = true;                     // a clone re-uploads on first use
  map.repeat.set(1 / tile, 1 / tile);
  map.anisotropy = GROUND_ANISOTROPY;
  // Materials are NOT shared between meshes: applySelectionHighlight() mutates
  // material.emissive in place, so one shared instance would light every bed
  // when you click one.
  // alphaTest, not `transparent`: the stepping-stone texture has open gaps, and a
  // sorted transparent surface on the ground would z-fight with everything drawn
  // near it. Discarding the fragment is both correct and free.
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, map, roughness: s.rough,
                                               metalness, side,
                                               alphaTest: s.steppers ? 0.5 : 0 });
  // stamped so a future hand-rolled material is DETECTABLE rather than merely
  // slightly different-looking (tests/js/design.test.mjs asserts it)
  mat.userData.surface = name;
  return mat;
}

/**
 * Materials this design asked for that the library cannot draw as themselves.
 *
 * The companion to objects.js's `wants` for free-text materials.
 * Opening material to free text is only honest if the downgrade is VISIBLE: a
 * brick path silently drawn as aggregate, with the owner told nothing, is the
 * invisible substitution the want list exists to prevent. The validator warns
 * too, but that reaches the MODEL — which is the wrong audience for "this is not
 * modelled yet, do you want it built".
 *
 * Same row shape as objects.wants so main.js can concatenate them and neither
 * side needs to know the other exists.
 */
export function materialWants(design) {
  const byKind = new Map();
  const note = (name, id, what) => {
    const key = `${String(name).trim()} ${what}`;
    if (!byKind.has(key)) byKind.set(key, { kind: key, ids: [], count: 0 });
    const w = byKind.get(key);
    w.ids.push(id);
    w.count++;
  };
  for (const [list, table, what] of [
    [design?.paths, GROUND_SURFACES, "paving"],
    [design?.patios, GROUND_SURFACES, "paving"],
    [design?.edges, WALL_SURFACES, "edging"],
    [design?.steps, WALL_SURFACES, "edging"],
  ]) {
    for (const o of list ?? []) {
      const name = o?.material;
      if (!name) continue;
      const key = surfaceKey(name);
      // MULCH_WORDS only stands in for bed mulch, so it is deliberately not
      // consulted here: a "bark path" is still a path nobody modelled.
      if (!table[key]) note(name, o.id, what);
    }
  }
  return [...byKind.values()].sort((a, b) => b.count - a.count);
}


export function makeGroundMaterial(material, metresPerTile, fallback) {
  const [name, s] = groundSurface(material, fallback);
  // DoubleSide because mapping ENU y to world -z reverses the triangulation's
  // winding; these are open surfaces, so lighting both faces is correct
  return surfaceMaterial(name, s, metresPerTile ?? s.tile_m,
    s.courses ? { courses: s.courses, units: s.units } : null);
}

/**
 * Every edging material as it is actually BUILT, in one table.
 *
 * Colour alone cannot distinguish a 5.23 m stone retaining wall from a 6 mm
 * aluminium strip. What separates them is how they are put together:
 *
 *   thickness_m  what a wall of this material is built out of. Masonry is
 *                stacked in units a person can lift; edging is rolled plate,
 *                and 6 mm is not a typo.
 *   batter_deg   how far a retaining face leans back into what it holds.
 *                Mortared brick goes up nearly plumb, dry-laid stone does not.
 *   course_m     the height one laid unit comes in, 0 for a material laid in
 *                no courses at all — a poured wall, a steel plate. Drawing
 *                courses on those would stripe every wall like stone.
 *   courses/units  that course height and unit length expressed as a whole
 *                number per texture tile, so the bond never breaks at a seam:
 *                tile_m === course_m * courses, asserted in the tests.
 *
 * thickness_m and batter_deg are DEFAULTS. A design may state either per edge;
 * most of the saved corpus states neither, so the table has to be the answer.
 */
export const WALL_SURFACES = {
  stone:        { hex: 0x9a958a, grain: 0.16, coarse: 3.2, rough: 0.95, metal: 0,
                  thickness_m: 0.35,  batter_deg: 8, course_m: 0.20,  courses: 4,  units: 3, tile_m: 0.80 },
  brick:        { hex: 0x9c5a44, grain: 0.10, coarse: 2.2, rough: 0.90, metal: 0,
                  thickness_m: 0.23,  batter_deg: 2, course_m: 0.075, courses: 12, units: 4, tile_m: 0.90 },
  timber:       { hex: 0x8f6f4f, grain: 0.12, coarse: 3.6, rough: 0.80, metal: 0,
                  thickness_m: 0.20,  batter_deg: 0, course_m: 0.20,  courses: 4,  units: 0, tile_m: 0.80 },
  concrete:     { hex: 0xb5b2ac, grain: 0.08, coarse: 3.5, rough: 0.85, metal: 0,
                  thickness_m: 0.20,  batter_deg: 3, course_m: 0,     courses: 0,  units: 0, tile_m: 1.20 },
  corten_steel: { hex: 0x8c4a2f, grain: 0.14, coarse: 2.4, rough: 0.72, metal: 0.5,
                  thickness_m: 0.012, batter_deg: 0, course_m: 0,     courses: 0,  units: 0, tile_m: 1.20 },
  aluminium:    { hex: 0xb8bec4, grain: 0.05, coarse: 2.0, rough: 0.40, metal: 0.5,
                  thickness_m: 0.006, batter_deg: 0, course_m: 0,     courses: 0,  units: 0, tile_m: 1.20 },
  // Dry stone is a WALL — coursed, battered hard because nothing binds it. Boulder
  // is not a wall at all (see rockEdgeMesh): it is armour laid along a slope toe,
  // and drawing it as a swept solid in grey is the same defect as drawing a bed as
  // a rectangle. Both support rock designs on slopes, including a 14 deg slope.
  dry_stone:    { hex: 0x8e8b80, grain: 0.20, coarse: 2.8, rough: 0.97, metal: 0,
                  thickness_m: 0.45,  batter_deg: 12, course_m: 0.14, courses: 5,  units: 5, tile_m: 0.70 },
  boulder:      { hex: 0x7d7a73, grain: 0.22, coarse: 3.0, rough: 0.98, metal: 0,
                  thickness_m: 0.55,  batter_deg: 0, course_m: 0,     courses: 0,  units: 0, tile_m: 0.60 },
};

// Materials that are laid, not built. These route to rockEdgeMesh.
export const ROCK_EDGES = new Set(["boulder"]);

/** Resolve a schema edge material to one WALL_SURFACES entry. */
function wallSurface(name) {
  const key = surfaceKey(name);
  if (WALL_SURFACES[key]) return [key, WALL_SURFACES[key]];
  if (!unknownSurfaces.has(`wall:${key}`)) {
    unknownSurfaces.add(`wall:${key}`);
    console.warn(`design.js: no wall surface for "${name}" — using corten_steel`);
  }
  return ["corten_steel", WALL_SURFACES.corten_steel];
}

export function makeWallMaterial(material) {
  const [name, s] = wallSurface(material);
  // FrontSide, unlike the ground: edgeMesh builds a CLOSED solid wound
  // outwards, so every back face is the inside of the wall and drawing it is
  // waste. tests/js/design.test.mjs measures the enclosed volume, which is the
  // only check that can tell "wound outwards" from "wound inside-out".
  return surfaceMaterial(name, s, s.tile_m,
    s.courses ? { courses: s.courses, units: s.units } : null, s.metal, THREE.FrontSide);
}

/**
 * WHERE THE DESIGN IS BUILT FLAT: every bed, patio and path carrying
 * `level_m`, as a ring in the design group's own frame (world x, z) from the SAME
 * outline its mesh is drawn from — the Chaikin passes for a bed and a patio, the
 * swept ribbon for a path. carve.js cuts the scan inside these rings; a second
 * outline here would cut a hole the surface does not fill.
 */
export function levelFootprints(design) {
  const out = [];
  const ring = pts => pts.map(([x, y]) => { const w = enuToWorld(x, y, 0); return [w.x, w.z]; });
  for (const b of design?.beds ?? [])
    if (b.level_m != null && b.polygon?.length > 2)
      out.push({ id: b.id, level: b.level_m, ring: ring(smoothClosed(b.polygon)) });
  for (const p of design?.patios ?? [])
    if (p.level_m != null && p.polygon?.length > 2)
      out.push({ id: p.id, level: p.level_m, ring: ring(smoothClosed(p.polygon, 1)) });
  for (const p of design?.paths ?? [])
    if (p.level_m != null && p.spline?.length > 1) {
      const st = sweptStations(p.spline), h = (p.width_m ?? 1) / 2;
      out.push({ id: p.id, level: p.level_m, ring: [
        ...st.map(s => [s.x + s.sx * h, s.z + s.sz * h]),
        ...st.map(s => [s.x - s.sx * h, s.z - s.sz * h]).reverse()] });
    }
  return out;
}

/**
 * The ground a thing STANDS on once the design is built: a level surface's level
 * inside its footprint, the measured ground everywhere else. A plant in a terraced
 * bed and a bench on a terrace must stand on that level: placing them on the
 * ORIGINAL slope leaves them floating over the cut or sunk into the fill.
 */
export function designedGround(design, heightAt) {
  const level = levelFootprints(design);
  if (!level.length) return heightAt;
  return (x, z) => {
    for (const s of level) if (insideRing([x, z], s.ring)) return s.level;
    return heightAt(x, z);
  };
}

const CUT_FACE_MATERIAL = () => new THREE.MeshStandardMaterial({
  color: 0x6e5a44, roughness: 1, metalness: 0, side: THREE.DoubleSide });

/**
 * The face between a level surface and the ground at its edge: the cut bank on the
 * uphill side, the filled batter on the downhill one. Without it a carved terrace
 * is a hole with no wall. A stretch shared with ANOTHER level surface at the same
 * level is a seam inside one bench, not an edge, and draws nothing.
 */
export function cutFaceMesh(ring, level, heightAt, others = [], step = 0.2) {
  const pts = [];
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let j = 0; j < k; j++) pts.push([ax + (bx - ax) * j / k, az + (bz - az) * j / k]);
  }
  const verts = [];
  const seam = (p, q) => {
    const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
    const dx = q[0] - p[0], dz = q[1] - p[1], L = Math.hypot(dx, dz) || 1;
    const out = [[mx - dz / L * 0.05, mz + dx / L * 0.05], [mx + dz / L * 0.05, mz - dx / L * 0.05]]
      .find(o => !insideRing(o, ring));
    return !!out && others.some(o => Math.abs(o.level - level) < 0.03 && insideRing(out, o.ring));
  };
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const gp = heightAt(p[0], p[1]), gq = heightAt(q[0], q[1]);
    if (Math.abs(gp - level) < 0.01 && Math.abs(gq - level) < 0.01) continue;
    if (seam(p, q)) continue;
    verts.push(p[0], level, p[1], p[0], gp, p[1], q[0], gq, q[1],
               p[0], level, p[1], q[0], gq, q[1], q[0], level, q[1]);
  }
  if (!verts.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, CUT_FACE_MATERIAL());
  mesh.name = "cut-face";
  return mesh;
}

function addCutFace(mesh, kind, item, others, heightAt) {
  if (item.level_m == null) return;
  const mine = levelFootprints({ [kind]: [item] })[0];
  if (!mine) return;
  const face = cutFaceMesh(mine.ring, mine.level, heightAt, others.filter(o => o.id !== item.id));
  if (face) { face.userData.id = item.id; mesh.add(face); }
}

export function bedMesh(bed, heightAt, others = []) {
  // level_m means this bed sits on a cut-and-fill bench and is FLAT, the same
  // way a path with level_m is. Without honouring it a terraced design renders
  // incoherently: the bench walk is flat while the bed beside it still drapes
  // down the original slope, so a 0.8 m wide bed on a 30% grade rears up 3 m
  // and reads as a standing panel rather than planting ground.
  const at = bed.level_m != null ? () => bed.level_m : heightAt;
  const geo = drapedPolygon(smoothClosed(bed.polygon), at, 0.02);
  // the schema's own default, so a bed that names no mulch still resolves to a
  // real surface instead of warning its way to one
  const mesh = new THREE.Mesh(geo, makeGroundMaterial(bed.mulch ?? "shredded_hardwood"));
  mesh.userData.id = bed.id;
  addCutFace(mesh, "beds", bed, others, heightAt);
  return mesh;
}

/**
 * A usable area — a sitting terrace, dining pad, fire-pit circle, lawn shelf.
 *
 * Shares bedMesh's draping and level_m handling, because a paved pad on a slope
 * has exactly the same geometry problem a bed does. The one difference that
 * matters geometrically: paving is laid in units, so its outline is only gently
 * eased rather than rounded to a blob. The surface itself is not special —
 * every ground material in this file comes from makeGroundMaterial.
 */
export function patioMesh(patio, heightAt, others = []) {
  const at = patio.level_m != null ? () => patio.level_m : heightAt;
  // one Chaikin pass, not three: a paved terrace has a built edge, so it should
  // read as a softened polygon rather than an amoeba the way a planting bed does
  const geo = drapedPolygon(smoothClosed(patio.polygon, 1), at, 0.03);
  const mesh = new THREE.Mesh(geo, makeGroundMaterial(patio.material, undefined, "aggregate"));
  mesh.userData.id = patio.id;
  addCutFace(mesh, "patios", patio, others, heightAt);
  return mesh;
}

/**
 * The centreline of a path or an edging, and how many stations to sample it at.
 *
 * CONTROL POINT COUNT is a fact about how many points the model writes, not
 * about the ground: deriving `divisions` from it makes a
 * 2-point 56 m traverse use the 24-division floor and sample the terrain
 * every 2.36 m, three times the height field's cell. Arc length is what
 * decides it. The floor stays as a lower bound because it is never coarser
 * than the length rule on the saved corpus (worst station there is 0.58 m) and
 * removing it would coarsen every short path.
 */
function sweptCurve(spline) {
  const curve = new THREE.CatmullRomCurve3(
    spline.map(([x, y]) => enuToWorld(x, y, 0)), false, "centripetal", 0.5);
  return { curve, divisions: Math.max(24, spline.length * 12,
    Math.ceil(curve.getLength() / FIELD_CELL_M)) };
}

/**
 * The stations of a swept centreline: plan position, the unit vector across
 * the sweep, and arc length so far in metres.
 *
 * One walker, because the ribbon and the wall want the same three numbers;
 * duplicated height-field indexing can disagree or index rows backwards.
 * `run` in particular must not be re-derived: it puts a surface's UVs in real
 * metres. Using t*divisions*0.2 for pathMesh's v stretches the grain by up to
 * 3.4x along a single walk.
 */
function sweptStations(spline) {
  const { curve, divisions } = sweptCurve(spline);
  const up = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3();
  const out = [];
  let run = 0, prev = null;
  for (let i = 0; i <= divisions; i++) {
    const t = i / divisions;
    const p = curve.getPoint(t);
    if (prev) run += Math.hypot(p.x - prev.x, p.z - prev.z);
    prev = p;
    // up x tangent has no y component, so an offset along it stays in plan and
    // every vertex keeps the height its own ground sample gave it
    side.crossVectors(up, curve.getTangent(t)).normalize();
    out.push({ x: p.x, z: p.z, sx: side.x, sz: side.z, run });
  }
  return out;
}

export function pathMesh(path, heightAt, others = []) {
  const stations = sweptStations(path.spline);
  const half = path.width_m / 2;
  // Vertices ACROSS the ribbon, not one per edge. With two per station the
  // paving is a straight chord from edge to edge, so a walk crossing a crown or
  // a swale is bridged or buried by its whole cross-slope and no number of
  // stations along the path can help — the missing samples are across it.
  // Measured with two vertices: a 2.4 m walk over a 0.5 m ridge stands 19.7 cm below
  // its own crest, and on the real scan the same walk averages 14.9 cm off the ground
  // it drapes onto. Same rule as the drape: sample at the field's cell.
  const spans = Math.max(1, Math.ceil(path.width_m / FIELD_CELL_M));
  const verts = [], uvs = [], idx = [];
  stations.forEach((st, i) => {
    for (let k = 0; k <= spans; k++) {
      const off = (k / spans - 0.5) * path.width_m;       // -half .. +half
      const x = st.x + st.sx * off, z = st.z + st.sz * off;
      // level_m means the path was cut/filled to a bench and is FLAT at that
      // elevation; without it, drape every station vertex onto the terrain so
      // the path climbs the slope and banks with it
      verts.push(x, path.level_m != null ? path.level_m : heightAt(x, z) + 0.03, z);
      // UVs in METRES, like every other ground surface here: across the ribbon
      // is its real width, along it is real arc length. A v built from t alone
      // also stretches the grain ALONG a single path, because CatmullRomCurve3
      // is not arc-length parameterised: on a 10.95 m walk the same t
      // step covers 0.0695 m in one place and 0.2397 m in another, 3.4x.
      uvs.push(off + half, st.run);
    }
    if (i < stations.length - 1) for (let k = 0; k < spans; k++) {
      const a = i * (spans + 1) + k;
      idx.push(a, a + 1, a + spans + 1, a + 1, a + spans + 2, a + spans + 1);
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, makeGroundMaterial(path.material, undefined, "aggregate"));
  mesh.userData.id = path.id;
  addCutFace(mesh, "paths", path, others, heightAt);
  return mesh;
}

/**
 * How far a wall's foot is buried below the ground at its own base.
 *
 * Small on purpose: it hides the joint between the wall and a terrain sampled
 * every 0.75 m without pretending to a footing the design has not excavated
 * for. The 0.05 m embedment hides the joint without implying a larger footing.
 */
const EDGE_EMBED_M = 0.05;

/**
 * A retaining wall or a border edging, swept as a real cross-section.
 *
 * Two vertices per station make a zero-thickness strip: a 5.23 m stone wall
 * becomes 96 triangles of flat #9a958a with no top, no ends and no texture.
 * It vanishes edge-on, both sides light as one plane, and nothing distinguishes
 * a wall from a fence panel. Walls need a real section and material detail.
 *
 * So the section is a closed solid — outer face, inner face, coping, buried
 * soffit, and an end cap at each end of the run — wound outwards so it can be
 * drawn FrontSide. Each face gets its own vertices rather than sharing them,
 * because computeVertexNormals() averages across shared ones and would round
 * the coping arris off into the face; and its own UVs, both in metres, so the
 * courses in the texture come out the size the material is sold in.
 *
 * thickness_m and batter_deg are read from the edge when the design states
 * them and from WALL_SURFACES when it does not, which is most of the corpus.
 */
/**
 * A rock edge: individual stones set along the line, not a slab wearing a rock
 * texture.
 *
 * Natural rocks can armour a slope toe with set stone instead of a retaining
 * wall that needs pricing and permitting. They must also READ as natural
 * stone, which depends on the silhouette. Colour and roughness on the same
 * swept solid produce a grey concrete kerb, not individual rocks.
 *
 * One merged geometry, not thirty meshes: a long run is thirty stones, and
 * thirty draw calls per edge is how a viewer that has to stay interactive dies.
 * Seeded off the edge id, so the same edge is the same rocks in every frame of a
 * walkthrough — otherwise no visual check of a design means anything — while two
 * different edges get different stone.
 */
function rockEdgeMesh(edge, heightAt) {
  const [, s] = wallSurface(edge.material);
  const stations = sweptStations(edge.spline);
  const rand = rngFrom(`rock:${edge.id ?? "edge"}`);
  const halfW = (edge.thickness_m ?? s.thickness_m) / 2;
  const total = stations[stations.length - 1].run;
  const at = (run) => {
    const i = Math.min(stations.length - 1,
      Math.max(0, stations.findIndex((st) => st.run >= run)));
    return stations[i < 0 ? stations.length - 1 : i];
  };

  const chunks = [];
  let run = 0;
  while (run <= total) {
    // Stones vary in size, which is the whole point; the mean still lands on the
    // requested height: irregularity must not turn a rock edge into a taller wall.
    const top = (edge.height_m ?? 0.4) * (0.85 + 0.35 * rand());
    const r = top * 0.62;                      // sits proud by `top`, buried below
    const st = at(run);
    const off = (rand() - 0.5) * halfW;        // jog off the line, as set stone does
    const x = st.x + st.sx * off, z = st.z + st.sz * off;
    const g = heightAt(x, z);

    const geo = new THREE.IcosahedronGeometry(r, 1);
    const p = geo.attributes.position;
    const sx = 0.8 + 0.5 * rand(), sy = 0.7 + 0.4 * rand(), sz = 0.8 + 0.5 * rand();
    const spin = rand() * Math.PI * 2, cs = Math.cos(spin), sn = Math.sin(spin);
    for (let i = 0; i < p.count; i++) {
      // Facet jitter first (a stone is not an eroded ball), then squash, then spin
      const k = 0.80 + 0.30 * Math.abs(Math.sin(i * 12.9898 + spin));
      const vx = p.getX(i) * k * sx, vy = p.getY(i) * k * sy, vz = p.getZ(i) * k * sz;
      p.setXYZ(i, vx * cs - vz * sn, vy, vx * sn + vz * cs);
    }
    // Scale so the tallest vertex lands exactly on `top` above ground: the jitter
    // above would otherwise make the stated height a suggestion.
    let peak = 0;
    for (let i = 0; i < p.count; i++) peak = Math.max(peak, p.getY(i));
    geo.scale(1, peak > 1e-6 ? (top / 2) / peak : 1, 1);
    geo.translate(x, g + top / 2, z);
    geo.computeVertexNormals();
    chunks.push(geo.attributes.position.array, geo.attributes.normal.array);

    run += r * (1.15 + 0.5 * rand());          // shoulder to shoulder, not a fence
  }

  const n = chunks.filter((_, i) => i % 2 === 0).reduce((a, c) => a + c.length, 0);
  const pos = new Float32Array(n), nor = new Float32Array(n);
  let o = 0;
  for (let i = 0; i < chunks.length; i += 2) {
    pos.set(chunks[i], o); nor.set(chunks[i + 1], o); o += chunks[i].length;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  const mesh = new THREE.Mesh(geo, makeWallMaterial(edge.material));
  mesh.material.flatShading = true;
  mesh.userData.id = edge.id;
  return mesh;
}


export function edgeMesh(edge, heightAt) {
  if (ROCK_EDGES.has(surfaceKey(edge.material))) return rockEdgeMesh(edge, heightAt);
  const [, s] = wallSurface(edge.material);
  const stations = sweptStations(edge.spline);
  const half = Math.max(0.001, (edge.thickness_m ?? s.thickness_m) / 2);

  // Masonry batters INTO what it holds, so the top offsets toward the UPHILL
  // side — and which side that is is a fact about the terrain, not about
  // edge.retains, which names what the wall DOES ("uphill"/"downhill") and not
  // where the hill is. Summed over the whole run so a curve cannot twist the
  // wall along its length, and it comes out zero on level ground, which is
  // also right: a free-standing border stands plumb.
  const probe = half + 0.35;
  let tilt = 0;
  for (const st of stations)
    tilt += heightAt(st.x + st.sx * probe, st.z + st.sz * probe)
          - heightAt(st.x - st.sx * probe, st.z - st.sz * probe);
  const batter = Math.abs(tilt) < 0.02 * stations.length ? 0
    : Math.sign(tilt) * Math.tan((edge.batter_deg ?? s.batter_deg) * Math.PI / 180);

  const verts = [], uvs = [], idx = [];
  const push = (p, u, v) => { verts.push(p[0], p[1], p[2]); uvs.push(u, v); return verts.length / 3 - 1; };
  const quad = (a, b, c, d) => idx.push(a, b, c, a, c, d);   // wound a->b->c->d
  // four strips of two vertices per station; each records where its first
  // vertex landed so the quads can be indexed off it
  const strip = { out: [], in: [], top: [], bot: [] };
  const ends = [];

  stations.forEach((st, i) => {
    const g = heightAt(st.x, st.z);
    const top = edge.level_m != null ? edge.level_m : g + edge.height_m;
    const lean = batter * Math.max(0, top - g);
    // Each face stands on ITS OWN ground, not the centreline's: sample the whole
    // shape across its width. A 0.6 m wall on a 40% slope drops 24 cm between
    // its two faces, so a centre-line base leaves the downhill one 12 cm clear
    // of the dirt — twice the embedment that is supposed to hide the joint.
    const foot = k => {
      const x = st.x + st.sx * half * k, z = st.z + st.sz * half * k;
      return [x, Math.min(heightAt(x, z), top) - EDGE_EMBED_M, z];
    };
    const bo = foot(1), bi = foot(-1);
    const to = [st.x + st.sx * (half + lean), top, st.z + st.sz * (half + lean)];
    const ti = [st.x + st.sx * (lean - half), top, st.z + st.sz * (lean - half)];
    // faces: u along the run, v down from the coping, so a course line is
    // level and the top one is flush with the top whatever the ground does.
    // coping and soffit: u across the thickness, v along the run, so the same
    // line becomes a joint between coping stones.
    strip.out.push(push(bo, st.run, top - bo[1]), push(to, st.run, 0));
    strip.in.push(push(bi, st.run, top - bi[1]), push(ti, st.run, 0));
    strip.top.push(push(to, 0, st.run), push(ti, 2 * half, st.run));
    strip.bot.push(push(bo, 0, st.run), push(bi, 2 * half, st.run));
    // The two ends of the run get their own vertices too, so the arris there
    // stays sharp. Taken from this loop rather than recomputed afterwards: the
    // ground, the top and the lean are already in hand here, and a second copy
    // of that derivation can disagree with the faces it closes.
    if (i === 0 || i === stations.length - 1)
      ends.push([push(bo, 0, top - bo[1]), push(to, 0, 0),
                 push(ti, 2 * half, 0), push(bi, 2 * half, top - bi[1])]);
  });

  // World is right-handed (x east, y up, z south) and side = up x tangent, so
  // side x tangent = -up: outward winding on the +side face runs foot -> top
  // -> next top -> next foot, and the -side face and the soffit are its
  // mirror. Getting this backwards makes a FrontSide wall invisible from
  // outside and encloses a NEGATIVE volume, which is what the test measures.
  for (let i = 0; i + 1 < stations.length; i++) {
    const [bO, tO] = [strip.out[i * 2], strip.out[i * 2 + 1]];
    const [nbO, ntO] = [strip.out[i * 2 + 2], strip.out[i * 2 + 3]];
    quad(bO, tO, ntO, nbO);
    const [bI, tI] = [strip.in[i * 2], strip.in[i * 2 + 1]];
    const [nbI, ntI] = [strip.in[i * 2 + 2], strip.in[i * 2 + 3]];
    quad(bI, nbI, ntI, tI);
    const [cO, cI] = [strip.top[i * 2], strip.top[i * 2 + 1]];
    const [ncO, ncI] = [strip.top[i * 2 + 2], strip.top[i * 2 + 3]];
    quad(cO, cI, ncI, ncO);
    const [sO, sI] = [strip.bot[i * 2], strip.bot[i * 2 + 1]];
    const [nsO, nsI] = [strip.bot[i * 2 + 2], strip.bot[i * 2 + 3]];
    quad(sO, nsO, nsI, sI);
  }

  // A wall that stops in mid-air with an open end reads as a cardboard flat,
  // just as a zero-thickness ribbon does. Near end
  // faces -tangent, far end +tangent, so their windings are mirrored.
  const [near, far] = ends;
  quad(near[0], near[3], near[2], near[1]);
  quad(far[0], far[1], far[2], far[3]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, makeWallMaterial(edge.material));
  mesh.userData.id = edge.id;
  return mesh;
}

function plantProxy(plant, options) {
  const grp = buildPlant(plant, options);
  const label = textLabel(plant.common ?? plant.species, "plant");
  label.position.y = (plant.mature_height_m ?? 1) + 0.35;
  // TAGGED so the viewer can hide them as a class. Finding them by "is it a
  // Sprite" would also catch the north arrow, the landmark pins and the area
  // captions, which must stay visible when the owner hides plant labels.
  label.userData.plantLabel = true;
  grp.add(label);
  return grp;
}

// A plant's own model (`asset`, a name in the library's model list) is drawn by buildPlant like any
// model file — sized, seated, reduced in Fast. The list's names are not FILE names;
// treating them as paths makes a failed request per plant, then draws the same proxy.
const plantMesh = async (plant, options) => plantProxy(plant, options);


/**
 * A flight of steps: treads you can stand on and risers between them.
 *
 * Steps are first-class elements in the schema, DESIGN_KEYS and set_steps op.
 * The validator can require a flight across a steep stretch, so the viewer
 * must draw every accepted flight rather than report success with no visible
 * change.
 *
 * Drawn as DISCRETE levels rather than a draped ribbon, which is the whole point
 * — a path is what you get when the ground is walkable and steps are what you
 * build when it is not, so rendering them as a ramp would hide the distinction
 * the validator just spent a rejection making.
 */
export function stepsMesh(step, heightAt) {
  const stations = sweptStations(step.spline);
  const runLength = stations[stations.length - 1].run;
  const half = (step.width_m ?? 1.0) / 2;
  const riser = step.riser_m ?? 0.16;
  const going = step.going_m ?? 0.30;

  // Fall measured on the real ground at the two ends, not declared: the number
  // of risers IS the fall, and taking it from anywhere else is how a flight ends
  // up floating at its bottom tread.
  const a = stations[0], b = stations[stations.length - 1];
  const topY = heightAt(a.x, a.z), botY = heightAt(b.x, b.z);
  const fall = topY - botY;
  // CEIL, not round. Rounding down is the unsafe direction for steps: a 0.26 m
  // fall at a declared 0.18 m riser rounds to ONE 26 cm riser — half again the
  // limit, and a riser taller than code is a trip hazard. More, shallower risers
  // only makes the flight longer, which the validator already checks against the
  // run available.
  const n = Math.max(1, Math.ceil(Math.abs(fall) / riser - 1e-9));
  const dropPer = fall / n;                       // signed: a flight may climb

  /** Centre-line point and across-vector at an arbitrary run distance. */
  const at = run => {
    const r = Math.max(0, Math.min(runLength, run));
    let i = 1;
    while (i < stations.length - 1 && stations[i].run < r) i++;
    const p0 = stations[i - 1], p1 = stations[i];
    const t = p1.run === p0.run ? 0 : (r - p0.run) / (p1.run - p0.run);
    return { x: p0.x + (p1.x - p0.x) * t, z: p0.z + (p1.z - p0.z) * t,
             sx: p1.sx, sz: p1.sz };
  };

  const verts = [], uvs = [], idx = [];
  const quad = (p, q, y0, y1) => {              // p,q are across-edges; y0 top, y1 far
    const base = verts.length / 3;
    verts.push(p.x - p.sx * half, y0, p.z - p.sz * half,
               p.x + p.sx * half, y0, p.z + p.sz * half,
               q.x - q.sx * half, y1, q.z - q.sz * half,
               q.x + q.sx * half, y1, q.z + q.sz * half);
    uvs.push(0, 0, step.width_m ?? 1.0, 0, 0, going, step.width_m ?? 1.0, going);
    idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  };

  // Lay the flight along whatever run there actually is. If the spline is
  // shorter than n treads of `going`, the treads compress rather than the flight
  // running off the end of its own route — the validator owns whether that is
  // legal, this only has to draw what was asked for.
  const tread = Math.min(going, runLength / n);
  for (let i = 0; i < n; i++) {
    const y = topY - dropPer * (i + 1);          // step DOWN onto tread i
    const r0 = i * tread, r1 = (i + 1) * tread;
    quad(at(r0), at(r1), y, y);                                    // the tread
    if (i < n - 1) quad(at(r1), at(r1), y, y - dropPer);           // the riser face
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, makeGroundMaterial(step.material ?? "stone", undefined, "aggregate"));
  mesh.material.side = THREE.DoubleSide;         // risers are seen from below going up
  mesh.userData.id = step.id;
  return mesh;
}

// WHAT A REBUILD MAY KEEP. Rebuilding a whole design for one plant move regenerates
// every plant, bed and lava rock (up to 0.9 s a rock, ~7 s for seventeen), freezing
// the page. A part is kept when its source item is byte-identical
// and nothing it was draped on changed (`options.reuseSalt`). Held in a WeakMap, not
// userData: userData is exported with the scene (photoreal), and a design's JSON
// per mesh does not belong in a GLB.
const builtFrom = new WeakMap();

/** The parts of a built design group that a later build may keep, by what built them. */
export function reusableParts(group) {
  const parts = new Map();
  group?.traverse?.(o => { const b = builtFrom.get(o); if (b) parts.set(b.key, o); });
  return parts;
}

/**
 * WHERE THE LAST BUILD'S TIME WENT, by species: Map<label, {n, ms, tris}>.
 *
 * `editTimings` can report a long BUILD without showing which plants cost that
 * time. Only parts actually built are counted; a kept part costs nothing,
 * which is the point of keeping it.
 * Read it with `__pedon.plantTimings()`.
 */
export const plantBuildStats = new Map();
/** The last few builds' stats, oldest first. The FIRST build of a page load is the
 *  one that matters; retain it across the forced re-drape straight after it. */
export const plantBuildHistory = [];
function countTris(obj) {
  let n = 0;
  obj.traverse(o => {
    const g = o.geometry;
    if (!g) return;
    const per = (g.index ? g.index.count : g.attributes.position?.count ?? 0) / 3;
    n += per * (o.isInstancedMesh ? o.count : 1);
  });
  return Math.round(n);
}

/**
 * The design's plants as they are DRAWN at this growth: scaled for "Plants at", with the size the
 * design declares carried through. One owner: the build and the viewer's model loading both
 * ask it, so what is loaded is what is built.
 */
export function sizedPlantsOf(design, growth = 1) {
  return (design.plants ?? []).map(p => {
    const sized = growth === 1 ? p : { ...p,
      mature_spread_m: (p.mature_spread_m ?? 1) * growth,
      mature_height_m: (p.mature_height_m ?? 1) * growth,
      // The size the design DECLARES, carried through the scaling. "Plants at"
      // is a drawing control — it scales what is rendered and nothing else.
      // Which MODEL a plant uses is a decision,
      // not a drawing: a manzanita is a manzanita at three years and at thirty.
      // Without this, assetName() compares the SCALED height against
      // MIN_ASSET_HEIGHT_M, so at the default "~5 years" (0.70) the design's
      // 2.5 m Arctostaphylos falls to 1.75 m, drops under the 2.0 m gate
      // and renders procedurally — while a 3 m Ceanothus, landing at 2.1 m,
      // keeps its GLB. That silently changes the asset between the working
      // and mature views and leaves a fetched manzanita.glb unused.
      declared_height_m: p.mature_height_m ?? 1 };
    return sized;
  });
}

export async function buildDesignGroup(design, heightAt = () => 0, growth = 1, options = {}) {
  const group = new THREE.Group();
  group.name = "design";
  plantBuildStats.clear();
  const reuse = options.reuse ?? null;
  const salt = options.reuseSalt ?? "";
  // a caller that passes a salt is opting in: its parts are remembered even on a
  // first build with nothing to keep yet
  const remember = reuse !== null || options.reuseSalt !== undefined;
  // Keep an unchanged part, or build it and remember what it was built from. The
  // pose goes back to the built one: a drag PREVIEWS by moving the mesh, and a
  // refused move leaves the file — and so the key — exactly as it was. ONE key
  // per part, computed once: a lookup key that differed from the stored one would
  // still keep the part, after paying for the rebuild it exists to skip.
  const keyOf = (kind, item) => remember ? `${kind}|${salt}|${JSON.stringify(item)}` : null;
  const keep = key => {
    const kept = key && reuse?.get(key);
    if (!kept) return null;
    reuse.delete(key);
    const { pose } = builtFrom.get(kept);
    kept.position.copy(pose.position); kept.quaternion.copy(pose.quaternion); kept.scale.copy(pose.scale);
    return kept;
  };
  const note = (key, built) => {
    if (key && built) builtFrom.set(built, { key, pose: { position: built.position.clone(),
      quaternion: built.quaternion.clone(), scale: built.scale.clone() } });
    return built;
  };
  // `reseat`: the part reads the ground ONLY for where it stands, so the drape salt
  // stays out of its key and a kept one is stood on the new ground instead.
  const part = (kind, item, build, reseat = null) => {
    const key = reseat ? (remember ? `${kind}|${JSON.stringify(item)}` : null) : keyOf(kind, item);
    const kept = keep(key);
    if (kept) { reseat?.(kept); return kept; }
    // counted beside the plants: a re-drape can cost 6.8 s with 0 plants built
    const t0 = performance.now();
    const built = build();
    const label = `[${kind.split(":")[0]}] ${item.kind ?? item.id ?? ""}`;
    const row = plantBuildStats.get(label) ?? { n: 0, ms: 0, tris: 0 };
    row.n++; row.ms += performance.now() - t0; row.tris += built ? countTris(built) : 0;
    plantBuildStats.set(label, row);
    return note(key, built);
  };
  const parts = [];
  // A level surface's cut face depends on its NEIGHBOURS (a seam inside one bench
  // draws no face), so what it was built from includes them — or a moved bed would
  // leave a stale wall standing in the middle of the terrace beside it.
  const level = levelFootprints(design);
  const withSeams = item => item.level_m == null ? item
    : { ...item, __seams: level.filter(o => o.id !== item.id).map(o => [o.id, o.level, o.ring]) };
  const others = item => item.level_m == null ? [] : level.filter(o => o.id !== item.id);
  for (const bed of design.beds ?? [])
    parts.push(part("bed", withSeams(bed), () => bedMesh(bed, heightAt, others(bed))));
  for (const path of design.paths ?? [])
    parts.push(part("path", withSeams(path), () => pathMesh(path, heightAt, others(path))));
  for (const edge of design.edges ?? []) parts.push(part("edge", edge, () => edgeMesh(edge, heightAt)));
  for (const patio of design.patios ?? [])
    parts.push(part("patio", withSeams(patio), () => patioMesh(patio, heightAt, others(patio))));
  // what stands on the garden stands on it AS BUILT: a level surface's level inside
  // its footprint, the measured ground elsewhere
  const standAt = designedGround(design, heightAt);
  // A FLIGHT MEETS THE SURFACES IT JOINS: reading the scanned ground at its two ends
  // can put the top tread 0.6 m below the cut or filled terrace it leaves. It reads
  // the designed ground, and what that ground is made of is in its key.
  const onLevels = level.map(o => [o.id, o.level]);
  for (const st of design.steps ?? [])
    parts.push(part("steps", { ...st, __levels: onLevels }, () => stepsMesh(st, standAt)));
  // objects last: a lantern or a boulder reads against the ground and the
  // planting behind it, and an unmodelled kind draws as a marked placeholder
  // rather than being dropped — the library must never veto the design.
  // A scanned model that has not loaded yet draws a preset, so whether it has
  // loaded is part of what the part was built from.
  for (const ob of design.objects ?? [])
    parts.push(part(`object:${objectModelReady(ob)}`, ob, () => objectMesh(ob, standAt),
                    kept => seatObject(kept, ob, standAt)));
  const sizedPlants = sizedPlantsOf(design, growth);
  // WHAT WAS GENERATED BEFORE IS READ BACK, not generated again: Fast's kinds of plant are
  // kept in the browser, and building is synchronous, so they are read first
  if (options.quality === "fast")
    await restoreModels(sizedPlants.map(fastModelKey));
  const plants = await Promise.all((design.plants ?? []).map(async (p, i) => {
    const sized = sizedPlants[i];
    // A PLANT'S MESH NEVER TOUCHES THE GROUND DATA — plantMesh takes no heightAt;
    // only its POSITION does, and that is set below for kept and built alike. So
    // the drape salt is left out of a plant's key. Including it builds the whole
    // planting TWICE: once before the terrain arrives and identically again when
    // it does (4.6 s for 236 plants, up to 22 s measured). Quality stays in:
    // it changes the mesh.
    const key = remember ? `plant:${options.quality ?? ""}|${JSON.stringify(sized)}` : null;
    const kept = keep(key);
    if (kept) return kept;
    // THE SYNCHRONOUS PART ONLY. Timed across the `await`, every plant's figure
    // includes every OTHER plant's build — they all start inside one Promise.all,
    // and a continuation only runs after the rest have had their turn. The
    // result can report 483 s of work inside a 33 s build.
    const t0 = performance.now();
    const pending = plantMesh(sized, options);
    const cpu = performance.now() - t0;
    const built = await pending;
    const label = p.common ?? p.species ?? "?";
    const row = plantBuildStats.get(label) ?? { n: 0, ms: 0, tris: 0 };
    row.n++; row.ms += cpu; row.tris += countTris(built);
    plantBuildStats.set(label, row);
    return note(key, built);
  }));
  (design.plants ?? []).forEach((p, i) => {
    const m = plants[i];
    const pos = enuToWorld(p.position[0], p.position[1], 0);
    pos.y = standAt(pos.x, pos.z);
    m.position.copy(pos);
    m.userData.id = p.id;
    parts.push(m);
  });
  // added only once every part exists: add() re-parents, so a kept part leaves
  // the group still on screen at this moment, never earlier
  for (const m of parts) group.add(m);
  plantBuildHistory.push({ at: Math.round(performance.now()), quality: options.quality ?? "",
                           rows: [...plantBuildStats].map(([plant, r]) => ({ plant, ...r })) });
  if (plantBuildHistory.length > 6) plantBuildHistory.shift();
  return group;
}

// A flat ring lying on the terrain: this is the marker's true ground position,
// unambiguous even when the pin above it floats.
function groundRing(p, color, tag) {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.22, 0.34, 24),
    new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.95, depthTest: false }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(p.x, p.y + PIN_LIFT.ring, p.z);
  ring.renderOrder = 3;
  if (tag !== undefined) { ring.userData.landmark = tag; ring.userData.pinLift = PIN_LIFT.ring; }
  return ring;
}

export function buildFootprintOverlay(site, heightAt = () => 0) {
  const group = new THREE.Group();
  group.name = "footprint";
  // user-marked landmarks. A floating pin alone leaves the actual ground point
  // ambiguous on a slope, so each gets a ring ON the terrain plus a stem up to
  // the marker — the ring is the coordinate, the stem shows how high the
  // marker floats above it.
  for (const lm of site?.landmarks ?? []) {
    const p = enuToWorld(lm.x, lm.y, 0);
    p.y = heightAt(p.x, p.z);
    group.add(groundRing(p, 0x4dd2ff, lm.name));
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.035, 1.6, 6),
      new THREE.MeshBasicMaterial({ color: 0x4dd2ff, transparent: true, opacity: 0.75 }));
    stem.position.set(p.x, p.y + PIN_LIFT.stem, p.z);
    stem.userData.landmark = lm.name;      // draggable
    stem.userData.pinLift = PIN_LIFT.stem;
    group.add(stem);
    const knob = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0x4dd2ff }));
    knob.position.set(p.x, p.y + PIN_LIFT.knob, p.z);
    knob.userData.landmark = lm.name;
    knob.userData.pinLift = PIN_LIFT.knob;
    group.add(knob);
    const lbl = textLabel(lm.name, "landmark");
    lbl.position.set(p.x, p.y + PIN_LIFT.label, p.z);
    // NOT `landmark`: pickPin raycasts everything tagged with that, and a label is
    // not a mesh. Tagged so the whole pin follows a drag, not just the part grabbed.
    lbl.userData.landmarkLabel = lm.name;
    lbl.userData.pinLift = PIN_LIFT.label;
    group.add(lbl);
  }
  if (!site?.footprint?.length) return group;
  // Just the house outline, drawn on the ground. "Set north" needs no 12 m posts
  // or curtain walls; those clutter the viewport and renders sent to the naming model.
  const pts = site.footprint.map(([x, y]) => {
    const p = enuToWorld(x, y, 0);
    p.y = heightAt(p.x, p.z) + 0.05;
    return p;
  });
  const outline = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([...pts, pts[0]]),
    new THREE.LineBasicMaterial({ color: 0xc4544a, transparent: true, opacity: 0.75 }));
  outline.name = "houseOutline";
  group.add(outline);
  return group;
}
