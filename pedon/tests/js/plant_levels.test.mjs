// node --test tests/js/plant_levels.test.mjs
//
// A Fast frame of a full planting is bound by plant TRIANGLES, not pixels (measured from a saved
// view: 51 of a frame's 57 ms of GPU time). Two things answer it, and this holds both to what
// they claim:
//   - parts under half a millimetre across (a deer grass's pedicels, batched with its culms) are
//     thinned like fine wood, and every piece that can be seen is kept;
//   - a layer of many small parts has coarser LEVELS (plant_lod.js) — a quarter of its parts,
//     each four times the area — shown only where the enlarged part is still under a pixel.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../viewer/node_modules/three/build/three.module.js";
import { needsLibrary } from "./lib/library.mjs";   // about the user's library: skips without one

globalThis.document = { createElement() { return { width: 1, height: 1, getContext: () =>
  new Proxy({ measureText: () => ({ width: 12 }) }, { get: (o, k) => o[k] ?? (String(k).startsWith("create") ? () => ({ addColorStop() {} }) : () => {}) }) }; } };

const { buildPlant, fastModelKey } = await import("../../viewer/src/plants.js");
const { prepareSimplifier, SUBVISIBLE_M, FINE_WOOD_MAX } = await import("../../viewer/src/preview_lod.js");
const { layerLevels, addPlantLevels, updatePlantLevels, plantLevels, LEVEL_MAX_PX } = await import("../../viewer/src/plant_lod.js");
await prepareSimplifier();

const pieces = (g, name) => { const out = []; g.traverse(o => { if (o.isInstancedMesh && o.name === name) out.push(o); }); return out; };
function widths(meshes) {
  const w = [];
  for (const o of meshes) {
    o.geometry.computeBoundingBox();
    const b = o.geometry.boundingBox, across = Math.min(b.max.x - b.min.x, b.max.z - b.min.z), a = o.instanceMatrix.array;
    for (let i = 0; i < o.count; i++)
      w.push(across * Math.min(Math.hypot(a[i * 16], a[i * 16 + 1], a[i * 16 + 2]), Math.hypot(a[i * 16 + 8], a[i * 16 + 9], a[i * 16 + 10])));
  }
  return w;
}

test("a deer grass in flower keeps every culm piece that can be seen, and not 100 k it cannot", needsLibrary, () => {
  const p = { id: "dg", species: "Muhlenbergia rigens", common: "Deer grass", position: [0, 0],
              mature_height_m: 0.91, mature_spread_m: 1.22, form: "grass", flower: "#b5a77e" };
  const fast = buildPlant(p, { quality: "fast" });
  const full = buildPlant({ ...p, id: fastModelKey(p) }, { quality: "detailed" });
  const wf = widths(pieces(fast, "culms")), wd = widths(pieces(full, "culms"));
  const seenFull = wd.filter(w => w >= SUBVISIBLE_M).length, seenFast = wf.filter(w => w >= SUBVISIBLE_M).length;
  assert.ok(wd.length > 20000, `the fixture is not flowering (${wd.length} culm pieces)`);
  assert.ok(seenFull > 500, "no visible culm pieces in the fixture");
  assert.equal(seenFast, seenFull, "a culm piece that can be seen was dropped");
  assert.ok(wf.length <= Math.max(seenFull, FINE_WOOD_MAX) + 1, `${wf.length} culm pieces drawn — the sub-pixel ones were not thinned`);
});

// ---- levels --------------------------------------------------------------------------------
function layer(n, size, name = "foliage") {
  const o = new THREE.InstancedMesh(new THREE.BoxGeometry(...size), new THREE.MeshStandardMaterial(), n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion();
  for (let i = 0; i < n; i++) {
    q.setFromEuler(new THREE.Euler(i * 0.37, i * 1.3, i * 0.11));
    m.compose(new THREE.Vector3(Math.sin(i) * 0.3, (i % 50) / 100, Math.cos(i * 1.7) * 0.3), q, new THREE.Vector3(1, 1, 1));
    o.setMatrixAt(i, m);
  }
  o.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(0.5), 3);
  o.name = name;
  return o;
}
const area = (o, L) => {                         // total in-plane area of the parts, by the matrices
  const a = L ? L.matrices : o.instanceMatrix.array, n = L ? L.count : o.count;
  o.geometry.computeBoundingBox();
  const s = o.geometry.boundingBox.getSize(new THREE.Vector3()).toArray();
  const ax = [0, 1, 2].sort((x, y) => s[x] - s[y]);
  let t = 0;
  for (let i = 0; i < n; i++) {
    const len = c => Math.hypot(a[i * 16 + c * 4], a[i * 16 + c * 4 + 1], a[i * 16 + c * 4 + 2]);
    t += s[ax[1]] * len(ax[1]) * s[ax[2]] * len(ax[2]);
  }
  return t;
};

for (const [kind, size] of [["blades", [0.003, 0.4, 0.0005]], ["leaves", [0.02, 0.03, 0.001]]]) {
  test(`${kind}: a level keeps the layer's area — fewer parts, each bigger, in the same places`, () => {
    const o = layer(4000, size);
    const levels = layerLevels(o);
    assert.equal(levels.length, 2);
    const full = area(o);
    for (const L of levels) {
      assert.ok(Math.abs(L.count - 4000 / L.every) < 4000 / L.every * 0.15, `level 1/${L.every} kept ${L.count}`);
      const got = area(o, L);
      assert.ok(Math.abs(got / full - 1) < 0.15, `level 1/${L.every}: ${(got / full * 100).toFixed(0)}% of the area`);
      // every kept part stands where one of the originals stood
      const places = new Set(); for (let i = 0; i < o.count; i++) places.add(o.instanceMatrix.array.slice(i * 16 + 12, i * 16 + 15).join());
      for (let j = 0; j < L.count; j++) assert.ok(places.has(L.matrices.slice(j * 16 + 12, j * 16 + 15).join()), "a part moved");
    }
    // the same parts on every load: a twin layer (a fresh load of the same plant) keeps the same ones
    const twin = layer(4000, size);
    layerLevels(twin).forEach((L, k) => assert.ok(Buffer.from(L.matrices.buffer).equals(Buffer.from(levels[k].matrices.buffer)),
      "a different choice of parts on another load"));
  });
}

test("a layer shows a level only where its enlarged part is under a pixel", () => {
  const root = new THREE.Group();
  const plant = new THREE.Group();
  plant.userData.fastIndividual = "0";
  plant.add(layer(2000, [0.003, 0.4, 0.0005]));
  root.add(plant);
  const plants = addPlantLevels(root);
  assert.equal(plants.length, 1);
  const [L1, L2] = layerLevels(plant.children[0]);
  const cam = new THREE.PerspectiveCamera(50, 1.5, 0.1, 500), high = 900;
  const focal = high / (2 * Math.tan(THREE.MathUtils.degToRad(25)));
  const at = d => { cam.position.set(0, 0, d); cam.updateMatrixWorld(); updatePlantLevels(plants, cam, high); return plantLevels(plant)[0].level; };
  const d1 = L1.width * focal / LEVEL_MAX_PX, d2 = L2.width * focal / LEVEL_MAX_PX;
  assert.equal(at(d1 * 0.9), 0, "a level shown where its part would be wider than a pixel");
  assert.equal(at(d1 * 1.1), 1);
  assert.equal(at(d2 * 1.1), 2);
  // only one level of a layer is drawn at a time, and off means the plant as generated
  const shown = () => plant.children.filter(m => m.visible).length;
  assert.equal(shown(), 1);
  updatePlantLevels(plants, cam, high, false);
  assert.equal(plantLevels(plant)[0].level, 0);
  assert.equal(shown(), 1);
});

test("levels ride beside the plant, not in it: a Fast plant from buildPlant has none, and a leveled one still clones", needsLibrary, () => {
  const p = { id: "lv", species: "Muhlenbergia rigens", common: "Deer grass", position: [0, 0],
              mature_height_m: 0.91, mature_spread_m: 1.22, form: "grass", flower: "#b5a77e" };
  const g = buildPlant(p, { quality: "fast" });
  let before = 0; g.traverse(o => { if (o.isMesh) before++; });
  const root = new THREE.Group(); root.add(g);
  const plants = addPlantLevels(root);
  assert.equal(plants.length, 1, "a Fast plant got no levels");
  let after = 0, hidden = 0, sharing = 0;
  g.traverse(o => { if (o.isMesh) { after++; if (!o.visible) hidden++; } });
  g.traverse(o => { if (o.userData.levelOf) { const src = o.parent.children.find(x => x.name === o.name && !x.userData.levelOf);
    if (src && src.geometry === o.geometry && src.material === o.material) sharing++; } });
  assert.ok(after > before && hidden === after - before, "levels are drawn before a camera asks for them");
  assert.equal(sharing, after - before, "a level does not share its layer's geometry and material");
  // not in userData: every clone copies userData as JSON, and a mesh there is serialised whole
  const holdsObject = (v, depth = 0) => !!v && typeof v === "object" && depth < 6
    && (v.isObject3D || Object.values(v).some(x => holdsObject(x, depth + 1)));
  let inUserData = false; g.traverse(o => { inUserData ||= holdsObject(o.userData); });
  assert.ok(!inUserData, "the levels ride in userData");
  assert.doesNotThrow(() => g.clone(), "a plant with levels cannot be copied");
  assert.equal(addPlantLevels(root).length, 1);
  let again = 0; g.traverse(o => { if (o.isMesh) again++; });
  assert.equal(again, after, "levels added twice");
});

// ---- the generic leaf shell -----------------------------------------------------------
test("a Fast leaf shell under its cap keeps the plant's leaf area — no dark cores showing through", () => {
  // capped at 1,500 true-size leaves over a mound that 13,000 close, a common thyme draws as dark balls
  // every merged foliage mesh: the leaf shell, and the masses under it (the same in both modes)
  const area = g => { let a = 0; g.traverse(o => { if (o.isMesh && !o.isInstancedMesh && o.name === "foliage") {
    const p = o.geometry.attributes.position, idx = o.geometry.index, v = [0, 1, 2].map(() => new THREE.Vector3());
    const tri = t => idx ? [idx.getX(t * 3), idx.getX(t * 3 + 1), idx.getX(t * 3 + 2)] : [t * 3, t * 3 + 1, t * 3 + 2];
    const n = (idx ? idx.count : p.count) / 3;
    for (let t = 0; t < n; t++) { tri(t).forEach((k, j) => v[j].fromBufferAttribute(p, k));
      a += v[1].clone().sub(v[0]).cross(v[2].clone().sub(v[0])).length() / 2; } } }); return a; };
  const p = { id: "thyme", species: "Thymus vulgaris", common: "Common thyme", position: [0, 0],
              mature_height_m: 0.3, mature_spread_m: 0.6, form: "mat", foliage: "grey_green", flower: "#d2aec6" };
  const fast = buildPlant(p, { quality: "fast" });
  const full = buildPlant({ ...p, id: fastModelKey(p) }, { quality: "detailed" });
  const leaves = g => { let n = 0; g.traverse(o => { if (o.isMesh && o.name === "foliage") n = Math.max(n, (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3); }); return n; };
  assert.ok(leaves(fast) < leaves(full) / 2, "the fixture is not capped in Fast — the rule is untested");
  const ratio = area(fast) / area(full);
  assert.ok(ratio > 0.8 && ratio < 1.25, `Fast carries ${(ratio * 100).toFixed(0)}% of full detail's leaf area`);
});

test("a simplified leaf is lit by its own shape: its normals agree with its faces (or catnip draws black patches)", needsLibrary, () => {
  const p = { species: "Nepeta cataria", common: "Catnip", position: [0, 0], mature_height_m: 0.75,
              mature_spread_m: 0.6, form: "perennial", flower: "#efeae2" };
  const g = buildPlant(p, { quality: "fast" });
  let corners = 0, against = 0, simplified = 0;
  const seen = new Set(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  g.traverse(o => {
    if (!o.isInstancedMesh || !/foliage|undersides/.test(o.name) || seen.has(o.geometry)) return;
    seen.add(o.geometry);
    const P = o.geometry.attributes.position, N = o.geometry.attributes.normal, I = o.geometry.index;
    if ((I ? I.count : P.count) / 3 > 40) return;                  // not simplified
    simplified++;
    for (let t = 0; t < (I ? I.count : P.count) / 3; t++) {
      const k = [0, 1, 2].map(j => I ? I.getX(t * 3 + j) : t * 3 + j);
      a.fromBufferAttribute(P, k[0]); b.fromBufferAttribute(P, k[1]); c.fromBufferAttribute(P, k[2]);
      const face = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
      for (const v of k) { corners++; if (n.fromBufferAttribute(N, v).dot(face) < 0.3) against++; }
    }
  });
  assert.ok(simplified >= 4, `only ${simplified} simplified leaf shapes — the fixture does not test this`);
  assert.ok(against / corners < 0.05, `${(against / corners * 100).toFixed(0)}% of leaf corners lit against their face`);
});

