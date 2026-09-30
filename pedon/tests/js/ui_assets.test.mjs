// node --test tests/js/
//
// The user needs an asset window to see a plant's photo or model and pick it.
//
// A text dropdown is hard to scan at 24 rows; a 57-species shortlist can mean
// 71 rows of text in a box four lines tall. It cannot show plants for comparison
// or filter for native species, low water use and cat safety — the facts the
// user needs when choosing.
//
// The picking LOGIC is what is pinned here — which cards exist, what each says,
// what the filters mean. The thumbnails need a GPU and are checked by the one
// thing that can see them, which is the viewer itself.
import { UNIT_NAMES, UNIT_FNS } from "./lib/units_scope.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DESIGN_KINDS } from "../../viewer/src/design_doc.js";
import { dataPath } from "../../viewer/project_paths.js";   // the active site's files
import { catalogue } from "./lib/library.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");
const CATALOG = catalogue();

function block(start, end, min) {
  const a = main.indexOf(start), b = main.indexOf(end);
  assert.notEqual(a, -1, `${start} missing from main.js`);
  assert.notEqual(b, -1, `${end} missing from main.js`);
  assert.ok(b > a, `${start} / ${end} are in the wrong order`);
  const s = main.slice(a + start.length, b);
  assert.ok(s.length > min, `the block after ${start} is only ${s.length} chars`);
  // DESIGN_KINDS lives in design_doc.js: whole-document writes need the
  // same list to know what a replacement must CLEAR. The extracted source
  // uses it as a free variable, so hand it the REAL list rather than a copy —
  // a second copy can omit kinds such as steps and prevent their deletion.
  // Only when it is actually referenced, so this stays inert
  // for the blocks that do not use it.
  if (/\bDESIGN_KINDS\b/.test(s))
    return `const DESIGN_KINDS = ${JSON.stringify(DESIGN_KINDS)};\n${s}`;
  return s;
}
const api = new Function(...UNIT_NAMES,
  `${block("// ── HAND-EDIT-START ──", "// ── HAND-EDIT-END ──", 400)}
   ${block("// ── PALETTE-START ──", "// ── PALETTE-END ──", 200)}
   return { paletteEntries, assetFilter, assetFacts };`)(...UNIT_FNS);

const DESIGN = { plants: [{ id: "p1", species: "Muhlenbergia rigens", common: "deergrass",
                            mature_height_m: 1.3, mature_spread_m: 1.3, position: [0, 0] }] };
const all = () => api.paletteEntries(DESIGN, {}, 3, CATALOG);

test("the window offers the whole shortlist, not four lines of a dropdown", () => {
  const rows = all();
  assert.ok(rows.length >= CATALOG.length, `${rows.length} cards for ${CATALOG.length} species`);
});

test("a card states what the user chooses on", () => {
  const manzanita = all().find(e => e.species === "Arctostaphylos spp.");
  const facts = api.assetFacts(manzanita);
  const text = facts.join(" ").toLowerCase();
  for (const want of ["native", "water", "evergreen", "2.5"]) {
    assert.ok(text.includes(want), `"${want}" missing from ${JSON.stringify(facts)}`);
  }
});

test("searching finds a plant by the name a person actually types", () => {
  // nobody types Arctostaphylos
  const hits = api.assetFilter(all(), { q: "manzanita" });
  assert.ok(hits.some(e => e.species === "Arctostaphylos spp."),
    "searching the common name found nothing");
  assert.ok(api.assetFilter(all(), { q: "MUHLEN" }).length > 0, "search is case-sensitive");
  assert.equal(api.assetFilter(all(), { q: "zzzz" }).length, 0);
});

test("the filters are the three questions the user asks about a plant", () => {
  const rows = all();
  const native = api.assetFilter(rows, { native: true });
  assert.ok(native.length > 10 && native.every(e => e.ca_native !== false),
    "native filter is wrong or empty");
  const dry = api.assetFilter(rows, { water: "very_low" });
  assert.ok(dry.length > 5 && dry.every(e => e.water === "very_low"), "water filter");
  const byForm = api.assetFilter(rows, { form: "grass" });
  assert.ok(byForm.length >= 3, `only ${byForm.length} grasses`);
});

test("the cat filter excludes NOT ASSESSED, exactly like the model's one does", () => {
  // With 42 of 57 species unassessed, the distinction matters: unassessed is
  // not safe. The picker must not give the user a false assurance of cat safety.
  const safe = api.assetFilter(all(), { catSafe: true });
  // not vacuous: enough cat-safe cards that the filter has something to keep (5: the fixture library has 9)
  assert.ok(safe.length >= 5, `${safe.length} cat-safe cards`);
  assert.ok(safe.every(e => e.cat_safe === true),
    "a card with unassessed cat safety passed the cat-safe filter");
  assert.ok(!safe.some(e => String(e.species).includes("Lavandula")),
    "lavender is offered as cat-safe");
});

test("filters combine, because that is the actual question", () => {
  // Native, very low water and cat-safe filters must work together; form is also filterable.
  const hits = api.assetFilter(all(), { native: true, water: "very_low", catSafe: true });
  assert.ok(hits.length >= 1, "no plant satisfies the user's three constraints at once");
  for (const e of hits) {
    assert.equal(e.ca_native, true);
    assert.equal(e.water, "very_low");
    assert.equal(e.cat_safe, true);
  }
});

test("a plant that cannot be placed still appears, marked", () => {
  // silently dropping it is how a library limitation becomes invisible
  const rows = all().filter(e => e.placeable === false);
  assert.ok(rows.every(e => typeof e.label === "string" &&
    e.label.includes(e.cat_safe === false ? "excluded: toxic to cats" : "no mature size")),
    "an unplaceable card does not say why");
});

// ══ the window itself ═════════════════════════════════════════════════════
const code = main.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("there is a window, it opens, and it is not another floating surprise", () => {
  assert.match(html, /id="assetWindow"/, "no asset window in the markup");
  assert.match(html, /id="btnAssets"/, "nothing opens it");
  assert.match(code, /getElementById\("btnAssets"\)\.onclick/, "the button does nothing");
  // it is a modal like #settings, which index.html already owns and
  // ui_no_overlap.test.mjs can already reason about
  assert.match(html, /#assetWindow[^{]*\{[^}]*position:\s*fixed/,
    "the window is not positioned by a rule in index.html, so no test can check it");
});

test("the cards show the MODEL, not a coloured square", () => {
  assert.match(code, /thumbFor\(|plantThumb\(/,
    "nothing renders a thumbnail — the user needs to see the plant's photo or model");
  assert.match(code, /import\s*\{[^}]*plantThumb[^}]*\}\s*from\s*["']\.\/thumbs\.js["']/,
    "thumbnails are not coming from thumbs.js");
});

test("picking a card selects it for placing, so the window is not a catalogue", () => {
  // SLICED TO THE END OF THE FUNCTIONS IT MEANS, not to 2600 characters. Adding
  // a control can push `card.onclick` beyond a fixed window and falsely fail
  // the check even when the handler exists.
  const at = code.indexOf("function renderAssetWindow");
  assert.ok(at >= 0, "renderAssetWindow not found");
  const end = code.indexOf("\nfunction ", code.indexOf("function assetCard", at) + 10);
  const body = code.slice(at, end > at ? end : code.length);
  assert.ok(body.length > 100 && body.length < 9000,
    `the slice did not end where expected (${body.length} chars)`);
  // `card.onclick`, not any `onclick` — the "Add your photo" button has its own
  // handler, so bare /onclick/ can match even without the CARD's handler
  assert.match(body, /\bcard\.onclick\s*=/, "a card is not clickable");
  assert.match(body, /placeWhat|paletteKey/,
    "picking a card does not reach the thing that decides what gets planted");
});

test("the habit filter is filled from the ONE table of form headers", () => {
  assert.match(code, /for\s*\(const \[form, label\] of FORM_LABELS\)/,
    "the habit dropdown is hand-typed and will drift the first time a form is added");
  const opts = html.match(/<select id="assetForm">([\s\S]*?)<\/select>/);
  assert.ok(opts, "no habit select");
  assert.equal((opts[1].match(/<option/g) ?? []).length, 1,
    "the habit options are hardcoded in the markup as well as generated");
});

test("changing the growth stage does not leave last stage's pictures up", () => {
  assert.match(code, /forgetThumbs\(\)/,
    "thumbs are cached and never invalidated — importing the cache reset "
    + "without calling it leaves stale pictures");
  const body = code.slice(code.indexOf('getElementById("growthStage").onchange'),
                          code.indexOf('getElementById("growthStage").onchange') + 400);
  assert.match(body, /forgetThumbs/, "the cache survives a change of growth stage");
});

test("the shortlist is actually LOADED at boot, not merely loadable", () => {
  // Without a call to loadPlantCatalog, `plantCatalog` stays []: a design and
  // library with 26 options cannot offer the owner's 57 additional species.
  // The asset window needs the shortlist, and colourFromPalette needs the
  // palette to apply foliage and flower colours. Tests that pass a catalog
  // directly to paletteEntries cannot verify that it loads at boot.
  assert.match(code, /\bloadPlantCatalog\s*\(\s*\)/,
    "loadPlantCatalog is defined and never called — the shortlist never loads");
  const defAt = code.search(/async function loadPlantCatalog/);
  const callAt = code.search(/(?<!function )\bloadPlantCatalog\s*\(\s*\)\s*;/);
  assert.notEqual(callAt, -1, "no bare call site");
  assert.notEqual(callAt, defAt, "the only match is the definition itself");
});


test('grass cards distinguish foliage size from flowering height', () => {
  const deergrass = all().find(e => e.species === 'Muhlenbergia rigens');
  assert.ok(api.assetFacts(deergrass).some(f => f === 'flowering height 1.2–1.8 m'));
});
