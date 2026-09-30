// One icon set, drawn rather than typed.
//
// This is a tool for designers, and unicode glyphs — ⛰ ⟺ ⬚ ❦ ⊞ ◳ ⤢ ▤ ◈ ⌖ ☀ —
// make a shell look bare. They come from whatever font resolves them, so they
// arrive at different weights, different optical sizes, different baselines and
// different metrics, and no amount of spacing fixes a row of symbols that were
// never drawn as a set.
//
// These are one set: 24-unit grid, 1.6 stroke, round caps and joins, currentColor
// so every state the CSS defines just works.

const SVG = (body, { size = 20, stroke = 1.6 } = {}) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none"
        stroke="currentColor" stroke-width="${stroke}"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/** path data only, so the wrapper stays in one place */
const D = {
  // ── rail: the surfaces ──
  objects: '<path d="M12 3.5 3.5 8l8.5 4.5L20.5 8 12 3.5Z"/><path d="M3.5 12.5 12 17l8.5-4.5"/><path d="M3.5 16.5 12 21l8.5-4.5"/>',
  designs: '<path d="M5 4.5h9l5 5V19a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19V6a1.5 1.5 0 0 1 1.5-1.5Z"/><path d="M14 4.5V10h5"/><path d="M8.5 14h7M8.5 17h4.5"/>',
  places:  '<path d="M12 21s6.5-5.6 6.5-10.5a6.5 6.5 0 1 0-13 0C5.5 15.4 12 21 12 21Z"/><circle cx="12" cy="10.5" r="2.4"/>',
  view:    '<circle cx="12" cy="12" r="3.6"/><path d="M12 3v2.2M12 18.8V21M21 12h-2.2M5.2 12H3M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6M18.4 18.4l-1.6-1.6M7.2 7.2 5.6 5.6"/>',

  // ── dock: the tools ──
  walk:    '<circle cx="13" cy="4.6" r="1.9"/><path d="M11.4 21.5 13 15l-2.6-2.2.9-4.3 3.4 1.7 1.1 2.6 2.6.9"/><path d="M10.4 8.5 7.6 10l-1 3.2"/><path d="M13 15l2.9 2.2.8 4.3"/>',
  pointer: '<path d="M6.2 3.6 18.4 12.4l-5.5 1.2 3.1 6.1-2.4 1.2-3.1-6.2-4.3 3.6V3.6Z"/>',
  measure: '<path d="M3.2 14.6 14.6 3.2a1.2 1.2 0 0 1 1.7 0l4.5 4.5a1.2 1.2 0 0 1 0 1.7L9.4 20.8a1.2 1.2 0 0 1-1.7 0l-4.5-4.5a1.2 1.2 0 0 1 0-1.7Z"/><path d="M7.6 10.2 9.4 12M10.6 7.2l2.6 2.6M13.6 4.2l1.8 1.8"/>',
  // a dashed loop thrown round three things: the same gesture as `area`, but
  // what it encloses is a SELECTION rather than a named region
  select:  '<path d="M4 9.5c2.2-3.4 6-5.2 9.6-4.6 3.3.6 6 3 6.4 6.1.4 3.2-1.8 6.3-5.3 7.4-3.9 1.2-8.3-.3-10.2-3.4-1-1.7-1.1-3.8-.5-5.5Z" stroke-dasharray="2.6 2.4"/><circle cx="9.6" cy="10.4" r="1.6" fill="currentColor" stroke="none"/><circle cx="14.4" cy="9.2" r="1.6" fill="currentColor" stroke="none"/><circle cx="12.2" cy="14.2" r="1.6" fill="currentColor" stroke="none"/>',
  area:    '<path d="M4.5 7.5 12 4l7.5 3.5-1.4 9.3L12 20l-6.1-3.2L4.5 7.5Z" stroke-dasharray="3 2.4"/><circle cx="12" cy="4" r="1.5" fill="currentColor" stroke="none"/><circle cx="19.5" cy="7.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="20" r="1.5" fill="currentColor" stroke="none"/><circle cx="4.5" cy="7.5" r="1.5" fill="currentColor" stroke="none"/>',
  add:     '<path d="M12 20c0-5 1.6-8.2 5.4-10.2C19 8.9 20 7.3 20 5.4c-4.8-.6-8 1-9.6 4.2"/><path d="M12 20c0-3.6-1-6-3.4-7.6C7 11.3 6.2 10 6.2 8.4c3.6-.4 6 .8 7.2 3.2"/><path d="M12 20v-4"/>',
  plan:    '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M3.5 10.2h17M10.2 3.5v17"/>',
  cube:    '<path d="M12 3 4 7.2v9.6L12 21l8-4.2V7.2L12 3Z"/><path d="M4 7.2 12 11.6l8-4.4M12 11.6V21"/>',
  frame:   '<path d="M4 9V5.4A1.4 1.4 0 0 1 5.4 4H9M15 4h3.6A1.4 1.4 0 0 1 20 5.4V9M20 15v3.6a1.4 1.4 0 0 1-1.4 1.4H15M9 20H5.4A1.4 1.4 0 0 1 4 18.6V15"/>',

  // ── ui ──
  close:    '<path d="M6.4 6.4 17.6 17.6M17.6 6.4 6.4 17.6"/>',
  chevronL: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  search:   '<circle cx="10.8" cy="10.8" r="6.3"/><path d="M15.4 15.4 20.5 20.5"/>',
  undo:     '<path d="M8.5 8.5 4.5 12l4 3.5"/><path d="M4.5 12h9a5.5 5.5 0 0 1 0 11H10"/>',
  redo:     '<path d="M15.5 8.5 19.5 12l-4 3.5"/><path d="M19.5 12h-9a5.5 5.5 0 0 0 0 11H14"/>',
  eye:      '<path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.9"/>',
  // A PHOTO CAMERA, so that no two buttons wear `frame` — one in the top bar
  // meaning "fit the whole yard in view" and one in the dock about photographs.
  // The same glyph in two bars reads as the same button and confuses. Taking a
  // picture is not framing a view, and it must not look like it.
  camera:   '<path d="M3.5 8.2h3.2l1.5-2.4h7.6l1.5 2.4h3.2A1.5 1.5 0 0 1 22 9.7v8.3a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 2 18V9.7a1.5 1.5 0 0 1 1.5-1.5Z"/><circle cx="12" cy="13.6" r="3.4"/>',
  eyeOff:   '<path d="M9.6 5.9A9.3 9.3 0 0 1 12 5.6c6 0 9.5 6.2 9.5 6.2a17 17 0 0 1-3.3 4M6 7.7A17 17 0 0 0 2.5 11.8s3.5 6.2 9.5 6.2c1 0 1.9-.2 2.8-.5"/><path d="M4 4l16 16"/>',
  lock:     '<rect x="5" y="10.5" width="14" height="9.5" rx="1.8"/><path d="M8.2 10.5V7.8a3.8 3.8 0 0 1 7.6 0v2.7"/>',
  more:     '<circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  trash:    '<path d="M4.5 6.8h15M9.5 6.8V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2v1.6"/><path d="M6.8 6.8 7.7 19a1.4 1.4 0 0 0 1.4 1.3h5.8A1.4 1.4 0 0 0 16.3 19l.9-12.2"/>',
};

/** `icon("objects")` -> an SVG string. Unknown names draw a dot, never nothing. */
export function icon(name, opts) {
  return SVG(D[name] ?? '<circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/>', opts);
}

export const ICON_NAMES = Object.keys(D);
