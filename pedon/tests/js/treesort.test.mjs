// node --test tests/js/treesort.test.mjs
//
// How the objects tree is ordered in a 3D app.
//
// A 2D editor's layer order is a RENDER decision — what covers what — and there
// is no such thing in a scene where geometry sits in space and is drawn by kind.
// Dragging a row up changes nothing visible in the scene. Sorting the tree helps
// the user find one object among 269 objects.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sortRows, withKindHeadings, ORDERS, rangeBetween } from "../../viewer/src/shell/treesort.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const mainRaw = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const main = mainRaw.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

// The row shape shell/rowtext.js produces: a NAME a person reads and a MEASURE
// beside it. `meta` holds the plant's size, so sorting by name must read `name`.
const ROWS = [
  { id: "p10", kind: "plant", name: "Thyme", meta: "p10 \u00b7 0.3 m" },
  { id: "p2",  kind: "plant", name: "Muhly", meta: "p2 \u00b7 0.9 m" },
  { id: "bed_1", kind: "bed", name: "bed_south", meta: "13.6 m\u00b2" },
  { id: "walk", kind: "path", name: "contour_walk", meta: "16.0 m \u00b7 1.1 m wide" },
  { id: "lantern", kind: "object", name: "stone lantern", meta: "lantern \u00b7 1.4 m" },
];

test("p2 comes before p10 — a plain string sort reads as random", () => {
  // the single most common thing in this list is a run of p<N> ids, and
  // "p10, p11, p2" is the classic lexicographic tell that nobody sorted properly
  const ids = sortRows(ROWS, "kind").filter(r => r.kind === "plant").map(r => r.id);
  assert.deepEqual(ids, ["p2", "p10"]);
});

test("by kind groups the ground before what stands on it", () => {
  const kinds = sortRows(ROWS, "kind").map(r => r.kind);
  assert.ok(kinds.indexOf("bed") < kinds.indexOf("plant"),
    "planting is listed before the ground it sits in");
  assert.ok(kinds.indexOf("path") < kinds.indexOf("object"));
});

test("an unknown kind sorts last rather than first", () => {
  // a kind this table has never heard of must not lead the list
  const withOdd = [...ROWS, { id: "x1", kind: "koi pond", name: "koi pond", meta: "x1" }];
  assert.equal(sortRows(withOdd, "kind").at(-1).kind, "koi pond");
});

test("by name reads the label the row SHOWS, not its id and not its size", () => {
  // `p42` tells the user nothing; they look for a name such as Pink muhly.
  // The row's second column is a measurement, so sorting by `meta` orders the
  // list by HEIGHT despite the name label on screen.
  const names = sortRows(ROWS, "name").map(r => r.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, undefined,
    { numeric: true, sensitivity: "base" })));
  // and it is demonstrably not the id order or the meta order
  assert.notDeepEqual(sortRows(ROWS, "name").map(r => r.id),
                      sortRows(ROWS, "name").map(r => r.meta).sort());
});

test("newest first uses the id's serial, not array position", () => {
  const ids = sortRows(ROWS, "recent").map(r => r.id);
  assert.equal(ids[0], "p10", "the highest-numbered object is not first");
});

test("the sort is STABLE, so a tie does not shuffle on every redraw", () => {
  // a list that reorders under the cursor is unusable even when every row is in
  // a defensible place
  const tied = [{ id: "a", kind: "plant", name: "same" }, { id: "b", kind: "plant", name: "same" },
                { id: "c", kind: "plant", name: "same" }];
  for (let i = 0; i < 5; i++)
    assert.deepEqual(sortRows(tied, "name").map(r => r.id), ["a", "b", "c"]);
});

test("sorting never drops or invents a row", () => {
  for (const o of ORDERS.map(o => o.id)) {
    const out = sortRows(ROWS, o);
    assert.equal(out.length, ROWS.length, `${o} changed the row count`);
    assert.deepEqual(new Set(out.map(r => r.id)), new Set(ROWS.map(r => r.id)));
  }
});

test("it does not mutate the list it was given", () => {
  // renderObjectList passes `loose` straight in, and a sort in place would
  // reorder the caller's array behind its back.
  //
  // THE FIXTURE IS THE TEST HERE. ROWS is already in recent order, so sorting
  // it in place with "recent" changes nothing and cannot reveal a mutation.
  // The input must be one the chosen order demonstrably reorders.
  const input = [{ id: "p1", kind: "plant", name: "a" },
                 { id: "bed_9", kind: "bed", name: "z" },
                 { id: "p7", kind: "plant", name: "m" }];
  const before = input.map(r => r.id);
  const out = sortRows(input, "kind");
  assert.notDeepEqual(out.map(r => r.id), before,
    "the fixture is already sorted, so this proves nothing — pick another");
  assert.deepEqual(input.map(r => r.id), before, "sortRows reordered its argument");
});

test("an empty or missing list is not an error", () => {
  assert.deepEqual(sortRows([], "kind"), []);
  assert.deepEqual(sortRows(undefined, "kind"), []);
});

test("headings appear only for the kind order, and once per run", () => {
  const items = withKindHeadings(sortRows(ROWS, "kind"), "kind");
  const heads = items.filter(i => i.type === "heading").map(i => i.kind);
  assert.deepEqual(heads, [...new Set(heads)], "a kind got two headings");
  assert.equal(withKindHeadings(sortRows(ROWS, "name"), "name")
    .filter(i => i.type === "heading").length, 0,
    "headings appeared in an order where they mean nothing");
});

test("every heading carries the count of what is under it", () => {
  // the list must show how many plants are in the design without making the
  // user count 215 rows by scrolling
  const items = withKindHeadings(sortRows(ROWS, "kind"), "kind");
  for (const h of items.filter(i => i.type === "heading")) {
    const under = sortRows(ROWS, "kind").filter(r => r.kind === h.kind).length;
    assert.equal(h.count, under, `the ${h.kind} heading says ${h.count}, not ${under}`);
  }
  assert.equal(items.filter(i => i.type === "heading")
                    .reduce((s, h) => s + h.count, 0), ROWS.length,
    "the counts do not add up to the list");
});

test("a heading counts what is SHOWN, so a filter does not make it lie", () => {
  const filtered = sortRows(ROWS, "kind").filter(r => r.kind !== "plant" || r.id === "p2");
  const plants = withKindHeadings(filtered, "kind").find(i => i.kind === "plant");
  assert.equal(plants.count, 1,
    "the heading counted the whole design while the list showed one row");
});

test("the order is VIEW state and never reaches the design", () => {
  // writing it into design.json would put a preference into the file the
  // design agent reads
  assert.match(main, /TREE_ORDER_KEY/);
  const body = main.slice(main.indexOf("function setTreeOrder"), main.indexOf("function renderObjectList"));
  assert.match(body, /localStorage\.setItem\(TREE_ORDER_KEY/);
  assert.ok(!/postOps|writeDesignDocument|\/api\/ops/.test(body),
    "changing the sort order emits a design write");
});

// ══ SHIFT-RANGE, and the menu that acts on what it selects ════════════════
// Shift selects a range, and right-click opens actions for the multi-selection,
// including grouping. The user must be able to select several objects and act
// on them together.

test("a range runs between the two rows, in either direction", () => {
  const order = ["a", "b", "c", "d", "e"];
  assert.deepEqual(rangeBetween(order, "b", "d"), ["b", "c", "d"]);
  assert.deepEqual(rangeBetween(order, "d", "b"), ["b", "c", "d"],
    "dragging the range upwards returned nothing — a range has no direction");
  assert.deepEqual(rangeBetween(order, "c", "c"), ["c"], "a range to itself is that row");
  assert.deepEqual(rangeBetween(order, "a", "e"), order);
});

test("the range is taken from the RENDERED order, not a re-derived one", () => {
  // THE TRAP, and the reason this takes the order as an argument instead of
  // computing it. The tree is sorted (by kind, by name, by size) and filtered,
  // and rows inside a collapsed group are not on screen at all. A range derived
  // from the design's own order would select things the user cannot see, between
  // two adjacent rows on screen — the failure is invisible until they delete
  // the selection.
  const asRendered = ["patio_1", "bed_south", "bed_north"];   // sorted by size, say
  assert.deepEqual(rangeBetween(asRendered, "patio_1", "bed_south"), ["patio_1", "bed_south"]);
  // the same two ids in the design's order would have swept up bed_north
  const asStored = ["bed_north", "bed_south", "patio_1"];
  assert.deepEqual(rangeBetween(asStored, "patio_1", "bed_south"), ["bed_south", "patio_1"]);
});

test("a range whose anchor has scrolled out of the list is the row they click", () => {
  // filtering or folding a group can hide the anchor. Selecting nothing would
  // read as a dead click; selecting everything would be a catastrophe.
  const order = ["c", "d", "e"];
  assert.deepEqual(rangeBetween(order, "a", "d"), ["d"]);
  assert.deepEqual(rangeBetween(order, "a", "zz"), [], "a row that is not in the list selects nothing");
  assert.deepEqual(rangeBetween([], "a", "b"), []);
  assert.deepEqual(rangeBetween(undefined, "a", "b"), [], "a missing order must not throw");
});

test("the three gestures are distinct, and the range is one of them", () => {
  // shift must select a range, while ⌘ toggles ONE row; mapping both keys to
  // the same gesture leaves no way to select a range
  const body = main.slice(main.indexOf("row.onclick = ev =>"),
                          main.indexOf("row.oncontextmenu"));
  assert.ok(body.length > 40, "the row click handler moved — retarget this test");
  assert.match(body, /ev\.shiftKey && treeAnchor/, "shift does not start a range");
  assert.match(body, /rangeBetween\(treeOrderIds, treeAnchor, o\.id\)/,
    "the range is not taken from the rendered order — see the trap above");
  assert.match(body, /ev\.metaKey \|\| ev\.ctrlKey/, "⌘ no longer toggles one row");
  assert.match(body, /treeAnchor = o\.id/, "nothing ever sets the anchor, so shift can never range");
});

test("the anchor list is rebuilt by the renderer, so it matches what is on screen", () => {
  // a stale order is the same bug as a re-derived one, arriving later
  const render = main.slice(main.indexOf("function renderObjectList"));
  assert.match(render, /treeOrderIds = \[\]/,
    "the rendered order is never cleared, so it accumulates rows across renders");
  assert.ok((render.match(/treeOrderIds\.push/g) ?? []).length >= 2,
    "the renderer does not record the rows it drew");
});

test("a right-click on a row opens the SAME menu the canvas opens", () => {
  // two menus built from two lists drift — the tree and canvas must both require
  // two objects before offering grouping
  const body = main.slice(main.indexOf("row.oncontextmenu"),
                          main.indexOf("row.oncontextmenu") + 700);
  assert.match(body, /contextItemsFor/, "the tree builds its own menu items");
  assert.match(body, /multi: selection\.size > 1/,
    "the menu is not told this is a multi-selection, so grouping cannot be offered");
  assert.match(body, /if \(!selection\.has\(o\.id\)\) setSelection\(\[o\.id\]\)/,
    "right-clicking a row outside the selection acts on something they did not point at");
  assert.match(body, /preventDefault/, "the browser's own menu opens over it");
});
