// node --test tests/js/last_camera.test.mjs
//
// A reload starts at the view the user was last at, not at a default view.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLastCamera } from "../../viewer/src/shell/navigate.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CAP = "/data/captures/yard.glb";
const saved = { pos: [12.5, 3.2, -4], target: [15, -1.8, 6.5], capture: CAP };

test("the camera you left is the camera you get", () => {
  assert.deepEqual(readLastCamera(JSON.stringify(saved), CAP), { pos: saved.pos, target: saved.target });
});

test("a camera taken over a different capture is not restored", () => {
  assert.equal(readLastCamera(JSON.stringify(saved), "/data/captures/other.ply"), null);
});

test("junk in storage is ignored rather than flinging the camera", () => {
  for (const raw of [null, "", "{", "[]", JSON.stringify({ pos: [1, 2], target: [0, 0, 0], capture: CAP }),
                     JSON.stringify({ ...saved, pos: [1, NaN, 2] }),
                     JSON.stringify({ ...saved, target: saved.pos })])
    assert.equal(readLastCamera(raw, CAP), null, `restored from ${raw}`);
});

test("boot restores it before the bookmark, and only then starts remembering", () => {
  const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
  const boot = main.slice(main.indexOf("async function boot()"), main.indexOf("\nboot();"));
  const restore = boot.indexOf("const cameraBack = restoreLastCamera();");
  assert.notEqual(restore, -1, "boot never puts the camera back where it was");
  assert.ok(restore < boot.indexOf("await loadScanGrid()"), "the camera is put back only after the yard has loaded");
  assert.ok(boot.indexOf("if (cameraBack)") < boot.indexOf("goToBookmark()"), "the old bookmark still wins over where the user was");
  assert.ok(boot.indexOf("cameraRemembering = true") > restore,
    "remembering starts before the restore, so boot's own framing overwrites the camera to restore");
  assert.match(main, /controls\.addEventListener\("change", \(\) => \{\s*if \(!cameraRemembering/,
    "moving the camera no longer remembers it");
});
