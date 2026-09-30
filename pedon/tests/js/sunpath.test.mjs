// node --test tests/js/sunpath.test.mjs
//
// Dragging the sun across the day, with a shadow camera fitted to the design.
//
// The user needs to see the design under sunlight at different times of day.
// sun.py computes the astronomy,
// /api/sun puts it on the scene, lighting.js samples a physical sky into both
// background and environment. Fetching each position round-trips to a Python
// subprocess, so a slider could fire a hundred of them. `sun.py day` returns a
// whole day's track; the viewer fetches it once and interpolates locally.
import { resolvePath } from "../../viewer/project_paths.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sunAt, dayRange, hhmm, minutesOf, utcMinutes, twoSunsWarning, seasonDates }
  from "../../viewer/src/shell/sunpath.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = f => fs.readFileSync(resolvePath(f), "utf8");   // data/… is the active site's

// a real-shaped day: sunrise 06:19, sunset 19:52 local (UTC-7), 30-min samples
const DAY = {
  date: "2026-09-12",
  sunrise_utc: "2026-09-12T13:19:00+00:00",
  sunset_utc: "2026-09-13T02:52:00+00:00",
  track: [
    { utc: "2026-09-12T14:00:00+00:00", altitude_deg: 5, azimuth_deg: 88 },
    { utc: "2026-09-12T15:00:00+00:00", altitude_deg: 17, azimuth_deg: 98 },
    { utc: "2026-09-12T16:00:00+00:00", altitude_deg: 29, azimuth_deg: 108 },
  ],
};

test("the hour interpolates between samples rather than snapping to one", () => {
  // 14:30 UTC is 07:30 local at UTC-7, halfway between the first two samples
  const mid = sunAt(DAY, 7 * 60 + 30, -7);
  assert.equal(mid.altitude_deg, 11, "half way between 5 and 17 is 11");
  assert.equal(mid.azimuth_deg, 93);
  // and an exact sample is itself
  assert.equal(sunAt(DAY, 8 * 60, -7).altitude_deg, 17);
});

test("before the first sample and after the last, it holds rather than extrapolating", () => {
  assert.equal(sunAt(DAY, 3 * 60, -7).altitude_deg, 5, "extrapolated below the first sample");
  assert.equal(sunAt(DAY, 23 * 60, -7).altitude_deg, 29, "extrapolated past the last sample");
  assert.equal(sunAt({ track: [] }, 600, -7), null);
  assert.equal(sunAt(null, 600, -7), null);
});

test("the azimuth takes the SHORT way round the compass", () => {
  // at the moment the sun passes due north, a naive mean of 359 and 1 is 180 —
  // which swings every shadow in the garden to the opposite side for one sample
  const wrap = { date: "2026-06-21",
    track: [{ utc: "2026-06-21T12:00:00+00:00", altitude_deg: 10, azimuth_deg: 359 },
            { utc: "2026-06-21T13:00:00+00:00", altitude_deg: 12, azimuth_deg: 1 }] };
  const mid = sunAt(wrap, 12 * 60 + 30, 0);
  assert.ok(mid.azimuth_deg > 359.5 || mid.azimuth_deg < 0.5,
    `halfway between 359 and 1 came out at ${mid.azimuth_deg}, not 0`);
});

test("the slider covers the whole day, with light before and after the sun", () => {
  const { start, end } = dayRange(DAY, -7);
  assert.equal(hhmm(start), "05:49", "sunrise is 06:19 local; 30 min of first light before it");
  assert.equal(hhmm(end), "20:22");
  // a day with no sunrise recorded still gives a usable range rather than NaN
  const fallback = dayRange({}, -7);
  assert.ok(Number.isFinite(fallback.start) && fallback.end > fallback.start);
});

test("the clock round-trips", () => {
  for (const t of ["00:00", "06:19", "12:00", "17:17", "23:59"])
    assert.equal(hhmm(minutesOf(t)), t);
  assert.equal(minutesOf("nonsense"), null);
  assert.equal(minutesOf(undefined), null);
  assert.equal(hhmm(1440), "00:00", "midnight the next day is midnight");
  assert.equal(utcMinutes("not a date", "2026-09-12"), null);
});

test("TWO SUNS: it says so when the plate and the design disagree", () => {
  // the scan is a PHOTOGRAPH and its shadows are painted into the texture, so
  // moving the light away from the capture hour puts the ground's shadows and
  // the design's pointing different ways — the one lighting error you cannot
  // art-direct around
  const cap = 17 * 60 + 17;
  assert.equal(twoSunsWarning({ litMinutes: cap, captureMinutes: cap, scanShown: true }), null);
  assert.equal(twoSunsWarning({ litMinutes: cap + 30, captureMinutes: cap, scanShown: true }), null,
    "half an hour is the same afternoon");
  const w = twoSunsWarning({ litMinutes: 8 * 60, captureMinutes: cap, scanShown: true });
  assert.match(w, /17:17/, "it does not say what hour the plate was taken at");
  assert.match(w, /[Hh]ide the scan/, "it names the problem and not the remedy");
});

test("with the plate hidden there is no contradiction to report", () => {
  // the whole point of the remedy: on bare measured ground the design's light is
  // the only light in the frame
  assert.equal(twoSunsWarning({ litMinutes: 8 * 60, captureMinutes: 17 * 60, scanShown: false }), null);
  assert.equal(twoSunsWarning({ litMinutes: 8 * 60, captureMinutes: null, scanShown: true }), null,
    "a capture whose hour is unknown cannot contradict anything");
  assert.equal(twoSunsWarning(), null);
});

test("the seasons are the four the sun actually turns on", () => {
  const d = seasonDates(null, 2026);
  assert.equal(d.june_solstice, "2026-06-21");
  assert.equal(d.december_solstice, "2026-12-21");
  assert.equal(Object.keys(d).length, 4);
});

test("the astronomy stays in sun.py — the viewer asks, it does not model", () => {
  // a second solar model in JS duplicates the astronomy and can disagree with
  // sun.py; the viewer must consume the shared model's results
  const src = read("viewer/src/shell/sunpath.js");
  for (const banned of [/Math\.asin/, /declination/i, /obliquity/i, /julian/i, /23\.44/])
    assert.ok(!banned.test(src), `sunpath.js is computing its own astronomy: ${banned}`);
  assert.match(read("viewer/vite.config.js"), /url === "\/api\/sun\/day"/,
    "nothing serves the day track the slider interpolates");
  assert.match(read("viewer/src/main.js"), /\/api\/sun\/day/,
    "the viewer never fetches a day track, so the slider is round-tripping again");
});

test("the shadow camera is FITTED to the design, not to the whole yard", () => {
  // With the default 60 m box the shadow map costs 10 ms a frame and changes
  // NOT ONE PIXEL — 2048 texels over 60 m is 2.9 cm each and
  // the normal bias that stops the 13° slope striping is 3 cm, so the sample
  // point goes clean through a 2 cm leaf. Six renders across the toggle are
  // byte-identical. Fitted to the design's own 9 x 29 m: 30.3% of the frame
  // changes and the mean luminance drops from 102.8 to 96.0.
  const lighting = read("viewer/src/lighting.js");
  assert.match(lighting, /fitTo\s*\(/, "the lighting cannot be aimed at the design");
  assert.match(lighting, /mapSize\.x\)\s*\*\s*1\.0/,
    "the normal bias must be 1.0 texel — 2.2 texels with the fitted box "
    + "exceeds 3 cm and can skip a 2 cm leaf");
  const main = read("viewer/src/main.js")
    .split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.match(main, /lighting\.fitTo\?\.\(/, "nothing ever fits it to the loaded design");
});
