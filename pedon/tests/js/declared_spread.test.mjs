// node --test tests/js/declared_spread.test.mjs
//
// A plant must not be drawn wider than its declared spread. Measured RADIALLY (twice the
// farthest foliage from the stem — an axis-aligned box of a turned plant overstates it): every
// form is within ~10% at the median, but unfitted, Siskiyou blue fescue draws 76% wide (its
// 27-43 cm blades arch out past a 0.5 m plant), the strap-leaved plants 27-29%. The catalogue's
// spread is what the validator spaces by (ASSET_FIDELITY 3: sizes are absolute), so a drawn
// plant must fit it — as library models do (assets.js buildAssetPlant).
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../viewer/node_modules/three/build/three.module.js";
import { buildPlant, drawnSpread } from "../../viewer/src/plants.js";

globalThis.document = { createElement() { return { width: 1, height: 1, getContext: () =>
  new Proxy({}, { get: (_, k) => String(k).startsWith("create") ? () => ({ addColorStop() {} }) : () => {} }) }; } };

for (const [species, form, h, s] of [["Festuca 'Siskiyou Blue'", "grass", 0.45, 0.5],
                                     ["Phormium", "strap", 1.5, 1.5], ["Sisyrinchium", "strap", 0.3, 0.3]]) {
  test(`${species} is drawn within its declared ${s} m spread`, () => {
    const g = buildPlant({ id: "x", species, common: species, position: [0, 0], form,
                           mature_height_m: h, mature_spread_m: s }, { quality: "detailed" });
    const d = drawnSpread(g);
    assert.ok(d <= s * 1.15, `drawn ${d.toFixed(2)} m across against a declared ${s} m`);
    assert.ok(d >= s * 0.8, `squeezed to ${d.toFixed(2)} m — too far the other way`);
  });
}

test("a plant already within its spread is left exactly as built", () => {
  // Margarita BOP reaches 0.649 m on a declared 0.6 (every vertex, measured). 'Caradonna' is no
  // fixture for this: every vertex of it reaches 0.585 on a declared 0.5, past the 0.575
  // limit — it only "fits" when drawnSpread reads 24 of its merged vertices
  const p = { id: "x", species: "Penstemon heterophyllus 'Margarita BOP'", common: "c", position: [0, 0],
              form: "perennial", mature_height_m: 0.5, mature_spread_m: 0.6 };
  const g = buildPlant(p, { quality: "detailed" });
  assert.ok(!g.userData.fitToSpread, `a plant that fitted was squeezed by ${g.userData.fitToSpread}`);
});

test("drawnSpread finds the outermost vertex of a merged mesh, and the outermost instance", () => {
  // Sampling 24 vertices of a merged mesh and every n-th of 400 instances reads plants short:
  // a manzanita's cards 14%, a Ceanothus's 217 k leaves 7%, 'Caradonna' past its limit
  const P = new Float32Array(3 * 10007);
  for (let i = 0; i < 10007; i++) P.set([Math.cos(i) * 0.2, 0.1, Math.sin(i) * 0.2], 3 * i);
  P.set([0.9, 0.1, 0], 3 * 5003);                              // the far one, where no sampler lands
  const merged = new THREE.Mesh(new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(P, 3)));
  const a = new THREE.Group(); a.add(merged);
  assert.ok(Math.abs(drawnSpread(a) - 1.8) < 1e-6, `merged: read ${drawnSpread(a).toFixed(3)} m across, it is 1.8`);
  const leaf = new THREE.BoxGeometry(0.01, 0.01, 0.01);
  const inst = new THREE.InstancedMesh(leaf, new THREE.MeshBasicMaterial(), 100003);
  const m = new THREE.Matrix4();
  for (let i = 0; i < inst.count; i++) inst.setMatrixAt(i, m.makeTranslation(Math.cos(i) * 0.3, 0.2, Math.sin(i) * 0.3));
  inst.setMatrixAt(70001, m.makeTranslation(1.2, 0.2, 0));
  const b = new THREE.Group(); b.add(inst);
  assert.ok(drawnSpread(b) > 2.4, `instanced: read ${drawnSpread(b).toFixed(3)} m across, it is over 2.4`);
  // and a PART's own farthest vertex: 24 samples of a blade miss its tip (Evergold's Fast
  // model reads 6% narrow that way while every vertex agrees with full detail)
  const Q = new Float32Array(3 * 1001);
  for (let i = 0; i < 1001; i++) Q.set([Math.cos(i) * 0.01, 0, Math.sin(i) * 0.01], 3 * i);
  Q.set([0.3, 0, 0], 3 * 517);                                   // the blade's tip, between samples
  const blade = new THREE.InstancedMesh(new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(Q, 3)),
                                        new THREE.MeshBasicMaterial(), 3);
  for (let i = 0; i < 3; i++) blade.setMatrixAt(i, m.makeRotationY(i * 2.1));
  const c = new THREE.Group(); c.add(blade);
  assert.ok(Math.abs(drawnSpread(c) - 0.6) < 1e-6, `a part's tip: read ${drawnSpread(c).toFixed(3)} m across, it is 0.6`);
});

test("the name label, a point on the plant's axis, stays where it was", () => {
  const g = buildPlant({ id: "x", species: "Phormium", common: "flax", position: [0, 0], form: "strap",
                         mature_height_m: 1.5, mature_spread_m: 1.5 }, { quality: "detailed" });
  assert.ok(g.userData.fitToSpread < 1, "the fixture needs a squeezed plant");
  const anchor = new THREE.Object3D(); anchor.position.set(0, 1.85, 0); g.add(anchor);
  g.updateWorldMatrix(true, true);
  const w = new THREE.Vector3().setFromMatrixPosition(anchor.matrixWorld);
  assert.ok(Math.abs(w.x) < 1e-9 && Math.abs(w.z) < 1e-9 && Math.abs(w.y - 1.85) < 1e-9, w.toArray());
});
