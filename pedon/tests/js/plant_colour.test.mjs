// node --test tests/js/
//
// Plants must not all be green: the user needs to see colour and compare colour
// in the design.
//
// data/plant_palette.json carries BOTH a foliage hex and a flower hex for every
// species in the palette. Without the wiring pinned here, neither reaches the garden:
//
//   * designs write `foliage: "dark_green"` — a WORD, which collapses through
//     nine ramps, so fifty species arrive as a handful of greens;
//   * `perennialClump` builds flower heads on stems, and merged into the same
//     geometry as the leaves they are painted the foliage colour.
//
// So the colour sits in a file, unused, unless the renderer gives the flower a
// material of its own.
//
// The rule this pins: a flower is only drawn when the plant SAYS it has one.
// Inventing blossom on an unflowered species would be the same class of lie as
// substituting a material silently — prettier, and still not the owner's garden.
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
const { buildPlant } = await import(path.join(ROOT, "viewer", "src", "plants.js"));
const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const PALETTE = catalogue();

/** Every distinct material colour in the built plant, excluding the shadow. */
function colours(obj) {
  const out = [];
  obj.traverse((n) => {
    if (n.isMesh && n.material?.color && n.material.map == null) {
      out.push("#" + n.material.color.getHexString());
    }
  });
  return out;
}
const near = (a, b, tol = 26) => {
  const A = new THREE.Color(a), B = new THREE.Color(b);
  return Math.abs(A.r - B.r) * 255 < tol && Math.abs(A.g - B.g) * 255 < tol
      && Math.abs(A.b - B.b) * 255 < tol;
};
const spec = (over = {}) => ({
  id: "x", species: "Achillea millefolium", form: "perennial",
  mature_height_m: 0.6, mature_spread_m: 0.6, position: [0, 0], ...over,
});

test("the palette really does carry both colours — the premise", () => {
  for (const p of PALETTE) {
    assert.match(p.foliage, /^#[0-9a-f]{6}$/i, `${p.species} foliage`);
    assert.match(p.flower, /^#[0-9a-f]{6}$/i, `${p.species} flower`);
  }
});

test("a declared flower colour is actually painted on the plant", () => {
  const flower = "#e0713a";
  const got = colours(buildPlant(spec({ foliage: "#7f9a7a", flower })));
  assert.ok(got.some(c => near(c, flower)),
    `no material anywhere near ${flower}; the plant is painted ${got.join(", ")}`);
});

test("flower and foliage are DIFFERENT materials, not one averaged green", () => {
  const o = buildPlant(spec({ foliage: "#7f9a7a", flower: "#e0603a" }));
  const got = colours(o);
  assert.ok(got.some(c => near(c, "#7f9a7a")), `foliage colour missing: ${got}`);
  assert.ok(got.some(c => near(c, "#e0603a")), `flower colour missing: ${got}`);
});

test("a plant that declares no flower grows none", () => {
  // the whole point of colour is that it MEANS something
  const plain = colours(buildPlant(spec({ foliage: "#7f9a7a" })));
  assert.ok(!plain.some(c => near(c, "#e0603a")), `invented a flower: ${plain}`);
});

test("two species from the palette come out visibly different", () => {
  // colour has to be seen AND compared in the design — comparison is the
  // requirement, so two rows of the palette must not converge.
  const poppy = PALETTE.find(p => p.species.startsWith("Eschscholzia"));
  const sage = PALETTE.find(p => p.species === "Salvia clevelandii");
  const a = colours(buildPlant(spec({ ...poppy, id: "a", form: poppy.form })));
  const b = colours(buildPlant(spec({ ...sage, id: "b", form: sage.form })));
  assert.ok(a.some(c => near(c, poppy.flower)), `poppy is not orange: ${a}`);
  assert.ok(b.some(c => near(c, sage.flower)), `cleveland sage is not violet: ${b}`);
});

test("the viewer fills a plant's colours in from the owner's palette", () => {
  // The wiring. Designs on disk write `foliage: "dark_green"` and no flower at
  // all, so without this the two tests above are true of nothing that exists.
  const code = main.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.match(code, /plantCatalog/,
    "main.js loads the shortlist for the PICKER and never uses it to colour the garden");
  assert.match(code, /function\s+colourFromPalette|colourFromPalette\(/,
    "nothing enriches a design's plants from the palette before they are built");
});
