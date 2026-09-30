// node --test tests/js/leaf_cards.test.mjs
//
// A Fast shoot model must not close its canopy by drawing a sixth of the leaves ~5x too big
// (a 98 x 17.6 mm rosemary "needle" where the plant's is 20 x 3.6). The real-time answer
// is a leaf-CLUSTER card: the full model's own leaves, gathered where they grow, each cluster
// drawn as one card carrying a picture of true-size leaves — so size, silhouette and the SCALE
// of the leaf all come from the full model, and the canopy closes from the image.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../viewer/node_modules/three/build/three.module.js";
import { buildPlant, fastModelKey } from "../../viewer/src/plants.js";
import { builderOf } from "../../tools/preview_agreement.mjs";
import { needsLibrary } from "./lib/library.mjs";   // about the user's library: skips without one

globalThis.document = { createElement() { return { width: 1, height: 1, getContext: () =>
  new Proxy({}, { get: (_, k) => String(k).startsWith("create") ? () => ({ addColorStop() {} }) : () => {} }) }; } };

const tris = g => { let t = 0; g.traverse(o => { if (o.isMesh) t += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3 * (o.isInstancedMesh ? o.count : 1); }); return t; };
const box = g => { g.rotation.set(0, 0, 0); g.updateWorldMatrix(true, true); const b = new THREE.Box3(); g.traverse(o => { if (o.isMesh && o.name !== "shadow") b.union(new THREE.Box3().setFromObject(o)); }); return b.getSize(new THREE.Vector3()); };

for (const [species, common, h, s] of [["Salvia rosmarinus", "Rosemary", 1.2, 1.2],
                                       ["Westringia fruticosa", "Coast rosemary", 1.8, 1.8],
                                       ["Salvia officinalis 'Berggarten'", "Berggarten sage", 0.6, 0.9]]) {
  test(`${common}: Fast carries its TRUE leaves, at the full model's size`, needsLibrary, () => {
    const plant = { id: common, species, common, position: [0, 0], mature_height_m: h, mature_spread_m: s, form: "mound" };
    // full detail of the individual Fast draws this plant as: another individual of the
    // same kind carries a different number of leaves
    const fast = buildPlant(plant, { quality: "fast" });
    const full = buildPlant({ ...plant, id: fastModelKey(plant) }, { quality: "detailed" });
    assert.equal(builderOf(fast), builderOf(full));
    let fullLeaves = 0, leafLen = 0;
    full.traverse(o => { if (o.isInstancedMesh && o.name === "foliage") {
      fullLeaves += o.count; o.geometry.computeBoundingBox();
      const b = o.geometry.boundingBox.getSize(new THREE.Vector3()); leafLen = Math.max(leafLen, Math.max(b.x, b.y, b.z)); } });
    // TRUE LEAVES EITHER WAY: small leaves on cluster cards carrying pictures of them at
    // their true size, or — a Berggarten's 6 cm leaves, too big to card — every leaf drawn as
    // itself, simplified. What may not happen is a few leaves drawn big.
    const lc = fast.userData.reduced?.cards?.find(c => c.name === "foliage");
    if (lc) {
      assert.equal(lc.parts, fullLeaves, "the cards do not carry the full model's leaves");
      assert.ok(lc.partLength <= leafLen * 1.05, `a leaf drawn ${lc.partLength} m against a true ${leafLen} m`);
    } else {
      let fastLeaves = 0, fastLen = 0;
      fast.traverse(o => { if (o.isInstancedMesh && o.name === "foliage") {
        fastLeaves += o.count; o.geometry.computeBoundingBox();
        const b = o.geometry.boundingBox.getSize(new THREE.Vector3()); fastLen = Math.max(fastLen, Math.max(b.x, b.y, b.z)); } });
      assert.equal(fastLeaves, fullLeaves, "Fast draws a different number of leaves — no cards, and not the full model's own");
      assert.ok(fastLen <= leafLen * 1.05, `a leaf drawn ${fastLen} m against a true ${leafLen} m`);
    }
    const bf = box(fast), bd = box(full);
    assert.ok(Math.abs(bf.y / bd.y - 1) <= 0.05 && Math.abs(Math.max(bf.x, bf.z) / Math.max(bd.x, bd.z) - 1) <= 0.08,
      `Fast ${bf.toArray().map(v => v.toFixed(2))} against full ${bd.toArray().map(v => v.toFixed(2))}`);
    // ~20x cheaper where every Fast leaf is on a card; a Berggarten's 6 cm leaves are drawn as
    // themselves, within the plant's budget — 10x cheaper, 52 k triangles for a 0.9 m sage
    assert.ok(tris(fast) * 8 <= tris(full), `Fast ${tris(fast)} triangles against ${tris(full)}`);
  });
}
