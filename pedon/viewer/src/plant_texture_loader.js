// ONE WAY A PLANT BUILDER'S TEXTURE IS LOADED.
//
// Fast draws the same builders as full detail, reduced — and their colour is in their
// textures: Evergold's gold, Sunset Gold's lime, coyote brush's pale leaf. Without them Fast
// falls back to each builder's darker no-texture colour and draws those plants 17-28% dark. The
// full set is tens of megabytes of large PNGs, so Fast asks for each at 256 px: the browser decodes it at
// that size off the main thread — the same picture, the same colours, a fraction of the memory.
import * as THREE from "three";

let detail = "detailed", turn = 0;
/** "fast" or "detailed": which size the builders' textures are loaded at from now on. */
export function setTextureDetail(d) {
  const next = d === "fast" ? "fast" : "detailed";
  if (next !== detail) { detail = next; turn++; }
}
/**
 * The key a builder caches its texture load under. It changes on EVERY switch, not just per
 * size: a builder registers its texture when a load finishes, so going full -> Fast -> full
 * with the full load cached would never register it again, and full detail would keep Fast's 256 px.
 */
export function textureDetail() { return `${detail}#${turn}`; }

// WHETHER EVERY BUILDER'S TEXTURE IS IN, at the size now being drawn. A Fast plant generated
// before its textures arrive is drawn in its darker no-texture colour; kept in the browser
// it would be drawn that way on every load until the plant code changed, so only a plant
// generated with its textures in is kept.
let readyFor = null;
export function markTexturesReady(key, ok) { readyFor = ok ? key : null; }
export function texturesReady(want) { return readyFor === textureDetail() && detail === want; }

export async function plantTexture(url) {
  if (detail !== "fast" || typeof createImageBitmap !== "function") return new THREE.TextureLoader().loadAsync(url);
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob, { resizeWidth: 256, resizeHeight: 256, resizeQuality: "medium" });
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  c.getContext("2d").drawImage(bmp, 0, 0);
  bmp.close?.();
  return new THREE.CanvasTexture(c);               // flipY as TextureLoader's, a canvas carries it
}

/**
 * A species builder's `prepare` (viewer/src/species.js): its textures — files in the library's
 * assets/plants/botanical/ — loaded once per detail level and handed to `register`, resolving true
 * when all are in; false, with a warning naming `what`, when one is not, and asked again next time.
 * Meanwhile the builder draws its no-texture colour, and Fast keeps nothing drawn without them.
 * One copy, shared by every builder.
 */
export function texturePreparer(files, register, what) {
  let loading = null;
  const urls = [].concat(files).map(f => f.startsWith("/") ? f : `/assets/plants/botanical/${f}`);
  return () => (loading ??= {})[textureDetail()] ??= Promise.all(urls.map(plantTexture))
    .then(textures => { register(...textures); return true; })
    .catch(e => { loading = null; console.warn(`[plants] ${what} unavailable:`, e.message); return false; });
}
