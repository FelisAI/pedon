// node --test tests/js/
//
// Object movement must be deliberate, and the displayed design must be named.
//
// Selection is required before moving an object. A drag across empty design
// or an object's body orbits the camera; only handles move the selection.
// A 5 px drag threshold alone still permits a nudge from a 6 px hand tremor.
//
// The UI must name the design on screen so the user can distinguish variants.
// Keeping `currentVariant` in main.js is insufficient without a visible label.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");
const code = main.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

function fnBody(name, span = 2200) {
  const i = code.search(new RegExp(`function\\s+${name}\\s*\\(`));
  assert.notEqual(i, -1, `${name} not found`);
  return code.slice(i, i + span);
}

// ── Nothing moves unless you aim at a handle ──────────────────────────────
//
// Selection alone does not prevent accidental movement. A body drag moves the
// camera; moving the object requires a deliberate grab of a handle.
test("a drag on an object's BODY does not move it", () => {
  // Moving from any point on a selected object permits accidental nudges.
  // The ways to move are the gizmo arrows and the control points.
  assert.doesNotMatch(code, /objDrag/,
    "body-drag machinery lets a press on a selected object move it");
  assert.match(code, /if \(grab === "orbit"\)/,
    "a press that belongs to nothing else must fall through to the camera");
});

test("the pixel dead zone applies to the gizmo drag", () => {
  // a gizmo arrow is grabbed with a click, so it needs a dead zone:
  // four pixels of tremor is 20 cm of site zoomed out
  assert.match(code, /DRAG_THRESHOLD_PX/, "the gizmo drag has no dead zone");
  const i = code.indexOf("function updateGizmoDrag");
  assert.notEqual(i, -1, "the gizmo drag moved; fix this test");
  assert.match(code.slice(i, i + 600), /DRAG_THRESHOLD_PX/,
    "the gizmo engages on the first pointermove, so a click on an arrow nudges");
});

test("clicking an unselected object selects it, so the first click is not wasted", () => {
  // Anchored on the selection branch itself rather than on a pickDesignObject
  // call site: the LAST occurrence of that name is the function definition, not a
  // caller, so using it as an anchor can inspect the wrong part of the file.
  // The branch's own comment is the anchor. `setSelection(selection.size === 1`
  // also appears in the Objects row handler, so it cannot reliably identify
  // the click-to-select branch.
  // `code` has every comment line stripped, so the anchor is read off `main`
  const i = main.indexOf("// plain click selects a design object");
  assert.notEqual(i, -1, "the click-to-select branch moved; fix this test");
  const body = main.slice(i, i + 1400);
  assert.match(body, /shiftKey|metaKey/, "no way to add to the selection");
  // toggling a LIST, not one id: a grouped object is picked as its whole group
  assert.match(body, /for \(const x of ids\) all \? selection\.delete\(x\) : selection\.add\(x\)/,
    "shift-click does not toggle membership");
  assert.match(body, /setSelection\(same \? \[\] : ids\)/,
    "a plain click no longer replaces the selection with what it picked");
});

// ── Say which design is on screen ────────────────────────────────────────
test("the viewer says which design it is rendering", () => {
  assert.match(html, /id="whichDesign"/,
    "no element names the design on screen — the user has 30-odd variants and "
    + "no way to tell which one they are looking at");
  assert.match(code, /getElementById\("whichDesign"\)/, "the element is never filled in");
});

test("it updates when the design changes, not only when the page loads", () => {
  assert.match(fnBody("refreshDesignList"), /whichDesign|showWhichDesign/,
    "the label is set once and then lies as soon as the user loads a variant");
});

test("it distinguishes the working design from a saved variant and from a preview", () => {
  // distinguish all three states: a preview deliberately shows a design other
  // than the user's working design
  const body = fnBody("showWhichDesign", 1400);
  assert.match(body, /previewSource|preview/i, "a preview is not distinguished");
  assert.match(body, /currentVariant/, "a loaded variant is not named");
});
