// node --test tests/js/
//
// Camera presets and snapping — two things a tool needs before you would
// recognise it as a 3D editor.
//
// Camera presets: the user must be able to change the camera angle while
// viewing, not only look from the top or frame everything. Every 3D app has the
// six standard views, because "look at it from the north" is a thing you do
// twenty times an hour and orbiting there by hand is not the same as being there.
//
// Snapping: without it nothing lines up. A path that should meet a terrace edge
// lands 4 cm off, and the owner cannot see 4 cm on screen — they find it later
// when the validator complains or the render looks wrong. Grid, and the object
// under the cursor, are the two that matter here.
//
// The maths is pure and lives in flycam.js / a snap module so it can be tested
// without a GPU; main.js only wires it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const snap = await import(path.join(ROOT, "viewer", "src", "snap.js"));
const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");
const code = main.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

// ── snapping ──────────────────────────────────────────────────────────────
test("a point snaps to the grid when it is close enough, and not otherwise", () => {
  // the tolerance is the whole design: snap always and you cannot place anything
  // off-grid, snap never and nothing lines up
  assert.deepEqual(snap.toGrid([3.02, 5.97], 0.5, 0.08), [3.0, 6.0]);
  assert.deepEqual(snap.toGrid([3.22, 5.71], 0.5, 0.08), [3.22, 5.71],
    "it snapped a point that was 22 cm from the line");
  assert.deepEqual(snap.toGrid([3.02, 5.97], 0.5, 0), [3.02, 5.97],
    "a zero tolerance still snapped — that is the off switch");
});

test("grid spacing is respected, not hardcoded", () => {
  assert.deepEqual(snap.toGrid([1.04, 2.03], 0.25, 0.08), [1.0, 2.0]);
  assert.deepEqual(snap.toGrid([1.04, 2.03], 1.0, 0.08), [1.0, 2.0]);
  assert.deepEqual(snap.toGrid([1.4, 2.4], 1.0, 0.08), [1.4, 2.4]);
});

test("a point snaps to another object's point before it snaps to the grid", () => {
  // meeting the terrace corner exactly matters more than sitting on a round
  // number, and a grid snap would quietly pull it 3 cm off the thing it meets
  const others = [[3.03, 5.99], [10, 10]];
  assert.deepEqual(snap.toNearest([3.0, 6.0], others, 0.5, 0.08), [3.03, 5.99]);
});

test("nothing to snap to leaves the point exactly where it was", () => {
  assert.deepEqual(snap.toNearest([3.37, 5.11], [], 0.5, 0.08), [3.37, 5.11]);
  assert.deepEqual(snap.toNearest([3.37, 5.11], null, 0, 0), [3.37, 5.11]);
});

test("an angle snaps to the nearest step within tolerance", () => {
  assert.equal(snap.toAngle(43, 15, 5), 45);
  assert.equal(snap.toAngle(37, 15, 5), 37, "37 is 8 deg from 45 and was pulled anyway");
  assert.equal(snap.toAngle(-2, 15, 5), 0);
  assert.equal(snap.toAngle(43, 15, 0), 43, "zero tolerance is the off switch");
});

test("snapping is off unless it is asked for", () => {
  // snapping is a convenience, not a rule; a snap that cannot be turned off is one
  assert.match(html, /id="snapOn"/, "no way to turn snapping on or off");
  assert.match(code, /snapOn/, "the checkbox is never read");
});

test("the drag paths use the shared snap, not their own arithmetic", () => {
  assert.match(code, /from\s*["']\.\/snap\.js["']/, "main.js does not import snap.js");
  for (const fn of ["toNearest", "toGrid"]) {
    assert.ok(code.includes(fn), `${fn} is imported and never used`);
  }
  assert.doesNotMatch(code, /Math\.round\([^)]*\/\s*gridStep/,
    "main.js has grown its own copy of the grid arithmetic");
});

// ── camera presets ────────────────────────────────────────────────────────
test("there are the standard views, not just top", () => {
  for (const id of ["viewTop", "viewFront", "viewSide", "viewIso"]) {
    assert.match(html, new RegExp(`id="${id}"`), `no ${id} control`);
  }
  assert.match(code, /function setView/, "nothing implements the presets");
});

test("each preset aims at what is THERE, not at the origin", () => {
  // a fixed camera position is useless on a property whose design sits 15 m off
  // the origin — every preset frames the design's own bounds
  const body = code.slice(code.indexOf("function setView"), code.indexOf("function setView") + 1400);
  assert.ok(body.length > 80, "setView not found");
  assert.match(body, /boundsOf|getCenter/, "the presets do not look at the design's bounds");
  assert.match(body, /controls\.target/, "the presets do not move the orbit target");
});

test("the presets are reachable from the shell, where the other daily tools are", () => {
  // Each preset is a NAMED command, which is strictly better than a cycle
  // button: saying "front view" beats pressing a button until front arrives.
  const src = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
  for (const id of ["view.front", "view.side", "view.iso", "view.top"])
    assert.ok(src.includes(`"${id}"`), `${id} is not a command`);
  // There is no cycler: pressing a button until the view you wanted comes round
  // is not a choice. A Camera menu names all four instead.
  // search for the END anchor FROM the start anchor. main.js has many
  // addEventListener calls and the first is long before the dock, so an
  // indexOf from 0 gives a backwards slice and an empty string — which then
  // fails with a true-sounding message about a test that has read nothing at
  // all.
  // The menu is on the TOP bar. The bottom tool bar is for action — adding and
  // drawing things — and the left panel is for managing and looking at existing
  // things. A camera preset does neither — it changes how you are LOOKING — so
  // it sits with the rest of the viewport chrome.
  const from = src.indexOf("const topBar = mountTopBar({");
  const bar = src.slice(from, src.indexOf("const dock = mountDock(DOCK_TOOLS,", from));
  assert.match(bar, /onCamera: ev =>/, "the top bar has no camera control");
  for (const id of ["view.top", "view.front", "view.side", "view.iso"])
    assert.ok(bar.includes(`"${id}"`), `${id} is not on the top bar's camera menu`);
});

test("“See the whole yard” frames the YARD, not the whole capture", () => {
  // Measured on this property: the scan is 41 m by 35 and runs west to x = -22
  // across the neighbour's ground, because a scanner records whatever it can
  // see. The garden is 9 m by 29. Framing design + scan pulls the camera 82 m
  // back and leaves the yard a small island with two thirds of the picture spent
  // on somebody else's lawn.
  //
  // The yard is what the OWNER has claimed — what is designed, the regions they
  // drew, the points they marked. All three are owner ground truth, which is
  // exactly what makes them the right definition: the scan's extent is an
  // accident of where the scanner could see.
  const src = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
  const code = src.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.match(code, /function yardBounds\(\)/, "there is no definition of the yard");
  const body = code.slice(code.indexOf("function yardBounds()"),
                          code.indexOf("function frameAll()"));
  for (const owned of ["designGroup", "areaGroup", "markers"])
    assert.ok(body.includes(owned), `the yard does not include ${owned}`);
  // the scan is the FALLBACK, for a fresh capture with nothing on it yet
  assert.match(body, /\?\?\s*boundsOf\(\[stage\]\)/,
    "the scan is not the fallback — either it is the definition again, or a "
    + "fresh property frames nothing at all");
  // and all three framings use it, not just the button the user pressed
  // SLICED TO THE NEXT FUNCTION, not to a fixed number of characters. A 220-char
  // window runs past the end of `frameAll` into `topView`, finds the call THERE,
  // and passes with frameAll mutated back to the whole capture.
  for (const fn of ["function frameAll()", "function topView()", "function setView(which)"]) {
    const at = code.indexOf(fn);
    assert.ok(at > 0, `${fn} is gone`);
    const next = code.indexOf("\nfunction ", at + fn.length);
    const body = code.slice(at, next > 0 ? next : code.length);
    // setView is long (four presets and their maths); the bound only has to
    // stop before the NEXT function, which it does
    assert.ok(body.length < 6000, `${fn}'s body did not end where expected`);
    assert.match(body, /yardBounds\(\)/, `${fn} still frames the whole capture`);
  }
});
