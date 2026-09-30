// node --test tests/js/shell.test.mjs
//
// The PEDON shell must make common operations easy to find; a 312 px column
// holding 83 controls is difficult to navigate.
//
// What is tested here is not that a bar exists — it is the handful of decisions
// that would be silently undone by a later edit: the palette must not steal ⌘K
// while the user is naming an area, unavailable commands must not appear in it,
// the shell must never reimplement a handler the app already has, and "previewing"
// must be impossible to miss, because editing confidently into an agent's file
// is the one failure mode the top bar exists to prevent.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCommands, rankCommands, prettyKeys } from "../../viewer/src/shell/commands.js";
import { opensPalette } from "../../viewer/src/shell/palette.js";
import { SURFACES } from "../../viewer/src/shell/surfaces.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SURFACES_SRC = fs.readFileSync(
  path.join(ROOT, "viewer", "src", "shell", "surfaces.js"), "utf8");
const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
// the dock's list has one owner, shared with the review sheet
const DOCK_TOOLS_SRC = fs.readFileSync(path.join(ROOT, "viewer", "src", "shell", "docktools.js"), "utf8");
assert.ok((DOCK_TOOLS_SRC.match(/id: "/g) ?? []).length >= 6, "docktools.js lost its tools — retarget this suite");

const CMDS = [
  { id: "a", title: "Walk the garden", group: "View", run() {} },
  { id: "b", title: "Measure", group: "Tools", run() {} },
  { id: "c", title: "Save this design as…", group: "Design", run() {} },
  { id: "d", title: "Delete selection", group: "Edit", run() {} },
];

test("⌘K is ignored while typing into a field", () => {
  // Shortcuts must respect the active element, as flycam does to keep W A S D
  // from moving the camera while the user types a landmark name. Opening the
  // palette mid-word would interrupt typing in the same way.
  assert.equal(opensPalette({ metaKey: true, key: "k" }, "BODY"), true);
  assert.equal(opensPalette({ ctrlKey: true, key: "k" }, "DIV"), true);
  for (const tag of ["INPUT", "TEXTAREA", "SELECT"])
    assert.equal(opensPalette({ metaKey: true, key: "k" }, tag), false,
      `⌘K fired while focus was in a ${tag}`);
});

test("a bare k, and ⌥⌘K, do not open it", () => {
  assert.equal(opensPalette({ key: "k" }, "BODY"), false);
  assert.equal(opensPalette({ metaKey: true, altKey: true, key: "k" }, "BODY"), false);
});

test("the palette finds a command by its initials, not only by substring", () => {
  // how a palette is actually typed once you know the app
  assert.equal(rankCommands(CMDS, "wtg")[0].title, "Walk the garden");
  assert.equal(rankCommands(CMDS, "sav")[0].title, "Save this design as…");
  assert.equal(rankCommands(CMDS, "meas")[0].title, "Measure");
});

test("a word-start match outranks a match buried mid-word", () => {
  const cmds = [{ id: "x", title: "Unmeasured thing", group: "G", run() {} },
                { id: "y", title: "Measure", group: "G", run() {} }];
  assert.equal(rankCommands(cmds, "measure")[0].title, "Measure");
});

test("a query that matches nothing returns nothing, rather than everything", () => {
  assert.deepEqual(rankCommands(CMDS, "zzzq"), []);
});

test("an empty query lists every command", () => {
  assert.equal(rankCommands(CMDS, "").length, CMDS.length);
  assert.equal(rankCommands(CMDS, "  ").length, CMDS.length);
});

test("a command that does not apply right now is not offered", () => {
  // a palette full of rows that do nothing is a list, not a tool
  const c = createCommands();
  let has = false;
  c.add({ id: "del", title: "Delete selection", when: () => has, run() {} });
  c.add({ id: "walk", title: "Walk", run() {} });
  assert.deepEqual(c.available().map(x => x.id), ["walk"]);
  has = true;
  assert.deepEqual(c.available().map(x => x.id).sort(), ["del", "walk"]);
});

test("a `when` that throws hides the command instead of breaking the palette", () => {
  const c = createCommands();
  c.add({ id: "bad", title: "Bad", when: () => { throw new Error("x"); }, run() {} });
  assert.deepEqual(c.available(), []);
});

test("a duplicate id is refused, so one gesture cannot appear twice", () => {
  const c = createCommands();
  assert.equal(c.add({ id: "one", title: "First", run() {} }), true);
  assert.equal(c.add({ id: "one", title: "Second", run() {} }), false);
  assert.equal(c.all().length, 1);
  assert.equal(c.all()[0].title, "First");
});

test("a malformed command is refused rather than registered half-formed", () => {
  const c = createCommands();
  for (const bad of [null, {}, { id: "x" }, { id: "x", title: "T" }])
    assert.equal(c.add(bad), false);
  assert.equal(c.all().length, 0);
});

test("running an unknown command says so rather than failing silently", () => {
  assert.throws(() => createCommands().run("nope"), /no command nope/);
});

test("shortcuts are shown in the platform's own symbols", () => {
  assert.match(prettyKeys("mod z"), /⌘|Ctrl/);
  assert.match(prettyKeys("mod shift z"), /⇧/);
});

// ── the wiring, which is where a shell usually goes wrong ─────────────────
test("the shell DELEGATES to existing handlers instead of reimplementing them", () => {
  // Commands route to the one handler that already exists. Duplicating five
  // panel buttons on a tool rail creates a second set of controls to maintain.
  const i = main.indexOf("// ── PEDON SHELL");
  assert.ok(i > 0, "the shell block is gone — retarget this test");
  const shell = main.slice(i);
  assert.match(shell, /const click = id => \(\) => document\.getElementById\(id\)\?\.click\(\)/,
    "the shell no longer delegates through a single click helper");
  assert.ok(!/fetch\("\/api\/ops"/.test(shell),
    "the shell posts ops itself — there must be exactly one write path");
});

test("extensions contribute commands into the SAME list as built-ins", () => {
  // otherwise this is a plugin menu, not a plugin system
  const shell = main.slice(main.indexOf("// ── PEDON SHELL"));
  assert.match(shell, /extensions\.get\("commands"\)/,
    "extension commands never reach the palette");
});

test("the surfaces' markup is a STORE, and the store is not a second surface", () => {
  // There must be no classic panel. The rail's surfaces ADOPT elements and
  // hand them back, so their markup needs a home even without a visible panel.
  // #shellStore provides it: hidden, aria-hidden, no header, no positioning
  // rule, and nothing anywhere can open it. Adoption still works and there is
  // exactly ONE place any of this content can appear.
  const html = fs.readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");
  const open = html.indexOf('id="shellStore"');
  assert.ok(open > 0, "no #shellStore — the surfaces have nowhere to adopt from");
  const close = html.indexOf("/#shellStore");
  assert.ok(close > open, "#shellStore is not closed with its marker comment");

  // it is inert markup, not a surface: it must never be shown
  const tag = html.slice(open - 5, html.indexOf(">", open) + 1);
  // `/hidden/` alone matches the "hidden" inside `aria-hidden`, even without
  // the attribute that hides the store. Match the BARE attribute, bounded.
  assert.match(tag, /\shidden[\s>]/,
    "#shellStore is not hidden — it would render as a stray column");
  assert.match(tag, /aria-hidden="true"/, "#shellStore is not hidden from screen readers");

  // every element a surface adopts really is inside it, or adoption finds nothing
  const store = html.slice(open, close);
  for (const [name, s] of Object.entries(SURFACES)) {
    for (const id of s.ids ?? []) {
      assert.ok(store.includes(`id="${id}"`),
        `${name} adopts #${id}, which is not inside #shellStore`);
    }
  }

  // and nothing can turn the store back into a panel
  assert.doesNotMatch(main, /function togglePanel/, "togglePanel still exists");
  assert.doesNotMatch(main, /getElementById\("panel"\)/, "main.js still reaches for #panel");
});

test("previewing is surfaced in the top bar, where the user is always looking", () => {
  const bar = fs.readFileSync(path.join(ROOT, "viewer", "src", "shell", "topbar.js"), "utf8");
  assert.match(bar, /previewing/);
  assert.match(bar, /edits are held/,
    "the top bar does not say that edits are refused while previewing");
  const css = fs.readFileSync(path.join(ROOT, "viewer", "src", "pedon.css"), "utf8");
  assert.match(css, /\.tb-design\.previewing/, "previewing has no visual state");
});

test("the dock is built from the registry, not from markup", () => {
  const dock = fs.readFileSync(path.join(ROOT, "viewer", "src", "shell", "dock.js"), "utf8");
  assert.match(dock, /export function mountDock\(tools/,
    "the dock hardcodes its buttons instead of taking them as data");
});

test("every surface the owner opens daily has a VISIBLE way in", () => {
  // The objects list is a common operation and needs a visible entry. A daily
  // surface reachable only by `o` or ⌘K requires knowing a shortcut in advance.
  //
  // The invariant is A VISIBLE ENTRY, not a dock button. There are two
  // places one can live, and which is right depends on the thing: the dock
  // carries TOOLS (verbs — walk, measure, add), the rail carries SURFACES
  // (places you work — objects, designs). Objects belongs on the rail as a
  // persistent panel.
  const dock = DOCK_TOOLS_SRC;            // one owner: shell/docktools.js
  const surfaces = SURFACES_SRC;
  for (const id of ["tool.assets", "tool.measure", "view.walk"])
    assert.ok(dock.includes(`"${id}"`), `${id} is a TOOL with no dock button`);
  for (const key of ["objects", "design", "places", "views", "view"])
    assert.match(SURFACES_SRC, new RegExp(`${key}:\\s*\\{[^}]*icon:`),
      `the "${key}" surface has no rail icon, so it has no visible entry`);
});

test("no two entries are named so alike that one looks like the other", () => {
  // Calling the ASSET PICKER "Plants and objects" suggests it opens the
  // objects list. Labels must identify the feature they open.
  const dock = DOCK_TOOLS_SRC;
  const dockTitles = [...dock.matchAll(/title: "([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(dockTitles).size, dockTitles.length, "two dock buttons share a title");
  // no dock-side label may READ as a rail surface. "Plants and objects" for
  // the asset picker conflicts with Objects for the list; "Views" (camera
  // angles) beside "View" (display settings) is similarly ambiguous. The
  // reader cannot tell which strip owns the word.
  assert.ok(!dockTitles.some(t => /^plants and objects$/i.test(t)),
    "the asset picker is named as though it opens the objects list");
  // and the rail's labels must not collide with the dock's either — they sit on
  // the same screen and the reader does not know which strip owns which word
  const surfaces = SURFACES_SRC;
  const railTitles = [...SURFACES_SRC.matchAll(/label: "([^"]+)"/g)].map(m => m[1]);
  // compared on a NORMALISED form, because "Views" and "View" are not equal
  // strings and are indistinguishable to a person glancing at two strips
  const norm = t => t.toLowerCase().replace(/[^a-z]/g, "").replace(/s$/, "");
  for (const r of railTitles)
    assert.ok(!dockTitles.some(d => norm(d) === norm(r)),
      `"${r}" is a rail surface and something on the dock is called the same thing`);
});

test("the shortcuts sheet lists the keys that open surfaces", () => {
  // the sheet shows the available actions; a key missing from it is a key
  // nobody finds
  const body = main.slice(main.indexOf("function showShortcuts"));
  for (const k of ["O", "V", "⇧S", "⌘G"])
    assert.ok(body.includes(`"${k}"`), `the sheet never mentions ${k}`);
});

test("a short query does not return junk it merely contains", () => {
  // Matching any ordered subsequence makes "wtg" match four rows: Walk the
  // garden, "Show everything", "View settings" and "Ask what's wrong". The
  // letters w, t and g appear in that order in all four, but the three unrelated
  // results undermine trust in the first row. Match meaningful initials instead.
  const cs = [
    { id: "a", title: "Walk the garden", group: "View", run() {} },
    { id: "b", title: "Show everything", group: "Edit", run() {} },
    { id: "c", title: "View settings", group: "App", run() {} },
    { id: "d", title: "Ask what's wrong", group: "Design", run() {} },
  ];
  const hits = rankCommands(cs, "wtg");
  assert.equal(hits.length, 1, `"wtg" returned ${hits.map(h => h.title).join(", ")}`);
  assert.equal(hits[0].title, "Walk the garden");
});

test("initials are how a palette is typed once you know the app", () => {
  const cs = [{ id: "a", title: "Eye-level shots", group: "View", run() {} },
              { id: "b", title: "Save a screenshot", group: "View", run() {} }];
  assert.equal(rankCommands(cs, "els")[0].title, "Eye-level shots");
});
