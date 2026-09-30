// node --test tests/js/ui_edit_is_honest.test.mjs
//
// Three ways the app can tell the owner something that is not true. Each one
// makes the design hard to modify by hand and basic UI operations unintuitive.
//
//   1. `_down` is set on every pointerdown. Never cleared, it makes the guard
//      `mode === "orbit" && !renderer.domElement._down` — which suppresses hover
//      feedback while the button is held — false forever after the first click
//      of a session. No object lights under the cursor and the pointer never
//      becomes a hand again: the only affordance in the app, dead within seconds.
//
//   2. The write is ALL-OR-NOTHING (tools/site_api.py writes only
//      `if applied and not rejected`, and returns `wrote`). Reporting success
//      per op means a multi-op gesture — align, space evenly, duplicate,
//      multi-drag, or substitute, which is two ops per plant — with one rejection
//      logs a green "ok" for every other op, returns true, and writes nothing.
//
//   3. previewSource is set ONLY by the MCP bridge, when an agent calls
//      preview_design. While set, every hand edit is refused with "Turn the
//      preview off first" — so without a control that turns it off, an agent
//      can strand the owner in a viewer that refuses all their edits.
//
// These are source-level assertions because main.js touches `document` at module
// scope; that is the same way every other ui_* suite here reads it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const api = fs.readFileSync(path.join(ROOT, "tools", "site_api.py"), "utf8");

test("the press flag is cleared on release, so hover feedback survives a click", () => {
  assert.match(main, /_down\s*=\s*\[/, "nothing sets _down — retarget this test");
  assert.match(main, /_down\s*=\s*null/,
    "_down is set and never cleared: the hover highlight and the pointer cursor "
    + "die after the first click of every session");
});

test("it is cleared on pointercancel too, not only on a clean pointerup", () => {
  // a drag interrupted by the OS, a touch turned into a gesture, or a release
  // off-screen: every one of those ends the press without a pointerup on the
  // canvas, and each would otherwise leave the flag stuck
  const cancels = main.match(/addEventListener\("pointercancel"[\s\S]{0,160}?_down\s*=\s*null/);
  assert.ok(cancels, "pointercancel does not clear _down");
});

test("the clear listens on window, so it runs AFTER the canvas reads the flag", () => {
  // registration order decides this: the canvas's own pointerup uses _down to
  // tell a click from a drag. Clearing it on the canvas ahead of that listener
  // would make every click read as a drag and selection would stop working — a
  // fix that breaks the thing it is fixing.
  const clear = main.indexOf('addEventListener("pointerup", () => { renderer.domElement._down = null; })');
  assert.notStrictEqual(clear, -1, "the window-level clear is gone");
  const before = main.slice(0, clear);
  assert.ok(!/renderer\.domElement\.addEventListener\("pointerup"[\s\S]*?_down/.test(before)
            || main.indexOf("const d = renderer.domElement._down") > clear,
    "a canvas pointerup that READS _down is registered after the clear, so the "
    + "click-versus-drag test now always sees null");
});

test("the server still reports whether it wrote, and still writes all-or-nothing", () => {
  // the browser assertion below is only meaningful while this holds
  assert.match(api, /if applied and not rejected/,
    "apply-ops is no longer all-or-nothing — postOps's `wrote` check needs revisiting");
  assert.match(api, /"wrote":\s*wrote/, "apply-ops no longer returns `wrote`");
});

test("postOps reports success from `wrote`, never from `applied`", () => {
  const i = main.indexOf("async function postOps");
  assert.notStrictEqual(i, -1, "postOps is gone — retarget this test");
  const body = main.slice(i, main.indexOf("\n}", i));
  assert.match(body, /out\.wrote/,
    "postOps ignores `wrote`, so a partly-rejected batch logs ok and writes nothing");
  assert.ok(!/return applied\.length > 0;/.test(body),
    "postOps still returns success on `applied`, which is not what reached disk");
});

test("a partly-rejected batch is reported as having written NOTHING", () => {
  const i = main.indexOf("async function postOps");
  const body = main.slice(i, main.indexOf("\n}", i));
  assert.match(body, /NOTHING was written/,
    "a batch with one rejection says nothing about the ops that did not survive it");
});

test("the design errors the server measured are shown, not discarded", () => {
  const i = main.indexOf("async function postOps");
  const body = main.slice(i, main.indexOf("\n}", i));
  assert.match(body, /out\.errors/,
    "apply-ops returns errors[] and the browser drops them, so a hand edit can "
    + "leave an error on disk with nothing on screen saying so");
});

test("previewing offers a way back to the owner's design", () => {
  const i = main.indexOf("function showWhichDesign");
  assert.notStrictEqual(i, -1, "showWhichDesign is gone — retarget this test");
  const body = main.slice(i, main.indexOf("\n}", i));
  assert.match(body, /previewSource\s*=\s*null/,
    "the banner says edits are held and offers no release: only the MCP bridge "
    + "sets previewSource, so nothing the owner can click would ever clear it");
});

test("the escape is a real control, not only a line of text", () => {
  const i = main.indexOf("function showWhichDesign");
  const body = main.slice(i, main.indexOf("\n}", i));
  assert.match(body, /createElement\("button"\)/, "no button is created");
  assert.match(body, /onclick\s*=/, "the escape has no handler");
});

test("the refusal that sends you there still exists", () => {
  // the complement: if the refusal were removed instead of given an exit, a
  // stray click would edit an agent's scratch file, which is the reason it is a
  // refusal rather than a redirect
  assert.match(main, /not while previewing/,
    "the preview write-refusal is gone — a hand edit can now land in an agent's file");
});
