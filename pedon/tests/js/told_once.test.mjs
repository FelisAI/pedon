// node --test tests/js/told_once.test.mjs
//
// Every edit returns the design's WHOLE error list, and an error stays on screen until
// dismissed — so an error the design already carries (a thyme in a Cleveland sage's
// planting hole) would come back as a fresh sticky toast after every edit, stacking
// identical ones. And a refusal would read "rejected — rejected: ...". An error is told
// once per design, again only if it comes back or grows; the word is said once.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newSince } from "../../viewer/src/shell/toast.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const postOps = (() => { const i = main.indexOf("async function postOps"); return main.slice(i, main.indexOf("\n}", i)); })();

test("an error the design already carries is told once, not after every edit", () => {
  const m = new Map();
  const hole = "plants p40 and p45: ... 0.06 m nearer ...";
  assert.deepEqual(newSince(m, "manul", [hole]), [hole]);
  assert.deepEqual(newSince(m, "manul", [hole]), [], "told again after an unrelated edit");
  assert.deepEqual(newSince(m, "manul", [hole, "a new one"]), ["a new one"]);
  assert.deepEqual(newSince(m, "manul", ["plants p40 and p45: ... 0.08 m nearer ..."]).length, 1,
    "a worse error is news");
  assert.deepEqual(newSince(m, "other", [hole]), [hole], "another design has not been told");
  newSince(m, "manul", []);
  assert.deepEqual(newSince(m, "manul", [hole]), [hole], "fixed and back again is news");
});

test("postOps tells design errors through newSince, keyed by the design", () => {
  assert.notEqual(postOps.length, 0, "postOps is gone — retarget this test");
  assert.match(postOps, /newSince\(toldErrors, currentVariant, out\.errors/);
  assert.doesNotMatch(postOps, /for \(const e of out\.errors/, "the raw list is toasted again");
});

test("a refusal says 'rejected' once", () => {
  const line = postOps.split("\n").find(l => l.includes("log(`rejected — "));
  assert.ok(line, "the refusal line is gone — retarget this test");
  const why = "rejected: plants p127 and p142: in one planting hole";
  const shown = `rejected — ${why.replace(/^rejected:\s*/, "")}`;
  assert.match(line, /replace\(\/\^rejected:/, "the server's own 'rejected:' is not stripped");
  assert.equal(shown.match(/rejected/g).length, 1);
});
