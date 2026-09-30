/**
 * Species -> model routing, measured against the designs that actually exist.
 *
 * Why this exists
 * ---------------
 * agent.py asks the model for a free-text botanical `species`. assetName()
 * turns that string into one of the 14 built GLBs through a regex table, and
 * anything it does not recognise silently becomes a procedural mass. Two things
 * are silent by construction: how often that lookup HITS, and whether the names
 * the table emits are names the library actually contains — a model renamed in
 * gen_trees.py would degrade every plant routed to it, with no error anywhere.
 * Code that nothing runs can be wrong for its whole existence, so this runs it.
 *
 * assetName() and growthForm() are pure functions of a plant record, so they
 * run in Node. buildPlant() does too, once a 2D-canvas stub exists for the
 * contact shadow — everything else it does is pure geometry. Only what needs
 * real WebGL — loadPlantLibrary() and hasAsset() over the loaded cache — stays
 * in viewer/routing-test.html. This file checks the routing tables against the
 * manifest ON DISK, which is the same JSON loadPlantLibrary() fetches.
 *
 *     node --test tests/js/plants.test.mjs
 */
import { needsSite } from "./lib/site.mjs";   // about a real site
import { dataPath } from "../../viewer/project_paths.js";   // the active site's files
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assetName, routableAssetNames, MIN_ASSET_HEIGHT_M,
  PLANT_FORMS, FORM_ASSET, normalizeForm,
} from "../../viewer/src/assets.js";
import {
  growthForm, buildPlant, GREENS, FOLIAGE, FOLIAGE_WORDS, normalizeFoliage,
} from "../../viewer/src/plants.js";
import { plantManifest } from "./lib/library.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = plantManifest();

const LIVE = dataPath("design.json");
const corpus = () => [LIVE, ...fs.readdirSync(dataPath("designs"))
  .filter(f => f.endsWith(".json"))
  .map(f => dataPath("designs", f))];
const plantsOf = f => JSON.parse(fs.readFileSync(f, "utf8")).plants ?? [];
const pct = (n, d) => d ? `${n}/${d} = ${(100 * n / d).toFixed(1)}%` : `${n}/0`;

test("every model the routing table can emit is one the library contains", () => {
  const routable = routableAssetNames();
  assert.ok(routable.length >= 10, `only ${routable.length} routable names`);
  const missing = routable.filter(n => !(n in manifest));
  assert.deepEqual(missing, [],
    `ASSET_MATCH routes to models that do not exist: ${missing.join(", ")}. ` +
    `Every plant matching those regexes falls back to a procedural mass with no error.`);
});

test("data/design.json: measured routing coverage, with the height gate accounted for", needsSite, t => {
  const plants = plantsOf(LIVE);
  assert.ok(plants.length, "data/design.json has no plants");

  const species = new Map();                      // species -> {n, asset}
  for (const p of plants) {
    const k = `${p.species} @ ${p.mature_height_m} m`;
    (species.get(k) ?? species.set(k, { n: 0, asset: assetName(p) }).get(k)).n++;
  }
  const routed = plants.filter(p => assetName(p));
  // MIN_ASSET_HEIGHT_M is a deliberate refusal, not a miss: a knee-high
  // cultivar handed a branching-tree model is worse than no model at all.
  // TALL IS NOT THE SAME AS WOODY, and the gate only ever meant the first. Sapling
  // ALWAYS builds a trunk, which is why seven of its presets are unroutable —
  // a blade, a stem bundle, a carpet and a herb have nothing to hang leaves on, and
  // no parameter reaches them. A 2.1 m bronze fennel clears the height gate and is
  // still a herbaceous perennial: handed a branching-tree model it would be a
  // little tree with an umbel on top, which is exactly the failure
  // MIN_ASSET_HEIGHT_M exists to prevent at the other end of the scale.
  //
  // So a tall plant is only "missed" if its FORM is one Sapling can actually build.
  // Verified: the fennel renders correctly procedurally — feathery foliage and
  // yellow umbels on tall stems.
  const HERBACEOUS = new Set(["perennial", "meadow", "grass", "rush", "strap", "mat", "rosette"]);
  const eligible = plants.filter(p => (p.mature_height_m ?? 0) >= MIN_ASSET_HEIGHT_M
                                      && !HERBACEOUS.has(normalizeForm(p.form)));
  const missed = eligible.filter(p => !assetName(p));

  t.diagnostic(`plants routed to a real model:      ${pct(routed.length, plants.length)}`);
  t.diagnostic(`species routed to a real model:     ${pct([...species.values()].filter(s => s.asset).length, species.size)}`);
  t.diagnostic(`gate ${MIN_ASSET_HEIGHT_M} m: eligible plants routed: ${pct(eligible.length - missed.length, eligible.length)}`);
  for (const [k, s] of species) t.diagnostic(`  ${String(s.n).padStart(2)}x ${k.padEnd(50)} -> ${s.asset ?? "procedural"}`);

  assert.deepEqual(missed.map(p => `${p.species} @ ${p.mature_height_m} m`), [],
    "plants tall enough for a real model got none");
  const unknown = routed.map(p => assetName(p)).filter(n => !(n in manifest));
  assert.deepEqual(unknown, [], "routed to a model the library does not contain");
});

test("no saved design routes to a model the library does not contain", t => {
  const bad = [];
  let total = 0, hit = 0, eligible = 0, eligibleHit = 0;
  const used = new Set();
  for (const f of corpus()) {
    for (const p of plantsOf(f)) {
      total++;
      const a = assetName(p);
      if (a) { hit++; used.add(a); if (!(a in manifest)) bad.push(`${path.basename(f)}: ${p.species} -> ${a}`); }
      if ((p.mature_height_m ?? 0) >= MIN_ASSET_HEIGHT_M) { eligible++; if (a) eligibleHit++; }
    }
  }
  t.diagnostic(`corpus: ${corpus().length} designs, ${total} plants, routed ${pct(hit, total)}`);
  t.diagnostic(`corpus: eligible (>= ${MIN_ASSET_HEIGHT_M} m) routed ${pct(eligibleHit, eligible)}`);
  t.diagnostic(`library models never reached by any saved design: ` +
    (Object.keys(manifest).filter(n => !used.has(n)).join(", ") || "(none)"));
  assert.deepEqual(bad, []);
});

test("a plant the asset library refuses never lands in the procedural tree form", needsSite, () => {
  // The two halves of that decision live in different files: assets.js owns the
  // gate, plants.js has to send everything under it to a shrub form, because
  // the procedural tree is the weakest form here and is exactly what a real
  // model was meant to replace. Species come from the real corpus rather than a
  // typed list, so this cannot drift away from what the agent actually writes.
  // The probes are REAL records with the height moved, never retyped fields:
  // assetName() reads species AND common, and a hand-built {species} probe
  // loses whichever half actually matched — Podocarpus macrophyllus 'Maki'
  // routes on its common name "shrubby yew pine", not on the genus.
  const routing = new Map();
  for (const f of corpus()) {
    for (const p of plantsOf(f)) if (assetName(p) && !routing.has(p.species)) routing.set(p.species, p);
  }
  assert.ok(routing.size >= 5, `only ${routing.size} routing species in the corpus`);
  for (const [species, real] of routing) {
    const at = { ...real, mature_height_m: MIN_ASSET_HEIGHT_M };
    const under = { ...real, mature_height_m: MIN_ASSET_HEIGHT_M - 0.01 };
    assert.ok(assetName(at), `${species} at the gate exactly should still get a model`);
    assert.equal(assetName(under), null, `${species} under the gate should get no model`);
    assert.notEqual(growthForm(under), "tree",
      `${species} just under the gate gets no model AND the procedural tree form`);
  }
});

test("a plant classified as a column is never handed a wide-crowned model", () => {
  // assets.js and plants.js classify the same species independently, and when
  // they disagree the ASSET wins — buildPlant() tries buildAssetPlant() first —
  // so the disagreement is invisible in the code and shows up only in the yard.
  // The aspect comes from the manifest, i.e. the model as actually built, not
  // from a second opinion about the plant: a column is narrower than half its
  // height (the cypress model is 0.23, the pine 0.59).
  const wrong = new Set();
  for (const f of corpus()) {
    for (const p of plantsOf(f)) {
      if (growthForm(p) !== "column") continue;
      const a = assetName(p);
      const m = a && manifest[a];
      if (!m) continue;
      const aspect = m.spread_m / m.height_m;
      if (aspect > 0.5) wrong.add(`${p.species} (${p.common}) -> ${a}, spread/height ${aspect.toFixed(2)}`);
    }
  }
  assert.deepEqual([...wrong], [],
    "plants.js calls these columns; assets.js hands them a spreading crown");
});

// ─── form routing ──────────────────────────────────────────────────────────
// The species tables are specific-first and finite; the model's botanical
// vocabulary is not. A species neither table has seen falls to a size heuristic
// (h > 4 -> tree, h < 0.6 -> mat, else mound) and becomes a generic blob, and a
// library that works that way cannot follow a design to another climate. So a
// plant may DECLARE a habit — `form` — read by BOTH routers.

// Deliberately off-palette: Southern-Hemisphere species that neither ASSET_MATCH
// nor FORMS mentions, checked below rather than assumed. `without` is what the
// size heuristic alone produces, so a row where it differs from `want` proves
// the declaration did the work rather than the height.
const FOREIGN = [
  // species, common, declared form, height, form WITH it, form WITHOUT it
  ["Chionochloa flavicans", "dwarf toetoe", "upright grass", 1.0, "grass", "mound"],
  ["Grevillea 'Poorinda Royal Mantle'", "royal mantle", "spreading groundcover", 0.9, "mat", "mound"],
  ["Leptospermum scoparium 'Ruby Glow'", "manuka", "multi-trunk shrub", 4.5, "mound", "tree"],
  ["Dracaena draco", "dragon tree", "succulent rosette", 5.0, "rosette", "tree"],
  ["Widdringtonia nodiflora", "mountain cedar", "columnar evergreen", 6.0, "column", "tree"],
  ["Metrosideros excelsa", "pohutukawa", "canopy tree", 8.0, "tree", "tree"],
  ["Corokia cotoneaster", "wire-netting bush", "mounding subshrub", 2.0, "mound", "mound"],
];
const foreignPlant = ([species, common, form, h]) =>
  ({ species, common, form, mature_height_m: h, mature_spread_m: h * 0.8 });

test("a species neither table knows still lands on the shape it declares", () => {
  for (const row of FOREIGN) {
    const [species, , form, , want, without] = row;
    const p = foreignPlant(row);
    const { form: _drop, ...undeclared } = p;
    // the premise: if a regex table did know this species the row proves nothing
    assert.equal(growthForm(undeclared), without,
      `${species} is not the unknown species this row assumes`);
    assert.equal(growthForm(p), want, `${species} declared "${form}"`);
  }
});

test("a species neither table knows gets its form's model rather than nothing", () => {
  // Only the woody branching forms have a model — the library is Sapling output,
  // so a grass or a rosette is correctly procedural and must stay null.
  const WANT = {
    "Widdringtonia nodiflora": FORM_ASSET.column,
    "Metrosideros excelsa": FORM_ASSET.tree,
    "Leptospermum scoparium 'Ruby Glow'": FORM_ASSET.mound,
    "Dracaena draco": null,          // rosette: no branching model is right
    "Chionochloa flavicans": null,   // under the height gate anyway
    "Grevillea 'Poorinda Royal Mantle'": null,
    // 2.0 m exactly, so it sits ON the gate and is the boundary case: a woody
    // mound at the threshold DOES get its form's model,
    // which is the behaviour this test is named for. Move the gate and this row
    // is the first to notice.
    "Corokia cotoneaster": FORM_ASSET.mound,
  };
  for (const row of FOREIGN) {
    const p = foreignPlant(row);
    const { form: _drop, ...undeclared } = p;
    assert.equal(assetName(undeclared), null,
      `${p.species} already routes by species; this row proves nothing`);
    assert.equal(assetName(p), WANT[p.species] ?? null,
      `${p.species} declared "${p.form}"`);
  }
});

test("a declared form never overrules a species the table knows", () => {
  // Order is the contract: species is the specific layer, form is the fallback.
  // Both probes have to DISAGREE with their declaration at a height the size
  // gate does not touch — a 0.3 m carpet declaring "canopy tree" proves
  // nothing, because sized() collapses tree to mat anyway and the test would
  // pass with the order inverted.
  const grass = { species: "Muhlenbergia rigens", common: "deergrass",
                  form: "mounding subshrub", mature_height_m: 1.2, mature_spread_m: 1.2 };
  assert.equal(growthForm(grass), "grass", "species table beaten by a declared form");

  const cypress = { species: "Cupressus sempervirens 'Glauca'", common: "Italian cypress",
                    form: "canopy tree", mature_height_m: 7, mature_spread_m: 1 };
  assert.equal(assetName(cypress), "cypress", "species model beaten by a declared form");
  assert.notEqual(assetName(cypress), FORM_ASSET.tree);
});

test("a declared tree form is size-gated exactly like a tree genus", () => {
  // A tree genus under MIN_ASSET_HEIGHT_M gets no model, so it must not get
  // the procedural tree either — that is the weakest form and is what a real
  // model exists to replace. A DECLARED habit reaches the same code or it
  // reopens the same hole through the new door.
  const small = { species: "Metrosideros excelsa", common: "pohutukawa",
                  form: "canopy tree", mature_height_m: MIN_ASSET_HEIGHT_M - 0.01,
                  mature_spread_m: 2 };
  assert.equal(assetName(small), null);
  assert.notEqual(growthForm(small), "tree");
  assert.equal(growthForm({ ...small, mature_height_m: 0.4 }), "mat");
});

test("the form vocabulary is closed", () => {
  assert.ok(PLANT_FORMS.length >= 8, `only ${PLANT_FORMS.length} forms`);
  for (const f of PLANT_FORMS) assert.equal(normalizeForm(f), f, `${f} is not its own alias`);
  for (const junk of ["", null, undefined, "banana", "very large"])
    assert.equal(normalizeForm(junk), null, `normalizeForm(${JSON.stringify(junk)})`);
  // every plant in the corpus, declared or not, lands inside the vocabulary
  for (const f of corpus())
    for (const p of plantsOf(f))
      assert.ok(PLANT_FORMS.includes(growthForm(p)), `${p.species} -> ${growthForm(p)}`);
});

test("each form's model is a model built for that form", t => {
  // The form router picks ONE representative model per habit. Two things have to
  // hold or it hands out the wrong silhouette silently: the model has to exist
  // in the library (same failure as a renamed model), and gen_trees.py — which
  // is where a new climate's models get added — has to declare that it serves
  // that habit. Aspect comes from the manifest, i.e. the model as actually
  // built, not from a second opinion about the plant.
  const src = fs.readFileSync(path.join(ROOT, "tools", "gen_trees.py"), "utf8");
  const presets = [...src.matchAll(/^ {4}"([a-z_]+)": dict\(/gm)].map(m => m[1]);
  // the body scan must stop at the next preset, or a preset that declares
  // nothing silently borrows the habit of the one below it
  const declared = new Map([...src.matchAll(
    /^ {4}"([a-z_]+)": dict\(\n(?:(?! {4}")[^\n]*\n)*? *form="([a-z]+)"/gm)].map(m => [m[1], m[2]]));
  assert.ok(presets.length >= Object.keys(manifest).length,
    `parsed only ${presets.length} presets out of gen_trees.py`);
  assert.deepEqual(presets.filter(n => !declared.has(n)), [],
    "gen_trees.py presets with no declared form");
  for (const [f, model] of Object.entries(FORM_ASSET)) {
    assert.ok(model in manifest, `form "${f}" routes to ${model}, not in the library`);
    assert.equal(declared.get(model), f,
      `form "${f}" routes to ${model}, which gen_trees.py builds as "${declared.get(model)}"`);
    const aspect = manifest[model].spread_m / manifest[model].height_m;
    t.diagnostic(`form ${f.padEnd(7)} -> ${model.padEnd(14)} spread/height ${aspect.toFixed(2)}`);
    if (f === "column") assert.ok(aspect < 0.5, `${model} is not narrow (${aspect.toFixed(2)})`);
    else assert.ok(aspect > 0.8, `${model} has no spreading crown (${aspect.toFixed(2)})`);
  }
});

/**
 * buildPlant() needs a 2D canvas for its contact shadow and nothing else — the
 * rest is pure geometry, no WebGL. The stub is installed around the call rather
 * than at module scope because a sibling suite stubs `document` too, with a
 * recorder that has no gradient.
 */
function withCanvas(fn) {
  const ctx = { createRadialGradient: () => ({ addColorStop() {} }),
                fillRect() {}, set fillStyle(_) {} };
  const real = globalThis.document;
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
  try { return fn(); } finally { globalThis.document = real; }
}

// the plant's own geometry; the contact shadow is a textured plane and its raw
// vertices say nothing about where the plant sits
const solidMeshes = g => {
  const out = [];
  g.traverse(o => { if (o.isMesh && o.material?.isMeshStandardMaterial) out.push(o); });
  return out;
};

test("declaring a form builds a different plant, and it stands on the ground", t => {
  // Routing is only worth anything if the forms downstream of it are actually
  // different objects, and code nothing executes can fail every time without
  // anyone knowing — so buildPlant() is run here, outside a browser. Nine declarations,
  // one unknown species, one height: only the form differs, so nine distinct
  // signatures is the proof that the declaration reaches the geometry.
  const seen = new Map();
  for (const form of PLANT_FORMS) {
    const p = { id: "probe", species: "Xxx yyy", common: "nothing known",
                form, mature_height_m: 4, mature_spread_m: 3 };
    assert.equal(growthForm(p), form, `the probe does not reach ${form}`);
    const meshes = withCanvas(() => solidMeshes(buildPlant(p)));
    assert.ok(meshes.length, `${form} built no geometry`);

    let verts = 0, lowest = Infinity;
    for (const m of meshes) {
      const pos = m.geometry.attributes.position;
      verts += pos.count;
      for (let i = 0; i < pos.count; i++) lowest = Math.min(lowest, pos.getY(i));
    }
    const sig = `${meshes.length}m/${verts}v`;
    t.diagnostic(`${form.padEnd(8)} ${sig.padEnd(12)} lowest vertex ${lowest.toFixed(3)} m`);
    assert.ok(!seen.has(sig), `${form} builds the same thing as ${seen.get(sig)}`);
    seen.set(sig, form);

    // A mound built as a dome centred at h/2 hangs every shrub half its height
    // in the air, which nobody notices until it is looked at from eye level.
    // A vine is the one deliberate exception — it starts a
    // quarter of the way up whatever it is climbing. The column is the loosest
    // real case at 0.12 m on a 4 m plant, which is why the bar is 5% and not 0.
    if (form !== "vine") assert.ok(lowest < 4 * 0.05,
      `${form} floats ${lowest.toFixed(2)} m above its own ground`);
  }
});

// ─── foliage colour ────────────────────────────────────────────────────────
// GREENS in plants.js is keyed on the nine growth FORMS, so two species that
// share a form are drawn from one ramp and differ only by where the seeded rng
// landed on it. Measured on data/design.json: 28 of 58 plants (48%) are
// `mound` — Heteromeles, Salvia, Lavandula, Eriogonum, Westringia, Olea — and
// that ramp (#5c7a52 -> #6b8a5e) is 25.0 RGB units long, 5.7% of the cube
// diagonal. Across the saved corpus it is 676 plants and 57 species on that one
// ramp. At the distance a garden is judged from, colour is most of what
// separates two shrubs of the same silhouette.
const RAMP_W = 25.0;         // the mound ramp's own length, measured: the bar for
                             // "further apart than the variation it replaces"
const rgb = h => [h >> 16 & 255, h >> 8 & 255, h & 255];
const rgbDist = (a, b) => Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i]));

// The meshes NAMED "foliage" carry the foliage colour.
//
// A mound has visible stems, so it has more than one solid mesh and "the only
// solid mesh" identifies nothing. Asking by name is stronger than counting, not
// weaker: it cannot silently read the bark ramp if the order of the pushes ever
// changes, which counting could.
function foliageHex(plant) {
  const meshes = withCanvas(() => solidMeshes(buildPlant(plant)))
    .filter(m => m.name === "foliage");
  assert.ok(meshes.length, `${plant.species}: no mesh named "foliage"`);
  // There are TWO — the solid masses, and the alpha-masked leaf cards kept
  // separate so the mask cannot punch leaf-shaped holes through the core. What
  // this function is actually about is the COLOUR, so it asserts that every
  // foliage mesh carries the same one. That is stronger than a count: it would
  // catch the cards and the core drifting apart, which counting never could.
  const hexes = [...new Set(meshes.map(m => m.material.color.getHex()))];
  assert.equal(hexes.length, 1,
    `${plant.species}: foliage meshes disagree about colour — ` +
    hexes.map(h => "#" + h.toString(16).padStart(6, "0")).join(" vs "));
  return hexes[0];
}

// The foliage a gardener would describe, in words the model actually writes.
// Grey-green repeats because Mediterranean planting IS mostly grey-green: the
// claim is not that every species differs, it is that the ones that genuinely
// differ stop being identical. Records come from the corpus, never retyped:
// growthForm() reads species AND common, and a hand-built probe loses whichever
// half matched.
const LIVE_MOUND_FOLIAGE = {
  "Heteromeles arbutifolia": "dark glossy green",
  "Salvia clevelandii": "grey-green",
  "Lavandula x intermedia 'Provence'": "silver",
  "Eriogonum fasciculatum": "grey-green",
  "Westringia fruticosa": "grey-green",
  "Olea europaea 'Montra'": "silver-grey",
};

test("species sharing a form share one ramp until they declare their foliage", needsSite, t => {
  const real = new Map();
  for (const f of corpus())
    for (const p of plantsOf(f))
      // ...and that have NOT declared their foliage, because `before` MEANS
      // "before declaring". Without this filter the species picked depend on
      // which design happens to be first in the corpus, and a design that
      // declares foliage on every plant makes the "before" set half declared
      // colours (the measured ramp width jumps to 212.9). A test whose input is
      // a mutable working file fails for having the wrong input, not for
      // finding a bug.
      if (LIVE_MOUND_FOLIAGE[p.species] && !real.has(p.species) && growthForm(p) === "mound"
          && !(p.foliage || p.foliage_hex))
        real.set(p.species, p);
  assert.ok(real.size >= 5, `only ${real.size} of the fixture species are in the corpus`);

  const spread = hexes => {
    let w = 0;
    for (const a of hexes) for (const b of hexes) w = Math.max(w, rgbDist(a, b));
    return w;
  };
  const before = [...real.values()].map(foliageHex);
  const after = [...real].map(([s, p]) => foliageHex({ ...p, foliage: LIVE_MOUND_FOLIAGE[s] }));
  for (const [i, [s]] of [...real].entries())
    t.diagnostic(`${s.padEnd(36)} #${before[i].toString(16).padStart(6, "0")} -> ` +
                 `#${after[i].toString(16).padStart(6, "0")}  (${LIVE_MOUND_FOLIAGE[s]})`);
  t.diagnostic(`widest gap between these species: ${spread(before).toFixed(1)} -> ${spread(after).toFixed(1)} RGB`);

  // the premise, measured: everything on one form ramp is inside that ramp's
  // own length. If someone widens GREENS instead, this fails and the numbers
  // above have to be re-derived rather than quietly trusted.
  assert.ok(spread(before) <= RAMP_W + 0.01,
    `the form ramp is already ${spread(before).toFixed(1)} wide; re-derive this test`);
  assert.ok(spread(after) >= 3 * RAMP_W,
    `declared foliage spreads these species only ${spread(after).toFixed(1)} RGB, ` +
    `barely more than the ${RAMP_W} ramp it replaces`);
  // species that declare the SAME foliage stay together — the colour comes from
  // the declaration, not from the species string
  const byWord = new Map();
  for (const [i, [s]] of [...real].entries()) {
    const w = LIVE_MOUND_FOLIAGE[s];
    if (byWord.has(w)) assert.ok(rgbDist(byWord.get(w), after[i]) <= RAMP_W * 2,
      `two species declaring "${w}" are ${rgbDist(byWord.get(w), after[i]).toFixed(1)} RGB apart`);
    byWord.set(w, after[i]);
  }
});

test("the foliage vocabulary is closed, and a generic green is not in it", () => {
  assert.ok(FOLIAGE_WORDS.length >= 8, `only ${FOLIAGE_WORDS.length} foliage words`);
  for (const w of FOLIAGE_WORDS) assert.equal(normalizeFoliage(w), w, `${w} is not its own alias`);
  for (const junk of ["", null, undefined, "banana", "leafy", "medium green"])
    assert.equal(normalizeFoliage(junk), null, `normalizeFoliage(${JSON.stringify(junk)})`);
  // The one that is not junk and still has to be refused: "green" says no more
  // than the form ramp already does, so accepting it would pull all nine forms
  // onto one colour — the flatness this feature exists to remove, inverted.
  for (const generic of ["green", "evergreen", "green foliage", "mid-green"])
    assert.equal(normalizeFoliage(generic), null,
      `"${generic}" displaces the form ramp with a generic green`);
  // the words a gardener actually writes, each landing where it should
  for (const [text, want] of [
    ["silver-grey", "silver"], ["grey-green", "grey_green"], ["gray green", "grey_green"],
    ["blue-grey glaucous", "blue_green"], ["dark glossy green", "dark_green"],
    ["golden yellow-green", "chartreuse"], ["deep burgundy", "purple"],
    ["bronze new growth", "bronze"], ["cream variegated", "variegated"],
    ["olive", "grey_green"], ["white woolly", "silver"], ["fresh apple green", "bright_green"],
  ]) assert.equal(normalizeFoliage(text), want, `"${text}"`);
});

test("the foliage palette is separated by more than the ramp it replaces is wide", t => {
  const mid = ([a, b]) => rgb(a).map((v, i) => (v + rgb(b)[i]) / 2);
  const dist = (p, q) => Math.hypot(...p.map((v, i) => v - q[i]));
  let closest = [Infinity, ""];
  for (const [w, pair] of Object.entries(FOLIAGE)) {
    // still a RAMP, not a flat colour: without per-plant variation every
    // lavender in a drift is pixel-identical, which is the same defect one
    // level down
    const width = rgbDist(pair[0], pair[1]);
    assert.ok(width >= RAMP_W / 2 && width <= RAMP_W * 2,
      `${w} ramp is ${width.toFixed(1)} wide; the form ramps are ~${RAMP_W}`);
    for (const [v, other] of Object.entries(FOLIAGE)) {
      if (v === w) continue;
      const d = dist(mid(pair), mid(other));
      if (d < closest[0]) closest = [d, `${w} vs ${v}`];
    }
  }
  t.diagnostic(`closest two foliage words: ${closest[1]} at ${closest[0].toFixed(1)} RGB ` +
               `(form ramp width ${RAMP_W})`);
  assert.ok(closest[0] >= RAMP_W,
    `${closest[1]} are ${closest[0].toFixed(1)} apart, inside the ${RAMP_W} jitter of one ramp`);
});

test("a foliage word the vocabulary does not know leaves the form ramp alone", () => {
  // The fallback is the whole safety of this feature: the model writes free
  // text, and anything it invents must render exactly as it did before rather
  // than as some default colour.
  const base = { id: "probe", species: "Xxx yyy", common: "nothing known",
                 form: "mounding subshrub", mature_height_m: 1.2, mature_spread_m: 1.2 };
  assert.equal(growthForm(base), "mound");
  const plain = foliageHex(base);
  // "facade" and "beaded" are six valid hex digits. A foliage word must not
  // become a colour by accident, so the # is required rather than optional.
  for (const junk of ["", "banana", "green", "evergreen", "very leafy", "facade", "beaded"])
    assert.equal(foliageHex({ ...base, foliage: junk }), plain,
      `foliage: ${JSON.stringify(junk)} moved the colour off the form ramp`);
  const m = rgb(GREENS.mound[0]).map((v, i) => (v + rgb(GREENS.mound[1])[i]) / 2);
  assert.ok(Math.hypot(...rgb(plain).map((v, i) => v - m[i])) <= RAMP_W,
    `the default is no longer on the mound ramp: #${plain.toString(16)}`);
});

test("an explicit hex wins outright", () => {
  // same contract as plant.asset beating the species table: a promise about one
  // plant, honoured exactly, with no ramp jitter to drift off it
  const base = { id: "probe", species: "Xxx yyy", common: "nothing known",
                 form: "mounding subshrub", mature_height_m: 1.2, mature_spread_m: 1.2 };
  for (const written of ["#b4463c", " #B4463C "])
    assert.equal(foliageHex({ ...base, foliage: written }), 0xb4463c, `foliage: "${written}"`);
  assert.notEqual(foliageHex({ ...base, foliage: "#b4463c" }), foliageHex(base));
  // a word still beats nothing, and a malformed hex is not silently a colour
  assert.equal(foliageHex({ ...base, foliage: "#12345" }), foliageHex(base));
});
