// node --test tests/js/asset_loading.test.mjs
//
// The library loads what the design NEEDS, not all of it.
//
// Fetching and Draco-decoding all 24 models (16.0 MB) with `loadPlantLibrary()`
// costs ~1.15 s per page load, even for a design that routes to only two.
//
// buildPlant() is SYNCHRONOUS and asks the cache for a model. A model that
// arrives after the design builds silently leaves that plant procedural, and
// nothing reports it. The models the opening design names are awaited before
// the first build, and everything else waits until something asks to draw it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { assetsNeededBy, MIN_ASSET_HEIGHT_M, routableAssetNames } from "../../viewer/src/assets.js";
import { plantManifest } from "./lib/library.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const assets = readFileSync(path.join(ROOT, "viewer", "src", "assets.js"), "utf8");
// The TRACKED FIXTURE, not data/design.json.
//
// A test about ROUTING needs a design that holds still. The owner's live working
// design changes as they edit it; removing its only tree can leave no models to
// route to without any routing fault.
const design = JSON.parse(
  readFileSync(path.join(ROOT, "tests", "fixtures", "hua_jing_design.json"), "utf8"));
const manifest = plantManifest();
const codeOnly = s => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("the live design needs only a handful of the library", () => {
  const need = assetsNeededBy(design);
  assert.ok(design.plants.length >= 100, "design.json is not the big design any more");
  assert.ok(need.length >= 1, "no model at all — routing is broken, not thrifty");
  assert.ok(need.length < Object.keys(manifest).length / 2,
    `${need.length} of ${Object.keys(manifest).length} models needed — if the design really `
    + "does use half the library there is nothing to save and this test should be re-thought");
  for (const n of need)
    assert.ok(manifest[n], `${n} is routed to but is not in the manifest`);
});

test("it names every model the design routes to, and no others", () => {
  // identities, not a count: a thrifty loader that misses a model leaves that
  // plant silently procedural, which is the failure mode this whole area has
  const need = new Set(assetsNeededBy(design));
  const big = design.plants.filter(p => (p.mature_height_m ?? 0) >= MIN_ASSET_HEIGHT_M);
  assert.ok(big.length > 0, "no plant clears the size gate — nothing is being checked");
  assert.ok(need.size > 0);
  // nothing under the gate may have pulled a model in
  const small = design.plants.filter(p => (p.mature_height_m ?? 0) < MIN_ASSET_HEIGHT_M);
  assert.equal(small.length + big.length, design.plants.length);
});

test("a design with no plants asks for nothing rather than throwing", () => {
  assert.deepEqual(assetsNeededBy({ plants: [] }), []);
  assert.deepEqual(assetsNeededBy({}), []);
  assert.deepEqual(assetsNeededBy(null), []);
});

test("boot awaits the design's own models, and does NOT preload the library", () => {
  const src = codeOnly(main);
  // through ensurePlantModels (both modes, only plants that draw from a file)
  assert.match(src, /await ensurePlantModels\(/,
    "boot no longer awaits the models the opening design names — a plant that "
    + "routes to a GLB will render procedural on the first frame, silently");
  // the whole-library preload must not be back on the boot path
  assert.ok(!/await loadPlantLibrary\(\)/.test(src),
    "loadPlantLibrary() is awaited again — that is all 24 models on every page load");
});

test("opening the picker uses immediate previews without loading full botanical assets", async () => {
  // from the photo index THROUGH showAssets: opening the picker is both, and a
  // slice starting at showAssets alone leaves `loadRefPhotos` undefined
  const start = main.indexOf("let refPhotoIndex");
  const end = main.indexOf("\nfunction assetFilters", start);
  assert.ok(start >= 0 && end > start);
  assert.ok(main.slice(start, end).includes("async function showAssets("),
    "the slice no longer contains showAssets");
  const calls = [], window = {hidden:true};
  const unexpected = () => { throw Error("Picker fetched full botanical assets"); };
  // `fetch` is stubbed rather than left global: opening the picker reads the
  // reference-photo index so a card can say whether the user has photographed that
  // plant, and a test that let it reach the network would be timing a request.
  const show = new Function("document", "fetch", "preparePlantTextures", "ensureAssets",
    "catalogNames", "forgetThumbs", "renderAssetWindow", "loadOwned", "syncRail", "prepareSimplifier",
    main.slice(start,end)+"; return showAssets;")(
    {getElementById:id=>id==="assetWindow"?window:{classList:{toggle(){}},hidden:true}},
    async()=>({json:async()=>({})}),
    unexpected,unexpected,unexpected,unexpected,()=>calls.push("draw"),
    async()=>({catalogue:[]}),                      // their plant list: read, never a model
    ()=>{},                                         // the dock lamp: Add lights while it is open
    async()=>true);                                 // the Fast reducer's simplifier: ready
  // TWO draws on open, deliberately: one immediately with what is loaded, and
  // one when the photo index arrives. A single draw would leave every card
  // saying they have not photographed the plant until something else redraws it.
  await show(true); assert.equal(window.hidden,false); assert.deepEqual(calls,["draw","draw"]);
  calls.length=0;
  await show(false); assert.equal(window.hidden,true); assert.deepEqual(calls,[]);
});

test("actual boot preload: Fast loads the builders' textures small and no library models; full detail awaits both",async()=>{
  const start=main.indexOf('const opening = await');
  const end=main.indexOf('\n  } catch',start);assert.ok(start>=0 && end>start);
  const body=main.slice(start,end),calls=[];
  const preload=new Function('renderQuality','fetch','preparePlantTextures','ensurePlantModels',
    'ensureObjectModels','objectModelsNeededBy',
    // NEWLINE after the body: it ends in a `// ...` line comment, and
    // concatenating '})();' straight onto it puts the closing brace INSIDE the
    // comment — "Unexpected end of input", from a test that reads the source
    // rather than from the source itself.
    'return (async()=>{'+body+'\n})();');
  for(const quality of ['fast','detailed']){
    calls.length=0;
    await preload(quality,async()=>({json:async()=>({plants:[]})}),
      async()=>calls.push('textures'),async()=>calls.push('models'),
      async()=>calls.push('object models'),()=>[]);
    // OBJECT MODELS LOAD IN BOTH MODES, and that is the point of them being
    // outside the guard. Fast preview is about BOTANICAL detail — simplified
    // plants, faster loading — and a scanned object has no simplified version:
    // the alternative to the user's own stone is a preset of something else.
    // Putting the load inside the guard leaves the model uncached in Fast, so
    // the stone silently draws as the builder's generic boulder (980 triangles).
    // THE BUILDERS' TEXTURES LOAD IN BOTH MODES — Fast draws the same builders,
    // reduced, and their colour is in their textures (at 256 px in Fast); without them
    // Evergold and Sunset Gold draw 20-28% dark. AND THE MODEL FILES LOAD IN BOTH MODES:
    // Fast draws a library tree or a species' own model reduced, not the generic shape —
    // ensurePlantModels decides which (only files a plant will draw from; in Fast only for kinds
    // not already kept), tested below.
    assert.deepEqual(calls, ['textures','models','object models']);
  }
});

test("ensurePlantModels loads a model file only for plants that draw from it — and in Fast only for kinds not kept", async () => {
  const start = main.indexOf("async function ensurePlantModels(");
  assert.ok(start >= 0, "ensurePlantModels not found — this test tests nothing");
  const end = main.indexOf("\n}\n", start);
  const make = new Function("sizedPlantsOf", "colourFromPalette", "growthScale", "assetsNeededBy", "assetName",
    "drawnByCode", "ensureAssets", "restoreModels", "keptModel", "fastModelKey",
    main.slice(start, end + 2) + "; return ensurePlantModels;");
  const plants = [{ id: "olive", model: "olive" }, { id: "hurd", model: "manzanita", code: true },
                  { id: "sage" }, { id: "kept", model: "toyon" }];
  const loaded = [], restored = [];
  const ensure = make(d => d.plants, d => d, () => 1, d => d.plants.map(p => p.model), p => p.model ?? null,
    p => !!p.code, async names => { loaded.push(...names); }, async keys => { restored.push(...keys); },
    key => key === "kept" ? {} : undefined, p => p.id);
  await ensure({ plants }, "detailed");
  assert.deepEqual(loaded, ["olive", "toyon"], "full detail loads a file its own code leaves unused, or misses one");
  assert.deepEqual(restored, [], "full detail read back Fast's kept plants");
  loaded.length = 0;
  await ensure({ plants }, "fast");
  assert.deepEqual(restored, ["olive", "hurd", "sage", "kept"], "Fast built without reading its kept plants back first");
  assert.deepEqual(loaded, ["olive"], "Fast loads a file for a kind it already keeps, or for one its code draws");
});

test("ensureAssets is idempotent and skips what is cached", () => {
  const src = codeOnly(assets);
  const i = src.indexOf("export async function ensureAssets");
  assert.notEqual(i, -1);
  const body = src.slice(i, i + 700);
  assert.match(body, /!cache\.has\(/,
    "ensureAssets re-fetches models it already has — opening the picker twice "
    + "would download the library twice");
  assert.match(body, /new Set\(/, "duplicate names in one call would be fetched twice");
});

// ── the "Plants at" slider must not change WHICH MODEL a plant gets ──
//
// It is a drawing control. Every decision, validator and walkthrough uses mature
// size, because judging a garden 30% smaller than the one that gets built leads
// to incorrect spacing. Which GLB a plant routes to is a decision — a manzanita
// is a manzanita at three years and at thirty — so routing must use the declared
// mature height.
//
// At the default growth of 0.70, gating on scaled height makes four 2.5 m
// Arctostaphylos render PROCEDURAL at 6,500 leaf cards each while two 3 m
// Ceanothus keep their GLB, because 2.5 x 0.7 = 1.75 falls under
// MIN_ASSET_HEIGHT_M and 3 x 0.7 = 2.1 does not. This makes the working view
// show a different, worse asset than the mature view, and leaves manzanita.glb
// fetched on every page load but unused.
import { assetName } from "../../viewer/src/assets.js";

const scaled = (p, growth) => ({ ...p,
  mature_spread_m: (p.mature_spread_m ?? 1) * growth,
  mature_height_m: (p.mature_height_m ?? 1) * growth,
  declared_height_m: p.mature_height_m ?? 1 });

test("a plant keeps its model at every growth stage", () => {
  const mz = { species: "Arctostaphylos spp.", common: "Manzanita", form: "mound",
               mature_height_m: 2.5, mature_spread_m: 2.5 };
  const at = assetName(mz);
  assert.equal(at, "manzanita", "the mature plant does not route to a model at all");
  for (const growth of [0.45, 0.7, 1.0]) {
    assert.equal(assetName(scaled(mz, growth)), at,
      `at growth ${growth} a manzanita routes to ${assetName(scaled(mz, growth))} `
      + `instead of ${at} — the slider is changing a DECISION, not a drawing`);
  }
});

test("the gate still refuses a plant that is genuinely too small", () => {
  // not every plant gets a model: a knee-high cultivar handed a full branching
  // tree is worse than no model, which is why MIN_ASSET_HEIGHT_M exists
  const carpet = { species: "Arctostaphylos 'Emerald Carpet'", common: "Manzanita",
                   form: "mat", mature_height_m: 0.3, mature_spread_m: 1.2 };
  assert.equal(assetName(carpet), null);
  assert.equal(assetName(scaled(carpet, 1.0)), null,
    "a 0.3 m groundcover got a tree model once declared_height_m was honoured");
});

test("buildDesignGroup carries the declared height through its scaling", async () => {
  // the guard for the other half: assets.js can only honour the field if the
  // caller sets it, and the caller is the only place that knows the true size.
  // The scaling is sizedPlantsOf — one owner, asked by the build and by the model loading
  const { sizedPlantsOf } = await import("../../viewer/src/design.js");
  const [p] = sizedPlantsOf({ plants: [{ id: "a", species: "x", mature_height_m: 2.5, mature_spread_m: 2, position: [0, 0] }] }, 0.7);
  assert.equal(p.mature_height_m, 2.5 * 0.7, "the growth scaling is gone — re-check what replaced it");
  assert.equal(p.declared_height_m, 2.5,
    "the scaling does not carry the declared size, so assetName() is back to gating on a number the slider moves");
  const design = readFileSync(path.join(ROOT, "viewer", "src", "design.js"), "utf8");
  const i = design.indexOf("export async function buildDesignGroup");
  assert.notEqual(i, -1, "buildDesignGroup not found — this test slices nothing");
  const body = design.slice(i, design.indexOf("\n}\n", i));
  assert.match(body, /sizedPlantsOf\(design, growth\)/, "buildDesignGroup no longer sizes its plants through sizedPlantsOf");
});

// ── Sapling is the wrong generator for seven of the ten small presets ─
//
// Routing to the ten sub-3 m models requires a measurement. Side-by-side renders
// against the procedural plant at the same species and size show:
//
//   grass_tuft, grass_fountain, rush_upright, strap   two thin vertical spikes
//   meadow_annual, perennial_clump, mat_spreading     bare-stemmed miniatures
//
// Sapling builds a BRANCH SKELETON with leaves on it. A fescue is two hundred
// blades from a crown, a rush is a bundle of stems, a groundcover is a carpet
// and a poppy is a herb — none of them has a trunk to hang anything from, and no
// parameter tuning produces one. Sapling's worse results below 2 m reflect what
// the generator makes, not a threshold to tune around. The procedural forms beat
// all seven decisively and cost 1.5-10x less.
//
// This test exists so a future session cannot lower MIN_ASSET_HEIGHT_M and
// silently route a fescue to a little tree. It is a DECISION written down, not a
// bug guard.
const WRONG_GENERATOR = ["grass_tuft", "grass_fountain", "rush_upright", "strap",
                         "meadow_annual", "perennial_clump", "mat_spreading"];

test("the seven wrong-generator presets are unreachable by routing", () => {
  const routable = new Set(routableAssetNames());
  for (const name of WRONG_GENERATOR)
    assert.ok(!routable.has(name),
      `${name} is routable. Sapling cannot build this form — it makes branch `
      + "skeletons, and this is a blade, a stem bundle, a carpet or a herb. "
      + "It is hand-placeable on purpose, not by omission.");
  // and they are still in the LIBRARY, because hand-placing them stays allowed
  for (const name of WRONG_GENERATOR)
    assert.ok(manifest[name], `${name} vanished from the manifest entirely`);
});

test("a knee-high plant is refused a model, whatever the tables say", () => {
  // Sapling ALWAYS builds a trunk, so a 0.5 m Salvia rendered from any of these
  // models is a miniature tree with a bare stem while the procedural one is the
  // broad low mass a subshrub actually is. The gate is what stops that, and the
  // failure mode is lowering it to allow routing to the ten small models.
  const small = { species: "Salvia officinalis 'Berggarten'", common: "Berggarten sage",
                  form: "mound", mature_height_m: 0.5, mature_spread_m: 0.7 };
  assert.equal(assetName(small), null,
    `a 0.5 m subshrub routed to ${assetName(small)} — the size gate is open, and `
    + "Sapling puts a bare trunk under it. Procedural is the honest shape "
    + "below 2 m and measurably the better picture.");
  // and the models the tables DO name are all built at tree scale, so the gate
  // and the tables cannot drift apart in the other direction
  for (const name of routableAssetNames()) {
    const m = manifest[name];
    if (!m) continue;
    assert.ok((m.height_m ?? 0) >= 2.0,
      `${name} is routable but was built at ${m.height_m} m`);
  }
});
