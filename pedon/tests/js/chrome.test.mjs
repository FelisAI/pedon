// node --test tests/js/chrome.test.mjs
//
// The visual craft. This is a professional tool used by designers, so the UI must
// look like a real designer's app rather than a bare one — and, separately, the
// left panel must not be capped to a limited height.
//
// Both are testable, and the height one is a genuine bug with a genuine cause.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { icon, ICON_NAMES } from "../../viewer/src/shell/icons.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const css = fs.readFileSync(path.join(ROOT, "viewer", "src", "pedon.css"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");
const mainRaw = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const main = mainRaw.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const SURFACES_SRC = fs.readFileSync(
  path.join(ROOT, "viewer", "src", "shell", "surfaces.js"), "utf8");

// ── the height bug ───────────────────────────────────────────────────────
test("an adopted list does not keep the panel's 150px cap", () => {
  // THE CAUSE, and it is the price of adoption: these lists carry
  // `max-height: 150px` from the classic panel's markup, which sizes them as
  // sections of a 312px column stacked five deep. Inside a full-height panel
  // that is a short box with its own scrollbar inside another scrollbar.
  assert.match(html, /#objList[^{]*\{[^}]*max-height:\s*150px/,
    "the classic panel no longer caps its lists — this override may be obsolete");
  const rule = css.match(/#pSide #objList[^{]*\{([^}]*)\}/);
  assert.ok(rule, "nothing releases the cap inside the side panel");
  assert.match(rule[1], /max-height:\s*none/, "the 150px cap still applies in the panel");
});

test("exactly ONE thing scrolls in the panel", () => {
  // a scrollbar inside a scrollbar is the bug a user actually sees
  assert.match(css, /\.side-body\s*\{[^}]*overflow-y:\s*auto/);
  const rule = css.match(/#pSide #objList[^{]*\{([^}]*)\}/)[1];
  assert.match(rule, /overflow:\s*visible/, "the adopted list still scrolls inside the body");
});

// ── drawn icons, not typed glyphs ────────────────────────────────────────
test("no surface renders a unicode glyph as an icon", () => {
  // they come from whatever font resolves them, so they arrive at different
  // weights, optical sizes and baselines, and no spacing fixes a row of symbols
  // that were never drawn as a set
  const GLYPHS = ["⛰", "⟺", "⬚", "❦", "⊞", "◳", "⤢", "▤", "◈", "⌖", "☀", "▫", "‹", "···"];
  for (const g of GLYPHS)
    assert.ok(!main.includes(`icon: "${g}"`) && !main.includes(`textContent = "${g}"`),
      `${g} is still used as an icon`);
});

test("every icon a surface asks for actually exists", () => {
  // an unknown name falls back to a dot, which is silent — so the set and the
  // callers are checked against each other here instead
  // icons are referenced from main.js, surfaces.js (the surface table's own
  // module) and docktools.js (the dock list's one owner) — read all three, or
  // this counts only some of them
  const DOCK_SRC = fs.readFileSync(path.join(ROOT, "viewer", "src", "shell", "docktools.js"), "utf8");
  const used = new Set([...(main + SURFACES_SRC + DOCK_SRC).matchAll(/icon(?:\(|: )"([a-zA-Z]+)"/g)]
    .map(m => m[1]));
  assert.ok(used.size >= 10, `only ${used.size} icons referenced — retarget this test`);
  for (const name of used)
    assert.ok(ICON_NAMES.includes(name), `"${name}" is requested and not drawn`);
});

test("the icons are one set: same grid, same stroke, same caps", () => {
  // this is what makes them look drawn together rather than collected
  for (const n of ICON_NAMES) {
    const svg = icon(n);
    assert.match(svg, /viewBox="0 0 24 24"/, `${n} is on a different grid`);
    assert.match(svg, /stroke-linecap="round"/, `${n} has different caps`);
    assert.match(svg, /stroke-width="1.6"/, `${n} has a different weight`);
    assert.match(svg, /stroke="currentColor"/, `${n} does not follow the text colour`);
  }
});

test("icons inherit colour, so every CSS state just works", () => {
  assert.ok(!/(fill|stroke)="#/.test(ICON_NAMES.map(n => icon(n)).join("")),
    "an icon hardcodes a colour and will not follow hover/active/disabled");
});

// ── depth and state ──────────────────────────────────────────────────────
test("floating surfaces have a lit edge, not just a shadow", () => {
  // a 1px border and a drop shadow make a rectangle; the hairline of light along
  // the top edge is what makes a surface read as lit
  const rule = css.match(/#pSide, #pInspector[^{]*\{([^}]*)\}/);
  assert.ok(rule, "the shared elevation rule is gone");
  assert.match(rule[1], /inset 0 1px 0 rgba\(255,255,255/,
    "no inner highlight, so the panels read as flat rectangles");
});

test("the active rail and dock states are more than a colour swap", () => {
  // ALL matching blocks, unioned — a selector may be declared more than once and
  // the CASCADE decides, so reading only the first match tests a rule that may
  // have been overridden: a flat early `.dock-btn.on` fails the check while a
  // refined one 400 lines further down wins.
  for (const sel of [/\.rail-btn\.on\s*\{([^}]*)\}/g, /\.dock-btn\.on\s*\{([^}]*)\}/g]) {
    const blocks = [...css.matchAll(sel)].map(m => m[1]);
    assert.ok(blocks.length, "missing an active state rule");
    assert.match(blocks.join(";"), /linear-gradient|box-shadow/,
      "the active state is a flat fill — indistinguishable from a hover at a glance");
  }
});

test("row controls appear on hover rather than sitting there as noise", () => {
  // 269 rows, each with an eye and a lock: always-on they are most of what the
  // panel contains
  assert.match(css, /#pSide \.eye[^{]*\{[^}]*opacity:\s*0/);
  assert.match(css, /#pSide \.orow:hover \.eye[^,]*[^{]*\{[^}]*opacity:\s*1/s);
  // except when they are ON, or the state is invisible
  assert.match(css, /#pSide \.eye\.on\s*\{[^}]*opacity:\s*1/);
});

test("focus is visible, and reduced motion is honoured", () => {
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

// ── the project menu ─────────────────────────────────────────────────────
test("project settings is reachable from the top bar, not only ⌘K", () => {
  // ⚙ lives inside the classic panel's <h1>, which is hidden by default — so
  // without the ··· menu the one door to calibration is a command you have to
  // know the name of
  assert.match(main, /onOverflow: ev =>/, "the ··· button opens nothing");
  const body = main.slice(main.indexOf("onOverflow: ev =>"));
  assert.match(body.slice(0, 700), /app\.settings/, "the menu does not offer project settings");
});

test("the menu says when the property is not calibrated, from the REAL state", () => {
  // a design on an unscaled or un-northed capture is wrong in a way no validator
  // catches, because every coordinate is self-consistent and all of them are wrong.
  //
  // The assertion is on the SOURCE of the answer, not on its wording: the
  // literal words "not calibrated" hard-coded behind a key site.json never has
  // are permanently on, so a wording check stays green while the property
  // really has no north set.
  const body = main.slice(main.indexOf("onOverflow: ev =>"));
  assert.match(body.slice(0, 900), /calibrationWarning\(/,
    "the menu invents its own idea of calibrated instead of asking setup.js");
  assert.ok(!/siteCache\?\.registration/.test(main),
    "reading a key site.json does not have");
  // and it is said where the user is already looking, not only inside a menu
  assert.match(main, /topBar\??\.setWarning/, "the top bar never says it");
});

test("the review sheet stays in step with the app it reviews", () => {
  // shell.html mounts the real components against fixture data so the chrome can
  // be LOOKED at — the viewer itself loads a scan and 240 plants and is busy for
  // over a minute, so visible defects go unnoticed while the source reads fine.
  // A sheet that drifts from the app stops being a review of it.
  const prev = fs.readFileSync(path.join(ROOT, "viewer", "src", "shell_preview.js"), "utf8");
  // THE SHEET CANNOT DRIFT ON SURFACES — it imports the same module the
  // app does, rather than keeping a copy. That is a stronger guarantee than
  // comparing two lists, so the check is that it imports rather than redefines.
  assert.match(prev, /import \{ SURFACES \} from ".\/shell\/surfaces\.js"/,
    "the sheet defines its own surfaces again — it will drift within the hour");
  assert.ok(!/const SURFACES = \{/.test(prev), "the sheet redefines SURFACES");
  assert.match(prev, /fetch\(`\/index\.html/, "the sheet no longer reads the real markup");
  assert.match(prev, /import plantInspector from/, "the sheet must show the real plant size editor");
  assert.match(prev, /plantInspector\.contributes\.inspectors\[0\]\.render/);
  // THE DOCK TOO, and for the same reason: one list. Comparing ids passes while the
  // sheet shows a stale label with the wrong icon, because an id is not a label — and
  // slicing main.js from an `indexOf` runs the loop over nothing the moment the array
  // moves (docs/lessons.md, `slice(-1)`).
  const tools = fs.readFileSync(path.join(ROOT, "viewer", "src", "shell", "docktools.js"), "utf8");
  assert.ok([...tools.matchAll(/id: "[a-z]+\.[a-zA-Z]+"/g)].length >= 6, "docktools.js lost its tools");
  for (const [name, src] of [["main.js", main], ["shell_preview.js", prev]]) {
    assert.match(src, /import \{ DOCK_TOOLS \} from ".\/shell\/docktools\.js"/, `${name} no longer imports the dock's tools`);
    assert.match(src, /mountDock\(DOCK_TOOLS,/, `${name} mounts a dock of its own`);
    assert.ok(!/mountDock\(\[/.test(src), `${name} defines a second dock list`);
  }
  assert.ok(!/"Eye-level shots"/.test(prev), "the sheet still carries a label the app dropped");
});

test("the markup the review sheet adopts actually exists", () => {
  // The sheet fetches index.html and adopts the store by id. If that markup is
  // renamed, the lookup returns null, an `if` skips quietly, `#objList` never arrives
  // and the next line throws — and nothing fails, because nothing opens the sheet.
  const prev = fs.readFileSync(path.join(ROOT, "viewer", "src", "shell_preview.js"), "utf8");
  const index = fs.readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");
  const id = prev.match(/const STORE_ID = "([^"]+)"/)?.[1];
  assert.ok(id, "the sheet no longer names the markup it adopts in one place");
  assert.ok(index.includes(`id="${id}"`), `index.html has no #${id} — the review sheet is blank`);
  assert.match(prev, /doc\.getElementById\(STORE_ID\)/);
  // every element the sheet reaches for by id has to come from somewhere
  const sheet = fs.readFileSync(path.join(ROOT, "viewer", "shell.html"), "utf8");
  {
    // ... or from a shell component that builds it (`#pSideWrap` is sidepanel.js's own)
    const shellDir = path.join(ROOT, "viewer", "src", "shell");
    const built = fs.readdirSync(shellDir).filter(f => f.endsWith(".js"))
      .map(f => fs.readFileSync(path.join(shellDir, f), "utf8")).join("\n") + prev;
    for (const want of [...prev.matchAll(/document\.getElementById\("([A-Za-z]+)"\)/g)].map(m => m[1]))
      assert.ok(index.includes(`id="${want}"`) || sheet.includes(`id="${want}"`) || new RegExp(`id = "${want}"|"${want}"`).test(built.replace(`getElementById("${want}")`, "")),
        `the sheet looks up #${want}, which nothing defines`);
  }
  // and a missing store is SAID, not skipped
  assert.match(prev, /throw new Error\(`shell\.html: index\.html has no #\$\{STORE_ID\}`\)/);
});

// ── two bugs that only LOOKING finds ─────────────────────────────────────
test("the hidden attribute beats every author display rule", () => {
  // THE BUG: `hidden` works by a UA rule of `display: none`, which any author
  // rule setting display overrides. A floating surface that sets one is
  // UNHIDEABLE without this — collapsing the panel leaves an empty chrome on
  // screen with a stale heading, and the source reads perfectly: the code says
  // one thing and the pixels say another.
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/,
    "nothing forces hidden to win, so a surface that sets display cannot hide");
  // AND THE OVERRIDE IS STILL NEEDED. Only some surfaces set a display —
  // #pContext does not — so the check is that AT LEAST ONE does. Asserting all
  // of them over-claims and fails on one that never needed it, which reads as a
  // regression in the fix.
  const setsDisplay = ["#pSide", "#pInspector", "#pPalette .pal-box", "#pToasts"]
    .filter(sel => {
      const m = css.match(new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
      return m && /display:/.test(m[1]);
    });
  assert.ok(setsDisplay.length > 0,
    "no surface sets display any more — the !important override may be obsolete");
});

test("collapsing clears the heading as well as the content", () => {
  // a panel that reappears still naming the surface it no longer holds makes a
  // panel that did not hide look like a broken surface
  const side = fs.readFileSync(path.join(ROOT, "viewer", "src", "shell", "sidepanel.js"), "utf8");
  const body = side.slice(side.indexOf("function hide()"), side.indexOf("function hide()") + 400);
  assert.match(body, /title\.textContent = ""/);
});

test("checkboxes are in the palette, not system blue", () => {
  // system blue is the one saturated hue on screen and not a colour of ours at all
  assert.match(css, /input\[type="checkbox"\][^{]*\{[^}]*accent-color:\s*var\(--p-clay\)/s,
    "checkboxes render in the browser's own accent colour");
});

test("nothing in the panel can overflow its width", () => {
  // at 296px single-line rows clip the time field and push the fifth layer
  // toggle off the edge entirely — a control you cannot see is a control
  // you do not have
  assert.match(css, /#pSide \.row\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /#pSide, \.side-body\s*\{[^}]*overflow-x:\s*hidden/);
});

test("a label and its checkbox never break apart", () => {
  assert.match(css, /#pSide label\.small\s*\{[^}]*white-space:\s*nowrap/s,
    '"on the ground" can wrap between the box and its words');
});

test("an editable name is not a permanent form field", () => {
  // An input rule broad enough to catch an untyped #designFilter also catches
  // `.gn`, the group's name, so every group row grows a permanent box and the
  // tree reads as a column of text inputs — visible in a screenshot, not in the
  // source, which is the whole point of the sheet.
  // A LATER OVERRIDE DOES NOT WORK: each `:not()` carries the specificity of its
  // argument, so the broad rule's three of them (1,3,1) beat a later
  // `#pSide input.gn` (1,1,1) and the override silently loses. So `.gn` is
  // EXCLUDED from the broad rule — which is also the clearer statement, since
  // that rule styles form fields and a renameable label is not one.
  assert.match(css, /#pSide input:not\(\[type="checkbox"\]\)[^,{]*:not\(\.gn\)/,
    "the broad field rule still claims .gn, so it paints a box at rest");
  const rule = css.match(/#pSide input\.gn\s*\{([^}]*)\}/);
  assert.ok(rule, "the group name has no rule of its own");
  assert.match(rule[1], /background:\s*none/, "it still paints a field at rest");
  assert.match(css, /#pSide input\.gn:focus/, "it never becomes a real field when focused");
});

test("the review sheet mirrors the app's ROW SHAPES, not just its names", () => {
  // a sheet that builds its own simplified rows shows Places flat while the app
  // ships `.lrow` and `.r`. A sheet that mirrors loosely reviews the mirror.
  const prev = fs.readFileSync(path.join(ROOT, "viewer", "src", "shell_preview.js"), "utf8");
  for (const cls of ["lrow", "r"])
    assert.ok(new RegExp(`className = "${cls}"`).test(prev),
      `the sheet does not build a .${cls} row, so that row's CSS is never exercised`);
  // and the app must still build them, or the mirror is of something gone
  assert.match(main, /className = "lrow"/);
  assert.match(main, /row\.className = "r"/);
});

test("a renameable NAME is never styled as a form field", () => {
  // The broad `#pSide input:not(…)` rule carries four :not()s (1,4,1) and beats
  // any later `.gn` (1,1,1) or `.lrow > input` (1,1,2), so without the exclusion
  // both the group name and every landmark render as a boxed field. The fix is
  // to EXCLUDE them where the rule is written, not to out-specify it after.
  const broad = css.match(/#pSide input:not\(\[type="checkbox"\]\)[^,{]*/);
  assert.ok(broad, "the broad field rule is gone — retarget this test");
  for (const cls of ["gn", "nm"])
    assert.ok(broad[0].includes(`:not(.${cls})`),
      `.${cls} is not excluded, so every one of those names renders as a boxed input`);
});

test("both name fields carry the class the exclusion depends on", () => {
  // the exclusion is only as good as the class actually being applied
  assert.match(main, /label\.className = "nm"/, "landmark names have no .nm class");
  assert.match(main, /n\.className = "nm"/, "area names have no .nm class");
});
