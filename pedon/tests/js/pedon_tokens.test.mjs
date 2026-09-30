// node --test tests/js/pedon_tokens.test.mjs
//
// The PEDON token system: the viewer's colours are named tokens in one stylesheet
// (viewer/src/pedon.css), not hard-coded values scattered through inline CSS.
//
// The tests that matter here are not "does a token exist" — they are the two
// decisions the palette is built on, which a later edit could quietly undo:
// the accent is NOT green (the garden supplies more greens than any palette can
// compete with, so a green accent vanishes the moment it sits over planting),
// and the semantic colours are kept apart from the accent (one amber for both
// "active" and "warning" makes every active control look like a problem).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const css = fs.readFileSync(path.join(ROOT, "viewer", "src", "pedon.css"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");

const token = name => (css.match(new RegExp(`--${name}:\\s*([^;]+);`)) ?? [])[1]?.trim();

/** #rrggbb -> hue in degrees, and saturation, so "is this green" is measurable */
function hsl(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  assert.ok(m, `not a hex colour: ${hex}`);
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: mx ? d / mx : 0, l: (mx + mn) / 2 };
}

test("the stylesheet is linked, and the old inline :root block is gone", () => {
  assert.match(html, /src\/pedon\.css/, "the token sheet is not linked from index.html");
  assert.ok(!/--bg:\s*#101512/.test(html),
    "the inline :root still hard-codes --bg, so the tokens are being overridden");
});

test("the accent is NOT green — it has to survive being shown over planting", () => {
  const { h, s } = hsl(token("p-clay"));
  assert.ok(s > 0.3, `the accent is nearly grey (sat ${s.toFixed(2)})`);
  assert.ok(h < 60 || h > 300,
    `the accent sits at hue ${Math.round(h)}deg, inside the range the garden itself `
    + `occupies — it will disappear over foliage`);
});

test("semantic colours are distinct from the accent", () => {
  // one amber for both "active" and "warning" makes every active control read
  // as a problem, which is why --p-warn and --p-clay are separate tokens
  const clay = hsl(token("p-clay")), warn = hsl(token("p-warn"));
  assert.ok(Math.abs(clay.h - warn.h) > 8,
    `accent ${Math.round(clay.h)}deg and warn ${Math.round(warn.h)}deg are the same colour`);
  for (const n of ["p-ok", "p-warn", "p-bad", "p-select"])
    assert.ok(token(n), `semantic token --${n} is missing`);
});

test("the surfaces are warm-biased, not neutral grey", () => {
  // a pure grey against warm foliage reads as a screenshot of an app; the bias
  // is what makes the chrome sit behind the yard instead of on top of it
  for (const n of ["p-soil-900", "p-soil-800", "p-soil-700"]) {
    const { s } = hsl(token(n));
    assert.ok(s > 0.02, `--${n} is neutral grey (sat ${s.toFixed(3)})`);
  }
});

test("text on the darkest surface clears WCAG AA for body copy", () => {
  const lum = hex => {
    const n = parseInt(hex.slice(1), 16);
    const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const bg = token("p-soil-900");
  assert.ok(ratio(token("p-ink"), bg) >= 4.5,
    `body text is ${ratio(token("p-ink"), bg).toFixed(2)}:1 on the app background`);
  assert.ok(ratio(token("p-dim"), bg) >= 3.0,
    `secondary text is ${ratio(token("p-dim"), bg).toFixed(2)}:1, below the large-text floor`);
});

test("the old variable names are aliases, so the existing panel still resolves", () => {
  // markup that still uses the short names keeps working without being rewritten
  for (const old of ["bg", "panel", "line", "ink", "dim", "accent", "sel"])
    assert.match(css, new RegExp(`--${old}:\\s*(var\\(--p-|color-mix|#)`),
      `--${old} was dropped; the existing panel depends on it`);
});

test("motion is disabled under prefers-reduced-motion", () => {
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  const block = css.slice(css.indexOf("prefers-reduced-motion"));
  assert.match(block.slice(0, 200), /--p-base:\s*0ms/);
});

test("a floating surface gets a lit edge, not only a shadow", () => {
  // it sits over a dark 3D scene, where a drop shadow alone is invisible
  assert.match(token("p-shadow-2"), /rgba\(255,255,255/,
    "the elevation token has no light edge, so a popover will vanish over planting");
});
