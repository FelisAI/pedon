// What the app draws for its own operator, and the model must never see.
//
// The grid, the axes, the north arrow and the cyan landmark pins are working
// furniture. Rendered into a frame they read as part of the garden, and a model
// shown that frame reads them as design objects: a GridHelper drawn in green
// straight across the terrain and the design gets critiqued as part of it.
//
// Every render path strips it — the walkthrough, the naming pass and the render
// broker alike. This lives in its own module because BOTH main.js and
// viewport.js need it, and viewport.js is imported BY main.js — importing back
// the other way would be a cycle.
// "gizmo" and the handles: the transform arrows, the rotation rings and the
// reshape dots are EDITING UI, and they would otherwise leak into every render
// the design agent and the owner review from — an object selected in the owner's
// viewer while a `look` is taken puts an orange rotation ring across the middle
// of the picture. A render for judging a garden must not contain the tools for
// changing it.
const FURNITURE_NAMES = ["markers", "proposals", "areas", "livearea",
                         "gizmo", "handles", "measure"];

function isFurniture(o, parent) {
  if (/Helper$/.test(o.type)) return true;         // the grid, the axes, the north arrow
  if (FURNITURE_NAMES.includes(o.name)) return true;
  // the footprint overlay mixes the two: the red house outline is measured site
  // truth and belongs in the picture, the cyan pins standing on it do not
  return parent?.name === "footprint" && o.name !== "houseOutline";
}

/**
 * Run `fn` with the app's furniture hidden, and put the scene back exactly as it
 * was — including leaving alone anything that was ALREADY hidden, so a layer the
 * owner switched off does not come back on.
 *
 * `keep` names groups the caller is deliberately photographing: the naming pass
 * exists to show the model the numbered proposal discs.
 *
 * An async `fn` (the walkthrough is one) holds the scene clean until its promise
 * settles — restoring on return would put the grid back before the later frames
 * were taken.
 */
export function withCleanScene(scene, fn, { keep = [] } = {}) {
  const hidden = [];
  (function walk(o, parent) {
    if (!o.visible || keep.includes(o.name)) return;
    if (isFurniture(o, parent)) { o.visible = false; hidden.push(o); return; }
    for (const c of o.children ?? []) walk(c, o);   // a hidden group hides its own children
  })(scene, null);
  const restore = () => { for (const o of hidden) o.visible = true; };
  let out;
  try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === "function") return Promise.resolve(out).finally(restore);
  restore();
  return out;
}
