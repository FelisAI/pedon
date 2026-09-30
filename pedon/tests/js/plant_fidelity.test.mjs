// node --test tests/js/plant_fidelity.test.mjs
//
// Plant models need realistic shape, colour and leaves at mature and intermediate
// stages so the design agent can judge its own planting.
//
// The design agent has to LOOK at its own planting before a run can finish,
// so what the renderer draws is an INPUT to the design loop. A
// planting scheme drawn as faceted lumps cannot be judged as a planting scheme
// by anyone, model or owner.
//
// The thresholds below use measured geometry and rendering characteristics,
// explained beside each check. These measurements describe failure cases:
//
//   a 2.5 m manzanita              3420 triangles in 3408 DISCONNECTED pieces.
//                                  The largest connected piece in the whole
//                                  shrub is TWO TRIANGLES. It is not a surface
//                                  at all — jittering every vertex of
//                                  an icosahedron independently tears the
//                                  shared corners apart, producing crumpled foil.
//                                  Displacement must depend on POSITION, not
//                                  vertex index, for shrubs and boulders alike.
//   median piece, same shrub       0.216 m — 8.6% of the plant's own spread. A
//                                  manzanita leaf is about 1% of it.
//   manzanita / rosemary / santolina, same size and seed
//                                  BIT-IDENTICAL: 2000 tris, 1983 pieces,
//                                  median 0.1544 m for all three — three
//                                  species, one object
//   a 2.5 m woody shrub            ONE mesh, no wood at all — no stem, no branch
//   a 15-plant drift, one species  0.5 / 441 RGB units apart on a word ramp,
//                                  0.0 with the palette's own hex
//   a 1.2 m deergrass              32 blades
//
// The cost tests at the bottom bound what fidelity may spend: 114 plants is a
// real design (data/design.json) and 71 cards is the asset window. Both need to
// stay responsive.
import { needsSite } from "./lib/site.mjs";   // about a real site
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "../../viewer/node_modules/three/build/three.module.js";
import { dataPath } from "../../viewer/project_paths.js";   // the active site's files
import { catalogue, plantManifest } from "./lib/library.mjs";
import { within } from "./lib/timing.mjs";   // wall-clock guards, stretched on a slow machine

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
globalThis.document = {
  createElement() {
    const ctx = { fillStyle: "#000", fillRect() {}, createRadialGradient: () => ({ addColorStop() {} }) };
    return { width: 0, height: 0, getContext: () => ctx };
  },
};
const plants = await import(path.join(ROOT, "viewer", "src", "plants.js"));
const { buildPlant } = plants;
const {readRenderQuality} = await import('../../viewer/src/render_quality.js');

const mk = (o) => buildPlant({ position: [0, 0], ...o });

/**
 * Every triangle of the plant, in the plant's own frame, with the name of the
 * mesh it came from.
 *
 * World-transformed, because a PlaneGeometry is authored in XY and rotated flat:
 * a bound or an edge taken in local coordinates does not measure the rendered
 * geometry. The same requirement applies to float_check and palette_renders.
 */
function trianglesOf(obj, want) {
  obj.updateMatrixWorld(true);
  const out = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  obj.traverse((n) => {
    const pos = n.geometry?.attributes?.position;
    if (!pos || n.name === "shadow") return;
    // An UNNAMED mesh counts as foliage. Naming the parts is part of what this
    // file asks for (see the test below). Without this fallback an unnamed
    // plant measures as 0, so a naming defect masks the geometry being measured.
    // A test whose failure is about its own scaffolding proves nothing.
    if (want && n.name !== want && !(want === "foliage" && !n.name)) return;
    const idx = n.geometry.index;
    const count = idx ? idx.count : pos.count;
    for (let i = 0; i + 2 < count; i += 3) {
      const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1,
            i2 = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(n.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(n.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(n.matrixWorld);
      out.push([a.clone(), b.clone(), c.clone()]);
    }
  });
  return out;
}

/**
 * The plant broken into CONNECTED PIECES — how many, how big, and how many
 * triangles each holds.
 *
 * Connected geometry gives a measurable threshold for leaf structure, while
 * leaf-like appearance alone does not.
 *
 * A shrub built from sixteen jittered icosahedra needs sixteen pieces. Applying
 * jitter per VERTEX of non-indexed geometry produces 3408 pieces instead:
 * the three copies of every shared corner move to three different places and the
 * surface tears into loose triangles. Displacement must depend on POSITION,
 * not vertex index, so neighbours stay joined. Subdivision cannot repair a
 * disconnected surface.
 *
 * Union-find over vertices welded by position, quantised to 0.1 mm: three.js
 * emits a subdivided icosahedron's shared corners as bit-identical floats, but a
 * merge and a matrix multiply do not guarantee that, and a component count that
 * depended on float luck would fail on somebody else's machine.
 */
function piecesOf(obj, want) {
  const instanced=[],ordinary=[];
  obj.traverse(n=>{if(n.name===want&&n.isMesh)(n.isInstancedMesh?instanced:ordinary).push(n);});
  if(want==='foliage'&&instanced.length&&!ordinary.length) {
    // Each shoot-model instance is one connected curved leaf, not one canopy.
    // Account for EVERY instance without expanding millions of triangle objects.
    const sizes=[],matrix=new THREE.Matrix4();let tris=0,biggest=0;
    for(const n of instanced){
      n.geometry.computeBoundingBox();const span=n.geometry.boundingBox.getSize(new THREE.Vector3()).length(),t=n.geometry.index.count/3;
      tris+=t*n.count;biggest=Math.max(biggest,t);
      for(let i=0;i<n.count;i++){n.getMatrixAt(i,matrix);sizes.push(span*new THREE.Vector3().setFromMatrixColumn(matrix,0).length());}
    }
    sizes.sort((a,b)=>a-b);return {tris,count:sizes.length,biggest,sizes};
  }
  const id = new Map(), parent = [];
  const find = (x) => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  const key = (v) => `${Math.round(v.x * 1e4)},${Math.round(v.y * 1e4)},${Math.round(v.z * 1e4)}`;
  const at = (v) => {
    const k = key(v);
    if (!id.has(k)) { id.set(k, parent.length); parent.push(parent.length); }
    return id.get(k);
  };
  const tris = trianglesOf(obj, want);
  const rows = tris.map(t => [t.map(at), t]);
  for (const [ix] of rows) { const r = find(ix[0]); parent[find(ix[1])] = r; parent[find(ix[2])] = r; }
  const nTris = new Map(), box = new Map();
  for (const [ix, pts] of rows) {
    const r = find(ix[0]);
    nTris.set(r, (nTris.get(r) ?? 0) + 1);
    const b = box.get(r) ?? box.set(r, new THREE.Box3()).get(r);
    for (const p of pts) b.expandByPoint(p);
  }
  const sizes = [...box.values()].map(b => b.getSize(new THREE.Vector3()).length()).sort((a, b) => a - b);
  const counts = [...nTris.values()].sort((a, b) => b - a);
  return { tris: tris.length, count: counts.length, biggest: counts[0] ?? 0, sizes };
}

const median = (xs) => xs[Math.floor(xs.length / 2)];

const MANZANITA = { id: "m", species: "Arctostaphylos spp.", common: "manzanita",
                    form: "mound", foliage: "grey_green",
                    mature_height_m: 2.5, mature_spread_m: 2.5 };

// ── leaves ───────────────────────────────────────────────────────────────────

test("the plant says which part of it is which", () => {
  // Name the contact shadow so it cannot count toward plant height or facet
  // size. Foliage, wood and bloom need names too: material colour cannot reliably
  // identify a stem, and every check here that separates leaf from bark depends
  // on those names.
  const names = new Set();
  mk(MANZANITA).traverse(n => { if (n.isMesh) names.add(n.name); });
  assert.ok(names.has("foliage"), `meshes are named ${[...names].map(n => `"${n}"`).join(", ")}`);
  assert.ok(names.has("wood"), `meshes are named ${[...names].map(n => `"${n}"`).join(", ")}`);
  assert.ok(names.has("shadow"));
});

test("the foliage masses are surfaces, not confetti", () => {
  // Per-vertex jitter splits a 2.5 m manzanita's 3420 triangles into pieces no
  // larger than TWO TRIANGLES. Every icosahedron tears at its seams. A torn
  // surface renders with a hard bright edge on every facet, resembling crumpled
  // foil rather than a bush. More subdivision cannot repair the seams.
  for (const [label, p] of [
    ["a 2.5 m mound", MANZANITA],
    ["a 0.15 m mat", { id: "t", species: "Thymus spp.", form: "mat",
                       mature_height_m: 0.15, mature_spread_m: 0.6 }],
    ["a 5 m procedural tree", { id: "tr", species: "Fremontodendron spp.", form: "tree",
                                mature_height_m: 5, mature_spread_m: 4 }],
  ]) {
    const { biggest, tris } = piecesOf(mk(p), "foliage");
    assert.ok(biggest >= 60,
      `${label}: the largest connected piece of foliage is ${biggest} triangle(s) ` +
      `out of ${tris} — the mass is not a surface`);
  }
});

test("a shrub is clad in leaf-sized pieces", () => {
  // An oversized foliage core on a 2.5 m manzanita measures 0.216 m at the median —
  // 8.6% of the plant's own spread, on a species whose leaves are about 1% of
  // it. Judged as a ratio rather than in metres because a 0.6 m santolina and a
  // 2.5 m manzanita both have leaves a few centimetres long; absolute facet size
  // (foliage_detail.test.mjs) is the other half of the same question and cannot
  // tell a big smooth blob from a small one.
  for (const [label, p] of [
    ["a 2.5 m manzanita", MANZANITA],
    ["a 0.6 m santolina", { id: "s", species: "Santolina chamaecyparissus", form: "mound",
                            mature_height_m: 0.6, mature_spread_m: 0.9 }],
  ]) {
    const g = mk(p);
    const { count, sizes, tris } = piecesOf(g, "foliage");
    const med = median(sizes), pct = 100 * med / p.mature_spread_m;
    // A card here is one LEAF on a broad-leaved plant and one SPRIG on a fine-leaved
    // one — a rosemary shoot tip, a santolina button — because a 5 mm needle
    // rendered as an untextured quad is sub-pixel at the distance a border is
    // judged from, and a shrub built from thousands of invisible slivers renders
    // as a bare core. 5% of a 0.9 m santolina is 4.5 cm, the size of one of its
    // foliage buttons. A 21.6 cm core occupies roughly a third of a small plant.
    // Cards are rectangular under a cropped outline mask. Their bounding
    // diagonal includes transparent corners; use a botanical 6 cm ceiling,
    // which rejects 21.6 cm cores masquerading as leaves.
    assert.ok(med <= 0.06,
      `${label}: the median foliage piece is ${med.toFixed(3)} m, ${pct.toFixed(1)}% of ` +
      `its own ${p.mature_spread_m} m spread — that is a facet, not a leaf`);
    assert.ok(count >= 200,
      `${label}: only ${count} foliage pieces over ${tris} triangles`);
  }
});

test("a grass clump reads as many blades", () => {
  // A 32-blade deergrass, or 26-46 blades on every grass regardless of size,
  // resembles a handful of straws. A mature deergrass needs hundreds of fine
  // leaves to form its fountain shape.
  const g = mk({ id: "g", species: "Muhlenbergia rigens", common: "deergrass",
                 form: "grass", mature_height_m: 1.2, mature_spread_m: 1.2 });
  // A dedicated bunchgrass uses one connected blade per GPU instance. Count
  // those instances, not just the 24 shared shape buffers underneath them.
  const blades = obj => {
    let count = 0;
    obj.traverse(o => { if (o.name === 'foliage' && o.isInstancedMesh) count += o.count; });
    return count || piecesOf(obj, 'foliage').count;
  };
  const count = blades(g);
  assert.ok(count >= 90, `a 1.2 m deergrass is ${count} blades`);
  // Hold blade width/species constant to test size. A finer-leaved fescue can
  // legitimately need almost as many blades as a larger, coarser deergrass.
  const small = blades(mk({ id: "f", species: "Muhlenbergia rigens", form: "grass",
                             mature_height_m: 0.45, mature_spread_m: 0.45 }));
  assert.ok(small < count * 0.8,
    `a 0.45 m deergrass has ${small} blades against the mature plant's ${count} — ` +
    `blade count is not following the plant`);
});

// ── silhouette ───────────────────────────────────────────────────────────────

test("three shrubs that share the mound form do not render as the same object", () => {
  // Use the SAME id so the seed cannot account for a difference. A shared mound
  // builder gives all three 2000 triangles, 6000 vertices, 1.237 m height,
  // 1.544 m width and 0.1222 m mean triangle edge: bit-identical geometry.
  // Manzanita, rosemary and santolina need distinct shapes within the mound form.
  const at = (species) => mk({ id: "same", species, form: "mound",
                               mature_height_m: 1.2, mature_spread_m: 1.5 });
  const sig = ["Arctostaphylos spp.", "Salvia rosmarinus", "Santolina chamaecyparissus"]
    .map((s) => {
      const e = piecesOf(at(s), "foliage");
      return { s, n: e.count, med: median(e.sizes) };
    });
  const report = sig.map(x => `${x.s}: ${x.n} pieces, median ${x.med.toFixed(4)} m`).join("\n  ");
  assert.equal(new Set(sig.map(x => `${x.n}|${x.med.toFixed(5)}`)).size, 3,
    `three species, one shape:\n  ${report}`);
  // and not merely different — different by enough to see. A rosemary is fine
  // and dense; a manzanita is broader-leaved and more open.
  const ns = sig.map(x => x.n).sort((a, b) => a - b);
  assert.ok(ns[2] >= ns[0] * 1.25,
    `densest ${ns[2]} vs sparsest ${ns[0]} pieces — same bush, three labels:\n  ${report}`);
  const ms = sig.map(x => x.med).sort((a, b) => a - b);
  assert.ok(ms[2] >= ms[0] * 1.25,
    `leaf sizes ${ms.map(m => m.toFixed(4)).join(" / ")} — same leaf on all three`);
});

test("the leaf layer routes by species, is declarable, and falls back on the form", () => {
  // Same three-layer shape as FORMS and FOLIAGE, for the same reason: the
  // species table is finite and the model's botanical vocabulary is not, so a
  // plant may DECLARE what its leaves are like and an unknown species still
  // lands on a real leaf instead of a default one.
  assert.equal(typeof plants.leafClass, "function", "no leaf layer at all");
  const cls = (o) => plants.leafClass({ mature_height_m: 1.2, mature_spread_m: 1.2, ...o });
  assert.equal(cls({ species: "Salvia rosmarinus", form: "mound" }), "needle",
    "rosemary is needle-leaved — and the greedy /salvia/ rule must not claim it first");
  assert.equal(cls({ species: "Arctostaphylos spp.", form: "mound" }), "small");
  assert.equal(cls({ species: "Ficus carica", form: "tree" }), "large");
  assert.equal(cls({ species: "Cupressus sempervirens", form: "column" }), "scale");
  // declared: a species no table names
  assert.equal(cls({ species: "Metrosideros excelsa", form: "tree", leaf: "broad glossy leaves" }), "large");
  assert.equal(cls({ species: "Metrosideros excelsa", form: "tree", leaf: "fine needle foliage" }), "needle");
  // nothing declared, nothing named: the form still has to produce a leaf
  assert.ok(plants.LEAF_WORDS.includes(cls({ species: "Metrosideros excelsa", form: "tree" })));
  // and a word with no leaf content says nothing, exactly as a bare "green" says
  // nothing to normalizeFoliage
  assert.equal(plants.normalizeLeaf("nice"), null);
});

// ── structure ────────────────────────────────────────────────────────────────

test("a woody shrub shows stems", () => {
  // A 2.5 m manzanita with ONE mesh of 10,260 foliage vertices and no stems
  // lacks its defining mahogany bark. Keep the base open so the bark is visible.
  const g = mk(MANZANITA);
  const wood = piecesOf(g, "wood");
  assert.ok(wood.tris > 0, "a 2.5 m manzanita has no woody geometry whatsoever");
  assert.ok(wood.count >= 3, `only ${wood.count} stem(s) on a mature multi-stem shrub`);
  let top = -Infinity, low = Infinity;
  for (const t of trianglesOf(g, "wood")) for (const v of t) { top = Math.max(top, v.y); low = Math.min(low, v.y); }
  assert.ok(top >= 0.35 * MANZANITA.mature_height_m,
    `the tallest stem reaches ${top.toFixed(2)} m on a ${MANZANITA.mature_height_m} m shrub — ` +
    `branches have to get into the canopy or the foliage is floating on twigs`);
  assert.ok(low <= 0.05, `the stems start at ${low.toFixed(2)} m — a shrub grows out of the ground`);
  // and the base is not buried: some stem is visible below the foliage
  let leafLow = Infinity;
  g.traverse(n => {
    // An instanced leaf's prototype starts at its petiole origin. Its world
    // position comes from the instance matrix, not the prototype vertices.
    if (n.isMesh && n.name === "foliage") leafLow = Math.min(leafLow, new THREE.Box3().setFromObject(n).min.y);
  });
  assert.ok(leafLow > 0.06, `foliage starts at ${leafLow.toFixed(3)} m — the bark is crowded out`);
});

test("a herbaceous plant is NOT given a woody trunk", () => {
  // The other half of the same decision. A yarrow, a poppy drift and a fescue
  // have no wood, and inventing some would be the same lie in the other
  // direction — the reason `mound` and `perennial` are different forms at all.
  for (const form of ["perennial", "meadow", "grass", "rush", "strap"]) {
    const g = mk({ id: "h", species: "test", form, mature_height_m: 0.7, mature_spread_m: 0.6 });
    assert.equal(piecesOf(g, "wood").tris, 0, `form "${form}" grew a trunk`);
  }
});

// ── colour ───────────────────────────────────────────────────────────────────

test("a drift of one species is not one colour", () => {
  // Fifteen plants of one species with sequential ids need visible variation.
  // A spread of 0.5 RGB units out of a 441-unit cube on a named ramp, or 0.0 on
  // the palette's own hex, renders as a flat colour despite per-plant colours.
  //
  // The colour measured is the one you SEE: material.color times the mean of the
  // vertex colours, because MeshStandardMaterial multiplies the two. Reading
  // material.color alone would miss the answer entirely — the per-individual
  // variation deliberately lives in the vertex colours so that an explicit hex
  // stays exactly the species colour it promises (plants.test.mjs holds that,
  // and plants_schema.test.mjs pins the per-form defaults it would move).
  const seen = (g) => {
    let mesh = null;
    g.traverse(o => { if (o.isMesh && (o.name === "foliage" || !o.name)) mesh ??= o; });
    if (!mesh) return null;
    const c = mesh.geometry.attributes.color;
    let f = 0;
    for (let i = 0; i < c.array.length; i++) f += c.array[i];
    f /= c.array.length;
    const m = mesh.material.color;
    return { r: m.r * f, g: m.g * f, b: m.b * f };
  };
  const drift = (base) => {
    const cols = [];
    for (let i = 1; i <= 15; i++) {
      const c = seen(mk({ id: `p${100 + i}`, ...base }));
      if (c) cols.push(c);
    }
    let worst = 0;
    for (const a of cols) for (const b of cols)
      worst = Math.max(worst, 255 * Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b));
    return worst;
  };
  // Both shapes the palette actually produces, and the SECOND is the one that
  // needs the per-individual vigour. With vigour disabled, the incidental spread
  // of shade sampling gives the big buckwheat a 41.5-unit range because a mound
  // of ten masses has ten shade draws that do not average out. The small
  // hex-coloured perennial spans only 6.6 units —
  // few parts, so its mean converges, and that is exactly the 花境 case, where
  // an explicit hex from plant_palette.json meets a small herbaceous plant.
  // Relying on incidental shade variation makes dense perennial drifts look flat.
  //
  // 8/441 is about where two leaves stop matching to the eye side by side. The
  // upper bound matters as much: past ~90 the drift stops being one species,
  // which is what assets.js's instanceTint band protects.
  for (const [label, base] of [
    ["a named ramp on a mound", { species: "Eriogonum fasciculatum", form: "mound",
      // Colour variation needs physical leaves, not fifteen mature 333 MB
      // export-sized crowns. The full-size master has its own bounds/visual QA.
      foliage: "grey_green", mature_height_m: 0.35, mature_spread_m: 0.45 }],   // flat-colour case: 0.5
    ["the palette's own hex on a small perennial", { species: "Erigeron glaucus",
      form: "perennial", foliage: "#7f9280", mature_height_m: 0.25, mature_spread_m: 0.4 }],
  ]) {                                                                        // flat-colour case: 0.0
    const w = drift(base);
    assert.ok(w >= 8, `${label}: 15 plants span ${w.toFixed(1)}/441 — one flat colour`);
    assert.ok(w <= 90, `${label}: 15 plants span ${w.toFixed(1)}/441 — that is a mixed border, not a drift`);
  }
});

test("the seeded stream still spreads on its FIRST draw", () => {
  // Hashing with s = s*31 + c and running a raw LCG makes the FIRST output nearly
  // linear in the seed: fifteen sequential ids span 0.0136 of the unit interval
  // on draw one and 0.9459 on draw three. buildPlant draws the
  // COLOURS first, deliberately, so that a geometry change cannot recolour the
  // garden. The first draw therefore needs to vary across sequential seeds.
  const ids = Array.from({ length: 15 }, (_, i) => `p${100 + i}`);
  for (const draw of [1, 2, 3]) {
    const v = ids.map(id => { const r = plants.rngFrom(id); let x; for (let i = 0; i < draw; i++) x = r(); return x; });
    const span = Math.max(...v) - Math.min(...v);
    assert.ok(span > 0.6, `draw ${draw} of 15 sequential ids spans only ${span.toFixed(4)}`);
  }
});

test("the same plant id renders the same plant", () => {
  // Non-negotiable: two renders of one garden must be identical or no visual
  // check the design agent makes means anything.
  // Hashed rather than compared element by element: a mature shrub carries tens
  // of thousands of floats, and `a.push(...p.array)` on that many is a stack
  // overflow rather than a test result.
  const sig = (o) => {
    let h = 2166136261 >>> 0, n = 0;
    o.traverse((m) => {
      const p = m.geometry?.attributes?.position;
      if (!p) return;
      n += p.array.length;
      for (let i = 0; i < p.array.length; i++) {
        h ^= Math.round(p.array[i] * 1e5) | 0;
        h = Math.imul(h, 16777619) >>> 0;
      }
    });
    return `${n}:${h}`;
  };
  assert.equal(sig(mk(MANZANITA)), sig(mk(MANZANITA)),
    "the same plant id built twice is a different plant");
  assert.notEqual(sig(mk(MANZANITA)), sig(mk({ ...MANZANITA, id: "m2" })),
    "two ids give the same object");
});

// ── what fidelity may cost ───────────────────────────────────────────────────

// Fast preview keeps loading responsive. These interaction guards exercise the
// same first-visit default as the app.
// Full-detail organ/fidelity checks above still use unmodified detailed builders.
// Full-detail cost measurements are 6.09 s for the site and 11.81 s for the picker.
test("a real 114-plant design stays affordable in the default viewing mode", needsSite, (t) => {
  // data/design.json is the active site's live design. Measured geometry costs
  // illustrate why both triangle count and build time matter:
  //
  //   base foliage       118,540 triangles   186 ms
  //   detailed foliage   334,006 triangles   ~190-290 ms
  //   fine grass blades  372,846 triangles   227 ms
  //   flower shapes      421,802 triangles   (with palette colours applied)
  //   species leaf sizes 586,304 triangles   ~230 ms
  //   mask cut and grain 638,644 triangles   ~330 ms
  //
  // Derive the alpha cut per mask. A single alphaTest of 0.45 discards almost
  // every fine-leaf card: a `needle` mask averages 0.074 alpha, so mipping a 3 cm
  // card toward its mean puts every texel under the cut and the whole card
  // vanishes. Rosemary, santolina and lavender then show bare stems with a few
  // floating blobs. Mound grain gives a wiry shrub its spreading habit; green
  // flower stalks and finer haze florets also contribute to geometry cost.
  //
  // A 5 cm `small` leaf is too large for Eriogonum (5-15 mm), Baccharis and
  // Origanum. The `tiny` class gives subshrubs their own silhouette grain. The
  // cost is structural: coverage is len^2 * density, so a capped per-plant card
  // count can leave a canopy open over its solid core when leaves get smaller.
  // A density sweep with the cap binding costs 534k-586k triangles; 586k gives a
  // closed canopy at 230 ms build time. The browser measurement is 1.78 M
  // triangles in 3.8 ms median. Any ceiling increase needs a measured reason.
  //
  // Fine grass geometry costs 38,840 extra triangles: 240 blades 6 mm wide,
  // with 30% straw-coloured, compared with 152 blades 54 mm wide. Fit the clump
  // to its declared height and spread. 54 mm is a leek; Muhlenbergia rigens
  // blades are 2-4 mm, measurable in data/refphotos/muhlenbergia_rigens.jpg.
  // Thin blades distinguish a grass silhouette from a bundle of plastic straps.
  //
  // Build time is paid on every design rebuild and needs its own assertion.
  // Triangle count alone cannot establish visual quality: one library GLB has
  // 124,000 triangles, while setting CORE_R to the full mass size costs 356,206
  // for the design but leaves only a fringe of foliage round solid pillows.
  // Geometry and timing checks bound cost; visual fidelity still needs renders.
  const design = JSON.parse(fs.readFileSync(dataPath("design.json"), "utf8"));
  assert.ok(design.plants.length >= 100, "design.json is not the big design any more");
  // The FLOWER COLOUR has to be applied here, exactly as main.js's
  // colourFromPalette does before it calls buildDesignGroup. Without it every
  // mound and mat has `bloomHex === null`, no bloom is built at all, and this
  // guard under-measures the real scene by 27% — 372,846 against the
  // browser's 474,282. A budget that cannot see a quarter
  // of the spend is not a budget.
  const palette = catalogue();
  const byName = new Map(palette.map(p => [String(p.species).toLowerCase(), p]));
  const plants = design.plants.map(p => {
    const c = byName.get(String(p.species).toLowerCase());
    return c ? { ...p, flower: c.flower, bloom: c.bloom, common: p.common ?? c.common } : p;
  });
  const flowered = plants.filter(p => p.flower).length;
  assert.ok(flowered >= design.plants.length * 0.8,
    `only ${flowered}/${plants.length} plants got a flower colour — the palette join is `
    + "broken, and this guard would go back to measuring a garden with no flowers in it");
  let tris = 0, drawnTris = 0;
  // Timed as the MINIMUM of three passes, not a single one. Wall-clock noise on a
  // loaded machine is one-sided — contention only ever makes a build look slower —
  // so a single reading turns this into a test of what else the box is doing.
  // Measurements of 1260 ms inside tools/selftest.py versus 178-219 ms in six
  // standalone and under-load runs show the scale of that noise.
  // The minimum is the standard estimator for compute time under noise, and it
  // still catches a real regression: the thing being guarded is a 5x slowdown, not
  // a 20% one.
  let ms = Infinity;
  for (let pass = 0; pass < 3; pass++) {
    const t1 = process.hrtime.bigint();
    let n2 = 0, drawn = 0;
    for (const p of plants) {
      const g = buildPlant(p, {quality:readRenderQuality(null)});
      g.traverse(n => {
        const pos = n.geometry?.attributes?.position;
        if (!pos || n.name === "shadow") return;
        const count=(n.geometry.index ? n.geometry.index.count : pos.count) / 3;
        n2 += count;drawn += count*(n.isInstancedMesh?n.count:1);
      });
    }
    ms = Math.min(ms, Number(process.hrtime.bigint() - t1) / 1e6);
    tris = n2;                       // deterministic: identical on every pass
    drawnTris = drawn;
  }
  t.diagnostic(`${design.plants.length} plants: ${tris} stored triangles, ${drawnTris} drawn triangles including instances, ${ms.toFixed(0)} ms build (best of 3)`);
  // Triangle count is a loose runaway guard on memory and build time. It must
  // allow realistic models even when they render more slowly: a 319k-triangle
  // scan costs 2.2 ms and a 2M-triangle planting 28.4 ms, because FILL RATE is
  // the limiting cost and triangle count does not predict it.
  //
  // Never use the guard to force a modelling compromise. A per-plant card cap
  // can force a `tiny` leaf to 2.6 cm instead of its botanical 1.4 cm because
  // smaller leaves need more cards. A 40,000-card allowance supports the smaller
  // buckwheat leaves. Grass coverage of 0.16-0.23 of its own silhouette is sparse
  // compared with the 1.0-2.4 measured for other herbaceous forms; 49 grasses in
  // a design each incur that geometry cost. A measured design with denser grass
  // geometry costs 4,081,816 triangles and 2732 ms, within the 6000 ms ceiling.
  //
  // Pricing leafCountFor only on the blobs' visible surface leaves gaps BETWEEN
  // spaced mound cores bare: that surface is just 0.32-0.44 of the plant's
  // silhouette. The 40k card cap also limits the biggest mounds. Covering the
  // full silhouette gives a measured cost of 6,680,614 triangles and 1311 ms.
  //
  // 9,000,000 stored triangles is the memory tripwire; build time has its own
  // 6000 ms ceiling. Instanced leaves share vertex buffers. Report the expanded
  // draw count separately so buffer sharing cannot disguise the rendered count.
  // Thin preview shoots by nodes as well as pitch: a measured same-model preview
  // costs 5.67 M stored triangles against a 5.27 M comparison. Move a ceiling
  // only for a measurement.
  //
  // Fast preview must preserve the full-detail plant's size and silhouette.
  // Four-times-wide grass blades give a quarter as many leaves, turning a 3 mm
  // Muhlenbergia haze into a coarse 12 mm tuft. Capping shrub foliage at 1,500
  // leaves or using stand-in builders for rosemary and coast rosemary also
  // changes the silhouette. For a measured 201-plant design, the same-model
  // shoot preview uses 9.8 M stored triangles versus 5.3 M for stand-ins, but
  // builds in 2,276 ms versus 5,568 ms: shoots are cheaper to construct than
  // leaf shells. Triangle count alone cannot predict build cost.
  assert.ok(tris < 9000000, `${tris} stored triangles for ${design.plants.length} plants`);
  // The leaf-size floor in shrubMasses enlarges foliage masses so a leaf is small
  // relative to its clump. Bigger masses carry more leaf shell: measured browser
  // costs for 114 plants span ~600-829 ms best-of-3.
  // The browser measurement matters. This ceiling is deliberately loose
  // because node's canvas shim makes leafTexture fall back per class and the
  // node figure runs ~40% above the browser's; the browser number is the one to
  // watch when assessing performance improvements.
  assert.ok(ms < within(6000), `${ms.toFixed(0)} ms to build one design's planting`);
});

test("the asset window still opens", async (t) => {
  // The picker must open without stalling. A 71-card build can cost 102 ms, and
  // Fast uses reduced photoreal builders whose full catalogue takes ~20 s to
  // build. Defer card pictures so opening the window only asks for them.
  const palette = catalogue();
  const lib = plantManifest();
  const cards = [
    ...palette.map(p => ({ ...p, id: `thumb:${p.species}`, position: [0, 0] })),
    ...Object.entries(lib).map(([n, m]) => ({ id: `thumb:${n}`, species: n, asset: n,
      mature_height_m: m.height_m ?? 4, mature_spread_m: m.spread_m ?? 3, position: [0, 0] })),
  ];
  assert.ok(cards.length >= 65, `only ${cards.length} cards`);
  const { plantThumbLater } = await import("../../viewer/src/thumbs.js");
  let answered = 0;
  const t0 = process.hrtime.bigint();
  const now = cards.map(c => plantThumbLater(c, () => { answered++; }));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  t.diagnostic(`${cards.length} cards asked for in ${ms.toFixed(1)} ms`);
  assert.ok(ms < within(100), `${ms.toFixed(0)} ms to open the window: it is drawing, not asking`);
  assert.equal(answered, 0, "a picture was drawn while the window was opening");
  assert.ok(now.every(u => u === null), "a picture was drawn while the window was opening");
});
