// node --test tests/js/shell_interaction.test.mjs
//
// The interaction model: no dangling console; right-click does something to the
// world; objects, places and versions open by name; the user can find out which
// tools exist; and W A S D moves the camera while just viewing, as in a 3D editor.
//
// The pure decisions are tested here because each is invisible until it is wrong
// at an edge, and each would be re-broken by an innocent-looking edit.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rightUpIntent, movesCamera, speedFor, isMoveKey } from "../../viewer/src/shell/navigate.js";
import { contextItemsFor } from "../../viewer/src/shell/contextmenu.js";
import { formatHistory } from "../../viewer/src/shell/toast.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");

// ── right-drag looks, right-click menus ──────────────────────────────────
test("a small wobble is a CLICK, not a drag", () => {
  // a 3 px shake while clicking a mouse is normal. A menu that refuses to open
  // for it reads as a broken button, and this is the whole subtlety of putting
  // both gestures on the same button — which is what Unity and Unreal do too.
  assert.equal(rightUpIntent({ x: 100, y: 100 }, { x: 102, y: 101 }), "menu");
  assert.equal(rightUpIntent({ x: 100, y: 100 }, { x: 100, y: 100 }), "menu");
});

test("a real drag is a look, and never opens the menu", () => {
  assert.equal(rightUpIntent({ x: 100, y: 100 }, { x: 140, y: 130 }), "looked");
  assert.equal(rightUpIntent({ x: 100, y: 100 }, { x: 100, y: 120 }), "looked");
});

test("a release with no press is neither", () => {
  assert.equal(rightUpIntent(null, { x: 0, y: 0 }), "none");
});

// ── WASD any time ────────────────────────────────────────────────────────
test("WASD moves the camera without entering a mode", () => {
  for (const k of ["w", "a", "s", "d", " ", "c", "ArrowUp"])
    assert.equal(movesCamera({ key: k }, "BODY"), true, `${k} does not move the camera`);
});

test("WASD does NOT move the camera while typing", () => {
  // otherwise W A S D moves the camera while the user types a landmark name
  for (const tag of ["INPUT", "TEXTAREA", "SELECT"])
    assert.equal(movesCamera({ key: "w" }, tag), false, `w moved the camera inside a ${tag}`);
});

test("a modifier means a shortcut, not movement", () => {
  // otherwise ⌘S strafes while trying to save
  for (const mod of ["metaKey", "ctrlKey", "altKey"])
    assert.equal(movesCamera({ key: "s", [mod]: true }, "BODY"), false);
});

test("a letter that is not a movement key is left alone", () => {
  assert.equal(isMoveKey("q"), false);
  assert.equal(movesCamera({ key: "k" }, "BODY"), false);
});

test("fly speed is geometric, so both ends of the yard are usable", () => {
  // a linear scale spends most of its travel in the wrong half: the useful range
  // runs from a centimetre nudge when placing a stone to a stride when crossing
  const slow = speedFor(-8), mid = speedFor(0), fast = speedFor(8);
  assert.ok(slow < mid && mid < fast, `${slow} ${mid} ${fast} is not monotonic`);
  assert.ok(slow >= 0.25 && fast <= 40, "speed leaves the usable band");
  assert.ok(fast / mid > 3, "the fast end is not meaningfully faster");
  assert.equal(speedFor(999), speedFor(14), "speed is not clamped at the top");
});

// ── right-click on the world ─────────────────────────────────────────────
test("bare ground offers what you can do to ground", () => {
  const ids = contextItemsFor(null).filter(i => i !== "-").map(i => i.id);
  assert.ok(ids.includes("place.here"));
  assert.ok(ids.includes("tool.measure"));
  assert.ok(!ids.includes("edit.delete"), "ground offered a delete");
});

test("changing species is offered for a plant and never for a bed", () => {
  // offering it for a bed is an action that can only log a refusal — the same
  // reason btnSubstitute is disabled for one
  const plant = contextItemsFor({ kind: "plant", id: "p1" }).filter(i => i !== "-").map(i => i.id);
  const bed = contextItemsFor({ kind: "bed", id: "b1" }).filter(i => i !== "-").map(i => i.id);
  assert.ok(plant.includes("sel.substitute"));
  assert.ok(!bed.includes("sel.substitute"));
});

test("delete is marked dangerous so it does not look like the others", () => {
  const del = contextItemsFor({ kind: "bed", id: "b1" }).find(i => i.id === "edit.delete");
  assert.equal(del.danger, true);
});

test("every context id is a command or is handled explicitly", () => {
  // a menu entry that resolves to nothing is a button that does nothing
  const handled = ["place.here", "sel.frame", "sel.hide", "sel.substitute"];
  // every shape of menu, so a branch cannot be added without being handled
  const ids = [...contextItemsFor(null),
               ...contextItemsFor({ kind: "plant", id: "p" }, { hasSelection: true }),
               ...contextItemsFor({ kind: "bed", id: "b" }, { hasSelection: true, multi: true })]
    .filter(i => i !== "-").map(i => i.id);
  for (const id of new Set(ids))
    assert.ok(handled.includes(id) || main.includes(`id: "${id}"`),
      `${id} is neither a command nor handled in the menu`);
});

// ── the console is gone, the refusals are not ────────────────────────────
test("the console element is removed from the page", () => {
  assert.ok(!/id="status"/.test(html), "the dangling console is still there");
  assert.ok(!/statusEl/.test(main), "main.js still writes to the console element");
});

test("errors are NOT auto-dismissed, because a refusal must be seen", () => {
  // a rejected hand edit must be refused VISIBLY
  const toast = fs.readFileSync(path.join(ROOT, "viewer", "src", "shell", "toast.js"), "utf8");
  const life = toast.match(/const LIFETIME = \{([^}]*)\}/)[1];
  assert.match(life, /err:\s*0/, "errors expire, so a refusal can vanish unseen");
  assert.match(toast, /live\.find\(x => LIFETIME\[x\.cls\]\)/,
    "overflow can push an error off screen to make room for an acknowledgement");
});

test("the history survives, so nothing is actually lost", () => {
  const rows = [{ msg: "planted p42", cls: "ok", at: new Date(2026, 8, 11, 17, 4, 5) }];
  assert.match(formatHistory(rows), /17:04:05 ok\s+planted p42/);
});

test("messages raised before the shell mounts are queued, not dropped", () => {
  // the first thing main.js does is log that the viewer is ready
  assert.match(main, /const preToast = \[\]/);
  assert.match(main, /for \(const \[m, c\] of preToast\) toasts\.push\(m, c\)/);
});

// ── discoverability ──────────────────────────────────────────────────────
test("objects, places and versions are reachable BY NAME", () => {
  for (const id of ["app.objects", "app.places", "app.versions"])
    assert.ok(main.includes(`id: "${id}"`), `${id} is not a command`);
  assert.match(main, /function openPanelAt/, "nothing opens a named section");
});

test("there is a way to ask what the tools are", () => {
  assert.match(main, /function showShortcuts/);
  assert.match(main, /id: "app\.keys"/, "the shortcuts sheet is not a command");
  const body = main.slice(main.indexOf("function showShortcuts"));
  for (const k of ["right-drag", "W A S D", "right-click"])
    assert.ok(body.includes(k), `the sheet never mentions ${k}`);
});

// ── measure reports where the user is looking ────────────────────────────
test("the measurement is shown on the canvas, not in a panel section", () => {
  // drawing a measure line must visibly give its length — describeRun's result
  // in a div inside a collapsible section of a hidden panel is never seen
  assert.ok(!/id="measureOut"/.test(html), "the readout is still inside the panel");
  assert.match(main, /function showMeasureHud/);
  const body = main.slice(main.indexOf("function showMeasureHud"),
                          main.indexOf("function showMeasureHud") + 1800);
  assert.match(body, /across/, "the HUD does not report the plan length");
  assert.match(body, /along the ground/, "the HUD drops the along-ground length");
});

test("measuring can be finished and undone", () => {
  // a tool needs a discoverable end, not just pressing the tool again
  const i = main.indexOf("// A TOOL NEEDS AN END");
  assert.ok(i > 0, "the measure exit handler is gone");
  // THE WHOLE HANDLER, brace-matched. A fixed character window goes red whenever
  // the handler grows another branch and pushes the checked one past the cut. A
  // window is a proxy for "in this handler"; the braces are the handler.
  const open = main.indexOf("{", main.indexOf('addEventListener("keydown"', i));
  assert.ok(open > i, "the measure exit handler is no longer a keydown listener");
  let depth = 0, end = open;
  for (; end < main.length; end++) {
    if (main[end] === "{") depth++;
    else if (main[end] === "}" && --depth === 0) break;
  }
  const body = main.slice(open, end + 1);
  assert.ok(body.length > 400, "the brace scan found nothing to read");
  assert.match(body, /Escape/, "Esc does not finish measuring");
  assert.match(body, /Backspace/, "a mis-clicked point cannot be taken back");
  assert.match(body, /mode !== "measure"/,
    "the measure branch no longer checks the mode, so Backspace would eat keys everywhere");
});

// ── basic 3D editing tooling ─────────────────────────────────────────────
//
// The user needs basic 3D editing tools: group objects, hide and show objects
// and groups. Grouping, per-object hide, per-group hide, fold, lock and rename
// are reachable from the context menu; solo isolates a selection. These tests
// pin solo and the rule that makes it safe.

test("grouping is offered for MANY and never for one", () => {
  // grouping one thing is an action that can only refuse, the same rule the
  // substitute button already follows
  const one = contextItemsFor({ kind: "bed", id: "b" }, { hasSelection: true })
    .filter(i => i !== "-").map(i => i.id);
  const many = contextItemsFor({ kind: "bed", id: "b" }, { hasSelection: true, multi: true })
    .filter(i => i !== "-").map(i => i.id);
  assert.ok(!one.includes("edit.group"), "grouping was offered for a single object");
  assert.ok(many.includes("edit.group"), "grouping is not offered for a multi-selection");
});

test("solo is offered, and so is the way back out", () => {
  const onObject = contextItemsFor({ kind: "plant", id: "p" }).filter(i => i !== "-").map(i => i.id);
  assert.ok(onObject.includes("edit.solo"), "solo is not reachable from an object");
  const onGround = contextItemsFor(null).filter(i => i !== "-").map(i => i.id);
  assert.ok(onGround.includes("edit.showAll"),
    "nothing on bare ground brings hidden objects back — solo would be a trap");
});

test("solo REMEMBERS what was already hidden", () => {
  // leaving solo must restore the previous state, not reveal everything: a
  // designer who had hidden the house does not want it back because they soloed
  // a bed for a moment
  const body = main.slice(main.indexOf("function toggleSolo"));
  assert.match(body, /soloMemory = JSON\.parse\(JSON\.stringify\(objectView\)\)/,
    "solo does not snapshot the previous visibility");
  assert.match(body, /objectView = soloMemory/, "leaving solo does not restore it");
});

test("solo keeps a selected object's whole GROUP", () => {
  // soloing one stone out of a triad and losing the other two is never what you
  // meant — the triad is the thing being judged
  const body = main.slice(main.indexOf("function toggleSolo"),
                          main.indexOf("const PANEL_KEY"));
  assert.match(body, /designGroups\(\)/, "solo ignores groups entirely");
  assert.match(body, /g\.members/, "solo does not keep a group's other members");
});

test("visibility stays VIEW state and never becomes a design field", () => {
  // An op would put a viewing preference into the file the design agent
  // reads, and the next session would see a deliberately hidden bed as deleted.
  const body = main.slice(main.indexOf("function toggleSolo"),
                          main.indexOf("const PANEL_KEY"));
  assert.ok(!/postOps\(|\/api\/ops/.test(body), "solo emits an op — visibility must be local");
  assert.match(body, /persistObjectView\(\)/, "solo does not persist to localStorage");
});

test("objectView reaches disk from exactly ONE function", () => {
  // solo replaces the whole map, so the write could not stay inline in
  // setObjectView without becoming a second copy — and two writers of one key
  // eventually overwrite each other's changes.
  // Hidden/folded is stored PER DESIGN under one store, which also holds the group
  // map and a deleted design's scope, and the store's key carries the SITE
  // (VIEW_KEY = siteKey(VIEW_STORE_KEY, SITE)): one writer, of the site's own store
  assert.match(main, /const VIEW_KEY = siteKey\(VIEW_STORE_KEY, SITE\)/, "the view store is no longer per site");
  const writes = [...main.matchAll(/localStorage\.setItem\(VIEW_KEY/g)];
  assert.equal(writes.length, 1, `the view store is written from ${writes.length} places`);
  assert.match(main, /function persistObjectView\(\) \{ persistView\(\); \}/);
  assert.ok(!/localStorage\.setItem\("yt\.(objectview|groupview)"/.test(main) && !/OBJECT_VIEW_KEY|GROUP_VIEW_KEY/.test(main),
    "the old shared maps are being written again");
});
