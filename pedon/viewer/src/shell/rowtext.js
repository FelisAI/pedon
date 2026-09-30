// What ONE ROW in the objects list says.
//
// One owner, both callers — main.js and the review sheet. Two copies drift, and a
// sheet that builds its own row shape reviews itself while the shipped one goes
// unlooked at: the duplicated-vocabulary fault, one level down from the surfaces
// table.
//
// Rows show what a thing IS — a bed's area, a path's length — rather than only
// its id. So the two halves are:
//
//   the NAME    what a person would call it. `p23` is not a name and
//               "Pink muhly grass" is; `bank_bed` already is one, and a
//               garden object's `kind` is free text ("water basin"), which is
//               the best name it has.
//   the MEASURE what you would buy, in the dim column beside it — and, where
//               the name is not unique (a drift of Pink muhly grass), the id
//               that tells two of them apart.
//
// Pure. No DOM, no THREE, no design state.
import { polygonArea } from "../areas.js";
// The ONE owner of what a measurement looks like on screen. `m()` below is a
// thin alias of it, so every row follows the project's unit setting without
// each caller knowing about it.
import { len, small, area as areaText } from "./units.js";

/** Length along a polyline, in metres. */
export const polyLen = pts => (pts ?? []).reduce((s, p, i) =>
  i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0, 0);

const m = n => len(n, 1);

/**
 * Plural of a kind, for a section heading.
 *
 * `kind + "s"` gives "stepss". English is a lookup, not a rule.
 */
const PLURAL = { patio: "patios", bed: "beds", path: "paths", steps: "steps",
                 edge: "edges", object: "objects", plant: "plants" };
export const kindPlural = k => PLURAL[k] ?? `${k}s`;

/** The label a person reads. Never an opaque id when a name exists. */
export function rowLabel(o, kind) {
  if (kind === "plant") return o?.common ?? o?.species ?? o?.id ?? "";
  if (kind === "object") return o?.kind ?? o?.id ?? "";   // free text: "water basin"
  return o?.id ?? "";
}

/**
 * The measured fact beside the name — and the id when the name does not
 * identify one thing.
 *
 * Deliberately SHORT: the panel is 296 px and every one of these truncates at
 * full width. Material, purpose and the rest are the inspector's job.
 */
export function rowMeta(o, kind) {
  if (!o) return "";
  if (kind === "path")  return `${m(polyLen(o.spline))} · ${m(o.width_m)} wide`;
  if (kind === "edge")  return `${m(polyLen(o.spline))} · ${m(o.height_m)} high`;
  // CENTIMETRES. A riser is a 15-18 cm quantity and `toFixed(1)` prints every
  // one of them as "0.1 m" or "0.2 m" — the difference between a comfortable
  // step and one over the code limit, rounded away on screen. It is also what a
  // builder says.
  if (kind === "steps") return `${m(polyLen(o.spline))}${o.riser_m == null ? ""
    : ` · ${small(o.riser_m)} risers`}`;
  if (kind === "bed" || kind === "patio")
    return areaText(polygonArea(o.polygon ?? []), 1);
  if (kind === "plant")
    return `${o.id} · ${o.mature_height_m == null ? "?" : m(o.mature_height_m)}`;
  if (kind === "object")
    return `${o.id}${o.height_m == null ? "" : ` · ${m(o.height_m)}`}`;
  return o.id ?? "";
}

/** One row's text, from the stored object. */
export function rowOf(o, kind) {
  return { id: o.id, kind, name: rowLabel(o, kind), meta: rowMeta(o, kind) };
}

/**
 * WHICH BEDS OF A SAVED DESIGN ARE CROWDED WHEN GROWN, as one line for its row
 *. `over` comes from /api/designs — python's bed_mature_coverage, beds at
 * or past the 1.6x the validator warns from, most crowded first. The READING is
 * python's own word for the band and is passed through, never re-derived: a second
 * set of edges here is how the compare table and the validator would disagree.
 *
 * COUNTS the beds in the worst band and names the worst one. Listed
 * most-crowded-first, every variant of one border begins with the same bed
 * (`upper_bed 3.2×`) and runs off the edge, so the rows read alike. The count is
 * what differs between them.
 */
export function crowdedLine(over) {
  const rows = (over ?? []).filter(r => r && r.bed && Number.isFinite(r.coverage))
    .sort((p, q) => q.coverage - p.coverage);
  if (!rows.length) return null;
  const band = rows[0].reading ?? "crowded when grown";
  const n = rows.filter(r => (r.reading ?? band) === band).length;
  return {
    text: `${n} bed${n > 1 ? "s" : ""} ${band} — worst ${rows[0].bed} ${rows[0].coverage.toFixed(1)}×`,
    // ONE sentence, grouped by band: shell/tooltip.js collapses newlines, and a line
    // per bed comes out as a run-on in the app
    title: "canopy over ground at full size — " + [...new Set(rows.map(r => r.reading ?? band))]
      .map(b => `${rows.filter(r => (r.reading ?? band) === b)
        .map(r => `${r.bed} ${r.coverage.toFixed(1)}×`).join(", ")}: ${b}`).join("; "),
  };
}
