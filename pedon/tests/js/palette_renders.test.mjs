// node --test tests/js/
//
// Every species in the palette has to DRAW. Models come from the asset
// library — faster, and cheaper than generating them with a model — so the
// palette is a promise: anything listed can be placed and will look like itself.
//
// A palette that lists a species the viewer renders as a grey blob is worse than
// no palette at all, because it reads as availability. Nothing else in the suite
// would catch that: the python tests check the table, the routing tests check the
// tables agree, and neither one ever executes a builder over the actual list.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "../../viewer/node_modules/three/build/three.module.js";
import { dataPath } from "../../viewer/project_paths.js";   // the active site's files
import { catalogue } from "./lib/library.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
globalThis.document = {
  createElement() {
    const ctx = { fillStyle: "#000", fillRect() {}, createRadialGradient: () => ({ addColorStop() {} }) };
    return { width: 0, height: 0, getContext: () => ctx };
  },
};
const { buildPlant, growthForm } = await import(path.join(ROOT, "viewer", "src", "plants.js"));
const PALETTE = catalogue();

const asPlant = (p, i) => ({
  id: `pal_${i}`, species: p.species, common: p.common, form: p.form,
  mature_height_m: p.mature_height_m, mature_spread_m: p.mature_spread_m,
  foliage: p.foliage, position: [0, 0],
});

// Vertices in the plant's OWN frame, transformed by each node's matrix.
//
// Measured the naive way — local geometry positions, no transforms — every mat
// plant reads at 4.5x its height. The culprit is the contact shadow: a
// PlaneGeometry is authored in XY and rotated flat, so in LOCAL coordinates a
// 1.5 m shadow disc is 1.5 m TALL. A bound taken in the wrong frame is not a bound.
function measure(obj) {
  obj.updateMatrixWorld(true);
  let n = 0;
  obj.traverse((node) => {
    const pos = node.geometry?.attributes?.position;
    if (!pos) return;
    n += pos.count*(node.isInstancedMesh?node.count:1);
  });
  const box=new THREE.Box3().setFromObject(obj),lo=box.min.y,hi=box.max.y;
  const wide=Math.max(Math.abs(box.min.x),Math.abs(box.max.x),Math.abs(box.min.z),Math.abs(box.max.z));
  return { n, lo, hi, wide, height: hi - Math.min(0, lo) };
}

// Both assertions inspect the same immutable full-detail palette inputs.
// Keep their measured evidence, not a second rebuild of every mature master
// (or hundreds of megabytes of retained live meshes). No plant is skipped.
const paletteMeasures=new Map();
function measurePalette(p,i){
  if(!paletteMeasures.has(i))paletteMeasures.set(i,measure(buildPlant(asPlant(p,i))));
  return paletteMeasures.get(i);
}

test("all 52 build something with real geometry", () => {
  const empty = [];
  PALETTE.forEach((p, i) => {
    const m = measurePalette(p,i);
    if (m.n < 12) empty.push(`${p.species} (${p.form}): ${m.n} vertices`);
  });
  assert.deepEqual(empty, [], `these draw as nothing:\n${empty.join("\n")}`);
});

test("each is roughly the height the palette states", () => {
  // Not exact: a procedural clump is grown, not extruded, and a GLB is scaled to
  // its own bounds. But a 0.1 m thyme that renders 1.2 m tall is not thyme.
  const bad = [];
  PALETTE.forEach((p, i) => {
    const m = measurePalette(p,i);
    const want = p.mature_height_m;
    if (m.height < want * 0.45 || m.height > want * 1.75) {
      bad.push(`${p.species}: asked ${want} m, drew ${m.height.toFixed(2)} m`);
    }
  });
  assert.deepEqual(bad, [], `heights are not honest:\n${bad.join("\n")}`);
});

test("the palette's declared form is the form that gets drawn", () => {
  // The palette says "rush" for Juncus because a rush is not a mound. If
  // growthForm() disagrees, the table is decoration and the silhouette work is
  // undone silently.
  const bad = [];
  PALETTE.forEach((p, i) => {
    const got = growthForm(asPlant(p, i));
    if (got !== p.form) bad.push(`${p.species}: palette says ${p.form}, viewer draws ${got}`);
  });
  assert.deepEqual(bad, [], `the table and the renderer disagree:\n${bad.join("\n")}`);
});

test("two plants of the same species are not the same object", () => {
  const a = measure(buildPlant({ ...asPlant(PALETTE[7], 0), id: "a" }));
  const b = measure(buildPlant({ ...asPlant(PALETTE[7], 0), id: "b" }));
  assert.notEqual(a.height.toFixed(4), b.height.toFixed(4),
    "a drift of deer grass is 9 identical clones — the seed is not reaching the geometry");
});
