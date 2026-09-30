// node --test tests/js/sidepanel.test.mjs
//
// The lists — objects, designs, places — get a surface of their own instead of
// being sections of a permanent column. Opening the objects list is one of the
// most common actions, so it must always have a way in.
//
// The design decision under test is ADOPTION: the surface MOVES the existing
// elements in rather than re-drawing them. `renderObjectList` already draws a
// tree with fold, hide, lock, rename and hover-highlight, all of it tested, and
// re-authoring it would have meant re-earning every one of those behaviours.
//
// Which makes the return trip the thing that can silently break: if a node is
// not put back where it came from, the classic panel is left with a hole and the
// next render writes into an orphan.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mountSidePanel } from "../../viewer/src/shell/sidepanel.js";
import { contextItemsFor } from "../../viewer/src/shell/contextmenu.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SURFACES_SRC = fs.readFileSync(
  path.join(ROOT, "viewer", "src", "shell", "surfaces.js"), "utf8");
const mainRaw = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
// COMMENTS STRIPPED before any source scan. A comment that explains why a call
// is NOT used contains the name of that call, and an assertion looking for its
// absence then fails on the explanation. The other ui_* suites read main.js
// the same way.
const main = mainRaw.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const html = fs.readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");

/** The smallest DOM the side panel touches — also the SPEC of what it may use.
 *  A panel reaching for anything richer than this fails here, which keeps it
 *  portable and keeps the test honest about the surface it is exercising. */
function fakeDom() {
  const mk = tag => {
    const cls = new Set();
    const el = {
      tag, children: [], dataset: {}, hidden: false, _text: "", style: {},
      classList: {
        add: c => cls.add(c), remove: c => cls.delete(c),
        contains: c => cls.has(c),
        toggle: (c, on) => (on === undefined ? (cls.has(c) ? cls.delete(c) : cls.add(c))
                                             : on ? cls.add(c) : cls.delete(c)),
      },
      get className() { return [...cls].join(" "); },
      set className(v) { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => cls.add(c)); },
      get textContent() { return this._text; },
      set textContent(v) { this._text = String(v); },
      get parentElement() { return el._parent ?? null; },
      appendChild(c) {
        if (c._parent) c._parent.children = c._parent.children.filter(x => x !== c);
        c._parent = el; el.children.push(c); return c;
      },
      append(...cs) { cs.forEach(c => el.appendChild(c)); },
      setAttribute() {}, getAttribute: () => null,
      set innerHTML(v) { if (v === "") { el.children.forEach(c => { c._parent = null; }); el.children = []; } },
    };
    return el;
  };
  const body = mk("body");
  global.document = { createElement: mk, body, getElementById: () => null };
  return { mk, body };
}

const SURFACES = {
  objects: { label: "Objects", icon: "▤", ids: ["objList"] },
  design:  { label: "Designs", icon: "◈", ids: ["designList"] },
};

function withDom(fn) {
  const { mk } = fakeDom();
  return fn(mk);
}

test("it adopts a node and gives it back when the surface changes", () => {
  const { mk } = fakeDom();
  const homeA = mk("div"), homeB = mk("div");
  const a = mk("div"); a.id = "objList"; homeA.appendChild(a);
  const b = mk("div"); b.id = "designList"; homeB.appendChild(b);
  global.document.getElementById = id => (id === "objList" ? a : id === "designList" ? b : null);

  const side = mountSidePanel({ surfaces: SURFACES });
  side.show("objects");
  assert.notEqual(a.parentElement, homeA, "the node was not adopted");
  side.show("design");
  assert.equal(a.parentElement, homeA,
    "switching surfaces stranded the first one's node — the markup it came from "
    + "is left with a hole and the next render writes into an orphan");
  side.hide();
  assert.equal(b.parentElement, homeB);
});

test("the rail has an entry per surface, and it stays when the panel collapses", () => {
  // every surface needs a permanent entry on the UI, and an entry that
  // disappears when you close the panel is not one
  const { mk } = fakeDom();
  global.document.getElementById = () => null;
  const side = mountSidePanel({ surfaces: SURFACES });
  const btns = side.rail.children.filter(c => c.tag === "button");
  assert.equal(btns.length, Object.keys(SURFACES).length, "the rail is missing a surface");
  side.show("objects");
  side.hide();
  assert.equal(side.rail.children.filter(c => c.tag === "button").length, btns.length,
    "collapsing the panel removed the entries too");
});

test("clicking the open surface collapses it", () => {
  const { mk } = fakeDom();
  global.document.getElementById = () => null;
  const side = mountSidePanel({ surfaces: SURFACES });
  side.toggle("objects");
  assert.equal(side.current(), "objects");
  side.toggle("objects");
  assert.equal(side.current(), null, "pressing the same entry twice did not close it");
});

test("what was open is remembered and restored", () => {
  // a persisted panel has to still be there when you come back
  const store = {};
  global.localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
  const { mk } = fakeDom();
  global.document.getElementById = () => null;
  mountSidePanel({ surfaces: SURFACES }).show("design");

  const { mk: mk2 } = fakeDom();
  global.document.getElementById = () => null;
  const again = mountSidePanel({ surfaces: SURFACES });
  assert.equal(again.current(), null, "it opened before restore() was called");
  again.restore();
  assert.equal(again.current(), "design", "the panel did not come back to where it was");
});

test("a remembered surface that no longer exists does not break the panel", () => {
  // THE GUARD THAT MATTERS IS IN show(), NOT restore(). Mutating restore()'s
  // `surfaces?.[want]` check leaves this green, because show() refuses an unknown
  // id anyway — a test of restore() alone passes for a reason other than the line
  // it is aimed at. Asserting the behaviour AND that show() itself refuses keeps
  // it pointed at the real invariant.
  const store = { "pedon.side": "a-surface-that-was-removed" };
  global.localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
  fakeDom();
  global.document.getElementById = () => null;
  const side = mountSidePanel({ surfaces: SURFACES });
  side.restore();
  assert.equal(side.current(), null);
  assert.equal(side.show("also-not-a-surface"), false,
    "show() accepts an unknown surface, so the panel can open onto nothing");
  assert.equal(side.current(), null);
});

test("a missing element is skipped rather than crashing the surface", () => {
  const { mk } = fakeDom();
  const home = mk("div"); const real = mk("div"); home.appendChild(real);
  global.document.getElementById = id => (id === "objList" ? real : null);
  const side = mountSidePanel({ surfaces: { objects: { label: "O", ids: ["objList", "gone"] } } });
  side.show("objects");
  assert.equal(side.isOpen(), true);
  side.hide();
  assert.equal(real.parentElement, home);
});

// ── the wiring ───────────────────────────────────────────────────────────
test("objects, designs and places each name real elements", () => {
  const spec = SURFACES_SRC;
  assert.ok(spec.length > 40, "the surface table is gone");
  for (const id of [...spec.matchAll(/"([a-zA-Z]+)"\]/g)].map(m => m[1]))
    assert.ok(html.includes(`id="${id}"`), `the surface table names #${id}, which is not in the page`);
});

test("the same command closes the surface it opened", () => {
  // a toggle, because pressing `o` twice to get back to the yard is what anyone
  // expects and re-opening the same list is never what they meant. The decision
  // lives INSIDE the persistent panel — openPanelAt just forwards.
  const body = main.slice(main.indexOf("function openPanelAt"),
                          main.indexOf("function showShortcuts"));
  assert.match(body, /sidePanel\.toggle\(which\)/,
    "openPanelAt no longer toggles, so opening the open surface reopens it");
});

test("the empty state does not point at a control that is not there", () => {
  // "describe what you want above" points at a brief box that is not on screen.
  // A hint pointing at something that is not on screen is worse than no hint.
  assert.ok(!/describe what you want above/.test(main),
    "the objects empty state still points at the removed brief box");
});

// ── acting on a GROUP, not only on the object you clicked ─────────────────
test("right-clicking something in a group offers the group", () => {
  // right-clicking a stone in a triad and being offered only that stone is the
  // same mistake solo would have made by dropping the other two: the group is
  // what was composed
  const g = { id: "grp_1", name: "Stone triad", members: ["o1", "o2", "o3"] };
  const ids = contextItemsFor({ kind: "object", id: "o1" }, { group: g })
    .filter(i => i !== "-").map(i => i.id);
  for (const id of ["group.select", "group.hide", "group.solo", "group.ungroup"])
    assert.ok(ids.includes(id), `${id} is not offered for a grouped object`);
});

test("the group's own name is on the menu, so it is clear what is being acted on", () => {
  const g = { id: "grp_1", name: "Stone triad", members: ["o1"] };
  const sel = contextItemsFor({ kind: "object", id: "o1" }, { group: g })
    .find(i => i.id === "group.select");
  assert.match(sel.title, /Stone triad/);
  // and an unnamed group falls back to its id rather than showing "undefined"
  const anon = contextItemsFor({ kind: "object", id: "o1" }, { group: { id: "grp_2", members: ["o1"] } })
    .find(i => i.id === "group.select");
  assert.match(anon.title, /grp_2/);
});

test("an ungrouped object is offered no group actions", () => {
  const ids = contextItemsFor({ kind: "object", id: "o1" }, { group: null })
    .filter(i => i !== "-").map(i => i.id);
  assert.ok(!ids.some(id => id.startsWith("group.")), "group actions offered with no group");
});

test("the group is captured when the menu OPENS, not when an item is clicked", () => {
  // by click time the selection may be several things, and "the group of the
  // first one" is a different group from the one whose name is on the menu
  const body = main.slice(main.indexOf("const ctxMenu = mountContextMenu"));
  assert.match(body, /const g = lastRightGroup/,
    "the handler looks the group up again instead of using what was shown");
  assert.match(main, /lastRightGroup = found \?/, "nothing captures the group at open time");
});

test("hiding a group uses applyLayers, the same pass its own eye uses", () => {
  // a group hides its own NODE; per-object visibility is a separate pass. Two
  // ways of applying one state drift apart and can leave a thing undeletable.
  // Read to the end of the BRANCH, not a fixed window: slicing a character
  // count reports a violation that does not exist as soon as the function it
  // is reading grows.
  const i = main.indexOf('it.id === "group.hide"');
  assert.notStrictEqual(i, -1, "the group.hide branch is gone — retarget this test");
  const branch = main.slice(i, main.indexOf('else if (it.id === "group.solo")', i));
  assert.ok(branch.length > 40 && branch.length < 900, `branch read was ${branch.length} chars`);
  assert.match(branch, /applyLayers\(\)/,
    "group hide uses a different visibility pass from the group eye");
  assert.ok(!/applyObjectVisibility/.test(branch),
    "group hide also runs the per-object pass — two ways of applying one state");
});

test("view settings are one surface, because they are all one question", () => {
  // the sun, plant maturity, render detail and the five layer toggles are all
  // questions about the PICTURE rather than about the design
  const spec = SURFACES_SRC;
  // SPLIT BY THE QUESTION EACH ANSWERS, not lumped into one strip: the sun, how
  // plants are drawn, what is shown, and how editing behaves are four different
  // questions, not one row of mixed checkboxes.
  for (const id of ["sunRow", "growthRow", "qualityRow", "layerRow", "editRow"]) {
    assert.ok(SURFACES_SRC.includes(`"${id}"`), `the Display surface does not adopt #${id}`);
    assert.ok(html.includes(`id="${id}"`), `#${id} is not in the page`);
  }
});

test("every surface the shell offers is reachable by a command", () => {
  // a surface with no way in is a surface nobody finds
  const spec = SURFACES_SRC;
  const keys = [...spec.matchAll(/^\s{2}(\w+):\s*\{/gm)].map(m => m[1]);
  assert.ok(keys.length >= 4, `only ${keys.length} surfaces found`);
  for (const k of keys)
    assert.match(main, new RegExp(`openPanelAt\\("${k}"\\)`),
      `the "${k}" surface has no command that opens it`);
});

test("Places can CREATE, not only list", () => {
  // a surface that shows what exists but cannot add to it sends you straight
  // back to the panel, which is the trip the surfaces exist to remove
  const spec = SURFACES_SRC;
  const places = spec.slice(spec.indexOf("places:"), spec.indexOf("\n", spec.indexOf("places:") + 60));
  for (const id of ["lmNewRow", "areaName"])
    assert.ok(spec.includes(`"${id}"`), `Places cannot reach #${id}, so nothing can be added`);
});

test("undo and redo are in the top bar, with where you are", () => {
  // in plain sight, not down a panel. Undo without a position is a leap of faith
  const bar = fs.readFileSync(path.join(ROOT, "viewer", "src", "shell", "topbar.js"), "utf8");
  assert.match(bar, /tb-undo/); assert.match(bar, /tb-redo/);
  assert.match(bar, /setHistory\(text\)/, "the bar cannot show the timeline position");
  assert.match(main, /onUndo: \(\) => document\.getElementById\("btnUndo"\)\?\.click\(\)/,
    "the bar's undo does not route to the one that already exists");
  assert.match(main, /topBar\.setHistory/, "nothing ever fills in the position");
});

test("every control left in the shell store is reachable some other way", () => {
  // THE TEST THAT SAYS THE SHELL IS COMPLETE. There is no classic panel to fall
  // back on, so a control stranded in the shell store is genuinely unreachable —
  // there is no other column to open — and anything this test lets through is
  // a feature the user has lost.
  const open = html.indexOf('<div id="shellStore"');
  assert.ok(open > 0, "no #shellStore — retarget this test");
  const body = html.slice(open, html.indexOf("/#shellStore"));
  const adopted = [...SURFACES_SRC.matchAll(/"([a-zA-Z]+)"/g)].map(m => m[1]);
  // ids inside an adopted container travel with it.
  //
  // DEPTH-COUNTED, not a character slice. Slicing "until a blank line or 1400
  // chars" reports a nested control as stranded; reading source by a fixed
  // window produces confident wrong answers. Walk the tags instead.
  const contentsOf = id => {
    const open = body.indexOf(`id="${id}"`);
    if (open < 0) return [];
    const start = body.lastIndexOf("<", open);
    const tag = /^<(\w+)/.exec(body.slice(start))?.[1];
    if (!tag) return [];
    if (body.slice(start, body.indexOf(">", start) + 1).endsWith("/>")) return [];
    let depth = 0, i = start;
    const re = new RegExp(`<${tag}\\b|</${tag}>`, "g");
    re.lastIndex = start;
    let m, end = body.length;
    while ((m = re.exec(body))) {
      depth += m[0][1] === "/" ? -1 : 1;
      if (depth === 0) { end = m.index; break; }
    }
    return [...body.slice(start, end).matchAll(/id="([^"]+)"/g)].map(x => x[1]);
  };
  const inAdopted = new Set();
  for (const id of adopted) for (const child of contentsOf(id)) inAdopted.add(child);
  // GUARD THE INSTRUMENT. If the reader cannot see a child it is known to
  // contain, every "stranded" result below is noise. growthStage is inside
  // #viewStrip; renderQuality deliberately is NOT — it sits in its own row,
  // #qualityRow, and this assertion checks the reader can see it there.
  assert.ok(inAdopted.has("renderQuality"),
    "the containment reader cannot see renderQuality inside #qualityRow — it is "
    + "broken, and every 'stranded' result below would be noise");

  // WIRED BY A COMPUTED ID, which no source-text scan can see. These four are
  // reached by `getElementById("view" + which[0].toUpperCase() + which.slice(1))`
  // over ["top","front","side","iso"], and each also has a named command. Listed
  // explicitly with the reason rather than loosening the check, so the exemption
  // is visible to a reader instead of being a hole in the regex.
  const COMPUTED = { viewTop: "view.top", viewFront: "view.front",
                     viewSide: "view.side", viewIso: "view.iso" };
  for (const [id, cmd] of Object.entries(COMPUTED))
    assert.ok(main.includes(`id: "${cmd}"`),
      `${id} is exempted because it is wired by a computed id AND has the command `
      + `${cmd} — but that command is gone, so it is now genuinely stranded`);

  const stranded = [];
  for (const m of body.matchAll(/<(?:button|select|input)[^>]*id="([^"]+)"/g)) {
    const id = m[1];
    if (inAdopted.has(id)) continue;
    if (main.includes(`click("${id}")`) || main.includes(`getElementById("${id}")?.click()`)) continue;
    if (main.includes(`"${id}"`)) continue;      // named in a surface or handler
    if (id in COMPUTED) continue;
    stranded.push(id);
  }
  assert.deepEqual(stranded, [],
    `these controls exist only inside the shell store, which nothing can open: ${stranded.join(", ")}`);
});
