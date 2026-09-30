// node --test tests/js/viewstate.test.mjs
//
// A HIDDEN ID MUST NOT RE-BIND TO A DIFFERENT OBJECT.
//
// `next_id` recycles the lowest free id, so a hidden entry must identify the
// object as well as its id. Python prunes groups; the browser must also reject
// stale entries. Solo writes an entry for every object in the design, so a
// replant or a design switch while soloed can otherwise hide different objects
// that reuse those ids. View state must also be scoped to each design.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { whatIs, honoured } from "../../viewer/src/shell/viewstate.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const codeOnly = s => s.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

const design = {
  p27: { kind: "plant", raw: { id: "p27", species: "Erigeron glaucus", common: "Seaside daisy" } },
  p28: { kind: "plant", raw: { id: "p28", species: "Muhlenbergia capillaris" } },
  bench: { kind: "object", raw: { id: "bench", kind: "bench" } },
  hua_walk: { kind: "path", raw: { id: "hua_walk" } },
};
const lookup = id => design[id] ?? null;

test("an id that now means a DIFFERENT plant is not hidden, and is reported stale", () => {
  const view = { p27: { hidden: true, what: "plant:muhlenbergia capillaris" } };   // hidden as a muhly
  const got = honoured(view, lookup);                                               // p27 is a daisy now
  assert.deepEqual([...got.hidden], []);
  assert.deepEqual(got.stale, ["p27"]);
});

test("the same thing stays hidden — a species, an object kind, a named path", () => {
  const view = { p28: { hidden: true, what: whatIs(design.p28) }, bench: { hidden: true, what: "object:bench" },
                 hua_walk: { hidden: true, what: "path" } };
  const got = honoured(view, lookup);
  assert.deepEqual([...got.hidden].sort(), ["bench", "hua_walk", "p28"]);
  assert.deepEqual(got.stale, []);
});

test("an id this design does not have is left alone: it belongs to another design", () => {
  const got = honoured({ lantern: { hidden: true, what: "object:lantern" } }, lookup);
  assert.deepEqual([...got.hidden], []);
  assert.deepEqual(got.stale, [], "dropping it would lose the user's hidden lantern when they switch away");
});

test("an entry written before signatures existed is still honoured", () => {
  assert.deepEqual([...honoured({ p27: { hidden: true } }, lookup).hidden], ["p27"]);
  assert.deepEqual([...honoured({ p27: { hidden: false, what: "x" } }, lookup).hidden], []);
});

test("main.js records what it hides, honours it through ONE function, and Solo does the same", () => {
  const main = codeOnly(fs.readFileSync(path.join(ROOT, "viewer/src/main.js"), "utf8"));
  assert.match(main, /else objectView\[id\]\.what = whatIs\(rawById\(currentDesign, id\)\);/);
  assert.match(main, /function hiddenObjectIds\(\) \{\s*\n\s*const \{ hidden, stale \} = honoured\(objectView, id => rawById\(currentDesign, id\)\);/);
  assert.match(main, /for \(const id of stale\) delete objectView\[id\];/);
  assert.match(main, /next\[o\.id\] = \{ hidden: true, what: whatIs\(rawById\(currentDesign, o\.id\)\) \}/,
    "Solo writes an entry for EVERY object and must sign each one");
  assert.doesNotMatch(main, /Object\.keys\(objectView\)\.filter\(k => objectView\[k\]\?\.hidden\)/,
    "a second, unsigned reading of the hidden map");
});

// ── ONE VIEW PER DESIGN ────────────────────────────────────────────────
// Each design needs its own object and group hide/show state. A global map hides
// objects in another design when they share a name and kind; signatures cannot
// distinguish them, so the maps must be scoped to the design.
import { viewScopeOf, readViewScope, writeViewScope, dropViewScope, VIEW_STORE_KEY }
  from "../../viewer/src/shell/viewstate.js";

test("what is hidden in one design is not hidden in another", () => {
  let store = {};
  store = writeViewScope(store, viewScopeOf("huajing_h_naturalism_wip"),
    { objects: { hua_jing_lower: { hidden: true }, contour_walk: { hidden: true } },
      groups: { grp_mu4hzgyk: { hidden: true, folded: true } } });
  const j = readViewScope(store, viewScopeOf("huajing_J_sunroom"));
  assert.deepEqual(j, { objects: {}, groups: {} }, "J opened with another design's things hidden");
  const back = readViewScope(store, viewScopeOf("huajing_h_naturalism_wip"));
  assert.deepEqual(Object.keys(back.objects).sort(), ["contour_walk", "hua_jing_lower"]);
  assert.equal(back.groups.grp_mu4hzgyk.hidden, true, "a SAVED-AS design inherits its parent's group ids — the group map must be scoped too");
});

test("an unnamed working design has a scope of its own, and names cannot collide with it", () => {
  assert.notEqual(viewScopeOf(""), viewScopeOf("unsaved"), "a design NAMED 'unsaved' would share the unnamed scope");
  assert.equal(viewScopeOf(undefined), viewScopeOf(""));
});

test("reading a scope hands back copies, and writing does not mutate the store", () => {
  const store = writeViewScope({}, "design:a", { objects: { p1: { hidden: true } }, groups: {} });
  const frozen = JSON.stringify(store);
  const got = readViewScope(store, "design:a");
  got.objects.p1.hidden = false; got.objects.p2 = { hidden: true };
  assert.equal(JSON.stringify(store), frozen, "editing the live maps reached into the store");
  writeViewScope(store, "design:b", { objects: { x: { hidden: true } }, groups: {} });
  assert.equal(JSON.stringify(store), frozen);
});

test("an empty scope costs nothing, and a deleted design takes its view with it", () => {
  let store = writeViewScope({}, "design:a", { objects: { p1: { hidden: true } }, groups: {} });
  store = writeViewScope(store, "design:a", { objects: {}, groups: {} });
  assert.deepEqual(store, {}, "eighty untouched designs should not each leave a key behind");
  store = writeViewScope({}, "design:a", { objects: {}, groups: { g: { folded: true } } });
  assert.deepEqual(dropViewScope(store, "design:a"), {});
  assert.deepEqual(store["design:a"].groups, { g: { folded: true } }, "dropViewScope mutated its argument");
});

test("main.js keeps ONE store, switches it with the design, and reads the old global maps nowhere", () => {
  const main = codeOnly(fs.readFileSync(path.join(ROOT, "viewer/src/main.js"), "utf8"));
  assert.match(main, /function setCurrentVariant\(name, opts\) \{[\s\S]{0,260}switchViewScope\(currentVariant, opts\);/,
    "the one owner of the current design's name no longer switches the view with it");
  assert.match(main, /setCurrentVariant\(name, \{ carry: true \}\)/, "Save as… must preserve the user's hidden objects and groups");
  assert.match(main, /viewStore = dropViewScope\(viewStore, viewScopeOf\(name\)\)/, "a deleted design leaves its view behind for the next one of that name");
  assert.match(main, /soloMemory = null;\s*\/\/ a solo belongs to the design/, "leaving a solo in another design restores the wrong garden's hidden set");
  // every write goes through persistView, and nothing READS the shared maps
  assert.equal((main.match(/localStorage\.setItem\(VIEW_KEY/g) ?? []).length, 1, "the view reaches storage from more than one place");
  assert.doesNotMatch(main, /JSON\.parse\(localStorage\.getItem\("yt\.(objectview|groupview)"\)/, "the shared maps are being read again");
  assert.doesNotMatch(main, /GROUP_VIEW_KEY|OBJECT_VIEW_KEY/);
  assert.ok(VIEW_STORE_KEY !== "yt.objectview" && VIEW_STORE_KEY !== "yt.groupview");
});
