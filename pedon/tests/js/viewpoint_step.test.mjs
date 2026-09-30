// node --test tests/js/viewpoint_step.test.mjs
//
// A hotkey steps through the saved views, rather than one key per view (1-9):
// `]` goes to the next saved view, `[` to the previous.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stepViewpoint } from "../../viewer/src/shell/viewpoints.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const V = ["halfway path", "halfwaypath", "lookfromhouse", "inthepath"].map(name => ({ name }));
const at = (cur, dir) => stepViewpoint(V, cur, dir)?.name;

test("] steps forward and [ steps back", () => {
  assert.equal(at("halfwaypath", 1), "lookfromhouse");
  assert.equal(at("halfwaypath", -1), "halfway path");
});

test("both ends wrap", () => {
  assert.equal(at("inthepath", 1), "halfway path");
  assert.equal(at("halfway path", -1), "inthepath");
});

test("from no view — or a deleted one — ] starts at the first and [ at the last", () => {
  assert.equal(at(null, 1), "halfway path");
  assert.equal(at(null, -1), "inthepath");
  assert.equal(at("since deleted", 1), "halfway path");
});

test("no saved views is nothing to step to, not a crash", () => {
  assert.equal(stepViewpoint([], null, 1), null);
  assert.equal(stepViewpoint(undefined, "x", -1), null);
});

test("the keys are wired to it, and the shortcut sheet says so", () => {
  // the pure function is half the guard; the other half is the call site
  const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
  assert.match(main, /ev\.key === "\[" \|\| ev\.key === "\]"[\s\S]{0,200}stepViewpoint\(siteCache\?\.viewpoints, lastViewpoint/,
    "[ and ] no longer step through saved views");
  assert.match(main, /lastViewpoint = v\.name/, "going to a view no longer records where [ ] step from");
  assert.match(main, /\["\[  \]", "previous \/ next saved view"\]/, "the ? sheet does not list [ ]");
});
