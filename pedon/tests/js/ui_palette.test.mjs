// node --test tests/js/ui_palette.test.mjs
//
// The plant palette: browsable by FORM and SIZE, and able to swap the
// species on a plant that is already in the ground.
//
// The palette must be both human-pickable and model-addressable, with form
// routing in assets.js. Rows must be grouped by form so the user can find
// groundcovers, and must show mature SPREAD because it determines whether a
// plant fits. A flat list of 24 design and library rows hides these distinctions.
//
// Two things are tested here, and the second is the valuable one.
//
//   1. GROUPING. A row's group is the growth form, which for a species in this
//      design is the form plants.js's growthForm() will actually route it to —
//      so the header is a promise about what the viewer draws, not a label
//      invented for the picker. A LIBRARY row is a MODEL, and a model's habit is
//      the one gen_trees.py declared when it built it; guessing one off the
//      model's nickname is how "oak" ends up filed as a mounding shrub.
//      The null bucket is necessary because growthForm() on the 14
//      library nicknames returns `mound` for oak, pine, cypress and manzanita
//      alike, because "oak" is in none of plants.js's regexes and every model is
//      offered at exactly 4 m, where the size fallback says mound.
//   2. SUBSTITUTION. Swap the species on an existing plant without regenerating
//      the design. This is an OP, exactly like placing and dragging. set_plants
//      preserves the id and position; place_plants always assigns a fresh id,
//      which would drop group membership. Placing before removing also leaves
//      two plants on one spot for one op, and validate() compares every plant
//      against every other, so the replacement conflicts with the original.
//
// The interaction cannot be tested headlessly — no WebGL, no pointer, no scan —
// so what is tested is the layer that decides whether the constraint holds:
// given a selected plant and a chosen species, exactly which op gets posted.
//
// Counts and identities before deltas, everywhere: checking only gaps between
// stair levels passes vacuously for a single tread, which has no gaps. Every
// grouping assertion below states how many rows there are before it says
// anything about where they sit.
import { UNIT_NAMES, UNIT_FNS } from "./lib/units_scope.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DESIGN_KINDS } from "../../viewer/src/design_doc.js";
import path from "node:path";
import {
  MIN_ASSET_HEIGHT_M, PLANT_FORMS, FORM_ASSET, normalizeForm,
} from "../../viewer/src/assets.js";
import { growthForm } from "../../viewer/src/plants.js";
import { catalogue, plantManifest } from "./lib/library.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const html = readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");
const schema = JSON.parse(readFileSync(path.join(ROOT, "schema", "design.schema.json"), "utf8"));
const manifest = plantManifest();
const genTrees = readFileSync(path.join(ROOT, "tools", "gen_trees.py"), "utf8");
// The owner's own 52-species shortlist for this climate. Read from
// disk rather than mocked: the point of section 4 below is that THIS file
// browses correctly, and a fixture that shares its assumptions with the code
// proves nothing — a fixture using `ids` where the code writes `members` can
// pass while testing the wrong schema.
const CATALOG = catalogue();

// ── extraction ────────────────────────────────────────────────────────────
// main.js cannot be imported (it builds a WebGLRenderer at module scope), so the
// pure parts are sliced out between markers and evaluated — the trick
// ui_place.test.mjs and ui_bearing.test.mjs already use. Both markers of both
// blocks are asserted found and in order, and the slice asserted non-trivial:
// indexOf can return -1, and slice(-1) is the file's LAST CHARACTER, so a regex
// guard against forbidden code can pass without inspecting the intended block.
function block(start, end, min) {
  const a = main.indexOf(start);
  const b = main.indexOf(end);
  assert.notEqual(a, -1, `${start} missing from main.js — nothing was extracted`);
  assert.notEqual(b, -1, `${end} missing from main.js — nothing was extracted`);
  assert.ok(b > a, `${start} / ${end} are in the wrong order`);
  const s = main.slice(a + start.length, b);
  assert.ok(s.length > min, `the block after ${start} is only ${s.length} chars`);
  // DESIGN_KINDS lives in design_doc.js; whole-document writes use the same list
  // to know what a replacement must CLEAR. The extracted source uses it as a
  // free variable, so hand it the REAL list rather than a copy: a second copy
  // can omit kinds such as steps and make them undeletable. Inject it only when
  // referenced, so this stays inert for blocks that do not use it.
  if (/\bDESIGN_KINDS\b/.test(s))
    return `const DESIGN_KINDS = ${JSON.stringify(DESIGN_KINDS)};\n${s}`;
  return s;
}

// The two blocks are evaluated in ONE scope because substituteOps builds its
// placement through plantOp — the same emitter a click on the ground uses, so
// there is one definition of "what a plant op looks like" and not two.
const EXPORTED = ["paletteEntries", "plantOp", "rawById", "substituteOps",
                  "paletteGroups", "FORM_LABELS", "plantFacts", "assetFacts"];
const api = new Function(...UNIT_NAMES,
  `${block("// ── HAND-EDIT-START ──", "// ── HAND-EDIT-END ──", 400)}
   ${block("// ── PALETTE-START ──", "// ── PALETTE-END ──", 200)}
   return { ${EXPORTED.join(", ")} };`)(...UNIT_FNS);

/** End index (exclusive) of the {...} block opening at or after `from`. */
function blockEnd(s, from) {
  const open = s.indexOf("{", from);
  assert.notEqual(open, -1, "no block found");
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") { depth--; if (!depth) return i + 1; }
  }
  assert.fail("unbalanced braces while slicing main.js");
}

// Check executable wiring: a comment describing an Escape handler can remain
// after the handler is deleted and falsely satisfy a source check.
const codeOnly = s => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** The source of a named function (or top-level arrow) in main.js, asserted non-trivial. */
function fnBody(anchor) {
  const at = main.search(new RegExp(`(async\\s+)?function\\s+${anchor}\\s*\\(`));
  const i = at !== -1 ? at : main.indexOf(anchor);
  assert.notEqual(i, -1, `${anchor} not found in main.js — this test is slicing nothing`);
  const body = codeOnly(main.slice(i, blockEnd(main, i)));
  assert.ok(body.length > 60, `${anchor} is only ${body.length} chars — nothing was extracted`);
  return body;
}

// ── the fixture ───────────────────────────────────────────────────────────
// Real species off this property, so the forms below are the classification the
// renderer really makes rather than one invented to suit the test. p6 has no
// mature size — the design schema requires only id/species/position, so that is
// legal on disk and is NOT legal in a place_plants op.
const DESIGN = {
  plants: [
    { id: "p1", species: "Muhlenbergia rigens", common: "deergrass", position: [1, 2], mature_spread_m: 1.3, mature_height_m: 1.3 },
    { id: "p2", species: "Muhlenbergia rigens", common: "deergrass", position: [3, 2], mature_spread_m: 1.3, mature_height_m: 1.3 },
    { id: "p3", species: "Heteromeles arbutifolia", common: "toyon", position: [5.5, -2.25], mature_spread_m: 3, mature_height_m: 3.5 },
    { id: "p4", species: "Arctostaphylos 'Emerald Carpet'", common: "emerald carpet", position: [7, 2], mature_spread_m: 1.5, mature_height_m: 0.4 },
    { id: "p5", species: "Quercus agrifolia", common: "coast live oak", position: [9, 2], mature_spread_m: 8, mature_height_m: 9 },
    { id: "p6", species: "Nameless sp.", common: "nameless", position: [11, 2] },
  ],
  beds: [{ id: "b1", polygon: [[0, 0], [2, 0], [2, 2], [0, 2]], mulch: "shredded_hardwood" }],
};

const ROUTERS = { growthForm, normalizeForm };
const entries = (man = manifest) => api.paletteEntries(DESIGN, man, MIN_ASSET_HEIGHT_M);
const entryFor = species => {
  const e = entries().find(x => x.species === species);
  assert.ok(e, `no palette entry for ${species}`);
  return e;
};
const groups = (man = manifest) => api.paletteGroups(entries(man), ROUTERS);
const groupOf = (gs, species) => gs.find(g => g.rows.some(r => r.species === species));

// ══ 0. the fixture and the vocabulary, before anything is asserted with them ══
test("every extracted name came out of main.js", () => {
  for (const n of ["paletteEntries", "plantOp", "rawById", "substituteOps", "paletteGroups"]) {
    assert.equal(typeof api[n], "function", `${n} is not a function`);
  }
  assert.ok(Array.isArray(api.FORM_LABELS), "FORM_LABELS is not an ordered list");
});

test("the fixture really is six plants and five distinct species", () => {
  assert.equal(DESIGN.plants.length, 6);
  assert.equal(new Set(DESIGN.plants.map(p => p.species)).size, 5);
  const p = entries();
  assert.equal(p.filter(e => e.source === "design").length, 5);
  assert.equal(p.filter(e => e.source === "library").length, Object.keys(manifest).length);
});

// ══ 1. THE GROUPS ═════════════════════════════════════════════════════════
test("every form in the vocabulary has a label, and no label invents a form", () => {
  // PLANT_FORMS is the vocabulary's one home (assets.js). A form with no label
  // here would put its plants in a bucket the owner never sees; a label naming a
  // form that does not exist is a header that can never fill.
  const named = api.FORM_LABELS.map(([f]) => f);
  assert.equal(named.length, new Set(named).size, "a form is labelled twice");
  const forms = named.filter(f => f !== null);
  assert.deepEqual([...forms].sort(), [...PLANT_FORMS].sort(),
    "FORM_LABELS and assets.PLANT_FORMS disagree about what forms exist");
  assert.ok(named.includes(null),
    "there is no bucket for a library model whose habit was never recorded — "
    + "those rows would be filed under a form nobody measured");
  for (const [, label] of api.FORM_LABELS) {
    assert.equal(typeof label, "string");
    assert.ok(label.length > 2, `"${label}" is not a header a person can read`);
  }
  // readable labels for the five forms that matter on this property
  const byForm = Object.fromEntries(api.FORM_LABELS);
  assert.match(byForm.grass, /grass/i);
  assert.match(byForm.mat, /groundcover|spreading/i);
  assert.match(byForm.mound, /shrub|mound/i);
  assert.match(byForm.tree, /tree/i);
  assert.match(byForm.column, /column|upright/i);
});

test("every entry lands in exactly one group, and nothing is dropped", () => {
  // count before content: a grouping that silently drops the rows it cannot
  // classify still produces a tidy-looking list of headers
  const all = entries();
  const gs = groups();
  assert.ok(gs.length >= 4, `${gs.length} groups — the palette collapsed into one bucket`);
  const seen = gs.flatMap(g => g.rows);
  assert.equal(seen.length, all.length, "rows were lost or duplicated by the grouping");
  assert.equal(new Set(seen).size, all.length, "an entry appears in two groups");
  for (const g of gs) assert.ok(g.rows.length > 0, `"${g.label}" is an empty header`);
});

test("the groups come out in the palette's own order, small to large", () => {
  const want = api.FORM_LABELS.map(([f]) => f);
  const got = groups().map(g => g.form);
  assert.ok(got.length >= 4);
  assert.deepEqual(got, want.filter(f => got.includes(f)),
    "groups are not in FORM_LABELS order — the browse order is whatever the design happened to be in");
});

test("a species in this design is filed under the form the RENDERER gives it", () => {
  const gs = groups();
  // concrete first — these are the four forms that matter on this property, and
  // they are stated as literals so a change in plants.js has to be looked at
  assert.equal(groupOf(gs, "Muhlenbergia rigens").form, "grass");
  assert.equal(groupOf(gs, "Arctostaphylos 'Emerald Carpet'").form, "mat");
  assert.equal(groupOf(gs, "Heteromeles arbutifolia").form, "mound");
  assert.equal(groupOf(gs, "Quercus agrifolia").form, "tree");
  // then the property: the header is a promise about what the viewer will draw,
  // so it has to be plants.js's own answer for every design row and not a second
  // classification living in the picker
  const design = entries().filter(e => e.source === "design");
  assert.equal(design.length, 5);
  for (const e of design) {
    assert.equal(groupOf(gs, e.species).form, growthForm(e),
      `${e.species} is offered as one form and drawn as another`);
  }
});

test("a library MODEL is filed under the habit the library recorded, not a guess", () => {
  // assets.FORM_ASSET is the router's own habit -> model map, so inverting it
  // gives three (model, habit) pairs that are ground truth rather than three
  // pairs invented next to the thing they test.
  const declared = Object.entries(FORM_ASSET).map(([form, model]) => [model, form]);
  assert.equal(declared.length, 3, `FORM_ASSET declares ${declared.length} habits, expected 3`);
  const withForm = structuredClone(manifest);
  for (const [model, form] of declared) {
    assert.ok(withForm[model], `${model} is not in the manifest`);
    withForm[model].form = form;
  }
  const gs = groups(withForm);
  for (const [model, form] of declared) {
    const g = gs.find(x => x.rows.some(r => r.asset === model));
    assert.ok(g, `${model} vanished from the palette`);
    assert.equal(g.form, form,
      `the library says ${model} is a ${form} and the palette filed it under ${g.form}`);
  }
  // The model's own habit beats its nickname. The SHIPPED manifest declares
  // `form` through gen_trees.py, so verify that declaration on the real model.
  const nickname = entries().find(e => e.asset === "oak" && e.source === "library");
  assert.equal(nickname.form, "tree",
    "the shipped manifest no longer declares oak's habit — rebuild the library");
  assert.equal(gs.find(g => g.rows.some(r => r.asset === "oak")).form, "tree");
  // and the declared habit is LOAD-BEARING: strip it and the nickname router
  // guesses "mound" for a canopy tree, because no regex in plants.js names "oak"
  // and every tree model is offered at 4 m, where the size fallback says mound.
  const { form: _stripped, ...guessed } = nickname;
  assert.equal(growthForm(guessed), "mound",
    "the nickname router changed its mind — this test's premise needs re-measuring");
});

test("a model whose habit was never recorded says so instead of guessing one", () => {
  // Every shipped model declares its habit. A SYNTHETIC case covers legacy or
  // hand-written manifests with no `form`: such models must not be filed as
  // mounding shrubs on the strength of a size fallback.
  const bare = structuredClone(manifest);
  for (const m of Object.values(bare)) delete m.form;
  const gs = api.paletteGroups(api.paletteEntries(DESIGN, bare, MIN_ASSET_HEIGHT_M), ROUTERS);
  const unknown = gs.find(g => g.form === null);
  assert.ok(unknown, "no bucket for the models whose habit is unknown");
  assert.equal(unknown.rows.length, Object.keys(bare).length,
    "some library models were filed under a form the library never declared");
  assert.ok(unknown.rows.every(r => r.source === "library"),
    "a species from the design ended up in the unknown bucket — growthForm always answers");
});

test("`form` is a real manifest key, not one this test invented", () => {
  // The fixture above adds `form` to a manifest; a fixture that shares an
  // assumption with the code proves nothing: it can pass despite a schema
  // mismatch such as `ids` versus `members`. tools/gen_trees.py is the builder,
  // so it is the ground truth for what a manifest entry holds.
  assert.match(genTrees, /form=spec\["form"\]/,
    "gen_trees.py no longer carries `form` into the manifest it writes");
  const declared = [...genTrees.matchAll(/^\s*form="([a-z]+)",/gm)].map(m => m[1]);
  assert.ok(declared.length >= 10,
    `only ${declared.length} presets declare a form — the parse is finding nothing`);
  for (const f of declared) {
    assert.ok(PLANT_FORMS.includes(f), `gen_trees.py declares form "${f}", not in PLANT_FORMS`);
  }
});

test("inside a group the rows run small to large", () => {
  const gs = groups();
  const mound = gs.find(g => g.form === "mound");
  assert.ok(mound, "no mounding-shrub group");
  assert.ok(mound.rows.length >= 2, `${mound.rows.length} rows — nothing to order`);
  for (const g of gs) {
    const h = g.rows.map(r => r.mature_height_m ?? 0);
    for (let i = 1; i < h.length; i++) {
      assert.ok(h[i] >= h[i - 1],
        `"${g.label}" is out of size order: ${h.join(", ")}`);
    }
  }
});

test("a row states the mature size, because that is what decides whether it fits", () => {
  // height AND spread. Spread decides whether a plant fits the bed it is going
  // into — it is also what validate() checks spacing at.
  assert.equal(entryFor("Muhlenbergia rigens").label,
    "deergrass · Muhlenbergia rigens · 1.3 × 1.3 m · 2 planted");
  assert.equal(entryFor("Quercus agrifolia").label,
    "coast live oak · Quercus agrifolia · 9 × 8 m · 1 planted");
  // a library row says it is a shape rather than a species, and is offered at
  // the size the library really draws it (read off the manifest, not typed here)
  const oak = entries().find(e => e.asset === "oak" && e.source === "library");
  assert.ok(oak, "no oak in the library palette");
  // "generic shape" says what the user gets — a shape for that habit rather
  // than that species, not merely where the model comes from
  assert.equal(oak.label, `oak · generic shape · 4 × ${manifest.oak.spread_m} m`);
  // and one that cannot be placed says why, instead of showing a size it made up
  assert.equal(entryFor("Nameless sp.").label, "nameless · Nameless sp. · no mature size · 1 planted");
});

// ══ 2. SUBSTITUTION ═══════════════════════════════════════════════════════
test("a selected plant and a chosen species emit exactly the swap, on the same id", () => {
  const ops = api.substituteOps(DESIGN.plants[2], entryFor("Muhlenbergia rigens"));
  // one set_plants on p3 preserves group membership. remove_objects +
  // place_plants would mint a fresh id and drop the plant from its group.
  assert.deepEqual(ops, [
    { tool: "set_plants", input: { plants: [{
      species: "Muhlenbergia rigens",
      common: "deergrass",
      position: [5.5, -2.25],
      mature_spread_m: 1.3,
      mature_height_m: 1.3,
      id: "p3",
    }] } },
  ]);
});

test("a substitution keeps the position and takes the NEW species' size", () => {
  // this is the whole difference from a move. The size has to be the new
  // species': spacing is checked at mature spread, so carrying the old plant's
  // 1.3 m over to a 9 m oak would put a canopy tree through the validator as a
  // grass clump.
  const pl = api.substituteOps(DESIGN.plants[0], entryFor("Quercus agrifolia"))[0].input.plants[0];
  assert.equal(pl.id, DESIGN.plants[0].id);
  assert.deepEqual(pl.position, DESIGN.plants[0].position);
  assert.equal(pl.mature_spread_m, 8);
  assert.equal(pl.mature_height_m, 9);
  assert.equal(pl.species, "Quercus agrifolia");
});

test("choosing a library shape substitutes the model the owner pointed at", () => {
  const oak = entries().find(e => e.asset === "oak" && e.source === "library");
  const ops = api.substituteOps(DESIGN.plants[0], oak);
  assert.equal(ops.length, 1);
  // assets.assetName() honours `asset` ahead of every species regex, so the
  // explicit asset preserves the user's model choice through the router
  assert.equal(ops[0].input.plants[0].asset, "oak");
});

test("substituting a plant for what it already is emits nothing at all", () => {
  // the same discipline as a sub-centimetre drag: no op, so no fresh id, no
  // timeline entry and no validator round trip for a change that is not one
  assert.deepEqual(api.substituteOps(DESIGN.plants[0], entryFor("Muhlenbergia rigens")), []);
  assert.deepEqual(api.substituteOps(DESIGN.plants[4], entryFor("Quercus agrifolia")), []);
  // but a library shape of the same size is a different plant — it carries an
  // asset the design row does not
  assert.equal(api.substituteOps(
    DESIGN.plants[4], entries().find(e => e.asset === "oak" && e.source === "library")).length, 1);
});

test("a species with no mature size cannot be substituted in", () => {
  const nameless = entryFor("Nameless sp.");
  assert.equal(nameless.placeable, false);
  assert.throws(() => api.substituteOps(DESIGN.plants[0], nameless), /mature size/i);
});

test("only a plant has a species to swap", () => {
  assert.throws(() => api.substituteOps(DESIGN.beds[0], entryFor("Muhlenbergia rigens")),
    /plant|position/i);
  assert.throws(() => api.substituteOps(null, entryFor("Muhlenbergia rigens")), /substitute|nothing/i);
  assert.throws(() => api.substituteOps(DESIGN.plants[0], null), /pick|place/i);
});

test("a substituted plant carries only keys the design schema allows", () => {
  // a palette entry also carries display fields (label, count, source) and the
  // schema is additionalProperties:false, so one spread {...entry} into the op
  // would fail the WHOLE design's schema check server-side — every hand edit
  // rejected, with a message about a key the owner never saw
  const allowed = new Set(Object.keys(schema.properties.plants.items.properties));
  assert.ok(allowed.size >= 6, "the schema read back nearly empty — wrong path?");
  assert.equal(schema.properties.plants.items.additionalProperties, false,
    "the schema stopped being closed, so this test no longer proves anything");
  let checked = 0;
  for (const e of entries().filter(x => x.placeable)) {
    const ops = api.substituteOps(DESIGN.plants[2], e);
    if (!ops.length) continue;
    for (const k of Object.keys(ops[0].input.plants[0])) {
      assert.ok(allowed.has(k), `"${k}" is not a plant property — the design would fail validation`);
    }
    checked++;
  }
  assert.ok(checked >= 5, `only ${checked} substitutions checked`);
});

// ══ 3. WIRING ═════════════════════════════════════════════════════════════
// An op emitter must be wired into the UI for the user to reach it.
test("the palette the owner sees is grouped by form", () => {
  const body = fnBody("renderPalette");
  assert.ok(body.includes("paletteGroups("),
    "renderPalette does not group — the grouping is dead code and the dropdown is still one flat list");
  assert.ok(body.includes("optgroup"), "the groups are not rendered as headers");
  assert.match(body, /growthForm/,
    "renderPalette does not hand the renderer's own classifier to the grouping");
  assert.match(codeOnly(main), /import\s*\{[^}]*growthForm[^}]*\}\s*from\s*"\.\/plants\.js"/,
    "growthForm is not imported from plants.js — a second classifier in the viewer is "
    + "liable to disagree with the renderer");
  assert.match(codeOnly(main), /import\s*\{[^}]*normalizeForm[^}]*\}\s*from\s*"\.\/assets\.js"/,
    "normalizeForm is not imported from assets.js");
});

test("the substitute button is on the working panel, beside the selection", () => {
  assert.match(html, /<button[^>]*id="btnSubstitute"/, "#btnSubstitute is missing from the page");
  const at = html.indexOf('id="btnSubstitute"');
  const bar = html.indexOf('id="selActions"');
  assert.notEqual(bar, -1, "#selActions is gone");
  assert.ok(at > bar && at < html.indexOf("</div>", bar) + 400,
    "the substitute button is not in the selection actions row, where the selection is");
  assert.doesNotMatch(html.slice(at - 80, at + 200), /data-mode/,
    "substitute is an action, not a mode — a data-mode here breaks setMode's inventory");
  assert.match(main, /getElementById\("btnSubstitute"\)\s*\.\s*(onclick|addEventListener)/,
    "#btnSubstitute has no handler in main.js");
});

test("substitute goes down the one op pipeline, like every other hand edit", () => {
  const body = fnBody("substituteSelection");
  assert.ok(body.includes("substituteOps("), "it does not build the swap op");
  assert.ok(body.includes("postOps("), "it does not post through /api/ops");
  assert.ok(!/writeJson\s*\(\s*["']data\/design\.json/.test(body),
    "substituteSelection writes design.json directly — bypassing the validated op pipeline");
  // still exactly one client for the endpoint
  assert.equal((main.match(/fetch\(\s*["'`]\/api\/ops/g) ?? []).length, 1,
    "the op endpoint is named more than once — duplicate clients can drift");
  // the ids SURVIVE a swap (set_plants), so clearing the selection would
  // throw away the user's selection of the plants they just changed
  assert.doesNotMatch(body, /setSelection\(\s*\[\s*\]\s*\)/,
    "the selection is cleared after a swap, but the swapped plants kept their ids");
});

test("place and substitute read ONE picked entry, not two copies of the lookup", () => {
  const hits = [...codeOnly(main).matchAll(/getElementById\("placeWhat"\)\s*\.\s*value/g)];
  assert.equal(hits.length, 1,
    `the palette selection is read from the DOM in ${hits.length} places — one of them will `
    + "drift from the others");
  assert.ok(fnBody("placeHere").includes("pickedEntry("), "placeHere does not use the shared lookup");
  assert.ok(fnBody("substituteSelection").includes("pickedEntry("),
    "substituteSelection does not use the shared lookup");
});

test("the button is only live when the selection holds a plant", () => {
  // a bed has no species, so offering the swap for one is an action that can
  // only ever log a refusal
  assert.match(fnBody("renderSelection"), /btnSubstitute/,
    "nothing enables or disables the substitute button as the selection changes");
});

// ══ 4. THE OWNER'S OWN 52 ═════════════════════════════════════════════════
// The owner's 52-species shortlist (data/plant_palette.json) must be reachable
// through the picker as well as through the design agent's list_assets. The
// picker must include the full shortlist alongside planted species and models.
//
// The user chooses on native / water / evergreen, so those facts have to
// be ON THE ROW. A picker that makes you open a JSON file to find out whether a
// plant is native is a picker you do not use.
// Cats have the run of this site — a site's policy, from its project.json
const CATS = { cats_have_access: true };
const withCat = (man = manifest, policy = CATS) =>
  api.paletteEntries(DESIGN, man, MIN_ASSET_HEIGHT_M, CATALOG, {}, policy);
const shortlist = () => withCat().filter(e => e.source === "shortlist");
const catEntry = species => {
  const e = withCat().find(x => x.species === species);
  assert.ok(e, `no palette entry for ${species}`);
  return e;
};

test("the shortlist on disk really carries the fields a person chooses on", () => {
  // premise before assertion: every test below is about THIS file, so if the
  // file changes shape they should say so instead of quietly testing nothing
  assert.ok(CATALOG.length >= 40, `only ${CATALOG.length} species in the shortlist`);
  for (const p of CATALOG) {
    for (const k of ["species", "common", "form", "mature_height_m", "mature_spread_m",
                     "water", "sun", "evergreen", "ca_native"]) {
      assert.ok(p[k] !== undefined, `${p.species} has no ${k}`);
    }
    assert.ok(PLANT_FORMS.includes(p.form), `${p.species} declares form "${p.form}"`);
  }
});

test("the whole shortlist reaches the picker, deduped against what is planted", () => {
  const planted = new Set(DESIGN.plants.map(p => p.species.toLowerCase()));
  const overlap = CATALOG.filter(p => planted.has(p.species.toLowerCase()));
  assert.equal(overlap.length, 2,
    "premise: two of the fixture's five species are in the owner's file — re-measure");
  const all = withCat();
  assert.equal(shortlist().length, CATALOG.length - overlap.length,
    "the shortlist is not offered in full, or an already-planted species is offered twice");
  assert.equal(all.length, 5 + (CATALOG.length - overlap.length) + Object.keys(manifest).length,
    "rows were lost or duplicated when the shortlist was merged in");
  const species = all.filter(e => e.source !== "library").map(e => e.species.toLowerCase());
  assert.equal(new Set(species).size, species.length, "a species is offered on two rows");
  // and the library shapes are untouched: they are shapes, not species
  assert.equal(all.filter(e => e.source === "library").length, Object.keys(manifest).length);
});

test("a planted species keeps THIS yard's measured size and gains the facts", () => {
  // the design's own numbers are facts about this garden; the file's are facts
  // about the species. Neither is a default for the other, so the shortlist
  // FILLS gaps and never overwrites — measured: the file calls Heteromeles 4.5 m
  // and this design's is 3.5 m, and overwriting it would move the row from
  // `mounding shrub` to `canopy tree`, which the grouping test above pins.
  const deer = catEntry("Muhlenbergia rigens");
  assert.equal(deer.source, "design");
  assert.equal(deer.mature_height_m, 1.3, "the file's 1.2 m overwrote this design's 1.3 m");
  assert.equal(deer.common, "deergrass", "the file's common name overwrote the design's");
  assert.equal(deer.count, 2);
  assert.equal(deer.ca_native, true, "the planted row never got the facts — only new rows did");
  assert.equal(deer.label,
    "deergrass · Muhlenbergia rigens · 1.3 × 1.3 m · CA native · low water · evergreen · 2 planted");
  const toyon = catEntry("Heteromeles arbutifolia");
  assert.equal(toyon.mature_height_m, 3.5, "the file's 4.5 m overwrote this design's 3.5 m");
  assert.equal(api.paletteGroups(withCat(), ROUTERS).find(
    g => g.rows.some(r => r.species === "Heteromeles arbutifolia")).form, "mound",
    "the toyon moved shelves — the shortlist overwrote a measured size");
});

test("every shortlist row is filed under the form the RENDERER will draw it as", () => {
  // the header is a promise about what the viewer draws. Measured across all 52:
  // growthForm() and the file's declared `form` agree on every row, and if
  // one ever stops agreeing the picker must follow the renderer, not the file.
  const gs = api.paletteGroups(withCat(), ROUTERS);
  let n = 0;
  for (const e of shortlist()) {
    const g = gs.find(x => x.rows.some(r => r.species === e.species));
    assert.ok(g, `${e.species} vanished from the palette`);
    assert.equal(g.form, growthForm(e), `${e.species} is offered as ${g.form} and drawn as ${growthForm(e)}`);
    n++;
  }
  assert.ok(n >= 40, `only ${n} shortlist rows checked`);
  // and every form the file uses has a header the owner can read
  for (const f of new Set(CATALOG.map(p => p.form))) {
    assert.ok(api.FORM_LABELS.some(([k]) => k === f), `form "${f}" has no header`);
  }
  assert.ok(gs.length >= 7, `${gs.length} groups for 52 species — the browse collapsed`);
});

test("a row states native, water and evergreen — what the user chooses on", () => {
  assert.equal(catEntry("Arctostaphylos spp.").label,
    "Manzanita · Arctostaphylos spp. · 2.5 × 2.5 m · CA native · very low water · evergreen");
  assert.equal(catEntry("Achillea millefolium").label,
    "Yarrow · Achillea millefolium · excluded: toxic to cats · CA native · low water · deciduous");
  // a garden plant that is not native must not claim to be, and must still say
  // what it drinks — that is the whole reason the field is on the row
  const exotic = shortlist().filter(e => e.ca_native === false);
  assert.ok(exotic.length >= 5, `only ${exotic.length} non-native rows — re-measure`);
  for (const e of exotic) {
    assert.doesNotMatch(e.label, /native/i, `${e.species} claims to be native`);
    assert.match(e.label, /water/, `${e.species} does not say what it drinks`);
  }
  // no raw JSON value leaks into a row a person reads: "very_low" is a key
  for (const e of shortlist()) assert.doesNotMatch(e.label, /_/, `${e.species}: ${e.label}`);
});

test("every water level in the file has English on the row", () => {
  for (const w of new Set(CATALOG.map(p => p.water))) {
    const f = api.plantFacts({ water: w });
    assert.ok(f.some(s => /water|thirst/.test(s)), `"${w}" has no wording in the picker`);
    assert.doesNotMatch(f.join(" "), /_/, `"${w}" reaches the row as a JSON key`);
  }
  // the facts are only ever stated when they are known: a design row with no
  // shortlist entry must not sprout "deciduous" out of an absent field
  assert.deepEqual(api.plantFacts({}), []);
});

test("every shortlist row can actually be placed, and carries only legal keys", () => {
  const allowed = new Set(Object.keys(schema.properties.plants.items.properties));
  let checked = 0;
  for (const e of shortlist()) {
    if (e.cat_safe === false) {
      assert.equal(e.placeable, false, `${e.species} is toxic and must not be offered for planting`);
      continue;
    }
    assert.equal(e.placeable, true, `${e.species} is offered but cannot be placed`);
    const ops = api.substituteOps(DESIGN.plants[2], e);
    if (!ops.length) continue;
    for (const k of Object.keys(ops[0].input.plants[0])) {
      assert.ok(allowed.has(k),
        `"${k}" is not a plant property — every hand edit would fail the schema check`);
    }
    checked++;
  }
  assert.ok(checked >= 40, `only ${checked} shortlist substitutions checked`);
});

test("the picker is built from the owner's file, read in exactly one place", () => {
  const code = codeOnly(main);
  assert.match(code, /["'`]\/data\/plant_palette\.json["'`]/,
    "main.js never loads data/plant_palette.json — the 52 species are unreachable by hand");
  assert.equal((code.match(/plant_palette\.json/g) ?? []).length, 1,
    "the shortlist file is named more than once — duplicate loaders can drift");
  const body = fnBody("renderPalette");
  assert.match(body, /paletteEntries\([^)]*MIN_ASSET_HEIGHT_M\s*,\s*\w+/,
    "renderPalette does not hand the shortlist to paletteEntries — it is loaded and never offered");
  // the fields that do not fit on a row still have to be reachable, and a
  // <select> has exactly one place for them
  for (const k of ["sun", "bloom", "note"]) {
    assert.ok(body.includes(`.${k}`),
      `the option tooltip drops ${k} — the row is all the owner ever sees of the file`);
  }
});

test("a site that says nothing about cats plants lavender, and still says it is toxic to them", () => {
  const e = withCat(manifest, {}).find(x => x.species === "Lavandula angustifolia");
  assert.ok(e && e.cat_safe === false, "the premise: the catalogue knows lavender is toxic to cats");
  assert.equal(e.excluded, false);
  assert.equal(e.placeable, true);
  assert.ok(api.assetFacts(e).includes("cat toxicity flagged"), api.assetFacts(e).join(" · "));
  assert.doesNotThrow(() => api.plantOp(e, 1, 2));
});

test('known toxic catalog entries cannot be emitted as planting operations', () => {
  for (const sp of ['Origanum majorana', 'Achillea millefolium', 'Lavandula angustifolia', 'Lupinus spp.']) {
    const entry = catEntry(sp);
    assert.equal(entry.placeable, false);
    assert.throws(() => api.plantOp(entry, 1, 2), /toxic to cats/);
  }
  const thyme = catEntry('Thymus vulgaris');
  assert.equal(api.plantOp(thyme, 1, 2).input.plants[0].flower, thyme.flower);
});
