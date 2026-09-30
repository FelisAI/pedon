// node --test tests/js/
//
// The landscape objects must be reachable in the viewer.
//
// `objects[]` exists so that a lantern, a water basin, a moon gate or a set
// boulder can exist at all — and unless `DESIGN_KINDS` lists them, a design with
// SIXTEEN of them has not one that can be selected, moved, measured or edited.
//
// Everything the model made — a path, a wall, an object — must have all of its
// properties editable; the viewer needs to feel close to a 3D editing app. A
// garden object you cannot click is the clearest possible failure of that.
//
// Duplicate lives here too. Setting a group of stones or a row of lanterns by
// hand means placing one and copying it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DESIGN_KINDS } from "../../viewer/src/design_doc.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "schema", "design.schema.json"), "utf8"));

function block(start, end, min) {
  const a = main.indexOf(start), b = main.indexOf(end);
  assert.notEqual(a, -1, `${start} missing`);
  const s = main.slice(a + start.length, b);
  assert.ok(s.length > min, `block after ${start} is only ${s.length} chars`);
  // DESIGN_KINDS lives in design_doc.js because the whole-document write needs
  // the same list to know what a replacement must CLEAR. The extracted source
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
   return { DESIGN_KINDS, MOVE_AS, rawById, moveOps, propertyOps, editableFields,
            duplicateOps, geometryOf };`)();

const LANTERN = { id: "lantern", kind: "lantern", position: [11.2, 3.4],
                  height_m: 1.4, rotation_deg: 20 };
const MUHLY = { id: "p200", species: "Muhlenbergia capillaris 'White Cloud'",
                common: "White Cloud Muhly", form: "grass", position: [15.23, -9.65],
                mature_height_m: 1.05, mature_spread_m: 1.0, foliage: "#7d8a5a" };
const DESIGN = { objects: [LANTERN], plants: [], paths: [], beds: [], patios: [], edges: [], steps: [] };

test("an object is a design object like any other", () => {
  const kinds = api.DESIGN_KINDS.map(([, k]) => k);
  assert.ok(kinds.includes("object"),
    `DESIGN_KINDS is ${JSON.stringify(kinds)} — an object cannot be found by id, so it `
    + "cannot be selected, measured or edited");
  const found = api.rawById(DESIGN, "lantern");
  assert.ok(found, "rawById cannot find an object");
  assert.equal(found.kind, "object");
  assert.equal(found.raw.id, "lantern");
});

test("an object can be MOVED, as an op", () => {
  const ops = api.moveOps("object", LANTERN, 0.5, -0.25);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].tool, "place_object");
  assert.deepEqual(ops[0].input.position, [11.7, 3.15]);
  assert.equal(ops[0].input.kind, "lantern", "the move dropped what it IS");
  assert.equal(ops[0].input.height_m, 1.4, "the move dropped its size");
  assert.equal(ops[0].input.rotation_deg, 20, "the move dropped its rotation");
});

test("a sub-centimetre nudge still posts nothing", () => {
  assert.deepEqual(api.moveOps("object", LANTERN, 0.001, 0), []);
});

test("its properties are editable, ROTATION included", () => {
  const names = api.editableFields("object").map(f => f.name);
  for (const k of ["kind", "height_m", "width_m", "rotation_deg", "material"]) {
    assert.ok(names.includes(k), `${k} cannot be edited; fields are ${JSON.stringify(names)}`);
  }
  const inp = api.propertyOps("object", LANTERN, "rotation_deg", 65)[0].input;
  assert.equal(inp.rotation_deg, 65);
  assert.equal(inp.kind, "lantern", "editing the rotation changed what it is");
  assert.deepEqual(inp.position, [11.2, 3.4], "editing a property moved it");
});

test("kind is FREE TEXT here too — the picker must not fence it back in", () => {
  const f = api.editableFields("object").find(x => x.name === "kind");
  assert.equal(f.free, true, "the kind control is a closed list");
  assert.ok(f.options.length >= 6, "it offers no suggestions at all");
  const inp = api.propertyOps("object", LANTERN, "kind", "tea house")[0].input;
  assert.equal(inp.kind, "tea house");
});

test("no object edit invents a key the schema rejects", () => {
  const allowed = new Set(Object.keys(schema.properties.objects.items.properties));
  for (const f of api.editableFields("object")) {
    const v = f.type === "number" ? 1.25 : "x";
    const ops = api.propertyOps("object", LANTERN, f.name, v);
    if (!ops.length) continue;
    for (const k of Object.keys(ops[0].input)) {
      assert.ok(allowed.has(k), `editing object.${f.name} produced "${k}"`);
    }
  }
});

// ── duplicate ─────────────────────────────────────────────────────────────
test("duplicating gives the copy a NEW id, or it overwrites the original", () => {
  const ops = api.duplicateOps("object", LANTERN, 0.8, 0);
  assert.equal(ops.length, 1);
  assert.notEqual(ops[0].input.id, "lantern",
    "the copy reuses the id — place_object replaces by id, so this DELETES the original");
  assert.deepEqual(ops[0].input.position, [12.0, 3.4], "the copy landed on top of the original");
  assert.equal(ops[0].input.kind, "lantern");
  assert.equal(ops[0].input.height_m, 1.4);
});

test("duplicating a path copies its whole line, offset", () => {
  const p = { id: "walk", spline: [[0, 0], [2, 1], [4, 0]], width_m: 1.1, material: "gravel" };
  const inp = api.duplicateOps("path", p, 1, 1)[0].input;
  assert.notEqual(inp.id, "walk");
  assert.equal(inp.spline.length, 3);
  assert.deepEqual(inp.spline[0], [1, 1]);
  assert.equal(inp.material, "gravel");
});

test("copies do not collide with each other", () => {
  const a = api.duplicateOps("object", LANTERN, 1, 0)[0].input.id;
  const b = api.duplicateOps("object", { ...LANTERN, id: a }, 1, 0)[0].input.id;
  assert.notEqual(a, b, "copying a copy reuses the id and destroys it");
});

// ── the wiring ────────────────────────────────────────────────────────────
const code = main.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const html = fs.readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");

test("there is a duplicate button and it posts an op", () => {
  assert.match(html, /id="btnSelDuplicate"/, "no duplicate control");
  assert.match(code, /getElementById\("btnSelDuplicate"\)/, "the button does nothing");
  const i = code.indexOf('getElementById("btnSelDuplicate")');
  assert.match(code.slice(i, i + 700), /duplicateOps\(/, "it does not build duplicate ops");
});

// ── a plant can be duplicated ──────────────────────────────────────
// MOVE_AS has no `plant` row, because moving a plant is not replace-by-id, so
// duplicate must not read that table as "what can be copied" — if it does, every
// plant in the garden is refused with "nothing in the selection can be
// duplicated".

test("duplicating a plant emits a PLACE, and never the remove half of a move", () => {
  const ops = api.duplicateOps("plant", MUHLY, 0.6, 0.6);
  assert.equal(ops.length, 1, "a copy that also removes the original is a move");
  assert.equal(ops[0].tool, "place_plants");
  assert.ok(!ops.some(o => o.tool === "remove_objects"), "the original is deleted by the copy");
  const [copy] = ops[0].input.plants;
  assert.deepEqual(copy.position, [15.83, -9.05], "the copy landed on top of the original");
  assert.equal(copy.species, MUHLY.species);
  assert.equal(copy.mature_spread_m, MUHLY.mature_spread_m, "the copy lost the size it is spaced by");
  assert.ok(!("id" in copy), "an invented id: place_plants mints one, and a collision is a rejection");
});

test("the button offers it for plants as well — the table is not the gate", () => {
  const src = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
  const dup = src.slice(src.indexOf('getElementById("btnSelDuplicate")'),
                        src.indexOf("};", src.indexOf('getElementById("btnSelDuplicate")')));
  assert.match(dup, /found\.kind !== "plant" && !MOVE_AS\[found\.kind\]/,
    "the loop skips anything MOVE_AS does not list, which is every plant");
  assert.match(dup, /plantedAt/, "a plant copy has no id until it is written; nothing reads it back");
});
