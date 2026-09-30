// node --test tests/js/plain_language.test.mjs
//
// Every label says what you GET, not how it works.
//
// A label that is perfectly clear to whoever wrote it can tell the user nothing:
// "eye level shots" does not say what it does, and neither do view buttons named
// after new photos, critique or snap. Words from the implementation creep into
// the vocabulary: a button called `frame`, another called `Detect structures`,
// `Demo splat`, `Check residual`, `live reload`, and tooltips explaining that
// something "is an op".
//
// "op" is the sharpest case and shows why prose review does not catch these. It
// is the correct internal word — one write path, `POST /api/ops`, and this whole
// architecture hangs off it — so it reads as precise to the code's author and as
// nothing at all to the user. A word being RIGHT is not the same as a word being
// readable.
import { resolvePath } from "../../viewer/project_paths.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = f => fs.readFileSync(resolvePath(f), "utf8");   // data/… is the active site's

// Each: the pattern, and what to say instead. The message is half the test —
// a failure that only says "banned word" invites deleting the word rather than
// rewriting the sentence.
const JARGON = [
  [/\bops?\b/i, 'an "op" is our word for a write, not the user\'s — say what is checked and that it undoes'],
  [/\bENU\b/, "ENU is a coordinate frame; the user has metres and compass directions"],
  [/\bgrazing\b/i, 'say where the camera stands ("at the plant\'s own height"), not the preset name'],
  [/\bresidual\b/i, "residual is surveying; say how far off the scale still is"],
  [/\bsplat\b/i, "splat is the capture format; say scan, capture or sample site"],
  [/\blive reload\b/i, 'say what happens: "update when the file changes"'],
  [/\blibrary shape\b/i, 'say "generic shape" — where a model came from is not the user\'s concern'],
  [/\bvalidators?\b/i, "say what is checked, not the name of the thing that checks it"],
  [/\bframe (the|this|it|everything|all|one)\b/i,
   '"frame" is camera jargon — "Zoom to it", "See the whole site"'],
  [/^frame$/i, '"frame" as a button is camera jargon'],
  [/\bdetect structures\b/i, 'say what it finds: "Find walls and structures"'],
  [/\beye-?level shots\b/i, "says where the camera is, not what you get — the user cannot tell what it is"],
];

/** Strings that reach the screen, with enough context to name the offender. */
function visibleStrings() {
  const out = [];
  const html = read("viewer/index.html");
  for (const m of html.matchAll(/<button\b[^>]*>([^<]{1,80})<\/button>/g))
    out.push(["index.html <button>", m[1].trim()]);
  for (const m of html.matchAll(/\b(title|placeholder|aria-label)="([^"]{2,200})"/g))
    out.push([`index.html ${m[1]}=`, m[2]]);
  // labels the shell defines in JS: command titles, menu items, dock buttons
  for (const f of ["viewer/src/shell/contextmenu.js", "viewer/src/shell/dock.js",
                   "viewer/src/shell/topbar.js", "viewer/src/shell/inspector.js",
                   "viewer/src/shell/sidepanel.js", "viewer/src/shell/surfaces.js",
                   "viewer/src/main.js"]) {
    const src = read(f).split("\n")
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");  // a comment is not a label
    for (const m of src.matchAll(/\b(title|label|hint|textContent)\s*[:=]\s*"([^"]{2,200})"/g))
      out.push([`${path.basename(f)} ${m[1]}`, m[2]]);
  }
  return out;
}

test("the sweep finds strings at all — otherwise every assertion below is vacuous", () => {
  const all = visibleStrings();
  assert.ok(all.length > 120, `only ${all.length} visible strings parsed; the extraction is broken`);
  assert.ok(all.some(([, s]) => /Walk the garden/.test(s)), "a known label was not picked up");
  assert.ok(all.some(([w]) => w.startsWith("index.html")), "index.html contributed nothing");
  assert.ok(all.some(([w]) => w.startsWith("main.js")), "main.js contributed nothing");
});

test("no visible label uses a word from the implementation", () => {
  const bad = [];
  for (const [where, s] of visibleStrings())
    for (const [re, why] of JARGON)
      if (re.test(s)) bad.push(`  ${where}: “${s}”\n      ${why}`);
  assert.deepEqual(bad, [], "labels naming a mechanism rather than an outcome:\n" + bad.join("\n"));
});

test("the ban list itself is live — it must reject a sentence I actually shipped", () => {
  // the fixture is the test here: a ban list matching nothing would pass above
  // with the whole vocabulary back in the file
  const shipped = [
    "another one of these, offset — an op, so it is checked and undoable",
    "frame the selection (F)",
    "Detect structures",
    "Demo splat",
    "it goes through the same validators the model's ops do",
  ];
  for (const s of shipped)
    assert.ok(JARGON.some(([re]) => re.test(s)), `the ban list no longer catches: “${s}”`);
});

test("and it does NOT reject the plain words that replaced them", () => {
  // over-banning is its own failure: a test that forbids "open" because it
  // contains "op" would push the next label towards something worse
  for (const s of ["Zoom to it", "See the whole site", "Find walls and structures",
                   "Load the sample site", "Photograph the garden", "Walk the garden",
                   "open the asset window", "options", "Change species",
                   "update when the file changes", "checked against the real ground"])
    assert.ok(!JARGON.some(([re]) => re.test(s)), `the ban list is too broad: it rejects “${s}”`);
});
