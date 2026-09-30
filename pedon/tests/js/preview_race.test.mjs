// node --test tests/js/
//
// preview_design must not answer until the design it names is actually loaded.
//
// setPreviewSource() returns loadDesign()'s promise. A previewOp that drops it
// replies "now rendering X" while the scene still holds the PREVIOUS design, and
// every render that follows — look, walk_through, a float check — sees the old
// one and says nothing about it. A design agent can then call `look` many times
// and reason about somebody else's garden each time, having never looked at what
// it designed.
//
// Walking two designs back to back exposes the race — both walks return the
// FIRST design's paths. Measured against the live viewer, with the promise
// dropped:
//     preview usable_v3 -> walkthrough stations: garden_walk, north_return   (curved_v1's!)
//     preview curved_v1 -> walkthrough stations: garden_walk, north_return
//   and with it awaited:
//     preview usable_v3 -> walk_dining_to_firepit, walk_kitchen_to_dining
//     preview curved_v1 -> garden_walk, north_return
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = fs.readFileSync(path.join(ROOT, "viewer", "src", "viewport.js"), "utf8");

// Comments dropped LINE BY LINE, not with the /\*...\*\/ regex the other suites
// use. That idiom is unsafe on this file and silently eats real code:
// viewport.js contains the string "only data/*.json paths", and the `/*` inside
// it opens a block-comment match that runs to the next `*/`, taking previewOp's
// body with it. The test would then fail against correct source — the same
// class of wrongness as a green test over a live bug, pointing the other way.
const code = src.split("\n")
  .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join("\n");

test("previewOp waits for the design to load before it answers", () => {
  const i = code.search(/async function previewOp\s*\(/);
  assert.notEqual(i, -1,
    "previewOp is not async, so it cannot wait for the design it just asked for");
  const body = code.slice(i, code.indexOf("\n}", i));
  assert.match(body, /await\s+ctx\.setPreviewSource\(/,
    "previewOp drops the promise setPreviewSource returns — it reports success "
    + "before the scene holds the design, and every render after it sees the old one");
});

test("the dispatcher waits for previewOp", () => {
  // an async op whose promise the caller throws away is the same bug one level up
  assert.match(code, /cmd\.op === "preview" \? await previewOp\(/,
    "the render dispatch does not await previewOp");
});

test("every async op in the dispatch chain is awaited", () => {
  // the chain is a ternary, so a missing await is invisible: the op returns a
  // Promise and `r.error`/`r.data` are both undefined on it, which reads to the
  // caller as a successful render with no data rather than as a mistake
  const chain = code.slice(code.indexOf("const r = cmd.op ==="),
                           code.indexOf("body = r.error"));
  assert.ok(chain.length > 40, "the dispatch chain moved; fix this parse");
  for (const m of chain.matchAll(/\?\s*(\w+)\(cmd, full\)/g)) {
    const fn = m[1];
    const isAsync = new RegExp(`async function ${fn}\\s*\\(`).test(code);
    if (isAsync) {
      assert.fail(`${fn} is async and the dispatch calls it without await`);
    }
  }
  for (const m of chain.matchAll(/await (\w+)\(cmd, full\)/g)) {
    assert.match(code, new RegExp(`async function ${m[1]}\\s*\\(`),
      `${m[1]} is awaited but is not async — a harmless await hides a real one`);
  }
});

test("walkthrough shares the prepared review used by look and export", () => {
  assert.match(code, /return ctx\.withReview\(full\.design, async group =>/);
  assert.match(code, /await execute\(\{ \.\.\.full, designGroup: \(\) => group \}\)/);
  // Mature growth, awaited assets, restore-on-error and nonzero yaw are exercised
  // through the production builder and dispatcher in review_scene.test.mjs.
});
