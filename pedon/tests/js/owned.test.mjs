// node --test tests/js/owned.test.mjs
//
// The Add selector stores and tracks the plants the owner already has: a ☆ mine toggle on every
// plant card and a "mine" filter; the list is the SITE's (data/owned_plants.json), not the
// browser's and not the shared catalogue's.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OWNED_FILE, ownedSet, withOwned } from "../../viewer/src/shell/owned.js";
import { catalogue } from "./lib/library.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");

test("the list toggles a species and keeps everything else in the file", () => {
  const doc = { note: "the owner's words", catalogue: ["Westringia fruticosa"] };
  const on = withOwned(doc, "Salvia coahuilensis", true);
  assert.deepEqual(on.catalogue, ["Salvia coahuilensis", "Westringia fruticosa"]);
  assert.equal(on.note, "the owner's words", "marking a plant threw away the rest of the file");
  assert.deepEqual(doc.catalogue, ["Westringia fruticosa"], "the input was mutated");
  assert.deepEqual(withOwned(on, "Westringia fruticosa", false).catalogue, ["Salvia coahuilensis"]);
  assert.equal(ownedSet(null).size, 0);
});

test("the list is the site's file, written merged onto what is on disk", () => {
  assert.equal(OWNED_FILE, "data/owned_plants.json");
  const i = main.indexOf("async function setOwned");
  const body = main.slice(i, main.indexOf("\n}", i));
  assert.ok(body.indexOf('fetchJson("/" + OWNED_FILE)') < body.indexOf("/api/save"),
    "it writes without reading what is on disk first — a design session's additions would be lost");
  assert.doesNotMatch(body, /localStorage/, "the list went into the browser, where no design session sees it");
});

test("every plant card can be marked, and the library can show only the owner's", () => {
  assert.ok(html.includes('id="assetMine"'), "no 'mine' filter");
  assert.match(main, /mine\.onclick = ev => \{ ev\.stopPropagation\(\); setOwned\(e\.species, !have, e\.common \?\? e\.species\); \}/,
    "the toggle is missing, or it also picks the plant for planting");
  assert.match(main, /if \(f\.mine && !f\.mineSet\?\.has\(e\.species\)\) return false;/);
  assert.match(main, /\["assetSearch", "assetForm", "assetWater", "assetNative", "assetCat", "assetMine"\]/,
    "ticking 'mine' does not redraw the library");
});

test("the shared catalogue says nothing about who owns what", () => {
  const cat = { plants: catalogue() };
  assert.deepEqual(cat.plants.filter(p => "owned_by_owner" in p).map(p => p.species), []);
});
