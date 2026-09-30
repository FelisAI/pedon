// node --test tests/js/
//
// A project setting switches how sizes are shown between metric and imperial.
//
// Metres remain the only thing stored, validated or computed; this is the last
// step before a number becomes text. It is run for real rather than scanned,
// because a formatter is exactly the kind of pure function whose tests pass with
// the call site deleted — the wiring is pinned separately, below.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { units, setUnits, len, small, area, lengthUnit } from
  "../../viewer/src/shell/units.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("metric is the default, and it is unchanged from what shipped", () => {
  setUnits("metric");
  assert.equal(units(), "metric");
  assert.equal(len(7.24), "7.2 m");
  assert.equal(len(0.65, 2), "0.65 m");
  assert.equal(small(0.17), "17 cm");        // a riser, in the unit a builder says
  assert.equal(area(16.9), "16.9 m²");
  assert.equal(lengthUnit(), "m");
});

test("imperial gives feet and inches, not 276 inches", () => {
  // inches alone fail for long lengths: a 7 m path is 276 in, which nobody can picture
  setUnits("imperial");
  assert.equal(len(7.24), "23 ft 9.0 in");
  assert.equal(len(0.30), "11.8 in");         // under a foot stays in inches
  assert.equal(small(0.17), "6.7 in");
  setUnits("metric");
});

test("it never prints twelve inches", () => {
  // 0.3047 m is a hair under a foot and rounds to "0 ft 12.0 in" without care
  setUnits("imperial");
  assert.equal(len(0.30479), "1 ft");
  assert.equal(len(2.7431), "9 ft");          // exactly 9 ft, no trailing 0.0 in
  setUnits("metric");
});

test("areas go to square feet, which is how paving is sold", () => {
  setUnits("imperial");
  assert.equal(area(16.9), "182 sq ft");
  assert.equal(area(4.0), "43.1 sq ft");      // small areas keep a decimal
  setUnits("metric");
});

test("a negative length keeps its sign", () => {
  setUnits("imperial");
  assert.equal(len(-0.5), "-1 ft 7.7 in");    // 19.7 in is over a foot
  setUnits("metric");
});

test("junk in never throws, and never renders as NaN", () => {
  // this runs on live design values; one undefined must not take the panel down
  for (const sys of ["metric", "imperial"]) {
    setUnits(sys);
    for (const bad of [undefined, null, NaN, "", {}]) {
      assert.equal(len(bad), "", `len(${String(bad)}) in ${sys}`);
      assert.equal(area(bad), "", `area(${String(bad)}) in ${sys}`);
      assert.equal(small(bad), "", `small(${String(bad)}) in ${sys}`);
    }
  }
  setUnits("metric");
});

test("an unrecognised system falls back to metric instead of throwing", () => {
  // it is read out of project.json, and a bad value there must not break the panel
  assert.equal(setUnits("cubits"), "metric");
  assert.equal(len(1), "1.0 m");
});

test("there is ONE owner of this conversion", () => {
  // inline conversions, each with its own toFixed, drift apart; the rule this
  // file is here to keep is that no second one appears
  const units = fs.readFileSync(path.join(ROOT, "viewer", "src", "shell", "units.js"), "utf8");
  for (const f of ["0.3048", "0.0254"]) {
    const hits = fs.readdirSync(path.join(ROOT, "viewer", "src", "shell"))
      .filter(n => n.endsWith(".js") && n !== "units.js")
      .filter(n => fs.readFileSync(path.join(ROOT, "viewer", "src", "shell", n), "utf8").includes(f));
    assert.deepEqual(hits, [], `${f} is defined a second time in ${hits.join(", ")}`);
  }
  assert.ok(units.includes("M_PER_FT") && units.includes("M_PER_IN"));
});


// ── the wiring. A pure function's tests pass with every call site deleted — a
// pure function is half a guard. ─────────────────────────────────────────────
test("the row text asks the formatter rather than writing its own m", () => {
  const rowtext = fs.readFileSync(path.join(ROOT, "viewer", "src", "shell", "rowtext.js"), "utf8");
  assert.match(rowtext, /from "\.\/units\.js"/, "rowtext.js does not import the formatter");
  assert.doesNotMatch(rowtext, /toFixed\(1\)\} m`/,
    "rowtext.js still formats metres itself, so the setting cannot reach the rows");
  assert.doesNotMatch(rowtext, /m²`/, "a bed area is still hard-coded to square metres");
});

test("the setting is read at boot and written back to the PROPERTY", () => {
  const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
  assert.match(main, /function restoreUnits\(\)/, "nothing reads the setting at boot");
  assert.match(main, /setUnits\(doc\?\.units\)/, "boot does not apply what the project says");
  assert.match(main, /getElementById\("projUnits"\)\?\.addEventListener\("change"/,
    "the control has markup but no handler");
  const html = fs.readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");
  assert.match(html, /id="projUnits"/, "no control on screen to change it");
});

test("saving the project MERGES, so renaming cannot reset the units", () => {
  // the lost update updateDesign() and updateSite() already guard against, in
  // the third file: a handler writing {name, named_on} as the whole document
  // would wipe every other setting
  const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
  assert.match(main, /async function updateProject\(/, "no merging writer for project.json");
  assert.match(main, /const next = \{ \.\.\.onDisk, \.\.\.patch \}/,
    "the project write is not a merge onto what is on disk");
  // anchored on the HANDLER: the first `getElementById("projName")` in the file
  // is renderProject filling the field in, and slicing from there proves nothing
  const i = main.indexOf('getElementById("projName")?.addEventListener');
  assert.notEqual(i, -1, "the rename handler moved; fix this test");
  assert.match(main.slice(i, i + 500), /updateProject\(/,
    "renaming the property still writes a snapshot over project.json");
});


// ── TYPING a size. Reading feet is half of it: a plant tag says "2 to 3 ft", a nursery page "3-4 feet",
// and the owner types what the tag says. Every length box takes feet and inches as they are written.
import { parseLen, lenField } from "../../viewer/src/shell/units.js";
const near = (a, b, tol = 0.0005) => assert.ok(a !== null && Math.abs(a - b) < tol, `${a} is not ${b}`);

test("feet and inches are read the ways they are written", () => {
  setUnits("imperial");
  for (const s of ["2 ft 7 in", "2ft 7in", "2ft7in", "2' 7\"", "2'7\"", "2'7", "2 ft 7", "2’ 7”", "31 in", "31\"", "31 inches"])
    near(parseLen(s), 31 * 0.0254);
  near(parseLen("2.5 ft"), 0.762);
  near(parseLen("2 1/2 ft"), 0.762);
  near(parseLen("3'"), 0.9144);
  near(parseLen("1/2 in"), 0.0127);
  near(parseLen("-6 in"), -0.1524);
  setUnits("metric");
});

test("a bare number is the unit the project speaks: feet, or inches for a small thing, or metres", () => {
  setUnits("imperial");
  near(parseLen("3"), 0.9144);                  // a plant tag's "3" is feet
  near(parseLen("7", { small: true }), 0.1778); // a riser's "7" is inches
  setUnits("metric");
  near(parseLen("0.8"), 0.8);
  near(parseLen("17", { small: true }), 0.17);  // centimetres, as `small` prints them
});

test("metric with its unit is read in either system", () => {
  for (const sys of ["metric", "imperial"]) {
    setUnits(sys);
    near(parseLen("0.8 m"), 0.8); near(parseLen("80 cm"), 0.8); near(parseLen("800mm"), 0.8);
  }
  setUnits("metric");
});

test("what is shown reads back as what was stored, to a twentieth of an inch", () => {
  setUnits("imperial");
  for (const v of [0.05, 0.17, 0.3048, 0.62, 0.8, 0.9, 1.3, 2.4, 7.24]) {
    near(parseLen(lenField(v)), v, 0.0254 / 20);
  }
  setUnits("metric");
  for (const v of [0.05, 0.8, 7.24]) near(parseLen(lenField(v)), v, 0.005);
});

test("junk is refused, never read as zero", () => {
  setUnits("imperial");
  for (const bad of ["", "   ", "ft", "abc", "2-3 ft", "2 ft 7 in 3", "1/0 in", null, undefined, NaN])
    assert.equal(parseLen(bad), null, `"${bad}" was read as a length`);
  setUnits("metric");
});

import { pair, span } from "../../viewer/src/shell/units.js";
test("a plant's size and its sourced range read as a tag does", () => {
  setUnits("metric");
  assert.equal(pair(0.8, 0.9), "0.8 × 0.9 m");           // metric reads as it always did
  assert.equal(span(0.6, 1.2), "0.6–1.2 m");
  setUnits("imperial");
  assert.equal(pair(0.8, 0.9), "2 ft 7 in × 2 ft 11 in");   // a tag has no tenths of an inch
  assert.equal(pair(0.3, 0.6), "1 ft × 2 ft");                // 11.8 in rounds up to a foot — never "12 in"
  assert.equal(span(0.6, 1.2), "2 ft–3 ft 11 in");
  assert.equal(span(0.6096, 0.9144), "2 ft–3 ft");       // "2 to 3 feet", as a plant tag says
  assert.equal(pair(null, 0.9), "");
  setUnits("metric");
});

test("the plant cards, the measure tool, the drag readout and the typed boxes ask the formatter", () => {
  // the setting once reached only the object rows; these wrote their own metres and no box took feet
  const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
  for (const [bad, where] of [[/× \$\{e\.mature_spread_m\} m`/, "the Add library's plant size"],
                              [/mature range \$\{e\.mature_height_range_m\.join/, "a plant's sourced range"],
                              [/\["across", `\$\{r\.plan_m\.toFixed/, "the measure tool"],
                              [/m spread · /, "a plant's selection line"],
                              [/toFixed\(2\)\} m east/, "the drag readout"],
                              [/m² total/, "the selection's total"]])
    assert.doesNotMatch(main, bad, `${where} still writes its own metres`);
  assert.match(main, /parseLen\(input\.value, \{ small: smallLen \}\)/, "the properties panel does not read feet and inches");
  assert.match(main, /parseLen\(document\.getElementById\("opHeight"\)\.value\)/, "a photo's size box does not read feet and inches");
  const html = fs.readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");
  assert.doesNotMatch(html, /type="number" id="op(Height|Spread)"/, "a number box cannot take \"2 ft 7 in\"");
});

import { size } from "../../viewer/src/shell/units.js";
test("one plant size reads as a tag gives it, and metric is unchanged", () => {
  setUnits("imperial");
  assert.equal(size(0.8), "2 ft 7 in");
  assert.equal(size(0.3), "1 ft");
  setUnits("metric");
  assert.equal(size(0.8), "0.8 m");
  assert.equal(size(null), "");
});

test("an extension is handed the project's unit, not left to write metres", () => {
  const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
  assert.match(main, /ui: \(\) => \(\{ log: \(msg, level\) => log\(msg, level\), size: plantSize, pair: sizePair,\s+parseLen, lenField, lengthUnit \}\)/,
    "the ui capability no longer carries the formatter");
});

