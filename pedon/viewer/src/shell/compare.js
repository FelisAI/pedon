// Comparing two designs, in numbers.
//
// A list of filenames does not explain the differences between designs.
// Measurements help the user choose between versions of the same planting.
//
// The eye on a row ghosts that design behind the working one, onion-skin.
// Numerical comparisons complement that view with measurements:
//
//   MATURE COVERAGE — leaf area over bed area — is the one that decides whether a
//   planting knits. Under 1.0 at maturity is thin, over ~1.3 knits (CLAUDE.md).
//   And it is measured at MATURE size, never at the ~5-year scale the viewer
//   draws, because a garden judged 30% smaller than the one that gets built is
//   spaced wrong.
//
//   SPECIES COUNT against plant count. 27 species for 32 plants means little
//   repetition, but it is REPORTED, never graded: a number in a brief is a
//   restriction wherever it is written down.
//
// Every figure here is a measurement of the document, not a score. This file
// must never grade a design; taste is reported and only
// physical facts are enforced.
//
// Pure. It is handed loaded design documents and returns rows.
import { polygonArea } from "../areas.js";
import { polyLen } from "./rowtext.js";

const sum = (xs, f) => (xs ?? []).reduce((s, x) => s + (f(x) || 0), 0);

/** Everything measurable about one design document. */
export function measureDesign(d) {
  const plants = d?.plants ?? [];
  const bedArea = sum(d?.beds, b => polygonArea(b.polygon ?? []));
  const patioArea = sum(d?.patios, p => polygonArea(p.polygon ?? []));
  const pathArea = sum(d?.paths, p => polyLen(p.spline) * (+p.width_m || 0));
  const pathLen = sum(d?.paths, p => polyLen(p.spline));
  // MATURE, never the drawn ~5-year size: coverage goes as the SQUARE of growth
  // scale, so a healthy 1.83x renders at 0.90x and reads as thin.
  const canopy = sum(plants, p => Math.PI * Math.pow((+p.mature_spread_m || 0) / 2, 2));
  const species = new Set(plants.map(p => String(p.species ?? "").trim().toLowerCase())
                                .filter(Boolean));
  const planted = bedArea || (patioArea + pathArea);   // no beds: coverage is meaningless
  return {
    plants: plants.length,
    species: species.size,
    beds: (d?.beds ?? []).length,
    paths: (d?.paths ?? []).length,
    objects: (d?.objects ?? []).length,
    bed_m2: +bedArea.toFixed(1),
    hard_m2: +(patioArea + pathArea).toFixed(1),
    path_m: +pathLen.toFixed(1),
    // null rather than Infinity or 0: "no beds" is not "zero coverage", and a
    // number invented for an empty denominator is the kind of fiction that ends
    // up quoted back as a fact
    coverage: bedArea > 0 ? +(canopy / bedArea).toFixed(2) : null,
    per_plant_m2: plants.length && planted ? +(planted / plants.length).toFixed(2) : null,
  };
}

/** How the rows are labelled and which way a difference points. */
export const FIELDS = [
  { key: "plants", label: "plants" },
  { key: "species", label: "species" },
  { key: "coverage", label: "mature coverage", suffix: "×", explain: coverageNote,
    note: "leaf area over bed area, at MATURE size. Under 1.0 is thin, over ~1.3 "
        + "knits, over ~2 is a five-year picture that wants thinning later." },
  // `unit`: shown in the project's unit (units.js) — square feet and feet in imperial
  { key: "per_plant_m2", label: "ground per plant", suffix: " m²", unit: "area" },
  { key: "bed_m2", label: "planted", suffix: " m²", unit: "area" },
  { key: "hard_m2", label: "paving", suffix: " m²", unit: "area" },
  { key: "path_m", label: "path", suffix: " m", unit: "length" },
  { key: "objects", label: "objects" },
];

/**
 * One table: a row per measurement, a column per design.
 *
 * `designs` is [{name, doc}] with the one being EDITED first. The difference is
 * against that first column, so the user can compare saved designs with the
 * one they are editing.
 */
export function compareTable(designs) {
  const cols = (designs ?? []).filter(d => d?.doc).map(d => ({
    name: d.name, measured: measureDesign(d.doc),
  }));
  if (!cols.length) return { cols: [], rows: [] };
  const base = cols[0].measured;
  const rows = FIELDS.map(f => ({
    ...f,
    values: cols.map((c, i) => {
      const v = c.measured[f.key];
      const b = base[f.key];
      // a difference against a column that has no number is not a difference
      const diff = i === 0 || v === null || b === null || b === undefined ? null
                 : +(v - b).toFixed(2);
      return { value: v, diff };
    }),
  }));
  return { cols, rows };
}

/**
 * WHAT A COVERAGE NUMBER MEANS, in a sentence.
 *
 * The number alone is not usable. Under 1.0 at maturity is thin, over ~1.3 knits
 * (CLAUDE.md); these bands describe whether the planting fills the ground.
 * The top of the range matters too: a border at over 2x mature coverage is
 * dense at five years and crowded once fully grown.
 * The design is spaced for FULL maturity; the reading says so.
 *
 * This REPORTS a measurement, it does not grade a design. "thin" and "knits" are
 * what the plants physically do at that density — the same category as a grade
 * percentage or a fall in metres, rather than a judgement of taste.
 */
export function coverageNote(coverage) {
  if (coverage === null || coverage === undefined) return null;
  // the same edges as agent.MATURE_COVERAGE_BANDS — held in step by
  // tests/js/compare_designs.test.mjs, so the table and the validator agree
  if (coverage < 1.0)
    return "thin at maturity — ground shows between the plants even when they are full grown";
  if (coverage < 1.3) return "closes, just";
  if (coverage < 1.6) return "knits";
  if (coverage < 2.0) return "tight at full size — neighbours overlap heavily once grown";
  // A design is spaced for full size; over 2x coverage is crowded at maturity.
  return "crowded at full maturity — plants will be growing into each other and some will have to come out";
}

/** "+0.72×" / "-24" — a signed difference, or "" when there is nothing to say. */
export function diffText(diff, suffix = "") {
  if (diff === null || diff === undefined || diff === 0) return "";
  return `${diff > 0 ? "+" : "−"}${Math.abs(diff)}${suffix}`;
}
