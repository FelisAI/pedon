// Landscape objects: the things a garden is made of that are not ground.
//
// WHY THIS EXISTS. Beds, paths, patios, plants, edges and steps cannot write down
// a bench, a boulder, a stone lantern, a water basin, a pergola or a fire pit.
// Without objects a design can only name a PATIO after a fire pit, and a style
// such as a Mediterranean / Japanese / Chinese fusion collapses into gravel and
// planting: those objects ARE the style, and a model with no grammar for them
// cannot place them however well it imagines them.
//
// THE RULE: the asset library's limitations must never limit the model. So
// `kind` is FREE TEXT, never an enum. The model asks for what the design
// needs and this module always returns something honest:
//
//   * a known kind gets purpose-built procedural geometry;
//   * an unknown kind gets a PLACEHOLDER at the size that was asked for, marked
//     as one, so it reads as "not modelled yet" rather than as a design decision;
//   * nothing is silently substituted and nothing is refused.
//
// Unmatched kinds become a WANT LIST (see `wants`), which turns a missing asset
// into a work item for the owner instead of an invisible downgrade nobody finds
// out about. That is the whole difference between a library that limits the design
// and a library that merely lags it.
//
// Procedural, not downloaded: no API key, no Blender, no new
// dependency. A lantern is a stack of lathed sections, a basin is a lathe, a
// boulder is a jittered icosahedron. Fidelity can improve later by routing a kind
// to a real GLB — the grammar does not have to change for that to happen.
import * as THREE from "three";
import { buildAssetObject } from "./assets.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { groundTexture } from "./grain.js";
import { enuToWorld } from "./design.js";

const STONE = 0x9a958a, DARK_STONE = 0x6f6a62, TIMBER = 0x7a5f43;
// scoria: near-black with a rust cast, never the neutral grey of granite
const LAVA = 0x3d332c;   // grain lightens it and warm sun lifts it further.
                         // Scoria is near-black with a rust cast -- but a value dark
                         // enough to look black is a silhouette with no surface:
                         // the pits stop reading because nothing catches light
                         // inside them. So this is a warm dark grey-brown, which is
                         // what scoria measures in sun.
const WATER = 0x3e5c63, METAL = 0x5d5a55;
// Exported: the panel that lists what could not be built has to be painted the
// same amber as the box standing in the yard, or the two stop reading as one
// fact. A re-typed hex drifts the first time either is tuned.
export const PLACEHOLDER_COLOUR = 0xb98b4a;
const PLACEHOLDER = PLACEHOLDER_COLOUR;

/**
 * An object material, with GRAIN.
 *
 * Flat colour is the most obviously computer-generated thing in any frame, which
 * is why the ground has a granular texture — and a stone lantern, a timber bench,
 * a dry-stone rim or a boulder in one unbroken hue fails the same way beside it.
 * The argument is not about the ground, so every object material carries grain.
 *
 * `grain` says how strongly the speck varies and `coarse` how big each speck is,
 * matching grain.js's own vocabulary. `tile_m` is the size the texture repeats
 * over in metres — small for a lantern's dressed stone, larger for a boulder.
 * Pass `grain: 0` for anything that really is uniform (water, a painted screen).
 */
const mat = (color, opts = {}) => {
  const { grain = 0.16, coarse = 2.4, tile_m = 0.55, ...rest } = opts;
  const m = new THREE.MeshStandardMaterial({
    color: grain > 0 ? 0xffffff : color, roughness: 0.85, metalness: 0.05, ...rest });
  if (grain > 0) {
    const map = groundTexture(color, grain, coarse).clone();
    map.needsUpdate = true;                   // a clone re-uploads on first use
    map.repeat.set(1 / tile_m, 1 / tile_m);
    map.anisotropy = 8;
    m.map = map;
  }
  return m;
};

/** A lathe from [radius, height] pairs, measured from the base up. */
function lathe(profile, color, segments = 14) {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 0.001), y));
  return new THREE.Mesh(new THREE.LatheGeometry(pts, segments), mat(color));
}

// ── the kinds, keyed on what a model would actually call them ─────────────
// Each builder returns geometry with its BASE AT y=0, so placement is one add.
const BUILDERS = {
  lantern: (h, w) => {                       // ishidoro: base, shaft, firebox, cap
    const g = new THREE.Group();
    // The profile below stacks to 1.34 units: base 0.16 + shaft 0.62 + firebox
    // 0.28 + cap 0.185 + finial 0.105. Dividing by anything else draws the lantern
    // at a height the design did not ask for (by 1.6, an ishidoro placed at the
    // catalogue's own 1.4 m comes out 1.12 m). A viewer that renders something
    // other than what the file says makes every measurement in the project
    // unfalsifiable, which is the same rule that keeps instanceScale out of the
    // renderer.
    //
    // AND THE DIVISOR MOVES WITH THE PROFILE. Change any section's height and
    // this number must change with it, or the lantern draws off its declared
    // height. tests/js/objects.test.mjs measures it instead of trusting the
    // comment.
    const s = h / 1.34;
    g.add(lathe([[0.22 * s, 0], [0.20 * s, 0.10 * s], [0.10 * s, 0.16 * s]], STONE));
    const shaft = lathe([[0.08 * s, 0], [0.08 * s, 0.62 * s]], STONE);
    shaft.position.y = 0.16 * s; g.add(shaft);

    // THE FIREBOX IS OPEN, and that is the whole object. A hibukuro built as a
    // solid six-sided drum renders an ishidoro as a mushroom on a post: a lantern
    // with nowhere for the light is a bollard. Built as six corner posts between a
    // floor and a lintel, so the openings are real gaps that read from every angle
    // — including the plan view, where a solid drum is just a hexagon.
    const fy = 0.78 * s, fh = 0.28 * s, fr = 0.19 * s;
    for (const [r, y, t] of [[0.21 * s, fy + 0.018 * s, 0.036 * s],
                             [0.20 * s, fy + fh - 0.020 * s, 0.040 * s]]) {
      const plate = new THREE.Mesh(new THREE.CylinderGeometry(r, r, t, 6), mat(STONE));
      plate.position.y = y; g.add(plate);
    }
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      const post = new THREE.Mesh(
        new THREE.BoxGeometry(0.042 * s, fh - 0.03 * s, 0.042 * s), mat(DARK_STONE));
      post.position.set(Math.cos(a) * fr, fy + fh / 2, Math.sin(a) * fr);
      post.rotation.y = -a;
      g.add(post);
    }

    // The KASA has eaves. A plain cone is a party hat; a real cap is a shallow
    // concave sweep that flares out at the rim, and the flare is what casts the
    // shadow line that says "lantern" at fifteen metres.
    const cap = lathe([[0.06 * s, 0], [0.17 * s, 0.055 * s], [0.26 * s, 0.115 * s],
                       [0.34 * s, 0.155 * s], [0.345 * s, 0.175 * s],
                       [0.30 * s, 0.185 * s]], STONE, 6);
    cap.position.y = 1.06 * s; g.add(cap);
    // the hoju: the onion finial, and the last 4 cm of the silhouette
    const finial = lathe([[0.045 * s, 0], [0.065 * s, 0.035 * s], [0.05 * s, 0.075 * s],
                          [0.015 * s, 0.105 * s]], STONE, 10);
    finial.position.y = 1.235 * s; g.add(finial);
    return g;
  },
  basin: (h, w) => {                         // tsukubai: a stone bowl holding water
    const g = new THREE.Group();
    const r = (w || 0.6) / 2;
    // The RIM is at h, the height the caller asked for. A profile written in its
    // own units and never reconciled with that height (a rim at h * 0.8) stands a
    // basin asked for at 0.4 m at 0.32 m — a fifth short.
    g.add(lathe([[r, 0], [r, h * 0.94], [r * 0.82, h], [r * 0.82, h * 0.31], [0, h * 0.28]], STONE, 18));
    // grain: 0 — water is the uniform case `mat` names ("pass grain: 0 for
    // anything that really is uniform"). With grain, a water surface wears a
    // speckled STONE texture and reads as a disc of grey concrete.
    const water = new THREE.Mesh(new THREE.CircleGeometry(r * 0.8, 18),
                                 mat(WATER, { grain: 0, roughness: 0.06, metalness: 0.1 }));
    water.rotation.x = -Math.PI / 2; water.position.y = h * 0.90; g.add(water);
    return g;
  },
  /**
   * A LAVA ROCK, which is not a dark boulder.
   *
   * Large lava rocks (over 10 inches) hold soil on a slope, and the temptation is
   * to take the boulder above and paint it black. That is the
   * category error ASSET_FIDELITY.md rule 6 is about: the one feature that makes
   * the thing recognisable has to be in the GEOMETRY, not in the colour. Scoria is
   * VESICULAR — gas froze in it as it cooled, so it is riddled with bubble
   * cavities, and at arm's length that pitting is the entire difference between
   * lava and any other dark rock. A smooth dark stone reads as wet granite.
   *
   * So: the fractured form comes from the boulder's own method (noise, then cutting
   * planes, then flat shading), and on top of it every vertex is pulled INWARD
   * where it falls inside a bubble — many small ones and a few large cavities,
   * because real scoria has both. The pits are what the light breaks on.
   *
   * Lava also breaks more sharply than weathered granite and is not bedded as
   * deeply: it is angular, it sits ON ground rather than settling into it, and it
   * is nearly black with a rust cast rather than grey.
   */
  lava_rock: (h, w, seed = 0) => {
    const r = (w || h) / 2;
    // A VESICLE MUST BE BIGGER THAN THE MESH CAN RESOLVE, or it does not exist.
    // A 0.035 m target edge is ~3 cm between vertices at this size while the
    // bubbles are ~1.5 cm across — so nearly every one lands between vertices
    // and moves nothing, and the rock renders as a smooth brown pyramid. Triangle
    // count and declared height both pass; only looking at one close shows it.
    // Target edge is 7 mm here, which is the resolution scoria actually needs,
    // and there is no triangle budget to trade it against.
    const detail = Math.max(6, Math.min(34, Math.ceil((r * 1.05) / 0.007) - 1));
    const geo = new THREE.IcosahedronGeometry(r, detail);
    const p = geo.attributes.position;
    let t = (seed * 2654435761) >>> 0 || 0x85ebca6b;
    const rnd = () => { t = (t * 1664525 + 1013904223) >>> 0; return t / 4294967296; };

    // fracture planes — more of them and biting deeper than a boulder's, because
    // lava shatters rather than wears
    const cuts = [];
    // 6-9 planes biting at 0.62-0.82 r. At 10-13 planes and 0.46-0.64 r the
    // planes eat the whole stone: it comes out a four-sided pyramid, all fracture
    // and no rock. The cuts are meant to give arrises, not to carve.
    const nPl = 6 + Math.floor(rnd() * 4);
    for (let i = 0; i < nPl; i++) {
      const a = rnd() * Math.PI * 2, z = rnd() * 1.8 - 0.9;
      const sxy = Math.sqrt(Math.max(0, 1 - z * z));
      cuts.push({ nx: Math.cos(a) * sxy, ny: z, nz: Math.sin(a) * sxy,
                  d: r * (0.62 + rnd() * 0.20) });
    }

    // THE VESICLES. Count scales with surface area, so a 60 cm rock is not a 25 cm
    // one with the same few holes stretched over it. A handful are large cavities.
    const ves = [];
    const n = Math.round(110 + 320 * (r * r));
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2, z = rnd() * 2 - 1;
      const sxy = Math.sqrt(Math.max(0, 1 - z * z));
      const big = rnd() < 0.13;
      ves.push({ x: Math.cos(a) * sxy, y: z, z: Math.sin(a) * sxy,
                 // angular radius: 0.09 rad on a 0.27 m stone is a ~2.4 cm pit,
                 // which is what a real cavity measures and is well above the
                 // 7 mm vertex spacing rather than below it
                 rad: big ? 0.20 + rnd() * 0.14 : 0.085 + rnd() * 0.075,
                 // Depth is measured, not guessed. At 0.11 r the pits are real
                 // but invisible past the fracture facets: building the rock with
                 // the vesicles switched OFF changes the deep-vertex count by 3%
                 // (218 cavities against 234), which means the bubbles only
                 // decorate a shape the cuts already made. A cavity has to bite
                 // deeper than the planes do to be the thing you see.
                 depth: (big ? 0.34 : 0.21) * (0.7 + rnd() * 0.6) });
    }
    // THE COST OF A LAVA ROCK IS ONE LINE: an acos for every vertex against
    // every vesicle — ~60,000 x ~130, eight million a rock. A vertex is inside a
    // bubble exactly when the DOT exceeds cos(rad), so the dot is tested first
    // and the acos is only taken for the few that pass. The threshold is
    // loosened by 1e-9 and the exact test still decides, so the geometry is
    // bit-identical — checked by hashing the position buffer.
    for (const b of ves) b.near = Math.cos(b.rad) - 1e-9;

    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const u = x / r, v = y / r, wv = z / r;
      const k = 1
        + 0.19 * Math.sin(2.1 * u + 0.7) * Math.cos(2.2 * wv - 0.9)
        + 0.12 * Math.sin(3.9 * v + 1.6)
        + 0.07 * Math.cos(5.6 * u - 3.1 * wv);
      let px = x * k, py = y * k, pz = z * k;
      for (const c of cuts) {
        const dot = px * c.nx + py * c.ny + pz * c.nz;
        if (dot > c.d) { const e = dot - c.d; px -= c.nx * e; py -= c.ny * e; pz -= c.nz * e; }
      }
      // pull inward inside a bubble, with a smooth rim so it is a cavity and not a spike
      const L = Math.hypot(px, py, pz) || 1;
      const ux = px / L, uy = py / L, uz = pz / L;
      let sink = 0;
      for (const b of ves) {
        const dot = ux * b.x + uy * b.y + uz * b.z;
        if (dot < b.near) continue;
        const d = Math.acos(Math.max(-1, Math.min(1, dot)));
        if (d < b.rad) {
          const f = 0.5 + 0.5 * Math.cos((d / b.rad) * Math.PI);
          sink = Math.max(sink, b.depth * f);
        }
      }
      if (sink > 0) { const g = 1 - sink; px *= g; py *= g; pz *= g; }
      p.setXYZ(i, px, py, pz);
    }

    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    // shallower than a boulder's 0.09: lava sits ON the ground, it does not settle
    const BURY = 0.05;
    const sx = (w || h) / Math.max(bb.max.x - bb.min.x, 1e-4);
    const sz = (w || h) / Math.max(bb.max.z - bb.min.z, 1e-4);
    const sy = (h / (1 - BURY)) / Math.max(bb.max.y - bb.min.y, 1e-4);
    const flat = Math.min(sx, sz);
    for (let i = 0; i < p.count; i++)
      p.setXYZ(i, (p.getX(i) - (bb.max.x + bb.min.x) / 2) * flat,
                  (p.getY(i) - (bb.max.y + bb.min.y) / 2) * sy,
                  (p.getZ(i) - (bb.max.z + bb.min.z) / 2) * flat);
    geo.computeBoundingBox();          // the stale-cache trap the boulder documents
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat(LAVA, { flatShading: true, grain: 0.13,
                                              coarse: 1.1, tile_m: 0.22, roughness: 0.98 }));
    m.position.y = (h / (1 - BURY)) * (0.5 - BURY);
    return m;
  },
  /**
   * A boulder — set stone, which means FRACTURED stone.
   *
   * A sphere displaced by smooth low-frequency sinusoids is a potato by
   * construction: every surface gently curved, no edge anywhere, nothing for the
   * light to break on, and it reads as a bread roll. A boulder is broken rock —
   * broad flat planes meeting at arrises — and the planes are what make it read
   * as stone at any distance.
   *
   * So the noise stays (it gives the lumpy, weathered form) and the vertices are
   * then CUT by a handful of planes: a vertex outside a plane is projected onto
   * it, which makes the faces near that plane coplanar and, with flatShading,
   * gives a real facet with a real edge. Cutting rather than re-tessellating means
   * the subdivision above still controls how fine the curved parts are.
   *
   * SEEDED, because set stone comes in groups. Five identical clones is the
   * flat-colour problem in another form — the eye reads repetition as manufacture
   * instantly, and set stone is placed as an asymmetric group of odd number.
   * objectMesh derives the seed from the object's id or position, so a
   * given stone is identical in every frame and different from its neighbour.
   */
  boulder: (h, w, seed = 0) => {
    const r = (w || h) / 2;
    // Subdivision scales with SIZE, like the foliage masses in plants.js. At a
    // fixed detail 1 — 80 faces whatever the radius — a 0.9 m set stone has
    // 0.41 m plates and reads from the path as a faceted polyhedron. The edge
    // target is 0.05 m; there is no triangle budget to trade it against.
    //
    // Detail from a TARGET EDGE LENGTH rather than from size tiers picked by
    // hand. three.js's `detail` is not what it looks like: PolyhedronGeometry
    // subdivides each base face into (detail+1)^2, so detail 3 is 320 faces, not
    // the 1280 the doubling suggests — a tier table written on that assumption
    // silently under-subdivides every stone.
    const detail = Math.max(1, Math.min(12, Math.ceil((r * 1.05) / 0.05) - 1));
    const geo = new THREE.IcosahedronGeometry(r, detail);
    const p = geo.attributes.position;

    // a small deterministic PRNG, so a seeded stone is the same in every frame
    let t = (seed * 2654435761) >>> 0 || 0x9e3779b9;
    const rnd = () => { t = (t * 1664525 + 1013904223) >>> 0; return t / 4294967296; };
    // Bedding and fracture planes. Distances are a fraction of r, so a plane
    // always cuts something but never truncates the stone to a chip.
    // 8-11 planes at 0.50-0.70 r. At 5-7 planes and 0.64-0.86 r the stone still
    // reads as a lump: the noise above pushes vertices out to ~1.34 r, so cuts
    // that far out only clip the extremes and leave the smooth surface owning
    // everything you actually see. The planes have to bite INSIDE the mean
    // radius before the facets, rather than the curvature, become the form.
    const cuts = [];
    const nPl = 8 + Math.floor(rnd() * 4);
    for (let i = 0; i < nPl; i++) {
      const a = rnd() * Math.PI * 2, z = rnd() * 1.7 - 0.85;
      const sxy = Math.sqrt(Math.max(0, 1 - z * z));
      cuts.push({ nx: Math.cos(a) * sxy, ny: z, nz: Math.sin(a) * sxy,
                  d: r * (0.50 + rnd() * 0.20) });
    }

    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const u = x / r, v = y / r, wv = z / r;
      // Displacement by POSITION, not by vertex index: neighbouring vertices move
      // together, which is what makes a form rather than noise, and it stays
      // deterministic.
      const k = 1
        + 0.17 * Math.sin(2.3 * u + 1.1) * Math.cos(1.9 * wv - 0.4)
        + 0.11 * Math.sin(3.7 * v + 2.2)
        + 0.06 * Math.cos(5.1 * u - 3.3 * wv);
      let px = x * k, py = y * k, pz = z * k;
      for (const c of cuts) {
        const dot = px * c.nx + py * c.ny + pz * c.nz;
        if (dot > c.d) {
          const e = dot - c.d;
          px -= c.nx * e; py -= c.ny * e; pz -= c.nz * e;
        }
      }
      p.setXYZ(i, px, py, pz);
    }
    // Cutting shrinks the stone, and by an amount that depends on the seed — so
    // normalise to the size that was ASKED for rather than whatever the planes
    // left. Without this a boulder is a different size every seed, which is
    // exactly the class of defect objects.test.mjs measures.
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    // A SET STONE IS BEDDED, so its declared height is the part that SHOWS. The
    // geometry is built 1/(1 - BURY) taller than asked and then sunk by the
    // difference, which leaves exactly h standing proud — rather than the 92% that
    // normalising the whole stone to h and then burying it would give.
    const BURY = 0.09;
    const sx = (w || h) / Math.max(bb.max.x - bb.min.x, 1e-4);
    const sz = (w || h) / Math.max(bb.max.z - bb.min.z, 1e-4);
    const sy = (h / (1 - BURY)) / Math.max(bb.max.y - bb.min.y, 1e-4);
    const flat = Math.min(sx, sz);
    for (let i = 0; i < p.count; i++)
      p.setXYZ(i, (p.getX(i) - (bb.max.x + bb.min.x) / 2) * flat,
                  (p.getY(i) - (bb.max.y + bb.min.y) / 2) * sy,
                  (p.getZ(i) - (bb.max.z + bb.min.z) / 2) * flat);
    // RECOMPUTE THE BOX. computeBoundingBox() above cached the PRE-normalisation
    // bounds, and Box3.setFromObject reuses geometry.boundingBox when it is set
    // rather than walking the vertices — so every consumer of the stone's extent
    // (frustum culling, selection, float_check) would be handed the bounds of a
    // shape that no longer exists: 0.776 m for a 0.600 m stone.
    //
    // A debug script that calls computeBoundingBox() itself before reading the
    // box cannot see this: it REPAIRS the stale cache as a side effect and
    // reports the correct 0.600 — the instrument fixing the fault while
    // measuring it.
    geo.computeBoundingBox();
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat(DARK_STONE, { flatShading: true }));
    m.position.y = (h / (1 - BURY)) * (0.5 - BURY);    // set INTO the ground, as stone is
    const g = new THREE.Group(); g.add(m); return g;
  },
  bench: (h, w) => {
    // SLATS, not a plank. Three boxes and 36 triangles would be the crudest
    // thing in the catalogue on the object most often placed, being where a
    // garden is actually sat in. A bench reads as a bench because of the gaps: the
    // line of shadow between the boards is most of what says "seat" rather than
    // "block", and it costs a few dozen triangles to have.
    //
    // Backless on purpose. A garden bench that faces a view has no back in half
    // the references, and the design agent asks for the seat by its HEIGHT —
    // adding a back would make `height_m` mean two different things.
    const g = new THREE.Group(), L = w || 1.6, seat = h || 0.45;
    const D = 0.42;                                   // seat depth
    const N = 5;                                      // boards
    const gap = 0.012;
    const bw = (D - gap * (N - 1)) / N;
    for (let i = 0; i < N; i++) {
      const board = new THREE.Mesh(new THREE.BoxGeometry(L, 0.045, bw), mat(TIMBER));
      board.position.set(0, seat, -D / 2 + bw / 2 + i * (bw + gap));
      g.add(board);
    }
    // a rail under the boards, so they are carried rather than floating
    for (const dz of [-D / 2 + 0.06, D / 2 - 0.06]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(L * 0.94, 0.05, 0.05), mat(TIMBER));
      rail.position.set(0, seat - 0.048, dz); g.add(rail);
    }
    for (const dx of [-L / 2 + 0.14, L / 2 - 0.14]) {
      // tapered legs: a slab reads as a plinth, and the taper is what makes it
      // furniture instead of masonry
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.062, seat - 0.07, 4),
                                 mat(DARK_STONE));
      leg.rotation.y = Math.PI / 4;
      leg.position.set(dx, (seat - 0.07) / 2, 0); g.add(leg);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.045, D * 0.78), mat(DARK_STONE));
      foot.position.set(dx, seat - 0.093, 0); g.add(foot);
    }
    return g;
  },
  pot: (h, w) => {
    const r = (w || h * 0.8) / 2;
    return lathe([[r * 0.45, 0], [r * 0.92, h * 0.35], [r, h * 0.8], [r * 0.98, h],
                  [r * 0.86, h * 0.97], [r * 0.82, h * 0.3], [0, h * 0.12]], 0x8c6f5a, 18);
  },
  /**
   * A fire pit — a drum, a bed of lava rock, and burnt wood in it.
   *
   * The drum alone — a smooth stone ring with a recessed floor — is
   * indistinguishable from a PLANTER and reads as one on the review sheet.
   * What says "fire" is not the masonry — every raised bed has masonry — it is
   * what is inside. A fire pit is looked into, and an empty one is furniture with
   * no purpose visible.
   *
   * The bed is scattered aggregate rather than a flat disc, because a disc at the
   * bottom of a drum reads as standing water; and the logs sit low and crossed,
   * which is how wood actually falls once it has burnt rather than the tidy
   * wigwam it was laid as.
   */
  firepit: (h, w, seed = 0) => {
    const g = new THREE.Group(), r = (w || 0.9) / 2, ht = h || 0.4;
    g.add(lathe([[r, 0], [r, ht], [r * 0.82, ht], [r * 0.82, ht * 0.4], [0, ht * 0.35]], DARK_STONE, 20));
    let t = (seed * 2654435761) >>> 0 || 0x51ed270b;
    const rnd = () => { t = (t * 1664525 + 1013904223) >>> 0; return t / 4294967296; };
    const floor = ht * 0.37;
    // the bed: dark lava rock, small and many, filling the bowl to just over the
    // recessed floor
    const bed = [];
    for (let i = 0; i < 90; i++) {
      const a = rnd() * Math.PI * 2, rad = Math.sqrt(rnd()) * r * 0.76;
      const sz = r * (0.035 + rnd() * 0.045);
      const st = new THREE.IcosahedronGeometry(sz, 0);
      st.scale(1, 0.7, 1);
      st.translate(Math.cos(a) * rad, floor + sz * 0.45, Math.sin(a) * rad);
      bed.push(st);
    }
    const bedGeo = mergeGeometries(bed, false);
    for (const b of bed) b.dispose();
    if (bedGeo) g.add(new THREE.Mesh(bedGeo, mat(0x37322e, { grain: 0.3, coarse: 3.4,
                                                             tile_m: 0.12, flatShading: true })));
    // burnt wood: charred bark, and the split faces still warm
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + rnd() * 0.7;
      const len = r * (0.9 + rnd() * 0.5), rad = r * (0.055 + rnd() * 0.03);
      const log = new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.85, rad, len, 7),
                                 mat(0x2a2320, { grain: 0.34, coarse: 4.0, tile_m: 0.10 }));
      log.rotation.set(Math.PI / 2 - (0.10 + rnd() * 0.16), a, 0, "YXZ");
      log.position.set(Math.cos(a) * r * 0.16, floor + rad * 1.5 + r * 0.05,
                       Math.sin(a) * r * 0.16);
      g.add(log);
      // the cut end glows: one warm face is what separates "burnt" from "dirty"
      const ember = new THREE.Mesh(new THREE.CircleGeometry(rad * 0.8, 8),
                                   mat(0xc4592a, { grain: 0.4, coarse: 5.0, tile_m: 0.06 }));
      ember.position.copy(log.position);
      ember.position.x += Math.cos(a) * len * 0.46;
      ember.position.z += Math.sin(a) * len * 0.46;
      ember.position.y += len * 0.06;
      ember.lookAt(ember.position.x + Math.cos(a), ember.position.y + 0.35,
                   ember.position.z + Math.sin(a));
      g.add(ember);
    }
    return g;
  },
  /**
   * A screen — a close-set panel of bamboo canes, bound to two rails.
   *
   * IT HAS TO ACTUALLY SCREEN. Eleven 4.4 cm poles spread across two metres
   * cover 24% of the width, which is a picket fence — a dotted line in plan —
   * and the one thing this object exists to do is block a view. Its own
   * catalogue note says so: "blocks a view — check it does not also block a way
   * through".
   *
   * A kenninji-gaki is canes set touching, with only a seam of light between
   * them. The count is DERIVED from the width and the cane, so a 4 m screen is
   * still a screen rather than the same eleven poles stretched further apart.
   */
  screen: (h, w) => {
    const g = new THREE.Group(), L = w || 1.8, ht = h || 1.8;
    const rad = 0.021, gap = 0.006;                  // cane radius, seam of light
    const pitch = rad * 2 + gap;
    const n = Math.max(6, Math.round(L / pitch));
    for (let i = 0; i < n; i++) {
      // canes vary: a bundle of identical cylinders is the flat-colour problem in
      // another form, and real cut bamboo is never the same twice
      const rr = rad * (0.88 + ((i * 37) % 11) / 40);
      const hh = ht * (0.985 + ((i * 53) % 7) / 400);
      const cane = new THREE.Mesh(new THREE.CylinderGeometry(rr, rr * 1.04, hh, 7),
                                  mat(TIMBER, { grain: 0.20, coarse: 3.2, tile_m: 0.22 }));
      cane.position.set(-L / 2 + rad + (L - rad * 2) * (i / Math.max(n - 1, 1)),
                        hh / 2, ((i * 29) % 5 - 2) * 0.002);
      g.add(cane);
    }
    // the binding rails sit BEHIND the canes, which is how they are really tied
    for (const y of [ht * 0.14, ht * 0.86]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(L, 0.05, 0.045),
                                  mat(TIMBER, { grain: 0.18, coarse: 2.6, tile_m: 0.4 }));
      rail.position.set(0, y, -rad - 0.024); g.add(rail);
    }
    return g;
  },
  /**
   * A moon gate — yuedongmen: a garden wall with a circular opening you walk
   * through.
   *
   * The HOLE is the element. It frames what is beyond it, which is the whole
   * reason it exists in a Chinese garden and the one thing a solid panel cannot
   * do.
   *
   * Built as an extruded Shape with a circular hole rather than as an arch of
   * blocks: it is one piece of masonry with an opening cut in it, which is what a
   * rendered wall should be, and the alternative (a torus plus two piers) leaves
   * seams where the circle meets the jambs.
   */
  moon_gate: (h, w) => {
    const ht = h || 2.6, L = w || 2.4, t = 0.22;
    // YOU WALK THROUGH IT. A circle centred at 0.52 of the height puts its bottom
    // 0.43 m off the ground on a 2.4 m gate — a threshold you step over, which is
    // a window, not a gate. In a real yuedongmen the circle comes down almost to
    // grade and the sill closes the last hand's width of it.
    //
    // That cannot be had on a SQUARE wall, and a square wall reads as a slab. A
    // 2.4 m circle needs about 0.7 m of masonry either side to read as a frame,
    // so the wall has to be over 3 m wide — a moon gate is a segment of garden
    // WALL with a circle cut in it, and it is always wider than it is tall.
    // OBJECT_META's default width is 3.4 m for the same reason. At those
    // proportions: a 1.92 m opening from 0.12 m to 2.04 m, which is headroom,
    // with 0.74 m of wall on each side.
    // The radius is 0.36 of the width. A smaller circle (0.30) wins frame but
    // pushes the sill UP: a smaller circle sitting on the same threshold reaches
    // less headroom, so the rule below has to raise it further. At the
    // catalogue's 3.4 m width, 0.36 still leaves 0.74 m of masonry each side.
    const r = Math.min(L * 0.36, ht * 0.40);
    // The circle's diameter is capped by the WALL'S WIDTH, so a narrow gate cannot
    // have both a low sill and headroom — it is one or the other, and which one
    // you get should be decided rather than fallen into. Headroom wins: a gate you
    // must duck through is not a gate at all, whereas a threshold you step over is
    // ordinary. So the circle sits as LOW as the sill allows, and is raised only as
    // far as it must be to keep 2.05 m of clear height.
    //
    // On the catalogue's own 3.4 x 2.4 m that gives 0.13 m to 2.05 m — you walk
    // through it. On a 2.4 m wall it gives 0.61 m to 2.05 m, which is a window with
    // headroom, and is the honest answer for a wall that narrow.
    // HEAD is the top of the CIRCLE, and the rim eats into it: the torus is
    // r + 0.035 with a 0.075 tube, so its inner face sits 0.04 m inside the
    // opening. A HEAD of 2.05 measures 2.01 m of real clear height; 2.15 leaves a
    // true 2.11 m, which a person walks through without thinking about it.
    const SILL = 0.12, HEAD = 2.15;
    const cy = Math.max(SILL + r, Math.min(HEAD - r, ht * 0.55));
    const outline = new THREE.Shape();
    outline.moveTo(-L / 2, 0);
    outline.lineTo(L / 2, 0);
    outline.lineTo(L / 2, ht);
    outline.lineTo(-L / 2, ht);
    outline.lineTo(-L / 2, 0);
    const hole = new THREE.Path();
    hole.absarc(0, cy, r, 0, Math.PI * 2, true);
    outline.holes.push(hole);
    const geo = new THREE.ExtrudeGeometry(outline, { depth: t, bevelEnabled: false, curveSegments: 48 });
    geo.translate(0, 0, -t / 2);
    // The plaster is warm and coarse. A flat 0xd8d2c6 at the default fine grain
    // reads as PAPER, or as a slab, and a limewashed garden wall is an off-white
    // with a visible float texture, closer to unglazed porcelain than to printer
    // paper.
    const wall = new THREE.Mesh(geo, mat(0xd9d1bd, { flatShading: false, grain: 0.26,
                                                     coarse: 1.5, tile_m: 0.9 }));
    const g = new THREE.Group();
    g.add(wall);
    // a coping course, so the top reads as built rather than sawn off
    const cap = new THREE.Mesh(new THREE.BoxGeometry(L + 0.14, 0.09, t + 0.14), mat(DARK_STONE));
    cap.position.y = ht + 0.045;
    g.add(cap);
    // A BASE COURSE. A wall meets the ground on something — a plinth of dressed
    // stone, wider and darker than the plaster it carries — and without one the
    // gate is a panel standing in the air, however good its coping and rim are.
    // Plinth + body + coping is the whole reason a wall reads as built; two of
    // the three are not enough.
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(L + 0.10, ht * 0.085, t + 0.10),
                                  mat(DARK_STONE, { coarse: 1.8, tile_m: 0.5 }));
    plinth.position.y = ht * 0.0425;
    g.add(plinth);
    // THE RIM. A moon gate is a circle you walk through and the thing that says
    // so is the dressed stone ring around the opening — without it the wall reads
    // from the path as a slab with a hole punched in it. The ring stands slightly
    // proud of the wall on BOTH faces, because it
    // is a course of shaped stones set through the thickness rather than a
    // moulding stuck on the front.
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(r + 0.035, 0.075, 12, 64), mat(0xcfc7b6));
    rim.position.y = cy;
    g.add(rim);
    // and a threshold, so the opening meets the ground on something
    const sill = new THREE.Mesh(
      new THREE.BoxGeometry(r * 2.1, 0.06, t + 0.12), mat(DARK_STONE));
    sill.position.y = 0.03;
    g.add(sill);
    return g;
  },
  koi_pond: (h, w) => {                      // a raised pond: stone drum, dark water, flag coping, koi
    const g = new THREE.Group(), ht = h || 0.5, W = w || 2.4;
    const R = W * 0.44, wall = ht * 0.72, n = 11;
    const noise = (i) => { const j = Math.sin(i * 12.9898) * 43758.5453; return j - Math.floor(j); };
    // the basin: a stone drum, slightly oval, lined dark so the water reads deep
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 0.96, wall, 28), mat(DARK_STONE));
    drum.scale.z = 0.8; drum.position.y = wall / 2; g.add(drum);
    // water a hand below the rim
    const top = wall - ht * 0.08;
    // grain: 0, and darker than the basin's: a pond has depth under it, and the
    // darkness is what makes a reflection read (see the note in `basin`)
    const water = new THREE.Mesh(new THREE.CircleGeometry(R * 0.98, 28),
      mat(0x2b4249, { grain: 0, roughness: 0.05, metalness: 0.1 }));
    water.rotation.x = -Math.PI / 2; water.scale.y = 0.8; water.position.y = top; g.add(water);
    // coping: an odd ring of flag stones, each a little different, following the oval
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + 0.2 * noise(i + 7), f = noise(i);
      const len = W * (0.2 + 0.06 * f), dep = W * (0.08 + 0.03 * f), th = (ht - wall) * (0.85 + 0.15 * f);
      const st = new THREE.Mesh(new THREE.BoxGeometry(len, th, dep), mat(STONE, { flatShading: true }));
      st.position.set(R * Math.cos(a), wall + th / 2, R * 0.8 * Math.sin(a));
      st.rotation.y = Math.atan2(-0.8 * Math.cos(a), -Math.sin(a)); g.add(st);
    }
    // koi at the surface — orange backs breaking the water — and a few lily pads
    for (let i = 0; i < 5; i++) {
      const a = noise(i + 20) * Math.PI * 2, r = R * (0.25 + 0.45 * noise(i + 30));
      const koi = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), mat(i === 2 ? 0xe9e2d4 : 0xd9682a, { roughness: 0.5 }));
      koi.scale.set(W * 0.055, W * 0.012, W * 0.018);
      koi.position.set(r * Math.cos(a), top + W * 0.006, r * 0.8 * Math.sin(a));
      koi.rotation.y = noise(i + 40) * Math.PI; g.add(koi);
    }
    for (let i = 0; i < 3; i++) {
      const a = 1.1 + i * 0.5 + noise(i + 50), r = R * (0.5 + 0.25 * noise(i + 60));
      const pad = new THREE.Mesh(new THREE.CircleGeometry(W * (0.03 + 0.015 * noise(i)), 10), mat(0x4f7a3a));
      pad.rotation.x = -Math.PI / 2; pad.position.set(r * Math.cos(a), top + 0.006, r * 0.8 * Math.sin(a)); g.add(pad);
    }
    return g;
  },
  pergola: (h, w) => {
    const g = new THREE.Group(), L = w || 3, ht = h || 2.3;
    for (const [dx, dz] of [[-L / 2, -0.9], [L / 2, -0.9], [-L / 2, 0.9], [L / 2, 0.9]]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.11, ht, 0.11), mat(TIMBER));
      post.position.set(dx, ht / 2, dz); g.add(post);
    }
    for (let i = 0; i <= 6; i++) {
      const r = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.09, 2.1), mat(TIMBER));
      r.position.set(-L / 2 + (L * i) / 6, ht, 0); g.add(r);
    }
    return g;
  },
};

/** Synonyms, so the model's own words find a builder. */
const ALIASES = [
  [/lantern|ishidoro|toro\b/i, "lantern"],
  [/basin|tsukubai|water bowl|bird ?bath/i, "basin"],
  [/boulder|rock|stone(?! lantern)|standing stone/i, "boulder"],
  [/bench|seat(?!ing wall)/i, "bench"],
  [/\bpot\b|urn|planter box|container|jar/i, "pot"],
  [/fire ?pit|brazier|hearth/i, "firepit"],
  [/screen|fence panel|bamboo|trellis|lattice/i, "screen"],
  // before the screen rule: "moon gate" must not be read as a fence panel, and
  // before pergola, because "moon arch" would otherwise match arbour
  [/moon ?_?gate|moon ?door|yue ?dong ?men|circular (opening|doorway)/i, "moon_gate"],
  [/koi ?_?pond/i, "koi_pond"],
  [/pergola|arbou?r|gazebo|ramada/i, "pergola"],
];

export const KNOWN_KINDS = Object.keys(BUILDERS);

/**
 * What each buildable kind IS, for a person choosing one from the picker.
 *
 * Only decoration: `objectCatalog()` walks BUILDERS, so a builder added without a
 * row here still appears (at the generic default) rather than silently vanishing
 * from the picker. A hand-typed parallel list of kinds drifts from the builders
 * it copies.
 *
 * The sizes are what the thing IS, not a minimum: an ishidoro is about 1.4 m, a
 * bench seat is 0.45 m, a tsukubai sits low enough to stoop to. They seed the
 * place op so a hand-placed lantern is a lantern and not a 0.8 m default stub.
 */
export const OBJECT_META = {
  lantern:   { label: "stone lantern", height_m: 1.4, width_m: 0.4,
               note: "ishidoro — the vertical accent at a path turn or beside water" },
  basin:     { label: "water basin",   height_m: 0.4, width_m: 0.6,
               note: "tsukubai — low, so you stoop to it; put it where a path pauses" },
  lava_rock: { label: "lava rock",     height_m: 0.32, width_m: 0.42,
               note: "vesicular scoria; >10 in is the size that reads as rock rather than gravel. "
                   + "Set in odd-numbered groups, part-buried, and it will hold soil on a bank" },
  boulder:   { label: "boulder",       height_m: 0.6, width_m: 0.9,
               note: "set stone; subdivides by size, so a big one is not a faceted lump" },
  bench:     { label: "bench",         height_m: 0.45, width_m: 1.6,
               note: "seat height, not overall height — face it at something worth sitting for" },
  pot:       { label: "pot",           height_m: 0.6, width_m: 0.5,
               note: "an olive jar reads as one object; three of one size read as a set" },
  firepit:   { label: "fire pit",      height_m: 0.4, width_m: 0.9,
               note: "wants level ground and 1 m of clear standing all round" },
  screen:    { label: "screen",        height_m: 1.8, width_m: 2.0,
               note: "blocks a view — check it does not also block a way through" },
  moon_gate: { label: "moon gate",     height_m: 2.4, width_m: 3.4,
               note: "a wall with a circular opening you walk through; wider than "
                     + "it is tall, or it reads as a panel rather than a wall" },
  koi_pond:  { label: "koi pond",      height_m: 0.5, width_m: 2.5,
               note: "water needs level ground; the ground here is mostly not" },
  pergola:   { label: "pergola",       height_m: 2.4, width_m: 3.0,
               note: "overhead structure — shade that you walk under rather than round" },
};

/** Every kind the library can really draw, with what a picker needs to show it. */
export function objectCatalog() {
  return KNOWN_KINDS.map(kind => ({
    kind,
    label: OBJECT_META[kind]?.label ?? kind.replace(/_/g, " "),
    height_m: OBJECT_META[kind]?.height_m ?? 0.8,
    width_m: OBJECT_META[kind]?.width_m ?? 0,
    note: OBJECT_META[kind]?.note ?? "",
  }));
}

/** Which builder a free-text kind resolves to, or null if nothing matches. */
export function resolveKind(kind) {
  const k = String(kind ?? "").trim();
  if (!k) return null;
  if (BUILDERS[k.toLowerCase()]) return k.toLowerCase();
  for (const [re, name] of ALIASES) if (re.test(k)) return name;
  return null;
}

/**
 * A placeholder: correct footprint and height, unmistakably not a model.
 *
 * Honest rather than pretty on purpose. A missing asset must read as "nobody has
 * modelled this yet", never as a design decision — a silent substitution is how a
 * gap stays invisible, and invisible gaps do not get filled.
 */
function placeholder(h, w) {
  const g = new THREE.Group(), s = w || 0.6;
  const box = new THREE.Mesh(new THREE.BoxGeometry(s, h, s),
    mat(PLACEHOLDER, { transparent: true, opacity: 0.45, roughness: 1 }));
  box.position.y = h / 2;
  g.add(box);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(s, h, s)),
    new THREE.LineBasicMaterial({ color: PLACEHOLDER }));
  edges.position.y = h / 2;
  g.add(edges);
  return g;
}

/** One object, standing on the ground it was given. */
export function objectMesh(obj, heightAt = () => 0) {
  const h = Number(obj.height_m) > 0 ? Number(obj.height_m) : 0.8;
  const w = Number(obj.width_m) > 0 ? Number(obj.width_m) : 0;
  const name = resolveKind(obj.kind);
  const g = new THREE.Group();
  // A SEED, so objects that come in groups are not identical clones. Derived from
  // the object's own id, falling back to its position — both are stable across
  // frames and across reloads, which is the property that matters: a stone that
  // reshuffles itself every render is worse than five identical ones.
  const key = String(obj.id ?? "") || `${(obj.position ?? [0, 0]).join(",")}`;
  let seed = 0;
  for (let i = 0; i < key.length; i++) seed = (seed * 31 + key.charCodeAt(i)) >>> 0;
  // A FILE BEATS A BUILDER, the same way `plant.asset` beats the species table.
  // This is what lets the owner scan a stone and place the stone rather than a preset
  // that resembles one. `buildAssetObject` returns null when the
  // model has not loaded yet, and the builder is the fallback — a late model
  // draws a preset for one frame rather than nothing at all.
  const fromFile = obj.model ? buildAssetObject(obj) : null;
  g.add(fromFile ?? (name ? BUILDERS[name](h, w, seed) : placeholder(h, w)));

  seatObject(g, obj, heightAt);
  if (Number.isFinite(obj.rotation_deg)) g.rotation.y = (obj.rotation_deg * Math.PI) / 180;
  // TILT: the lean, about the object's own horizontal axis. Applied after the yaw
  // and in the object's own frame, so "lean" means the same thing whichever way
  // the thing is facing — a boulder turned 90 degrees still leans the way it was
  // set to lean, rather than suddenly leaning sideways.
  if (Number.isFinite(obj.tilt_deg)) g.rotateX((obj.tilt_deg * Math.PI) / 180);

  g.userData.id = obj.id;
  g.userData.kind = obj.kind;              // the asked-for words, kept for the want list
  g.userData.resolved = name;
  g.userData.placeholder = !name;
  return g;
}

/**
 * Stand an object on the ground — the ONLY thing about an object that reads the
 * terrain. Its own function so a re-drape can re-seat a kept object instead of
 * rebuilding it: the terrain arrives after the first build on every page load, and
 * regenerating every lava rock for a change of height is wasted work.
 */
export function seatObject(g, obj, heightAt = () => 0) {
  const [x, y] = obj.position ?? [0, 0];
  const p = enuToWorld(x, y, 0);
  // level_m is the object's BASE elevation, absolute, exactly as it is for a bed,
  // a path and a patio (design.js) — one meaning of the word across the whole
  // vocabulary. Omitted, the thing stands on the measured ground, which is the
  // normal case. Set, it stands on a plinth
  // or a wall top; float_check measures the built geometry, so an object left
  // hanging is reported rather than silently accepted.
  p.y = Number.isFinite(obj.level_m) ? obj.level_m : heightAt(p.x, p.z);
  g.position.copy(p);
}

/**
 * What the design asked for and the library could not build.
 *
 * This is the point of the whole module. A gap that only shows up as a dull box in
 * the corner of a render is a gap nobody acts on; a list with the kind, the reason
 * and the ids that wanted it is a work item.
 */
export function wants(design) {
  const byKind = new Map();
  for (const o of design?.objects ?? []) {
    if (resolveKind(o.kind)) continue;
    const key = String(o.kind ?? "").trim() || "(unnamed)";
    if (!byKind.has(key)) byKind.set(key, { kind: key, ids: [], count: 0 });
    const w = byKind.get(key);
    w.ids.push(o.id);
    w.count++;
  }
  return [...byKind.values()].sort((a, b) => b.count - a.count);
}
