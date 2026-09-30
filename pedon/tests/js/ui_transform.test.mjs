// node --test tests/js/
//
// Put a thing EXACTLY somewhere, and never call two features the same name.
//
// Two features with nearly the same name — "Walk the garden" (the free camera,
// WASD) and "Walk through" (eight rendered stills for the critique) — make the
// free camera look missing: a user who wants to walk through the garden
// themselves reads a label that points at the wrong one.
//
// Moving and rotating work like a regular 3D editing app. Dragging places a
// thing approximately. Every 3D app also lets you TYPE where it goes, and this
// one stores everything to the centimetre — so position and rotation need fields
// of their own: MOVE_AS carries geometry in `pts`, and the inspector shows only
// `keep` from it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DESIGN_KINDS } from "../../viewer/src/design_doc.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");
const code = main.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

function block(start, end, min) {
  const a = main.indexOf(start), b = main.indexOf(end);
  assert.notEqual(a, -1, `${start} missing`);
  const s = main.slice(a + start.length, b);
  assert.ok(s.length > min, `block after ${start} is only ${s.length} chars`);
  // DESIGN_KINDS lives in design_doc.js because the whole-document write needs
  // the same list to know what a replacement must CLEAR. The extracted source
  // uses it as a free variable, so hand it the REAL list rather than a copy —
  // a second copy of this vocabulary drifts until an object cannot be deleted.
  // Only when it is actually referenced, so this stays inert for the blocks
  // that do not use it.
  if (/\bDESIGN_KINDS\b/.test(s))
    return `const DESIGN_KINDS = ${JSON.stringify(DESIGN_KINDS)};\n${s}`;
  return s;
}
const api = new Function(
  `${block("// ── HAND-EDIT-START ──", "// ── HAND-EDIT-END ──", 400)}
   return { editableFields, propertyOps, MOVE_AS };`)();

const LANTERN = { id: "lantern", kind: "lantern", position: [11.2, 3.4],
                  height_m: 1.4, rotation_deg: 20 };

// ── the two walks must not share a name ───────────────────────────────────
test("the free camera and the rendered stills have different names", () => {
  const label = (id) => {
    const m = html.match(new RegExp(`<button id="${id}"[^>]*>([^<]*)<`));
    assert.ok(m, `${id} not found`);
    return m[1].trim().toLowerCase();
  };
  const fly = label("btnFly"), stills = label("btnWalk");
  assert.notEqual(fly, stills, "the two features have the SAME label");
  assert.ok(!(fly.includes("walk") && stills.includes("walk")),
    `both are called walk-something ("${fly}" / "${stills}") — that collision `
    + "makes the free camera look missing");
});

test("the stills button says it renders pictures", () => {
  const m = html.match(/<button id="btnWalk"[^>]*title="([^"]*)"/);
  assert.ok(m, "btnWalk has no tooltip");
  assert.match(m[1], /render|still|image|photo|frame/i,
    `"${m[1]}" does not say it produces pictures rather than putting you in the garden`);
});

// ── type a position ───────────────────────────────────────────────────────
test("a point object can be placed by typing x and y", () => {
  const names = api.editableFields("object").map(f => f.name);
  for (const n of ["x_m", "y_m"]) {
    assert.ok(names.includes(n), `no ${n} field; fields are ${JSON.stringify(names)}`);
  }
  const inp = api.propertyOps("object", LANTERN, "x_m", 12.75)[0].input;
  assert.deepEqual(inp.position, [12.75, 3.4], "typing x moved the wrong coordinate");
  assert.equal(inp.kind, "lantern", "typing a coordinate changed what it is");
  const inp2 = api.propertyOps("object", LANTERN, "y_m", -1.5)[0].input;
  assert.deepEqual(inp2.position, [11.2, -1.5]);
});

test("typing the position it already has posts nothing", () => {
  assert.deepEqual(api.propertyOps("object", LANTERN, "x_m", 11.2), []);
});

test("a coordinate is stored to the centimetre like every other hand edit", () => {
  const inp = api.propertyOps("object", LANTERN, "x_m", 12.3456)[0].input;
  assert.deepEqual(inp.position, [12.35, 3.4]);
});

test("x and y are NOT offered on things that are a line, not a point", () => {
  // a path has a whole spline; one x/y pair would be meaningless, and the
  // control-point handles are how you move those
  for (const kind of ["path", "edge", "bed", "patio", "steps"]) {
    const names = api.editableFields(kind).map(f => f.name);
    assert.ok(!names.includes("x_m"), `${kind} offers an x field and has a ${api.MOVE_AS[kind].pts}`);
  }
});

test("the position fields carry an explanation, like every other field", () => {
  const src = block("// ── HAND-EDIT-START ──", "// ── HAND-EDIT-END ──", 400);
  for (const f of ["x_m", "y_m"]) {
    assert.match(src, new RegExp(`${f}:\\s*"`), `${f} has no entry in fieldHelp`);
  }
});
