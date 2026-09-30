// node --test tests/js/fast_leaves.test.mjs
//
// Fast must not draw a plant darker than full detail. Each way it can, measured on the same
// individual in both modes (compare.html):
//   - a rolled thyme leaf's box is nearly as thick as it is wide, so a stand-in built from the box
//     is two crossed planes facing sideways and down: silver thyme 12% dark, Cleveland sage 19%;
//   - offered a ribbon (a blade's strip along its midline), a leaf draws blue-grey;
//   - a stand-in rhombus covers half its box where an oval leaf covers four-fifths.
// A deer grass blade still needs its ribbon: it arches, so its box is nearly square, and denied
// the ribbon by a box test it draws as flat plates across the plant's foot.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../viewer/node_modules/three/build/three.module.js";
import { catalogue, needsLibrary } from "./lib/library.mjs";

globalThis.document = { createElement() { return { width: 1, height: 1, getContext: () =>
  new Proxy({ measureText: () => ({ width: 12 }) }, { get: (o, k) => o[k] ?? (String(k).startsWith("create") ? () => ({ addColorStop() {} }) : () => {}) }) }; } };

const { buildPlant, fastModelKey } = await import("../../viewer/src/plants.js");
const { prepareSimplifier, standIn, simplifyTo, thinPieces, reduceModel } = await import("../../viewer/src/preview_lod.js");
await prepareSimplifier();

function meanNormal(g) {
  const P = g.attributes.position, I = g.index, n = (I ? I.count : P.count) / 3, s = new THREE.Vector3();
  const v = [0, 1, 2].map(() => new THREE.Vector3());
  let area = 0;
  for (let t = 0; t < n; t++) {
    for (let j = 0; j < 3; j++) v[j].fromBufferAttribute(P, I ? I.getX(t * 3 + j) : t * 3 + j);
    const c = v[1].clone().sub(v[0]).cross(v[2].clone().sub(v[0]));
    area += c.length() / 2; s.addScaledVector(c, 0.5);
  }
  return { mean: s.divideScalar(area || 1), area };
}
const layers = (g, re) => { const out = []; g.traverse(o => { if (o.isInstancedMesh && re.test(o.name)) out.push(o); }); return out; };
const plant = (species, h, w) => ({ species, common: species, position: [0, 0], mature_height_m: h, mature_spread_m: w, form: "mound" });

for (const p of [plant("Thymus x citriodorus 'Silver Beauty'", 0.3, 0.6), plant("Salvia clevelandii", 1.2, 2.4)]) {
  test(`${p.species}: every Fast leaf faces the way its leaf does, and none is a ribbon`, () => {
    const fast = buildPlant(p, { quality: "fast" });
    const full = buildPlant({ ...p, id: fastModelKey(p) }, { quality: "detailed" });
    const f = layers(fast, /foliage|undersides/), d = layers(full, /foliage|undersides/);
    assert.equal(f.length, d.length, "not the same leaf layers");
    f.forEach((o, i) => {
      const want = meanNormal(d[i].geometry).mean, got = meanNormal(o.geometry).mean;
      assert.ok(want.lengthSq() > 0.25, "the fixture's leaves are not one-sided — the rule is untested");
      assert.ok(got.dot(want) >= 0.75 * want.lengthSq(), `${o.name} faces ${got.toArray().map(x => x.toFixed(2))} where the leaf faces ${want.toArray().map(x => x.toFixed(2))}`);
      assert.ok(!o.geometry.userData.ribbon, `${o.name} drawn as a ribbon`);
    });
  });
}

test("a leaf's stand-in faces the way the leaf does, at its true size, over three-quarters of its box", () => {
  const p = plant("Thymus x citriodorus 'Silver Beauty'", 0.3, 0.6);
  const full = buildPlant({ ...p, id: fastModelKey(p) }, { quality: "detailed" });
  for (const o of layers(full, /foliage|undersides/).slice(0, 2)) {
    const s = standIn(o.geometry, new THREE.Vector3(1, 1, 1));
    const want = meanNormal(o.geometry).mean, got = meanNormal(s).mean;
    assert.ok(got.dot(want) >= 0.75 * want.lengthSq(), `the stand-in of ${o.name} faces ${got.toArray().map(x => x.toFixed(2))}`);
    o.geometry.computeBoundingBox(); s.computeBoundingBox();
    const src = o.geometry.boundingBox.clone().expandByScalar(1e-6);
    assert.ok(src.containsBox(s.boundingBox), "the stand-in is drawn bigger than the leaf");
    const box = o.geometry.boundingBox.getSize(new THREE.Vector3()).toArray().sort((x, y) => x - y);
    assert.ok(meanNormal(s).area >= 0.7 * box[1] * box[2] * 0.85, `the stand-in covers ${(meanNormal(s).area / (box[1] * box[2]) * 100).toFixed(0)}% of its box`);
  }
});

test("a deer grass blade keeps its ribbon — an arch is not a wide part", needsLibrary, () => {
  const p = { species: "Muhlenbergia rigens", common: "Deer grass", position: [0, 0], mature_height_m: 0.91, mature_spread_m: 1.22, form: "grass" };
  const blades = layers(buildPlant(p, { quality: "fast" }), /^foliage$/);
  const ribbons = blades.filter(o => o.geometry.userData.ribbon).length;
  assert.ok(blades.length > 10);
  // and none drawn as a plate: no blade piece may span more than its full blade's width...
  let plates = 0;
  for (const o of blades) { o.geometry.computeBoundingBox(); const s = o.geometry.boundingBox.getSize(new THREE.Vector3()).toArray().sort((x, y) => x - y);
    if (!o.geometry.userData.ribbon && (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3 <= 4 && s[0] < 1e-6) plates++; }
  assert.equal(plates, 0, `${plates} blade variants drawn as flat plates`);
  assert.ok(ribbons >= blades.length / 2, `${ribbons} of ${blades.length} blade variants are ribbons`);
});

test("a model file's normalised colours come through every reduction as colours (or its branches draw white)", () => {
  const withColour = g => {                      // 0.25 grey, stored as a model file stores it
    const n = g.attributes.position.count;
    g.setAttribute("color", new THREE.BufferAttribute(new Uint16Array(n * 3).fill(16384), 3, true));
    return g;
  };
  const check = (g, what) => {
    assert.ok(g, `${what}: no reduction`);
    const c = g.attributes.color;
    for (let i = 0; i < c.count; i++) for (let k = 0; k < 3; k++) {
      const v = c.getComponent(i, k);
      assert.ok(Math.abs(v - 0.25) < 0.01, `${what}: a colour of ${v} where the part is 0.25`);
    }
  };
  check(simplifyTo(withColour(new THREE.SphereGeometry(1, 32, 16)), 60), "simplified");
  check(standIn(withColour(new THREE.PlaneGeometry(1, 0.5, 4, 2))), "stand-in");
  const leaves = new THREE.BufferGeometry(), pos = [];
  for (let i = 0; i < 600; i++) { const x = i % 30, z = Math.floor(i / 30); pos.push(x, 0, z, x + 0.3, 0, z, x, 0, z + 0.2); }
  leaves.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  check(thinPieces(withColour(leaves), 4), "thinned");
});

// ---- sizes that must not drift in Fast -------------------------------------------------------
const pal = catalogue();
const entry = species => ({ ...pal.find(p => p.species === species), position: [0, 0] });
const boxOf = (g, re) => { g.updateMatrixWorld(true); const b = new THREE.Box3();
  g.traverse(o => { if (o.isMesh && re.test(o.name)) b.union(new THREE.Box3().setFromObject(o)); }); return b; };
const pair = p => { const fast = buildPlant(p, { quality: "fast" }); fast.rotation.set(0, 0, 0); fast.scale.x = Math.abs(fast.scale.x);
  return [fast, buildPlant({ ...p, id: fastModelKey(p) }, { quality: "detailed" })]; };

test("a leaf card reaches no further than its leaves (or a prostrate rosemary draws 3.5 cm too tall)", needsLibrary, () => {
  const [fast, full] = pair(entry("Rosmarinus 'Prostratus'"));
  const cards = boxOf(fast, /^leaf cards$/), leaves = boxOf(full, /^foliage$/);
  assert.ok(!cards.isEmpty(), "no leaf cards — the fixture does not card its leaves");
  const r = b => Math.max(b.max.x, -b.min.x, b.max.z, -b.min.z);
  assert.ok(cards.max.y <= leaves.max.y * 1.02, `cards to ${cards.max.y.toFixed(3)} m, leaves to ${leaves.max.y.toFixed(3)} m`);
  assert.ok(r(cards) <= r(leaves) * 1.02 + 0.005, `cards reach ${r(cards).toFixed(3)} m, leaves ${r(leaves).toFixed(3)} m`);
});

for (const species of ["Lavandula angustifolia", "Oenothera lindheimeri"]) {
  test(`${species}: under Fast's leaf cap the flowers stand where full detail's do, and no leaf reaches past full's`, () => {
    const [fast, full] = pair(entry(species));
    const bf = boxOf(fast, /^bloom$/), bd = boxOf(full, /^bloom$/);
    assert.ok(!bd.isEmpty(), "no flowers — the fixture does not flower");
    for (const k of ["min", "max"]) assert.ok(bf[k].distanceTo(bd[k]) < 0.005, `flowers span ${bf[k].toArray().map(v => v.toFixed(3))} against ${bd[k].toArray().map(v => v.toFixed(3))}`);
    const lf = boxOf(fast, /^foliage$/), ld = boxOf(full, /^foliage$/), w = b => b.getSize(new THREE.Vector3());
    assert.ok(Math.max(w(lf).x, w(lf).z) <= Math.max(w(ld).x, w(ld).z) * 1.03, `leaves ${w(lf).toArray().map(v => v.toFixed(3))} against ${w(ld).toArray().map(v => v.toFixed(3))}`);
  });
}

