// node --test tests/js/
//
// Add and remove control points, not just move the ones that are there.
//
// The LINE of a path decides whether it looks natural or random, and dragging the
// existing points can only redistribute a curve, never make it smoother or simpler.
// A three-point spline cannot be made to bend more no matter where its points go.
//
// The op path is unchanged: an inserted or deleted point re-places the whole
// object through /api/ops, so a change that puts the line on the house or off the
// scan is rejected with the reason and undoable.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DESIGN_KINDS } from "../../viewer/src/design_doc.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const code = main.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

function block(start, end, min) {
  const a = main.indexOf(start), b = main.indexOf(end);
  assert.notEqual(a, -1, `${start} missing`);
  const s = main.slice(a + start.length, b);
  assert.ok(s.length > min, `block after ${start} is only ${s.length} chars`);
  // DESIGN_KINDS lives in design_doc.js: the whole-document write needs the
  // same list to know what a replacement must CLEAR. The extracted source
  // uses it as a free variable, so hand it the REAL list rather than a copy —
  // a second copy of this vocabulary can omit steps and make a flight
  // undeletable. Only when it is actually referenced, so this stays inert
  // for the blocks that do not use it.
  if (/\bDESIGN_KINDS\b/.test(s))
    return `const DESIGN_KINDS = ${JSON.stringify(DESIGN_KINDS)};\n${s}`;
  return s;
}
const api = new Function(
  `${block("// ── HAND-EDIT-START ──", "// ── HAND-EDIT-END ──", 400)}
   return { insertPointOps, deletePointOps, geometryOf, MOVE_AS, midpointsFor };`)();

const PATH = { id: "walk", spline: [[0, 0], [3, 1], [6, 0]], width_m: 1.1, material: "gravel" };
const BED = { id: "b1", mulch: "bark", polygon: [[0, 0], [4, 0], [4, 4], [0, 4]] };
const EDGE2 = { id: "e", spline: [[0, 0], [4, 0]], height_m: 0.3, material: "corten_steel" };
const TRI = { id: "t", mulch: "bark", polygon: [[0, 0], [4, 0], [2, 3]] };

test("a point can be inserted between two others", () => {
  const ops = api.insertPointOps("path", PATH, 0, [1.5, 0.9]);
  assert.equal(ops.length, 1);
  const sp = ops[0].input.spline;
  assert.equal(sp.length, 4, "the point was not inserted");
  assert.deepEqual(sp[1], [1.5, 0.9], "it did not land between points 0 and 1");
  assert.deepEqual(sp[0], [0, 0]);
  assert.deepEqual(sp[2], [3, 1], "the following points were disturbed");
  assert.equal(ops[0].input.material, "gravel", "the insert dropped the material");
});

test("a point can be removed", () => {
  const sp = api.deletePointOps("path", PATH, 1)[0].input.spline;
  assert.deepEqual(sp, [[0, 0], [6, 0]]);
});

test("a polygon keeps at least a triangle, a line at least two ends", () => {
  // below these the object stops being the thing it is, and the op would be
  // rejected server-side anyway — better to say so where the click happened
  assert.throws(() => api.deletePointOps("bed", TRI, 0),
    "a triangle was allowed to lose a corner");
  assert.throws(() => api.deletePointOps("edge", EDGE2, 0),
    "a two-point line was allowed to lose an end");
  assert.equal(api.deletePointOps("bed", BED, 0)[0].input.polygon.length, 3);
});

test("a bad index is refused rather than corrupting the shape", () => {
  for (const i of [-1, 9, null, "1", 1.5]) {
    assert.throws(() => api.deletePointOps("path", PATH, i), `delete accepted ${i}`);
    assert.throws(() => api.insertPointOps("path", PATH, i, [1, 1]), `insert accepted ${i}`);
  }
});

test("inserting rounds to the stored centimetre", () => {
  const sp = api.insertPointOps("path", PATH, 0, [1.23456, 0.98765])[0].input.spline;
  assert.deepEqual(sp[1], [1.23, 0.99]);
});

test("a point kind has no points to add or remove", () => {
  const obj = { id: "o", kind: "lantern", position: [1, 2] };
  assert.throws(() => api.insertPointOps("object", obj, 0, [1, 1]));
  assert.throws(() => api.deletePointOps("object", obj, 0));
});

test("a polygon can be inserted into across its closing edge", () => {
  // the last->first segment is a real edge of a bed and the commonest place you
  // want a new corner; an insert that only knows about i..i+1 cannot reach it
  const poly = api.insertPointOps("bed", BED, 3, [-1, 2])[0].input.polygon;
  assert.equal(poly.length, 5);
  assert.deepEqual(poly[4], [-1, 2], "the new corner did not land after the last one");
});

// ── the wiring ────────────────────────────────────────────────────────────
test("the viewer offers both, on the handles themselves", () => {
  const body = code.slice(code.indexOf("function renderHandles"),
                          code.indexOf("function renderHandles") + 3200);
  assert.match(body, /midpointsFor\(/,
    "there is no way to add a point — only the existing ones are drawn");
  assert.match(code, /insertPointOps\(/, "insertPointOps is never called");
  assert.match(code, /deletePointOps\(/, "deletePointOps is never called");
});

test("both go through the op poster, like every other hand edit", () => {
  for (const fn of ["insertPointOps", "deletePointOps"]) {
    // every occurrence EXCEPT the definition — the call sites are the pointer
    // handlers, which sit earlier in the file than the hand-edit block, so
    // searching forward from the definition finds nothing and says so wrongly
    const def = code.indexOf(`function ${fn}`);
    const sites = [...code.matchAll(new RegExp(`${fn}\\(`, "g"))]
      .map(m => m.index).filter(i => Math.abs(i - def) > 12);
    assert.ok(sites.length, `${fn} has no call site outside its definition`);
    const near = sites.some(i => /postOps\(/.test(code.slice(Math.max(0, i - 500), i + 400)));
    assert.ok(near,
      `${fn} does not post an op — a hand edit that skips the validators is what the one write path prevents`);
  }
});

test("a line gets a midpoint between each pair, a polygon one more", () => {
  // Behaviour, not source shape. Asserting the SHAPE of the loop stays green
  // with the closing edge disabled, which is a test that cannot fail for the
  // thing it is about.
  const line = api.midpointsFor("path", PATH.spline);
  assert.equal(line.length, 2, "a 3-point line should have 2 midpoints");
  assert.deepEqual(line[0].at, [1.5, 0.5]);
  assert.equal(line[1].after, 1);

  const poly = api.midpointsFor("bed", BED.polygon);
  assert.equal(poly.length, 4, "a 4-corner bed needs 4 midpoints, including the closing edge");
  assert.equal(poly[3].after, 3, "the closing edge is not offered");
  assert.deepEqual(poly[3].at, [0, 2], "the closing midpoint is not between the last and first corners");

  assert.deepEqual(api.midpointsFor("object", [1, 2]), [], "a point kind offers midpoints");
  assert.deepEqual(api.midpointsFor("path", [[0, 0]]), []);
});
