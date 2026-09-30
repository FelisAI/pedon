// node --test tests/js/
//
// THE DOCK. Daily tools must be always visible, never scrolled past, labelled,
// clear of the other overlays, showing which mode is live, and driving the SAME
// handler as the control they mirror rather than a second copy of it.
//
// A rail of buttons that each call .click() on a panel button is a whole surface
// whose only content is a reference to another surface. The dock is built from
// the extension registry instead, so a tool contributed by an extension appears
// beside a built-in one with no markup here at all. That is why these tests read
// the DOCK LIST (shell/docktools.js) rather than the markup.
//
// Daily tools — the camera, walking the design, plant maturity — belong on a
// common strip of icon buttons. Buried in the last section of a long scrolling
// panel, a shipped feature goes unfound and gets asked for again. The dock is
// always visible, never scrolled past, and the place the NEXT daily tool goes
// instead of being appended to whatever section happens to be last.
//
// The geometry matters as much as the icons: an overlay that covers a panel
// section (status text over a section header) makes it unclickable, so the dock
// must not overlap the panel or the canvas controls.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = fs.readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");
const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const code = main.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

const rail = () => {
  const m = html.match(/<div id="toolRail"[\s\S]*?<\/div>\s*<!-- \/toolRail -->/);
  assert.ok(m, "no #toolRail in the markup");
  return m[0];
};

const dockList = () => {
  // one owner: the app and the review sheet both mount shell/docktools.js
  assert.match(code, /mountDock\(DOCK_TOOLS,/, "the app no longer mounts the shared dock list — retarget this suite");
  const src = fs.readFileSync(path.join(ROOT, "viewer", "src", "shell", "docktools.js"), "utf8");
  assert.ok((src.match(/id: "/g) ?? []).length >= 6, "docktools.js lost its tools");
  return src;
};

test("there is a dock, and the daily tools live on it", () => {
  const d = dockList();
  for (const id of ["view.walk", "tool.measure", "tool.area", "tool.assets"])
    assert.ok(d.includes(`"${id}"`), `${id} is not on the dock`);
});

test("every tool on it is named, or an icon is a guessing game", () => {
  const d = dockList();
  // TOP-LEVEL ENTRIES ONLY. Some carry a nested `menu: [...]`, and a
  // brace-naive regex stops at the first `}` inside it and reads a menu ITEM as
  // if it were a dock button — which then "has no icon", correctly but
  // uselessly. A dock button is exactly the thing that declares an icon.
  const entries = [...d.matchAll(/\{\s*id:\s*"[^"]+",\s*icon:\s*"([^"]+)",\s*title:\s*"([^"]+)"/g)];
  assert.ok(entries.length >= 4, `only ${entries.length} dock buttons found`);
  for (const [, ico, title] of entries) {
    assert.ok(ico.length, "a dock button has no icon");
    assert.ok(title.length >= 3, `a dock button has no readable name: ${title}`);
  }
  // the name is rendered as a real label and an aria-label, not only a tooltip
  const dock = fs.readFileSync(path.join(ROOT, "viewer", "src", "shell", "dock.js"), "utf8");
  assert.match(dock, /aria-label/, "a dock button is unreadable to a screen reader");
  assert.match(dock, /class = "dock-label"|className = "dock-label"/,
    "the dock renders no visible name for its icons");
});

test("the dock is positioned by a rule in the stylesheet, like every other overlay", () => {
  // main.js must not create positioned elements: ui_no_overlap.test.mjs can only
  // reason about what it can read in CSS
  const css = fs.readFileSync(path.join(ROOT, "viewer", "src", "pedon.css"), "utf8");
  assert.match(css, /#pDock\s*\{[^}]*position:\s*fixed/,
    "the dock has no CSS rule, so no test can check where it sits");
  const hits = [...code.matchAll(/style\.position\s*=\s*["'](fixed|absolute)["']/g)];
  assert.equal(hits.length, 0, "main.js positions an element out of flow");
});

test("it does not sit on top of the panel", () => {
  // the panel is top-left; the dock is bottom-centre. An overlay that covers a
  // panel section makes that section unclickable
  const css = fs.readFileSync(path.join(ROOT, "viewer", "src", "pedon.css"), "utf8");
  const dock = css.match(/#pDock\s*\{([^}]*)\}/)[1];
  assert.match(dock, /bottom:/, "the dock is not anchored to the bottom");
  assert.ok(!/top:\s*\d/.test(dock), "the dock is anchored to the top, where the bar is");
  const bar = css.match(/#pTopBar\s*\{([^}]*)\}/)[1];
  assert.match(bar, /top:\s*0/, "the top bar is not at the top");
});

test("each dock button drives the SAME handler as the control it mirrors", () => {
  // two buttons that each do their own thing are two features to keep in step.
  // The dock runs a COMMAND, and the command delegates to the one existing
  // handler — so there is still no second copy of any action.
  assert.match(code, /onPick: t => commands\.run\(t\.id\)/,
    "the dock has its own actions instead of running commands");
  assert.match(code, /const click = id => \(\) => document\.getElementById\(id\)\?\.click\(\)/,
    "commands no longer delegate to the existing control");
});

test("the dock shows which tool is live", () => {
  assert.match(code, /syncRail\(/, "nothing keeps the tool surface in step with the mode");
  const body = code.slice(code.indexOf("function syncRail"), code.indexOf("function syncRail") + 400);
  assert.match(body, /dockRef\?\.sync\(\)/, "syncRail no longer lights the dock");
  const dock = fs.readFileSync(path.join(ROOT, "viewer", "src", "shell", "dock.js"), "utf8");
  assert.match(dock, /classList\.toggle\("on"/,
    "the dock never lights the active tool, so you cannot see what mode you are in");
});

test("the left rail is really gone, not merely hidden", () => {
  // two tool surfaces is worse than either: the user would see both and have to learn
  // which one is live
  assert.ok(!/id="toolRail"/.test(html), "the old rail markup is still in the page");
  assert.ok(!/railWalk|railMeasure|railArea/.test(code), "main.js still wires the old rail");
});
