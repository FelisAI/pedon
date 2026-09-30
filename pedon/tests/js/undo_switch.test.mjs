// node --test tests/js/
//
// THE SWITCH THAT EATS A DESIGN.
//
// Clicking a name in the Saved list replaces the working design wholesale.
// `snapshotWorking()` archives it first, and that is not enough: click a saved
// variant over a working design twice and the design flips back and forth in
// seconds, and the user who wants the lost version back cannot find it — without
// a way back, recovering it means hashing archives against variants. The
// snapshot that would answer it in one click is already on disk — the archive is
// not the missing part. The WAY BACK is.
//
// So these tests are about the seam, not the archive: the stamp has to travel
// from the snapshot to a control the user can see and press.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const code = main.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

function fnBody(name, span = 2600) {
  const i = code.search(new RegExp(`function\\s+${name}\\s*\\(`));
  assert.notEqual(i, -1, `${name} not found`);
  return code.slice(i, i + span);
}

test("snapshotWorking hands back the stamp, not just success", () => {
  // the whole fix rides on this: a boolean says the archive happened and gives
  // the caller no way to name the file it happened into
  const body = fnBody("snapshotWorking", 900);
  assert.match(body, /\?\s*stamp\s*:/,
    "snapshotWorking returns a bare boolean again — nothing downstream can name "
    + "the archive it wrote, so the undo has no file to read");
});

test("switching to a saved design offers the way back", () => {
  const body = fnBody("loadVariant", 900);
  assert.match(body, /const stamp = await snapshotWorking\(\)/,
    "loadVariant throws the stamp away");
  assert.match(body, /offerUndoSwitch\(stamp/,
    "the archive is taken and then forgotten — the user is left with no way back "
    + "to the design that was clicked over");
});

test("restoring a version from History offers it too", () => {
  // the History restore button replaces the working design by the same
  // mechanism, so it fails the same way; fixing only the Saved list would leave
  // half the hole open
  const i = code.indexOf("restore a version");
  assert.notEqual(i, -1, "the History restore handler moved; fix this test");
  const body = code.slice(Math.max(0, i - 400), i + 400);
  assert.match(body, /offerUndoSwitch\(stamp/,
    "restoring a version still replaces the working design with no way back");
});

test("the undo is a control on screen, in the line that says what you are editing", () => {
  // a UI defect is invisible in source by definition, so this only asserts the
  // control is BUILT and attached; that it is legible and lands in the right
  // place is checked by pressing it in the running viewer
  const body = fnBody("rebuildDesignList", 6000);
  assert.match(body, /if \(undoSwitch\)/, "nothing renders the offer");
  assert.match(body, /cur\.appendChild\(back\)/,
    "the undo control is built and never attached to the status line");
  assert.match(body, /data\/history\/design-\$\{u\.stamp\}\.json/,
    "the undo does not read the archive it was handed");
});

test("undoing is itself undoable — it snapshots before it overwrites", () => {
  // the design being replaced BY the undo is still a design someone may have
  // meant to keep; a one-way undo is a second way to lose work, not a fix
  const i = code.indexOf("undo the switch");
  assert.notEqual(i, -1, "the undo handler moved; fix this test");
  const body = code.slice(Math.max(0, i - 500), i + 300);
  assert.match(body, /await snapshotWorking\(\)/,
    "pressing undo discards the current design with no archive of its own");
});
