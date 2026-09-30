// node --test tests/js/botanical_lod.test.mjs
//
// Garden detail must make the yard renderable WITHOUT deleting the plants.
//
// Both halves are load-bearing, and the second is the one that catches a bad
// implementation. Culling every organ under 6 mm and thinning the rest to a
// triangle budget reports a 219x saving and takes a Ceanothus from 5,082,611
// florets to ZERO and from 30,303 leaves to ten. A cost measurement cannot tell
// you that — an empty shrub is very cheap — so the
// coverage assertions below exist to make "cheap" and "still a plant" separate
// claims that must both hold.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
globalThis.document = { createElement() {
  const ctx = new Proxy({}, { get: (t, k) =>
      k === "measureText" ? (() => ({ width: 10 }))
    : k === "getImageData" ? (() => ({ data: new Uint8ClampedArray(4) }))
    : k === "createLinearGradient" || k === "createRadialGradient" ? (() => ({ addColorStop() {} }))
    : k === "canvas" ? { width: 0, height: 0 } : (() => {}) });
  return { width: 0, height: 0, getContext: () => ctx, toDataURL: () => "" };
} };
const THREE = await import(path.join(ROOT, "viewer", "node_modules", "three", "build", "three.module.js"));
const W = await import(path.join(ROOT, "viewer", "src", "woody_geometry.js"));

const proto = (tri, span) => {
  const g = new THREE.BoxGeometry(span, span, span);
  // pad the index so the prototype reports the triangle count the test wants
  const idx = new Uint32Array(Math.max(3, tri * 3));
  for (let i = 0; i < idx.length; i++) idx[i] = i % 8;
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
};

test("inspection keeps every organ — compare.html must be untouched", () => {
  const hair = proto(12000, 0.0003);
  const p = W.detailPlan(hair, "leaf hairs", 900000, "inspection");
  assert.equal(p.action, "keep");
  assert.equal(p.keep, 900000, "inspection thinned an organ; the masters must render whole");
});

test("garden drops surface FINISH, which cannot reach a pixel", () => {
  // 0.3 mm hairs at 3.5 mm/px (5 m). Measured share of the design: 24.5%.
  for (const name of ["leaf hairs", "stem hairs", "abaxial wool", "leaf pubescence",
                      "leaf undersides", "reproductive organs"]) {
    const p = W.detailPlan(proto(9000, 0.0003), name, 500000, "garden");
    assert.equal(p.action, "cull", `${name} survived garden detail`);
  }
});

test("garden AGGREGATES a swarm — it must never simply delete one", () => {
  // A ceanothus carries 5,082,611 florets. They are not redundant copies, they
  // TILE A SURFACE: thin them and the shrub stops being blue.
  const p = W.detailPlan(proto(2400, 0.003), "bloom", 5082611, "garden");
  assert.equal(p.action, "aggregate",
    "a dense swarm of sub-pixel organs was thinned or culled rather than aggregated — "
    + "culling or thinning a swarm erases every flower on the plant");
  assert.equal(p.keep, 5082611, "aggregate must consider every instance, not a subset");
});

test("a small plant is left completely alone", () => {
  // 544 leaves on a Berggarten sage: cheap, and individually visible. Nothing to do.
  const p = W.detailPlan(proto(300, 0.05), "foliage", 544, "garden");
  assert.notEqual(p.action, "cull");
  assert.equal(p.keep, 544, "a 544-leaf plant was thinned; it costs nothing to keep");
});

test("thinning has a FLOOR, so no canopy can go bald for a budget", () => {
  // The failure this floor prevents: a 30,303-leaf ceanothus reduced to ten.
  W.setBotanicalBudget(1);                       // an absurd budget on purpose
  try {
    const p = W.detailPlan(proto(18702, 0.09), "foliage", 30303, "garden");
    assert.ok(p.keep >= 30303 * 0.2,
      `budget pressure cut foliage to ${p.keep} of 30303 — a plant with no leaves is `
      + "not a cheap plant, it is a wrong one");
  } finally { W.setBotanicalBudget(240000); }
});

test("instanceBatch really applies the plan, and reports what it did", () => {
  const mat = new THREE.MeshBasicMaterial();
  W.setBotanicalDetail("garden");
  try {
    const items = [];
    for (let i = 0; i < 4000; i++)
      items.push({ at: new THREE.Vector3((i % 40) * 0.01, ((i / 40) | 0) * 0.01, 0),
                   q: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1),
                   color: new THREE.Color(0.3, 0.4, 0.9) });
    const swarm = W.instanceBatch(proto(2400, 0.003), mat, items, "bloom");
    assert.ok(swarm.userData.lodAggregated === 4000, "the swarm was not aggregated");
    assert.ok(swarm.count > 0 && swarm.count < 4000,
      `aggregation produced ${swarm.count} lumps from 4000 organs — it must reduce, and must not empty`);
    assert.ok(swarm.instanceColor, "aggregated lumps lost their colour, which is the whole point of keeping them");

    const culled = W.instanceBatch(proto(9000, 0.0003), mat, items, "leaf hairs");
    assert.equal(culled.count, 0);
    assert.equal(culled.userData.lodCulled, 4000);
  } finally { W.setBotanicalDetail("inspection"); }
});

// ── AN AGGREGATED SWARM KEEPS ITS COLOUR ──────────────────────────────
// California fuchsia can draw as a mound of BLACK BALLS with red flowers on it. Its 21,703
// leaves are a swarm, garden detail stands lumps in for them, and the lump is drawn with
// the caller's material — `vertexColors: true`, as it is across the plant modules, because
// the real leaf carries its colour per vertex. A shared lump geometry with no `color`
// attribute gets (0,0,0) from WebGL and everything multiplies to black.
// "lost their colour" above only checks that an instanceColor EXISTS; black is a colour.
const swarmOf = (n, color) => {
  const items = [];
  for (let i = 0; i < n; i++)
    items.push({ at: new THREE.Vector3((i % 40) * 0.01, ((i / 40) | 0) * 0.01, 0),
                 q: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1), color });
  return items;
};
const meanLumpColour = m => {
  const a = m.instanceColor.array, out = [0, 0, 0];
  for (let i = 0; i < m.count; i++) for (let k = 0; k < 3; k++) out[k] += a[i * 3 + k] / m.count;
  return out;
};

test("a lump can be drawn by a vertexColors material without going black", () => {
  W.setBotanicalDetail("garden");
  try {
    const lump = W.instanceBatch(proto(2400, 0.003), new THREE.MeshStandardMaterial({ vertexColors: true }),
                                 swarmOf(4000, new THREE.Color(1, 1, 1)), "foliage");
    assert.ok(lump.userData.lodAggregated, "not aggregated — this test is about lumps");
    const c = lump.geometry.attributes.color;
    assert.ok(c, "the lump has no `color` attribute: under vertexColors it reads (0,0,0) and draws BLACK");
    assert.equal(c.count, lump.geometry.attributes.position.count);
    for (let i = 0; i < c.count; i++)
      assert.ok(c.getX(i) === 1 && c.getY(i) === 1 && c.getZ(i) === 1, "the lump's own vertex colour must be white — it is a multiplier");
  } finally { W.setBotanicalDetail("inspection"); }
});

test("a lump is the colour of the ORGAN it stands for, not of the tint over it", () => {
  // the leaf is green PER VERTEX; its instance colour is only a tint near 1
  const leaf = proto(2400, 0.003);
  const n = leaf.attributes.position.count, green = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) green.set([0.19, 0.24, 0.17], i * 3);
  leaf.setAttribute("color", new THREE.BufferAttribute(green, 3));
  W.setBotanicalDetail("garden");
  try {
    const lump = W.instanceBatch(leaf, new THREE.MeshStandardMaterial({ vertexColors: true }),
                                 swarmOf(4000, new THREE.Color(1, 0.9, 1)), "foliage");
    const got = meanLumpColour(lump);
    for (const [k, want] of [[0, 0.19], [1, 0.24 * 0.9], [2, 0.17]])
      assert.ok(Math.abs(got[k] - want) < 0.01, `lump colour ${got.map(v => v.toFixed(2))} — channel ${k} should be ${want}`);
    // and an organ with no vertex colour is left exactly as its instances said
    const plain = W.instanceBatch(proto(2400, 0.003), new THREE.MeshStandardMaterial(),
                                  swarmOf(4000, new THREE.Color(0.3, 0.4, 0.9)), "bloom");
    const p = meanLumpColour(plain);
    assert.ok(Math.abs(p[0] - 0.3) < 0.01 && Math.abs(p[1] - 0.4) < 0.01 && Math.abs(p[2] - 0.9) < 0.01, `${p}`);
  } finally { W.setBotanicalDetail("inspection"); }
});
