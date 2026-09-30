// node --test tests/js/
//
// A slope needs different types of edging — steel, natural rock — and a model must
// be able to generate them.
//
// corten_steel and aluminium are swept-solid materials. The one that matters on a
// 14 deg slope is a ROCK edge, and a rock edge is not a grey wall. A colour and a
// roughness on the same swept solid is right for brick and wrong for
// boulders: the whole reason to armour a slope toe with rock rather than build a
// wall is that it reads as irregular natural stone. A boulder edge drawn as a
// smooth slab tinted grey is the same defect as a bed drawn as a hard rectangle.
//
// So this suite asserts the SHAPE, not the swatch.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
globalThis.document = {
  createElement() {
    const ops = [];
    const ctx = { fillStyle: "#000", fillRect: (x, y, w, h) => ops.push({ style: ctx.fillStyle, x, y, w, h }) };
    return { width: 0, height: 0, ops, getContext: () => ctx };
  },
};
const design = await import(path.join(ROOT, "viewer", "src", "design.js"));

const FLAT = () => 0;                       // level ground: any relief is the EDGE's
const run = (material, extra = {}) => design.edgeMesh(
  { id: "e1", spline: [[0, 0], [3, 0], [6, 0]], height_m: 0.5, material, ...extra }, FLAT);

function topProfile(obj) {
  // Highest vertex in each 0.25 m bucket along x — the silhouette you'd see.
  const buckets = new Map();
  obj.traverse?.((n) => {
    const p = n.geometry?.attributes?.position;
    if (!p) return;
    for (let i = 0; i < p.count; i++) {
      const b = Math.round(p.getX(i) / 0.25);
      buckets.set(b, Math.max(buckets.get(b) ?? -Infinity, p.getY(i)));
    }
  });
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, y]) => y);
}

test("the rock edges exist at all", () => {
  for (const m of ["boulder", "dry_stone"]) {
    assert.ok(design.WALL_SURFACES[m], `no "${m}" surface — a slope has no rock option`);
  }
});

test("a boulder edge reads as rocks, not as a wall painted grey", () => {
  const rough = topProfile(run("boulder"));
  const smooth = topProfile(run("concrete"));
  const spread = (a) => Math.max(...a) - Math.min(...a);
  assert.ok(smooth.length > 4 && rough.length > 4, "no geometry to compare");
  assert.ok(spread(smooth) < 0.05,
    `concrete on flat ground should have a level top, got ${spread(smooth).toFixed(3)} m`);
  assert.ok(spread(rough) > 0.12,
    `boulders vary in size; this top is flat to ${spread(rough).toFixed(3)} m, ` +
    `which is a slab wearing a rock texture`);
});

test("a boulder edge is still the height it was asked for", () => {
  // Irregular is not the same as arbitrary. A 0.5 m rock toe that averages 0.9 m
  // is a retaining wall the owner did not ask for and did not price.
  const tops = topProfile(run("boulder"));
  const mean = tops.reduce((a, b) => a + b, 0) / tops.length;
  assert.ok(Math.abs(mean - 0.5) < 0.18, `asked 0.5 m, mean top ${mean.toFixed(2)} m`);
  assert.ok(Math.max(...tops) < 0.9, `tallest rock ${Math.max(...tops).toFixed(2)} m is a wall`);
});

test("rock edges are reproducible", () => {
  // Two renders of the same design must not shuffle the boulders, or every
  // walkthrough frame shows a different garden and no visual check means anything.
  assert.deepEqual(topProfile(run("boulder")), topProfile(run("boulder")));
});

test("two different rock edges are not the same rocks", () => {
  const a = topProfile(run("boulder"));
  const b = topProfile(design.edgeMesh(
    { id: "e2", spline: [[0, 0], [3, 0], [6, 0]], height_m: 0.5, material: "boulder" }, FLAT));
  assert.notDeepEqual(a, b, "every rock edge in the garden is the identical rock run");
});
