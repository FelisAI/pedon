// node --test tests/js/model_plants.test.mjs
//
// A plant drawn from a MODEL FILE — a library tree for a 2 m+ plant no builder claims, or the
// model the design agent fetched or made for a species (`asset`) — is that model in full detail,
// and must be the same model in Fast, not the generic shape: five catalogue species, and any tree
// on another designer's site. Fast draws it reduced to the plant's budget: a library tree is a
// mesh of branch tubes (simplified) and a mesh of ~100 k separate leaves (thinned, keeping their
// area).
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../viewer/node_modules/three/build/three.module.js";
import { needsLibrary } from "./lib/library.mjs";   // about the user's library: skips without one

globalThis.document = { createElement() { return { width: 1, height: 1, getContext: () =>
  new Proxy({ measureText: () => ({ width: 12 }) }, { get: (o, k) => o[k] ?? (String(k).startsWith("create") ? () => ({ addColorStop() {} }) : () => {}) }) }; } };

const { registerAsset } = await import("../../viewer/src/assets.js");
const { buildPlant, fastModelKey, drawnByCode, builderName } = await import("../../viewer/src/plants.js");
const { assetName } = await import("../../viewer/src/assets.js");
const { prepareSimplifier, PLANT_BUDGET } = await import("../../viewer/src/preview_lod.js");
await prepareSimplifier();

// a tree as the library ships one: branch tubes, and leaves as separate little pieces — heavier
// than its budget (a 3 m tree: 200 k), as the olive (656 k) and toyon (638 k) are
function libraryTree() {
  const branches = [];
  for (let i = 0; i < 120; i++) {
    const t = new THREE.CylinderGeometry(0.02, 0.03, 1, 24, 8, true);
    t.rotateZ((i % 7 - 3) * 0.2); t.translate(Math.sin(i) * 0.6, 1 + (i % 10) * 0.25, Math.cos(i * 1.7) * 0.6);
    branches.push(t.toNonIndexed());
  }
  const trunk = new THREE.BufferGeometry();
  const bp = branches.flatMap(g => [...g.attributes.position.array]);
  trunk.setAttribute("position", new THREE.Float32BufferAttribute(bp, 3));
  trunk.computeVertexNormals();
  const lp = [];
  for (let i = 0; i < 220000; i++) {
    const r = 1.2 * Math.cbrt((i * 0.6180339) % 1), a = i * 2.39996, b = (i * 0.7548) % Math.PI;
    const x = r * Math.sin(b) * Math.cos(a), y = 2.2 + r * Math.cos(b), z = r * Math.sin(b) * Math.sin(a);
    lp.push(x, y, z, x + 0.04, y + 0.01, z, x + 0.02, y, z + 0.03);
  }
  const leaves = new THREE.BufferGeometry();
  leaves.setAttribute("position", new THREE.Float32BufferAttribute(lp, 3));
  leaves.computeVertexNormals();
  const green = new THREE.MeshStandardMaterial({ color: 0x557744, side: THREE.DoubleSide });
  const g = new THREE.Group();
  const m1 = new THREE.Mesh(trunk, new THREE.MeshStandardMaterial({ color: 0x664433 })); m1.name = "tree_1";
  const m2 = new THREE.Mesh(leaves, green); m2.name = "tree_2";
  g.add(m1, m2);
  return g;
}
registerAsset("test_tree", libraryTree(), { height_m: 4, spread_m: 3 });

const tris = g => { let t = 0; g.traverse(o => { if (o.isMesh && o.visible) t += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3 * (o.isInstancedMesh ? o.count : 1); }); return t; };
const area = (g, name) => { let a = 0; g.traverse(o => { if (!o.isMesh || o.name !== name) return;
  const p = o.geometry.attributes.position, ix = o.geometry.index, n = (ix ? ix.count : p.count) / 3, v = [0, 1, 2].map(() => new THREE.Vector3());
  for (let t = 0; t < n; t++) { for (let j = 0; j < 3; j++) v[j].fromBufferAttribute(p, ix ? ix.getX(t * 3 + j) : t * 3 + j);
    a += v[1].clone().sub(v[0]).cross(v[2].clone().sub(v[0])).length() / 2; } }); return a; };
const model = g => { let n = null; g.traverse(o => { n ??= o.userData?.assetName ?? null; }); return n; };

const plant = { species: "Arbutus test", common: "test tree", position: [0, 0], mature_height_m: 4, mature_spread_m: 3, form: "tree", asset: "test_tree" };

test("a plant drawn from a model file is that model in Fast too, within the plant's budget", () => {
  const full = buildPlant({ ...plant, id: fastModelKey(plant) }, { quality: "detailed" });
  const fast = buildPlant(plant, { quality: "fast" });
  assert.equal(model(full), "test_tree");
  assert.equal(model(fast), "test_tree", "Fast drew the generic shape, not the plant's model");
  assert.ok(tris(full) > PLANT_BUDGET * 2 * 1.2, "the fixture is not heavy — the reduction is untested");
  assert.ok(tris(fast) <= PLANT_BUDGET * 2 * 1.05, `Fast ${tris(fast)} triangles, the budget ${PLANT_BUDGET * 2}`);
});

test("its leaves are thinned keeping their area, not melted: the same leaf area, fewer leaves", () => {
  const full = buildPlant({ ...plant, id: fastModelKey(plant) }, { quality: "detailed" });
  const fast = buildPlant(plant, { quality: "fast" });
  const ratio = area(fast, "tree_2") / area(full, "tree_2");
  assert.ok(ratio > 0.85 && ratio < 1.15, `Fast's leaves carry ${(ratio * 100).toFixed(0)}% of the model's leaf area`);
  assert.equal(fast.userData.reduced?.thinned?.includes("tree_2") ?? (() => { let r = null; fast.traverse(o => { r ??= o.userData?.reduced; }); return r?.thinned?.includes("tree_2"); })(), true, "the leaves were not thinned");
  const box = g => { const b = new THREE.Box3(); g.traverse(o => { if (o.isMesh && o.name !== "shadow") b.union(new THREE.Box3().setFromObject(o)); }); return b.getSize(new THREE.Vector3()); };
  fast.rotation.set(0, 0, 0); fast.scale.x = Math.abs(fast.scale.x); fast.updateMatrixWorld(true); full.updateMatrixWorld(true);
  const bf = box(fast), bd = box(full);
  assert.ok(Math.abs(bf.y / bd.y - 1) < 0.05 && Math.abs(Math.max(bf.x, bf.z) / Math.max(bd.x, bd.z) - 1) < 0.05,
    `Fast ${bf.toArray().map(v => v.toFixed(2))} against full ${bd.toArray().map(v => v.toFixed(2))}`);
});

test("a plant its own code draws does not ask for a model file; one no code claims does", needsLibrary, () => {
  // otherwise every Dr. Hurd load fetches and decodes manzanita.glb, 12.8 MB its own builder leaves unused
  for (const [species, code] of [["Arctostaphylos manzanita 'Dr. Hurd'", true], ["Arctostaphylos glauca", false],
                                  ["Heteromeles arbutifolia", false]]) {
    const p = { species, common: species, position: [0, 0], mature_height_m: 4, mature_spread_m: 3, form: "tree" };
    assert.ok(assetName(p), `${species} is not routed to a model — the question is untested`);
    assert.equal(drawnByCode(p), code, `${species}: drawn by code? ${!code}`);
    assert.equal(!!builderName(buildPlant(p, { quality: "fast" })), code, `${species}: the build disagrees`);
  }
});

