// node --test tests/js/
//
// ESC LEAVES PLACE MODE — the user needs an obvious way out.
//
// Pressing the Add button again is not where your hand is once you are
// clicking the ground. Esc is what everything else in this viewer uses to leave
// a mode, and a keydown handler that returns early on
// `if (mode !== "measure") return;` gives that exit to measure mode only.
//
// Area drawing needs the same exit, from the same place: one handler,
// every mode that can trap you.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main=fs.readFileSync(path.join(ROOT,"viewer","src","main.js"),"utf8");
// Every tool leaves through ONE exit, leaveTool(), which Esc and the dock's Select both
// take; these hold the exits against it rather than against per-tool branches.
const leave = main.slice(main.indexOf("function leaveTool"), main.indexOf("\n}", main.indexOf("function leaveTool")));
test("Escape leaves place mode", () => {
  assert.match(main, /if \(ev\.key === "Escape" && !fly\.on && mode !== "orbit"\) \{[\s\S]{0,200}leaveTool\(\)/,
    "Esc does nothing in place mode");
  assert.match(leave, /else if \(mode !== "orbit"\) \{[^}]*setMode\("orbit"\)/, "it does not actually leave place mode");
});
test("Escape leaves area drawing too", () => {
  assert.match(leave, /mode === "area"\) document\.getElementById\("btnDrawArea"\)\?\.click\(\)/,
    "a half-drawn area has no exit");
});
test("the early return does not swallow every other mode", () => {
  const h=main.indexOf('if (mode !== "measure") return;');
  const esc=main.indexOf('if (ev.key === "Escape" && !fly.on && mode !== "orbit")');
  assert.ok(esc<h && esc!==-1,"the Esc exit sits after the measure-only guard, so it can never run");
});
