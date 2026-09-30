// node --test tests/js/setup_path.test.mjs
//
// Is this property set up, and what is the next thing to do?
//
// A site needs setting up — north, the measurements and the rest.
// `analyze_site.py` has a strict order and doing it out of order silently
// produces a wrong yard — silently being the whole problem: every coordinate
// stays self-consistent, so nothing looks broken and no validator can object.
//
// THE MEASURED CASE IS THIS PROPERTY. `site.frame.north_set` is false, and
// site.json carries its own warning about it: "Bearings, contour directions and
// the compass sense of zone names are UNVERIFIED until Set north is done on this
// capture." The shell must say so too, from keys site.json actually has: a hint
// computed from a key it never has reads "not calibrated" on every property
// forever, and a warning that is always on is not a warning.
import { needsSite } from "./lib/site.mjs";   // about a real site
import { resolvePath } from "../../viewer/project_paths.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupSteps, calibrationWarning, setupProgress }
  from "../../viewer/src/shell/setup.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = f => fs.readFileSync(resolvePath(f), "utf8");   // data/… is the active site's
const by = (steps, id) => steps.find(s => s.id === id);

const DONE_CALIB = { capture: "x.glb", plane: { nx: 0, ny: 1, nz: 0, d: 0 },
                     northSet: true, spans: [{ lenM: 3 }], scale: 1.02 };
const DONE_SITE = { zones: [{ name: "back_yard" }], scan_coverage: { cells: 1 },
                    address: "12 Example St", usda_zone: "10a",
                    frame: { north_set: true } };

test("a bare property has everything outstanding and one step marked NEXT", () => {
  const steps = setupSteps({});
  assert.equal(steps.filter(s => s.done).length, 0);
  assert.equal(steps.filter(s => s.state === "next").length, 1,
    "exactly one step is the next thing to do");
  assert.equal(by(steps, "capture").state, "next", "the path does not start at the capture");
});

test("a finished property raises no warning at all", () => {
  const steps = setupSteps({ calib: DONE_CALIB, site: DONE_SITE });
  assert.equal(steps.filter(s => !s.done).length, 0, steps.filter(s => !s.done).map(s => s.id).join());
  assert.equal(calibrationWarning(steps), null,
    "a warning that is on when everything is done is not a warning");
  assert.deepEqual(setupProgress(steps), { done: 6, total: 6 });
});

test("THIS property: north is not set, and the shell must say so", needsSite, () => {
  // read off the real file, not a fixture I wrote — a fixture I author can only
  // confirm what I already believe
  const site = JSON.parse(read("data/site.json"));
  assert.equal(site.frame?.north_set, false,
    "north has been set since — re-check what this test is asserting");
  const steps = setupSteps({ calib: {}, site });
  assert.equal(by(steps, "north").done, false);
  const warn = calibrationWarning(steps);
  assert.ok(warn, "the real site.json raises no warning");
  assert.match(warn.long, /north/);
  assert.match(warn.long, /self-consistent and wrong|not calibrated/);
});

test("the LIVE calibration counts, not only what the file last recorded", () => {
  // site.json is written by a tool run; the browser may have set north since.
  // Reading the file alone would go on warning after the user had just fixed it.
  const site = { frame: { north_set: false } };
  assert.equal(by(setupSteps({ calib: { northSet: true }, site }), "north").done, true);
  assert.equal(by(setupSteps({ calib: {}, site }), "north").done, false);
  // and the file counts when the browser has no calibration loaded yet
  assert.equal(by(setupSteps({ calib: {}, site: { frame: { north_set: true } } }), "north").done, true);
});

test("only BLOCKING steps raise the warning", () => {
  // a missing climate zone is incomplete; a missing north is WRONG in the one
  // way nothing downstream can detect, and conflating them makes the loud one
  // no louder than the quiet one
  const steps = setupSteps({ calib: DONE_CALIB,
                             site: { ...DONE_SITE, address: null, usda_zone: null } });
  assert.equal(by(steps, "address").done, false);
  assert.equal(calibrationWarning(steps), null,
    "a missing address raised a not-calibrated warning");
});

test("the warning names what is missing, in a sentence", () => {
  // TWO BLOCKING steps missing — the ground plane and north. The capture is
  // loaded so it does not count, and scale is deliberately NOT blocking, so
  // neither can be used to reach a plural here.
  const steps = setupSteps({ calib: { capture: "x.glb" }, site: { ...DONE_SITE, frame: {} } });
  const w = calibrationWarning(steps);
  assert.match(w.short, /2 setup steps left/);
  assert.match(w.long, /ground/);
  assert.match(w.long, /north/);
  // one missing step reads as one thing, not as "1 setup steps"
  const one = calibrationWarning(setupSteps({
    calib: { ...DONE_CALIB, northSet: false }, site: { ...DONE_SITE, frame: {} } }));
  assert.equal(one.short, "no north");
});

test("an unlocked scale does not raise the warning, and an unset north does", () => {
  // Measuring before locking the scale is optional: the default is shown and
  // the user may keep it.
  //
  // These are DIFFERENT SIZES OF WRONG and the top bar must not conflate them.
  // A LiDAR capture's own scale is off by about a percent. An unset north is off
  // by however the scanner happened to be facing — 23.3° measured on this
  // property — and every bearing, every slope aspect and every sun
  // position inherits it. So scale is a suggestion and north is a refusal.
  const scaleOnly = setupSteps({ calib: { ...DONE_CALIB, scale: 1, spans: [] },
                                 site: DONE_SITE });
  assert.equal(by(scaleOnly, "scale").done, false, "premise: the scale is unlocked here");
  assert.equal(calibrationWarning(scaleOnly), null,
    "an unlocked scale raised a not-calibrated warning — it is a 1% error, not a wrong frame");

  const northless = setupSteps({ calib: { ...DONE_CALIB, northSet: false },
                                 site: { ...DONE_SITE, frame: {} } });
  assert.ok(calibrationWarning(northless), "an unset north must still warn");
});

test("the scale counts as locked by a measured span OR a scale that moved", () => {
  const base = { capture: "x", plane: {}, northSet: true };
  assert.equal(by(setupSteps({ calib: base }), "scale").done, false,
    "an untouched scale of 1 is not a locked scale");
  assert.equal(by(setupSteps({ calib: { ...base, spans: [{ lenM: 3 }] } }), "scale").done, true);
  assert.equal(by(setupSteps({ calib: { ...base, scale: 1.04 } }), "scale").done, true);
});

test("nothing at all is not an exception", () => {
  assert.equal(setupSteps().length, 6);
  assert.equal(setupSteps({ calib: null, site: null }).length, 6);
  assert.equal(calibrationWarning(), null);
  assert.deepEqual(setupProgress(), { done: 0, total: 0 });
});

test("the shell READS this, and no longer reads a key that does not exist", () => {
  const main = read("viewer/src/main.js")
    .split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.match(main, /calibrationWarning\(/, "nothing computes the warning");
  assert.match(main, /setWarning/, "the top bar is never told");
  assert.ok(!/siteCache\?\.registration/.test(main),
    "reading siteCache.registration — a key site.json never has, so the "
    + "hint reads 'not calibrated' on every property forever");
  assert.match(read("viewer/src/shell/topbar.js"), /tb-warn/,
    "the top bar has nowhere to show it");
  assert.match(read("viewer/index.html"), /id="setupPath"/,
    "the settings window has nowhere to show the path");
});
