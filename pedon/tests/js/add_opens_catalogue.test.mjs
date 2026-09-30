// node --test tests/js/
//
// Add opens the asset panel; it does not arm place mode, because there is
// nothing to pick without the asset panel.
//
// Arming place mode directly would place whatever `placeWhat` happens to hold —
// `placeWhat` is a HIDDEN <select>, so that is its first option, a plant the
// user never chose. The cursor ghost would draw that plant, and the only
// surface that can choose one is a window the button did not open.
//
// The second half of the gesture lives in the asset window: its card click
// calls pickEntry() and then setMode("place"). Add supplies only the first
// half, which is why it is one call and not a flow.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");

/** The handler's own body, brace-matched — a fixed-width slice runs straight past
 *  the closing brace into the NEXT handler, which assigns setMode("place") for a
 *  different reason, and fails against code that is correct. */
function handler(id) {
  const i = main.indexOf(`document.getElementById("${id}").onclick`);
  assert.notEqual(i, -1, `${id} has no click handler`);
  const open = main.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < main.length; j++) {
    if (main[j] === "{") depth++;
    else if (main[j] === "}") { depth--; if (!depth) return main.slice(i, j + 1); }
  }
  throw new Error(`unbalanced braces in ${id}`);
}

test("Add opens the catalogue instead of arming place mode", () => {
  const body = handler("btnPlace");
  assert.match(body, /showAssets\(true\)/,
    "Add still does not open the asset window, so there is nothing to pick from");
  // COMMENTS STRIPPED. The handler's own comment explains that picking a card
  // arms the mode, so matching setMode("place") in the raw text would fail
  // against correct code.
  const code = body.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const arming = code.slice(code.indexOf("if (!stage)"));
  assert.doesNotMatch(arming, /setMode\("place"\)/,
    "Add still arms place mode on a plant the owner never chose");
});

test("it is still a toggle — pressing Add while placing leaves the mode", () => {
  // Escape also exits; the button must keep working too, or the change
  // above would strand the user in place mode
  assert.match(handler("btnPlace"),
    /if \(mode === "place"\) \{ setMode\("orbit"\); return; \}/,
    "Add no longer leaves place mode");
});

test("it still refuses before a capture is loaded", () => {
  // pickSurface falls back to the flat y=0 plane with no scan, and a plant on
  // invented ground is precisely what the validator rejects
  assert.match(handler("btnPlace"), /if \(!stage\)/,
    "the no-capture guard is gone");
});

test("choosing from the catalogue is what arms the mode", () => {
  // the half that already existed, pinned so the two halves cannot drift apart
  const i = main.indexOf("card.onclick = () => {");
  assert.notEqual(i, -1, "the asset card handler moved; fix this test");
  const body = main.slice(i, i + 700);
  assert.match(body, /pickEntry\(key\)/, "picking a card no longer sets what gets planted");
  assert.match(body, /setMode\("place"\)/,
    "picking a card no longer arms place mode — with Add no longer arming it either, "
    + "nothing would");
});
