// A viewing preference, never a change to plant masters or saved designs.
export const FAST_QUALITY = 'fast';
export const DETAIL_QUALITY = 'detailed';
const KEY = 'yardtwin.renderQuality';
export function readRenderQuality(storage, search = '') {
  let saved;
  try { saved = storage?.getItem(KEY); } catch { /* disabled storage */ }
  const value = new URLSearchParams(search).get('quality') ?? saved;
  return value === DETAIL_QUALITY ? DETAIL_QUALITY : FAST_QUALITY;
}
export function saveRenderQuality(storage, value) {
  try { storage?.setItem(KEY, value); } catch { /* works for this visit */ }
}
// SHADOWS ARE THEIR OWN AXIS, not a side effect of the plant-detail preset.
//
// Tied to it, Fast preview — the mode most viewing happens in — would cast no
// shadow however far the sun is moved across the day, and shadows are most of
// what "what would it look like at six" means. The two settings
// answer different questions: Fast preview is about how much BOTANICAL DETAIL is
// built (and how long the page takes to load); shadows are about how the scene
// is LIT. One is loading cost, the other is per-frame cost, and they are not the
// same decision.
const SHADOW_KEY = 'yardtwin.shadows';
export function readShadows(storage) {
  try {
    const v = storage?.getItem(SHADOW_KEY);
    if (v !== null && v !== undefined) return v === '1';
  } catch { /* disabled storage */ }
  return true;              // measured affordable in Fast preview
}
export function saveShadows(storage, on) {
  try { storage?.setItem(SHADOW_KEY, on ? '1' : '0'); } catch { /* works for this visit */ }
}

export function applyRenderQuality(renderer, value, pixelRatio = 1, shadows = null) {
  renderer.setPixelRatio(Math.min(pixelRatio, value === FAST_QUALITY ? 1 : 2));
  // `null` keeps whatever the shadow control last decided; a boolean sets it.
  // Passing nothing must NOT silently turn shadows off: they are their own axis,
  // not a side effect of the preset.
  if (shadows !== null) renderer.shadowMap.enabled = !!shadows;
  renderer.shadowMap.needsUpdate = true;
}

/**
 * Turn shadows on or off AND make it take effect.
 *
 * `renderer.shadowMap.enabled` is compiled into every shader: three bakes
 * `USE_SHADOWMAP` into the program at build time, so flipping the flag after the
 * first frame changes nothing at all until the materials are rebuilt. Measured:
 * with the flag `true`, every mesh armed to cast and the sun `castShadow`, renders
 * across the toggle come back BYTE-IDENTICAL.
 * `shadowMap.needsUpdate` is not that: it re-renders the map, it does not
 * recompile the shaders that sample it.
 *
 * So the flag and the recompile go together, in one function, and nothing sets
 * the flag on its own.
 */
export function setShadows(renderer, scene, on) {
  renderer.shadowMap.enabled = !!on;
  renderer.shadowMap.needsUpdate = true;
  scene?.traverse?.(o => {
    const m = o.material;
    if (!m) return;
    if (Array.isArray(m)) m.forEach(x => { if (x) x.needsUpdate = true; });
    else m.needsUpdate = true;
  });
}
