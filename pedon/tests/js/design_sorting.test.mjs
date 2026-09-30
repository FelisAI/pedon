// node --test tests/js/design_sorting.test.mjs
//
// The Designs list can be sorted, because with dozens of saved designs finding
// one in an unsorted list is hard.
//
// Alphabetical is the worst order for that question. The names carry no date, so
// `alt_bank_none` and `usable_v3` sit twenty rows apart from the work of five
// minutes ago, and "the one I was just editing" — nearly always what you are
// looking for — could be anywhere in the list.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// main.js touches `document` at module scope, so the pure function is lifted out
// of the source the same way the other ui_* suites read it.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const i = src.indexOf("export function orderDesigns");
assert.notStrictEqual(i, -1, "orderDesigns is gone — retarget this test");
let depth = 0, end = -1;
for (let j = src.indexOf("{", i); j < src.length; j++) {
  if (src[j] === "{") depth++;
  else if (src[j] === "}") { depth--; if (!depth) { end = j; break; } }
}
const orderDesigns = new Function(src.slice(i, end + 1).replace("export function", "return function") + "")();

// One name deliberately carries capitals: with an all-lowercase fixture a
// case-insensitivity test passes even when only the QUERY is lowered.
const NAMES = ["alt_bank_none", "med_chinese_v1", "usable_v3", "Zebra_ALT", "undated"];
const META = {
  alt_bank_none:  { mtime_ms: 1000 },
  med_chinese_v1: { mtime_ms: 9000 },
  usable_v3:      { mtime_ms: 5000 },
  Zebra_ALT:      { mtime_ms: 3000 },
  // `undated` deliberately absent
};

test("most recent first is the default order", () => {
  const out = orderDesigns(NAMES, META, {});
  assert.equal(out[0], "med_chinese_v1", "the newest design is not first");
  assert.deepEqual(out.slice(0, 3), ["med_chinese_v1", "usable_v3", "Zebra_ALT"]);
});

test("an undated design does not jump to the top of 'most recent'", () => {
  // a file whose stat failed has no mtime; treating that as 0 must not read as
  // "brand new", and must not be an unstable sort either
  const out = orderDesigns(NAMES, META, { sort: "recent" });
  assert.equal(out[out.length - 1], "undated");
});

test("name and oldest are honoured", () => {
  assert.deepEqual(orderDesigns(NAMES, META, { sort: "name" }),
    ["alt_bank_none", "med_chinese_v1", "undated", "usable_v3", "Zebra_ALT"]);
  assert.equal(orderDesigns(NAMES, META, { sort: "oldest" })[0], "undated");
});

test("the filter narrows by name", () => {
  assert.deepEqual(orderDesigns(NAMES, META, { filter: "chinese" }), ["med_chinese_v1"]);
  assert.deepEqual(orderDesigns(NAMES, META, { filter: "CHIN" }), ["med_chinese_v1"],
    "an upper-case query must match a lower-case name");
  assert.deepEqual(orderDesigns(NAMES, META, { filter: "zebra" }), ["Zebra_ALT"],
    "a lower-case query must match an UPPER-case name — this is the half that a "
    + "fixture of all-lowercase names silently fails to test");
});

test("the design you are EDITING is pinned and never filtered away", () => {
  // losing sight of what you are editing because you typed in a search box is a
  // worse problem than the one the search box solves
  const out = orderDesigns(NAMES, META, { filter: "zzz", current: "usable_v3" });
  assert.deepEqual(out, ["usable_v3"], "the edited design vanished behind a filter");
  const out2 = orderDesigns(NAMES, META, { sort: "name", current: "Zebra_ALT" });
  assert.equal(out2[0], "Zebra_ALT", "the edited design is not pinned to the top");
});

test("an empty list and missing meta do not throw", () => {
  assert.deepEqual(orderDesigns([], undefined, {}), []);
  assert.deepEqual(orderDesigns(["a"], undefined, {}), ["a"]);
});
