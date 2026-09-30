/**
 * What hour the garden is lit at.
 *
 * A hard-coded direction — `LEGACY_SUN`, which lighting.js itself describes as
 * arbitrary, not a measurement — sits at altitude 47.969 deg and bearing
 * 123.690 deg. The photogrammetry plate that fills most of every eye-level shot
 * was captured at a real hour, under a sun somewhere else in the sky. Lit from
 * the legacy direction, the analytic light and the photograph it stands on
 * disagree, often by tens of degrees, and the design's shadows fall one way
 * while the scan's baked-in shadows fall another.
 *
 * `setSunFromAzimuthAltitude` in lighting.js does the lighting. This module is
 * the other half — where the clock comes from — and it is deliberately tiny and
 * pure so it can be tested without a browser.
 *
 * The solar arithmetic is NOT here. It is `tools/sun.py`, reached through
 * `GET /api/sun`, because one solar model is the whole point: a second one
 * transcribed into JavaScript would drift and disagree with the first.
 */

/** Scaniverse writes "Scaniverse 2025-06-14 093012.glb" — date and LOCAL clock. */
const CAPTURE_STAMP = /(\d{4})-(\d{2})-(\d{2})[ _T-]+(\d{2})(\d{2})(\d{2})?/;

/**
 * The date and local time a capture was taken, read off its own filename.
 *
 * Returns `{ date: "2025-06-14", time: "09:30" }` or null when the reference
 * carries no stamp. Null is a real answer and the caller falls back to "now" —
 * guessing an hour would put the garden under a sun that never shone on it.
 *
 * Rejects impossible clock values rather than passing them to the solar model,
 * because a stamp is only a filename convention and a file can be called
 * anything.
 */
export function captureSunTime(ref) {
  const m = CAPTURE_STAMP.exec(String(ref ?? ""));
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m;
  const Y = +y, MO = +mo, D = +d, H = +hh, MI = +mm;
  if (MO < 1 || MO > 12 || D < 1 || D > 31) return null;
  if (H > 23 || MI > 59) return null;
  // a real calendar day, not just plausible digits: 2026-02-31 is not a date
  const probe = new Date(Y, MO - 1, D);
  if (probe.getMonth() !== MO - 1 || probe.getDate() !== D) return null;
  return { date: `${y}-${mo}-${d}`, time: `${hh}:${mm}` };
}

/**
 * The UTC offset, in hours, that this browser's own zone had on that date.
 *
 * DERIVED, never tabled: the Pacific coast is -7 in August and -8 in December, and a
 * hard-coded offset would light every winter design an hour wrong. `sun.py`
 * takes the offset as a number, so the viewer answers "what was my zone doing
 * then" and lets the one solar model do the astronomy.
 */
export function utcOffsetHoursFor({ date, time } = {}) {
  if (!date) return null;
  const [y, mo, d] = date.split("-").map(Number);
  const [hh, mi] = String(time ?? "12:00").split(":").map(Number);
  const local = new Date(y, (mo || 1) - 1, d || 1, hh || 0, mi || 0);
  if (Number.isNaN(local.getTime())) return null;
  // getTimezoneOffset is minutes to ADD to local to reach UTC, and is positive
  // west of Greenwich — the opposite sign from the offset sun.py wants
  return -local.getTimezoneOffset() / 60;
}

/**
 * The query string for GET /api/sun, or "" for "right now".
 *
 * Kept here rather than inline at the fetch so the whole clock-to-request path
 * is one tested unit; the route itself shape-checks every value again before it
 * reaches a subprocess argv.
 */
export function sunQuery(when) {
  if (!when?.date) return "";
  const off = utcOffsetHoursFor(when);
  const p = new URLSearchParams({ date: when.date, time: when.time ?? "12:00" });
  if (Number.isFinite(off)) p.set("utc_offset", String(off));
  return `?${p}`;
}

/**
 * One line saying what the garden is lit by, for the panel.
 *
 * It must say when the BEARING is not trusted. With north unset, sun.py refuses
 * the azimuth and lighting.js falls back to its arbitrary one, so a shadow in
 * the render points nowhere in particular — and a viewer that displayed a
 * confident compass bearing there would be inventing site truth, which is the
 * one thing this project never does.
 */
export function sunLabel(state, when) {
  if (!state) return "sun: unknown";
  const alt = Number(state.altitude_deg);
  const at = when?.date ? `${when.date} ${when.time}` : "now";
  if (!Number.isFinite(alt)) return `sun: unknown · ${at}`;
  if (alt <= 0) return `sun: below the horizon · ${at}`;
  const bearing = state.azimuth_trusted
    ? `bearing ${Math.round(state.azimuth_deg)}°`
    : "bearing not known — set north";
  return `sun: ${alt.toFixed(1)}° up · ${bearing} · ${at}`;
}
