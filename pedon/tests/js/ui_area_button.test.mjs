// node --test tests/js/ui_area_button.test.mjs
//
// Clicking the area button must visibly do something. The name field sits BELOW
// the button inside a collapsible panel — and the dock's pencil drives the same
// handler, so it can be clicked with that panel shut. A button that REFUSES with a
// line in a log nobody is looking at is, from the outside, indistinguishable from
// a dead button.
//
// A daily tool on the rail has to either work or SHOW you what it wants.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");

function handler(anchor) {
  const i = src.indexOf(anchor);
  assert.notStrictEqual(i, -1, `anchor "${anchor}" is gone — retarget this test`);
  let depth = 0;
  for (let j = src.indexOf("{", i); j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) return src.slice(i, j + 1); }
  }
  throw new Error("unbalanced");
}

test("the dock pencil and the panel button are the same control", () => {
  // The dock runs the command, and the command clicks the control that already
  // exists — so there is exactly one thing that starts an area.
  assert.match(src, /\{ id: "tool\.area",\s*title: "Draw an area",[\s\S]{0,120}?click\("btnDrawArea"\)/,
    "the tool.area command no longer forwards to btnDrawArea — retarget this test");
  // the dock's list has one owner: shell/docktools.js
  const dockTools = fs.readFileSync(path.join(ROOT, "viewer", "src", "shell", "docktools.js"), "utf8");
  assert.match(dockTools, /\{ id: "tool\.area",\s*icon:/, "the pencil is not on the dock");
  assert.match(src, /mountDock\(DOCK_TOOLS,/, "the app no longer mounts that list");
});

test("the name field is genuinely reachable-but-hidden, which is why this matters", () => {
  const btn = html.indexOf('id="btnDrawArea"');
  const input = html.indexOf('id="areaName"');
  assert.ok(btn !== -1 && input !== -1);
  assert.ok(input > btn,
    "the name field no longer sits below the button — if it were above it, the "
    + "precondition would be visible and this guard could be relaxed");
});

test("arming NEVER refuses — drawing comes first, naming after", () => {
  // You cannot name a region whose shape you have not seen, so an area needs no
  // name before it is marked: it gets a default name and the user renames it.
  // Focusing the name field instead only makes the refusal louder.
  //
  // A test pinning the refusal would pin a symptom, and pinning a symptom is how
  // a symptom survives a round of feedback.
  const body = handler('document.getElementById("btnDrawArea").onclick');
  assert.ok(!/if \(!name\)/.test(body),
    "arming still has a name precondition — the button does nothing again");
  assert.ok(!/name the area first/.test(body));
});

test("an unnamed area still gets a name, because areas are found BY NAME", () => {
  // the guarantee that matters: an area is owner ground truth and designs scope
  // to it by name, so one with no name at all would be a region nothing could
  // ever ask about. It gets a default such as `area 6`, not nothing.
  const i2 = src.indexOf('const nameEl = document.getElementById("areaName")');
  assert.notStrictEqual(i2, -1, "the area-naming block is gone — retarget this test");
  const near = src.slice(i2, i2 + 700);
  assert.match(near, /`area \$\{n\}`/, "a blank name produces no default");
  assert.match(near, /while \(taken\.has/, "the default can collide with an existing area");
});

