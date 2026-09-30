// node --test tests/js/every_command_has_a_home.test.mjs
//
// Everything a hotkey does must also be findable by a person clicking the UI, in
// the place UX design puts it; a hotkey is never the only way in.
//
// This is the structural rule rather than a round of patching. ⌘K is a SEARCH
// BOX: it finds what you can already name. A capability whose only home is a
// search box is a capability nobody discovers, and the palette quietly becomes
// the place things go when nobody decides where they belong — including whole
// workflows such as review (eye-level shots, ask what's wrong).
//
// So: a command must be reachable by CLICKING something. The legitimate homes
// are the dock, a dock button's menu, the rail, a panel header's actions, the
// inspector card, the right-click menu, the top bar, or the ··· menu. Anything
// else fails here, which makes a shortcut-only command impossible to ship.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const raw = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const main = raw.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const ctx = fs.readFileSync(path.join(ROOT, "viewer", "src", "shell", "contextmenu.js"), "utf8");
const SURFACES_SRC = fs.readFileSync(
  path.join(ROOT, "viewer", "src", "shell", "surfaces.js"), "utf8");

/** The block of main.js between two anchors, so each home is read exactly. */
const between = (a, b) => {
  const i = main.indexOf(a);
  assert.notStrictEqual(i, -1, `anchor "${a}" is gone — retarget this test`);
  const j = main.indexOf(b, i);
  return main.slice(i, j === -1 ? main.length : j);
};

const REGISTERED = [...main.matchAll(/\{ id: "([a-z]+\.[a-zA-Z]+)",\s*title:/g)].map(m => m[1]);

// the six places a person can CLICK
// the dock's list has one owner — shell/docktools.js, shared with the review sheet
const DOCK = fs.readFileSync(path.join(ROOT, "viewer", "src", "shell", "docktools.js"), "utf8");
assert.ok(/export const DOCK_TOOLS = \[/.test(DOCK) && (DOCK.match(/id: "/g) ?? []).length >= 6, "docktools.js lost its tools — retarget this test");
const RAIL = SURFACES_SRC;
const BAR  = between("onOverflow: ev =>", "onUndo:");
const INSP = between("function selectionActions", "function renderProperties");
// the top bar carries undo/redo as real buttons, wired by callback rather than by
// command id — so the block is searched for the CONTROL they delegate to
const TOPBAR = between("const topBar = mountTopBar({", "const dock = mountDock(DOCK_TOOLS,");
// the rail is a home too, and a surface names its command explicitly so the link
// is in the source rather than in a naming convention a reader has to infer
const HOMES = [
  ["the dock or a dock menu", DOCK],
  ["the rail, or a panel header action", RAIL],
  ["the ··· menu", BAR],
  ["the inspector card", INSP],
  ["the right-click menu", ctx],
  ["the top bar", TOPBAR],
];

test("the audit reads something — the anchors still exist", () => {
  // guard the instrument: if a block came back empty every command below would
  // read as homeless and the failure list would be noise
  assert.ok(REGISTERED.length >= 25, `only ${REGISTERED.length} commands found`);
  for (const [name, block] of HOMES)
    assert.ok(block.length > 80, `${name} read back empty (${block.length} chars)`);
});

test("EVERY command has a place a person can click", () => {
  const homeless = [];
  for (const id of new Set(REGISTERED)) {
    // a command is at home if a clickable surface names it, OR — for undo/redo —
    // if the top bar delegates to the very control the command clicks
    const btn = (main.match(new RegExp(`id: "${id.replace(".", "\\.")}"[^}]*?click\\("(\\w+)"\\)`)) ?? [])[1];
    const found = HOMES.filter(([, block]) =>
      block.includes(`"${id}"`) || (btn && block.includes(`"${btn}"`))).map(([n]) => n);
    if (!found.length) homeless.push(id);
  }
  assert.deepEqual(homeless, [],
    "these are reachable only by ⌘K or a hotkey, which is not an interface:\n  "
    + homeless.join("\n  "));
});

test("a hotkey is a shortcut TO something visible, never the only way in", () => {
  // the distinction that matters: `keys` on a command is fine — it is an
  // accelerator. What is not fine is `keys` being the whole answer.
  const withKeys = [...main.matchAll(/\{ id: "([a-z]+\.[a-zA-Z]+)",[^}]*keys: "/g)].map(m => m[1]);
  assert.ok(withKeys.length >= 4, `only ${withKeys.length} commands carry a key — retarget`);
  for (const id of withKeys) {
    const btn = (main.match(new RegExp(`id: "${id.replace(".", "\\.")}"[^}]*?click\\("(\\w+)"\\)`)) ?? [])[1];
    const clickable = HOMES.some(([, block]) =>
      block.includes(`"${id}"`) || (btn && block.includes(`"${btn}"`)));
    assert.ok(clickable, `${id} has a shortcut and no visible home — the shortcut IS the UI`);
  }
});

test("the review workflow is on screen, split between action and management", () => {
  // The bottom tool bar is for ACTION — adding and drawing things; the left panel
  // is for managing and looking at existing things. BROWSING the shots — and
  // asking what is wrong with them — is the Views surface, and the stills are the
  // only reliable judge of a design, so neither half may be ⌘K-only.
  // Rendering the shots lives in Views too, beside the photos: a separate "see it
  // from inside" button on the dock would conflict with the Views tab, so the dock
  // carries a view picker instead.
  assert.ok(/views:[\s\S]{0,1500}"view\.shots"/.test(RAIL), "photographing the garden has no button in the Views surface");
  assert.ok(!DOCK.includes('"view.shots"'), "the photo walk is back on the dock beside the Views tab");
  assert.ok(DOCK.includes('"view.pick"'), "the dock has no way to go to a saved view");
  assert.ok(RAIL.includes('"design.ask"'), "the critique is not on the Views surface");
  assert.match(RAIL, /views:\s*\{[^}]*"vpList"/, "there is no Views surface to browse");
});

test("the four standard views are NAMED, and live with the viewport chrome", () => {
  // they change how you are LOOKING rather than what exists, so by that rule they
  // belong neither on the action dock nor in the management panel
  for (const id of ["view.top", "view.front", "view.side", "view.iso"])
    assert.ok(TOPBAR.includes(`"${id}"`), `${id} is not on the top bar's camera menu`);
  assert.ok(!/"view\.cycle"/.test(DOCK + TOPBAR), "the blind cycle button is back");
});

test("saving a design and starting one live where the designs are", () => {
  for (const id of ["design.new", "design.saveAs"])
    assert.ok(RAIL.includes(`"${id}"`), `${id} is not an action on the Designs surface`);
});

test("a dock button that opens a menu declares it", () => {
  // otherwise it looks identical to one that acts immediately, and the first
  // click teaches you something you should have been able to see
  const dockJs = fs.readFileSync(path.join(ROOT, "viewer", "src", "shell", "dock.js"), "utf8");
  assert.match(dockJs, /classList\.add\("has-menu"\)/);
  const css = fs.readFileSync(path.join(ROOT, "viewer", "src", "pedon.css"), "utf8");
  assert.match(css, /\.dock-btn\.has-menu::after/, "nothing marks a menu button visually");
});
