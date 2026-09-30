// node --test tests/js/growth_default.test.mjs
//
// Full maturity is the default view. A plan is spaced for the plants GROWN, and
// a viewer that opens at ~5 years makes the same design read as both bare and
// crowded.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = fs.readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");
const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const select = html.slice(html.indexOf('<select id="growthStage"'), html.indexOf("</select>", html.indexOf('<select id="growthStage"')));

test("the yard opens at mature size", () => {
  const selected = [...select.matchAll(/<option value="([\d.]+)"([^>]*)>([^<]*)</g)]
    .filter(m => /\bselected\b/.test(m[2]));
  assert.equal(selected.length, 1, "exactly one stage may be preselected");
  assert.equal(selected[0][1], "1", `the viewer opens at ${selected[0][3].trim()}, not mature`);
});

test("the younger stages are still there — this is a default, not a removal", () => {
  for (const v of ["0.45", "0.7", "1"])
    assert.ok(select.includes(`value="${v}"`), `stage ${v} is gone`);
});

test("the stage you choose survives a reload", () => {
  assert.match(main, /localStorage\.setItem\("yardtwin\.growthStage"|localStorage\.setItem\(GROWTH_KEY/,
    "choosing a stage no longer remembers it");
  assert.match(main, /localStorage\.getItem\(GROWTH_KEY\)/, "the remembered stage is never read back");
  // a stored value that is not one of the options must not be applied
  const block = main.slice(main.indexOf("const GROWTH_KEY"), main.indexOf('document.getElementById("growthStage").onchange'));
  assert.match(block, /options\].some\(o => o\.value === saved\)/, "any string in storage is applied as a growth scale");
});
