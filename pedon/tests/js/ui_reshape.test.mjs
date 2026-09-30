// node --test tests/js/
//
// Change the SHAPE of a thing, not just its numbers.
//
// The user wants to move and edit a corten steel edge the way a real 3D editing
// app allows. Selecting it, moving the whole thing, deleting it and typing new
// values into its fields do not alter its LINE — and the line of a path is what
// a design is most often judged on (too long, too straight, curves that feel
// natural or random). Every such judgement is about a spline, so the spline
// itself must be editable.
//
// The op path is the one-write-path rule: a reshape is an OP, judged by the same
// execute() + validate() a model op is. A vertex dragged onto the house, off the scan, or
// into a grade the ground cannot carry is REJECTED with the reason and undoable
// for free — which is the whole argument for not writing to the file directly.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DESIGN_KINDS } from "../../viewer/src/design_doc.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "schema", "design.schema.json"), "utf8"));

function block(start, end, min) {
  const a = main.indexOf(start), b = main.indexOf(end);
  assert.notEqual(a, -1, `${start} missing`);
  assert.notEqual(b, -1, `${end} missing`);
  const s = main.slice(a + start.length, b);
  assert.ok(s.length > min, `block after ${start} is only ${s.length} chars`);
  // DESIGN_KINDS lives in design_doc.js because the whole-document write needs the
  // same list to know what a replacement must CLEAR. The extracted source
  // uses it as a free variable, so hand it the REAL list rather than a copy —
  // a second copy of this vocabulary can leave a flight of steps undeletable.
  // Only when it is actually referenced, so this stays inert for the blocks
  // that do not use it.
  if (/\bDESIGN_KINDS\b/.test(s))
    return `const DESIGN_KINDS = ${JSON.stringify(DESIGN_KINDS)};\n${s}`;
  return s;
}
const api = new Function(
  `${block("// ── HAND-EDIT-START ──", "// ── HAND-EDIT-END ──", 400)}
   return { reshapeOps, MOVE_AS, geometryOf };`)();

const EDGE = { id: "bank_steel", material: "corten_steel", height_m: 0.3, level_m: -0.85,
               retains: "downhill",
               spline: [[10.8, -1.55], [11.2, -2.6], [11.4, -3.8], [11.2, -4.9], [10.9, -5.55]] };
const BED = { id: "b1", mulch: "shredded bark", level_m: -1.2,
              polygon: [[12, -8], [16, -8], [16, -4], [12, -4]] };

test("every editable kind exposes the geometry a reshape moves", () => {
  for (const [kind, spec] of Object.entries(api.MOVE_AS)) {
    if (spec.point) {
      // an object is a POINT: it has a position, not a line, so there is nothing to drag a handle along and
      // geometryOf must say so rather than handing back a coordinate pair that
      // would render as two handles at x and y metres
      assert.equal(spec.pts, "position", `${kind} is a point kind with pts ${spec.pts}`);
      continue;
    }
    assert.ok(["spline", "polygon"].includes(spec.pts), `${kind} has no point list`);
  }
  assert.deepEqual(api.geometryOf("object", { id: "o", position: [1, 2] }), [],
    "a point object offers reshape handles, which would be two handles at (1,?) and (2,?)");
  assert.equal(api.geometryOf("edge", EDGE).length, 5);
  assert.equal(api.geometryOf("bed", BED).length, 4);
  assert.deepEqual(api.geometryOf("edge", { id: "x" }), []);
});

test("dragging one control point moves ONLY that point", () => {
  const ops = api.reshapeOps("edge", EDGE, 2, [12.1, -3.75]);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].tool, "set_edge");
  const sp = ops[0].input.spline;
  assert.equal(sp.length, 5, "the reshape changed how many points there are");
  assert.deepEqual(sp[2], [12.1, -3.75]);
  for (const i of [0, 1, 3, 4]) assert.deepEqual(sp[i], EDGE.spline[i], `point ${i} moved`);
});

test("it carries every field the op needs, or the edit redesigns the object", () => {
  const inp = api.reshapeOps("edge", EDGE, 0, [10.5, -1.4])[0].input;
  assert.equal(inp.id, "bank_steel");
  assert.equal(inp.height_m, 0.3, "the height was dropped");
  assert.equal(inp.level_m, -0.85, "the level was dropped — the wall stops retaining");
  assert.equal(inp.retains, "downhill");
  // set_edge is SUBMITTED as edge_material and STORED as material
  assert.equal(inp.edge_material, "corten_steel", JSON.stringify(inp));
  assert.equal(inp.material, undefined, "both names were sent");
});

test("a polygon vertex works the same way", () => {
  const inp = api.reshapeOps("bed", BED, 1, [16.8, -8.4])[0].input;
  assert.deepEqual(inp.polygon[1], [16.8, -8.4]);
  assert.equal(inp.polygon.length, 4);
  assert.equal(inp.mulch, "shredded bark");
  assert.equal(inp.level_m, -1.2);
});

test("coordinates are stored to the centimetre, like every other hand edit", () => {
  const sp = api.reshapeOps("edge", EDGE, 1, [11.23456, -2.65432])[0].input.spline;
  assert.deepEqual(sp[1], [11.23, -2.65], `${JSON.stringify(sp[1])} is not stored-centimetre`);
});

test("a drag that does not move it posts nothing", () => {
  assert.deepEqual(api.reshapeOps("edge", EDGE, 2, [11.4, -3.8]), [],
    "re-dropping a handle where it already was costs a validator round trip and a "
    + "timeline entry");
});

test("a bad index is refused rather than silently corrupting the shape", () => {
  for (const i of [-1, 5, 99, null, "2"]) {
    assert.throws(() => api.reshapeOps("edge", EDGE, i, [11, -3]),
      `index ${JSON.stringify(i)} was accepted`);
  }
});

test("no reshape can invent a key the schema rejects", () => {
  const allowed = new Set(Object.keys(schema.properties.edges.items.properties));
  const inp = api.reshapeOps("edge", EDGE, 3, [11.5, -5.0])[0].input;
  for (const k of Object.keys(inp)) {
    assert.ok(allowed.has(k) || k === "edge_material",
      `reshape produced "${k}", which the schema rejects`);
  }
});

// ══ the wiring ════════════════════════════════════════════════════════════
const code = main.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

test("the viewer draws handles on the selected object", () => {
  assert.match(code, /function renderHandles/, "nothing draws the control points");
  assert.match(code, /renderHandles\(/, "renderHandles is never called");
  const body = code.slice(code.indexOf("function renderHandles"),
                          code.indexOf("function renderHandles") + 2400);
  assert.match(body, /geometryOf\(/, "the handles are not built from the object's own geometry");
  assert.match(body, /enuGroup/,
    "handles are added to the scene rather than to enuGroup — they would slide off "
    + "the design the moment north is set, which is this project's oldest bug class");
});

test("dragging a handle posts an op, it does not write the file", () => {
  assert.match(code, /reshapeOps\(/, "the drag never builds a reshape op");
  const i = code.indexOf("handleDrag");
  assert.notEqual(i, -1, "no handle-drag state at all");
  assert.match(code.slice(i, i + 3000), /postOps\(/,
    "a reshape bypasses /api/ops — a hand edit that skips the validators is what "
    + "the one write path exists to prevent");
});

test("handles only appear for ONE selected object", () => {
  const body = code.slice(code.indexOf("function renderHandles"),
                          code.indexOf("function renderHandles") + 900);
  assert.match(body, /selection.*!==\s*1|length\s*!==\s*1|size\s*!==\s*1/,
    "handles are drawn for a multi-selection, where a vertex index means nothing");
});
