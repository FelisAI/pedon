// node --test tests/js/plant_variation.test.mjs
//
// A drift of five should not be five copies of one object.
//
// Measured: a library model carries TWO flat materials — one bark colour, one
// leaf colour — and `COLOR_0` is absent from the mesh, so there is no per-vertex
// variation either. Without this, the only thing separating two manzanitas is
// `inst.rotation.y`. Five of them in a bed is the same flat-green silhouette at
// five angles, which is exactly what makes massed planting read as wallpaper
// however well it is grouped.
//
// Two cheap remedies, no regeneration needed: materials are ALREADY cloned per
// instance (selection highlighting needs that), so tinting one costs nothing,
// and a scale jitter is one multiply. Both must be driven by the caller's `rand`
// so a garden does not change colour every time the page reloads.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
globalThis.document = { createElement: () => ({ width: 0, height: 0,
  getContext: () => ({ fillRect() {}, fillText() {}, beginPath() {}, arc() {}, fill() {},
                       stroke() {}, createLinearGradient: () => ({ addColorStop() {} }) }) }) };
const assets = await import(path.join(ROOT, "viewer", "src", "assets.js"));

/** A deterministic PRNG, so a test failure is reproducible. */
function prng(seed) { let s = seed; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; }

test("the variation helpers are exported at all", () => {
  assert.equal(typeof assets.instanceTint, "function",
    "no instanceTint — every clone of a species is the same flat colour");
  assert.equal(typeof assets.instanceScale, "function",
    "no instanceScale — every clone of a species is exactly the same size");
});

test("two instances differ in colour, and not by a silly amount", () => {
  const r = prng(7);
  const seen = Array.from({ length: 8 }, () => assets.instanceTint(r));
  const uniq = new Set(seen.map(v => v.toFixed(4)));
  assert.ok(uniq.size >= 6, `only ${uniq.size} distinct tints in 8 — clones still match`);
  for (const v of seen)
    assert.ok(v > 0.82 && v < 1.18,
      `tint ${v.toFixed(3)} would change the species, not vary the individual`);
});

test("two instances differ in size, within what a plant actually does", () => {
  const r = prng(11);
  const seen = Array.from({ length: 8 }, () => assets.instanceScale(r));
  assert.ok(new Set(seen.map(v => v.toFixed(4))).size >= 6, "clones are all one size");
  for (const v of seen)
    assert.ok(v > 0.85 && v < 1.15,
      `scale ${v.toFixed(3)} is a different plant, not a different individual`);
});

test("the same seed gives the same garden", () => {
  // otherwise every reload repaints the planting and the owner cannot trust that
  // what they looked at yesterday is what they are looking at now
  const a = prng(3), b = prng(3);
  assert.equal(assets.instanceTint(a), assets.instanceTint(b));
  assert.equal(assets.instanceScale(a), assets.instanceScale(b));
});
