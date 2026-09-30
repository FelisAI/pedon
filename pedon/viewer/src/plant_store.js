// KEEP WHAT IS GENERATED.
//
// A plant is GENERATED in the browser — its species' model built from code, and in Fast that
// model reduced — and generating every species is most of a page load. What is
// generated depends only on the plant's own fields and the plant code, so
// it is kept: in memory for the session, and in the browser's IndexedDB under the version of
// the plant code (/api/plant-build `plants`), so the next load reads it back instead.
//
// A model is stored as its parts: the object tree, each geometry's arrays, each material as
// three's own JSON — with what that JSON leaves out put back (translucency, depth packing) —
// and each texture's settings and pixels, the pixels once however many plants share them.
// Anything this cannot store exactly is not stored: that plant is generated each load,
// and `storeStats().refused` says why.
import * as THREE from "three";
import { translucent } from "./translucency.js";

const DB_NAME = "pedon-plant-models", FORMAT = 1;
/** Past this many bytes kept, the least recently used models go. */
export const STORE_CAP_BYTES = 1.5e9;

const MODELS = new Map();          // key -> generated model (the master every individual copies)
const PENDING = new Map();         // key -> model generated this session and not yet stored
const stats = { restored: 0, restoreMs: 0, stored: 0, storeMs: 0, refused: {}, bytes: 0 };

/** The generated model kept for `key`, or undefined if it has to be generated. */
export function keptModel(key) { return MODELS.get(key); }

/** Keep a freshly generated model: in memory now, and in the browser's store when it is idle.
 *  `complete` false — made before every builder's texture was in — is kept for the session
 *  only: stored, it would be drawn in its darker no-texture colour on every load for good. */
export function keepModel(key, model, complete = true) {
  if (MODELS.size > 800) MODELS.clear();       // a session that walks through every design
  MODELS.set(key, model);
  if (!model || typeof indexedDB === "undefined") return;
  if (!complete) { stats.refused["textures not in"] = (stats.refused["textures not in"] ?? 0) + 1; return; }
  PENDING.set(key, model); scheduleSave();
}

/** What the store did this session — `__pedon.plantStore()`. */
export function storeStats() { return { ...stats, kept: MODELS.size, pending: PENDING.size }; }

// ---------------------------------------------------------------------------------------------
// packing: a model to plain data IndexedDB can hold, and back

const refuse = (why) => { stats.refused[why] = (stats.refused[why] ?? 0) + 1; return null; };

function isPlain(v, depth = 0) {
  if (v === null || ["string", "number", "boolean", "undefined"].includes(typeof v)) return true;
  if (depth > 8 || typeof v !== "object") return false;
  if (Array.isArray(v)) return v.every(x => isPlain(x, depth + 1));
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(v).every(x => isPlain(x, depth + 1));
}

// two independent 32-bit hashes of the pixels: the key a picture is stored under once
function pixelKey(w, h, data) {
  const u = new Uint32Array(data.buffer, data.byteOffset, data.byteLength >> 2);
  let a = 0x811c9dc5, b = 5381;
  for (let i = 0; i < u.length; i++) {
    a = Math.imul(a ^ u[i], 0x01000193);
    b = (Math.imul(b, 33) ^ u[i]) >>> 0;
  }
  return `${w}x${h}:${(a >>> 0).toString(36)}${b.toString(36)}`;
}

const TEXTURE_KEYS = ["name", "mapping", "channel", "wrapS", "wrapT", "format", "internalFormat", "type",
  "colorSpace", "minFilter", "magFilter", "anisotropy", "flipY", "generateMipmaps", "premultiplyAlpha",
  "unpackAlignment"];
const OBJECT_TYPES = new Set(["Group", "Object3D", "Mesh"]);
// a material's bookkeeping, and what is carried separately (textures, userData, the shader hook)
const SKIP_FIELDS = new Set(["uuid", "id", "version", "_listeners", "userData", "onBeforeCompile",
  "customProgramCacheKey", "type", "name"]);
const MATERIAL_TYPES = new Set(["MeshStandardMaterial", "MeshPhysicalMaterial", "MeshBasicMaterial",
  "MeshLambertMaterial", "MeshDepthMaterial"]);

/** A model as plain data and the pixels it needs, or null (and why, in stats) if it cannot be. */
export function packModel(root) {
  const geos = [], geoAt = new Map(), mats = [], matAt = new Map(), texs = [], texAt = new Map();
  const pixels = new Map();
  let bytes = 0;

  const texRef = t => {
    if (texAt.has(t)) return texAt.get(t);
    if (!t.isTexture || t.isDataTexture || t.isCompressedTexture || t.isVideoTexture) throw "texture kind";
    const img = t.image;
    // a canvas round-trips exactly: its upload went through the same 2D surface. A decoded
    // image does not (a canvas loses the colour under transparent pixels), so it is refused.
    if (!(typeof HTMLCanvasElement !== "undefined" && img instanceof HTMLCanvasElement)) throw "texture not a canvas";
    const ctx = img.getContext("2d");
    if (!ctx) throw "canvas without 2d";
    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    const px = pixelKey(img.width, img.height, data);
    if (!pixels.has(px)) pixels.set(px, { w: img.width, h: img.height, data });
    const p = {};
    for (const k of TEXTURE_KEYS) p[k] = t[k];
    for (const k of ["repeat", "offset", "center"]) p[k] = t[k].toArray();
    p.rotation = t.rotation;
    if (!isPlain(t.userData)) throw "texture userData";
    p.userData = t.userData;
    const at = texs.push({ p, px, uuid: t.uuid }) - 1;
    texAt.set(t, at);
    return at;
  };

  const matRef = m => {
    if (matAt.has(m)) return matAt.get(m);
    if (!MATERIAL_TYPES.has(m.type)) throw `material ${m.type}`;
    // the only shader hook a plant's material may carry is translucency's, which is put back
    const hooked = Object.prototype.hasOwnProperty.call(m, "onBeforeCompile");
    if (hooked && !m.userData?.translucency) throw "material shader hook";
    const meta = { textures: {}, images: {} };
    for (const k in m) if (m[k]?.isTexture) { const i = texRef(m[k]); meta.textures[m[k].uuid] = { uuid: m[k].uuid, i }; }
    const { shader, __prevEmissive, ...ud } = m.userData ?? {};
    const saved = m.userData;
    m.userData = ud;                                // not the compiled shader, not a highlight
    let json;
    try { json = m.toJSON(meta); } finally { m.userData = saved; }
    delete json.metadata;
    if (json.userData && !isPlain(json.userData)) throw "material userData";
    // WHAT THREE'S OWN JSON LEAVES OUT, found by reading it back: a depth material's packing
    // (without it a leaf card's shadow is unreadable), `ior` (kept only as a rounded
    // reflectivity), a normal scale with no normal map. Each field is compared, and one that
    // differs is stored as it is; one that cannot be is refused.
    const probe = new THREE.MaterialLoader().setTextures(Object.fromEntries(
      Object.keys(meta.textures).map(u => [u, new THREE.Texture()]))).parse(json);
    json.extra = {};
    for (const k of Object.keys(m)) {
      if (SKIP_FIELDS.has(k)) continue;
      const x = m[k], y = probe[k];
      if (typeof x === "function" || x?.isTexture) continue;
      if (x?.isColor || x?.isVector2 || x?.isVector3 || x?.isVector4 || x?.isEuler || x?.isMatrix3) {
        if (!y?.equals?.(x)) json.extra[k] = { array: x.toArray() };
      }
      else if (x === null || ["number", "string", "boolean", "undefined"].includes(typeof x)) {
        if (!Object.is(x, y)) json.extra[k] = { value: x };
      } else if (isPlain(x)) { if (JSON.stringify(x) !== JSON.stringify(y)) json.extra[k] = { value: x }; }
      else throw `material field ${k}`;
    }
    probe.dispose();
    const at = mats.push(json) - 1;
    matAt.set(m, at);
    return at;
  };

  const geoRef = g => {
    if (geoAt.has(g)) return geoAt.get(g);
    if (Object.keys(g.morphAttributes).length) throw "morph attributes";
    const attrs = {};
    for (const [name, a] of Object.entries(g.attributes)) {
      if (a.isInterleavedBufferAttribute || a.isInstancedBufferAttribute) throw "attribute kind";
      attrs[name] = { a: a.array, s: a.itemSize, n: a.normalized };
      bytes += a.array.byteLength;
    }
    if (g.index) bytes += g.index.array.byteLength;
    if (!isPlain(g.userData)) throw "geometry userData";
    if (!g.boundingSphere) g.computeBoundingSphere();
    if (!g.boundingBox) g.computeBoundingBox();
    const at = geos.push({ name: g.name, attrs, index: g.index?.array ?? null, groups: g.groups.map(x => ({ ...x })),
      ud: g.userData, bs: [...g.boundingSphere.center.toArray(), g.boundingSphere.radius],
      bb: [...g.boundingBox.min.toArray(), ...g.boundingBox.max.toArray()] }) - 1;
    geoAt.set(g, at);
    return at;
  };

  const node = o => {
    if (!OBJECT_TYPES.has(o.type) || o.isSprite || o.isLine || o.isPoints || o.isLOD || o.isSkinnedMesh) throw `object ${o.type}`;
    if (Object.prototype.hasOwnProperty.call(o, "onBeforeRender")) throw "object render hook";
    if (!isPlain(o.userData)) throw "object userData";
    const n = { t: o.isInstancedMesh ? "I" : o.isMesh ? "M" : o.type === "Group" ? "G" : "O",
      name: o.name, ud: o.userData, p: o.position.toArray(), q: o.quaternion.toArray(), s: o.scale.toArray(),
      v: o.visible, cs: o.castShadow, rs: o.receiveShadow, fc: o.frustumCulled, ro: o.renderOrder,
      l: o.layers.mask, mau: o.matrixAutoUpdate, m: o.matrixAutoUpdate ? null : o.matrix.toArray() };
    if (o.isMesh) {
      n.g = geoRef(o.geometry);
      n.mat = Array.isArray(o.material) ? o.material.map(matRef) : matRef(o.material);
      if (o.customDepthMaterial) n.dm = matRef(o.customDepthMaterial);
      if (o.customDistanceMaterial) n.xm = matRef(o.customDistanceMaterial);
    }
    if (o.isInstancedMesh) {
      if (o.morphTexture) throw "instanced morph";
      n.c = o.count;
      n.im = o.instanceMatrix.array; n.imu = o.instanceMatrix.usage;
      bytes += n.im.byteLength;
      if (o.instanceColor) { n.ic = o.instanceColor.array; bytes += n.ic.byteLength; }
      if (o.boundingSphere) n.bs = [...o.boundingSphere.center.toArray(), o.boundingSphere.radius];
    }
    n.k = o.children.map(node);
    return n;
  };

  try {
    const tree = node(root);
    for (const { data } of pixels.values()) bytes += data.byteLength;
    return { record: { format: FORMAT, tree, geos, mats, texs, bytes }, pixels };
  } catch (why) {
    if (typeof why !== "string") throw why;
    return refuse(why);
  }
}

// one canvas and one three.js Source per picture, shared by every texture that shows it
const SOURCES = new Map();
function sourceFor(px, rec) {
  let s = SOURCES.get(px);
  if (s) return s;
  const c = document.createElement("canvas");
  c.width = rec.w; c.height = rec.h;
  const data = rec.data instanceof Uint8ClampedArray ? rec.data : new Uint8ClampedArray(rec.data.buffer ?? rec.data);
  c.getContext("2d").putImageData(new ImageData(data, rec.w, rec.h), 0, 0);
  s = new THREE.Source(c);
  SOURCES.set(px, s);
  return s;
}

/** A packed model as three.js objects again. `pixels`: pixel key -> {w, h, data}. */
export function unpackModel(record, pixels) {
  const textures = record.texs.map(({ p, px, uuid }) => {
    const rec = pixels.get(px);
    if (!rec) throw new Error(`missing picture ${px}`);
    const t = new THREE.Texture();
    t.source = sourceFor(px, rec);
    for (const k of TEXTURE_KEYS) t[k] = p[k];
    t.repeat.fromArray(p.repeat); t.offset.fromArray(p.offset); t.center.fromArray(p.center);
    t.rotation = p.rotation;
    t.userData = structuredClone(p.userData);
    t.uuid = uuid;
    t.needsUpdate = true;
    return t;
  });
  const loader = new THREE.MaterialLoader();
  const mats = record.mats.map(json => {
    const byUuid = {};
    for (const k in json) if (typeof json[k] === "string") {
      const i = record.texs.findIndex(t => t.uuid === json[k]);
      if (i >= 0) byUuid[json[k]] = textures[i];
    }
    loader.setTextures(byUuid);
    const m = loader.parse(json);
    for (const [k, e] of Object.entries(json.extra ?? {}))
      if (e.array) m[k].fromArray(e.array);
      else m[k] = e.value;
    if (m.userData?.translucency) translucent(m, m.userData.translucency);
    return m;
  });
  const geos = record.geos.map(r => {
    const g = new THREE.BufferGeometry();
    g.name = r.name;
    for (const [name, a] of Object.entries(r.attrs)) g.setAttribute(name, new THREE.BufferAttribute(a.a, a.s, a.n));
    if (r.index) g.setIndex(new THREE.BufferAttribute(r.index, 1));
    for (const x of r.groups) g.addGroup(x.start, x.count, x.materialIndex);
    g.userData = r.ud;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(r.bs[0], r.bs[1], r.bs[2]), r.bs[3]);
    g.boundingBox = new THREE.Box3(new THREE.Vector3(r.bb[0], r.bb[1], r.bb[2]), new THREE.Vector3(r.bb[3], r.bb[4], r.bb[5]));
    return g;
  });
  const build = n => {
    const mat = n.mat === undefined ? null : Array.isArray(n.mat) ? n.mat.map(i => mats[i]) : mats[n.mat];
    let o;
    if (n.t === "I") {
      o = new THREE.InstancedMesh(geos[n.g], mat, 0);
      o.instanceMatrix = new THREE.InstancedBufferAttribute(n.im, 16);
      o.instanceMatrix.usage = n.imu;
      if (n.ic) o.instanceColor = new THREE.InstancedBufferAttribute(n.ic, 3);
      o.count = n.c;
      if (n.bs) o.boundingSphere = new THREE.Sphere(new THREE.Vector3(n.bs[0], n.bs[1], n.bs[2]), n.bs[3]);
    } else if (n.t === "M") o = new THREE.Mesh(geos[n.g], mat);
    else if (n.t === "G") o = new THREE.Group();
    else o = new THREE.Object3D();
    if (n.dm !== undefined) o.customDepthMaterial = mats[n.dm];
    if (n.xm !== undefined) o.customDistanceMaterial = mats[n.xm];
    o.name = n.name; o.userData = n.ud;
    o.position.fromArray(n.p); o.quaternion.fromArray(n.q); o.scale.fromArray(n.s);
    o.visible = n.v; o.castShadow = n.cs; o.receiveShadow = n.rs; o.frustumCulled = n.fc; o.renderOrder = n.ro;
    o.layers.mask = n.l; o.matrixAutoUpdate = n.mau;
    if (n.m) { o.matrix.fromArray(n.m); o.matrixWorldNeedsUpdate = true; }
    for (const k of n.k) o.add(build(k));
    return o;
  };
  return build(record.tree);
}

// ---------------------------------------------------------------------------------------------
// the browser's store

let versionPromise = null, dbPromise = null;
// what the store holds, read once when it is opened: the models' sizes and last use, and which
// pictures are already in it — so a write never has to read inside its own transaction
let index = {}, storedPixels = new Set();

/** The plant code's version, or null where there is no server to ask (a test). */
function plantVersion() {
  versionPromise ??= (typeof fetch === "function" && typeof location !== "undefined"
    ? fetch("/api/plant-build").then(r => r.json()).then(j => j.plants ?? null).catch(() => null)
    : Promise.resolve(null));
  return versionPromise;
}

const req = r => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
const done = tx => new Promise((ok, no) => { tx.oncomplete = ok; tx.onerror = tx.onabort = () => no(tx.error); });

function openStore() {
  dbPromise ??= (async () => {
    const version = await plantVersion();
    if (!version || typeof indexedDB === "undefined" || typeof document === "undefined") return null;
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      for (const s of ["models", "pixels", "meta"]) if (!open.result.objectStoreNames.contains(s)) open.result.createObjectStore(s);
    };
    const db = await req(open);
    const read = db.transaction(["pixels", "meta"], "readonly");
    const [was, idx, px] = await Promise.all([req(read.objectStore("meta").get("version")),
      req(read.objectStore("meta").get("index")), req(read.objectStore("pixels").getAllKeys())]);
    if (was === `${version}|${FORMAT}`) { index = idx ?? {}; storedPixels = new Set(px); }
    else {
      // ONE VERSION KEPT: a model generated by other code is not this code's plant
      const tx = db.transaction(["models", "pixels", "meta"], "readwrite");
      tx.objectStore("models").clear(); tx.objectStore("pixels").clear();
      tx.objectStore("meta").put(`${version}|${FORMAT}`, "version");
      tx.objectStore("meta").put({}, "index");
      await done(tx);
      index = {}; storedPixels = new Set();
    }
    stats.bytes = Object.values(index).reduce((s, x) => s + x.bytes, 0);
    return db;
  })().catch(e => { console.warn("[plants] the plant store is unavailable:", e?.message ?? e); return null; });
  return dbPromise;
}

/**
 * Read back the kept models for these keys before a build, so the build — synchronous — finds
 * them. Keys already in memory are not read again.
 */
export async function restoreModels(keys) {
  const want = [...new Set(keys)].filter(k => !MODELS.has(k));
  if (!want.length) return 0;
  const db = await openStore();
  if (!db) return 0;
  const t0 = performance.now();
  const have = want.filter(k => index[k]);
  if (!have.length) return 0;
  const tx = db.transaction("models", "readonly");
  const records = await Promise.all(have.map(k => req(tx.objectStore("models").get(k))));
  const pxKeys = new Set();
  for (const r of records) if (r) for (const t of r.texs) pxKeys.add(t.px);
  const tp = db.transaction("pixels", "readonly");
  const pics = await Promise.all([...pxKeys].map(k => req(tp.objectStore("pixels").get(k))));
  const pixels = new Map([...pxKeys].map((k, i) => [k, pics[i]]).filter(([, p]) => p));
  let n = 0;
  const now = Date.now();
  records.forEach((r, i) => {
    if (!r || r.format !== FORMAT) return;
    try { MODELS.set(have[i], unpackModel(r, pixels)); n++; index[have[i]].used = now; }
    catch (e) { console.warn("[plants] a kept model could not be read back; it will be generated:", e.message); }
  });
  stats.restored += n; stats.restoreMs += performance.now() - t0;
  if (n) writeIndex(db);
  return n;
}

function writeIndex(db) {
  const tx = db.transaction("meta", "readwrite");
  tx.objectStore("meta").put(index, "index");
  return done(tx).catch(() => {});
}

let saving = null;
function scheduleSave() {
  if (saving || typeof document === "undefined") return;
  const idle = globalThis.requestIdleCallback ?? (f => setTimeout(f, 200));
  saving = new Promise(r => idle(() => r(), { timeout: 5000 }))
    .then(saveKept)
    .catch(e => console.warn("[plants] could not keep generated plants:", e?.message ?? e))
    .finally(() => { saving = null; if (PENDING.size) scheduleSave(); });
}

/** Store what was generated since the last save. Resolves when it is written. */
export async function saveKept() {
  const db = await openStore();
  if (!db) { PENDING.clear(); return 0; }
  const batch = [...PENDING];
  PENDING.clear();
  const t0 = performance.now();
  let n = 0;
  for (const [key, model] of batch) {
    const packed = packModel(model);
    if (!packed) continue;
    index[key] = { bytes: packed.record.bytes, used: Date.now() };
    let total = Object.values(index).reduce((s, x) => s + x.bytes, 0);
    const drop = [];
    for (const [k] of Object.entries(index).sort((a, b) => a[1].used - b[1].used)) {
      if (total <= STORE_CAP_BYTES) break;
      if (k === key) continue;
      total -= index[k].bytes; delete index[k]; drop.push(k);
    }
    const tx = db.transaction(["models", "pixels", "meta"], "readwrite");
    for (const [k, rec] of packed.pixels) if (!storedPixels.has(k)) { tx.objectStore("pixels").put(rec, k); storedPixels.add(k); }
    tx.objectStore("models").put(packed.record, key);
    for (const k of drop) tx.objectStore("models").delete(k);
    tx.objectStore("meta").put(index, "index");
    await done(tx);
    stats.bytes = total;
    n++;
  }
  stats.stored += n; stats.storeMs += performance.now() - t0;
  return n;
}

/** Forget every kept model, in memory and in the browser. */
export async function forgetModels() {
  MODELS.clear(); PENDING.clear();
  const db = await openStore();
  if (!db) return;
  const tx = db.transaction(["models", "pixels", "meta"], "readwrite");
  tx.objectStore("models").clear(); tx.objectStore("pixels").clear(); tx.objectStore("meta").put({}, "index");
  await done(tx);
  index = {}; storedPixels = new Set(); stats.bytes = 0;
}
