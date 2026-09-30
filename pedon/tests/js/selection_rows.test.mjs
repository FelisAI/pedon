// node --test tests/js/selection_rows.test.mjs
//
// Selecting something highlights it in the Objects list, and vice versa. The list → yard
// half is a row click that selects and a row hover that lights the object. The yard → list
// half is the easy one to miss: setSelection paints the 3D highlight, the property card,
// the handles and the gizmo, and must mark the list's rows too.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const body = (from, to) => main.slice(main.indexOf(from), main.indexOf(to, main.indexOf(from)));

test("selecting anywhere repaints the rows — it is part of setSelection, not a caller", () => {
  const fn = body("function setSelection(ids) {", "\nfunction pickDesignObject");
  assert.match(fn, /syncObjectRows/,
    "the Objects list is not repainted when the selection changes, so picking in the yard leaves the row unmarked");
  // the one place that owns "what is selected" — the lesson its own comment carries
  assert.match(fn, /for \(const render of \[[^\]]*syncObjectRows[^\]]*\]/,
    "syncObjectRows is called outside the render list, where the next caller will forget it");
});

test("a row can be found from an id, and says whether it is selected", () => {
  const fn = body("function objectRow(o, opts = {})", "\nfunction groupRow");
  assert.match(fn, /dataset\.objectId = o\.id/, "rows carry no id, so no selection can find them");
  assert.match(fn, /selection\.has\(o\.id\) \? " sel" : ""/, "a freshly built row does not show the selection");
});

test("the row is brought into view only when it is off screen", () => {
  const fn = body("function syncObjectRows()", "\nfunction setSelection");
  assert.match(fn, /scrollIntoView/, "with 269 rows the marked one is usually out of sight");
  assert.match(fn, /r\.top < b\.top \|\| r\.bottom > b\.bottom/,
    "it scrolls unconditionally, which yanks the list under the cursor mid-click");
  assert.doesNotMatch(fn, /renderObjectList\(\)/,
    "rebuilding the list on every click throws away the scroll position you were reading");
});

test("the other direction still works: a row click selects, a row hover lights the object", () => {
  const fn = body("function objectRow(o, opts = {})", "\nfunction groupRow");
  assert.match(fn, /row\.onmouseenter = \(\) => \{ hoverId = o\.id; applySelectionHighlight\(\); \}/);
  assert.match(fn, /setSelection\(/, "clicking a row no longer selects it");
});
