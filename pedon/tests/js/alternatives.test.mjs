// node --test tests/js/alternatives.test.mjs
//
// TWO PROPOSALS FOR ONE CORNER — the browser half.
//
// `tools/alternatives.py` is the other half, and the two are cross-checked
// below: a resolver that disagreed across the language boundary would draw the
// user one garden and measure another, which is the exact class objects_index.py is
// cross-checked against node for.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { activeDesign, alternativeSets, chosenAlternative, inactiveIds }
  from "../../viewer/src/design_doc.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");

const doc = () => ({
  plants: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
  groups: [{ id: "gravel", name: "gravel court", members: ["p1"], alt_of: "east" },
           { id: "planted", name: "planted", members: ["p2"], alt_of: "east" }],
  alternatives: { east: "gravel" },
});

test("only the chosen proposal is drawn", () => {
  assert.deepEqual(activeDesign(doc()).plants.map(p => p.id), ["p1", "p3"]);
});

test("an undeclared choice is still ONE garden", () => {
  const d = doc(); d.alternatives = {};
  assert.deepEqual(activeDesign(d).plants.map(p => p.id), ["p1", "p3"],
    "a design that names proposals and forgets to choose drew both");
  const bad = doc(); bad.alternatives = { east: "nope" };
  assert.deepEqual(activeDesign(bad).plants.map(p => p.id), ["p1", "p3"]);
});

test("an object in BOTH proposals survives", () => {
  const d = doc();
  d.groups[0].members = ["p1", "p3"];
  d.groups[1].members = ["p2", "p3"];
  assert.ok(activeDesign(d).plants.some(p => p.id === "p3"),
    "the object the two proposals AGREE on was deleted with the loser");
});

test("a design with no proposals is handed back untouched", () => {
  const d = { plants: [{ id: "p1" }], groups: [] };
  assert.equal(activeDesign(d), d, "the common case pays for a feature it does not use");
});

test("the losing group goes too, so the tree shows no empty proposal", () => {
  assert.deepEqual(activeDesign(doc()).groups.map(g => g.id), ["gravel"]);
});

// ── the two languages must agree ─────────────────────────────────────────
test("the python resolver and this one answer the same", () => {
  // THE FAILURE THIS CATCHES IS THE WORST KIND: the user is shown one garden and the
  // validator, composition and the design agent measure another, with both
  // halves internally consistent and no error anywhere.
  const cases = [
    doc(),
    { ...doc(), alternatives: { east: "planted" } },
    { ...doc(), alternatives: {} },
    { plants: [{ id: "a" }], groups: [{ id: "solo", members: ["a"] }] },
    { plants: [{ id: "a" }, { id: "b" }],
      groups: [{ id: "x", members: ["a", "b"], alt_of: "s" },
               { id: "y", members: ["b"], alt_of: "s" }],
      alternatives: { s: "y" } },
  ];
  const script = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "tools"))})
import alternatives as A
for d in json.load(sys.stdin):
    print(json.dumps(sorted(A.inactive_ids(d))))
`;
  const out = execFileSync("python3", ["-c", script],
    { input: JSON.stringify(cases), encoding: "utf8" }).trim().split("\n");
  cases.forEach((d, i) => {
    const js = [...inactiveIds(d)].sort();
    assert.deepEqual(js, JSON.parse(out[i]),
      `case ${i}: the browser drops ${JSON.stringify(js)} and python drops ${out[i]}`);
  });
});

// ── the wiring, where this would actually go wrong ───────────────────────
test("the WHOLE document is kept; only the BUILD sees one proposal", () => {
  // `currentDesign` is stored in the timeline and written straight back by
  // restore, so a resolved copy landing there would delete the proposal the user
  // did not choose — the same asymmetry site_api._design() exists for.
  const at = main.indexOf("async function loadDesign");
  const body = main.slice(at, main.indexOf("\nlet siteCache", at));
  assert.match(body, /currentDesign = design;/,
    "currentDesign is set from something other than the whole document");
  assert.match(body, /const drawn = activeDesign\(design\)/, "nothing resolves for the build");
  assert.ok(!/currentDesign = drawn|tlPush\(drawn\)/.test(body),
    "a RESOLVED design reaches the timeline or the write path — restoring it "
    + "would delete the other proposal from disk");
  assert.match(body, /buildDesignGroup\(colourFromPalette\(drawn\)/,
    "the build draws the whole document, so both proposals appear in the yard");
});

test("switching proposals is written to the DOCUMENT, not to localStorage", () => {
  // HIDING draws the line the other way, and the distinction is the point:
  // which proposal the user is looking at would be view state; which one the
  // design CLAIMS is what every measurement and the design agent must agree on,
  // and that cannot live in one browser.
  const at = main.indexOf("async function chooseAlternative");
  assert.ok(at > 0, "nothing switches proposals");
  const body = main.slice(at, main.indexOf("\n}", at));
  assert.ok(!/localStorage/.test(body),
    "the live proposal is remembered per browser, so python measures a different garden");
  assert.match(body, /saveAlternatives/, "the choice never reaches the document");
});

test("both halves of the decision are written together", () => {
  // a set declared in one write and chosen in another leaves a moment where the
  // document names proposals with none chosen
  const at = main.indexOf("async function saveAlternatives");
  const body = main.slice(at, main.indexOf("\n}", at));
  assert.match(body, /writeDesignDocument\(\{ groups, alternatives \}/,
    "groups and the choice are written separately");
  assert.ok(!/fetch\("\/api\/ops"/.test(body), "a second write path");
});

test("the proposals control is hidden unless the design has proposals", () => {
  const at = main.indexOf("function renderAlternatives");
  const body = main.slice(at, main.indexOf("\n}\n", at));
  assert.match(body, /box\.hidden = !sets\.size/,
    "an empty proposals row sits above the object list on every design");
});
