// WHICH MODEL IS A SPECIES' OWN (assets.js registerAsset `whole`): one fetched or made for a species
// carries its own flowers and gets no generic blossom; a library TREE the app's generator built
// gets one. The tree generator records where its models came from (docs/library.md) — as
// "generated" — and that record must not turn the olive into a flowerless "own" model.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../viewer/node_modules/three/build/three.module.js";
import { registerAsset } from "../../viewer/src/assets.js";

const tree = () => {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(3, 4, 3)));
  return g;
};

test("a library tree gets blossom, whether it says it was generated or says nothing", () => {
  assert.equal(registerAsset("t1", tree(), { height_m: 4, spread_m: 3 }).whole, false);
  assert.equal(registerAsset("t2", tree(), { height_m: 4, spread_m: 3,
    source: { from: "generated", script: "tools/gen_trees.py", preset: "olive", seed: 7 } }).whole, false);
});

test("a species' own model — fetched or made for it — keeps its own flowers", () => {
  assert.equal(registerAsset("m1", tree(), { source: { from: "polyhaven", id: "x" } }).whole, true);
  assert.equal(registerAsset("m2", tree(), { source: { from: "made", script: "assets/plants/m2.py" } }).whole, true);
});
