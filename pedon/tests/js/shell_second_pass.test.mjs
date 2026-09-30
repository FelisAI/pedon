// node --test tests/js/shell_second_pass.test.mjs
//
// THE SHELL, SECOND PASS — camera controls, project saving and loading, and the
// objects panel header. Related coverage lives in tooltip.test.mjs,
// shell/sidepanel/stylesheet_intact, setup_path, ui_gizmo and treesort.
//
//   Distinct actions need distinct glyphs across the top bar and dock.
//   Project saving and loading must be discoverable.
//   The objects panel header must be clear and uncluttered.
import { resolvePath } from "../../viewer/project_paths.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SURFACES } from "../../viewer/src/shell/surfaces.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = p => fs.readFileSync(resolvePath(p), "utf8");   // data/… is the active site's
const topbar = read("viewer/src/shell/topbar.js");
const main = read("viewer/src/main.js");
// Adjacent string literals joined, so a sentence wrapped across two lines is one
// string to match against. `"a " + "b"` reads as "a b" to the user and as two
// unrelated tokens to a regex. Copy assertions must check what the user reads,
// rather than how the source wraps it.
const mainText = main.replace(/"\s*\+\s*"/g, "");
const html = read("viewer/index.html");
const css = read("viewer/src/pedon.css");
const icons = read("viewer/src/shell/icons.js");
const cfg = read("viewer/vite.config.js");

// ══ ONE CAMERA CONTROL ════════════════════════════════════════════════════
// Framing the site and entering a view need distinct glyphs, because identical
// controls one bar apart make different camera actions hard to distinguish.

test("the top bar has exactly one camera control", () => {
  const buttons = [...topbar.matchAll(/class="(tb-[a-z]+)"[^>]*type="button"/g)].map(m => m[1]);
  const viewish = buttons.filter(b => ["tb-cam", "tb-frame", "tb-view"].includes(b));
  assert.deepEqual(viewish, ["tb-cam"],
    `the top bar carries ${viewish.length} camera-ish buttons: ${viewish.join(", ")}`);
  assert.ok(!topbar.includes("onFrame"),
    "a separate framing handler allows a duplicate camera button");
});

test("framing the whole site is available in the camera menu", () => {
  // it is a camera framing exactly like Top and Isometric are, so that is where
  // it belongs; removing the button must not remove the capability
  assert.match(main, /id: "view\.frameAll"/, "there is no frame-all command");
  // the MENU entry, not the command registration — `indexOf` finds the latter
  // first, and it carries `keys` rather than the `hint` a menu row displays
  const at = main.lastIndexOf('{ id: "view.frameAll"');
  assert.notEqual(at, main.indexOf('{ id: "view.frameAll"'),
    "view.frameAll appears once — it is a command with no entry in the camera menu");
  const menu = main.slice(at, at + 240);
  assert.match(menu, /See the whole site/, "the entry still reads as a mechanism");
  assert.match(menu, /hint: "F"/, "the key that does it is not shown beside it");
  // FIRST in the menu, because it is the framing the owner uses most
  assert.ok(menu.indexOf('view.top') > menu.indexOf('view.frameAll'),
    "framing the whole yard is not the first entry of the camera menu");
});

test("the two surfaces use distinct glyphs", () => {
  // the dock's camera action needs its own glyph so it is distinguishable from
  // the top bar's `frame` control
  assert.match(icons, /camera:/, "there is no camera glyph, so something is reusing another");
  // the dock's list lives in shell/docktools.js, shared with the review sheet,
  // so both use the same icons. The camera button is "Go to a view"; the photo
  // walk lives in Views.
  assert.match(read("viewer/src/shell/docktools.js"), /id: "view\.pick",\s*icon: "camera"/,
    "the dock's camera button wears a glyph that belongs to framing");
});

// ══ WHAT IS MY PROJECT, AND WHERE DOES IT LIVE ════════════════════════════
// The app must explain how a project saves and how to load a new project.
//
// A project's data/ directory holds its site data, and everything writes on
// change. The app must SHOW that it saves automatically: an invisible autosave
// and a missing Save button are indistinguishable to the user.

test("the project inventory endpoint exists and names every part", () => {
  assert.match(cfg, /url === "\/api\/project"/, "nothing answers what the project is");
  for (const p of ["data/captures", "data/calibration.json", "data/site.json",
                   "data/design.json", "data/designs", "data/terrain_scan.json",
                   "data/views"]) {
    assert.ok(cfg.includes(p), `the inventory does not account for ${p}`);
  }
  // it must report what is really on disk rather than what ought to be there
  assert.match(cfg, /statSync/, "the sizes and dates are asserted rather than measured");
});

test("settings says the project saves itself, because there is no button to press", () => {
  assert.ok(html.includes('id="projParts"'), "the parts of the project are never listed");
  assert.ok(html.includes('id="projName"'), "the property cannot be named");
  assert.ok(html.includes('id="newProjectHow"'), "nothing answers how to start a second property");
  assert.match(mainText, /saves itself as you work/,
    "the window never says the project is already saved, which is the actual answer");
  assert.match(mainText, /nothing to press/,
    "it does not say the missing Save button is the design rather than an omission");
});

test("calibration autosaves so there is nothing to press", () => {
  // Calibration — level, north and scale — determines every coordinate and
  // must save on change, because keeping it only in memory loses it on close.
  const apply = main.slice(main.indexOf("function applyCalib"),
                           main.indexOf("function applyCalib") + 1200);
  assert.match(apply, /autoSaveCalib/,
    "applyCalib is the one place every calibration change passes, and it does not save");
  assert.match(main, /restoringCalib/,
    "loading a saved calibration will write it straight back — a save loop on boot");
});

// ══ THE TOP OF THE OBJECTS PANEL ═════════════════════════════════════════
// Keep the filter and sort control together, with the count on a second row.
// "Show all" is a reset for hidden objects, an uncommon state for the user;
// making it full-width gives it the prominence of a primary action.

test("the objects surface header is a filter line and a tally, and nothing else", () => {
  // `objAlts` is `hidden` unless the design declares two proposals for one
  // corner, so a design without proposals shows only a filter line and a tally.
  assert.deepEqual(SURFACES.objects.ids,
    ["objRow", "objFind", "objAlts", "objTally", "objList"],
    "the objects surface does not adopt the expected header and list rows");
  const html2 = fs.readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");
  const alts = html2.slice(html2.indexOf('id="objAlts"'));
  assert.match(alts.slice(0, alts.indexOf(">") + 1), /\shidden[\s>]/,
    "the proposals row is visible on designs that have no proposals");
  assert.equal(SURFACES.objects.actions, undefined,
    "'Show all' is in the header, where it reads as the primary control");
});

test("the sort control sits ON the filter line rather than in a row of its own", () => {
  const body = main.slice(main.indexOf("function ensureTreeSortControl"),
                          main.indexOf("function ensureTreeSortControl") + 800);
  assert.ok(body.length > 40, "ensureTreeSortControl moved — retarget this test");
  assert.match(body, /getElementById\("objFind"\)/,
    "the sort control is appended somewhere other than the filter line");
});

test("the reset appears beside the count, and only when there is something to reset", () => {
  assert.ok(html.includes('id="objTally"'), "there is no tally row");
  const tally = html.slice(html.indexOf('id="objTally"'), html.indexOf('id="objList"'));
  assert.ok(tally.includes('id="objShown"'), "the count is not on the tally row");
  assert.ok(tally.includes('id="btnShowAllObjects"'), "the reset is not beside the count");
  // BARE ATTRIBUTES ONLY. `/hidden/` over the raw tag is satisfied by the
  // "hidden" inside title="everything hidden with an eye comes back", even
  // without a hidden attribute. `aria-hidden` can also match that substring.
  // Strip quoted values, then look for a bare attribute in what is left.
  const tag = tally.slice(tally.indexOf('<button id="btnShowAllObjects"'));
  const attrs = tag.slice(0, tag.indexOf(">")).replace(/"[^"]*"/g, '""');
  assert.match(attrs, /\shidden[\s=]?/,
    "the reset is visible when there is nothing hidden to show");
  // and the count must say what is hidden, or the reset appears for no reason
  assert.match(main, /hidden`/, "the count never says how many rows are hidden");
});

test("the objects header does not start with an empty selection bar", () => {
  // #objRow is the selection bar and is empty most of the time; hide it when
  // empty so a bordered row does not clutter the top of the surface
  assert.match(css, /#pSide #objRow:not\(:has\(\.bad\)\) \{[^}]*display: none/,
    "an empty selection row still occupies the top of the objects surface");
});
