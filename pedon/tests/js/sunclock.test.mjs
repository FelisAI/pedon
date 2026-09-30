// node --test tests/js/sunclock.test.mjs
//
// What hour the garden is lit at.
//
// The viewer must call `setSunFromAzimuthAltitude` to use the measured sun.
// Without a caller, every frame uses lighting.js's arbitrary LEGACY_SUN:
// altitude 47.969 deg, bearing 123.690 deg.
//
// The photogrammetry plate fills most of every eye-level shot. At its 17:17 local
// capture time, tools/sun.py puts the real sun at 29.209 deg / 260.894 deg. The
// legacy sun differs by 18.8 deg in altitude, so the design's shadows disagree
// with the scan's baked-in shadows. In a 1200 px eye-level comparison, matching
// the capture's sun changes 52.1% of pixels — an order of magnitude more than
// leaf translucency (3.6%), mip erosion (3.7%) or the alpha-mask sRGB tag (0.1%).
//
// The astronomy is NOT tested here and is not in the module: it is tools/sun.py,
// reached over GET /api/sun. One solar model keeps all four render-broker
// clients consistent; a second implementation in JavaScript can disagree.
//
// The LAST test is the one that matters most: it asserts the caller still exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  captureSunTime, utcOffsetHoursFor, sunQuery, sunLabel,
} from "../../viewer/src/sunclock.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const vite = readFileSync(path.join(ROOT, "viewer", "vite.config.js"), "utf8");
const html = readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");
const codeOnly = s => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

// ── the capture's own hour ────────────────────────────────────────────────

test("it reads the hour off a real Scaniverse filename", () => {
  // this exact string is data/site.json frame.capture on the live property
  assert.deepEqual(
    captureSunTime("/data/captures/Scaniverse 2026-08-24 171728.glb"),
    { date: "2026-08-24", time: "17:17" });
  // seconds are optional, and separators vary between exporters
  assert.deepEqual(captureSunTime("Scaniverse 2026-08-24 1717.glb"),
                   { date: "2026-08-24", time: "17:17" });
  assert.deepEqual(captureSunTime("scan_2026-01-02T0905.glb"),
                   { date: "2026-01-02", time: "09:05" });
});

test("no stamp is null, not a guess", () => {
  // Null makes the caller fall back to "now". Inventing an hour would light the
  // garden under a sun that never shone on it, which is site truth invented — the
  // one thing this project never does.
  for (const ref of ["capture.glb", "", null, undefined, "yard.ply", "2026.glb"])
    assert.equal(captureSunTime(ref), null, `${ref} should not yield an hour`);
});

test("impossible clocks and calendars are refused, not passed to the solar model", () => {
  assert.equal(captureSunTime("x 2026-02-31 120000.glb"), null, "Feb 31 is not a date");
  assert.equal(captureSunTime("x 2026-13-01 120000.glb"), null, "month 13");
  assert.equal(captureSunTime("x 2026-00-10 120000.glb"), null, "month 0");
  assert.equal(captureSunTime("x 2026-08-24 250000.glb"), null, "hour 25");
  assert.equal(captureSunTime("x 2026-08-24 126500.glb"), null, "minute 65");
  // and a real leap day is accepted
  assert.deepEqual(captureSunTime("x 2028-02-29 0800.glb"), { date: "2028-02-29", time: "08:00" });
});

test("midnight and noon survive the parse", () => {
  assert.deepEqual(captureSunTime("x 2026-08-24 000000.glb"), { date: "2026-08-24", time: "00:00" });
  assert.deepEqual(captureSunTime("x 2026-08-24 235900.glb"), { date: "2026-08-24", time: "23:59" });
});

// ── the offset, derived rather than tabled ────────────────────────────────

test("the UTC offset follows daylight saving instead of being hard-coded", () => {
  // The real reason this is derived: the Pacific coast is -7 in August and -8 in December.
  // A tabled offset would light every winter design an hour wrong. Run in a child
  // process with a fixed TZ so this asserts the actual rule, not the runner's zone.
  const script = `
    import { utcOffsetHoursFor } from ${JSON.stringify(path.join(ROOT, "viewer", "src", "sunclock.js"))};
    console.log(JSON.stringify({
      aug: utcOffsetHoursFor({ date: "2026-08-24", time: "17:17" }),
      dec: utcOffsetHoursFor({ date: "2026-12-24", time: "17:17" }),
    }));`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script],
                           { env: { ...process.env, TZ: "America/Los_Angeles" }, encoding: "utf8" });
  const { aug, dec } = JSON.parse(out);
  assert.equal(aug, -7, "August in California is PDT, UTC-7");
  assert.equal(dec, -8, "December in California is PST, UTC-8");
  assert.notEqual(aug, dec, "the offset must move with DST or winter renders are an hour off");
});

test("a missing or broken date yields no offset rather than NaN", () => {
  assert.equal(utcOffsetHoursFor({}), null);
  assert.equal(utcOffsetHoursFor(), null);
  assert.equal(utcOffsetHoursFor({ date: "not-a-date" }), null);
});

// ── the request ───────────────────────────────────────────────────────────

test("the query carries date, time and the derived offset", () => {
  const q = sunQuery({ date: "2026-08-24", time: "17:17" });
  assert.match(q, /^\?/);
  const p = new URLSearchParams(q.slice(1));
  assert.equal(p.get("date"), "2026-08-24");
  assert.equal(p.get("time"), "17:17");
  assert.ok(Number.isFinite(Number(p.get("utc_offset"))), "no offset — sun.py would read it as UTC");
});

test("no hour means an empty query, which the route reads as 'now'", () => {
  assert.equal(sunQuery(null), "");
  assert.equal(sunQuery({}), "");
  assert.equal(sunQuery(undefined), "");
});

// ── the label must not invent a bearing ───────────────────────────────────

test("with north unset the label says the bearing is NOT known", () => {
  // sun.py refuses the azimuth without north and lighting.js falls back to its
  // arbitrary one, so a confident compass bearing on screen would be invented
  // site truth. The altitude, which needs only a latitude and a clock, is real.
  const s = sunLabel({ altitude_deg: 29.209, azimuth_deg: 123.69, azimuth_trusted: false },
                     { date: "2026-08-24", time: "17:17" });
  assert.match(s, /29\.2/, "the altitude is real and should be shown");
  assert.match(s, /set north/, "it must say the bearing is not known");
  assert.ok(!/123/.test(s), "it must not print the arbitrary fallback bearing as fact");
  assert.ok(!/260/.test(s));
});

test("with north set the bearing is shown", () => {
  const s = sunLabel({ altitude_deg: 29.209, azimuth_deg: 260.894, azimuth_trusted: true },
                     { date: "2026-08-24", time: "17:17" });
  assert.match(s, /261|260/, "a trusted bearing should appear");
  assert.ok(!/set north/.test(s));
});

test("a sun below the horizon says so rather than printing a negative height", () => {
  const s = sunLabel({ altitude_deg: -19.89, azimuth_trusted: false }, null);
  assert.match(s, /below the horizon/);
  assert.ok(!/-19/.test(s));
});

// ── the wiring — the guard this whole file exists for ─────────────────────

test("setSunFromAzimuthAltitude HAS a caller in the viewer", () => {
  // The setter needs a caller; otherwise the viewer lights every frame from
  // the arbitrary LEGACY_SUN instead of the capture's measured sun.
  const src = codeOnly(main);
  assert.match(src, /import \{[^}]*setSunFromAzimuthAltitude[^}]*\} from "\.\/lighting\.js"/,
    "main.js does not import the setter");
  assert.match(src, /setSunFromAzimuthAltitude\(\s*lighting/,
    "nothing in the viewer aims the sun — it uses the arbitrary LEGACY_SUN");
  // and it is actually invoked on load, with the CAPTURE's hour
  assert.match(src, /aimSun\(\s*captureSunTime\(/,
    "the sun is never aimed at the capture's own hour when the scan loads");
  // north arriving makes the refused bearing trustworthy, so it must re-aim
  const i = src.indexOf("calib.northSet = true");
  assert.notEqual(i, -1, "could not find where north is set");
  assert.match(src.slice(i, i + 200), /aimSun\(/,
    "setting north does not re-aim the sun, so the bearing stays refused until reload");
});

test("the solar arithmetic is shelled to sun.py, not reimplemented in JS", () => {
  // `url === "/api/sun"`, not startsWith: vite.config.js strips the query at
  // line 195, and tests/test_dry2.py extracts served routes by exactly that
  // pattern — a startsWith route is invisible to it and reads as unserved
  assert.match(vite, /url === "\/api\/sun"/, "no /api/sun route, or not in the file's own form");
  assert.match(vite, /"sun\.py"/, "the route does not reach tools/sun.py");
  // the classic hazard: values off a query string reaching a subprocess argv
  const i = vite.indexOf('/api/sun');
  const body = vite.slice(i, i + 1400);
  assert.match(body, /\\d\{4\}-\\d\{2\}-\\d\{2\}/, "the date is not shape-checked before argv");
  assert.match(body, /execFile\(/, "must use execFile (argv, no shell), not exec");
  // the viewer must use the single solar model in sun.py
  const srcAll = codeOnly(main) + codeOnly(readFileSync(path.join(ROOT, "viewer", "src", "sunclock.js"), "utf8"));
  assert.ok(!/declination|hourAngle|hour_angle|solarNoon|equationOfTime/i.test(srcAll),
    "the viewer contains a second solar model — sun.py must be the one model");
});

test("the owner can move the clock, and get back to the capture's hour", () => {
  assert.match(html, /id="sunTime"/, "no time control");
  assert.match(html, /id="sunCapture"/, "no way back to the hour the scan was taken");
  assert.match(html, /id="sunLabel"/, "nothing says what the garden is lit by");
  const src = codeOnly(main);
  assert.match(src, /getElementById\("sunTime"\)[\s\S]{0,200}addEventListener/,
    "the time input is in the markup but nothing reads it");
});
