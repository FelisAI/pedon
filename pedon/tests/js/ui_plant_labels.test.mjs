// node --test tests/js/ui_plant_labels.test.mjs
//
// Plant labels can be hidden.
//
// With 193 plants the species names are most of what you see from any distance,
// and every judgement about colour, massing or height is made THROUGH them. So
// this is a viewing control, not a cosmetic one.
//
// The trap it has to avoid: hiding "sprites" would also take out the north arrow,
// the landmark pins and the area captions, none of which are plant labels. The
// label carries a tag so the toggle finds exactly its own class.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const design = fs.readFileSync(path.join(ROOT, "viewer", "src", "design.js"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");

test("the control exists where the other layer toggles are", () => {
  assert.match(html, /id="layPlantLabels"/, "no toggle in the panel");
  assert.match(main, /"layPlantLabels"/, "the toggle is not wired to applyLayers");
});

test("a plant label is TAGGED, so the toggle cannot hit the north arrow", () => {
  assert.match(design, /userData\.plantLabel\s*=\s*true/,
    "plant labels are untagged, so hiding them means guessing by sprite type — "
    + "which would also hide the north arrow, the landmark pins and the area names");
  // and the toggle must use the tag rather than a type test
  assert.match(main, /userData\?\.plantLabel/);
  assert.doesNotMatch(main, /isSprite[\s\S]{0,80}layPlantLabels/,
    "the toggle is selecting by sprite type again");
});

test("it reaches the ghosted overlays too", () => {
  // a design shown alongside carries its own labels; hiding only the edited one
  // leaves half the names on screen and looks like the toggle is broken
  const i = main.indexOf("layPlantLabels");
  const near = main.slice(i, i + 700);
  assert.match(near, /overlays/, "overlay designs keep their labels when names are off");
});

test("the choice survives a reload", () => {
  assert.match(main, /localStorage\.setItem\("yardtwin\.layer\." \+ id/,
    "a preference you have to re-set on every reload is not a setting");
  assert.match(main, /localStorage\.getItem\("yardtwin\.layer\." \+ id/);
});

test("it is VIEW state, never written into the design", () => {
  // the rule per-object visibility follows: what you can see is not a
  // property of the garden
  const i = main.indexOf("layPlantLabels");
  const near = main.slice(Math.max(0, i - 400), i + 700);
  assert.doesNotMatch(near, /writeDesignDocument|postOps|apply-ops/,
    "the label toggle is reaching the design file");
});
