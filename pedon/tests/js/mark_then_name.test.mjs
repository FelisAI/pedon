// node --test tests/js/mark_then_name.test.mjs
//
// Marking needs no name first: a mark gets a default name and the user renames it.
// Landmarks auto-number a blank name, and areas do the same — a lasso that REFUSES
// until the area is named makes you decide what a region is called before you
// have seen where it is.
//
// The half people forget is the second one. Auto-naming without an obvious way
// to rename just means everything stays called `area 6`, so the new row opens
// for editing with its text selected: type and the default is replaced.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const raw = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const main = raw.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const html = fs.readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");

test("drawing an area does not refuse without a name", () => {
  assert.ok(!/name the area first/.test(main),
    "the lasso still demands a name before it will save what you drew");
});

test("a blank name becomes a default, and the default does not collide", () => {
  const i = main.indexOf('const nameEl = document.getElementById("areaName")');
  assert.notStrictEqual(i, -1, "the area-naming block is gone — retarget this test");
  const body = main.slice(i, i + 600);
  assert.match(body, /`area \$\{n\}`/, "no default name is generated");
  assert.match(body, /while \(taken\.has/,
    "the default can collide with an existing area — and areas are addressed BY NAME");
});

test("a landmark still auto-numbers against the FILE, not a cache", () => {
  // the behaviour areas share: naming off a stale
  // cache means the first click after a reload overwrites spot_1
  const i = main.indexOf("async function addLandmark");
  const body = main.slice(i, i + 700);
  assert.match(body, /auto-name against the fresh file|s\.landmarks\.some/,
    "landmark auto-naming no longer reads the freshly-written file");
});

test("both lists can rename, or auto-naming is a trap", () => {
  // WORD-BOUNDED. Without the \b, renaming the function to `renameAreaDISABLED`
  // still matches and the mutation stays green — the assertion would test that
  // the letters exist, not that the function does.
  assert.match(main, /async function renameLandmark\b/);
  assert.match(main, /async function renameArea\b/,
    "an area cannot be renamed, so every one of them stays called `area 6`");
  assert.match(main, /onchange = \(\) => renameArea\(/,
    "renameArea exists and nothing calls it");
});

test("renaming an area goes through the ONE owner write path", () => {
  // areas are owner ground truth and designs scope to them BY NAME
  const i = main.indexOf("async function renameArea");
  const body = main.slice(i, main.indexOf("async function renameLandmark"));
  assert.match(body, /updateSite\(/, "renameArea writes site.json some other way");
  assert.ok(!/fetch\("\/api\/save"/.test(body), "it bypasses the owner merge");
});

test("a rename that would collide is refused, not silently applied", () => {
  const i = main.indexOf("async function renameArea");
  const body = main.slice(i, main.indexOf("async function renameLandmark"));
  assert.match(body, /already exists/,
    "two areas could end up sharing a name, and a design scoped by name would find the wrong one");
});

test("renaming warns that designs scoped to the old name will not find it", () => {
  const i = main.indexOf("async function renameArea");
  const body = main.slice(i, main.indexOf("async function renameLandmark"));
  assert.match(body, /will not find it/,
    "renaming silently orphans every design scoped to the old name");
});

test("the new row opens for renaming, with its text selected", () => {
  assert.match(main, /function renameInPlace/);
  const body = main.slice(main.indexOf("function renameInPlace"), main.indexOf("function renameInPlace") + 500);
  assert.match(body, /\.select\(\)/, "the default name is not selected, so you must clear it by hand");
  assert.match(main, /renameInPlace\("areaList"/, "nothing opens a newly drawn area for renaming");
});

test("the fields do not tell the user to name it first", () => {
  assert.ok(!/name it, then draw/.test(html), "the area field still says to name it first");
  assert.ok(!/placeholder="name a spot, then click it"/.test(html));
  assert.match(html, /id="areaName"[^>]*placeholder="optional name"/,
    "the area name field does not read as optional");
});
