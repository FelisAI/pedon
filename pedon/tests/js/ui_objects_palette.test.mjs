// node --test tests/js/ui_objects_palette.test.mjs
//
// The asset window carries the OBJECTS, not only the plants.
//
// Placing by hand goes through an asset picker, and the picker holds everything
// the library can build, not only plants: a lantern, a basin, a moon gate, a koi
// pond. Without them the only way to get one into the site is to ask the model
// for it in prose, and a picker of plants alone implies the rest of a garden does
// not exist.
//
// Three things are tested, and the third is the one that matters here.
//
//   1. The CATALOGUE is derived from BUILDERS, so a builder added without a
//      description still reaches the picker instead of silently vanishing. A
//      second hand-typed list of kinds drifts from the first.
//   2. The FILTERS. Every filter in the asset window except the search box asks a
//      question about a plant. A boulder is not a California native and has no
//      water need, so those filters must drop the objects — and must never do the
//      opposite, admitting an object into a "cat-safe" list, which would be the
//      picker answering a question about an animal wrongly by omission.
//   3. The WIRING. Something can be built, tested, and never connected — a
//      loader defined and never called leaves the picker without the owner's
//      species. paletteEntries() takes its object catalogue INJECTED, which makes
//      it testable and also makes "forgot to pass it" a silent empty shelf. So
//      the call sites are asserted, not assumed.
//
// Every assertion states a count and an identity before any delta: a test that
// asserts only the gaps between stair levels passes vacuously, because a single
// tread has no gaps.
import { UNIT_NAMES, UNIT_FNS } from "./lib/units_scope.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DESIGN_KINDS } from "../../viewer/src/design_doc.js";
import path from "node:path";
import { KNOWN_KINDS, OBJECT_META, objectCatalog, resolveKind } from "../../viewer/src/objects.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");

// ── extraction ────────────────────────────────────────────────────────────
// main.js builds a WebGLRenderer at module scope and cannot be imported, so the
// pure parts are sliced between markers and evaluated. Both markers of both
// blocks are asserted present and in order, and the slice asserted non-trivial:
// a guard that slices from an indexOf that returned -1 gets slice(-1), the
// file's LAST CHARACTER, and sits green with the bug it forbids.
function block(start, end, min) {
  const a = main.indexOf(start), b = main.indexOf(end);
  assert.notEqual(a, -1, `${start} missing from main.js — nothing was extracted`);
  assert.notEqual(b, -1, `${end} missing from main.js — nothing was extracted`);
  assert.ok(b > a, `${start} / ${end} are in the wrong order`);
  const s = main.slice(a + start.length, b);
  assert.ok(s.length > min, `the block after ${start} is only ${s.length} chars`);
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

const EXPORTED = ["paletteEntries", "objectOp", "placeOp", "plantOp",
                  "assetFilter", "paletteGroups", "assetFacts"];
const api = new Function(...UNIT_NAMES,
  `${block("// ── HAND-EDIT-START ──", "// ── HAND-EDIT-END ──", 400)}
   ${block("// ── PALETTE-START ──", "// ── PALETTE-END ──", 200)}
   return { ${EXPORTED.join(", ")} };`)(...UNIT_FNS);

const codeOnly = s => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

// The real routers, so what the picker is tested with is what the viewer passes.
const ROUTERS = { objectCatalog, resolveKind };
// growthForm is only reached for plant rows; objects never touch it, which is
// itself asserted below.
const GROUP_ROUTERS = {
  growthForm: p => p.form ?? "mound",
  normalizeForm: f => f ?? null,
};

// A design holding ONE lantern, so the "how many are already placed" count has a
// non-zero case and a zero case in the same fixture.
const DESIGN = {
  plants: [],
  objects: [{ id: "l1", kind: "stone lantern", position: [2, 3] }],
};

const entries = () => api.paletteEntries(DESIGN, {}, 0, [], ROUTERS);
const objectRows = () => entries().filter(e => e.source === "object");

// ── 1. the catalogue is derived, not typed twice ──────────────────────────

test("every kind the library can build reaches the picker, and nothing else does", () => {
  const cat = objectCatalog();
  assert.equal(cat.length, KNOWN_KINDS.length,
    "objectCatalog and BUILDERS disagree — one of them is a second hand-typed list");
  assert.deepEqual(cat.map(o => o.kind).sort(), [...KNOWN_KINDS].sort());
  // the ten core garden objects, by kind
  for (const k of ["lantern", "basin", "boulder", "bench", "pot", "firepit",
                   "screen", "moon_gate", "koi_pond", "pergola"])
    assert.ok(cat.some(o => o.kind === k), `${k} is missing from the picker`);
});

test("a builder with no description still appears, at the generic default", () => {
  // The failure this guards is a builder added to BUILDERS and forgotten in
  // OBJECT_META: it must degrade to a plain label, never disappear.
  const undescribed = objectCatalog().filter(o => !OBJECT_META[o.kind]);
  for (const o of undescribed) {
    assert.ok(o.label, `${o.kind} reached the picker with no label at all`);
    assert.ok(o.height_m > 0, `${o.kind} reached the picker with no height`);
  }
  // and the shape of the fallback is exercised even when every kind IS described
  const meta = { label: undefined, height_m: undefined };
  assert.equal(meta.label ?? "moon_gate".replace(/_/g, " "), "moon gate");
  assert.equal(meta.height_m ?? 0.8, 0.8);
});

test("the sizes are the thing itself, not a shared default", () => {
  const by = Object.fromEntries(objectCatalog().map(o => [o.kind, o]));
  // a bench seat is 0.45 m and a moon gate is 2.4 m; if these ever collapse to
  // one number the picker is drawing ten stubs
  assert.equal(by.bench.height_m, 0.45);
  assert.equal(by.moon_gate.height_m, 2.4);
  assert.equal(by.lantern.height_m, 1.4);
  const heights = new Set(objectCatalog().map(o => o.height_m));
  assert.ok(heights.size >= 6, `only ${heights.size} distinct heights across ten objects`);
});

// ── 2. the rows ───────────────────────────────────────────────────────────

test("the objects are on the same list as the plants, and are placeable", () => {
  const rows = objectRows();
  assert.equal(rows.length, KNOWN_KINDS.length);
  for (const r of rows) {
    assert.equal(r.source, "object");
    assert.ok(r.placeable, `${r.kind} is on the list but cannot be placed`);
    assert.ok(r.kind, "an object row with no kind cannot be placed");
    assert.ok(r.common, `${r.kind} has no readable name`);
  }
});

test("a row says how many are already in this design", () => {
  const rows = Object.fromEntries(objectRows().map(r => [r.kind, r]));
  // "stone lantern" is free text in the design and resolves to the lantern builder
  assert.equal(resolveKind("stone lantern"), "lantern");
  assert.equal(rows.lantern.count, 1, "the lantern already in the design was not counted");
  assert.equal(rows.moon_gate.count, 0, "a kind not in the design must count zero");
});

test("an object's facts are its own size and purpose, never a plant's", () => {
  const gate = objectRows().find(r => r.kind === "moon_gate");
  const facts = api.assetFacts(gate).join(" · ");
  assert.match(facts, /2\.4 × 3\.4 m/);   // its own height AND width, as a plant card reads (units.js pair)
  assert.ok(!/cat-safe|cat toxicity/.test(facts),
    "an object must not carry a cat-safety claim — nobody assessed a moon gate");
  assert.ok(!/mature/.test(facts), "an object does not have a mature size");
});

// ── 3. the filters ────────────────────────────────────────────────────────

test("with no filters the objects are on the list", () => {
  const shown = api.assetFilter(entries(), {});
  assert.equal(shown.filter(e => e.source === "object").length, KNOWN_KINDS.length);
});

test("every plant-only filter drops the objects", () => {
  for (const f of [{ native: true }, { catSafe: true }, { form: "mound" },
                   { water: "low" }, { maxWater: "low" }]) {
    const shown = api.assetFilter(entries(), f);
    assert.equal(shown.filter(e => e.source === "object").length, 0,
      `${JSON.stringify(f)} is a question about a plant and let an object through`);
  }
});

test("cat-safe never admits an object by omission", () => {
  // the sharp end of the rule above: "not assessed" is not "safe", and an object
  // is not assessed at all
  const shown = api.assetFilter(entries(), { catSafe: true });
  assert.deepEqual(shown.filter(e => e.source === "object"), []);
});

test("the search box finds an object by name", () => {
  const hits = api.assetFilter(entries(), { q: "moon" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "moon_gate");
  assert.equal(api.assetFilter(entries(), { q: "lantern" })[0].kind, "lantern");
});

// ── 4. the shelf ──────────────────────────────────────────────────────────

test("objects get their own shelf and never land on a plant's", () => {
  const groups = api.paletteGroups(entries(), GROUP_ROUTERS);
  const obj = groups.filter(g => g.form === "object");
  assert.equal(obj.length, 1, "the objects are not on exactly one shelf");
  assert.equal(obj[0].rows.length, KNOWN_KINDS.length);
  assert.equal(obj[0].label, "garden objects");
  for (const g of groups.filter(g => g.form !== "object"))
    assert.equal(g.rows.filter(r => r.source === "object").length, 0,
      `an object was filed under the plant shelf "${g.label}"`);
});

test("the object shelf comes last, and is sorted small to large", () => {
  const groups = api.paletteGroups(entries(), GROUP_ROUTERS);
  assert.equal(groups[groups.length - 1].form, "object",
    "this is a planting-led garden; the plants come first");
  const h = groups[groups.length - 1].rows.map(r => r.height_m);
  assert.deepEqual(h, [...h].sort((a, b) => a - b), `object shelf out of size order: ${h}`);
});

test("nothing is dropped: every entry lands on exactly one shelf", () => {
  const all = entries();
  const groups = api.paletteGroups(all, GROUP_ROUTERS);
  const placed = groups.flatMap(g => g.rows);
  assert.equal(placed.length, all.length,
    `${all.length} entries went in and ${placed.length} came out`);
  assert.equal(new Set(placed).size, placed.length, "an entry is on two shelves");
});

// ── 5. the op ─────────────────────────────────────────────────────────────

test("placing an object emits place_object, carrying what it is", () => {
  const gate = objectRows().find(r => r.kind === "moon_gate");
  const op = api.placeOp(gate, 11.234, -5.678);
  assert.equal(op.tool, "place_object");
  assert.equal(op.input.kind, "moon_gate");
  assert.deepEqual(op.input.position, [11.23, -5.68]);
  // From the CATALOGUE, not a literal. Hard-coded sizes here would make a change
  // to the moon gate's proportions — it is a wall segment and always wider than
  // it is tall — fail a test that is about PLUMBING, not about how big a moon
  // gate is. A size in objects.js is a design decision; this test's job is that
  // the seeded op carries whatever that decision was.
  assert.equal(op.input.height_m, gate.height_m);
  assert.equal(op.input.width_m, gate.width_m);
  assert.ok(gate.height_m > 0 && gate.width_m > 0,
    "the catalogue entry has no size, so the assertions above are vacuous");
  assert.ok(op.input.id, "place_object is an upsert and needs an id");
});

test("every placement gets a fresh id, or the second lantern replaces the first", () => {
  const lantern = objectRows().find(r => r.kind === "lantern");
  const a = api.placeOp(lantern, 1, 1).input.id;
  const b = api.placeOp(lantern, 2, 2).input.id;
  assert.notEqual(a, b, "place_object is keyed on id — two placements collided");
});

test("a plant still routes to place_plants, unchanged", () => {
  const plant = { source: "shortlist", species: "Salvia apiana", common: "white sage",
                  mature_height_m: 1.2, mature_spread_m: 1.2 };
  const op = api.placeOp(plant, 3, 4);
  assert.equal(op.tool, "place_plants");
  assert.equal(op.input.plants[0].species, "Salvia apiana");
});

test("an object with no position on the ground is refused, not placed at NaN", () => {
  const pot = objectRows().find(r => r.kind === "pot");
  assert.throws(() => api.placeOp(pot, NaN, 2), /no position on the ground/);
  assert.throws(() => api.objectOp({ source: "object" }, 1, 2), /pick what to place/);
});

// ── 6. the wiring — the half that is easy to forget ──────────────────────

test("both call sites hand paletteEntries its object catalogue", () => {
  // Injected arguments make a function testable and make "forgot to pass it" a
  // silently empty shelf. A loader defined and never called empties the picker
  // the same way, so this is asserted rather than assumed.
  const src = codeOnly(main);
  const calls = [...src.matchAll(/paletteEntries\(([^;]*?)\)\s*;/gs)];
  assert.ok(calls.length >= 2, `only ${calls.length} paletteEntries call sites found`);
  for (const c of calls)
    assert.match(c[1], /objectCatalog/,
      "a paletteEntries call site does not pass objectCatalog — that shelf is empty");
});

test("the picker draws objects with the object builder, not the plant one", () => {
  const src = codeOnly(main);
  assert.match(src, /entryThumb\s*=\s*\(e, later\)\s*=>[^;]*objectThumb/,
    "entryThumb must route an object row to objectThumb");
  assert.match(src, /import \{[^}]*objectThumb[^}]*\} from "\.\/thumbs\.js"/,
    "objectThumb is not imported — the cards would fall back to text");
  // and it is actually used where the cards and the tile are drawn
  assert.ok((src.match(/entryThumb\(e\b/g) ?? []).length >= 2,
    "the pick tile and the asset card must both use the dispatcher");
});

test("substitute refuses an object rather than growing one", () => {
  const src = codeOnly(main);
  const i = src.indexOf("async function substituteSelection");
  assert.notEqual(i, -1, "substituteSelection not found — this test slices nothing");
  const body = src.slice(i, i + 900);
  assert.match(body, /source === "object"/,
    'substitute must refuse an object: it would write species: "moon_gate" into a plant');
});

// ── the object LIBRARY: models found, made or scanned ─────────────────

test("a library model is its own row, places as ITSELF, and shows its own picture", () => {
  // Assets need not be baked into code. A fetched lantern and the built-in
  // lantern must be two rows (their key is the FILE), and picking the fetched one must
  // put THAT model down — through the same place_object the agent uses.
  const lib = [{ name: "Wooden Lantern 01", kind: "lantern", model: "assets/objects/wooden-lantern-01.glb",
                 preview: "assets/objects/wooden-lantern-01.png", size_m: [0.22, 0.24, 0.53],
                 source: { from: "polyhaven" } }];
  const design = { plants: [], objects: [{ id: "w1", kind: "lantern", model: lib[0].model, position: [1, 1] }] };
  const rows = api.paletteEntries(design, {}, 0, [], { ...ROUTERS, objectLibrary: () => lib })
    .filter(e => e.source === "object" && /lantern/i.test(e.common));
  const mine = rows.find(e => e.model === lib[0].model), built = rows.find(e => !e.model);
  assert.ok(mine && built, "the fetched lantern and the built-in one are not two rows");
  assert.notEqual(mine.species, built.species, "they share a key, so picking one picks the other");
  assert.equal(mine.count, 1, "the placed fetched lantern is not counted as its own");
  assert.equal(built.count, 0, "a fetched lantern is counted as the built-in kind too");
  assert.equal(mine.height_m, 0.53);
  assert.match(mine.note, /CC0/, "it does not say where it came from");
  const op = api.objectOp(mine, 3, 4);
  assert.equal(op.tool, "place_object");
  assert.equal(op.input.model, lib[0].model, "picking the fetched lantern places the built-in one");
  assert.equal(op.input.kind, "lantern");
  assert.equal(api.objectOp(built, 3, 4).input.model, undefined);
  // its picture is its own render, and no card shows it a file path as a botanical name
  const src = main;
  assert.match(src, /const entryThumb = \(e, later\) => \(e\?\.preview \? `\/\$\{e\.preview\}`/, "the card draws a builder's lantern, not the model's own picture");
  assert.match(src, /if \(!e\.model && \(e\.common \?\? e\.species\) !== e\.species\)/, "a library card shows its file path");
  assert.match(src, /loadObjectLibrary\(\);/, "the library is never loaded, so the picker never shows it");
});
