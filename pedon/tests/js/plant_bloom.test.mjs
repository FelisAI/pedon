// node --test tests/js/plant_bloom.test.mjs
//
// How flowery a plant is must be a fact about THAT PLANT.
//
// The five species that route to a bought model — manzanita, ceanothus, toyon,
// olive, flannel bush — are the largest things in the garden. Sizing their
// blossom by a clamped formula
//
//     n    = clamp(2600 + spread * 3200, 2600, 13000)
//     head = clamp(spread * 0.007,        0.006,  0.020)
//
// gives them all the SAME AMOUNT OF FLOWER. Not approximately: exactly. Every
// species in the palette hits BOTH clamps, so each gets 50.7 m² of flower
// whatever it is. Measured against each model's own geometry that is 63%
// flower on the manzanita — whose GLB is a sparse gnarled shrub with 18.4 m² of
// leaf — and 27% on the olive, at 172.6 m². An olive tree. Whose reference
// photograph, refphotos/olea_europaea_fruitless.jpg, contains no visible flower
// at all.
//
// The tell is five bloom areas agreeing to three significant figures while the
// plants agree about nothing. So the assertion that matters
// here is not any single number: it is that the numbers DIFFER, in the direction
// the photographs say, and that each one lands where its table entry claims.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "../../viewer/node_modules/three/build/three.module.js";
import { libraryJson } from "./lib/library.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
globalThis.document = {
  createElement() {
    const ctx = { fillStyle: "#000", fillRect() {}, createRadialGradient: () => ({ addColorStop() {} }) };
    return { width: 0, height: 0, getContext: () => ctx };
  },
};
const { assetBlooms, bloomUnit, ellipsoidArea, geomTriangleArea } =
  await import(path.join(ROOT, "viewer", "src", "plants.js"));
const palette = libraryJson("data/plant_palette.json");

/**
 * A stand-in for a loaded GLB: a box of the plant's mature size.
 *
 * The real models cannot be loaded here — GLTFLoader needs a browser — and they
 * are not what is under test. assetBlooms reads only the asset's BOUNDING BOX,
 * so a box of the right size exercises the identical code path, and using one
 * keeps this test measuring the blossom rule rather than the asset library.
 */
function fakeAsset(h, spread) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(spread, h, spread).translate(0, h / 2, 0)));
  return g;
}

const rng = (seed => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)(7);

/** Bloom area, and the canopy shell it is measured against — the same shell assetBlooms uses. */
function bloomOn(plant) {
  const h = plant.mature_height_m, spread = plant.mature_spread_m;
  const asset = fakeAsset(h, spread);
  const mesh = assetBlooms(asset, spread, rng, bloomUnit(plant));
  const shell = ellipsoidArea(spread / 2, h * 0.5 * 0.55, spread / 2);
  const area = mesh ? geomTriangleArea(mesh.geometry) : 0;
  return { area, shell, share: area / (area + shell) };
}

const GLB = ["Ceanothus spp.", "Arctostaphylos spp.", "Heteromeles arbutifolia",
             "Olea europaea (fruitless)", "Fremontodendron spp."];
const plantsOf = () => GLB.map(sp => {
  const p = palette.plants.find(x => x.species === sp);
  assert.ok(p, `${sp} is no longer in the palette — this test is measuring nothing`);
  return p;
});

test("each species gets the share of flower its photograph shows", () => {
  for (const p of plantsOf()) {
    const want = bloomUnit(p).cover;
    const { share } = bloomOn(p);
    // 3 points of slack: the count is derived from an idealised shell and the
    // units land on a jittered one, so it cannot be exact
    assert.ok(Math.abs(share - want) < 0.03,
      `${p.common} is ${(share * 100).toFixed(1)}% flower against a declared `
      + `${(want * 100).toFixed(1)}% — the count is no longer derived from the cover`);
  }
});

test("blossom scales with the plant, instead of hitting a ceiling", () => {
  // The half a share-based assertion cannot see: with BOTH clamps pinned, a 1 m
  // shrub and a 6 m tree get the same 13,000 heads at the same 2 cm. Growing a
  // plant must grow its blossom with it.
  //
  // (Asserting merely that the five species' bloom AREAS differ from one another
  // checks nothing: the per-species cluster sizes make the areas differ no
  // matter what sets the count, so it passes with a clamped count. Verified by
  // mutation, which is the only way that gets found.)
  const spec = bloomUnit({ species: "Ceanothus spp." });
  const one = bloomOn({ mature_height_m: 1.5, mature_spread_m: 1.5, species: "Ceanothus spp." });
  const two = bloomOn({ mature_height_m: 3.0, mature_spread_m: 3.0, species: "Ceanothus spp." });
  const grew = two.area / one.area;
  assert.ok(grew > 2.5,
    `doubling the plant multiplied its blossom by only ${grew.toFixed(2)}x — the `
    + "count is capped rather than derived, so every big shrub gets the same "
    + "blossom as every small one");
  assert.ok(Math.abs(one.share - spec.cover) < 0.03 && Math.abs(two.share - spec.cover) < 0.03,
    "and the SHARE must stay put while the area grows — that is what makes it a "
    + "property of the species rather than of the size");
});

test("blossom follows the photographs, not the plant's size", () => {
  // An olive is the BIGGEST of the five and the least flowery, so any rule that
  // scales blossom with size — which is what a clamped formula degenerates to
  // — gets this pair backwards.
  const by = Object.fromEntries(plantsOf().map(p => [p.common, bloomOn(p)]));
  assert.ok(by["Olive"].share < by["California lilac"].share / 10,
    `an olive is ${(by["Olive"].share * 100).toFixed(1)}% flower against a `
    + `ceanothus at ${(by["California lilac"].share * 100).toFixed(1)}% — `
    + "refphotos/olea_europaea_fruitless.jpg has no visible flower in it");
  assert.ok(by["Olive"].area < by["California lilac"].area,
    "the olive is the largest of the five and must still carry the least flower");
  assert.ok(by["Manzanita"].share < by["California lilac"].share / 2,
    "refphotos/arctostaphylos_spp.jpg is dominated by glossy green leaf with "
    + "small racemes at the tips; a manzanita is not half flower");
});

test("a species with no entry still gets a sane default, not zero and not a snowstorm", () => {
  const made_up = { species: "Nothingia inventa", common: "Test plant",
                    mature_height_m: 2.0, mature_spread_m: 2.0 };
  const spec = bloomUnit(made_up);
  assert.ok(spec.cover > 0.02 && spec.cover < 0.35, `default cover is ${spec.cover}`);
  const { share } = bloomOn(made_up);
  assert.ok(Math.abs(share - spec.cover) < 0.03);
});

test("the count is DERIVED, so the geometry's cost cannot silently change it", () => {
  // The property that makes the table trustworthy: n is whatever hits the cover,
  // measured against one real unit's own area. So a bigger unit means fewer of
  // them and the same amount of flower — which is what stops a future session
  // "tuning" the sphere segments and changing how flowery the garden looks.
  const p = palette.plants.find(x => x.species === "Ceanothus spp.");
  const base = bloomUnit(p);
  const asset = fakeAsset(p.mature_height_m, p.mature_spread_m);
  const shell = ellipsoidArea(p.mature_spread_m / 2, p.mature_height_m * 0.5 * 0.55,
                              p.mature_spread_m / 2);
  const shareWith = (spec) => {
    const m = assetBlooms(asset, p.mature_spread_m, rng, spec);
    const a = m ? geomTriangleArea(m.geometry) : 0;
    return a / (a + shell);
  };
  const small = shareWith({ ...base, unit: base.unit * 0.5 });
  const big = shareWith({ ...base, unit: base.unit * 2 });
  assert.ok(Math.abs(small - big) < 0.04,
    `halving and doubling the cluster size changed the flower share from `
    + `${(small * 100).toFixed(1)}% to ${(big * 100).toFixed(1)}% — the count is `
    + "not being derived from the cover, so the table no longer means anything");
});
