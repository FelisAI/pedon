// node --test tests/js/plant_forms.test.mjs
//
// 52 plants, 3 silhouettes.
//
// Measured on a real site's plant list: with a catch-all "mound" rule, 44 of 52
// species land on that single growth form — every Salvia, the rush, the yarrow,
// the toyon, and the entire fall-seeded wildflower list. `mound` and `mat` both
// build from shrubMasses, so a deer grass, a buckwheat, a poppy drift and a
// manzanita would draw as the same clustered blobs at different sizes.
//
// Planting like that reads as undifferentiated however well it is massed, and no
// amount of Blender fixes it: Sapling makes woody things, and a rush is not
// woody. So there are more procedural forms and a routing table that reaches
// them.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
globalThis.document = { createElement: () => ({ width: 0, height: 0,
  getContext: () => ({ fillRect() {}, fillText() {}, beginPath() {}, arc() {}, fill() {},
                       stroke() {}, createLinearGradient: () => ({ addColorStop() {} }),
                       createRadialGradient: () => ({ addColorStop() {} }) }) }) };
const plants = await import(path.join(ROOT, "viewer", "src", "plants.js"));

const LIST = [
  ["Arctostaphylos 'Emerald Carpet'", "mat"],
  ["Baccharis pilularis 'Pigeon Point'", "mat"],
  ["Thymus vulgaris", "mound"],
  ["Fragaria chiloensis", "mat"],
  ["Muhlenbergia rigens", "grass"],
  ["Festuca californica", "grass"],
  ["Carex oshimensis 'Evergold'", "grass"],
  ["Juncus patens", "rush"],
  ["Salvia clevelandii", "mound"],
  // Salvia is where a mound rule is greediest — it would claim every one of
  // the eleven in the palette except the chia — and a
  // Mediterranean scheme is built out of contrasting habits, not out of eleven
  // domes. The upright border spike, the grey carpet and the shade-tolerant
  // runner are three different plants and three different silhouettes.
  ["Salvia nemorosa 'Caradonna'", "perennial"],
  ["Salvia argentea", "perennial"],
  ["Salvia spathacea", "perennial"],
  ["Salvia 'Bee's Bliss'", "mat"],
  ["Salvia leucantha", "mound"],
  ["Salvia mellifera", "mound"],
  ["Eriogonum fasciculatum", "mound"],
  ["Cistus purpureus", "mound"],
  ["Achillea millefolium", "perennial"],
  ["Erigeron glaucus", "perennial"],
  ["Penstemon heterophyllus", "perennial"],
  ["Heuchera maxima", "perennial"],
  ["Eschscholzia californica", "meadow"],
  ["Layia platyglossa", "meadow"],
  ["Lupinus succulentus", "meadow"],
  ["Phormium tenax", "strap"],
  ["Sisyrinchium bellum", "strap"],
];

test("the fixture really is the hard case", () => {
  assert.ok(LIST.length >= 20);
  assert.ok(new Set(LIST.map(([, f]) => f)).size >= 6,
    "if the fixture only expects two forms it cannot detect a collapse into one");
});

test("no form swallows more than a third of the list", () => {
  const tally = {};
  for (const [sp] of LIST) {
    const f = plants.growthForm({ species: sp, common: "", mature_height_m: 0.9 });
    tally[f] = (tally[f] ?? 0) + 1;
  }
  const [worst, n] = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  assert.ok(n <= Math.ceil(LIST.length / 3),
    `"${worst}" takes ${n}/${LIST.length} — planting will read as one repeated shape. ` +
    `Tally: ${JSON.stringify(tally)}`);
});

for (const [species, want] of LIST) {
  test(`${species} -> ${want}`, () => {
    const got = plants.growthForm({ species, common: "", mature_height_m: 0.9 });
    assert.equal(got, want);
  });
}

test("every form the table can emit actually builds geometry", () => {
  const forms = new Set(LIST.map(([, f]) => f));
  for (const f of forms) {
    const m = plants.buildPlant({ id: "x", species: "test", form: f,
                                  mature_height_m: 0.9, mature_spread_m: 0.8 });
    let verts = 0;
    m.traverse(o => { verts += o.geometry?.attributes?.position?.count ?? 0; });
    assert.ok(verts > 30, `form "${f}" produced ${verts} vertices — no shape of its own`);
  }
});

// ── the strap fan: a fountain, not a whorl or a plank column ────────
//
// Three separate defects can live here at once, and all three are invisible in
// every number the project measures — they need somebody to look at a flax.

const strap = (h, spread, id) => plants.buildPlant({
  id, species: "Phormium", common: "New Zealand flax", form: "strap",
  foliage: "#7a5f62", flower: "#c04a3a",
  mature_height_m: h, mature_spread_m: spread, position: [0, 0] });

/** Every foliage vertex of a plant, as [x, y, z]. */
const verts = (grp) => {
  const out = [];
  grp.traverse(o => {
    if (!o.isMesh || o.name !== "foliage") return;
    const p = o.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) out.push([p.getX(i), p.getY(i), p.getZ(i)]);
  });
  return out;
};

test("a strap plant's blades arch OUTWARD, not sideways", () => {
  // rotateY(a) carries a blade's local +Z — the way its tip curves — to
  // (sin a, 0, cos a); a base placed at (cos a, 0, sin a) is ninety degrees
  // apart, so every blade curves AROUND the clump instead of away from it, and a
  // Phormium reads as a whorl rather than a fountain.
  //
  // This has to be measured PER BLADE. Comparing the plant's radius high up
  // against its radius at the base passes with the bug present: aggregate
  // radius barely moves (0.963 m against 0.915 m),
  // because a tangential arch still carries the tip away from the axis, just not
  // in its own direction. Blades are 30 consecutive vertices in the merged,
  // de-indexed mesh, so each one can be checked against its OWN radius.
  const v = verts(strap(1.5, 1.5, "flax-arch"));
  assert.ok(v.length > 300, `only ${v.length} vertices — the fan is a stub again`);
  let sum = 0, n = 0;
  for (let k = 0; k + 30 <= v.length; k += 30) {
    const b = v.slice(k, k + 30);
    const lo = b.reduce((m, q) => (q[1] < m[1] ? q : m));
    const hi = b.reduce((m, q) => (q[1] > m[1] ? q : m));
    const br = Math.hypot(lo[0], lo[2]);
    if (br < 1e-4) continue;
    const dx = hi[0] - lo[0], dz = hi[2] - lo[2];
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) continue;
    sum += (dx * (lo[0] / br) + dz * (lo[2] / br)) / len;   // 1 out, 0 sideways
    n++;
  }
  assert.ok(n > 10, `only ${n} blades resolved — the 30-vertex grouping is stale`);
  const aligned = sum / n;
  // measured: 0.975 pointing outward, -0.01 with the axes swapped
  assert.ok(aligned > 0.75,
    `blade tips run ${aligned.toFixed(2)} along their own radius (1 = straight out, `
    + "0 = sideways) — the arch is rotated off the radial direction");
});

test("a big strap plant is not a stub, and a small one is not a thicket", () => {
  // A fixed 11-15 blades whatever the size makes a 1.5 m Phormium 100 triangles.
  // FOLIAGE only. Counting the whole plant hides the effect, because a small
  // strap also grows flowers and a big one does not — 1234 against 1162, which
  // reads as "no scaling" when the blades really go 41 to 17.
  const big = verts(strap(1.5, 1.5, "flax-big")).length;
  const small = verts(strap(0.3, 0.3, "sis-small")).length;
  assert.ok(big > small * 1.5,
    `a 1.5 m flax has ${big} blade vertices against a 0.3 m plant's ${small} — `
    + "blade count is not following size, so one of them is wrong");
  // 40,000. The blade COUNT is derived from coverage rather than clamped at 74,
  // because clamped straps measure 0.35-0.55 of their own silhouette against
  // the 1.0-2.4 the forms that read correctly occupy — a fan you can see
  // straight through. 8,670 vertices is 2,890 triangles for the most
  // architectural plant in the palette, and fidelity is worth a slower render,
  // so this is a TRIPWIRE against an explosion, not a budget.
  assert.ok(big < 40000, `${big} vertices for one flax`);
});

test("the blades do not merge into a column at the base", () => {
  // 41 blades 8 cm wide through a 9 cm base ring is an opaque cylinder, and the
  // flax renders as a tree trunk with leaves stuck in the top. The base ring has
  // to be wide enough to SEAT the blades side by side.
  //
  // Measured on the base radius, not on a circumference-versus-blade-count sum:
  // counting "blades" as vertices/12 in a height band is not how many blades
  // pass through that band, and passes with the bug present. Base radius
  // separates cleanly — 0.248 m correct against
  // 0.102 m with the ring capped.
  const v = verts(strap(1.5, 1.5, "flax-ring")).filter(q => q[1] < 0.12);
  assert.ok(v.length > 0, "no foliage near the ground at all");
  const r = Math.max(...v.map(q => Math.hypot(q[0], q[2])));
  assert.ok(r > 1.5 * 0.09,
    `the fan is ${r.toFixed(2)} m across at the ground for a 1.5 m clump — too `
    + "tight to seat its own blades, so they merge into a solid wall");
});

test("a small strap plant flowers and a large one does not", () => {
  // Sisyrinchium is NAMED for its flower; a strap form that emits none draws the
  // one plant in the palette whose identity is its bloom as a green fan.
  // A Phormium's inflorescence is a 3 m panicle, which is a different object.
  const bloomTris = (g) => { let n = 0;
    g.traverse(o => { if (o.isMesh && o.name === "bloom")
      n += o.geometry.index ? o.geometry.index.count / 3
                            : o.geometry.attributes.position.count / 3; });
    return n; };
  const sis = plants.buildPlant({ id: "sis", species: "Sisyrinchium",
    common: "Blue-eyed grass", form: "strap", foliage: "#6f8f6a", flower: "#4a6fd0",
    mature_height_m: 0.3, mature_spread_m: 0.3, position: [0, 0] });
  assert.ok(bloomTris(sis) > 0, "blue-eyed grass has no flower");
  assert.equal(bloomTris(strap(1.5, 1.5, "flax-bloom")), 0,
    "a 1.5 m flax grew the small-strap flower, which is not its inflorescence");
});
