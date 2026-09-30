// node --test tests/js/marker_move.test.mjs
//
// Markers can be moved.
//
// A move is whole: every part of the pin follows the cursor, the cursor shows a
// pin can be grabbed, the moved row keeps its place in Places, and the save
// completes. A log line in `addLandmark` that reads a `const e` declared inside
// the updateSite callback would throw `ReferenceError: e is not defined` after
// the write lands, so every save and every move would end in an exception and
// nothing would say "moved".
//
// A marker is OWNER GROUND TRUTH. That forbids a model inventing one; it does not
// forbid the owner correcting their own measurement.
import { resolvePath } from "../../viewer/project_paths.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { upsertLandmark, pinParts, PIN_LIFT } from "../../viewer/src/landmarks.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = p => fs.readFileSync(resolvePath(p), "utf8");   // data/… is the active site's
const codeOnly = s => s.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
/** The body of `function name(` … matched by braces, so growth cannot slice it short. */
function body(src, name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} is gone — fix this lookup, do not delete the check`);
  let i = src.indexOf("{", src.indexOf(")", at)), depth = 0;
  const start = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) break;
  }
  return src.slice(start, i + 1);
}

const LIST = [{ name: "a", x: 1, y: 1 }, { name: "b", x: 2, y: 2 }, { name: "c", x: 3, y: 3 }];

test("a moved marker keeps its place in the list", () => {
  const got = upsertLandmark(LIST, { name: "a", x: 9, y: 9 });     // the FIRST one, so order shows
  assert.deepEqual(got.map(l => l.name), ["a", "b", "c"]);
  assert.deepEqual(got[0], { name: "a", x: 9, y: 9 });
});

test("a new marker goes on the end, and the input is never mutated", () => {
  const before = JSON.stringify(LIST);
  assert.deepEqual(upsertLandmark(LIST, { name: "d", x: 4, y: 4 }).map(l => l.name), ["a", "b", "c", "d"]);
  upsertLandmark(LIST, { name: "a", x: 9, y: 9 });
  assert.equal(JSON.stringify(LIST), before);
  assert.deepEqual(upsertLandmark(undefined, { name: "z" }), [{ name: "z" }]);
});

test("every part of a pin follows a drag — ring, stem, knob AND label — and nobody else's", () => {
  const mk = (ud) => ({ userData: ud });
  const kids = [mk({ landmark: "gate", pinLift: 0.02 }), mk({ landmark: "gate", pinLift: 0.8 }),
                mk({ landmark: "gate", pinLift: 1.6 }), mk({ landmarkLabel: "gate", pinLift: 2.0 }),
                mk({ landmark: "other", pinLift: 0.8 }), mk({ footprintIndex: 0 }), mk({})];
  const parts = pinParts(kids, "gate");
  assert.deepEqual(parts.map(([, lift]) => lift), [0.02, 0.8, 1.6, 2.0]);
  assert.equal(pinParts(kids, undefined).length, 0, "an untagged object must never match a missing name");
});

test("design.js builds the pin from the same heights the drag moves it with", () => {
  const src = codeOnly(read("viewer/src/design.js"));
  for (const part of ["ring", "stem", "knob", "label"]) {
    assert.match(src, new RegExp(`p\\.y \\+ PIN_LIFT\\.${part}`), `${part} is placed by a number of its own`);
    assert.match(src, new RegExp(`pinLift = PIN_LIFT\\.${part}`), `${part} does not carry its lift, so a drag flattens the pin`);
  }
  assert.ok(PIN_LIFT.ring < PIN_LIFT.stem && PIN_LIFT.stem < PIN_LIFT.knob && PIN_LIFT.knob < PIN_LIFT.label);
  // the label must NOT be tagged `landmark`: pickPin raycasts everything that is
  assert.doesNotMatch(src, /lbl\.userData\.landmark\s*=/);
});

test("saving a marker does not end in a ReferenceError", () => {
  const fn = body(codeOnly(read("viewer/src/main.js")), "addLandmark");
  const declared = fn.indexOf("const e = worldToEnu(p)");
  const callback = fn.indexOf("await updateSite(");
  const logged = fn.indexOf("${e[0]");
  assert.ok(declared >= 0 && callback >= 0 && logged >= 0, "addLandmark changed shape — re-read it");
  assert.ok(declared < callback,
    "`e` is declared inside the updateSite callback again, and the log line after it throws");
  assert.match(fn, /s\.landmarks = upsertLandmark\(s\.landmarks, lm\)/, "the list is rebuilt by filter+push again");
  assert.doesNotMatch(fn, /\.filter\(l => l\.name !== saved\)/);
});

test("the drag moves the whole pin and the cursor says a pin can be grabbed", () => {
  const main = codeOnly(read("viewer/src/main.js"));
  assert.match(main, /for \(const \[part, lift\] of pinParts\(footprintGroup\?\.children, drag\.pin\.userData\.landmark\)\)\s*\n\s*part\.position\.set\(lp\.x, lp\.y \+ lift, lp\.z\)/);
  assert.doesNotMatch(main, /drag\.pin\.position\.set\(/, "only the grabbed mesh moves again");
  // the pin wins the cursor because it wins the press — even over a plant behind it
  assert.match(main, /style\.cursor = pickPin\(ev\) \? "grab" : id \? "pointer" : ""/);
  assert.match(main, /style\.cursor = "grabbing"/);
});

test("a Places row can arm a move, one click finishes it, and Esc or any mode change drops it", () => {
  const main = codeOnly(read("viewer/src/main.js"));
  const list = body(main, "renderLandmarkList");
  assert.match(list, /mv\.textContent = "move"/);
  assert.match(list, /armedMove = lm\.name;[^\n]*\n\s*setMode\("landmark"\);/, "the row must hand the name to setMode");
  assert.match(list, /row\.append\(label, go, mv, del\)/, "the button is built and never shown");
  const sm = body(main, "setMode");
  assert.match(sm, /relocating = m === "landmark" \? armedMove : null;\s*\n\s*armedMove = null;/,
    "a change of mode must drop a pending move, and only a row's own call may carry one in");
  // the generic "type a name, then click" hint is wrong when the user is MOVING a named marker
  assert.match(sm, /m === "landmark" && !relocating/);
  assert.ok(main.indexOf("let relocating = null;") < main.indexOf("function setMode("),
    "declared below setMode, the start-up call to setMode hits the temporal dead zone");
  assert.match(main, /if \(relocating\) \{[\s\S]{0,260}addLandmark\(moving, p\)/);
  // Esc leaves marking through the one exit, which still says the landmark stayed put
  const leave = body(main, "leaveTool");
  assert.match(leave, /const moving = mode === "landmark" \? relocating : null;/);
  assert.match(leave, /log\(moving \? `"\$\{moving\}" stays where it was`/);
});
