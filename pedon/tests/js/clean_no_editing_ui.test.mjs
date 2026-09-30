// node --test tests/js/clean_no_editing_ui.test.mjs
//
// A render for JUDGING a garden must not contain the tools for CHANGING it.
//
// A `look` taken through the broker while the owner has an object selected in
// their own viewer would come back with an orange rotation ring across the middle
// of the picture. The gizmo, the reshape handles and the measure line are editing
// UI and belong to the person editing, not to the picture.
//
// withCleanScene strips the grid, the axes and the cyan pins for the same reason;
// the editing UI is the same class.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const clean = fs.readFileSync(path.join(ROOT, "viewer", "src", "clean.js"), "utf8");
const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");

test("the editing UI is named as furniture", () => {
  for (const n of ["gizmo", "handles", "measure"]) {
    assert.match(clean, new RegExp(`"${n}"`),
      `"${n}" is not hidden for a clean render, so it can appear in a review frame`);
  }
});

test("EVERY name in the list is one main.js actually uses", () => {
  // A furniture list naming a group that does not exist hides nothing while
  // reading as though it does. A test written against a few known names passes
  // with a phantom entry (say "liveLasso" where the real group is "livearea")
  // sitting in the array. Iterate the array itself so a dead entry cannot hide.
  const lit = clean.slice(clean.indexOf("const FURNITURE_NAMES"));
  const names = [...lit.slice(lit.indexOf("["), lit.indexOf("]")).matchAll(/"([^"]+)"/g)]
    .map(m => m[1]);
  assert.ok(names.length >= 6, `only found ${names.length} names — retarget this test`);
  for (const n of names) {
    assert.match(main, new RegExp(`name\\s*=\\s*"${n}"`),
      `FURNITURE_NAMES contains "${n}" but main.js never names a group that, so it ` +
      "hides nothing");
  }
});

test("the design itself is NOT furniture", () => {
  // The complement: stripping too much would photograph an empty yard.
  //
  // Read the ARRAY LITERAL, not the file. Matching
  // /FURNITURE_NAMES[^\]]*"footprint"/ against the whole source fails wrongly —
  // the regex runs past the array into isFurniture(), which legitimately names
  // "footprint" while deciding that the red house outline STAYS.
  const lit = clean.slice(clean.indexOf("const FURNITURE_NAMES"));
  const arr = lit.slice(lit.indexOf("["), lit.indexOf("]") + 1);
  for (const n of ["designs", "scan", "footprint", "houseOutline"]) {
    assert.ok(!arr.includes(`"${n}"`),
      `"${n}" is in FURNITURE_NAMES — that is the garden, not the furniture`);
  }
  assert.ok(arr.includes('"gizmo"'), "the array scan itself is looking in the wrong place");
});
