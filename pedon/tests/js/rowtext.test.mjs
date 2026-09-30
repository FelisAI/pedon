// node --test tests/js/rowtext.test.mjs
//
// What one row in the objects list SAYS.
//
// A row shows what a thing IS (a bed's area, a path's length) rather than only
// its id: 269 rows that read `plant · p23 · Pink muhly grass` say nothing. Two
// halves — a name a person recognises, and the measurement — written ONCE:
// written in main.js and again in the review sheet, they drift, and the sheet
// shows a bare id for every bed and path while the app shows areas and lengths.
import { resolvePath } from "../../viewer/project_paths.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rowLabel, rowMeta, rowOf, kindPlural, polyLen }
  from "../../viewer/src/shell/rowtext.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = p => fs.readFileSync(resolvePath(p), "utf8");   // data/… is the active site's
const codeOnly = s => s.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

const BED   = { id: "bed_south", polygon: [[0, 0], [4, 0], [4, 3], [0, 3]], mulch: "bark" };
const PATH  = { id: "contour_walk", spline: [[0, 0], [0, 10]], width_m: 1.05,
                material: "decomposed_granite" };
const PLANT = { id: "p27", species: "Thymus vulgaris", common: "Common thyme",
                mature_height_m: 0.3, mature_spread_m: 0.6 };
const OBJ   = { id: "basin", kind: "water basin", height_m: 0.5, width_m: 0.7 };
const STEPS = { id: "terrace_steps", spline: [[0, 0], [3, 4]], riser_m: 0.15, going_m: 0.4 };

test("the NAME is what a person would call it, never an opaque id", () => {
  // `p27` says nothing; "Common thyme" is the thing the user is looking for, and a
  // garden object's free-text kind is the best name it has
  assert.equal(rowLabel(PLANT, "plant"), "Common thyme");
  assert.equal(rowLabel(OBJ, "object"), "water basin");
  // a bed's id already IS a name — inventing a prettier one would be fiction
  assert.equal(rowLabel(BED, "bed"), "bed_south");
});

test("a plant with no common name falls back to its species, then its id", () => {
  assert.equal(rowLabel({ id: "p9", species: "Salvia apiana" }, "plant"), "Salvia apiana");
  assert.equal(rowLabel({ id: "p9" }, "plant"), "p9");
});

test("the MEASURE is the quantity you would buy", () => {
  assert.equal(rowMeta(BED, "bed"), "12.0 m²");
  assert.equal(rowMeta(PATH, "path"), "10.0 m · 1.1 m wide");
  // CENTIMETRES for a riser: at one decimal of a metre every riser in a
  // design prints as "0.1 m", and 0.15 against 0.19 is the difference between
  // a comfortable step and one over the code limit
  assert.equal(rowMeta(STEPS, "steps"), "5.0 m · 15 cm risers");
  assert.equal(rowMeta({ id: "s2", spline: [[0, 0], [3, 4]], riser_m: 0.19 }, "steps"),
    "5.0 m · 19 cm risers", "two different risers must not print the same");
});

test("where the name does not identify ONE thing, the id comes with it", () => {
  // in a real design 81 of 215 plants are called Pink muhly grass; the id is the only thing
  // that tells two of them apart, so it moves to the dim column rather than away
  assert.match(rowMeta(PLANT, "plant"), /\bp27\b/);
  assert.match(rowMeta(PLANT, "plant"), /0\.3 m/);
  assert.match(rowMeta(OBJ, "object"), /\bbasin\b/);
});

test("a missing measurement says so rather than printing NaN or undefined", () => {
  const m = rowMeta({ id: "p1", common: "x" }, "plant");
  assert.ok(!/NaN|undefined|null/.test(m), `a bare plant renders "${m}"`);
  assert.equal(rowMeta({ id: "o1", kind: "moon gate" }, "object"), "o1");
  assert.equal(rowMeta(undefined, "bed"), "");
});

test("the plural of steps is steps", () => {
  // `kind + "s"` puts "stepss" on screen
  assert.equal(kindPlural("steps"), "steps");
  assert.equal(kindPlural("bed"), "beds");
  assert.equal(kindPlural("patio"), "patios");
  // an unmodelled kind still gets a heading rather than blanking one
  assert.equal(kindPlural("koi pond"), "koi ponds");
});

test("polyLen measures the run, not the straight line between the ends", () => {
  // an L-shaped path is 8 m of walking and 5.66 m as the crow flies; a path is
  // bought and walked by the first number
  assert.equal(polyLen([[0, 0], [4, 0], [4, 4]]), 8);
  assert.equal(polyLen([[1, 1]]), 0);
  assert.equal(polyLen(undefined), 0);
});

test("rowOf carries the id through, so selection still has something to point at", () => {
  assert.deepEqual(rowOf(BED, "bed"),
    { id: "bed_south", kind: "bed", name: "bed_south", meta: "12.0 m²" });
});

test("BOTH the app and the review sheet read this one module", () => {
  // THE WHOLE POINT. A review sheet that builds its own row shape reviews that
  // shape, and the shipped one goes unlooked at. A second copy of this
  // vocabulary drifts within the hour.
  for (const f of ["viewer/src/main.js", "viewer/src/shell_preview.js"]) {
    const src = codeOnly(read(f));
    assert.match(src, /import\s*\{[^}]*rowOf[^}]*\}\s*from\s*["']\.[^"']*rowtext\.js["']/,
      `${f} does not import the row vocabulary`);
    assert.ok(!/function\s+describe\s*\(/.test(src),
      `${f} has its own describe() — a second copy drifts`);
  }
});

// ── WHICH BEDS ARE CROWDED WHEN GROWN, on a saved design's row ──────────
// A design can be over 2.0x at full maturity while the Saved list says only
// "203 plants · 31 species". The measurement is python's; what is tested here
// is that the row says it, and that the three places it travels through are joined.
import { crowdedLine } from "../../viewer/src/shell/rowtext.js";

const OVER = [
  { bed: "hua_jing_upper", coverage: 3.8, reading: "crowded at full maturity" },
  { bed: "bed_upper_bank", coverage: 3.18, reading: "crowded at full maturity" },
  { bed: "hua_jing_lower", coverage: 2.16, reading: "crowded at full maturity" },
  { bed: "bed_bank_shelf", coverage: 1.8, reading: "tight at full size" },
];

test("a crowded design's row counts the beds in the worst band and names the worst", () => {
  const got = crowdedLine(OVER);
  // three of the four are in the top band; the fourth is only "tight" and is not counted
  assert.equal(got.text, "3 beds crowded at full maturity — worst hua_jing_upper 3.8×");
  // order of arrival must not matter — the worst is found, not assumed to be first
  assert.equal(crowdedLine([...OVER].reverse()).text, got.text);
  assert.equal(crowdedLine(OVER.slice(3)).text, "1 bed tight at full size — worst bed_bank_shelf 1.8×");
  // every bed is in the tooltip, because the row only has room for two
  for (const r of OVER) assert.ok(got.title.includes(r.bed), `${r.bed} missing from the tooltip`);
  assert.equal(got.title, "canopy over ground at full size — hua_jing_upper 3.8×, bed_upper_bank 3.2×, "
    + "hua_jing_lower 2.2×: crowded at full maturity; bed_bank_shelf 1.8×: tight at full size");
  assert.ok(!got.title.includes("\n"), "the app's tooltip collapses newlines into a run-on");
});

test("the band word is python's, passed through — never re-derived from the number", () => {
  // A deliberately WRONG reading: if this function ever grows its own edges it
  // will print "crowded" here, and then the list and the validator can disagree.
  const got = crowdedLine([{ bed: "b", coverage: 9.9, reading: "thin at maturity" }]);
  assert.equal(got.text, "1 bed thin at maturity — worst b 9.9×");
});

test("a design with nothing over says nothing, so its row is the one without the line", () => {
  assert.equal(crowdedLine([]), null);
  assert.equal(crowdedLine(undefined), null);
  assert.equal(crowdedLine([{ bed: "b", coverage: null, reading: "x" }]), null);
});

test("the seams: python measures, the dev server carries it, the list draws it", () => {
  const api = codeOnly(read("tools/site_api.py"));
  assert.match(api, /def cmd_crowding[\s\S]*?_agent\.bed_mature_coverage\(/,
    "crowding must use the one python metric");
  const cfg = codeOnly(read("viewer/vite.config.js"));
  assert.match(cfg, /"crowding", "--names"/, "the dev server does not ask python for crowding");
  assert.match(cfg, /meta\[name\]\.crowded = /, "the measurement never reaches the /api/designs reply");
  assert.doesNotMatch(cfg, /mature_spread_m/, "the dev server grew its own coverage arithmetic");
  const main = codeOnly(read("viewer/src/main.js"));
  assert.match(main, /crowdedLine\(m\?\.crowded\)/, "the list does not read meta.crowded");
  assert.match(main, /\.\.\.\(crowded \? \[crowded\] : \[\]\)/, "the line is built and never appended");
  assert.match(read("viewer/src/pedon.css"), /#pSide \.drow \.crowded\s*\{/, "the line has no style");
});
