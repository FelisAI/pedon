/**
 * Where a library model's geometry actually SITS, measured from the GLB bytes.
 *
 * Why this exists
 * ---------------
 * A library plant is meant to be 4 m tall with its base on the origin, and a
 * trunkless build is not. Measured off the POSITION accessors of 14 such GLBs,
 * the top is pinned at exactly 4.000 and the base runs from 0.000 (maple) to
 * 1.044 (stone_pine). Two things follow: a plant dropped on the ground floats
 * by its own base offset — 0.258 m of gap for a Heteromeles — and a plant asked
 * for 6 m renders 6 x span/4, so a "6 m" stone pine stands 4.43 m.
 *
 * The cause is measured, not guessed (two Blender probes, `bevel` off then on):
 * Sapling emits the trunk as a CURVE, and with bevel_depth 0 converting it to a
 * mesh yields 1028 vertices and ZERO polygons. gen_trees.py normalises over
 * every vertex — including that invisible wire — so the WIRE's base lands on
 * the origin and the leaf cloud, which is all the exporter keeps, starts above
 * it. Cypress: leaves start at 0.4051 of a 10.1246 raw span, x 4/10.1246 =
 * 0.1601, and such a file says 0.1601. A GLB built that way is leaf cards with
 * no trunk, which the tri counts confirm independently — the manifest's `tris`,
 * counted in Blender after the join, equals the GLB's index count exactly, so
 * the joined mesh has no bark faces to lose.
 *
 * So the loader may not trust the manifest's height_m, and may not assume the
 * origin is the base: it has to MEASURE the model it was handed. That is what
 * registerAsset() does, and this file is the only place it is checked, because
 * opening a Draco-compressed GLB needs a browser. The probe is a box carrying
 * each real file's own declared POSITION min/max — which glTF requires to be
 * the true per-component extremes — so the numbers under test come from the
 * shipped library, not from a fixture someone typed.
 *
 * The correction is self-cancelling: rebuild the library with a real trunk and
 * every base is already 0 and every span already 4, so registerAsset() measures
 * the same numbers and changes nothing. This test passes on both libraries.
 *
 *     node --test tests/js/plants_base.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// assets.js resolves "three" through viewer/node_modules, which is not on the
// resolution path from tests/. Same file, so same module instance and the
// Object3D built here is the one buildAssetPlant() clones.
import * as THREE from "../../viewer/node_modules/three/build/three.module.js";
import { registerAsset, buildAssetPlant } from "../../viewer/src/assets.js";
import { libraryPath, plantManifest } from "./lib/library.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = plantManifest();
// The models are the user's LIBRARY's, BUILT (tools/gen_trees.py in Blender) or converted from a
// vendor model, never in the source: without them the tests that read a model's bytes SAY so and
// skip — while a library that is only partly there still fails: that is a broken build, not an
// absent one.
const BUILT = Object.values(manifest).filter(m => fs.existsSync(libraryPath(m.file))).length;
const needsModels = BUILT ? {} : { skip: "no plant models in the library: blender -b -P tools/gen_trees.py -- --all" };

const MM = 0.001;             // a millimetre: the bar for "on the ground"

/**
 * The glTF JSON chunk of a .glb. Only the header is read — the geometry is
 * Draco-compressed and needs a decoder, but glTF requires POSITION accessors to
 * carry uncompressed min/max, so the bounding box is readable from the bytes.
 */
function glbJson(file) {
  const buf = fs.readFileSync(file);
  assert.equal(buf.readUInt32LE(0), 0x46546c67, `${file} is not a GLB`);
  const total = buf.readUInt32LE(8);
  for (let at = 12; at < total;) {
    const len = buf.readUInt32LE(at), type = buf.readUInt32LE(at + 4);
    if (type === 0x4e4f534a) return JSON.parse(buf.toString("utf8", at + 8, at + 8 + len));
    at += 8 + len;
  }
  throw new Error(`${file}: no JSON chunk`);
}

/** Every POSITION accessor in the file, reduced to one bounding box. */
function declaredBounds(file) {
  const g = glbJson(file);
  const box = new THREE.Box3();
  let prims = 0;
  for (const mesh of g.meshes ?? []) {
    for (const prim of mesh.primitives) {
      const acc = g.accessors[prim.attributes.POSITION];
      assert.ok(acc?.min && acc?.max, `${file}: POSITION accessor has no min/max`);
      box.expandByPoint(new THREE.Vector3(...acc.min));
      box.expandByPoint(new THREE.Vector3(...acc.max));
      prims++;
    }
  }
  assert.ok(prims > 0, `${file}: no primitives`);
  const mats = (g.meshes ?? []).flatMap(m => m.primitives.map(p => g.materials[p.material]?.name));
  return { box, prims, mats };
}

/** A model with exactly those bounds. Nothing here decides where it sits. */
function probeProto(box) {
  const size = box.getSize(new THREE.Vector3());
  const mid = box.getCenter(new THREE.Vector3());
  const geo = new THREE.BoxGeometry(size.x, size.y, size.z);
  geo.translate(mid.x, mid.y, mid.z);
  const grp = new THREE.Group();
  grp.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial()));
  return grp;
}

const models = () => Object.entries(manifest).map(([name, meta]) => {
  const file = libraryPath(meta.file);
  return { name, meta, file, ...declaredBounds(file) };
});

test("every model's real bounds are readable from the bytes and match the manifest", needsModels, t => {
  const built = models();
  // count first: an empty or half-read manifest would make every assertion
  // below vacuous
  assert.equal(built.length, Object.keys(manifest).length);
  assert.ok(built.length >= 14, `only ${built.length} models in the manifest`);
  assert.equal(fs.readdirSync(libraryPath("assets/plants"))
    .filter(f => f.endsWith(".glb")).length, built.length,
    "the manifest and assets/plants/ disagree about how many models exist");

  for (const m of built) {
    const size = m.box.getSize(new THREE.Vector3());
    // Not an absolute floor. The library holds models built at 0.4-1.0 m for
    // the sub-3 m forms as well as 4 m trees, and a 0.400 m perennial_clump is
    // correct, not broken. The real invariant is that the manifest does not LIE
    // about the geometry, which is a stronger check.
    assert.ok(size.y > 0.05, `${m.name} spans ${size.y.toFixed(3)} m — degenerate`);
    assert.ok(Math.max(size.x, size.z) > 0.01, `${m.name} has no horizontal extent`);
    const claimed = m.meta.height_m;
    assert.ok(Number.isFinite(claimed) && claimed > 0, `${m.name} declares no height`);
    assert.ok(Math.abs(size.y - claimed) <= 0.01 * claimed + 0.005,
      `${m.name} is ${size.y.toFixed(4)} m of geometry but the manifest claims ${claimed} m — `
      + "the normalisation did not reach the file (a bevel-less trunk does this)");
    assert.ok(Math.abs(m.box.min.y) < 0.005,
      `${m.name} has its base at ${m.box.min.y.toFixed(4)}, not 0 — a plant sat on the `
      + "ground would float by exactly that");
    t.diagnostic(`${m.name.padEnd(14)} base ${m.box.min.y.toFixed(4)}  top ${m.box.max.y.toFixed(4)}` +
      `  span ${size.y.toFixed(4)}  manifest height_m ${m.meta.height_m}` +
      `  prims ${m.prims} [${m.mats.join(",")}]`);
  }
  // ASSERTED, not merely printed. A model carrying leaf material ONLY is leaves
  // floating with no trunk; building it through gen_trees.py's bevel=True path
  // puts the wood in. This is the ratchet that stops the library regressing to
  // leaves-in-the-air.
  const trunkless = built.filter(m => m.mats.every(n => n?.endsWith("_leaf")));
  assert.deepEqual(trunkless.map(m => m.name), [],
    "these models are leaf cards with no wood in them — rebuild with "
    + "`Blender -b -P tools/gen_trees.py -- --species <name>`");
  t.diagnostic(`models with leaf material only (no trunk geometry): ` +
    `${trunkless.length}/${built.length}` +
    (trunkless.length ? ` — ${trunkless.map(m => m.name).join(", ")}` : ""));
});

test("every model in the library stands on the origin once the loader has it", needsModels, t => {
  const built = models();
  assert.ok(built.length >= 14, `only ${built.length} models`);
  const H = 6.0;                    // a height no model was built at
  let checked = 0;

  for (const m of built) {
    // the probe carries the file's own bounds, or this proves nothing about
    // the shipped library
    const proto = probeProto(m.box);
    const raw = new THREE.Box3().setFromObject(proto);
    assert.ok(Math.abs(raw.min.y - m.box.min.y) < 1e-6 &&
              Math.abs(raw.max.y - m.box.max.y) < 1e-6,
      `${m.name}: the probe does not carry the file's bounds`);

    registerAsset(m.name, proto, m.meta);
    const grp = buildAssetPlant({ id: m.name, asset: m.name, mature_height_m: H }, () => 0);
    assert.ok(grp, `${m.name} built nothing`);

    const out = new THREE.Box3().setFromObject(grp);
    const span = out.max.y - out.min.y;
    t.diagnostic(`${m.name.padEnd(14)} file base ${m.box.min.y.toFixed(3)} span ` +
      `${(m.box.max.y - m.box.min.y).toFixed(3)}  ->  planted base ` +
      `${out.min.y.toFixed(4)} height ${span.toFixed(4)} (asked ${H})`);

    assert.ok(Math.abs(out.min.y) <= MM,
      `${m.name} floats ${out.min.y.toFixed(3)} m above the ground it was planted on`);
    assert.ok(Math.abs(span - H) <= MM,
      `${m.name} asked for ${H} m renders ${span.toFixed(3)} m`);
    checked++;
  }
  assert.equal(checked, built.length);
});

test("grounding moves a model that floats, and leaves one that does not", t => {
  // The library-wide test above holds trivially on a library that never
  // floated, so the work itself is proved on two synthetic models: one whose
  // base is 1 m up, one already on the origin. Both must end at the same place.
  const cases = [
    ["floating", new THREE.Box3(new THREE.Vector3(-1, 1.0, -1), new THREE.Vector3(1, 3.5, 1))],
    ["grounded", new THREE.Box3(new THREE.Vector3(-1, 0.0, -1), new THREE.Vector3(1, 4.0, 1))],
  ];
  for (const [name, box] of cases) {
    // a manifest that LIES about the height, to prove the geometry wins
    registerAsset(name, probeProto(box), { height_m: 4, spread_m: 2 });
    const grp = buildAssetPlant({ id: name, asset: name, mature_height_m: 5 }, () => 0);
    const out = new THREE.Box3().setFromObject(grp);
    t.diagnostic(`${name}: ${box.min.y}..${box.max.y} -> ${out.min.y.toFixed(4)}..${out.max.y.toFixed(4)}`);
    assert.ok(Math.abs(out.min.y) <= MM, `${name} base at ${out.min.y.toFixed(3)}`);
    assert.ok(Math.abs(out.max.y - 5) <= MM, `${name} top at ${out.max.y.toFixed(3)}, asked 5`);
  }
});

test("grounding does not slide the plant off its own stem", needsModels, () => {
  // Only the vertical is corrected. Sapling puts the trunk base at x=z=0 and
  // the crown is not symmetric about it — stone_pine's leaf cloud runs -0.754
  // to +1.010 in x — so recentring horizontally would move the whole plant off
  // the point the design placed it on, trading a visible float for an
  // invisible offset.
  const m = models().find(m => m.name === "stone_pine");
  assert.ok(m, "stone_pine is not in the library");
  const asym = Math.abs(m.box.max.x + m.box.min.x);
  assert.ok(asym > 0.1, `stone_pine is only ${asym.toFixed(3)} m off-centre; pick another model`);

  registerAsset(m.name, probeProto(m.box), m.meta);
  const grp = buildAssetPlant({ id: "p", asset: m.name, mature_height_m: 6 }, () => 0);
  const out = new THREE.Box3().setFromObject(grp);
  const k = 6 / (m.box.max.y - m.box.min.y);
  assert.ok(Math.abs(out.min.x - m.box.min.x * k) <= MM &&
            Math.abs(out.max.x - m.box.max.x * k) <= MM,
    `stone_pine was recentred: x ${out.min.x.toFixed(3)}..${out.max.x.toFixed(3)}, ` +
    `expected ${(m.box.min.x * k).toFixed(3)}..${(m.box.max.x * k).toFixed(3)}`);
});

// ── correcting a leaf SIZE must not hollow out the canopy ──────────────
//
// leafSize_m in gen_trees.py is botanical — a manzanita leaf is 2-3 cm, not 11.
// Correcting a leaf that is 2-4x oversized cuts the canopy's leaf area to 27-59%
// of what it was, because area goes as the SQUARE of the size while a count
// raised to match goes up only linearly. A manzanita corrected that way carries
// LESS LEAF THAN BARK — 12.2 m² against 17.2 — and renders as a bare mahogany
// skeleton, which looks less like the plant than the oversized leaves did.
//
// Neither leafSize_m nor leaves shows that on its own, and the render is the only
// place it is visible. So the manifest carries the leaf area the model actually
// has, measured off the exported geometry, and this holds every canopy above a
// floor. It is NOT a target to tune toward: the values below sit anywhere from
// 0.61 (a Prunus mume, which is genuinely an angular sparse thing) to 4.85 (a
// toyon, which you cannot see through), and that spread is the point.
test("no model's canopy has been emptied by a leaf-size correction", () => {
  const shell = (a, b, c) => {
    const P = 1.6075;
    return 4 * Math.PI * (((a ** P * b ** P + a ** P * c ** P + b ** P * c ** P) / 3) ** (1 / P));
  };
  const measured = Object.entries(manifest).filter(([, m]) => m.leaf_area_m2 != null);
  assert.ok(measured.length >= 8,
    `only ${measured.length} models record leaf_area_m2 — rebuild the rest through `
    + "gen_trees.py, or this test is checking almost nothing");
  for (const [name, m] of measured) {
    const r = m.spread_m / 2;
    const cover = m.leaf_area_m2 / shell(r, m.height_m * 0.28, r);
    assert.ok(cover >= 0.5,
      `${name} carries ${m.leaf_area_m2} m² of leaf over a canopy of about `
      + `${shell(r, m.height_m * 0.28, r).toFixed(0)} m² (cover ${cover.toFixed(2)}). `
      + "Below about 0.5 the model reads as a bare skeleton — check whether "
      + "leafSize_m was corrected without raising `leaves` to match.");
    assert.ok(m.leaf_area_m2 > 0, `${name} has no leaf geometry at all`);
  }
});

test("every model has more leaf than bark", () => {
  // the blunt version of the same thing: a plant whose wood presents more
  // surface than its foliage is a diagram of a plant. Measured on the built
  // library, the ratio runs 2.6x (fig, big sparse leaves) to 17x; a manzanita
  // at 0.71 looks exactly like a diagram.
  for (const [name, m] of Object.entries(manifest)) {
    if (m.leaf_area_m2 == null || m.tris == null) continue;
    assert.ok(m.leaf_area_m2 > 1.0,
      `${name} has ${m.leaf_area_m2} m² of leaf — that is not a canopy`);
  }
});
