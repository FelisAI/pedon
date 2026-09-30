// node --test tests/js/ui_place.test.mjs
//
// The owner can put a plant down by hand — and it goes through the SAME
// validators a model-emitted op does.
//
// That constraint is the whole feature, not a nicety. agent.execute() +
// validate() already own every rule this yard has — spacing at mature spread,
// cut/fill, retaining limits, on-scanned-ground, the area restriction — and a
// hand-edit that writes design.json directly reintroduces exactly the floating
// and off-scan geometry the validators exist to catch, except the OWNER authored
// it and will trust it more than the model's. So the viewer's job is NOT to
// place a plant. It is to emit an OP and post it down the one pipeline.
//
// Dragging cannot be tested headlessly — no WebGL, no pointer, no scan — so
// what is tested here is the layer that can be, which is also the layer that
// decides whether the constraint holds: given a pick at ENU (x, y) and a chosen
// palette entry, exactly which op object gets posted. Four parts:
//
//   1. EMISSION — plantOp / moveOps / paletteEntries / rawById run for real.
//      main.js cannot be imported (it builds a WebGLRenderer at module scope),
//      so the pure block is extracted between two markers and evaluated, the
//      same trick ui_groups.test.mjs uses. Both markers are asserted found, in
//      order, and every extracted name asserted to be a function: slicing from
//      an indexOf that returned -1 is `slice(-1)`, the file's LAST CHARACTER,
//      and a test over it stays green with the bug sitting in the file.
//   2. GROUND TRUTH — the emitted plant is checked against
//      schema/design.schema.json and the library manifest ON DISK, not against
//      numbers typed into this file. A palette entry carries display fields
//      (label, count, source) and the design schema is additionalProperties:
//      false, so one spread `{...entry}` into the op would make every hand
//      placement fail schema validation — server-side, silently, as a rejection.
//   3. THE ONE PIPELINE — no hand-edit path may write design.json itself.
//      This is the assertion the feature exists for.
//   4. WIRING — the button, the palette and the click branch. A perfect op
//      emitter nothing calls is invisible.
//
// Counts and identities are asserted BEFORE deltas everywhere: a test that
// asserts only the gaps between stair levels passes vacuously on the broken
// case — a single tread has no gaps.
import { UNIT_NAMES, UNIT_FNS } from "./lib/units_scope.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DESIGN_KINDS } from "../../viewer/src/design_doc.js";
import path from "node:path";
import { MIN_ASSET_HEIGHT_M } from "../../viewer/src/assets.js";
import { plantManifest } from "./lib/library.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const html = readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");
const schema = JSON.parse(readFileSync(path.join(ROOT, "schema", "design.schema.json"), "utf8"));
const manifest = plantManifest();

// ── extraction ────────────────────────────────────────────────────────────
const START = "// ── HAND-EDIT-START ──";
const END = "// ── HAND-EDIT-END ──";

function handEditSource() {
  const a = main.indexOf(START);
  const b = main.indexOf(END);
  assert.notEqual(a, -1, `${START} missing from main.js — nothing was extracted`);
  assert.notEqual(b, -1, `${END} missing from main.js — nothing was extracted`);
  assert.ok(b > a, "the hand-edit markers are in the wrong order");
  const block = main.slice(a + START.length, b);
  assert.ok(block.length > 400, `the extracted block is only ${block.length} chars`);
  // DESIGN_KINDS lives in design_doc.js because the whole-document write needs
  // the same list to know what a replacement must CLEAR. The extracted source
  // uses it as a free variable, so hand it the REAL list rather than a copy —
  // a second copy of this vocabulary drifts, and a kind missing from one copy
  // cannot be deleted. Only when it is actually referenced, so this stays inert
  // for the blocks that do not use it.
  if (/\bDESIGN_KINDS\b/.test(block))
    return `const DESIGN_KINDS = ${JSON.stringify(DESIGN_KINDS)};\n${block}`;
  return block;
}

const EXPORTED = ["paletteEntries", "plantOp", "moveOps", "rawById", "areaOp"];
const api = new Function(...UNIT_NAMES,
  `${handEditSource()}\nreturn { ${EXPORTED.join(", ")} };`)(...UNIT_FNS);

/** End index (exclusive) of the {...} block that opens at or after `from`. */
function blockEnd(s, from) {
  const open = s.indexOf("{", from);
  assert.notEqual(open, -1, "no block found");
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") { depth--; if (!depth) return i + 1; }
  }
  throw new Error("unbalanced braces");
}

// A comment is not a wiring. A test that asks whether a handler "mentions
// settings" stays green with the branch deleted, because the comment explaining
// the branch is still there. Every source assertion below runs on code with the
// prose stripped out.
const codeOnly = s => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** The source text of a named function in main.js, asserted non-trivial. */
function fnBody(name) {
  const at = main.search(new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`));
  assert.notEqual(at, -1, `function ${name} not found in main.js`);
  const body = codeOnly(main.slice(at, blockEnd(main, at)));
  assert.ok(body.length > 60, `${name} is only ${body.length} chars — nothing was extracted`);
  return body;
}

// ── the fixture design ────────────────────────────────────────────────────
// Shaped like the live file: repeated species (deergrass x2), a species with no
// declared mature size (the schema requires only id/species/position, so this
// is legal on disk and is NOT legal in a place_plants op), and one object of
// every kind a drag can pick up.
const DESIGN = {
  plants: [
    { id: "p1", species: "Muhlenbergia rigens", common: "deergrass", position: [1, 2], mature_spread_m: 1.3, mature_height_m: 1.3 },
    { id: "p2", species: "Muhlenbergia rigens", common: "deergrass", position: [3, 2], mature_spread_m: 1.3, mature_height_m: 1.3 },
    { id: "p3", species: "Heteromeles arbutifolia", common: "toyon", position: [5, 2], mature_spread_m: 3, mature_height_m: 3.5, form: "mound" },
    { id: "p4", species: "Nameless sp.", common: "nameless", position: [7, 2] },
  ],
  beds: [{ id: "b1", polygon: [[0, 0], [2, 0], [2, 2], [0, 2]], mulch: "shredded_hardwood", level_m: 12.5 }],
  paths: [{ id: "w1", spline: [[0, 0], [5, 5]], width_m: 1.2, material: "flagstone" }],
  edges: [{ id: "e1", spline: [[0, 0], [4, 0]], height_m: 0.7, material: "corten_steel", retains: "uphill", thickness_m: 0.1 }],
  patios: [{ id: "t1", polygon: [[0, 0], [3, 0], [3, 3], [0, 3]], material: "decomposed_granite", purpose: "dining" }],
  steps: [{ id: "s1", spline: [[0, 0], [0, 2]], width_m: 1.0, riser_m: 0.17, going_m: 0.3 }],
};

const entryFor = species =>
  api.paletteEntries(DESIGN, manifest, MIN_ASSET_HEIGHT_M).find(e => e.species === species);

// ══ 1. EMISSION ═══════════════════════════════════════════════════════════
test("every extracted name is a function", () => {
  for (const n of EXPORTED) assert.equal(typeof api[n], "function", `${n} is not a function`);
});

test("a pick and a species emit exactly one place_plants op", () => {
  const op = api.plantOp(entryFor("Muhlenbergia rigens"), 12.345, -5.678);
  assert.deepEqual(op, {
    tool: "place_plants",
    input: {
      plants: [{
        species: "Muhlenbergia rigens",
        common: "deergrass",
        position: [12.35, -5.68],
        mature_spread_m: 1.3,
        mature_height_m: 1.3,
      }],
    },
  });
});

test("the placed position is rounded to the stored centimetre, without -0", () => {
  const op = api.plantOp(entryFor("Muhlenbergia rigens"), -0.001, 4);
  const [x, y] = op.input.plants[0].position;
  // agent.STORED_POSITION_TOL_M = 0.015 exists because every stored coordinate
  // in this project is written at 2 dp; a raycast hit is not.
  assert.equal(x, 0);
  assert.ok(Object.is(x, 0), "-0 leaks into the op (and into the diff of every design)");
  assert.equal(y, 4);
});

test("a declared form travels with the plant, and an absent one is not invented", () => {
  const withForm = api.plantOp(entryFor("Heteromeles arbutifolia"), 1, 1).input.plants[0];
  assert.equal(withForm.form, "mound");
  const without = api.plantOp(entryFor("Muhlenbergia rigens"), 1, 1).input.plants[0];
  assert.ok(!("form" in without), "form appeared on a plant that never declared one");
});

test("a plant with no mature size is refused, not placed with a guessed one", () => {
  const e = entryFor("Nameless sp.");
  assert.ok(e, "the species is still offered in the palette");
  assert.equal(e.placeable, false);
  assert.throws(() => api.plantOp(e, 1, 1), /mature size/i);
});

test("a pick that missed the ground cannot become a plant", () => {
  const e = entryFor("Muhlenbergia rigens");
  assert.throws(() => api.plantOp(e, NaN, 3), /position|finite|number/i);
  assert.throws(() => api.plantOp(e, 3, undefined), /position|finite|number/i);
});

// ── the palette ───────────────────────────────────────────────────────────
test("the palette leads with the species already in this design, deduped and counted", () => {
  const p = api.paletteEntries(DESIGN, manifest, MIN_ASSET_HEIGHT_M);
  const mine = p.filter(e => e.source === "design");
  // count and identity BEFORE order: an assertion about order is satisfied by
  // an empty list, and an empty palette is exactly the failure worth catching
  assert.equal(mine.length, 3, "one entry per distinct species — 4 plants, 3 species");
  assert.deepEqual(mine.map(e => e.species),
    ["Muhlenbergia rigens", "Heteromeles arbutifolia", "Nameless sp."]);
  // 8-12 species in odd-numbered drifts is this project's rule, and left free
  // the model returns ~27 species for 32 plants. Reaching for something already
  // planted is therefore the common case, so it is the top of the list.
  assert.equal(p[0].species, "Muhlenbergia rigens");
  assert.deepEqual(mine.map(e => e.count), [2, 1, 1]);
  // the sizes are THIS design's facts, not a number typed into the viewer
  assert.equal(mine[1].mature_spread_m, 3);
  assert.equal(mine[1].mature_height_m, 3.5);
});

test("library shapes fill out the palette at the size the library really draws", () => {
  const p = api.paletteEntries(DESIGN, manifest, MIN_ASSET_HEIGHT_M);
  const lib = p.filter(e => e.source === "library");
  const names = Object.keys(manifest);
  assert.equal(lib.length, names.length, "one entry per model in the manifest");
  for (const e of lib) {
    assert.ok(manifest[e.asset], `${e.asset} is not a model in the manifest`);
    // the number comes off the manifest, not out of this file — a re-generated
    // library moves it and nothing here has to be retyped
    assert.equal(e.mature_spread_m, manifest[e.asset].spread_m);
    assert.ok(e.mature_height_m >= MIN_ASSET_HEIGHT_M,
      `${e.asset} would be placed at ${e.mature_height_m} m, under the ${MIN_ASSET_HEIGHT_M} m `
      + "gate — the owner picks a SHAPE and gets a procedural blob");
    assert.equal(e.placeable, true);
  }
});

test("a library pick places the model the owner actually pointed at", () => {
  const oak = api.paletteEntries(DESIGN, manifest, MIN_ASSET_HEIGHT_M)
    .find(e => e.source === "library" && e.asset === "oak");
  assert.ok(oak, "no oak in the library palette");
  const pl = api.plantOp(oak, 2, 3).input.plants[0];
  // assets.assetName() honours `asset` before any species regex, so this is the
  // only way the user's choice of model survives the trip through the router
  assert.equal(pl.asset, "oak");
});

// ── moving what is already there ──────────────────────────────────────────
test("a moved bed is an upsert of the SAME id, with every field it had", () => {
  const ops = api.moveOps("bed", DESIGN.beds[0], 1.234, -0.5);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].input.polygon.length, 4, "vertices were lost in the move");
  assert.deepEqual(ops[0], {
    tool: "upsert_bed",
    input: {
      id: "b1",
      polygon: [[1.23, -0.5], [3.23, -0.5], [3.23, 1.5], [1.23, 1.5]],
      mulch: "shredded_hardwood",
      level_m: 12.5,
    },
  });
});

test("a moved bed with no level_m does not acquire one", () => {
  const ops = api.moveOps("bed", { id: "b9", polygon: [[0, 0], [1, 0], [1, 1]] }, 1, 1);
  assert.equal(ops.length, 1);
  assert.ok(!("level_m" in ops[0].input),
    "a level appeared on a bed that had none — that is a terrace nobody asked for");
});

test("a moved edge is emitted as edge_material, which is not what it is stored as", () => {
  const ops = api.moveOps("edge", DESIGN.edges[0], 2, 0);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].tool, "set_edge");
  assert.equal(ops[0].input.spline.length, 2);
  // execute() reads inp["edge_material"] and stores it as "material": passing
  // the stored name through unchanged raises "set_edge missing 'edge_material'"
  assert.equal(ops[0].input.edge_material, "corten_steel");
  assert.ok(!("material" in ops[0].input));
  assert.equal(ops[0].input.height_m, 0.7);
  assert.equal(ops[0].input.retains, "uphill");
  assert.equal(ops[0].input.thickness_m, 0.1);
  assert.deepEqual(ops[0].input.spline, [[2, 0], [6, 0]]);
});

test("a moved path keeps its width and material", () => {
  const ops = api.moveOps("path", DESIGN.paths[0], 0, 1.5);
  assert.equal(ops.length, 1);
  assert.deepEqual(ops[0], {
    tool: "set_path",
    input: { id: "w1", spline: [[0, 1.5], [5, 6.5]], width_m: 1.2, material: "flagstone" },
  });
});

test("a moved patio keeps its purpose — that is what makes it usable area", () => {
  const ops = api.moveOps("patio", DESIGN.patios[0], -1, 0);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].tool, "set_patio");
  assert.equal(ops[0].input.polygon.length, 4);
  assert.equal(ops[0].input.purpose, "dining");
  assert.equal(ops[0].input.material, "decomposed_granite");
});

test("moved steps keep the riser and going the validator just approved", () => {
  const ops = api.moveOps("steps", DESIGN.steps[0], 1, 0);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].tool, "set_steps");
  assert.equal(ops[0].input.riser_m, 0.17);
  assert.equal(ops[0].input.going_m, 0.3);
  assert.equal(ops[0].input.width_m, 1.0);
});

test("a moved plant keeps its id, so it stays in its group", () => {
  // not remove_objects + place_plants: place_plants mints a fresh id, so dragging a
  // five-plant group that way deletes the group by the fourth member
  const ops = api.moveOps("plant", DESIGN.plants[0], 2, -1);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].tool, "set_plants");
  const [p] = ops[0].input.plants;
  assert.deepEqual(p, { ...DESIGN.plants[0], position: [3, 1] },
    "a field of the plant was dropped or changed in the move");
  assert.ok(!ops.some(o => o.tool === "remove_objects" || o.tool === "place_plants"));
});

test("a move smaller than the stored centimetre emits nothing at all", () => {
  assert.deepEqual(api.moveOps("bed", DESIGN.beds[0], 0.004, -0.001), []);
  assert.deepEqual(api.moveOps("plant", DESIGN.plants[0], 0, 0), []);
  // and one that rounds to a real centimetre still does
  assert.equal(api.moveOps("bed", DESIGN.beds[0], 0.006, 0).length, 1);
});

test("an object kind with no op cannot be silently dragged nowhere", () => {
  assert.throws(() => api.moveOps("landmark", { id: "x" }, 1, 1), /landmark/);
});

test("rawById finds an object of every kind, and nothing that is not there", () => {
  const kinds = { p1: "plant", b1: "bed", w1: "path", e1: "edge", t1: "patio", s1: "steps" };
  assert.equal(Object.keys(kinds).length, 6);
  for (const [id, kind] of Object.entries(kinds)) {
    const hit = api.rawById(DESIGN, id);
    assert.ok(hit, `${id} not found`);
    assert.equal(hit.kind, kind);
    assert.equal(hit.raw.id, id);
  }
  assert.equal(api.rawById(DESIGN, "nope"), null);
  assert.equal(api.rawById(null, "p1"), null);
});

// ── a drawn region becomes a feature ──────────────────────────────────────
test("an area the owner drew becomes a patio through the same pipeline", () => {
  const poly = [[0, 0], [3.004, 0], [3, 2.996], [0, 3]];
  const op = api.areaOp("patio", "Fire Pit Terrace", poly);
  assert.deepEqual(op, {
    tool: "set_patio",
    input: { id: "patio_fire_pit_terrace", polygon: [[0, 0], [3, 0], [3, 3], [0, 3]] },
  });
  // material and mulch are NOT sent: execute() owns those defaults, and a second
  // copy of them here would drift from the first
  assert.ok(!("material" in op.input));
});

test("the same area makes a bed with its own id, and never a second copy", () => {
  const poly = [[0, 0], [3, 0], [3, 3], [0, 3]];
  const bed = api.areaOp("bed", "Fire Pit Terrace", poly);
  assert.equal(bed.tool, "upsert_bed");
  assert.equal(bed.input.id, "bed_fire_pit_terrace");
  assert.notEqual(bed.input.id, api.areaOp("patio", "Fire Pit Terrace", poly).input.id);
  // both ops replace by id, so pressing the button twice re-places the object
  // rather than stacking a second one on the same ground
  assert.deepEqual(api.areaOp("bed", "Fire Pit Terrace", poly), bed);
});

test("a region too thin to be a shape is refused", () => {
  assert.throws(() => api.areaOp("patio", "sliver", [[0, 0], [1, 1]]), /vertices|polygon/i);
  assert.throws(() => api.areaOp("lawn", "x", [[0, 0], [1, 0], [1, 1]]), /lawn/);
});

// ══ 2. GROUND TRUTH ═══════════════════════════════════════════════════════
test("an emitted plant carries only keys schema/design.schema.json allows", () => {
  const allowed = new Set(Object.keys(schema.properties.plants.items.properties));
  assert.ok(allowed.size >= 6, "the schema read back nearly empty — wrong path?");
  assert.equal(schema.properties.plants.items.additionalProperties, false,
    "the schema stopped being closed, so this test no longer proves anything");
  for (const e of api.paletteEntries(DESIGN, manifest, MIN_ASSET_HEIGHT_M)) {
    if (!e.placeable) continue;
    const pl = api.plantOp(e, 1, 1).input.plants[0];
    for (const k of Object.keys(pl)) {
      assert.ok(allowed.has(k),
        `"${k}" is not a plant property — the whole design would fail schema validation`);
    }
  }
});

test("an emitted plant carries every key place_plants requires", () => {
  // OPS_SCHEMA requires species, common, position, mature_spread_m and
  // mature_height_m; the design schema requires species and position. An op
  // short of any of them is rejected by execute() before the yard ever sees it.
  const need = ["species", "common", "position", "mature_spread_m", "mature_height_m"];
  const entries = api.paletteEntries(DESIGN, manifest, MIN_ASSET_HEIGHT_M).filter(e => e.placeable);
  assert.equal(entries.length, 2 + Object.keys(manifest).length,
    `${entries.length} placeable entries — expected the 2 sized species in the design `
    + `plus all ${Object.keys(manifest).length} library shapes`);
  for (const e of entries) {
    const pl = api.plantOp(e, 1, 1).input.plants[0];
    for (const k of need) assert.ok(k in pl, `${e.species} emitted no ${k}`);
    assert.equal(pl.position.length, 2);
  }
});

// ══ 3. THE ONE PIPELINE ═══════════════════════════════════════════════════
test("there is exactly one client for the op endpoint", () => {
  const hits = main.match(/fetch\(\s*["'`]\/api\/ops/g) ?? [];
  assert.equal(hits.length, 1,
    "the op endpoint is named more than once — a second client drifts from the "
    + "first on error handling");
  assert.ok(fnBody("postOps").includes("/api/ops"), "postOps is not the one client");
});

test("postOps reloads from the file on EVERY exit, in one place", () => {
  const body = fnBody("postOps");
  const reloads = body.match(/loadDesign\(\s*true\s*\)/g) ?? [];
  // one, in a finally: written per-branch instead, a count stays green when the
  // SUCCESS path's reload is deleted, because the 404 branch still has one
  assert.equal(reloads.length, 1,
    `${reloads.length} reloads in postOps — one branch can then lose its own`);
  assert.match(body, /finally\s*{[^}]*loadDesign\(\s*true\s*\)/,
    "the reload is not on the path every exit takes, so a rejected move leaves "
    + "the preview sitting where the owner dropped it and the file disagreeing");
});

test("no hand-edit path writes design.json behind the validators", () => {
  for (const name of ["placeHere", "moveSelection", "postOps"]) {
    const body = fnBody(name);
    assert.ok(!/writeJson\s*\(\s*["']data\/design\.json/.test(body),
      `${name} writes design.json directly — that is the parallel write path the one pipeline exists to prevent`);
  }
  assert.ok(fnBody("placeHere").includes("postOps("), "placeHere does not post an op");
  assert.ok(fnBody("moveSelection").includes("postOps("), "moveSelection does not post an op");
});

test("the click that places, and the drag that moves, both emit ops", () => {
  // placeOp dispatches between plants and OBJECTS in the picker: a plant still
  // has to reach plantOp through it, or hand-planting stops emitting an op
  assert.ok(fnBody("placeHere").includes("placeOp("), "placeHere does not build an op");
  assert.match(fnBody("placeOp"), /plantOp\(/,
    "placeOp no longer falls through to plantOp — placing a plant by hand is broken");
  assert.ok(fnBody("moveSelection").includes("moveOps("), "moveSelection does not build a move op");
  // the pick has to be converted out of the world frame before it is stored:
  // world coordinates stored as ENU are invisible until north is set
  assert.match(fnBody("placeHere"), /worldToEnu\(/,
    "placeHere stores a raycast hit without converting it to ENU — at a non-zero "
    + "yaw that plants metres from where the owner clicked");
});

// ══ 4. WIRING ═════════════════════════════════════════════════════════════
test("the panel has a place button and a palette to pick from", () => {
  assert.match(html, /id="btnPlace"[^>]*data-mode="place"|data-mode="place"[^>]*id="btnPlace"/,
    "#btnPlace is missing or is not a mode button (setMode lights it by data-mode)");
  assert.match(html, /<select[^>]*id="placeWhat"/, "#placeWhat select is missing");
  for (const id of ["btnPlace", "placeWhat"]) {
    assert.ok(main.includes(`"${id}"`), `${id} exists in the markup but nothing in main.js reads it`);
  }
});

test("place is a real mode, entered and left like the others", () => {
  assert.match(fnBody("setMode"), /"place"|'place'/,
    "setMode says nothing about place mode — the owner gets no hint and no way to tell they are in it");
  assert.match(codeOnly(main), /mode\s*===\s*"place"[\s\S]{0,80}placeHere\(/,
    "no pointer handler turns a click in place mode into a placement — the "
    + "mode is enterable and does nothing");
  assert.match(main, /btnPlace[\s\S]{0,120}setMode\(/,
    "#btnPlace does not toggle the mode");
});

test("the area list can turn a drawn region into a design object", () => {
  const body = fnBody("renderAreaList");
  assert.ok(body.includes("areaOp("), "renderAreaList offers no way to make an area a feature");
  assert.ok(body.includes("postOps("), "it does not go through the op pipeline");
  assert.ok(!/writeJson\s*\(\s*["']data\/design\.json/.test(body),
    "renderAreaList writes the design itself, behind the validators");
});

test("the palette is rebuilt when the design changes", () => {
  // a species the model just planted has to become pickable without a reload,
  // and a design switched underneath must not leave the old yard's palette up
  assert.match(fnBody("loadDesign"), /renderPalette\(/,
    "renderPalette is never called after a design loads");
  assert.ok(fnBody("renderPalette").includes("paletteEntries("),
    "renderPalette does not read the palette model");
});
