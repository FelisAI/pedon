// node --test tests/js/
//
// Placing by hand goes through an asset picker, like importing an asset in a 3D
// editor: open the library, pick the thing, put it down. An asset window that is
// a SECOND place to browse, beside the <select> it replaces, leaves the unusable
// dropdown as the control you actually choose with, and the picker with the
// pictures an optional detour.
//
// The <select> stays as the STATE, hidden. It is the single source `pickedEntry()`
// reads, and ui_palette.test.mjs asserts there is exactly one DOM read of it —
// swapping the storage as well as the interface would mean rewriting the whole
// selection layer to change a control. What changes is what the user SEES and
// clicks.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");
const code = main.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

test("the dropdown is not the thing the user chooses with", () => {
  const sel = html.match(/<select id="placeWhat"[^>]*>/);
  assert.ok(sel, "placeWhat is gone entirely — pickedEntry() reads it");
  assert.match(sel[0], /\bhidden\b/,
    "the <select> is still on screen: the picker sits BESIDE the control it "
    + "is meant to replace, so the unusable dropdown is still the one "
    + "you use");
});

test("what you click to choose is a tile that shows the current pick", () => {
  assert.match(html, /id="pickTile"/, "no visible chooser at all");
  assert.match(code, /getElementById\("pickTile"\)/, "the tile is never filled in or wired");
  const body = code.slice(code.indexOf("function renderPickTile"),
                          code.indexOf("function renderPickTile") + 1600);
  assert.ok(body.length > 100, "renderPickTile not found");
  // entryThumb dispatches between plants and OBJECTS in the picker; it must
  // still reach plantThumb for a plant, or the tile silently loses its picture
  assert.match(body, /entryThumb\(/,
    "the tile shows no picture — the user picks by seeing the photo/model of the plant");
  // (deferred: `later` gets the picture when it is drawn — plantThumbLater)
  assert.match(code, /entryThumb\s*=\s*\(e, later\)\s*=>[^;]*plantThumbLater\(e, later\)[^;]*plantThumb\(e\)/,
    "entryThumb no longer reaches plantThumb — every plant tile would be blank");
  assert.match(body, /pickedEntry\(/, "the tile does not show what is actually picked");
});

test("clicking the tile opens the asset window", () => {
  // anchored on the HANDLER, not the first mention: renderPickTile also looks the
  // element up, and slicing from there tests the wrong 400 characters
  const i = code.indexOf('getElementById("pickTile").onclick');
  assert.notEqual(i, -1, "the tile has no click handler");
  assert.match(code.slice(i, i + 200), /showAssets\(true\)/, "the tile does not open the picker");
});

test("picking a card puts you straight into placing", () => {
  // choose the thing, then click the ground. Leaving the window open and the
  // mode unarmed makes it a catalogue again.
  // the WHOLE function, not a fixed 2600 characters: code such as the ☆ mine toggle
  // pushes the click handler past a fixed cut, and a cut that silently shrinks is a vacuous test
  const at = code.indexOf("function assetCard");
  const body = code.slice(at, code.indexOf("\n}", at));
  assert.match(body, /pickEntry\(/, "a card does not set the pick");
  assert.match(body, /showAssets\(false\)/, "the window stays open over the garden");
  assert.match(body, /setMode\("place"\)/,
    "after picking you still have to find and press Place — that is the detour "
    + "the picker exists to remove");
});

test("the tile keeps up with the pick, wherever it was changed from", () => {
  assert.match(code, /renderPickTile\(\)/, "renderPickTile is never called");
  const i = code.indexOf("function pickEntry");
  assert.match(code.slice(i, i + 400), /renderPickTile\(\)/,
    "setting the pick does not refresh the tile, so it shows the previous plant");
});

test("there is still exactly ONE DOM read of what is picked", () => {
  // the invariant ui_palette.test.mjs guards; a tile that read the select itself
  // would be the second reader
  const hits = [...code.matchAll(/getElementById\("placeWhat"\)\s*\.\s*value/g)];
  assert.equal(hits.length, 1, `the pick is read from the DOM in ${hits.length} places`);
});
