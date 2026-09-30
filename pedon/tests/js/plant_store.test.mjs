// node --test tests/js/plant_store.test.mjs
//
// A Fast plant is generated once per KIND, in a few individuals, and kept — in memory and
// in the browser's IndexedDB — so a page load reads it back instead of generating it again.
// What this holds to:
//   - what is read back IS what was generated: every object, array, material setting and
//     picture, compared field by field (a kept plant that draws differently is a wrong plant
//     that survives every reload);
//   - a plant is one of FAST_VARIANTS individuals of its kind, generated from the kind's seed,
//     so the individual does not depend on which plant happened to be built first;
//   - an individual shares its kind's geometry and instance arrays and owns its materials —
//     with shared materials, selecting one lights no plant;
//   - the store's version moves with the plant code and nothing else.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "../../viewer/node_modules/three/build/three.module.js";
import { needsLibrary } from "./lib/library.mjs";   // about the user's library: skips without one

// A 2D canvas that keeps its pixels: every picture a builder draws is a distinct pattern here, so
// a picture that comes back as another plant's, or not at all, is a failed comparison
let canvases = 0;
class FakeCanvas {
  constructor() { this.width = 64; this.height = 64; this.serial = canvases++; this.pixels = null; }
  getContext(kind) {
    if (kind !== "2d") return null;
    const c = this;
    const px = () => {
      if (!c.pixels || c.pixels.length !== c.width * c.height * 4) {
        c.pixels = new Uint8ClampedArray(c.width * c.height * 4);
        let s = (c.serial + 1) * 2654435761 >>> 0;
        for (let i = 0; i < c.pixels.length; i++) { s = Math.imul(s ^ (s >>> 13), 1103515245) + 12345 >>> 0; c.pixels[i] = s >>> 24; }
      }
      return c.pixels;
    };
    return new Proxy({
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(px()), width: w, height: h }),
      putImageData: img => { c.pixels = new Uint8ClampedArray(img.data); },
      measureText: () => ({ width: 12 }),
    }, { get: (o, k) => o[k] ?? (String(k).startsWith("create") ? () => ({ addColorStop() {} }) : () => {}), set: () => true });
  }
}
globalThis.HTMLCanvasElement = FakeCanvas;
globalThis.ImageData = class { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } };
globalThis.document = { createElement: () => new FakeCanvas() };

const { buildPlant, fastModelKey, FAST_VARIANTS, builderName } = await import("../../viewer/src/plants.js");
const { packModel, unpackModel, keptModel, forgetModels, keepModel } = await import("../../viewer/src/plant_store.js");
const { plantCodeVersion } = await import("../../viewer/plant_version.js");

const plant = (species, common, h, w, form, extra = {}) =>
  ({ id: `${common}-1`, species, common, position: [0, 0], mature_height_m: h, mature_spread_m: w, form, ...extra });
// one of each way Fast is made: the stand-in builders, a shoot plant's leaf cards, a reduced
// photoreal builder, the bunchgrass, and the generic forms
const KINDS = [
  plant("Agastache 'Rosie Posie'", "Rosie Posie", 0.6, 0.6, "perennial", { flower: "#d0619a" }),
  plant("Salvia rosmarinus", "Rosemary", 1.2, 1.2, "mound"),
  plant("Stachys byzantina", "Lamb's ear", 0.45, 0.6, "mat", { flower: "#b58fb5" }),
  plant("Muhlenbergia rigens", "Deer grass", 1.2, 1.2, "grass", { flower: "#b5a77e" }),
  plant("Muhlenbergia capillaris", "Pink muhly", 0.9, 0.9, "grass"),
  plant("Epilobium canum", "California fuchsia", 0.5, 0.9, "perennial"),
  plant("Xxx yyy", "a mound nobody knows", 1.0, 1.2, "mound"),
];

const master = p => keptModel(fastModelKey(p));

// ---- the comparison: everything a renderer reads -------------------------------------------
const TEX = ["name", "mapping", "channel", "wrapS", "wrapT", "format", "internalFormat", "type", "colorSpace",
  "minFilter", "magFilter", "anisotropy", "flipY", "generateMipmaps", "premultiplyAlpha", "unpackAlignment", "rotation"];
function sameTexture(a, b, where) {
  for (const k of TEX) assert.deepEqual(b[k], a[k], `${where}.${k}`);
  for (const k of ["repeat", "offset", "center"]) assert.ok(b[k].equals(a[k]), `${where}.${k}`);
  assert.deepEqual(b.userData, a.userData, `${where}.userData`);
  const pa = a.image.getContext("2d").getImageData(0, 0, a.image.width, a.image.height).data;
  const pb = b.image.getContext("2d").getImageData(0, 0, b.image.width, b.image.height).data;
  assert.equal(b.image.width, a.image.width, `${where} width`);
  assert.ok(Buffer.from(pa.buffer).equals(Buffer.from(pb.buffer)), `${where}: a different picture`);
}
function sameMaterial(a, b, where) {
  assert.equal(b.type, a.type, `${where}.type`);
  for (const k of Object.keys(a)) {
    if (["uuid", "id", "version", "_listeners"].includes(k)) continue;
    const x = a[k], y = b[k];
    if (typeof x === "function") {
      assert.equal(typeof y, "function", `${where}.${k} was lost`);
      if (k === "customProgramCacheKey") assert.equal(y(), x(), `${where}.${k}`);
    } else if (x?.isTexture) sameTexture(x, y, `${where}.${k}`);
    else if (x?.isColor) assert.equal(y?.getHex(), x.getHex(), `${where}.${k}`);
    else if (x?.isVector2 || x?.isVector3 || x?.isEuler) assert.ok(y?.equals(x), `${where}.${k}`);
    else if (k === "userData") { const { shader, ...u } = x; const { shader: _, ...v } = y; assert.deepEqual(v, u, `${where}.userData`); }
    else if (x && typeof x === "object") assert.deepEqual(y, x, `${where}.${k}`);
    else assert.equal(y, x, `${where}.${k}`);
  }
  // the depth packing a card's shadow needs: three's own JSON drops it
  if (a.isMeshDepthMaterial) assert.equal(b.depthPacking, a.depthPacking, `${where}.depthPacking`);
}
const bytes = a => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
function sameGeometry(a, b, where) {
  assert.deepEqual(Object.keys(b.attributes).sort(), Object.keys(a.attributes).sort(), `${where} attributes`);
  for (const [k, x] of Object.entries(a.attributes)) {
    const y = b.attributes[k];
    assert.equal(y.itemSize, x.itemSize, `${where}.${k}.itemSize`);
    assert.equal(y.normalized, x.normalized, `${where}.${k}.normalized`);
    assert.equal(y.array.constructor, x.array.constructor, `${where}.${k} type`);
    assert.ok(bytes(y.array).equals(bytes(x.array)), `${where}.${k} values`);
  }
  assert.equal(!!b.index, !!a.index, `${where} index`);
  if (a.index) assert.ok(bytes(b.index.array).equals(bytes(a.index.array)), `${where} index values`);
  assert.deepEqual(b.groups, a.groups, `${where} groups`);
  assert.deepEqual(b.userData, a.userData, `${where} userData`);
}
function sameModel(a, b, where = "root") {
  assert.equal(b.type, a.type, `${where} type`);
  assert.equal(!!b.isInstancedMesh, !!a.isInstancedMesh, `${where} instanced`);
  for (const k of ["name", "visible", "castShadow", "receiveShadow", "frustumCulled", "renderOrder", "matrixAutoUpdate"])
    assert.equal(b[k], a[k], `${where}.${k}`);
  assert.equal(b.layers.mask, a.layers.mask, `${where} layers`);
  for (const k of ["position", "quaternion", "scale"]) assert.ok(b[k].equals(a[k]), `${where}.${k}`);
  assert.deepEqual(b.userData, a.userData, `${where} userData`);
  if (a.isMesh) {
    sameGeometry(a.geometry, b.geometry, `${where}.geometry`);
    const ma = [a.material].flat(), mb = [b.material].flat();
    assert.equal(mb.length, ma.length, `${where} materials`);
    ma.forEach((m, i) => sameMaterial(m, mb[i], `${where}.material[${i}]`));
    for (const k of ["customDepthMaterial", "customDistanceMaterial"]) {
      assert.equal(!!b[k], !!a[k], `${where}.${k}`);
      if (a[k]) sameMaterial(a[k], b[k], `${where}.${k}`);
    }
  }
  if (a.isInstancedMesh) {
    assert.equal(b.count, a.count, `${where}.count`);
    assert.ok(bytes(b.instanceMatrix.array).equals(bytes(a.instanceMatrix.array)), `${where} instance matrices`);
    assert.equal(!!b.instanceColor, !!a.instanceColor, `${where} instance colours`);
    if (a.instanceColor) assert.ok(bytes(b.instanceColor.array).equals(bytes(a.instanceColor.array)), `${where} instance colour values`);
  }
  assert.equal(b.children.length, a.children.length, `${where} children`);
  a.children.forEach((c, i) => sameModel(c, b.children[i], `${where}/${c.name || i}`));
}

// what IndexedDB does to a record: a structured clone, no prototypes, no shared references
const throughTheStore = packed => ({ record: structuredClone(packed.record), pixels: new Map([...packed.pixels].map(([k, v]) => [k, structuredClone(v)])) });

for (const p of KINDS) {
  test(`${p.common}: the Fast model read back from the store is the one that was generated`, () => {
    buildPlant(p, { quality: "fast" });
    const m = master(p);
    assert.ok(m, "nothing kept for this kind");
    const packed = packModel(m);
    assert.ok(packed, "the store refused this plant — it would be generated on every load");
    const back = throughTheStore(packed);
    sameModel(m, unpackModel(back.record, back.pixels));
  });
}

test("a model the store cannot hold exactly is refused, not stored wrong", () => {
  const g = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
  mesh.geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  g.add(mesh);
  assert.ok(packModel(g), "a plain mesh should pack");
  mesh.material.onBeforeCompile = () => {};                // a shader hook it cannot put back
  assert.equal(packModel(g), null);
  mesh.material = new THREE.MeshStandardMaterial();
  mesh.userData.at = new THREE.Vector3();                  // not plain data
  assert.equal(packModel(g), null);
  mesh.userData = {};
  g.add(new THREE.Line());
  assert.equal(packModel(g), null);
});

// ---- individuals ---------------------------------------------------------------------------
const ids = n => Array.from({ length: n }, (_, i) => `drift-${i}`);

test(`a drift is ${FAST_VARIANTS} individuals of its kind, turned and mirrored — not one plant copied`, () => {
  const p = KINDS[0];
  const built = ids(30).map(id => buildPlant({ ...p, id }, { quality: "fast" }));
  // an individual is known by its instance arrays: part shapes (a petal, a stand-in) can be
  // shared by every plant, where each individual stands its parts in its own places — or, drawn
  // by the generic generator (no library), by its geometry, which has no instanced parts
  const placement = g => {
    let x = null; g.traverse(o => { if (!x && o.isInstancedMesh) x = o.instanceMatrix; });
    if (!x) g.traverse(o => { if (!x && o.isMesh && o.geometry.attributes.position.count > 64) x = o.geometry.attributes.position; });
    return x;
  };
  const individuals = new Set(built.map(placement));
  assert.equal(individuals.size, FAST_VARIANTS, "not the kind's individuals");
  // distinct individuals are distinct plants, not one generation three times
  const arrays = [...individuals].map(a => bytes(a.array));
  assert.ok(!arrays[0].equals(arrays[1]) && !arrays[1].equals(arrays[2]), "the individuals are the same plant");
  const turns = new Set(built.map(g => g.rotation.y.toFixed(3)));
  assert.ok(turns.size > 25, `only ${turns.size} turns among 30 plants`);
  const mirrored = built.filter(g => g.scale.x < 0).length;
  assert.ok(mirrored > 5 && mirrored < 25, `${mirrored} of 30 mirrored`);
});

test("an individual shares its kind's arrays and owns its materials — selecting one lights only it", needsLibrary, () => {
  const p = KINDS[1];
  const twin = ids(40).find(id => fastModelKey({ ...p, id }) === fastModelKey({ ...p, id: "one" }));
  const a = buildPlant({ ...p, id: "one" }, { quality: "fast" });
  const b = buildPlant({ ...p, id: twin }, { quality: "fast" });           // the same individual
  const m = master({ ...p, id: "one" });
  const meshes = g => { const out = []; g.traverse(o => { if (o.isMesh) out.push(o); }); return out; };
  const [ma, mb, mm] = [meshes(a), meshes(b), meshes(m)];
  assert.equal(ma.length, mm.length);
  let instanced = 0, depth = 0;
  mm.forEach((src, i) => {
    assert.ok(ma[i].geometry === src.geometry, "geometry copied, not shared");
    if (src.isInstancedMesh) {
      instanced++;
      assert.ok(ma[i].instanceMatrix === src.instanceMatrix, "instance matrices copied, not shared");
      assert.equal(ma[i].count, src.count);
    }
    const [xa, xb, xs] = [ma[i], mb[i], src].map(o => [o.material].flat());
    xa.forEach((mat, k) => {
      assert.ok(mat !== xs[k], "an individual draws with its kind's own material");
      assert.ok(mat !== xb[k], "two plants share a material: highlighting one lights neither");
      sameMaterial(xs[k], mat, `${src.name}.material`);
    });
    if (src.customDepthMaterial) { depth++; assert.ok(ma[i].customDepthMaterial === src.customDepthMaterial, "the card shadow's depth material was dropped"); }
  });
  assert.ok(instanced > 0, "the fixture has no instanced parts — the sharing is untested");
  assert.ok(depth > 0, "the fixture has no card shadows — carrying their depth material is untested");
});

test("an individual is the same whichever plant of its kind is built first", async () => {
  const p = KINDS[2];
  const key = fastModelKey({ ...p, id: "a" });
  const sameVariant = ids(60).find(id => id !== "a" && fastModelKey({ ...p, id }) === key);
  const arrays = () => { const out = []; master({ ...p, id: "a" }).traverse(o => { if (o.isMesh) out.push(bytes(o.geometry.attributes.position.array)); }); return out; };
  await forgetModels();
  buildPlant({ ...p, id: "a" }, { quality: "fast" });
  const first = arrays();
  await forgetModels();
  buildPlant({ ...p, id: sameVariant }, { quality: "fast" });
  const second = arrays();
  assert.equal(second.length, first.length);
  first.forEach((x, i) => assert.ok(x.equals(second[i]), "the individual depended on which plant was built first"));
});

test("a kind is what the plant is: not its id or place, not the order its fields were written in", () => {
  const p = KINDS[3];
  const k = q => fastModelKey(q).replace(/#\d+$/, "");
  assert.equal(k({ ...p, id: "x", position: [3, 4] }), k({ ...p, id: "y", position: [0, 0] }));
  const reordered = Object.fromEntries(Object.entries(p).reverse());
  assert.equal(fastModelKey(reordered), fastModelKey(p));
  for (const change of [{ species: "Muhlenbergia capillaris" }, { mature_spread_m: 1.3 }, { flower: "#ffffff" },
                        { foliage: "#445566" }, { declared_height_m: 2 }])
    assert.notEqual(k({ ...p, ...change }), k(p), `${Object.keys(change)[0]} is not in the kind`);
});

test("a kept model is what a build uses — the seam, not only the parts", async () => {
  const p = { ...KINDS[4], id: "seam" };
  await forgetModels();
  const marker = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  mesh.name = "kept marker";
  marker.add(mesh);
  marker.userData.drawnSpread = p.mature_spread_m;
  keepModel(fastModelKey(p), marker);
  const g = buildPlant(p, { quality: "fast" });
  assert.equal(g.children[0]?.name, "kept marker", "the build generated instead of using what was kept");
  await forgetModels();
});

// ---- the version -----------------------------------------------------------------------------
test("the store's version moves with the plant code and its textures, not with the rest of the viewer", () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plant-version-"));
  try {
    fs.cpSync(path.join(ROOT, "viewer", "src"), path.join(tmp, "viewer", "src"), { recursive: true });
    for (const pkg of ["three", "meshoptimizer"]) {
      fs.mkdirSync(path.join(tmp, "viewer", "node_modules", pkg), { recursive: true });
      fs.copyFileSync(path.join(ROOT, "viewer", "node_modules", pkg, "package.json"), path.join(tmp, "viewer", "node_modules", pkg, "package.json"));
    }
    const tex = path.join(tmp, "library", "assets", "plants", "botanical");
    fs.mkdirSync(tex, { recursive: true });
    fs.writeFileSync(path.join(tex, "leaf.png"), "a");
    const lib = path.join(tmp, "library"), version = () => plantCodeVersion(tmp, lib);
    // a species builder is the LIBRARY's, made of app parts it imports as @pedon/…
    fs.mkdirSync(path.join(lib, "species"), { recursive: true });
    fs.writeFileSync(path.join(lib, "species", "a_species.js"),
      'import { surfaceGeometry } from "@pedon/woody_geometry.js";\nexport const build = () => null;\n');
    const v0 = version();
    const touch = (rel, text) => fs.appendFileSync(path.join(tmp, rel), text);
    touch("viewer/src/main.js", "\n// a menu changed\n");
    assert.equal(version(), v0, "a change outside the plant code threw away every kept plant");
    touch("library/species/a_species.js", "\n// a builder changed\n");
    const v1 = version();
    assert.notEqual(v1, v0, "a library builder changed and the kept plants would still be drawn");
    // woody_geometry.js is reached ONLY through a library builder's @pedon/ import
    touch("viewer/src/woody_geometry.js", "\n// a part builders are made of changed\n");
    const v1b = version();
    assert.notEqual(v1b, v1, "a part only the library's builders use changed, and the kept plants stayed");
    touch("viewer/src/preview_lod.js", "\n// the reduction changed\n");
    const v2 = version();
    assert.notEqual(v2, v1b, "the reduction changed and the kept plants would still be drawn");
    fs.writeFileSync(path.join(tex, "leaf.png"), "bb");
    assert.notEqual(version(), v2, "a texture changed and the kept plants would still be drawn");
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test("an individual's tag is not read as a builder: a generic plant names none in either mode", () => {
  // read as a builder, a `fastModel` tag makes every generic plant "drawn by fastModel" in Fast,
  // and the agreement tool then reports 61 of the catalogue's species as a different plant
  const p = KINDS[6];
  assert.equal(builderName(buildPlant(p, { quality: "detailed" })), null);
  assert.equal(builderName(buildPlant(p, { quality: "fast" })), null);
});

