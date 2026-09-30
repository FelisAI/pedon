/**
 * The schema and the renderer, held to the same plant vocabulary.
 *
 * Why this exists
 * ---------------
 * viewer/src/plants.js reads `form` and `foliage` off a plant record, and
 * schema/design.schema.json's plant object is `additionalProperties: false`.
 * A field the schema does not name is not "the colour is ignored": the schema
 * check in agent.validate() REJECTS the whole design, so the one half of the
 * feature the model can actually reach would be the half that is missing. Half
 * a feature is worse than none, because the renderer's references read as
 * evidence that it works.
 *
 * Re-measured here rather than trusted (node tests/js/plants_schema.test.mjs
 * prints it): of 58 plants in data/design.json, 28 (48.3%) are `mound`, and
 * that one ramp — #5c7a52 -> #6b8a5e — is 25.0 RGB units long, 5.7% of the
 * 441.7 cube diagonal. It carries Lavandula, Eriogonum, Salvia, Heteromeles,
 * Westringia and Olea; across the 28 saved designs, 676 plants and 57 species.
 *
 * The other half of the job is that admitting a field must not repaint anything
 * already on disk: a plant that declares neither field takes the default path,
 * pinned below to the exact colours it produces — a schema change that alters
 * existing designs is a migration, not a feature.
 *
 *     node --test tests/js/plants_schema.test.mjs
 */
import { needsSite } from "./lib/site.mjs";   // about a real site
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PLANT_FORMS } from "../../viewer/src/assets.js";
import { growthForm, buildPlant, GREENS, FOLIAGE_WORDS, fastModelKey } from "../../viewer/src/plants.js";
import {readRenderQuality} from '../../viewer/src/render_quality.js';
import { dataPath } from "../../viewer/project_paths.js";   // the active site's files

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "schema", "design.schema.json"), "utf8"));
const plantSchema = schema.properties.plants.items;

const LIVE = dataPath("design.json");
const FIXTURE = path.join(ROOT, "tests", "fixtures", "scattered_design.json");
const corpus = () => [LIVE, ...fs.readdirSync(dataPath("designs"))
  .filter(f => f.endsWith(".json"))
  .map(f => dataPath("designs", f))];
const plantsOf = f => JSON.parse(fs.readFileSync(f, "utf8")).plants ?? [];

const rgb = h => [h >> 16 & 255, h >> 8 & 255, h & 255];
const rgbDist = (a, b) => Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i]));
const DIAG = Math.hypot(255, 255, 255);

test("the plant object is closed, so a field the schema omits is a rejection", () => {
  // The premise of every assertion below. If this ever became true-by-default
  // the fields would be admitted whatever the schema said, and the tests would
  // be measuring nothing.
  assert.equal(plantSchema.additionalProperties, false,
    "the plant object is open; a missing property is no longer a rejection");
  assert.deepEqual(plantSchema.required, ["id", "species", "position"],
    "the required set moved; re-derive what 'optional' means here");
});

test("the schema admits every plant field the renderer reads", () => {
  // `asset` is in the list on purpose: it is the shape the other two have to
  // match — optional, string,
  // and carrying a description, because the description IS what the model reads.
  for (const field of ["asset", "form", "foliage"]) {
    const p = plantSchema.properties[field];
    assert.ok(p, `plants[].${field} is read by viewer/src/plants.js and the ` +
                 `schema forbids it: a design declaring it is rejected whole`);
    assert.equal(p.type, "string", `plants[].${field} should be a string`);
    assert.ok((p.description ?? "").length > 40,
      `plants[].${field} has no description; the model never learns it exists`);
    assert.ok(!plantSchema.required.includes(field),
      `plants[].${field} is required; every saved design would stop validating`);
  }
});

test("the schema hands the model the vocabulary the renderer normalises to", t => {
  // The two files can drift silently: a colour added to FOLIAGE that the schema
  // never names is a colour the model is never told it may write — the missing
  // field problem again, one word at a time.
  assert.ok(FOLIAGE_WORDS.length >= 9, `only ${FOLIAGE_WORDS.length} foliage words`);
  assert.ok(PLANT_FORMS.length >= 9, `only ${PLANT_FORMS.length} forms`);
  const foliage = plantSchema.properties.foliage.description;
  const form = plantSchema.properties.form.description;
  for (const w of FOLIAGE_WORDS)
    assert.ok(foliage.includes(w), `FOLIAGE has "${w}"; the schema description does not name it`);
  for (const f of PLANT_FORMS)
    assert.ok(form.includes(f), `PLANT_FORMS has "${f}"; the schema description does not name it`);
  // the hex escape hatch is honoured by foliageRamp() and needs its # spelled
  // out: "facade" and "beaded" are six valid hex digits, and without a
  // mandatory # one of them would render as #facade
  assert.ok(/#rrggbb|#[0-9a-f]{6}/i.test(foliage),
    "the schema never mentions the explicit hex form, so nothing will ever write one");
  t.diagnostic(`foliage vocabulary in the schema: ${FOLIAGE_WORDS.join(", ")}`);
});

test("the corpus is measured, and declaring the fields stays additive", needsSite, t => {
  const files = corpus();
  let total = 0, declared = 0;
  const forms = new Map();
  for (const f of files)
    for (const p of plantsOf(f)) {
      total++;
      if (p.foliage || p.form) declared++;
      const g = growthForm(p);
      forms.set(g, (forms.get(g) ?? 0) + 1);
    }
  assert.ok(files.length >= 10, `only ${files.length} designs in the corpus`);
  assert.ok(total >= 500, `only ${total} plants in the corpus`);
  const mound = forms.get("mound") ?? 0;
  t.diagnostic(`corpus: ${files.length} designs, ${total} plants, ` +
               `${mound} (${(100 * mound / total).toFixed(1)}%) on the one mound ramp`);
  t.diagnostic(`mound ramp #${GREENS.mound[0].toString(16)} -> #${GREENS.mound[1].toString(16)}: ` +
    `${rgbDist(...GREENS.mound).toFixed(1)} RGB = ` +
    `${(100 * rgbDist(...GREENS.mound) / DIAG).toFixed(1)}% of the cube diagonal`);
  // `declared` is reported, not asserted: the ops schema offers the fields and
  // design runs emit them, so any fixed count would fail for the feature WORKING.
  // A jump here means new designs are using the fields and their rendering is
  // worth an eye — a note to a human, not a condition a test can decide.
  t.diagnostic(`${declared} of ${total} saved plants declare form/foliage`);
});

/**
 * buildPlant() needs a 2D canvas for its contact shadow and nothing else. The
 * stub is installed around the call, not at module scope, because a sibling
 * suite stubs `document` too with a recorder that has no gradient.
 *
 * The same five lines are in plants.test.mjs. Sharing them would mean importing
 * one test file from another, which under node --test registers that file's
 * whole suite a second time inside this one — a worse defect than a repeated
 * stub.
 */
function withCanvas(fn) {
  const ctx = { createRadialGradient: () => ({ addColorStop() {} }),
                fillRect() {}, set fillStyle(_) {} };
  const real = globalThis.document;
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
  try { return fn(); } finally { globalThis.document = real; }
}

// The plant's own foliage material, asked for by NAME rather than by taking the
// first solid mesh, which would rely on buildPlant() pushing foliage before
// wood. Falling back to the first keeps the helper
// honest about a plant that has no named foliage at all rather than throwing.
const foliageHex = (plant, quality = readRenderQuality()) => withCanvas(() => {
  const out = [];
  // Schema colour promises apply to the app's default viewing path. Full
  // botanical surfaces/geometry have separate species, atlas and palette QA.
  buildPlant(plant,{quality}).traverse(o => { if (o.isMesh && o.material?.isMeshStandardMaterial) out.push(o); });
  assert.ok(out.length, `${plant.species}: built no solid geometry`);
  // "leaf cards": a shoot plant's leaves in Fast, which carry the plant's colour too
  return (out.find(m => m.name === "foliage" || m.name === "leaf cards") ?? out[0]).material.color.getHex();
});

// The default rendering, pinned. One id, one size, every declared habit, so the
// only thing that varies is the form ramp — and every value here was MEASURED
// off this code, not chosen.
//
// These must NOT move when the GEOMETRY changes. The colours are drawn BEFORE any
// geometry: drawn after the vertex loops, which call r() per vertex, subdividing
// a shrub more finely would shift the whole seeded stream and repaint every plant
// in the garden, and a legitimate detail change would arrive as a colour
// regression — which teaches the next person that this file is noise. Drawn
// first, these move only when a RAMP moves — which is the thing the test is
// actually about. If the library's colour management changes, re-derive rather
// than relax.
//
// The one other thing that can move all thirteen at once without any ramp
// changing is the seeded stream itself (rngFrom). Its hash must not make the
// FIRST output nearly linear in the seed: `s = s*31 + c` feeding a bare LCG
// spans only 0.0136 of the unit interval over fifteen sequential plant ids on
// draw one, against 0.9459 on draw three. Since the colours are drawn first,
// that would put the one value that has to differ between neighbours on the one
// draw that does not, and a fifteen-plant drift would render 0.5 RGB units wide
// out of 441. A different stream is a different point on each ramp, so changing
// it moves every default by a few units; each is still ONE ramp lerp and nothing
// else. Re-derive then, not relax — the values stay exact, and a ramp change
// still fails here.
const DEFAULT_HEX = {
  rosette: 0x86a48b, grass: 0xa5a16d, column: 0x466546, tree: 0x668458,
  palm: 0x658853, mat: 0x96b495, mound: 0x638258, cane: 0x839b5a, vine: 0x618252,
  rush: 0x769279, strap: 0x507262, perennial: 0x759258, meadow: 0x9db169,
};

test("a plant that declares no foliage renders exactly what it renders today", t => {
  assert.equal(Object.keys(DEFAULT_HEX).length, PLANT_FORMS.length,
    "a form has no pinned default colour");
  for (const form of PLANT_FORMS) {
    const p = { id: "probe", species: "Xxx yyy", common: "nothing known",
                form, mature_height_m: 4, mature_spread_m: 3 };
    assert.equal(growthForm(p), form, `the probe does not reach ${form}`);
    // THE PLANT'S OWN COLOUR, from its own seed — which full detail draws it with. Fast draws a
    // plant as one of a few individuals of its kind, each its own draw off the same ramp,
    // so on the default path the probe must be EXACTLY its individual's colour, and that
    // individual is one ramp lerp like any other plant.
    const got = foliageHex(p, "detailed");
    assert.equal(foliageHex(p), foliageHex({ ...p, id: fastModelKey(p) }, "detailed"),
      `${form}: the default view draws a colour that is not its individual's`);
    t.diagnostic(`${form.padEnd(8)} #${got.toString(16).padStart(6, "0")}`);
    assert.equal(got, DEFAULT_HEX[form],
      `${form} used to render #${DEFAULT_HEX[form].toString(16).padStart(6, "0")} and now ` +
      `renders #${got.toString(16).padStart(6, "0")}: every saved design changes colour`);
  }
});

test("a plant that declares nothing comes off its own form's ramp", t => {
  // Reads the PINNED fixture, not data/design.json. This test needs plants that
  // declare no foliage, and the live working file is exactly where that stops
  // being true: the design agent emits `foliage` on everything it places, so every
  // live plant would be skipped and the test would report itself vacuous. The
  // answer is a fixed input, not a weaker assertion.
  const plants = plantsOf(FIXTURE);
  assert.ok(plants.length >= 20, `only ${plants.length} plants in the fixture`);
  const seen = new Map();
  let declared = 0;
  for (const p of plants) {
    // A plant that DECLARES its foliage is supposed to leave its form's ramp —
    // that is the entire point of the field. The design agent emits it (p38-p40
    // here declare grey_green), and asserting the ramp over them would fail the
    // feature for working.
    if (p.foliage || p.foliage_hex) { declared++; continue; }
    const form = growthForm(p);
    seen.set(form, (seen.get(form) ?? 0) + 1);
    const ramp = GREENS[form];
    assert.ok(ramp, `${form} has no ramp`);
    const got = rgb(foliageHex(p));
    // a lerp between two endpoints cannot leave the box they span; 1 is the
    // rounding of the sRGB round-trip through the linear working space
    const [lo, hi] = [rgb(ramp[0]), rgb(ramp[1])];
    for (let i = 0; i < 3; i++)
      assert.ok(got[i] >= Math.min(lo[i], hi[i]) - 1 && got[i] <= Math.max(lo[i], hi[i]) + 1,
        `${p.species} (${form}) renders rgb(${got}) — off the #${ramp[0].toString(16)} -> ` +
        `#${ramp[1].toString(16)} ramp it declares nothing to leave`);
  }
  t.diagnostic([...seen].map(([f, n]) =>
    `${f} ${n} (${(100 * n / plants.length).toFixed(1)}%)`).join(", "));
  assert.ok(seen.size >= 1 && [...seen.values()].reduce((a, b) => a + b, 0) >= 5,
    `only ${[...seen.values()].reduce((a, b) => a + b, 0)} undeclared plants checked ` +
    `(${declared} declared and skipped) — this test would pass by checking nothing`);
});
