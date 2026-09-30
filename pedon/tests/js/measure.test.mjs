// node --test tests/js/
//
// Measuring in the app.
//
// The one decision that matters here is which LENGTH. A site can fall steeply
// (14.3 degrees on the reference site), and on that ground the distance across
// the map and the distance you actually walk are not the same number:
//
//   * you order paving, gravel and turf by PLAN area — the shadow on the map;
//   * you walk, and you buy edging and hose by SLOPE length, along the ground.
//
// A measuring tool that silently picks one is wrong for half the jobs it will be
// used for, and on a 25% grade it is wrong by 3%, which is enough to be short of
// stone and not enough to notice until you are. So report both, and say which is
// which.
//
// Pure, and it reuses areas.js's polygonArea rather than transcribing the
// shoelace: that ray-crossing/area pair has one home for exactly this reason —
// every transcription is a copy that drifts.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const m = await import(path.join(ROOT, "viewer", "src", "measure.js"));

const FLAT = () => 0;
const SLOPE = (x) => x * 0.75;        // 36.9 deg: a 3-4-5 triangle, so the maths is exact

test("a flat run measures its plan length and nothing surprising", () => {
  const r = m.measure([[0, 0], [3, 4]], FLAT);
  assert.equal(r.points, 2);
  assert.ok(Math.abs(r.plan_m - 5) < 1e-9, r.plan_m);
  assert.ok(Math.abs(r.slope_m - 5) < 1e-9, "flat ground made the walk longer than the map");
  assert.equal(r.fall_m, 0);
  assert.equal(r.area_m2, null, "two points do not enclose anything");
});

test("on a slope the walk is longer than the map, by the right amount", () => {
  // 4 m across, rising 3 m -> 5 m along the ground. If this ever returns 4 the
  // tool is measuring the drawing instead of the garden.
  const r = m.measure([[0, 0], [4, 0]], SLOPE);
  assert.ok(Math.abs(r.plan_m - 4) < 1e-6, `plan ${r.plan_m}`);
  assert.ok(Math.abs(r.slope_m - 5) < 1e-6, `slope ${r.slope_m}`);
  assert.ok(Math.abs(r.fall_m - 3) < 1e-6, `fall ${r.fall_m}`);
  assert.ok(Math.abs(r.grade_pct - 75) < 1e-6, `grade ${r.grade_pct}`);
});

test("a closed shape reports PLAN area, which is what materials are sold by", () => {
  const r = m.measure([[0, 0], [4, 0], [4, 4], [0, 4]], SLOPE);
  assert.ok(Math.abs(r.area_m2 - 16) < 1e-6,
    `${r.area_m2} m2 — plan area must not be inflated by the slope; a supplier `
    + "quotes the footprint");
  assert.ok(r.slope_m > r.plan_m, "the perimeter still walks longer than it draws");
});

test("area comes from the ONE polygon-area function in this project", () => {
  const src = fs.readFileSync(path.join(ROOT, "viewer", "src", "measure.js"), "utf8");
  assert.match(src, /import\s*\{[^}]*polygonArea[^}]*\}\s*from\s*["']\.\/areas\.js["']/,
    "measure.js does not use areas.js's polygonArea — the shoelace has one home, "
    + "and a transcription is a copy that drifts");
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, ""), /\*\s*p\[1\]\s*-\s*/,
    "a fifth hand-rolled shoelace is being written here");
});

test("it measures the ground it was given, not an interpolation of it", () => {
  // heightAt returns NaN off the scan. A segment with an unmeasured end must not
  // quietly contribute a made-up rise — on a real site the filled field invents
  // a 357% cliff.
  const patchy = (x) => (x > 5 ? NaN : 0);
  const r = m.measure([[0, 0], [4, 0], [9, 0]], patchy);
  assert.ok(Math.abs(r.plan_m - 9) < 1e-6, "plan length is geometry and is always known");
  assert.equal(r.unmeasured_m > 0, true, "nothing reports that part of this run is off the scan");
  assert.ok(Number.isFinite(r.slope_m), `slope length went NaN: ${r.slope_m}`);
});

test("one point measures nothing, and says so rather than throwing", () => {
  for (const pts of [[], [[1, 1]], null]) {
    const r = m.measure(pts, FLAT);
    assert.equal(r.plan_m, 0);
    assert.equal(r.area_m2, null);
  }
});

test("the readout says which number is which", () => {
  // "12.4 m" on a slope is ambiguous and the ambiguity is the whole bug
  const r = m.measure([[0, 0], [4, 0]], SLOPE);
  const t = m.describe(r);
  assert.match(t, /4\.0 m across/, t);
  assert.match(t, /5\.0 m along the ground/, t);
  assert.match(t, /75/, t);
  const flatText = m.describe(m.measure([[0, 0], [3, 4]], FLAT));
  assert.doesNotMatch(flatText, /along the ground/,
    "on flat ground the two numbers are identical and printing both is noise");
});

// ══ the wiring ════════════════════════════════════════════════════════════
const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const code = main.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const html = fs.readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");

test("the viewer uses measure.js rather than its own arithmetic", () => {
  assert.match(code, /from\s*["']\.\/measure\.js["']/, "main.js does not import measure.js");
  // The readout is labelled rows on the canvas, not one sentence: on a 14 deg
  // slope the two lengths ARE the tool, and a sentence makes you parse which
  // number is which.
  // The arithmetic is still measure.js's — that is what this test is for.
  assert.ok(code.includes("measureRun("), "measure.js is imported and never called");
  assert.ok(!/plan_m\s*=\s*[^;]*Math\.hypot/.test(code),
    "main.js computes a plan length itself instead of asking measure.js");
  assert.match(html, /id="btnMeasure"/, "no button — the feature is undiscoverable");
  assert.match(code, /getElementById\("btnMeasure"\)\.onclick/, "the button does nothing");
});

test("measuring reads the ground in the ENU frame, not the world frame", () => {
  // THE bug class of this project: ENU and world are identical at yaw 0 and
  // diverge the moment north is set, and heightAt is a WORLD function. A
  // measuring tool that hands it ENU coordinates is right until the day it is
  // silently, unfixably wrong.
  const body = code.slice(code.indexOf("function groundAtEnu"),
                          code.indexOf("function groundAtEnu") + 400);
  assert.match(body, /enuToWorld\(/,
    "groundAtEnu does not convert to world before calling heightAt");
  assert.match(body, /heightAt\(w\.x,\s*w\.z\)/, body);
});

test("turning the camera does not drop measuring points", () => {
  assert.match(code, /DRAG_THRESHOLD_PX/,
    "a click and an orbit drag both end in pointerup; without the threshold every "
    + "camera move leaves a stray point on the ground");
});

test("the readout floats, and cannot swallow a click meant for the yard", () => {
  // A readout reported somewhere the user is not looking has not been reported:
  // in the panel's flow it goes unseen, and the user draws lines and gets no
  // answer. So it floats — which risks status text covering the scene and
  // blocking clicks on it, and the answer to that is pointer-events, not going
  // back into a collapsed section.
  const css = fs.readFileSync(new URL("../../viewer/src/pedon.css", import.meta.url), "utf8");
  const rule = css.match(/\.p-hud\s*\{[^}]*\}/);
  assert.ok(rule, ".p-hud has no style rule at all");
  assert.match(rule[0], /position\s*:\s*fixed/, "the HUD does not float");
  assert.match(rule[0], /pointer-events\s*:\s*none/,
    "the HUD intercepts clicks — it would block the ground it is describing");
});

test("starting another mode clears the measurement", () => {
  // setMode is the ONE place that decides which mode is live and which button
  // looks pressed. A measure overlay that outlives it leaves a green line and a
  // readout on screen describing a run the user has stopped caring about — and
  // the Measure button lit while they are placing plants.
  const body = code.slice(code.indexOf("function setMode"),
                          code.indexOf("function setMode") + 1800);
  assert.ok(body.length > 100, "setMode not found");
  assert.match(body, /clearMeasure\(\)/,
    "setMode does not clear the measurement when another mode takes over");
  assert.match(code, /setMode\("measure"\)/,
    "the Measure button sets `mode` by hand instead of going through setMode, so "
    + "the one function that owns mode state does not know about it");
});
