// node --test tests/js/plant_model_whole.test.mjs
//
// A plant model fetched or made for a species (asset_store, `source` in its
// manifest entry) IS that species' look — its flowers are part of the model. The
// generic blossom the viewer adds to bought library models ("a bought model still
// flowers": the ceanothus, the flannel bush) would put a second set of flowers on
// top of it. Generated library models keep theirs.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../viewer/node_modules/three/build/three.module.js";
import { registerAsset } from "../../viewer/src/assets.js";
import { buildPlant } from "../../viewer/src/plants.js";

// the canvas the textures draw on: every method answers
globalThis.document = { createElement() { return { width: 1, height: 1, getContext: () =>
  new Proxy({}, { get: (_, k) => String(k).startsWith("create") ? () => ({ addColorStop() {} }) : () => {} }) }; } };

const probe = (w, h) => {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(w, h, w).translate(0, h / 2, 0),
                       new THREE.MeshStandardMaterial({ color: 0x849281 })));
  return g;
};
registerAsset("made_mat", probe(0.6, 0.3), { source: { from: "made" } });
registerAsset("generated_shrub", probe(2.4, 2.0), {});

const plant = (asset, h, s) => ({ id: "p1", species: "Eriogonum umbellatum", common: "Sulfur buckwheat",
  position: [0, 0], mature_height_m: h, mature_spread_m: s, flower: "#e2ce3d", asset });
const assetOf = g => { let n = null; g.traverse(o => { n ??= o.userData?.assetName ?? null; }); return n; };

test("a species' own model is drawn as it is, with no generic blossom on top", () => {
  const g = buildPlant(plant("made_mat", 0.3, 0.6));
  assert.equal(assetOf(g), "made_mat", "the plant was not drawn with its model at all");
  // a boolean, not the mesh: a failing equal() formats the whole THREE graph (100 s, measured)
  assert.ok(!g.getObjectByName("bloom"), "a second set of flowers was added to the model");
});

test("a generated library model still gets its blossom", () => {
  // the control: without it the test above passes if blossoms were never added
  const g = buildPlant(plant("generated_shrub", 2.0, 2.4));
  assert.equal(assetOf(g), "generated_shrub");
  assert.ok(g.getObjectByName("bloom"), "the library model lost its flowers");
});
