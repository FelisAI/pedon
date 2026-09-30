// WHAT A MEASUREMENT LOOKS LIKE ON SCREEN — and the ONE place that decides.
//
// A project setting switches how sizes are shown, between inches and centimetres.
//
// Everything in PEDON is stored, validated and computed in METRES and none of
// that changes. This is a DISPLAY unit: the last step before a number becomes
// text. Doing that conversion inline, in dozens of places each with its own
// `toFixed`, is exactly the duplicated-vocabulary fault `tests/test_dry.py`
// exists to catch — dozens of chances for one of them to disagree the first
// time anything changes.
//
// Pure: no DOM, no fetch, no design state, so the tests run it for real.
//
// WHY FEET AND INCHES RATHER THAN BARE INCHES. A 7 m path is 276 inches,
// which is a number nobody can picture. A builder says
// "9 ft 1 in", and a riser — the one quantity this project prints in
// centimetres because metres round it away — is said in plain inches. So the
// rule is the one people actually speak: under a foot, inches; over it, feet and
// inches. Areas go to square feet, which is how paving and turf are sold.

export const SYSTEMS = ["metric", "imperial"];

const M_PER_FT = 0.3048;
const M_PER_IN = 0.0254;
const SQFT_PER_SQM = 10.763910416709722;

let system = "metric";

/** The unit system in force. */
export const units = () => system;

/** Set it. Anything unrecognised falls back to metric rather than throwing —
 *  a bad value in project.json must not take the panel down with it. */
export function setUnits(next) {
  system = SYSTEMS.includes(next) ? next : "metric";
  return system;
}

const round = (n, dp) => Number(n).toFixed(dp);

/** Number(null) and Number("") are both 0, and a design value that is missing
 *  must read as nothing rather than as a confident zero. */
function metres(value) {
  if (value === null || value === undefined || value === "") return null;
  const v = typeof value === "number" ? value : Number(value);
  return Number.isFinite(v) ? v : null;
}

/**
 * A LENGTH, from metres.
 *
 * `dp` is the metric decimal count the caller already chose — a path wants 1, a
 * calibration span wants 3 — and the imperial side picks its own precision from
 * the size of the thing, because "9 ft 1.000 in" is false precision and
 * "0.2 in" is not.
 */
export function len(value, dp = 1) {
  const v = metres(value);
  if (v === null) return "";
  if (system !== "imperial") return `${round(v, dp)} m`;
  const neg = v < 0 ? "-" : "";
  const inches = Math.abs(v) / M_PER_IN;
  // ROUND FIRST, THEN DECIDE. Choosing the branch off the raw value prints
  // 0.30479 m as "12.0 in": it is 11.999 in, so it takes the inches branch, and
  // the rounding to one decimal turns it into a twelve that should be a foot.
  // Both branches need the guard, not only the feet branch.
  const shown = Number(round(inches, inches < 2 ? 2 : 1));
  if (shown < 12) return `${neg}${round(inches, inches < 2 ? 2 : 1)} in`;
  const feet = Math.floor(shown / 12);
  const rest = Number(round(shown - feet * 12, 1));
  if (rest >= 12) return `${neg}${feet + 1} ft`;
  return rest < 0.05 ? `${neg}${feet} ft` : `${neg}${feet} ft ${round(rest, 1)} in`;
}

/**
 * A SMALL length — a riser, a leaf, a gap. Metric says centimetres because a
 * riser is a 15-18 cm quantity and metres round the difference between a
 * comfortable step and one over code straight off the screen.
 */
export function small(value, dp = 0) {
  const v = metres(value);
  if (v === null) return "";
  if (system !== "imperial") return `${round(v * 100, dp)} cm`;
  return `${round(v / M_PER_IN, 1)} in`;
}

/** AN AREA, from square metres. */
export function area(sqm, dp = 1) {
  const v = metres(sqm);
  if (v === null) return "";
  if (system !== "imperial") return `${round(v, dp)} m²`;
  const sqft = v * SQFT_PER_SQM;
  return `${round(sqft, sqft < 100 ? 1 : 0)} sq ft`;
}

/** The bare unit word, for a field label or a placeholder. */
export const lengthUnit = () => (system === "imperial" ? "ft/in" : "m");

// ── TYPING a size. A plant tag, a nursery page and a tape measure all say feet and inches, so a
// length box takes them as they are written — 2 ft 7 in, 2'7", 31 in, 2.5 ft, 2 1/2 ft — and metric
// with its unit in either system. A bare number is the unit the project speaks: feet (inches for a
// SMALL thing, a riser) in imperial, metres (centimetres, small) in metric. Anything else is refused
// with null, never read as zero.

/** "2", "2.5", ".5", "2 1/2", "1/2" -> the number, or NaN. */
function amount(s) {
  const t = String(s).trim();
  let m = t.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (m) return +m[3] ? +m[1] + +m[2] / +m[3] : NaN;
  m = t.match(/^(\d+)\/(\d+)$/);
  if (m) return +m[2] ? +m[1] / +m[2] : NaN;
  return /^(\d+(\.\d*)?|\.\d+)$/.test(t) ? Number(t) : NaN;
}

/** A typed length, in metres — or null when it is not one. */
export function parseLen(text, { small: isSmall = false } = {}) {
  if (text === null || text === undefined || (typeof text === "number" && !Number.isFinite(text))) return null;
  let s = String(text).trim().toLowerCase()
    .replace(/[′’‘`]/g, "'").replace(/[″”“]/g, '"').replace(/''/g, '"');
  if (!s) return null;
  const neg = s.startsWith("-");
  if (neg) s = s.slice(1).trim();
  const out = v => (Number.isFinite(v) ? (neg ? -v : v) : null);
  let m = s.match(/^(.+?)\s*(mm|cm|m|metres?|meters?)$/);
  if (m) {
    const v = amount(m[1]);
    return out(m[2] === "mm" ? v / 1000 : m[2] === "cm" ? v / 100 : v);
  }
  let feet = 0, inches = 0, any = false;
  m = s.match(/^(.+?)\s*(?:ft|feet|foot|')\s*(.*)$/);
  if (m) {
    feet = amount(m[1]);
    if (!Number.isFinite(feet)) return null;
    any = true; s = m[2].trim();
  }
  if (s) {
    const withUnit = s.match(/^(.+?)\s*(?:in|inch|inches|")$/);
    const v = amount(withUnit ? withUnit[1] : s);
    if (!Number.isFinite(v)) return null;
    if (withUnit || any) inches = v;                    // after feet, a bare number is inches
    else if (system !== "imperial") return out(isSmall ? v / 100 : v);
    else if (isSmall) inches = v; else feet = v;
    any = true;
  }
  return any ? out(feet * M_PER_FT + inches * M_PER_IN) : null;
}

/** A length as it stands in a text box, for the owner to edit: "2 ft 7.5 in" or "0.8". Metric keeps
 *  the bare number the box has always held; imperial adds a decimal inch so it reads back true. */
export function lenField(value) {
  const v = metres(value);
  if (v === null) return "";
  if (system !== "imperial") return String(Number(round(v, 3)));
  const neg = v < 0 ? "-" : "";
  const inches = Math.round(Math.abs(v) / M_PER_IN * 10) / 10;
  if (inches < 12) return `${neg}${inches} in`;
  const feet = Math.floor(inches / 12), rest = Math.round((inches - feet * 12) * 10) / 10;
  return rest ? `${neg}${feet} ft ${rest} in` : `${neg}${feet} ft`;
}

/** A plant's or an object's size, "h × w": metric as it always read ("0.8 × 0.9 m"); imperial in feet
 *  and inches, as a plant tag gives it. */
export function pair(a, b) {
  const x = metres(a), y = metres(b);
  if (x === null || y === null) return "";
  return system === "imperial" ? `${wholeInches(x)} × ${wholeInches(y)}` : `${x} × ${y} m`;
}

/** ONE plant or object size as a tag gives it: "2 ft 7 in" in imperial, "0.8 m" as it always read. */
export function size(value) {
  const v = metres(value);
  if (v === null) return "";
  return system === "imperial" ? wholeInches(v) : `${v} m`;
}

/** A PLANT'S size in feet and whole inches — a tag says "2 to 3 ft", and a tenth of an inch on a
 *  mature size is precision nobody has. Rounded first, so 11.8 in is "1 ft", never "12 in". */
function wholeInches(v) {
  const neg = v < 0 ? "-" : "", inches = Math.round(Math.abs(v) / M_PER_IN);
  if (inches < 12) return `${neg}${inches} in`;
  const feet = Math.floor(inches / 12), rest = inches - feet * 12;
  return rest ? `${neg}${feet} ft ${rest} in` : `${neg}${feet} ft`;
}

/** A sourced range, "lo–hi", in the project's unit. */
export function span(lo, hi) {
  const x = metres(lo), y = metres(hi);
  if (x === null || y === null) return "";
  return system === "imperial" ? `${wholeInches(x)}–${wholeInches(y)}` : `${x}–${y} m`;
}
