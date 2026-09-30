// node --test tests/js/
//
// Moving controls between surfaces is the cheapest way to silently lose one.
// Fit ground, Set north, the span/scale trio, the footprint solve, Demo splat and
// capture loading are one-time calibration controls, kept behind a
// project-settings window rather than on the surface of the daily design loop.
// A move between surfaces is exactly where a button gets dropped, or keeps its
// markup and loses its handler, or keeps its handler and falls out of the
// selector that lights it up.
//
// So this file is structural, in three parts:
//
//   1. INVENTORY — every control id in the frozen inventory exists and is
//      wired to a handler in main.js. Frozen as a literal list, so
//      a deletion fails here rather than being noticed much later in use.
//   2. PLACEMENT — the one-time calibration controls are in the settings
//      surface, the daily loop is on the working panel.
//   3. REACH — setMode() lights the pressed mode button by selector. The
//      data-mode buttons live on more than one surface, so a selector scoped to
//      one container ("#panel button[data-mode]") would leave Set north working
//      but never looking pressed, which is the kind of defect that only shows
//      up with a human at the tab. Asserted against the real ancestor chain,
//      not by eyeballing the string.
//
// main.js cannot be imported (it builds a WebGLRenderer and reads the DOM at
// module scope), so main.js is scanned as source — the same trick
// clean_scene.test.mjs uses. index.html is genuinely parsed instead: "is this
// control inside the settings window" is a containment question, and a regex
// over flat text cannot answer it without inventing an answer.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");
const main = readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");

// ── a very small HTML reader ──────────────────────────────────────────────
// Enough to answer "what is this element, and what is it inside". Not a
// browser: it does not care about text, only about the tag stack, so every
// element carries the ids of its open ancestors.
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img",
  "input", "link", "meta", "param", "source", "track", "wbr"]);

function parseDom(src) {
  const body = src
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
  const els = [];
  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m;
  while ((m = tagRe.exec(body))) {
    const [, closing, rawTag, attrText, selfClose] = m;
    const tag = rawTag.toLowerCase();
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
      continue;
    }
    const attrs = {};
    for (const a of attrText.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
    }
    const el = { tag, id: attrs.id || null, attrs, ancestors: stack.map(s => s.id).filter(Boolean) };
    els.push(el);
    if (!selfClose && !VOID.has(tag)) stack.push({ tag, id: el.id });
  }
  return els;
}

const dom = parseDom(html);
const byId = new Map(dom.filter(e => e.id).map(e => [e.id, e]));
const el = id => {
  const e = byId.get(id);
  assert.ok(e, `no element with id="${id}" in viewer/index.html`);
  return e;
};

/** Is `id` inside the element `container`? */
const inside = (id, container) => el(id).ancestors.includes(container);

// ── the frozen inventory ──────────────────────────────────────────────────
// Every button index.html must keep, in source order.
const BUTTONS = [
  "btnDesignSaveAs", "btnDesignNew", "btnFrameSel", "btnSelGroup", "btnSelClear",
  "btnSelDelete", "btnUndo", "btnRedo", "btnDetect", "btnKeepAll", "btnKeepSure",
  "btnDropAll", "btnMark", "btnDrawArea", "btnFrameAll", "btnTopView", "btnWalk",
  "btnBookmark", "btnGoBookmark", "btnShot", "btnLevel", "btnNorth", "btnSave",
  "btnSpan", "btnApplyScale", "btnCheckSpan", "btnLoadSite", "btnAlign",
  "btnSolveAlign", "btnDemo", "btnDesign", "btnWalkAsk", "btnWalkClose",
  // putting a plant down by hand is a daily action, so it is on the working
  // panel rather than in settings — and in this inventory with it
  "btnPlace",
];

// The controls that are not buttons but hold state a handler reads. Several of
// these (spanLen, spanUnit) are read only at the moment Set scale is pressed,
// so they have no handler of their own and are asserted by presence + use.
const INPUTS = [
  "captureSel", "splatFile", "spanLen", "spanUnit", "chkPoll",
  "growthStage", "layDesign", "laySite", "layHouse", "layScan", "nameBackend",
  "lmName", "areaName", "placeWhat",
];

// One-time-per-property calibration: belongs in project settings.
const CALIBRATION = [
  "btnLevel", "btnNorth", "btnSave", "btnSpan", "spanLen", "spanUnit",
  "btnApplyScale", "btnCheckSpan", "btnLoadSite", "btnAlign", "btnSolveAlign",
  "btnDemo", "captureSel", "splatFile", "btnDesign", "chkPoll",
];

// The daily loop: design, layers, growth stage, framing, walkthrough, places.
const DAILY = [
  "btnDesignSaveAs", "btnDesignNew", "designList",
  "objList", "btnUndo", "btnRedo", "btnFrameSel", "btnSelGroup", "btnSelClear",
  "btnSelDelete", "btnDetect", "btnMark", "btnDrawArea", "lmName", "areaName",
  "layDesign", "laySite", "layHouse", "layScan", "growthStage", "btnFrameAll",
  "btnTopView", "btnWalk", "btnBookmark", "btnGoBookmark", "btnShot",
  "btnPlace", "placeWhat", "btnFly",
];

// ── 0. the reader itself, before anything is asserted with it ─────────────
test("the html reader sees the real document", () => {
  assert.ok(dom.length > 50, `only ${dom.length} elements parsed — the reader is broken`);
  assert.equal(el("shellStore").tag, "div");
  assert.equal(el("btnDesignSaveAs").tag, "button");
  assert.ok(inside("btnDesignSaveAs", "shellStore"),
    "btnDesignSaveAs should be inside #shellStore");
  assert.ok(!inside("shellStore", "shellStore"), "an element is not inside itself");
  assert.ok(!inside("btnDesignSaveAs", "walkOverlay"), "containment must not match everything");
});

// ── 1. inventory: nothing may be dropped by a move ────────────────────────
test("every control that existed is still in the page", () => {
  const buttons = dom.filter(e => e.tag === "button" && e.id).map(e => e.id);
  assert.ok(buttons.length >= BUTTONS.length,
    `${buttons.length} buttons with ids, expected at least ${BUTTONS.length}`);
  for (const id of BUTTONS) assert.equal(el(id).tag, "button", `${id} is no longer a button`);
  for (const id of INPUTS) {
    assert.match(el(id).tag, /^(input|select|textarea)$/, `${id} is no longer an input`);
  }
});

test("every control is still wired to a handler in main.js", () => {
  const missing = BUTTONS.filter(id =>
    !new RegExp(`getElementById\\("${id}"\\)\\s*\\.\\s*(onclick|addEventListener)`).test(main));
  assert.deepEqual(missing, [], "buttons in the page with no handler in main.js");

  const unread = INPUTS.filter(id => !main.includes(`"${id}"`));
  assert.deepEqual(unread, [], "stateful controls nothing in main.js reads");
});

// ── 2. placement: setup off the working surface ───────────────────────────
test("a project-settings surface exists, with a visible way in", () => {
  const settings = el("settings");
  assert.ok(!inside("settings", "shellStore"),
    "the settings window must be its own surface, not inert markup in the store");
  // THE WAY IN is the ··· menu. #btnSettings is the handler target the shell
  // delegates THROUGH rather than the thing the user clicks; what the user
  // clicks is the ··· menu, and the command is what makes it reachable at all.
  assert.ok(inside("btnSettings", "shellStore"),
    "#btnSettings is the delegate target and must live in the store");
  assert.match(main, /id: "app\.settings"/,
    "there is no app.settings command, so nothing can open project settings");
  assert.match(main, /\{ id: "app\.settings", title: "Project settings…"/,
    "project settings is not in the ··· overflow menu — its only way in is a hotkey");
  assert.match(main, /getElementById\("btnSettings"\)\s*\.\s*(onclick|addEventListener)/);
  assert.match(main, /getElementById\("btnSettingsClose"\)\s*\.\s*(onclick|addEventListener)/);
  assert.equal(settings.attrs.hidden, "", "settings starts closed");
});

test("one-time calibration lives in project settings", () => {
  const stillStored = CALIBRATION.filter(id => inside(id, "shellStore"));
  assert.deepEqual(stillStored, [],
    "calibration controls left in the shell store, where nothing can reach them");
  const notMoved = CALIBRATION.filter(id => !inside(id, "settings"));
  assert.deepEqual(notMoved, [], "calibration controls that are in neither surface");
});

test("the daily design loop stays on the working surface", () => {
  // The "working surface" is the shell store the rail's surfaces adopt from — a
  // daily control that is NOT in it has no surface to appear on, which means it
  // cannot be reached at all.
  const lost = DAILY.filter(id => !inside(id, "shellStore"));
  assert.deepEqual(lost, [], "daily controls that no surface can adopt");
  const buried = DAILY.filter(id => inside(id, "settings"));
  assert.deepEqual(buried, [], "daily controls buried in settings");
});

// ── 3. reach: the mode buttons still light up after moving ────────────────
test("setMode lights mode buttons wherever they now live", () => {
  const modeButtons = dom.filter(e => e.attrs["data-mode"]);
  // `measure` is a mode in the same sense as `area`: it takes over the click on
  // the ground, so it has to light up and it has to be switched OFF by setMode
  // when another one starts. So is `pick`, the lasso that selects a section
  // rather than naming one. The count is asserted rather than the list being
  // open-ended, because a mode button that setMode cannot reach is a button that
  // stays lit after you have left it.
  assert.equal(modeButtons.length, 8,
    `expected the 8 mode buttons (landmark, area, measure, north, span, align, place, pick), `
    + `found ${modeButtons.length}`);
  assert.deepEqual(modeButtons.map(e => e.attrs["data-mode"]).sort(),
    ["align", "area", "landmark", "measure", "north", "pick", "place", "span"]);

  // exactly one place decides which mode button looks pressed
  const sels = [...main.matchAll(/querySelectorAll\("([^"]*data-mode[^"]*)"\)/g)].map(m => m[1]);
  assert.equal(sels.length, 1, `mode-button selector written ${sels.length} times: ${sels}`);

  // does that selector reach each button, given where it sits in the document?
  const reaches = (sel, e) => sel.split(",").some(part => {
    const toks = part.trim().split(/\s+/);
    const last = toks.pop();
    if (!/button/.test(last) || !/\[data-mode\]/.test(last)) return false;
    return toks.every(t => t.startsWith("#") && e.ancestors.includes(t.slice(1)));
  });
  const unreached = modeButtons.filter(e => !reaches(sels[0], e)).map(e => e.id);
  assert.deepEqual(unreached, [],
    `mode buttons "${sels[0]}" cannot light: they are outside its scope`);
});

// A comment is not a wiring. A test that asks whether the keydown handler
// mentions "settings" stays GREEN with the branch that closes the window
// deleted, because the comment explaining the branch is still sitting there. So
// every source assertion here runs on code with the prose stripped out.
const codeOnly = s => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("closing settings cannot strand you in an invisible mode", () => {
  // north, span and align are entered from inside the settings window and
  // driven by clicking the ground. Close the window with one of them still on
  // and the button that says so is gone, but the next click on the yard still
  // sets north — so the close path has to drop back to orbit.
  const at = main.indexOf("function showSettings");
  assert.notEqual(at, -1, "showSettings not found in main.js");
  const body = codeOnly(main.slice(at, main.indexOf("\n}", at)));
  assert.match(body, /setMode\("orbit"\)/,
    "closing the settings window leaves a calibration mode armed");
});

test("Escape closes the settings window", () => {
  // FIND THE HANDLER THAT HANDLES ESCAPE, not "the first keydown listener".
  // Slicing from the first occurrence breaks as soon as another keydown listener
  // sits ABOVE it (the ⌘ orbit-modifier binding, a one-liner, matches first) —
  // the fixed-window source-slice fault, wearing "first occurrence" instead of
  // "next 1400 chars".
  const blocks = [];
  for (let i = main.indexOf('addEventListener("keydown"'); i !== -1;
       i = main.indexOf('addEventListener("keydown"', i + 1)) {
    const end = main.indexOf("\n});", i);
    blocks.push(codeOnly(main.slice(i, end === -1 ? i + 4000 : end)));
  }
  assert.ok(blocks.length, "no keydown handler found in main.js");
  const block = blocks.find(b => /escape/i.test(b));
  assert.ok(block, `no keydown handler mentions Escape (${blocks.length} searched)`);
  assert.match(block, /showSettings\(\s*false\s*\)/,
    "Escape does not close the settings window");

  // The call being PRESENT is not the same as the call being REACHABLE. With the
  // guard replaced by `else if (false) showSettings(false)` — Escape can never
  // close the window — every assertion above still passes. A source test cannot
  // execute the handler, so at least check that the branch guarding the call is
  // a real condition about the window and not a literal.
  const call = block.indexOf("showSettings(false)") >= 0
    ? block.indexOf("showSettings(false)") : block.search(/showSettings\(\s*false\s*\)/);
  const guard = block.slice(0, call);
  const lastIf = Math.max(guard.lastIndexOf("if ("), guard.lastIndexOf("if("));
  assert.ok(lastIf >= 0, "showSettings(false) is not inside a branch at all");
  const cond = guard.slice(lastIf, guard.indexOf(")", lastIf) + 1);
  assert.doesNotMatch(cond, /\(\s*(false|0)\s*\)/,
    `Escape's branch is a dead literal, so the window can never be closed: ${cond}`);
  assert.match(cond, /settings/i,
    `Escape's branch does not test the settings window: ${cond}`);
});

// ── 5. the two "look at my garden" controls must be reachable ─────────────
test("walking and maturity are at the TOP, not four sections down", () => {
  // Walking in the design with the free camera and choosing one global maturity
  // (default 70%) are how the user looks at the garden. Built, tested and
  // documented but placed in the last section of a long scrolling panel, they
  // would never be found. Built-and-invisible is the same failure as
  // built-and-not-connected.
  //
  // "Above the fold" cannot be measured from markup, so the proxy is ORDER: these
  // two appear before the first <section>, in the strip under the title.
  const firstSection = html.indexOf("<section");
  assert.notEqual(firstSection, -1, "no sections at all; fix this test");
  for (const id of ["btnFly", "growthStage"]) {
    const at = html.indexOf(`id="${id}"`);
    assert.notEqual(at, -1, `${id} is gone`);
    assert.ok(at < firstSection,
      `${id} sits inside a collapsible section — the user scrolls past it and never finds it`);
  }
});

test("the daily list knows the free camera is daily", () => {
  assert.ok(DAILY.includes("btnFly"),
    "btnFly is not treated as a daily control, so nothing stops it being buried again");
});
