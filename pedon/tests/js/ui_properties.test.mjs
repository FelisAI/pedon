// node --test tests/js/
//
// The user needs to edit every property of model-created objects directly,
// including paths and walls, with controls like those in a 3D editing app.
//
// Moving objects and swapping plant species is not enough. A wall's height, a
// path's width and material, a patio's purpose and a flight's riser must all be
// editable. Changing a 0.5 m wall to 0.7 m must not require a model redesign.
//
// The op table already knows every field: MOVE_AS carries `keep` precisely so a
// move does not silently redesign the object. So the editable set is not a new
// list to invent and drift — it is that one, read out. A second hand-typed table
// of what a path has can drift from the op table.
//
// An edit is an OP, judged by the same execute() + validate() as a model op.
// A property editor that writes straight to the file
// would reintroduce exactly the off-scan and floating geometry the validators
// exist to catch, except the owner would have authored it and would trust it.
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
  // DESIGN_KINDS in design_doc.js also tells the whole-document write what a
  // replacement must CLEAR. The extracted source uses it as a free variable,
  // so supply the REAL list: a separate copy can omit kinds such as steps from
  // deletion. Only supply it when referenced, so this stays inert for blocks
  // that do not use it.
  if (/\bDESIGN_KINDS\b/.test(s))
    return `const DESIGN_KINDS = ${JSON.stringify(DESIGN_KINDS)};\n${s}`;
  return s;
}
const api = new Function(
  `${block("// ── HAND-EDIT-START ──", "// ── HAND-EDIT-END ──", 400)}
   return { editableFields, propertyOps, MOVE_AS, fieldHelp };`)();

const PATH = { id: "walk", spline: [[0, 0], [3, 1], [6, 0]], width_m: 1.1, material: "gravel" };
const EDGE = { id: "wall", spline: [[0, 0], [4, 0]], height_m: 0.5, material: "stone",
               retains: "uphill", level_m: -1.2 };
const STEPS = { id: "flight", spline: [[0, 0], [2, 2]], width_m: 1.2, riser_m: 0.16, going_m: 0.32,
                material: "stone" };

test("the editable fields come from the op table, not a second list", () => {
  const src = block("// ── HAND-EDIT-START ──", "// ── HAND-EDIT-END ──", 400);
  const fn = src.slice(src.indexOf("function editableFields"), src.indexOf("function editableFields") + 900);
  assert.match(fn, /MOVE_AS/,
    "editableFields does not read MOVE_AS — a second table of what a path has will drift");
});

test("every field the op carries is editable, for every kind", () => {
  for (const [kind, spec] of Object.entries(api.MOVE_AS)) {
    const names = api.editableFields(kind).map(f => f.name);
    for (const k of spec.keep) {
      assert.ok(names.includes(k), `${kind}.${k} is carried by the op and cannot be edited`);
    }
    // the renamed one is a real property too: an edge's material is submitted as
    // edge_material and stored as material, and the user must be able to change it
    for (const from of Object.keys(spec.rename ?? {})) {
      assert.ok(names.includes(from), `${kind}.${from} is not offered`);
    }
  }
});

test("a field knows what it IS, so the editor can show the right control", () => {
  const byName = Object.fromEntries(api.editableFields("edge").map(f => [f.name, f]));
  assert.equal(byName.height_m.type, "number", "a height is typed as text");
  assert.equal(byName.material.type, "select", "material offers no choices at all");
  assert.ok(byName.material.options.length >= 6, byName.material.options);
  assert.equal(byName.retains.type, "select");
  assert.deepEqual(byName.retains.options, ["uphill", "downhill", "none"]);
});

test("material offers the MODELLED list but does not fence it", () => {
  // free text: the library must not cap the design. A <select> that only offers
  // six materials would impose that limit in the interface.
  const mat = api.editableFields("path").find(f => f.name === "material");
  assert.equal(mat.free, true,
    "the material control is a closed list — the schema allows free text "
    + "and the picker must allow it too");
  assert.ok(mat.options.includes("decomposed_granite"), mat.options);
});

test("changing one property re-places the object and keeps the rest", () => {
  const ops = api.propertyOps("path", PATH, "width_m", 1.6);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].tool, "set_path");
  const inp = ops[0].input;
  assert.equal(inp.id, "walk");
  assert.equal(inp.width_m, 1.6, "the change did not take");
  assert.equal(inp.material, "gravel", "the material was dropped — the edit redesigned the path");
  assert.deepEqual(inp.spline, PATH.spline, "the geometry moved during a property edit");
});

test("an edge's material goes back under the name the op expects", () => {
  // set_edge is SUBMITTED as edge_material and STORED as material; passing the
  // stored name straight back raises "set_edge missing 'edge_material'"
  const inp = api.propertyOps("edge", EDGE, "material", "dry_stone")[0].input;
  assert.equal(inp.edge_material, "dry_stone", JSON.stringify(inp));
  assert.equal(inp.material, undefined, "both names were sent");
  assert.equal(inp.height_m, 0.5, "the height was dropped");
  assert.equal(inp.retains, "uphill");
});

test("setting a field to nothing removes it rather than writing empty", () => {
  // level_m is the live case: a path with level_m renders FLAT, and clearing it
  // must make the path follow the ground again, not set it to 0 m
  const inp = api.propertyOps("path", { ...PATH, level_m: -2 }, "level_m", "")[0].input;
  assert.equal("level_m" in inp, false, `level_m came back as ${inp.level_m}`);
});

test("no edit can invent a key the schema will reject", () => {
  const allowed = {
    path: new Set(Object.keys(schema.properties.paths.items.properties)),
    steps: new Set(Object.keys(schema.properties.steps.items.properties)),
  };
  for (const [kind, raw] of [["path", PATH], ["steps", STEPS]]) {
    for (const f of api.editableFields(kind)) {
      // a value guaranteed to DIFFER from what the fixture holds, or propertyOps
      // correctly posts nothing and there is no op to inspect
      const v = f.type === "number" ? (raw[f.name] ?? 0) + 0.37 : `x_${f.name}`;
      const ops = api.propertyOps(kind, raw, f.name, v);
      assert.equal(ops.length, 1, `editing ${kind}.${f.name} produced no op`);
      const inp = ops[0].input;
      for (const k of Object.keys(inp)) {
        assert.ok(allowed[kind].has(k) || k === "id",
          `editing ${kind}.${f.name} produced key "${k}", which the schema rejects`);
      }
    }
  }
});

test("an unchanged value posts nothing", () => {
  assert.deepEqual(api.propertyOps("path", PATH, "width_m", 1.1), [],
    "re-selecting the same value still costs a validator round trip and a timeline entry");
});

// ══ the wiring ════════════════════════════════════════════════════════════
const code = main.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

test("the inspector is rendered, and goes through the same op path as everything else", () => {
  // the inspector is a card beside the selection (src/shell/inspector.js).
  // It must render, and every edit must go through the op path.
  assert.match(code, /const box = inspector\.body/,
    "renderProperties no longer draws into the inspector card");
  assert.match(code, /function renderProperties/, "nothing renders it");
  assert.match(code, /renderProperties\(/, "renderProperties is never called");
  // BRACE-SCAN, not a fixed 3,000-character window: renderProperties can grow
  // past that window and hide the op poster from the assertion. A test must
  // inspect the whole function to avoid reporting an unrelated size change
  // as a bypass of the validators.
  const body = (() => {
    const i = code.indexOf("function renderProperties");
    assert.notStrictEqual(i, -1, "renderProperties is gone — retarget this test");
    let depth = 0;
    for (let j = code.indexOf("{", i); j < code.length; j++) {
      if (code[j] === "{") depth++;
      else if (code[j] === "}" && !--depth) return code.slice(i, j + 1);
    }
    throw new Error("unbalanced braces in renderProperties");
  })();
  assert.match(body, /propertyOps\(/, "the panel does not build ops");
  assert.match(body, /postOps\(|sendOps\(|applyOps\(/,
    "a property edit does not go through the op poster — a hand edit that bypasses "
    + "the validators can create off-scan or floating geometry");
});

test("the ONE function that owns the selection rebuilds the inspector and handles", () => {
  // setSelection owns what is selected and must update the selection bar,
  // property panel and handles for every entry point: the Objects list,
  // deselect and the agent's --selection. Scattered calls to renderProperties
  // and renderHandles can leave these paths with a partly updated UI.
  //
  // The owner of the state must also apply its consequences in one place.
  const body = code.slice(code.indexOf("function setSelection"),
                          code.indexOf("function setSelection") + 700);
  assert.ok(body.length > 80, "setSelection not found");
  // The renderers are invoked through a list, each in its own try/catch. A
  // ReferenceError in renderProperties must not prevent renderHandles from
  // running and leave the user unable to reshape a curve. Assert that all are
  // REACHED, not that they are literally called with parentheses.
  for (const fn of ["renderSelection", "renderProperties", "renderHandles"]) {
    assert.ok(body.includes(fn), `setSelection does not reach ${fn}`);
  }
  assert.match(body, /try\s*\{[^}]*\}\s*catch/,
    "one renderer throwing still takes the other two down with it");
});

test("the shift-click branch keeps up too, since it edits the selection directly", () => {
  // the toggle is over a LIST, because a grouped object is picked as its
  // whole group and toggling it member by member would leave half a
  // group selected off one click
  const i = code.indexOf("for (const x of ids) all ? selection.delete(x) : selection.add(x)");
  assert.notEqual(i, -1, "the shift-click toggle moved");
  const after = code.slice(i, i + 260);
  assert.match(after, /renderProperties\(\)/, "shift-click leaves a stale inspector");
  assert.match(after, /renderHandles\(\)/, "shift-click leaves stale handles");
});

test("a field says what it DOES, not just what it is called", () => {
  // The user needs to fit an edge to the slope at a constant height. An edge
  // with level_m set has a FLAT TOP at that elevation, so on a slope one end
  // stands tall and the other buries — bank_steel measures 0.14 m at one end
  // and 0.25 m at the other. Clearing level_m makes it follow the ground at a
  // constant height; rotation is not the control for this. Bare field names
  // cannot explain that to the user.
  const hints = api.fieldHelp;
  assert.ok(hints && typeof hints === "object", "no per-field explanations at all");
  const lvl = hints.level_m ?? "";
  assert.match(lvl, /flat/i, `level_m help does not say it makes a flat top: "${lvl}"`);
  assert.match(lvl, /follow|ground/i, "it does not say what clearing it does");
  for (const f of ["height_m", "retains", "batter_deg", "material"]) {
    assert.ok((hints[f] ?? "").length > 20, `${f} has no explanation`);
  }
});

test("the explanation reaches the panel, not just the source", () => {
  const body = code.slice(code.indexOf("function renderProperties"),
                          code.indexOf("function renderProperties") + 3400);
  assert.match(body, /fieldHelp/, "renderProperties never uses the explanations");
  assert.match(body, /title\s*=|\.hint/,
    "the explanation is looked up and not shown anywhere the owner can read it");
});
