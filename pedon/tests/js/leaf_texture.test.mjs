// node --test tests/js/
//
// Plants should look photoreal, not like simple 3D models.
//
// Sound geometry is not enough, and the reason is one line: WITHOUT A TEXTURE,
// every leaf, every grass blade, every flower is a flat-shaded untextured
// polygon, so foliage is a field of little green lozenges.
//
// The jump that costs nothing in assets is an ALPHA-MASKED leaf: the card stops
// being a rectangle and becomes a leaf shape, with veining and an edge that is
// not straight. It is generated in a canvas, so there is nothing to buy, no key,
// and nothing to download — which is the standing constraint here.
//
// Headless note: these tests run in node with a stub canvas, so the generator
// must not ASSUME a real 2D context. contactShadowTexture already survives that,
// and this follows the same shape.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "../../viewer/node_modules/three/build/three.module.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// A canvas stub that RECORDS, so a test can tell a real drawing from a no-op —
// the same trick design.test.mjs uses to read back a painted surface.
const ops = [];
globalThis.document = {
  createElement() {
    const ctx = new Proxy({}, {
      get(_, k) {
        if (k === "canvas") return { width: 128, height: 128 };
        return (...args) => { ops.push({ fn: String(k), args }); return ctx; };
      },
      set() { return true; },
    });
    return { width: 0, height: 0, getContext: () => ctx };
  },
};
const plants = await import(path.join(ROOT, "viewer", "src", "plants.js"));

test("there is a leaf texture at all", () => {
  assert.equal(typeof plants.leafTexture, "function",
    "nothing generates a leaf image — every leaf is still a flat quad");
  const t = plants.leafTexture("medium");
  assert.ok(t, "leafTexture returned nothing");
});

test("it DRAWS something — a blank mask is a rectangle with extra steps", () => {
  ops.length = 0;
  plants.leafTexture("small");
  const drew = ops.filter(o => /fill|arc|bezier|quadratic|lineTo|moveTo|ellipse|stroke/.test(o.fn));
  assert.ok(drew.length > 3,
    `only ${drew.length} drawing calls — the mask is empty, so the card stays a rectangle`);
});

test("a needle and a broad leaf are not the same picture", () => {
  // rosemary and manzanita are different plants and the mask is where that lives
  const shapes = {};
  for (const cls of ["needle", "small", "medium", "large", "filigree"]) {
    ops.length = 0;
    plants.leafTexture(cls);
    shapes[cls] = ops.filter(o => /fill|arc|bezier|quadratic|lineTo|ellipse/.test(o.fn)).length;
  }
  const uniq = new Set(Object.values(shapes));
  assert.ok(uniq.size > 1,
    `every leaf class draws the identical mask (${JSON.stringify(shapes)})`);
});

test("the same class is generated ONCE, not per plant", () => {
  // 114 plants x hundreds of cards: a texture per card would melt the tab
  const a = plants.leafTexture("medium");
  const b = plants.leafTexture("medium");
  assert.equal(a, b, "leafTexture is not cached — this is per-plant canvas work");
});

test("legacy masked foliage cards carry the mask and the solid core does not", () => {
  // As one merged mesh, masking would cut leaf-shaped holes
  // straight through the core, because an icosahedron's UVs are spherical and
  // sample the mask arbitrarily — so the split is the point, not a detail.
  // Use the explicit fallback: catalog taxa can graduate to solid botanical leaves.
  const p = { id: "m", species: "Legacy mask test shrub", form: "mound", foliage: "#7f8f7a",
              mature_height_m: 2.0, mature_spread_m: 2.0, position: [0, 0] };
  const masked = [], plain = [];
  plants.buildPlant(p).traverse(n => {
    if (!n.isMesh || n.name !== "foliage") return;
    (n.material.alphaMap ? masked : plain).push(n);
  });
  assert.ok(masked.length, "no foliage mesh carries the leaf mask");
  assert.ok(plain.length, "the solid masses are gone, or they are being masked too");
  const m = masked[0].material;
  assert.ok(m.alphaTest > 0, "the mask is loaded and not applied — cards stay rectangles");
  assert.equal(m.transparent, false,
    "blended rather than alpha-tested: thousands of overlapping cards would need "
    + "per-frame sorting, which is what makes a foliage scene crawl");
  assert.equal(m.side, THREE.DoubleSide, "a leaf seen from behind disappears");
  // and the cards are the bulk of it, or the core is still the silhouette
  const cards = masked.reduce((n, x) => n + x.geometry.attributes.position.count, 0);
  const core = plain.reduce((n, x) => n + x.geometry.attributes.position.count, 0);
  assert.ok(cards > core * 3,
    `${cards} card vertices against ${core} of core — the leaves are a trim on a pillow`);
});

test("it still builds with no usable canvas, because the tests have none", () => {
  // and so does a browser that refuses a context. A picker that throws is worse
  // than a picker with flat leaves.
  // The caches must be cleared FIRST or this passes for the wrong reason: both
  // textures are memoised, so a previous test having built them means the
  // no-context path never runs, and this passes even while
  // contactShadowTexture throws on a null context.
  const saved = globalThis.document;
  globalThis.document = { createElement() { return { getContext: () => null }; } };
  try {
    plants.forgetLeafTextures?.();
    plants.forgetShadowTexture?.();
    const p = { id: "z", species: "Salvia greggii", form: "mound", foliage: "#5f7a52",
                mature_height_m: 0.9, mature_spread_m: 0.9, position: [0, 0] };
    const built = plants.buildPlant(p);
    assert.ok(built, "buildPlant threw when no 2D context was available");
  } finally {
    globalThis.document = saved;
    plants.forgetLeafTextures?.();
  }
});
