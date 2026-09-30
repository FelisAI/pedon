// node --test tests/js/plant_inspector.test.mjs
//
// The first extension, and the slice that proves the contract in pedon/EXTENSIONS.md.
//
// The built-in property inspector is keyed on `MOVE_AS[kind]`, and MOVE_AS has
// rows for path, edge, bed, patio, steps and object — and none for plant. Without
// this extension, selecting a plant (most of the objects in a real design) shows
// NOTHING: plants can be DRAGGED — moveOps has an explicit `kind === "plant"`
// branch — but have no panel, so a user cannot edit a plant by hand.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ext from "../../viewer/src/extensions/plant-inspector/ui.js";
import { checkManifest, createRegistry } from "../../viewer/src/extensions.js";
import { size as unitSize, pair as unitPair, setUnits, parseLen, lenField, lengthUnit }
  from "../../viewer/src/shell/units.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// the smallest DOM this panel touches. Deliberately not jsdom: the shim is the
// specification of what an inspector may use, so a panel reaching for anything
// richer fails here and the sandbox story stays true.
function fakeDoc() {
  const mk = tag => ({
    tag, children: [], attrs: {}, style: {},
    appendChild(c) { this.children.push(c); return c; },
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text ?? ""; },
  });
  return { createElement: mk };
}
function walk(el, out = []) { out.push(el); (el.children ?? []).forEach(c => walk(c, out)); return out; }

const PLANT = {
  id: "p42", species: "Muhlenbergia capillaris", common: "Pink muhly",
  position: [14.5, -7.9], mature_height_m: 0.95, mature_spread_m: 0.95, form: "grass",
};

function render(raw = PLANT, host = {}) {
  global.document = fakeDoc();
  const box = global.document.createElement("div");
  const applied = [];
  const logs = [];
  const ctx = {
    ops: { apply: (ops, what) => { applied.push({ ops, what }); } },
    ui: { log: (m, l) => logs.push([m, l]), size: unitSize, pair: unitPair,
          parseLen, lenField, lengthUnit, ...(host.ui ?? {}) },
    design: { byId: () => ({ raw: host.current ?? raw }) },
    assets: { plant: () => host.palRow ?? null },
  };
  const ins = ext.contributes.inspectors[0];
  ins.render(box, { kind: "plant", raw }, ctx);
  return { box, applied, logs, nodes: walk(box) };
}

test("the manifest is valid and asks for the minimum", () => {
  assert.deepEqual(checkManifest(ext), []);
  assert.deepEqual(ext.permissions.slice().sort(),
    ["assets:read", "design:read", "ops:write", "ui:notify"]);
});

test("it registers for the kind that had no inspector", () => {
  const reg = createRegistry();
  reg.load(ext, { ops: () => ({}), design: () => ({}), assets: () => ({}), ui: () => ({}) });
  assert.equal(reg.inspectorFor("plant").forKind, "plant");
});

test("the extension imports nothing from the app", () => {
  // the review rule that keeps the capability boundary real, and the reason this
  // same file can run in a Worker later without being rewritten
  const src = fs.readFileSync(
    path.join(ROOT, "viewer", "src", "extensions", "plant-inspector", "ui.js"), "utf8");
  const imports = [...src.matchAll(/^\s*import\s.*$/gm)].map(m => m[0]);
  assert.deepEqual(imports, [], `an extension must receive, not import: ${imports}`);
});

test("selecting a plant now renders something", () => {
  const { nodes } = render();
  const text = nodes.map(n => n.textContent).join(" ");
  assert.match(text, /Pink muhly/, "the plant's own name is not shown");
  assert.match(text, /Muhlenbergia capillaris/);
  assert.ok(nodes.some(n => n.tag === "input"), "no editable field at all");
});

test("position is offered as typed x and y, seeded from the plant", () => {
  const inputs = render().nodes.filter(n => n.tag === "input");
  assert.deepEqual(inputs.slice(0, 2).map(i => i.value), [14.5, -7.9]);
});

test("a move is set_plants on the SAME id, so the plant stays in its group", () => {
  // not remove_objects + place_plants: place_plants mints a fresh id, so every
  // typed move would drop the plant out of its group
  const { applied, nodes } = render();
  const [x] = nodes.filter(n => n.tag === "input");
  x.value = 15.25;
  x.onchange();
  assert.equal(applied.length, 1, "nothing was applied");
  assert.deepEqual(applied[0].ops.map(o => o.tool), ["set_plants"]);
  const [p] = applied[0].ops[0].input.plants;
  assert.equal(p.id, "p42", "the id changed — the plant would fall out of its group");
  assert.deepEqual(p.position, [15.25, -7.9]);
});

test("the whole record travels, since set_plants replaces it whole", () => {
  const { applied, nodes } = render();
  const [x] = nodes.filter(n => n.tag === "input");
  x.value = 15.25; x.onchange();
  const p = applied[0].ops[0].input.plants[0];
  for (const k of Object.keys(PLANT).filter(k => k !== "position"))
    assert.equal(p[k], PLANT[k], `${k} was dropped — the op would delete it`);
});

test("a no-op edit applies nothing", () => {
  const { applied, nodes } = render();
  const [x] = nodes.filter(n => n.tag === "input");
  x.value = 14.5;                     // unchanged
  x.onchange();
  assert.equal(applied.length, 0, "an unchanged field still posted an op");
});

test("a non-numeric position is refused before it reaches the ops path", () => {
  const { applied, logs, nodes } = render();
  const [x] = nodes.filter(n => n.tag === "input");
  x.value = "over there";
  x.onchange();
  assert.equal(applied.length, 0);
  assert.match(logs[0][0], /numbers/);
});

test("typed planning sizes use the unit parser and preserve the whole current plant", async () => {
  setUnits("imperial");
  try {
    const current = { ...PLANT, position: [15, -8], flower: "#eeaaaa" };
    const { nodes, applied } = render(PLANT, { current });
    const height = nodes.find(n => n.name === "mature_height_m");
    const width = nodes.find(n => n.name === "mature_spread_m");
    assert.ok(height && width, "size fields are missing");
    height.value = "3 ft"; width.value = "4 ft";
    await nodes.find(n => n.textContent === "Apply size").onclick();
    assert.deepEqual(applied[0].ops, [{tool:"set_plants", input:{plants:[{
      ...current, mature_height_m:3*.3048, mature_spread_m:4*.3048, size_override:true,
    }]}}]);
  } finally { setUnits("metric"); }
});

test("changing only width does not round an untouched height", async () => {
  const raw = { ...PLANT, mature_height_m: .9144 };
  const { nodes, applied } = render(raw);
  nodes.find(n => n.name === "mature_spread_m").value = "1.5 m";
  await nodes.find(n => n.textContent === "Apply size").onclick();
  assert.equal(applied[0].ops[0].input.plants[0].mature_height_m, .9144);
});

test("empty, zero, negative and invalid sizes never post an edit", async () => {
  for (const value of ["", "0", "-1 m", "wide"]) {
    const { nodes, applied, logs } = render();
    nodes.find(n => n.name === "mature_spread_m").value = value;
    await nodes.find(n => n.textContent === "Apply size").onclick();
    assert.equal(applied.length, 0, value);
    assert.ok(logs.length, "invalid size is explained");
  }
});

test("reset uses the catalogue and removes the deliberate size choice", async () => {
  const raw = { ...PLANT, size_override:true };
  const palRow = {mature_height_m:.6, mature_spread_m:.9, cat_safe:null};
  const { nodes, applied } = render(raw, { palRow });
  await nodes.find(n => n.textContent === "Reset to catalogue size").onclick();
  assert.deepEqual(applied[0].ops[0].input.plants[0], {
    ...PLANT, mature_height_m:.6, mature_spread_m:.9,
  });
  assert.match(nodes.map(n => n.textContent).join(" "), /Catalogue height.*0.6 m.*Catalogue width.*0.9 m/);
});

test("cat safety is three-state, and null is NOT reported as safe", () => {
  // where cats have the run of a garden, a design tool guessing at toxicity is
  // the worst answer available
  const unverified = render(PLANT, { palRow: { cat_safe: null } });
  assert.match(unverified.nodes.map(n => n.textContent).join(" "), /not verified/);
  const toxic = render(PLANT, { palRow: { cat_safe: false } });
  assert.match(toxic.nodes.map(n => n.textContent).join(" "), /NO — toxic/);
  const safe = render(PLANT, { palRow: { cat_safe: true } });
  assert.match(safe.nodes.map(n => n.textContent).join(" "), /cat safe\s*yes|yes/);
});

test("the app consults the registry before its own table", () => {
  // the wiring half: without this the extension is registered and never called
  const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
  const i = main.indexOf("function renderProperties");
  const body = main.slice(i, main.indexOf("\n}\n", i));
  const reg = body.indexOf("extensions.inspectorFor");
  const tbl = body.indexOf("MOVE_AS[kind]");
  assert.ok(reg > -1, "renderProperties never asks the registry");
  assert.ok(reg < tbl, "the built-in table is consulted first, so an extension can never own a kind");
});

// the project's unit reaches the facts through ctx.ui, as everything reaches an extension
test("mature size is written in the project's unit, through ctx", () => {
  setUnits("imperial");
  const { nodes } = render(PLANT, { ui: { size: unitSize, pair: unitPair } });
  const text = nodes.map(n => n.textContent + " " + (n.value ?? "")).join(" ");
  setUnits("metric");
  assert.match(text, /3 ft 1.4 in/, "the pink muhly's size is still written in metres");
  assert.doesNotMatch(text, /0\.95 m/);
});
