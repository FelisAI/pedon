// node --test tests/js/ui_drag_threshold.test.mjs
//
// A click must not nudge the thing it clicked.
//
// Dragging an object's BODY does not move it — allowing a move from any point on
// it makes moving something by accident far too easy — so the dead zone guards
// the gizmo drag, the gesture that moves things. The reasoning below is why a
// PIXEL threshold.
//
// A click meant as a click must not move the object slightly. Dragging requires
// the object to be SELECTED first, but once selected, a drag with no dead zone
// engages on the very first pointermove with zero slack, so pointer jitter between
// down and up becomes a real edit: an op posted, design.json written, a timeline
// entry added.
//
// The existing guard cannot help, and the reason is worth keeping. moveOps has
// `if (!ddx && !ddy) return []` — under a stored centimetre is not a move — but
// that is measured in METRES while intent is expressed in PIXELS. Zoomed out, four
// pixels of tremor is 20 cm of yard and passes the centimetre test easily; zoomed
// in, a deliberate 5 cm nudge is half a pixel and would be discarded. One
// threshold in world units cannot tell "the hand slipped" from "the hand meant it"
// at two zooms.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");

function blockAfter(anchor, chars = 1400) {
  const i = src.indexOf(anchor);
  assert.notStrictEqual(i, -1, `anchor "${anchor}" is gone — retarget this test`);
  return src.slice(i, i + chars);
}

test("the gesture this file guards is the GIZMO drag, and the body drag is gone", () => {
  assert.doesNotMatch(src, /objDrag/, "the body drag is back without a dead zone of its own");
  assert.match(src, /function updateGizmoDrag/, "the gizmo drag moved; retarget this test");
  assert.ok(/selection\.has\(id\)/.test(src),
    "select-before-anything is gone — that half of the guard must not regress");
});

test("a drag threshold exists, and it is in pixels", () => {
  assert.match(src, /DRAG_THRESHOLD_PX|dragThresholdPx/,
    "no pixel dead zone: the drag engages on the first pointermove, so hand tremor " +
    "between down and up writes an op to disk");
  const m = /DRAG_THRESHOLD_PX\s*=\s*(\d+(?:\.\d+)?)/.exec(src);
  assert.ok(m, "the threshold should be a named constant, not a literal in the handler");
  const px = parseFloat(m[1]);
  assert.ok(px >= 3 && px <= 12,
    `${px}px is outside the useful band: under 3 does not cover tremor, over 12 ` +
    `makes a deliberate short drag feel broken`);
});

test("the threshold is measured from where the pointer went DOWN", () => {
  const down = blockAfter("const d = { part, frame: f", 900);
  assert.match(down, /at: \[ev\.clientX/,
    "the gizmo press records no screen position, so no pixel distance can be measured");
});

test("nothing moves until the dead zone is crossed", () => {
  const move = blockAfter("function updateGizmoDrag", 700);
  assert.match(move, /engaged/, "the gizmo moves the selection on the first pointermove");
  assert.match(move, /Math\.hypot\(ev\.clientX - d\.at\[0\], ev\.clientY - d\.at\[1\]\) < DRAG_THRESHOLD_PX/,
    "the dead zone is not measured from the press");
});

test("a sub-threshold release puts the preview back", () => {
  // Otherwise the object sits visually nudged while the file says otherwise, and a
  // scene that disagrees with disk shows the user a design that is not saved.
  const i = src.indexOf("async function endGizmoDrag");
  assert.notEqual(i, -1, "the gizmo release moved; retarget this test");
  assert.match(src.slice(i, i + 1200), /position\.copy\(n?\.?base\)|copy\(base\)/,
    "the preview is not restored when the move is abandoned");
});
