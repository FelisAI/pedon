// node --test tests/js/
//
// Coast rosemary must not draw its flowers as balls.
//
// Measured: the DETAILED model is right — its bloom is 1,553 instances of a flat
// 9.7 x 9.9 x 1.2 mm five-lobed disc, which is what a Westringia flower is. A
// build that skips the shoot model falls back to bloom spheres scattered over
// the canopy (129 of them, 36 triangles each, 4,644 triangles in that mesh), and
// those balls are what the floret radius sizes.
//
// And the size rule must read the common name as well as `species`: "Westringia
// fruticosa" contains no "rosemary" — only its common name, Coast Rosemary,
// does — so a rule on `species` alone gives it the COARSE radius, 12 mm rather
// than 6.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { needsLibrary } from "./lib/library.mjs";   // about the user's library: skips without one

globalThis.document = { createElement() { return { width: 0, height: 0,
  getContext: () => new Proxy({ measureText: () => ({ width: 12 }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }) },
    { get: (o, k) => o[k] ?? (() => {}) }) }; } };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { floretRadius, buildPlant } = await import("../../viewer/src/plants.js");

test("a needle-leaved shrub gets the fine floret, whichever name says so", () => {
  assert.equal(floretRadius({ species: "Westringia fruticosa", common: "Coast Rosemary" }), .003,
    "Westringia is still getting 12 mm balls");
  assert.equal(floretRadius({ species: "Salvia rosmarinus", common: "Rosemary" }), .003);
  // the botanical name alone must still work — most of the palette has no
  // helpful common name
  assert.equal(floretRadius({ species: "Westringia fruticosa" }), .003,
    "matching now depends on a common name being present");
  // and the COMMON name alone must work too. Without this the second half of
  // the rule is dead weight: deleting it leaves every assertion above green,
  // because "westringia" is in the botanical name as well. This is the case the
  // rule exists for — the next plant sold as a rosemary that is not one.
  assert.equal(floretRadius({ species: "Prostanthera rotundifolia",
                              common: "Round-leaf Rosemary Bush" }), .003,
    "a plant whose COMMON name says rosemary still gets 12 mm balls");
});

test("a broad-leaved subshrub keeps the coarser floret", () => {
  // the counterweight: a rule that matches everything is not a rule
  assert.equal(floretRadius({ species: "Salvia clevelandii", common: "Cleveland sage" }), .006);
  assert.equal(floretRadius({ species: "Cistus", common: "Rockrose" }), .006);
});

test("a plant with no names at all does not throw", () => {
  // it runs over every plant in the design on every fast rebuild
  assert.equal(floretRadius({}), .006);
  assert.equal(floretRadius(null), .006);
});

test("the builder asks it instead of carrying its own copy of the rule", () => {
  const src = fs.readFileSync(path.join(ROOT, "viewer", "src", "plants.js"), "utf8");
  const code = src.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.match(code, /new THREE\.SphereGeometry\(floretRadius\(plant\), 6, 4\)/,
    "the bloom sphere no longer reads the shared rule");
  assert.equal((code.match(/rosmarinus\|rosemary\|coleonema/g) ?? []).length, 1,
    "the floret rule is written in more than one place");
});

test("the detailed model is not the problem — its flower is a flat disc", needsLibrary, () => {
  // pinned so a future 'fix' to the balls does not reach into the good path
  const plant = { id: "w1", species: "Westringia fruticosa", common: "Coast Rosemary",
                  position: [15, -5], mature_height_m: 1.8, mature_spread_m: 1.8,
                  form: "mound", foliage: "#6a7d5e", flower: "#f6f4ef" };
  const g = buildPlant(plant, { quality: "detailed" });
  let bloom = null;
  g.traverse(o => { if (o.isMesh && o.name === "bloom") bloom = o; });
  assert.ok(bloom, "the detailed build has no bloom at all");
  bloom.geometry.computeBoundingBox();
  const b = bloom.geometry.boundingBox;
  const w = (b.max.x - b.min.x) * 1000, thick = (b.max.z - b.min.z) * 1000;
  assert.ok(w > 6 && w < 14, `a Westringia flower is about 10 mm across; this one is ${w.toFixed(1)} mm`);
  assert.ok(thick < w / 4, `it is a FLAT five-lobed flower, not a ball (${thick.toFixed(1)} mm thick)`);
});
