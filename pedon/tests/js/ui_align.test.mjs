// node --test tests/js/ui_align.test.mjs
//
// Align and distribute.
//
// Beside delete, duplicate and group in the selection bar, this is the one a
// person coming from Figma reaches for first, and the one a GARDEN wants most.
// Five stepping stones evenly spaced along a run, a row of pots on the terrace
// edge, three set stones sharing a face — dragging that by hand gives you a row
// that is NEARLY straight, which reads worse than no row at all.
//
// Axes are COMPASS, not screen: this project sets north and carves zones by
// compass, and "align left" would mean something different every time the camera
// moved — the class of bug the ENU/world rule exists to prevent.
//
// main.js cannot be imported (it builds a WebGLRenderer at module scope), so the
// pure block is sliced between its markers and eval'd, the way every other UI
// suite here does it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");

const slice = (a, b) => {
  const i = main.indexOf(a);
  // search for the end AFTER the start: "};" appears hundreds of times earlier in
  // the file, and a from-the-top search silently slices nothing
  const j = i === -1 ? -1 : main.indexOf(b, i + a.length);
  assert.ok(i !== -1 && j > i, `markers ${a}..${b} not found — this test slices nothing`);
  return main.slice(i, j);
};
// MOVE_AS is the shape table the box reader depends on; take the real one
const moveAs = slice("const MOVE_AS = {", "};") + "};";
const block = slice("// ── ALIGN-START ──", "// ── ALIGN-END ──");
const { bboxOf, alignDeltas, spreadDeltas } =
  new Function(`${moveAs}\n${block}\nreturn { bboxOf, alignDeltas, spreadDeltas };`)();

const obj = (id, x, y, w = 0.4) =>
  ({ id, kind: "object", raw: { id, kind: "pot", position: [x, y], width_m: w } });
const bed = (id, pts) => ({ id, kind: "bed", raw: { id, polygon: pts } });

// ── the box reader ────────────────────────────────────────────────────────

test("a point and a run both yield a box", () => {
  const p = bboxOf("object", { position: [2, 3] });
  assert.deepEqual([p.minx, p.maxx, p.cx, p.cy], [2, 2, 2, 3]);
  const b = bboxOf("bed", { polygon: [[0, 0], [4, 0], [4, 2], [0, 2]] });
  assert.deepEqual([b.minx, b.maxx, b.miny, b.maxy], [0, 4, 0, 2]);
  assert.deepEqual([b.cx, b.cy], [2, 1]);
});

test("something with no usable points yields no box, rather than NaN", () => {
  assert.equal(bboxOf("bed", { polygon: [] }), null);
  assert.equal(bboxOf("object", { position: [NaN, 2] }), null);
  assert.equal(bboxOf("bed", { polygon: [["a", "b"]] }), null);
});

// ── align ─────────────────────────────────────────────────────────────────

test("align north brings everything to the NORTHMOST, not to the mean", () => {
  // the target is the one you are pointing at. A mean would move every object
  // including the one already where you want the row.
  const d = alignDeltas([obj("a", 0, 1), obj("b", 5, 4), obj("c", 9, 2)], "north");
  const by = Object.fromEntries(d.map(x => [x.id, x.dy]));
  assert.equal(by.b, undefined, "the northmost object moved");
  assert.ok(Math.abs(by.a - 3) < 1e-9);
  assert.ok(Math.abs(by.c - 2) < 1e-9);
  assert.ok(d.every(x => x.dx === 0), "a north align moved something east");
});

test("align west uses the box EDGE, so different sizes share a face", () => {
  const wide = bed("wide", [[2, 0], [8, 0], [8, 1], [2, 1]]);   // minx 2
  const narrow = bed("narrow", [[5, 3], [6, 3], [6, 4], [5, 4]]); // minx 5
  const d = alignDeltas([wide, narrow], "west");
  assert.equal(d.length, 1);
  assert.equal(d[0].id, "narrow");
  assert.ok(Math.abs(d[0].dx + 3) < 1e-9, "narrow should move 3 m west to share the face");
});

test("centring uses the MIDDLE, which is what a row of unequal stones wants", () => {
  const big = bed("big", [[0, 0], [4, 0], [4, 1], [0, 1]]);      // cx 2
  const small = obj("small", 6, 5);                               // cx 6
  const d = alignDeltas([big, small], "centre_ew");
  const by = Object.fromEntries(d.map(x => [x.id, x.dx]));
  // mean of 2 and 6 is 4: both move 2 m, in opposite directions
  assert.ok(Math.abs(by.big - 2) < 1e-9);
  assert.ok(Math.abs(by.small + 2) < 1e-9);
});

test("things already lined up produce NO ops", () => {
  assert.deepEqual(alignDeltas([obj("a", 0, 3), obj("b", 5, 3)], "north"), []);
});

test("one thing cannot be aligned, and a bad axis is refused", () => {
  assert.deepEqual(alignDeltas([obj("a", 0, 0)], "north"), []);
  assert.deepEqual(alignDeltas([obj("a", 0, 0), obj("b", 1, 1)], "sideways"), []);
});

// ── distribute ────────────────────────────────────────────────────────────

test("spacing evenly keeps the two ENDS and evens the middles", () => {
  // The ends are where the owner already put them: the run is theirs, the spacing
  // is not. Deliberately NOT starting at x=0 — at x=0 a mutation that spreads
  // from the origin instead of from the west end gives the same number, and passes.
  const d = spreadDeltas([obj("a", 6, 0), obj("b", 7, 0), obj("c", 15, 0), obj("d", 18, 0)], "x");
  const by = Object.fromEntries(d.map(x => [x.id, x.dx]));
  assert.equal(by.a, undefined, "the west end moved — it is where the owner put it");
  assert.equal(by.d, undefined, "the east end moved");
  assert.ok(Math.abs(by.b - 3) < 1e-9, "b should land at 10");
  assert.ok(Math.abs(by.c + 1) < 1e-9, "c should land at 14");
});

test("it sorts along the axis first, so selection order cannot change the answer", () => {
  const jumbled = [obj("c", 15, 0), obj("a", 6, 0), obj("d", 18, 0), obj("b", 7, 0)];
  const ordered = [obj("a", 6, 0), obj("b", 7, 0), obj("c", 15, 0), obj("d", 18, 0)];
  const key = ds => Object.fromEntries(ds.map(x => [x.id, +x.dx.toFixed(9)]));
  assert.deepEqual(key(spreadDeltas(jumbled, "x")), key(spreadDeltas(ordered, "x")));
});

test("two things are already evenly spaced", () => {
  assert.deepEqual(spreadDeltas([obj("a", 0, 0), obj("b", 4, 0)], "x"), []);
});

// ── the wiring, which is where this project loses features ────────────────

test("the control exists and goes through the OP path", () => {
  const html = readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");
  assert.match(html, /id="alignHow"/, "no align control in the selection bar");
  for (const v of ["west", "east", "north", "south", "centre_ew", "centre_ns",
                   "spread_x", "spread_y"])
    assert.ok(html.includes(`value="${v}"`), `the control cannot ask for ${v}`);
  const code = main.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  // anchor on the HANDLER, not on the first mention of the id. The inspector
  // card also references #alignHow — to focus it — and slicing from that earlier
  // mention reads 1,600 characters of the wrong function and reports that
  // aligning has left the op path. Find where the value is ACTED on.
  const i = code.indexOf('getElementById("alignHow").onchange');
  assert.notEqual(i, -1, "nothing handles a change of the align control");
  const body = code.slice(i, i + 1600);
  assert.match(body, /moveOps\(/,
    "align writes without moveOps, so an aligned object skips the validators that "
    + "a dragged one goes through — every change must take the one write path");
  assert.match(body, /postOps\(/, "align does not post ops");
  assert.match(body, /snapshotWorking\(/, "align is not undoable");
});
