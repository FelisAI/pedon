// node --test tests/js/
//
// A group belongs to its design, and a CLIPBOARD is how anything crosses.
//
// Two requirements that are one request: groups are specific to a design, not
// shared between designs, and something copied in one design can be pasted into
// another. A design switch that copies the outgoing grouping into the incoming
// design is the wrong shape: grouping should not VANISH and it should not BLEED.
// Explicit copy/paste satisfies both; an implicit copy on every switch satisfies
// neither.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const code = main.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

function fnBody(name, span = 2400) {
  const i = code.search(new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`));
  assert.notEqual(i, -1, `${name} not found`);
  return code.slice(i, i + span);
}

test("the clipboard stores RECORDS, never ids", () => {
  // An id means nothing outside the design it came from: next_id recycles freed
  // ones, so a stale id can re-bind a hidden group onto unrelated plants.
  // Copying ids across a design boundary would be that bug with a wider blast
  // radius.
  const body = fnBody("copySelection");
  assert.match(body, /items\.push\(\{ kind: found\.kind, raw: found\.raw \}\)/,
    "the clipboard is storing something other than the object itself");
  assert.doesNotMatch(body, /items\.push\(id\)|items\.push\(\{ id/,
    "the clipboard is storing ids, which do not survive leaving their design");
});

test("it outlives the design you were in", () => {
  // the whole point: copy in one design, switch, paste. localStorage, because a
  // reload in between is normal.
  assert.match(code, /const CLIP_KEY = "yardtwin\.clipboard"/, "no clipboard key");
  assert.match(fnBody("copySelection"), /localStorage\.setItem\(CLIP_KEY/,
    "the clipboard does not survive leaving the design");
  assert.match(fnBody("readClipboard", 400), /localStorage\.getItem\(CLIP_KEY/);
});

test("paste mints new ids through the ordinary ops path", () => {
  // not a second write path, and not invented ids: duplicateOps already knows
  // that a plant copy is a PLACE and that place_plants mints the id server-side
  const body = fnBody("pasteClipboard");
  assert.match(body, /duplicateOps\(kind, raw/, "paste does not reuse the duplicate path");
  assert.match(body, /postOps\(ops/, "paste writes by some route other than /api/ops");
  assert.match(body, /snapshotWorking\(\)/, "a paste is not archived, so it cannot be undone");
});

test("paste offsets rather than using the other design's coordinates", () => {
  // another yard's coordinates are meaningless here; the same yard's are on top
  // of the original
  assert.match(fnBody("pasteClipboard"), /const dx = 0\.8, dy = 0\.8/,
    "paste drops things at the coordinates they had in the design they came from");
});

test("an empty clipboard says so instead of doing nothing", () => {
  assert.match(fnBody("pasteClipboard"), /the clipboard is empty/,
    "pressing paste with nothing copied is silent");
});

test("⌘C still copies TEXT when text is selected", () => {
  // the panel is full of names and ids the user may want to copy as words; stealing
  // ⌘C outright would be a regression dressed as a feature
  const i = code.indexOf('ev.key === "c" || ev.key === "C"');
  assert.notEqual(i, -1, "no copy hotkey");
  assert.match(code.slice(i, i + 260), /getSelection\(\)\?\.toString\(\)/,
    "the copy hotkey fires even when the user is copying text");
});
