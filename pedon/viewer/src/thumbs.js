/**
 * A picture of the actual model, for the asset window.
 *
 * The user picks a plant from a real asset window where they can see what each
 * one looks like; a dropdown of names is not usable for this.
 *
 * It renders the MODEL rather than shipping photographs, and that is the honest
 * choice: a stock photo of a manzanita would show the user something the garden
 * will not contain, and the gap between the two is exactly the kind of silent
 * substitution this project refuses. What the user picks here is what gets
 * planted, drawn by the same buildPlant() the yard uses, in the same colours.
 *
 * The same rule covers the OBJECTS — a lantern, a basin, a moon gate — drawn
 * by the same objectMesh() the garden uses. There is ONE render harness below and
 * two thin callers, because a second copy of "make a scene, frame it, snapshot it"
 * drifts from the first.
 *
 * One small renderer, made on first use and reused. Thumbnails are cached by
 * everything that can change the picture, because dozens of species x a WebGL context
 * per card is how a picker becomes slower than a dropdown.
 */
import * as THREE from "three";
import { buildPlant } from "./plants.js";
import { objectMesh } from "./objects.js";

const SIZE = 132;
let gl = null, cache = new Map();

function renderer() {
  if (gl) return gl;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE * 2;          // 2x, so it stays crisp
  gl = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  gl.setClearAlpha(0);
  return gl;
}

const keyOf = e => [e.species, e.common, e.form, e.mature_height_m, e.mature_spread_m,
                    e.foliage, e.flower, e.asset].join("|");

/**
 * Build it, frame it, snapshot it. The ONE harness.
 *
 * `build` returns an Object3D standing at the origin; everything else — the flat
 * two-sided light, the three-quarter camera, the dispose sweep, the cache and the
 * never-throw contract — is the same whatever was built.
 *
 * Returns a data: URL, or null if the browser cannot give us a context. Null is a
 * real answer: the card falls back to text rather than to a blank grey square.
 */
function thumb(key, build, what) {
  if (cache.has(key)) return cache.get(key);
  let url = null;
  let scene = null;
  try {
    const g = renderer();
    scene = new THREE.Scene();
    // Flat, neutral light from two sides: a thumbnail is for COMPARING colour,
    // and a raking sun would make each subject's hue depend on where it happened
    // to sit rather than on what it is.
    scene.add(new THREE.HemisphereLight(0xffffff, 0x60705f, 2.2));
    const key1 = new THREE.DirectionalLight(0xffffff, 1.1);
    key1.position.set(2, 3, 2);
    scene.add(key1);

    const model = build();
    scene.add(model);

    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const mid = box.getCenter(new THREE.Vector3());
    const reach = Math.max(size.x, size.y, size.z, 0.3);
    const cam = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
    // slightly above eye level for the subject's own height, three-quarter view:
    // the angle a nursery photograph is taken from, for the same reason
    cam.position.set(mid.x + reach * 1.5, mid.y + reach * 0.75, mid.z + reach * 2.0);
    cam.lookAt(mid.x, mid.y * 0.9, mid.z);
    g.render(scene, cam);
    url = g.domElement.toDataURL("image/png");
  } catch (e) {
    // A picker that throws is worse than a picker with no pictures.
    console.warn("thumbs.js: no thumbnail for", what, e);
    url = null;
  } finally {
    // in the finally, so a throw midway through building does not leak the half
    // of the scene that had already been made
    scene?.traverse((n) => {
      n.geometry?.dispose?.();
      if (Array.isArray(n.material)) n.material.forEach(m => m.dispose?.());
      else n.material?.dispose?.();
    });
  }
  cache.set(key, url);
  return url;
}

/** A data: URL of this plant, or null — drawn now, however long that takes. */
export function plantThumb(entry, { quality = 'fast' } = {}) {
  if (!entry?.species) return null;
  return thumb(quality + "|" + keyOf(entry),
               () => buildPlant({ ...entry, id: `thumb:${entry.species}`, position: [0, 0] }, { quality }),
               entry.species);
}

// ── DEFERRED, AND KEPT ──────────────────────────────────────────────────────
//
// Fast draws the photoreal builders reduced — the same plant as full detail — and building
// one takes 0.1-2.5 s. Drawn as each card is made, opening the window builds every model at
// once — tens of seconds — a stall that makes the window unusable. So a card asks for its
// picture and gets it when it is ready: from this session's memory, from the browser's store —
// kept under the plant code's version (/api/plant-build), so a picture is drawn once per version,
// not once per visit — or drawn in the next idle moment, one per turn, so the window stays usable.
let build = null;
/** The plant code's version; null keeps nothing between visits (a test, or no server). */
export function setPlantBuild(id) { build = id || null; }
const waiting = new Map(), queue = [];
let pumping = false, dbp = null;

function db() {
  return dbp ??= new Promise(ok => {
    try {
      const r = indexedDB.open("pedon-thumbs", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("thumbs");
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ok(null);
    } catch { ok(null); }                        // private mode, a test: nothing is kept
  });
}
const kept = async key => {
  const d = await db();
  if (!d) return null;
  return new Promise(ok => {
    try { const q = d.transaction("thumbs").objectStore("thumbs").get(key); q.onsuccess = () => ok(q.result ?? null); q.onerror = () => ok(null); }
    catch { ok(null); }
  });
};
const keep = async (key, url) => {
  const d = await db();
  try { d?.transaction("thumbs", "readwrite").objectStore("thumbs").put(url, key); } catch {}
};

/**
 * This plant's picture now if it is known; otherwise null, and `onReady(url)` when it is drawn
 * or found (url null if it cannot be). The order asked is the order drawn — top of the window first.
 */
export function plantThumbLater(entry, onReady, { quality = "fast" } = {}) {
  if (!entry?.species) return null;
  const key = quality + "|" + keyOf(entry);
  if (cache.has(key)) return cache.get(key);
  if (!waiting.has(key)) { waiting.set(key, []); queue.push({ key, entry, quality }); }
  waiting.get(key).push(onReady);
  if (!pumping) { pumping = true; setTimeout(pump, 0); }
  return null;
}

async function pump() {
  const job = queue.shift();
  if (!job) { pumping = false; return; }
  const at = build && `${build}|${job.key}`;
  let url = at ? await kept(at) : null;
  if (url) cache.set(job.key, url);
  else {
    url = plantThumb(job.entry, { quality: job.quality });
    if (url && at) keep(at, url);
  }
  for (const f of waiting.get(job.key) ?? []) { try { f(url); } catch {} }
  waiting.delete(job.key);
  setTimeout(pump, 0);
}

/**
 * A data: URL of this object kind, or null.
 *
 * Drawn flat on the ground plane — `heightAt` is the identity zero, because a
 * thumbnail has no terrain and objectMesh would otherwise ask the yard where this
 * lantern stands, which for a catalogue row is nowhere.
 */
export function objectThumb(entry) {
  const kind = entry?.kind ?? entry?.species;
  if (!kind) return null;
  return thumb(`object|${kind}|${entry?.height_m}|${entry?.width_m}`,
               () => objectMesh({ id: `thumb:${kind}`, kind, position: [0, 0],
                                  height_m: entry?.height_m, width_m: entry?.width_m },
                                () => 0),
               kind);
}

/** Drop the cache — growth stage changes what a plant looks like — and what was waiting. */
export function forgetThumbs() { cache = new Map(); queue.length = 0; waiting.clear(); }
