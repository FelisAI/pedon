// node --test tests/js/preview_builders.test.mjs
//
// Fast preview must draw the SAME plant as full detail for every species with its own
// botanical builder. A separate Fast shape is measurably a different plant
// (tools/preview_agreement.mjs): on a 155-plant design, 40 plants off, lamb's ear 41% too
// short, bronze fennel 51% too wide, Rosie Posie agastache and deer grass on the generic
// shape. The owner works in Fast, so Fast runs the SAME builder and draws its parts with
// cheap stand-ins in the same places.
import test from "node:test";
import assert from "node:assert/strict";
import { agreement } from "../../tools/preview_agreement.mjs";

const plant = (species, common, h, w, form, flower) =>
  ({ id: common, species, common, position: [0, 0], mature_height_m: h, mature_spread_m: w, form, flower });
const DESIGN = { plants: [
  plant("Agastache 'Rosie Posie'", "Rosie Posie", 0.6, 0.6, "perennial", "#d0619a"),
  plant("Stachys byzantina", "Lamb's ear", 0.45, 0.6, "mat", "#b58fb5"),
  plant("Muhlenbergia rigens", "Deer grass", 1.2, 1.2, "grass", "#b5a77e"),
  plant("Foeniculum vulgare 'Purpureum'", "Bronze fennel", 1.8, 0.9, "perennial", "#e1c64a"),
] };
const rows = agreement(DESIGN);

for (const r of rows) {
  test(`${r.species}: Fast is the same builder, the same size, and cheaper`, () => {
    assert.equal(r.fast_builder, r.full_builder, "Fast drew a different plant");
    assert.ok(Math.abs(r.h_err) <= 5 && Math.abs(r.w_err) <= 5,
      `Fast is ${r.h_err}% in height and ${r.w_err}% in width off full detail`);
    // cheaper: at least 3x (fennel's merged segments go 20 -> 6 triangles), or it is not a
    // preview — unless full detail is already cheap (lamb's ear is 44 k)
    assert.ok(r.fast.tris * 3 <= r.full.tris || r.full.tris < 60000,
      `Fast ${r.fast.tris} triangles against ${r.full.tris} at full`);
  });
}

import { buildPlant } from "../../viewer/src/plants.js";
import { needsLibrary } from "./lib/library.mjs";   // about the user's library: skips without one
test("a stand-in carries every attribute its material reads — or it draws black", needsLibrary, () => {
  let checked = 0;
  for (const p of DESIGN.plants) {
    buildPlant(p, { quality: "fast" }).traverse(o => {
      if (!o.isInstancedMesh) return;
      for (const m of [o.material].flat()) {
        if (m.vertexColors) { assert.ok(o.geometry.attributes.color, `${p.common} ${o.name}: vertexColors with no colour`); checked++; }
        if (m.map) assert.ok(o.geometry.attributes.uv, `${p.common} ${o.name}: a texture with no uv`);
      }
    });
  }
  assert.ok(checked >= 4, `only ${checked} colour-carrying parts checked — the test sees nothing`);
});

test("a grass blade is its own width in Fast", () => {
  // Blades drawn 4x wide get a quarter the count, because the count follows coverage: a
  // 3 mm Muhlenbergia haze becomes a coarse 12 mm tuft. True width costs the frame at a
  // saved view 51 -> 57 ms (median of 12), for Fast matching full detail.
  const [muhly] = agreement({ plants: [plant("Muhlenbergia capillaris", "Pink muhly", 0.9, 0.9, "grass", "#d98cb0")] });
  assert.ok(muhly.fast.tris >= 0.9 * muhly.full.tris,
    `Fast draws ${muhly.fast.tris} triangles of blade against ${muhly.full.tris} — the blades are wider and fewer`);
});
