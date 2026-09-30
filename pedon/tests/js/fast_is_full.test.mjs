// node --test tests/js/fast_is_full.test.mjs
//
// FAST IS THE SAME PLANT AS FULL DETAIL, for every species that has its own builder. The
// photoreal builders are too heavy to draw as they are — a Ceanothus is 238 k leaves and 5.1 M
// florets — and an accurate, shared model is worth more than a generic shape that looks wrong.
// So Fast builds the same model and reduces it (preview_lod.js reduceBuilt). Sizes are measured
// to the millimetre: rounded to the centimetre, the agreement tool hides a 5.5% miss on deer grass.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../viewer/node_modules/three/build/three.module.js";
import { agreement } from "../../tools/preview_agreement.mjs";
import { buildPlant } from "../../viewer/src/plants.js";
import { prepareSimplifier, reduceBuilt, ribbonOf, FINE_WOOD_MAX, OVERLAY, DENSITIES } from "../../viewer/src/preview_lod.js";
import { setTextureDetail, textureDetail } from "../../viewer/src/plant_texture_loader.js";
import { needsLibrary } from "./lib/library.mjs";   // about the user's library: skips without one

await prepareSimplifier();

const plant = (species, h, w) => ({ id: species, species, common: species, position: [0, 0], mature_height_m: h, mature_spread_m: w });
// one species for each heavy builder, small enough to build quickly
// (small: this file is paid for in the suite's CPU budget — at larger sizes it costs 11.5 s)
const ONE_OF_EACH = [
  plant("Ceanothus spp.", 0.5, 0.6), plant("Ceanothus 'Ray Hartman'", 0.7, 0.7),
  plant("Ceanothus thyrsiflorus var. griseus 'Horizontalis'", 0.25, 0.6), plant("Baccharis pilularis", 0.5, 0.6),
  plant("Festuca 'Siskiyou Blue'", 0.45, 0.5), plant("Festuca californica", 0.6, 0.6), plant("Carex pansa", 0.25, 0.6),
  plant("Carex oshimensis 'Evergold'", 0.3, 0.45), plant("Calamagrostis foliosa", 0.5, 0.6),
  plant("Bidens 'Sun Drop Compact'", 0.23, 0.33), plant("Echeveria spp.", 0.24, 0.32), plant("Echeveria 'Doris Taylor'", 0.2, 0.2),
  plant("Eriogonum fasciculatum", 0.4, 0.5), plant("Eriogonum umbellatum", 0.3, 0.6),
  plant("Coleonema pulchellum 'Sunset Gold'", 0.4, 0.5), plant("Epilobium canum", 0.3, 0.4), plant("Coreopsis", 0.46, 0.54),
  plant("Cistus spp.", 0.6, 0.7), plant("Arctostaphylos 'Howard McMinn'", 0.7, 0.8),
];
const rows = agreement({ plants: ONE_OF_EACH });
// big enough that its leaves are carded — past what its budget can draw one by one (at 1 m a
// Ceanothus draws its own leaves); built once, Fast caches it
const CARDED = plant("Ceanothus spp.", 1.5, 2.0);

for (const r of rows) {
  test(`${r.species}: Fast is its own builder, reduced — the same size, and cheaper`, needsLibrary, () => {
    assert.notEqual(r.full_builder, "generic", "the fixture reaches no builder");
    assert.equal(r.fast_builder, r.full_builder, "Fast drew a different plant");
    assert.ok(Math.abs(r.h_err) <= 5 && Math.abs(r.w_err) <= 5,
      `Fast is ${r.h_err}% in height and ${r.w_err}% in width off full detail`);
    assert.ok(r.fast.tris * 3 <= r.full.tris, `Fast ${r.fast.tris} triangles against ${r.full.tris} at full`);
  });
}

test("what lies on a leaf goes, and fine wood keeps its thickest", needsLibrary, () => {
  const g = buildPlant(CARDED, { quality: "fast" });
  let twigs = 0, cards = null;
  g.traverse(o => {
    if (!o.isMesh) return;
    assert.ok(!OVERLAY.test(o.name), `${o.name} is still drawn under the cards`);
    if (o.name === "twigs and petioles") twigs += o.count;
    if (o.name === "leaf cards") cards = o;
  });
  assert.ok(twigs > 0 && twigs <= FINE_WOOD_MAX, `${twigs} twigs kept`);
  assert.ok(cards, "the leaves are not on cards — or not named as the shoot plants' are");
});

test("a copied leaf material is still that material — translucent", needsLibrary, () => {
  // Material.clone() drops onBeforeCompile: the cards and ribbons come out opaque and ~20% dark
  const g = buildPlant(CARDED, { quality: "fast" });
  const cards = g.getObjectByName("leaf cards");
  assert.ok(cards.material.userData.translucency, "the cards are not the leaf's material");
  // not "is onBeforeCompile a function" — every material has a default one, and that check
  // stays green with the translucency gone (seen by mutation)
  assert.match(String(cards.material.customProgramCacheKey()), /^translucent\|/, "the cards' material lost its translucency");
});

test("a sparse card is drawn at every distance, and shadows as its parts do", needsLibrary, () => {
  // shrunk for distance a sparse card averages to ~12% alpha, which 4x MSAA alpha-to-coverage
  // rounds to no samples at all: Sunset Gold's needles vanish into a haze. Hashed alpha keeps
  // the fraction; the shadow pass must hash the same picture or each card shadows as a solid quad.
  const g = buildPlant(CARDED, { quality: "fast" });
  const cards = g.getObjectByName("leaf cards"), depth = cards.customDepthMaterial;
  assert.equal(cards.material.alphaHash, true, "the cards' density is thresholded, not hashed");
  assert.ok(!cards.material.alphaToCoverage, "alpha-to-coverage rounds a sparse card away");
  assert.ok(depth?.alphaHash && depth.map === cards.material.map, "the cards shadow as solid quads");
});

/** A curled blade as builders make one: a grid, `v` along it, a top and an underside facing apart. */
function blade(S = 48, N = 6) {
  const P = [], UV = [], I = [];
  for (const side of [0, 1]) for (let i = 0; i <= S; i++) for (let j = 0; j <= N; j++) {
    const t = i / S, u = j / N - 0.5, a = t * 2.2;                        // arches over and down
    P.push(u * 0.004 * (1 - t), Math.sin(a) * 0.3 + (side ? -0.0004 : 0.0004), (1 - Math.cos(a)) * 0.3);
    UV.push(j / N, t);
  }
  const at = (side, i, j) => side * (S + 1) * (N + 1) + i * (N + 1) + j;
  for (const side of [0, 1]) for (let i = 0; i < S; i++) for (let j = 0; j < N; j++) {
    const q = [at(side, i, j), at(side, i + 1, j), at(side, i, j + 1), at(side, i + 1, j + 1)];
    I.push(...(side ? [q[0], q[2], q[1], q[1], q[2], q[3]] : [q[0], q[1], q[2], q[1], q[3], q[2]]));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(UV, 2));
  g.setIndex(I); g.computeVertexNormals();
  return g;
}

test("a blade's ribbon keeps its tip, and is lit by its own shape", () => {
  const src = blade(), r = ribbonOf(src, 8);
  assert.ok(r, "no ribbon for a blade whose v runs along it");
  src.computeBoundingBox(); r.computeBoundingBox();
  const a = src.boundingBox, b = r.boundingBox;
  assert.ok(Math.abs(b.max.z - a.max.z) < 0.01 && Math.abs(b.max.y - a.max.y) < 0.01,
    `the ribbon reaches ${b.max.toArray().map(x => x.toFixed(3))} where the blade reaches ${a.max.toArray().map(x => x.toFixed(3))}`);
  // the top's and the underside's normals cancel; averaged, they light Bidens 54% dark
  const n = r.attributes.normal, v = new THREE.Vector3();
  for (let i = 0; i < n.count; i++) assert.ok(Math.abs(v.fromBufferAttribute(n, i).length() - 1) < 1e-3, `normal ${i} is ${v.length().toFixed(3)} long`);
  assert.ok(r.attributes.position.count / 3 <= 16, `${r.attributes.position.count / 3} triangles for 8 segments`);
});

test("a card is as dense as the parts it stands for", () => {
  // n parts of area a over a card of area A cover 1 - e^(-n a / A); a made-up fade swings a
  // Ceanothus between 8% and 18% blue against full detail's 29%
  const leaf = new THREE.PlaneGeometry(0.02, 0.01).rotateX(-Math.PI / 2);
  leaf.setAttribute("color", new THREE.Float32BufferAttribute(new Array(leaf.attributes.position.count * 3).fill(1), 3));
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true });
  // 30,000: past what a 2 m plant's budget draws one by one (~8 triangles a leaf), so carded
  const n = 30000, mesh = new THREE.InstancedMesh(leaf, mat, n), m = new THREE.Matrix4();
  let k = 0;
  const put = (x, z, y) => mesh.setMatrixAt(k++, m.makeTranslation(x, y, z));
  for (let i = 0; i < 29000; i++) put(0.5 + Math.random() * 0.08, 0.5 + Math.random() * 0.08, 0.5);   // a dense clump
  for (let i = 0; i < 1000; i++) put(-2 + (i % 32) * 0.13, -2 + Math.floor(i / 32) * 0.13, 0.2);   // one to a cell
  mesh.name = "foliage";
  const g = new THREE.Group(); g.add(mesh);
  reduceBuilt(g, 2.0);
  const cards = g.getObjectByName("leaf cards");
  assert.ok(cards, "not carded");
  // the density is IN THE PICTURE: each card's uvs pick an atlas quadrant drawn at DENSITIES[k] —
  // as vertex alpha, the shadow pass never sees it and every card casts a solid oval
  const uv = cards.geometry.attributes.uv, levels = [];
  for (let i = 0; i < uv.count; i += 12) levels.push((uv.getX(i) > 0.5 ? 1 : 0) + (uv.getY(i) > 0.5 ? 2 : 0));
  assert.equal(Math.max(...levels), DENSITIES.length - 1, "the dense clump is not drawn at the densest picture");
  // a lone 2 x 1 cm leaf, half on each of its card's two quads, covers under a fifth of either:
  // drawn sparse, not solid (drawn on both, every leaf shows twice and canopies go solid)
  const lone = Math.min(...levels);
  assert.ok(DENSITIES[lone] <= 0.3, `a lone leaf's card is drawn at ${DENSITIES[lone]}`);
});

test("the fit is the plant's, decided on the full model", () => {
  // measured on its cards, Cistus crosses the fit tolerance and Fast alone is squeezed 11%
  const p = plant("Cistus spp.", 1.2, 1.5);
  const fast = buildPlant(p, { quality: "fast" }), full = buildPlant(p, { quality: "detailed" });
  assert.equal(fast.userData.fitToSpread ?? 1, full.userData.fitToSpread ?? 1);
});

test("a builder's texture is loaded again on every switch of detail", () => {
  // cached per size, full -> Fast -> full would never re-register the full texture
  setTextureDetail("detailed"); const a = textureDetail();
  setTextureDetail("fast");     const b = textureDetail();
  setTextureDetail("detailed"); const c = textureDetail();
  assert.notEqual(a, b); assert.notEqual(a, c); assert.notEqual(b, c);
  setTextureDetail("detailed"); assert.equal(textureDetail(), c, "asking for the same detail again reloaded it");
});

test("a card is lit as its leaves face, from either side", needsLibrary, () => {
  // shaded by its own plane, the upright quad is a wall and the flat one flips dark from
  // below: up close a manzanita draws in dark bands, 34 against full detail's 46
  const g = buildPlant(CARDED, { quality: "fast" });
  const cards = g.getObjectByName("leaf cards"), n = cards.geometry.attributes.normal;
  assert.equal(cards.material.side, THREE.FrontSide, "a two-sided card flips its lighting when seen from behind");
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  for (let card = 0; card < n.count; card += 24) {                 // two quads, both windings
    a.fromBufferAttribute(n, card);
    for (let i = card + 1; i < card + 24; i++)
      assert.ok(b.fromBufferAttribute(n, i).distanceTo(a) < 1e-6, `card ${card / 24}: its quads are lit as different things`);
  }
});
