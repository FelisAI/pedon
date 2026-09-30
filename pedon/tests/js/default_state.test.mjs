// node --test tests/js/default_state.test.mjs
//
// A DEFAULT SELECTION STATE: after Measure or any other tool, the user needs a way back. Select
// is the first dock tool, lit when no tool is; it and Esc leave ANY tool through one exit, and
// that exit leaves each tool the way the tool's own button does.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DOCK_TOOLS } from "../../viewer/src/shell/docktools.js";
import { icon } from "../../viewer/src/shell/icons.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const body = start => { const i = main.indexOf(start); assert.ok(i >= 0, `${start} is gone`); return main.slice(i, main.indexOf("\n}", i)); };

test("Select is the first tool on the dock, with its own icon", () => {
  assert.equal(DOCK_TOOLS[0].id, "tool.select");
  assert.match(icon("pointer"), /<path/, "the pointer icon is missing");
  assert.match(main, /\{ id: "tool\.select", [^}]*run: \(\) => leaveTool\(\) \}/s);
});

test("the one exit leaves every tool the way its own button does", () => {
  const leave = body("function leaveTool");
  for (const [mode, btn] of [["measure", "btnMeasure"], ["pick", "btnLassoSelect"], ["area", "btnDrawArea"]])
    assert.match(leave, new RegExp(`mode === "${mode}"\\) document\\.getElementById\\("${btn}"\\)\\?\\.click\\(\\)`),
      `${mode} is not left through its own button — its cleanup would be skipped`);
  assert.match(leave, /if \(fly\.on\) setFly\(false\)/, "walking is not left");
  assert.match(leave, /if \(assetWindowOpen\(\)\) showAssets\(false\)/, "Select leaves Add's library open, and Add lit");
  assert.match(leave, /else if \(mode !== "orbit"\) \{[^}]*setMode\("orbit"\)/, "place/landmark/north are not left");
});

test("leaving a tool says so ONCE", () => {
  // an Esc handler that logs "back to selecting" after the button has said "measuring off" says it twice
  const i = main.indexOf('if (ev.key === "Escape" && !fly.on && mode !== "orbit")');
  const esc = main.slice(i, main.indexOf("return;", i));
  assert.doesNotMatch(esc, /log\(/, "Esc adds a second message to the tool's own");
  assert.match(body("function leaveTool"), /setMode\("orbit"\);\s*log\(/, "place/landmark leave in silence");
});

test("Esc takes the same exit for every tool", () => {
  assert.match(main, /if \(ev\.key === "Escape" && !fly\.on && mode !== "orbit"\) \{[\s\S]{0,200}leaveTool\(\);/);
  assert.doesNotMatch(main, /mode === "place" && ev\.key === "Escape"/, "a per-tool Esc sits beside the one exit");
});

test("the dock lights Select in the default state, and Select a section when it is on", () => {
  const i = main.indexOf("activeId: () =>");
  const lamp = main.slice(i, main.indexOf("}),", i));
  assert.match(lamp, /mode === "orbit" \? "tool\.select"/);
  assert.match(lamp, /mode === "pick" \? "tool\.pick"/);
  const area = body('document.getElementById("btnDrawArea").onclick');
  // and by running the lamp itself, over the states the user can be in
  const src = main.slice(i + "activeId: ".length, main.indexOf("\n});", i)).trim().replace(/,$/, "");
  const lampFor = (fly, mode, open = false) =>
    new Function("fly", "mode", "assetWindowOpen", `return (${src})();`)({ on: fly }, mode, () => open);
  assert.equal(lampFor(false, "orbit"), "tool.select");
  assert.equal(lampFor(false, "orbit", true), "tool.assets", "Add's library is open and Select is lit");
  assert.equal(lampFor(false, "measure", true), "tool.measure");
  assert.equal(lampFor(true, "orbit"), "view.walk");
  assert.equal(lampFor(false, "place"), "tool.assets");
  assert.match(body("async function showAssets"), /syncRail\(\)/, "opening the library does not tell the dock");
  assert.equal((area.match(/syncRail\(\)/g) ?? []).length, 2, "drawing an area on or off does not tell the dock");
});

test("leaving Measure does not throw — a throw leaves the viewer stuck in Measure", () => {
  // clearMeasure must not depend on #measureOut, which is not in the document; setMode runs
  // clearMeasure BEFORE it records the new mode, so a throw leaves `mode` at "measure" and
  // every way out (the button, Esc, Select) dies there.
  const i = main.indexOf("function clearMeasure");
  const fn = new Function("meas", "enuGroup", "disposeObj", "document", "measureHud",
    main.slice(i, main.indexOf("\n}", i) + 2) + "; return clearMeasure;");
  let hidden = false;
  const clear = fn({ pts: [1], group: null }, {}, () => {}, { getElementById: () => null },
                   { hide: () => { hidden = true; } });
  assert.doesNotThrow(() => clear(), "clearMeasure throws without #measureOut");
  assert.ok(hidden, "leaving Measure leaves its readout on screen");
});
