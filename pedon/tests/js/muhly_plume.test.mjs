// node --test tests/js/muhly_plume.test.mjs
//
// A pink muhly is a PINK CLOUD, and it has to be able to be both.
//
// Muhlenbergia capillaris — pink, or 'White Cloud' — must not render like deer
// grass: a tuft with bare straw wires above it. Two things in grassInflorescence
// decide it:
//
//   1. `airy` — a diffuse open panicle — must match Muhlenbergia capillaris as
//      well as Sporobolus, Festuca, Nassella and Stipa. Without it capillaris
//      draws the NARROW SPIKE that is right for M. rigens and wrong for the one
//      plant whose entire character is a haze of tiny florets.
//   2. `headColour` must use the flower colour every grass in the catalog
//      declares, not a hardcoded straw. Otherwise pink muhly cannot be pink, and
//      Nassella pulchra, PURPLE needlegrass at #99788a, draws tan.
//
// Rendering ONE of them close, which is rule 2 of ASSET_FIDELITY.md, shows this;
// counting triangles cannot show that a plant looks like the wrong species.
import test from "node:test";
import assert from "node:assert/strict";
import { grassInflorescence } from "../../viewer/src/botanical.js";

const rnd = () => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; };
const build = (species, flower) => grassInflorescence(
  { species, flower, mature_height_m: 0.95, mature_spread_m: 0.95 }, rnd());

function colours(mesh) {
  const c = mesh.geometry.attributes.color;
  const out = [];
  for (let i = 0; i < c.count; i++) out.push([c.getX(i), c.getY(i), c.getZ(i)]);
  return out;
}

test("a pink muhly is measurably pink", () => {
  const cols = colours(build("Muhlenbergia capillaris", "#d98cb0"));
  const pink = cols.filter(([r, g, b]) => r > g && r > b && r - g > 0.08);
  assert.ok(pink.length > 0,
    "nothing in a pink muhly's inflorescence is pink — the head colour is being "
    + "overridden with straw, which makes it read as deer grass");
});

test("the white form is not the pink one", () => {
  const mean = sp => {
    const c = colours(build(sp.species, sp.flower));
    return c.reduce((a, x) => a + (x[0] - x[1]), 0) / c.length;   // redness
  };
  const pinkness = mean({ species: "Muhlenbergia capillaris", flower: "#d98cb0" });
  const whiteness = mean({ species: "Muhlenbergia capillaris 'White Cloud'", flower: "#e8e4d8" });
  assert.ok(pinkness > whiteness + 0.05,
    `pink ${pinkness.toFixed(3)} vs white ${whiteness.toFixed(3)} — the owner has both and `
    + "they must not render as the same plant");
});

test("capillaris gets the diffuse panicle and rigens keeps its spike", () => {
  // the two Muhlenbergia are on opposite sides of the airy line, and collapsing
  // them either way loses a real botanical difference
  const cloud = build("Muhlenbergia capillaris", "#d98cb0").geometry.attributes.position.count;
  const spike = build("Muhlenbergia rigens", "#c8bda0").geometry.attributes.position.count;
  assert.ok(cloud > spike * 2,
    `capillaris ${cloud} vertices vs rigens ${spike} — a haze of florets is far more `
    + "geometry than a narrow spike; if they are close, capillaris is still drawing a spike");
});

test("a grass with no declared flower gets NO head", () => {
  // The function's opening guard requires p.flower, so the `||` fallback in
  // headColour is unreachable. This pins the real behaviour: a species that
  // declares no flower is out of bloom, and inventing a straw head for it would
  // be worse than drawing none.
  assert.equal(build("Festuca idahoensis", undefined), null);
  assert.ok(build("Festuca idahoensis", "#c3b398"),
    "a declared flower must still produce a head");
});

test("a plant this function does not serve still returns null", () => {
  assert.equal(build("Salvia clevelandii", "#8f8ec7"), null);
});
