// node --test tests/js/tooltip.test.mjs
//
// THE TOP BAR NEEDS HOVER TOOLTIPS THAT ACTUALLY APPEAR.
//
// Every control up there can carry `title` and still show nothing: a `title`
// attribute is not a tooltip, it is a REQUEST for one. The browser waits a second
// or more, draws OS chrome, and abandons the request if the pointer moved on the
// way in. Over a canvas repainting every frame that is unreliable enough that a
// user hovering a row of icon-only buttons concludes there is nothing there.
//
// So the thing to test is not "does it have a title" — that can be true while
// the tooltip is missing. It is the PLACEMENT (a bubble that hangs off the
// screen is a tooltip nobody can read) and the SUPPRESSION (leaving `title` in
// place gives two tooltips for one button, in different places, a second apart).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { placeTip } from "../../viewer/src/shell/tooltip.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = fs.readFileSync(path.join(ROOT, "viewer", "src", "shell", "tooltip.js"), "utf8");
const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "viewer", "src", "pedon.css"), "utf8");

const VIEW = { width: 1440, height: 900 };
const tip = { width: 160, height: 24 };

test("the bubble hangs below the button it explains", () => {
  const at = placeTip({ left: 700, top: 8, bottom: 36, width: 32 }, tip, VIEW);
  assert.equal(at.top, 36 + 8, "the bubble is not below the button");
  assert.equal(at.left, 700 + 16 - 80, "the bubble is not centred on the button");
});

test("a button at the bottom of the window gets its tooltip ABOVE it", () => {
  // THE DOCK. It sits at the bottom centre and is entirely icon-only, so it is
  // the surface that needs this most and the one where "always below" would put
  // every bubble off the bottom edge of the screen.
  const at = placeTip({ left: 700, top: 856, bottom: 884, width: 32 }, tip, VIEW);
  assert.ok(at.top < 856, `the dock's tooltip was placed at ${at.top}, below the window`);
  assert.equal(at.top, 856 - 8 - 24);
});

test("a bubble never hangs off either side", () => {
  const left = placeTip({ left: 4, top: 8, bottom: 36, width: 32 }, tip, VIEW);
  assert.ok(left.left >= 6, `clamped to ${left.left}, off the left edge`);
  const right = placeTip({ left: 1420, top: 8, bottom: 36, width: 32 }, tip, VIEW);
  assert.ok(right.left + tip.width <= VIEW.width - 6,
    `the bubble reaches ${right.left + tip.width} in a ${VIEW.width} window`);
});

test("with no room either way it still lands on screen", () => {
  // a short window, a tall bubble: below would overflow and above is negative.
  // Preferring below is right — the bubble is then clipped at the bottom rather
  // than drawn at a negative top, where it is invisible instead of partial.
  const at = placeTip({ left: 700, top: 2, bottom: 30, width: 32 },
                      { width: 160, height: 200 }, { width: 1440, height: 220 });
  assert.ok(at.top >= 0, `placed at ${at.top} — above the top of the window`);
});

test("the native tooltip is SUPPRESSED, not raced", () => {
  // two tooltips for one button, ours at once and the OS's a second later in a
  // different place, is worse than the bug being fixed
  assert.match(src, /removeAttribute\("title"\)/,
    "the title attribute is left in place, so the OS draws its own as well");
  assert.match(src, /setAttribute\("title", held\.text\)/,
    "the title is never restored — the tooltip works exactly once per button");
  // and the restore must survive the element being re-rendered under the pointer
  assert.match(src, /held\.el\.isConnected/,
    "restoring into a detached node throws, and the handler dies with it");
});

test("the bubble cannot swallow a click, or hover itself", () => {
  const rule = css.slice(css.indexOf("#pTip"), css.indexOf("#pTip") + 400);
  assert.match(rule, /pointer-events:\s*none/,
    "#pTip takes pointer events — it would cover the button it describes");
  assert.match(rule, /position:\s*fixed/, "#pTip scrolls away from what it explains");
});

test("tooltips are mounted before the surfaces that need them", () => {
  // A PURE FUNCTION IS HALF A GUARD: every assertion above passes with the call
  // to mountTooltips deleted, and the top bar goes back to having no tooltip.
  assert.match(main, /mountTooltips\(/, "nothing ever mounts the tooltips");
  assert.ok(main.indexOf("mountTooltips(") < main.indexOf("mountTopBar("),
    "the top bar is built before tooltips are listening");
});
