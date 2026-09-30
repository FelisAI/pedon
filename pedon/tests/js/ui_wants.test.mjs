// node --test tests/js/ui_wants.test.mjs
//
// A missing model must be a WORK ITEM, not an invisible downgrade.
//
// `kind` is free text, so a design can ask for
// a pagoda, a koi pond or a tea house; objects.js builds what it can, draws a
// marked placeholder for what it cannot, and records the rest as a WANT. The
// viewer must call `objects.wants()` to make the want list visible. Objects must
// also appear in the object list, support selection and carry measurements;
// otherwise a placeholder box is the owner's only trace of the requested model.
//
// So this suite is about the last step: the viewer says, unprompted, what the
// design asked for that nothing could build, WHERE it stands, and that it is not
// modelled yet.
//
// Three things are pinned:
//   1. the ROWS — what/how many/where — built from objects.js's own classifier
//      rather than a second copy of the kind matcher living in the viewer;
//   2. the WIRING — it is rebuilt with the design, so a want cannot go stale or
//      sit in dead code;
//   3. the GEOMETRY — it must not become a floating overlay that blocks clicks
//      on the Scene section (tests/js/ui_no_overlap.test.mjs). That test reads CSS rules out of
//      index.html; this element is created in main.js and has no CSS rule to
//      read, so its no-overlap check has to live here, against the source that
//      builds it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pointInPolygon } from "../../viewer/src/areas.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const html = readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");

// objects.js pulls in three (and design.js), which resolve from viewer/src —
// the same route tests/js/objects.test.mjs takes rather than a second copy of
// the dependency. The canvas shim is design.js's label sprites.
globalThis.document = {
  createElement() {
    const ctx = { fillStyle: "#000", fillRect() {}, fillText() {}, measureText: () => ({ width: 10 }),
                  beginPath() {}, arc() {}, fill() {}, stroke() {}, createLinearGradient: () => ({ addColorStop() {} }) };
    return { width: 0, height: 0, getContext: () => ctx };
  },
};
const objects = await import(path.join(ROOT, "viewer", "src", "objects.js"));
const designJs = await import(path.join(ROOT, "viewer", "src", "design.js"));

// ── extraction ────────────────────────────────────────────────────────────
// main.js cannot be imported (a WebGLRenderer at module scope), so the pure part
// is sliced between markers and evaluated — the trick ui_place / ui_palette /
// ui_groups already use. Both markers asserted found, in order, and the slice
// asserted non-trivial: indexOf can return -1, and slice(-1) is the file's LAST
// CHARACTER, so a regex check on that slice can pass without checking the code.
function block(start, end, min) {
  const a = main.indexOf(start), b = main.indexOf(end);
  assert.notEqual(a, -1, `${start} missing from main.js — nothing was extracted`);
  assert.notEqual(b, -1, `${end} missing from main.js — nothing was extracted`);
  assert.ok(b > a, `${start} / ${end} are in the wrong order`);
  const s = main.slice(a + start.length, b);
  assert.ok(s.length > min, `the block after ${start} is only ${s.length} chars`);
  return s;
}
const api = new Function(
  `${block("// ── WANTS-START ──", "// ── WANTS-END ──", 200)}\n return { wantRows };`)();

const codeOnly = s => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

function blockEnd(s, from) {
  const open = s.indexOf("{", from);
  assert.notEqual(open, -1, "no block found");
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") { depth--; if (!depth) return i + 1; }
  }
  assert.fail("unbalanced braces while slicing main.js");
}
function fnBody(anchor) {
  const at = main.search(new RegExp(`(async\\s+)?function\\s+${anchor}\\s*\\(`));
  const i = at !== -1 ? at : main.indexOf(anchor);
  assert.notEqual(i, -1, `${anchor} not found in main.js — this test is slicing nothing`);
  const body = codeOnly(main.slice(i, blockEnd(main, i)));
  assert.ok(body.length > 60, `${anchor} is only ${body.length} chars — nothing was extracted`);
  return body;
}

// ── the fixture ───────────────────────────────────────────────────────────
// Two kinds the library really can build and two it really cannot, checked
// against objects.js rather than assumed — a fixture that shares its assumptions
// with the code proves nothing.
const AREA = { name: "retaining_wood", polygon: [[10, -8], [16, -8], [16, -3], [10, -3]] };
const placeOf = (x, y) => (pointInPolygon(x, y, AREA.polygon) ? AREA.name : null);
const DESIGN = {
  objects: [
    { id: "o1", kind: "stone lantern", position: [2, 1], height_m: 1.4 },
    { id: "o2", kind: "pagoda", position: [12.35, -6.12], width_m: 2 },
    { id: "o3", kind: "pagoda", position: [1.02, 3.04] },
    { id: "o4", kind: "tea house", position: [-4.55, 7.5] },
    { id: "o5", kind: "bench", position: [0, 0] },
  ],
};
const rows = (design = DESIGN, place = placeOf) => api.wantRows(design, { wants: objects.wants, placeOf: place });
const rowFor = kind => {
  const r = rows().find(x => x.kind === kind);
  assert.ok(r, `no want row for ${kind}`);
  return r;
};

// ══ 0. the premise ════════════════════════════════════════════════════════
test("the fixture is two buildable kinds and two the library cannot build", () => {
  assert.ok(objects.resolveKind("stone lantern"), "premise: a lantern IS modelled");
  assert.ok(objects.resolveKind("bench"), "premise: a bench IS modelled");
  assert.equal(objects.resolveKind("pagoda"), null, "premise: a pagoda is NOT modelled");
  assert.equal(objects.resolveKind("tea house"), null, "premise: a tea house is NOT modelled");
  assert.ok(objects.resolveKind("moon gate"),
    "premise check: a moon gate IS modelled, so it is not a want");
  assert.equal(typeof api.wantRows, "function", "wantRows did not come out of main.js");
  assert.equal(typeof objects.PLACEHOLDER_COLOUR, "number",
    "objects.js does not export the colour it paints a placeholder — the panel would have to "
    + "re-type the hex, and a second copy of a constant can drift");
});

// ══ 1. THE ROWS ═══════════════════════════════════════════════════════════
test("one row per unmodelled kind, and nothing for what was built", () => {
  // counts and identities before content: a want list that quietly drops the
  // kind it cannot classify still renders a tidy little panel
  const r = rows();
  assert.equal(r.length, 2, `${r.length} rows for two unmodelled kinds`);
  assert.deepEqual(r.map(x => x.kind).sort(), ["pagoda", "tea house"]);
  assert.equal(r.reduce((n, x) => n + x.count, 0), 3, "the three unmodelled objects are not all counted");
  assert.equal(rowFor("pagoda").count, 2);
  assert.equal(rowFor("tea house").count, 1);
});

test("a row says WHAT was asked for and that it is not modelled yet", () => {
  // the owner's words, not a slug: `kind` is free text on purpose and the row is
  // the only place they see what the design actually asked for
  assert.equal(rowFor("pagoda").label, "pagoda · 2 asked for · not modelled yet");
  assert.equal(rowFor("tea house").label, "tea house · 1 asked for · not modelled yet");
});

test("a row says WHERE it stands — the drawn area if it is in one, always the metres", () => {
  // "where" is the half that makes it actionable. A name the owner gives the ground beats
  // two numbers, and the numbers are still there because an area only covers part
  // of the yard. o2 is inside retaining_wood, o3 is not.
  assert.equal(rowFor("pagoda").where, "in retaining_wood · at 12.4, -6.1 and 1 more");
  assert.equal(rowFor("tea house").where, "at -4.6, 7.5");
  // with no areas drawn at all it still answers, in metres
  assert.equal(rows(DESIGN, () => null).find(x => x.kind === "tea house").where, "at -4.6, 7.5");
  assert.equal(rows(DESIGN, () => null).find(x => x.kind === "pagoda").where,
    "at 12.4, -6.1 and 1 more");
});

test("the ids travel, so the row can take the user to it", () => {
  assert.deepEqual(rowFor("pagoda").ids, ["o2", "o3"]);
  assert.deepEqual(rowFor("tea house").ids, ["o4"]);
  assert.deepEqual(rowFor("pagoda").points, [[12.35, -6.12], [1.02, 3.04]]);
});

test("an object with no position is still reported, honestly", () => {
  // it is drawn at [0,0] by objectMesh's own fallback, and pretending to know
  // where it is would be worse than saying nobody placed it
  const r = api.wantRows({ objects: [{ id: "x", kind: "tea house" }] },
                         { wants: objects.wants, placeOf });
  assert.equal(r.length, 1);
  assert.equal(r[0].count, 1);
  assert.match(r[0].where, /no position/i, `"${r[0].where}" claims to know where it is`);
});

test("a design with nothing missing produces nothing at all", () => {
  // a professional tool is quiet when there is nothing to say
  assert.deepEqual(api.wantRows({ objects: [{ id: "o", kind: "bench", position: [0, 0] }] },
                                { wants: objects.wants, placeOf }), []);
  assert.deepEqual(api.wantRows({}, { wants: objects.wants, placeOf }), []);
  assert.deepEqual(api.wantRows(null, { wants: objects.wants, placeOf }), []);
});

// ══ 2. THE WIRING ═════════════════════════════════════════════════════════
// A row builder with zero callers cannot show the user what is missing.
test("the viewer asks objects.js what is missing, rather than deciding for itself", () => {
  const code = codeOnly(main);
  assert.match(code, /import\s*\{[^}]*\bwants\b[^}]*\}\s*from\s*["']\.\/objects\.js["']/,
    "main.js does not import wants from objects.js — a second copy of the kind matcher in the "
    + "viewer can disagree with the object builder");
  assert.doesNotMatch(code, /lantern\|ishidoro|resolveKind\s*=/,
    "main.js has grown its own copy of the kind aliases");
  assert.ok(fnBody("renderWants").includes("wantRows("), "renderWants does not build the rows");
});

test("the want list is rebuilt with the design, so it can never go stale", () => {
  assert.match(fnBody("renderObjectList"), /renderWants\(/,
    "nothing rebuilds the want list when the design changes — it would show the previous yard's "
    + "missing models, or never appear at all");
});

test("the row names the place through the ONE point-in-polygon in the viewer", () => {
  const body = fnBody("renderWants");
  assert.match(body, /pointInPolygon|placeOf/,
    "renderWants does not name the area a want stands in");
  assert.match(codeOnly(main), /import\s*\{[^}]*pointInPolygon[^}]*\}\s*from\s*["']\.\/areas\.js["']/,
    "pointInPolygon is not the shared one — duplicate ray-crossing tests can "
    + "disagree about which area contains an object");
  assert.doesNotMatch(fnBody("renderWants"), /yi\s*>\s*y\)\s*!==|crossing/,
    "a duplicate ray-crossing test is being written inside renderWants");
});

test("clicking a row takes the user to the thing", () => {
  // "where" answered properly: the panel says the metres, and the click puts the
  // camera on it. objectMesh stamps userData.id, so the nodes are findable.
  const body = fnBody("renderWants");
  assert.match(body, /onclick/, "the row is not clickable");
  assert.match(body, /frameBox\(|frameSelection\(|objectsFor\(/,
    "clicking the row does not frame the object — the owner is left to find it by eye");
});

// ══ 3. THE GEOMETRY — it stays in the panel's flow ════════════════════════
test("the want strip lives in the panel's flow, not in another floating overlay", () => {
  const body = fnBody("renderWants");
  assert.doesNotMatch(body, /position\s*[:=]\s*["']?\s*(fixed|absolute)/,
    "the want list is positioned out of the panel's flow and can cover "
    + "the Scene section, blocking clicks "
    + "(tests/js/ui_no_overlap.test.mjs)");
  assert.doesNotMatch(body, /z-?index|zIndex/i,
    "an element that wins the stacking order can cover the panel");
  assert.match(body, /objList/,
    "the strip is not attached beside the object list, which is where the owner already reads "
    + "what is in this design");
});

test("main.js still creates no fixed overlay of its own", () => {
  // the whole file, not just this feature: index.html owns every fixed overlay
  // (#panel, #status, #settings, #walkOverlay) and ui_no_overlap.test.mjs can
  // only reason about the ones it can read there.
  const hits = [...codeOnly(main).matchAll(/style\.position\s*=\s*["'](fixed|absolute)["']/g)];
  assert.equal(hits.length, 0,
    `main.js positions ${hits.length} element(s) out of flow — index.html owns the overlays, and `
    + "an overlay with no CSS rule is one ui_no_overlap.test.mjs cannot check");
});

test("the strip is painted the placeholder's own amber, defined once", () => {
  // the box in the yard and the note in the panel have to read as the same fact,
  // and a re-typed hex would drift the first time either is tuned
  const body = fnBody("renderWants");
  assert.match(body, /PLACEHOLDER_COLOUR/,
    "the strip re-types the placeholder colour instead of importing it from objects.js");
  assert.match(codeOnly(main), /import\s*\{[^}]*PLACEHOLDER_COLOUR[^}]*\}\s*from\s*["']\.\/objects\.js["']/,
    "PLACEHOLDER_COLOUR is not imported from objects.js");
  assert.doesNotMatch(body, /#?b98b4a/i, "the amber is written out by hand in main.js as well");
});

// ══ 4. it has to be VISIBLE, and stacked ══════════════════════════════════
test("the want row is styled, and does not inherit .row's flex", () => {
  // .row is `display: flex; flex-wrap: wrap`, so the two lines a want row is
  // made of — what was asked for, and where it stands — would sit side by side
  // and read as one run-on sentence. A strip with no rule of its own is not a
  // neutral default here; it is the wrong layout.
  assert.match(html, /\.row\.want\s*\{[^}]*display:\s*block/,
    "no .row.want rule overriding the flex — the two lines run together");
  assert.match(html, /\.row\.want\s*\{[^}]*cursor:\s*pointer/,
    "the row is clickable in main.js and does not say so to the pointer");
  assert.match(html, /\.row\.want:hover/, "no hover state — it does not read as interactive");
});

// ══ 5. materials are wants too ════════════════════════════════════════════
test("a material nobody modelled reaches the same want list", () => {
  // Path/patio/edge material is free text so the library does not cap the design.
  // That requires any downgrade to be
  // VISIBLE: a brick path silently drawn as aggregate, with the owner told
  // nothing, is the invisible substitution the want list exists to prevent —
  // and the validator's warning goes to the MODEL, which is the wrong audience
  // for deciding whether to request a missing model.
  const d = {
    paths: [{ id: "walk", spline: [[12.4, -6.1], [13, -4]], width_m: 1.2, material: "brick" },
            { id: "spine", spline: [[1, 1], [2, 2]], width_m: 1.2, material: "gravel" }],
    patios: [{ id: "court", polygon: [[1, 1], [3, 1], [3, 3], [1, 3]], material: "pebble_mosaic" }],
    edges: [{ id: "wall", spline: [[1, 1], [2, 2]], height_m: 0.4, material: "stone" }],
  };
  const rows = designJs.materialWants(d);
  const kinds = rows.map(r => r.kind).sort();
  assert.deepEqual(kinds, ["brick paving", "pebble_mosaic paving"],
    `unmodelled materials not reported as wants: ${JSON.stringify(rows)}`);
  const brick = rows.find(r => r.kind === "brick paving");
  assert.deepEqual(brick.ids, ["walk"], "the row cannot take the owner to the path");
  assert.equal(brick.count, 1);
  assert.deepEqual(designJs.materialWants({}), [], "an empty design wants nothing");
  assert.deepEqual(designJs.materialWants(null), []);
});

test("the viewer shows material wants beside the object ones", () => {
  // A reporter must be called for its output to reach the user.
  const body = fnBody("renderWants");
  assert.match(body, /materialWants/,
    "renderWants asks objects.js what is missing but never asks design.js");
  assert.match(codeOnly(main), /import\s*\{[^}]*materialWants[^}]*\}\s*from\s*["']\.\/design\.js["']/,
    "materialWants is not imported from design.js, so a second copy of the "
    + "surface table is about to be written in main.js");
});
