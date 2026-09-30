// node --test tests/js/ui_write_paths.test.mjs
//
// One write path for design.json, and edits go through the validators.
//
// Hand PLACEMENT and DRAGGING emit an op and post it to /api/ops, so the owner's
// gestures are judged by the same agent.execute() + validate() a model op is.
// DELETE must too: it is an EDIT, not a document load, and deleting is not as
// safe as it looks — removing a retaining wall leaves the terrace it held
// standing on nothing, which is precisely the class float_check exists to catch.
//
// A delete that writes data/design.json itself also invites a plainer bug: it
// filters a hand-typed key list — beds/paths/patios/plants/edges — which does
// not include `steps`, so deleting a flight of steps silently does nothing.
// agent.execute's remove_objects iterates DESIGN_KEYS, so routing delete through
// the op avoids the omission by not having a second list at all.
//
// The other writes (group save, timeline restore, variant switch, clear) REPLACE
// the document rather than authoring an edit, and must stay able to load a design
// that already has errors — many saved designs do. They go through one guarded
// helper instead, so there is a single place that knows how a design reaches
// disk.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");

/** The body of a named function or arrow assigned at top level. */
function bodyOf(anchor) {
  const i = src.indexOf(anchor);
  assert.notStrictEqual(i, -1, `anchor "${anchor}" is gone — retarget this test`);
  const open = src.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) return src.slice(i, j + 1); }
  }
  throw new Error("unbalanced braces");
}

test("the anchors this file depends on still exist", () => {
  // assert the SAMPLE before the property: every check below is a source scan,
  // and a scan whose anchor moved passes by finding nothing
  assert.ok(src.includes("btnSelDelete"), "the delete handler is gone");
  assert.ok(src.includes("/api/ops"), "the op endpoint call is gone");
  assert.ok(src.length > 50000, "main.js looks truncated");
});

test("delete goes through the op path, not a direct write", () => {
  const body = bodyOf('document.getElementById("btnSelDelete").onclick');
  assert.match(body, /remove_objects/,
    "delete does not emit a remove_objects op — a hand edit is bypassing the validators");
  assert.doesNotMatch(body, /writeJson\s*\(\s*["']data\/design\.json/,
    "delete still writes design.json directly");
});

test("delete does not carry its own list of design keys", () => {
  const body = bodyOf('document.getElementById("btnSelDelete").onclick');
  assert.doesNotMatch(body, /\["beds",\s*"paths"/,
    "a second hand-typed key list — this is how `steps` got missed; let " +
    "agent.DESIGN_KEYS be the only one");
});

test("design.json reaches disk through exactly one helper", () => {
  const calls = [...src.matchAll(/writeJson\s*\(\s*["']data\/design\.json["']/g)];
  const helper = bodyOf("async function writeDesignDocument");
  const inHelper = [...helper.matchAll(/writeJson\s*\(\s*["']data\/design\.json["']/g)].length;
  assert.strictEqual(inHelper, 1, "the helper should hold the one write");
  assert.strictEqual(calls.length, 1,
    `design.json is written from ${calls.length} places; it should be one — ` +
    `everything else calls writeDesignDocument()`);
});
