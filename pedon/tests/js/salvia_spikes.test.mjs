// node --test tests/js/salvia_spikes.test.mjs
//
// A sage's flowers must not hang loose in mid-air. Measured with NO stalk under the
// whorls: Cleveland sage's violet at 1.24-1.75 m over a plant whose every other part
// stops at 1.15, purple sage 1.68-2.26 over 1.44, white sage 1.40-1.91 over 0.97.
// The spike code adds its stalks to `woodRecords`, so the wood mesh must be built from
// that list AFTER the spikes add to it; built a few lines earlier, the stalks are
// never drawn.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../viewer/node_modules/three/build/three.module.js";
import { buildPlant } from "../../viewer/src/plants.js";
import { needsLibrary } from "./lib/library.mjs";   // about the user's library: skips without one

globalThis.document = { createElement() { return { width: 1, height: 1, getContext: () =>
  new Proxy({}, { get: (_, k) => String(k).startsWith("create") ? () => ({ addColorStop() {} }) : () => {} }) }; } };

const SAGES = [
  ["Salvia apiana", "White sage", 1.0, 1.4, "#eceae0"],
  ["Salvia clevelandii", "Cleveland sage", 1.2, 1.5, "#8f8ec7"],
  ["Salvia pachyphylla", "Mojave sage", 0.9, 1.0, "#6f6fb8"],
  ["Salvia leucophylla", "Purple sage", 1.5, 1.8, "#c39bc0"],
];

for (const [species, common, h, s, flower] of SAGES) {
  test(`${common}'s flower whorls stand on stalks`, needsLibrary, () => {
    const g = buildPlant({ id: "p1", species, common, position: [0, 0], form: "mound",
                           mature_height_m: h, mature_spread_m: s, flower });
    g.updateWorldMatrix(true, true);
    const box = name => {
      const b = new THREE.Box3();
      g.traverse(o => { if (o.isMesh && o.name === name) b.union(new THREE.Box3().setFromObject(o)); });
      return b;
    };
    const bloom = box("bloom"), wood = box("wood");
    assert.ok(!bloom.isEmpty(), `${common} drew no flowers at all — the test cannot see the fault`);
    // the tallest stalk reaches the top whorl (a floret sits beside its stalk, so allow its size)
    assert.ok(wood.max.y >= bloom.max.y - 0.05,
      `flowers reach ${bloom.max.y.toFixed(2)} m, stalks stop at ${wood.max.y.toFixed(2)} m — they float`);
  });
}
