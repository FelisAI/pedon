// node --test tests/js/plant_model_fresh.test.mjs
//
// The design agent can fetch or make a PLANT model while the viewer is open —
// asset_store writes it into assets/plants/manifest.json. A viewer that reads that
// manifest only once at boot does not know the new model's name, and draws the
// plant as the generic shape until a reload. So a name the page has not seen
// re-reads the manifest once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogNames, ensureAssets, MANIFEST_URL } from "../../viewer/src/assets.js";

let manifest = {};
const asked = [];
globalThis.fetch = async (url) => {
  const u = String(url?.url ?? url);
  asked.push(u);
  if (u.startsWith(MANIFEST_URL)) return { ok: true, json: async () => manifest };
  throw new Error(`no network in this test: ${u}`);
};
const warned = [];
console.warn = (...a) => warned.push(a.join(" "));
console.info = () => {};
const manifestReads = () => asked.filter(u => u.startsWith(MANIFEST_URL)).length;

test("a model added after the page loaded is found, with one re-read", async () => {
  await ensureAssets([]);                                   // boot: the library as it was
  assert.equal(manifestReads(), 1);
  manifest = { buckwheat_made: { name: "buckwheat_made", file: "assets/plants/buckwheat_made.glb",
                                 base_m: 0, height_m: 0.3, spread_m: 0.9 } };
  await ensureAssets(["buckwheat_made"]);                    // make_asset ran meanwhile
  assert.equal(manifestReads(), 2, "the manifest was not re-read for a name it lacked");
  // it went on to LOAD the model: the manifest answered, the (absent) file did not
  assert.ok(warned.some(w => w.includes("buckwheat_made")),
    `the new model was never requested:\n${warned.join("\n")}`);
});

test("a name the library truly lacks costs one re-read, not one per rebuild", async () => {
  const before = manifestReads();
  await ensureAssets(["no_such_model"]);
  await ensureAssets(["no_such_model"]);
  await ensureAssets(["no_such_model"]);
  assert.equal(manifestReads() - before, 1);
});

test("a failed re-read keeps the models already known", async () => {
  // Asked through catalogNames, not by loading the model again: under node, three's
  // FileLoader never settles a SECOND load of a URL whose first Request could not be
  // built (no base for a relative URL outside a browser) — a harness artefact.
  globalThis.fetch = async () => { throw new Error("viewer server restarting"); };
  await ensureAssets(["another_new_one"]);                  // the re-read fails
  assert.ok((await catalogNames()).includes("buckwheat_made"),
    "a failed re-read forgot the library it already had");
});
