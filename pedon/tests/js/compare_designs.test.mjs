// node --test tests/js/compare_designs.test.mjs
//
// The Designs panel must let the user compare versions, not just filenames.
//
// A collection of 65 designs includes four versions of the same
// border — huajing_A_asis, huajing_B_smaller, huajing_C_split, huajing_D_drift —
// and choosing between them is the whole reason they exist.
//
// The eye on a row ghosts that design behind the working one. The comparison
// table uses the SAME selection, so there
// is no second mode to learn.
import { needsSite } from "./lib/site.mjs";   // about a real site
import { resolvePath } from "../../viewer/project_paths.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { measureDesign, compareTable, diffText, coverageNote, FIELDS }
  from "../../viewer/src/shell/compare.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = f => fs.readFileSync(resolvePath(f), "utf8");   // data/… is the active site's
const design = n => JSON.parse(read(`data/designs/${n}.json`));

// a 10 x 10 bed with four 2 m-spread plants in it: canopy 4 * pi = 12.57 m2 over
// 100 m2, so coverage is 0.13 and every number below is checkable by hand
const SIMPLE = {
  beds: [{ id: "b", polygon: [[0, 0], [10, 0], [10, 10], [0, 10]] }],
  paths: [{ id: "p", spline: [[0, 0], [0, 10]], width_m: 1 }],
  patios: [{ id: "q", polygon: [[0, 0], [4, 0], [4, 5], [0, 5]] }],
  plants: Array.from({ length: 4 }, (_, i) => ({ id: `p${i}`, species: i < 3 ? "Salvia apiana" : "Thymus vulgaris", mature_spread_m: 2 })),
  objects: [{ id: "lantern", kind: "stone lantern" }],
};

test("every figure is checkable by hand", () => {
  const m = measureDesign(SIMPLE);
  assert.equal(m.plants, 4);
  assert.equal(m.species, 2, "three salvias and one thyme is two species");
  assert.equal(m.bed_m2, 100);
  assert.equal(m.hard_m2, 30, "a 20 m² patio plus 10 m of 1 m path");
  assert.equal(m.path_m, 10);
  assert.equal(m.coverage, 0.13, "4 x pi x 1² over 100 m²");
  assert.equal(m.objects, 1);
});

test("COVERAGE IS AT MATURE SIZE, never at the size the viewer draws", () => {
  // coverage goes as the SQUARE of growth scale, so the viewer's default 0.70
  // renders a healthy 1.83x at 0.90x and it reads as thin. A model judging a
  // garden 30% smaller than the one that gets built spaces it wrong.
  const m = measureDesign(SIMPLE);
  const asDrawn = measureDesign({ ...SIMPLE,
    plants: SIMPLE.plants.map(p => ({ ...p, mature_spread_m: p.mature_spread_m * 0.7 })) });
  assert.ok(asDrawn.coverage < m.coverage / 1.9,
    "the fixture does not distinguish mature from drawn — pick another");
  assert.equal(m.coverage, 0.13, "measureDesign is scaling the spread it was given");
});

test("no beds is not zero coverage", () => {
  // a number invented for an empty denominator is the kind of fiction that ends
  // up quoted back as a fact
  const m = measureDesign({ plants: [{ mature_spread_m: 2 }], patios: [], paths: [] });
  assert.equal(m.coverage, null);
  assert.equal(measureDesign({}).plants, 0);
  assert.equal(measureDesign(undefined).coverage, null);
});

test("the difference is against the design you are EDITING", () => {
  const t = compareTable([
    { name: "working", doc: SIMPLE },
    { name: "other", doc: { ...SIMPLE, plants: SIMPLE.plants.slice(0, 2) } },
  ]);
  const plants = t.rows.find(r => r.key === "plants");
  assert.equal(plants.values[0].diff, null, "the base column shows a difference from itself");
  assert.equal(plants.values[1].diff, -2);
  assert.equal(diffText(-2), "−2");
  assert.equal(diffText(0.05, "×"), "+0.05×");
  assert.equal(diffText(0), "", "zero is not a difference worth printing");
  assert.equal(diffText(null), "");
});

test("a missing measurement produces no difference rather than a fake one", () => {
  const t = compareTable([
    { name: "no beds", doc: { plants: [{ mature_spread_m: 2 }] } },
    { name: "has beds", doc: SIMPLE },
  ]);
  const cov = t.rows.find(r => r.key === "coverage");
  assert.equal(cov.values[0].value, null);
  assert.equal(cov.values[1].diff, null, "a difference was computed against nothing");
});

test("it REPORTS and does not grade", () => {
  // Physical facts are enforced, taste is only ever reported. A table that
  // ranked these would be a grade, and a number in a brief is a restriction
  // wherever it is written down.
  const src = read("viewer/src/shell/compare.js");
  for (const banned of [/\bscore\b/i, /\bbetter\b/i, /\bworse\b/i, /\bbest\b/i, /\brank\b/i,
                        /\bgrade[ds]?\b/i])
    assert.ok(!new RegExp(banned.source, banned.flags).test(
      src.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n")),
      `compare.js grades a design: ${banned}`);
  for (const f of FIELDS) assert.ok(f.label && !/good|bad|ideal/i.test(f.label));
});

test("it uses the shoelace that already has a home", () => {
  // Shared geometry functions prevent duplicate implementations from disagreeing.
  const src = read("viewer/src/shell/compare.js");
  assert.match(src, /import \{ polygonArea \} from "\.\.\/areas\.js"/);
  assert.ok(!/x1 \* y2/.test(src), "compare.js hand-rolled a second shoelace");
});

test("THE REAL FOUR: it tells huajing A, B, C and D apart", needsSite, () => {
  // the fixture I author can only confirm what I already believe, so this
  // reads the designs the owner is actually choosing between
  const names = ["huajing_A_asis", "huajing_B_smaller", "huajing_C_split", "huajing_D_drift"];
  const t = compareTable(names.map(n => ({ name: n, doc: design(n) })));
  assert.equal(t.cols.length, 4);
  const plants = t.rows.find(r => r.key === "plants").values.map(v => v.value);
  assert.equal(new Set(plants).size, 4, `all four report the same plant count: ${plants}`);
  const cov = t.rows.find(r => r.key === "coverage").values.map(v => v.value);
  for (const c of cov) assert.ok(c > 1 && c < 3, `coverage ${c} is not a real number for this border`);
  // and the differences point the right way: D has fewer plants than C
  const d = t.rows.find(r => r.key === "plants").values[3].diff;
  assert.ok(d > 0, "D is reported as having fewer plants than A, which is backwards");
});

test("the panel actually shows it, and the counts come from the server", () => {
  const main = read("viewer/src/main.js")
    .split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.match(main, /renderCompare\(\)/, "nothing draws the comparison");
  assert.match(main, /compareTable\(/, "the panel does not use the shared measurement");
  assert.match(main, /designMeta\?\.\[name\]/, "rows do not carry what is in the design");
  assert.match(read("viewer/index.html"), /id="designCompare"/);
  // and the cached documents are dropped when a variant is overwritten, or the
  // table goes on measuring the version the user replaces
  // BOTH BRANCHES: `comparedDocs.clear()` in the else branch does not verify
  // the per-name drop. Asserting that a token is present is not asserting
  // that the behaviour holds.
  const at = main.indexOf("const invalidateVariant");
  const inv = main.slice(at, main.indexOf("\n\n", at));
  assert.ok(inv.length < 400, "invalidateVariant did not end where expected");
  assert.match(inv, /comparedDocs\.delete\(name\)/, "overwriting one variant leaves its "
    + "document cached, so the table keeps measuring the version the user replaces");
  assert.match(inv, /comparedDocs\.clear\(\)/, "clearing every variant leaves the cache");
  // the server counts, cached on mtime: 65 documents on every poll is a storm
  const cfg = read("viewer/vite.config.js");
  assert.match(cfg, /designCounts/, "the designs endpoint says nothing about the designs");
  assert.match(cfg, /counts\._stamp !== stamp/,
    "the cache stamp is stored but never COMPARED, so every request reparses 65 files");
});

test("the coverage number is READ OUT, because the number alone is not usable", () => {
  // Coverage under 1.0 at maturity is thin; over ~1.3 knits. A border over 2x
  // represents a five-year picture that needs thinning at eight to ten years.
  // The user needs that explanation when choosing between border versions.
  assert.match(coverageNote(0.8), /thin/);
  assert.match(coverageNote(1.1), /closes/);
  assert.match(coverageNote(1.45), /knits/);
  assert.match(coverageNote(1.8), /tight/);
  // Describe crowding at full maturity without assuming it is intentional.
  assert.match(coverageNote(2.4), /crowded at full maturity/);
  assert.doesNotMatch(coverageNote(2.4), /on purpose|five-year/);
  assert.equal(coverageNote(null), null, "no beds is not a density to describe");
  assert.equal(coverageNote(undefined), null);
  // the bands must actually SPLIT — one sentence for every number would say nothing
  assert.equal(new Set([0.8, 1.1, 1.45, 1.8, 2.4].map(coverageNote)).size, 5);
});

test("the table and the validator read crowding off the SAME band edges", () => {
  // agent.MATURE_COVERAGE_BANDS is what check-ops warns with; two copies of the
  // edges would let the panel say "knits" about a bed the validator calls crowded
  const out = execFileSync("python3", ["-c",
    "import sys,json;sys.path.insert(0,'tools');import agent;print(json.dumps(agent.MATURE_COVERAGE_BANDS))"],
    { cwd: ROOT, encoding: "utf8" });
  const bands = JSON.parse(out);
  const edges = bands.map(b => b[0]).filter(e => e !== null);
  for (const e of edges) {
    const below = coverageNote(e - 0.001), at = coverageNote(e);
    assert.notEqual(below, at, `python has a band edge at ${e} that the table does not split at`);
  }
  for (const [edge, word] of bands) {
    const probe = edge === null ? edges[edges.length - 1] + 0.5 : edge - 0.01;
    const first = word.split(/[ ,]/)[0];
    assert.match(coverageNote(probe), new RegExp(first), `below ${edge} python says "${word}", the table says "${coverageNote(probe)}"`);
  }
});

test("the reading is a measurement explained, not a verdict", () => {
  // "thin" and "knits" are what the plants physically DO at that
  // density — the same category as a grade percentage or a fall in metres
  for (const c of [0.5, 1.0, 1.5, 3.0]) {
    const n = coverageNote(c) ?? "";
    for (const banned of [/\bbetter\b/i, /\bworse\b/i, /\bbest\b/i, /\bgood\b/i,
                          /\bbad\b/i, /\bshould\b/i, /\bwrong\b/i])
      assert.ok(!banned.test(n), `coverageNote(${c}) passes judgement: "${n}"`);
  }
});

test("the panel shows the reading, not just the row", () => {
  const main = read("viewer/src/main.js")
    .split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.match(main, /coverageNote\(/, "nothing reads the coverage number out");
  assert.match(main, /cmp-reading/, "there is nowhere for it to appear");
});
