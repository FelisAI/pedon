// node --test tests/js/place_ghost.test.mjs
//
// In place mode the picked asset is drawn at the mouse position, so the user can
// see what they are about to put down before they place it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const body = (from, to) => main.slice(main.indexOf(from), main.indexOf(to, main.indexOf(from) + 1));

test("place mode draws what you are about to put down, and follows the cursor", () => {
  assert.match(body("function setMode(m)", "\nfunction "), /if \(m === "place"\) \{\s*\n\s*buildPlaceGhost\(\)/,
    "entering place mode builds no preview");
  assert.match(main, /pointermove", ev => \{\s*\n\s*if \(mode === "place"\) movePlaceGhost\(ev\)/,
    "the preview does not follow the cursor");
});

test("it is built once per picked asset, not per mouse move", () => {
  const build = body("async function buildPlaceGhost()", "\nfunction movePlaceGhost");
  assert.match(build, /if \(key === placeGhostKey\) return;/,
    "a 2 M-triangle shrub would be rebuilt on every pointermove");
  assert.match(build, /renderQuality|growthScale\(\)/, "the key ignores the size and detail it was built at");
  const move = body("function movePlaceGhost(ev)", "\n/** A click in place mode");
  assert.doesNotMatch(move, /buildDesignGroup|buildPlant/, "the move path rebuilds geometry");
});

test("the preview is a ghost, is not the design, and is cleaned up", () => {
  const build = body("async function buildPlaceGhost()", "\nfunction movePlaceGhost");
  assert.match(build, /opacity = \(m\.opacity \?\? 1\) \* 0\.5/, "the preview is drawn as solid as the real thing");
  assert.match(build, /designsGroup\.add\(g\)/, "the ghost is parented somewhere else than the design's own frame");
  assert.doesNotMatch(build, /designGroup\.add/, "a ghost inside designGroup would be picked, measured and exported");
  assert.match(body("function setMode(m)", "\nfunction "), /if \(m !== "place"\) clearPlaceGhost\(\);/,
    "leaving place mode keeps the ghost on screen");
  assert.match(body("function clearPlaceGhost()", "\nasync function buildPlaceGhost"), /disposeObj\(placeGhost, "mesh"\)/,
    "the ghost's geometry leaks");
});

test("hovering empty sky hides it, and says nothing", () => {
  const move = body("function movePlaceGhost(ev)", "\n/** A click in place mode");
  assert.match(move, /pickSurface\(ev, \{ quiet: true \}\)/,
    "every mouse move over the sky would log 'click missed the scanned ground'");
  assert.match(move, /placeGhost\.visible = !!p/, "the ghost stays put when the cursor leaves the ground");
  assert.match(move, /worldToEnu\(p\)[\s\S]*enuToWorld\(/,
    "a raycast answers in world; placing it without converting mixes the ENU and world frames");
});

test("Esc takes the ghost off the screen, from wherever it hangs", () => {
  // After Add and Esc no shadow plant may be left on the screen. The ghost hangs from
  // designsGroup, and `enuGroup.remove(...)` detaches only a DIRECT child: Esc would leave
  // the mode with the plant still standing, label and all. Measured in the app:
  // 8,048,428 triangles before Add, 8,071,856 with the ghost, 8,048,428 after Esc.
  const src = fs.readFileSync(new URL("../../viewer/src/main.js", import.meta.url), "utf8");
  const clear = src.slice(src.indexOf("function clearPlaceGhost()"), src.indexOf("function wantedGhostKey()"));
  assert.match(clear, /placeGhost\.removeFromParent\(\);/, "the ghost is detached from a parent it may not have");
  assert.ok(!/enuGroup\.remove\(placeGhost\)/.test(clear), "the ghost is removed from enuGroup, which is not its parent");
  // and one still being built when Esc lands is dropped, not added to a finished mode
  const build = src.slice(src.indexOf("async function buildPlaceGhost()"), src.indexOf("function movePlaceGhost"));
  assert.match(build, /if \(mode !== "place" \|\| key !== wantedGhostKey\(\)\) \{\s*disposeObj\(g, "mesh"\);\s*return;/,
    "a ghost that finishes building after Esc is still added to the scene");
});
