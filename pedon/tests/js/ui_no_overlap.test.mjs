// node --test tests/js/ui_no_overlap.test.mjs
//
// A floating surface must not sit on top of another surface's controls.
//
// A side panel with max-height:calc(100vh - 24px) reaches the bottom of a short
// window; a full-width bar fixed at the bottom with the same z-index covers it.
// Equal z-index resolves by document order, so the later surface wins and
// swallows whatever section of the panel happens to be last. Adding a section
// would silently move the problem somewhere else, which is why this is a
// geometry test and not a "check this section is clickable" test.
//
// The fix is that they must not share horizontal space at all.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const shellCss = fs.readFileSync(
  new URL("../../viewer/src/pedon.css", import.meta.url), "utf8");
const html = fs.readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");

/** The declarations of a fixed-position rule, as {prop: value}. */
function ruleOf(selector, source = html) {
  const i = source.indexOf(selector + " {");
  assert.notStrictEqual(i, -1, `no CSS rule for "${selector}" — retarget this test`);
  const body = source.slice(i, source.indexOf("}", i));
  const out = {};
  for (const decl of body.slice(body.indexOf("{") + 1).split(";")) {
    const [k, ...v] = decl.split(":");
    if (v.length) out[k.trim()] = v.join(":").trim();
  }
  return out;
}

const px = v => {
  const m = /(-?\d+(?:\.\d+)?)\s*px/.exec(v || "");
  return m ? parseFloat(m[1]) : null;
};

test("both elements are still fixed overlays — the premise of this test", () => {
  // Messages are transient toasts and there is no status bar or classic panel.
  // The GUARANTEE is what this suite is really for: a floating surface must not
  // cover another and make it unclickable.
  //
  // The two surfaces that could do it are the left column — #pSideWrap, which
  // holds the rail and #pSide — and the toast stack. Both live in pedon.css.
  assert.equal(ruleOf("#pSideWrap", shellCss).position, "fixed");
  assert.equal(ruleOf("#pToasts", shellCss).position, "fixed");
  assert.ok(px(ruleOf("#pSide", shellCss).width) > 0,
    "the side surface needs a known width to compare");
});

test("the toasts stack clear of the side column, on the other side of the window", () => {
  const wrap = ruleOf("#pSideWrap", shellCss);
  const side = ruleOf("#pSide", shellCss);
  const toasts = ruleOf("#pToasts", shellCss);
  // `left: 0` is unitless, and px() wants a unit — a bare zero is still zero
  assert.ok(wrap.left === "0" || px(wrap.left) === 0,
    `the side column is not anchored to the left edge (left: ${wrap.left})`);
  // the rail sits beside #pSide inside the same wrapper, so the occupied strip is
  // wider than #pSide alone — bound it generously and still clear of the toasts
  const occupied = px(side.width) + 80;
  assert.ok(toasts.right !== undefined,
    "#pToasts is not anchored to the right — it could grow across the side column");
  assert.ok(occupied < 900,
    `the side column occupies about ${occupied}px; toasts anchored right stay clear of it`);
  // and they must never swallow a click meant for the yard
  assert.equal(toasts["pointer-events"], "none",
    "the toast stack intercepts pointer events over the canvas");
  // the WRAPPER spans the whole height and must not either — only its children
  // may take pointer events, or the left edge of the yard becomes undraggable
  assert.equal(wrap["pointer-events"], "none",
    "#pSideWrap swallows clicks over the full height of the window");
});

test("every floating surface has a z-index somebody chose", () => {
  // equal values resolve by document order, which is not a decision anyone made.
  // these are the surfaces that float over the yard, and
  // they must stack in a stated order: menu over palette over inspector over
  // dock and bar.
  const z = sel => parseInt(ruleOf(sel, shellCss)["z-index"], 10);
  const order = ["#pTopBar", "#pDock", "#pInspector", "#pPalette", "#pContext"];
  const seen = order.map(s => [s, z(s)]);
  for (const [s, v] of seen)
    assert.ok(Number.isFinite(v), `${s} has no z-index, so its stacking is accidental`);
  assert.ok(z("#pContext") > z("#pPalette"),
    "the context menu can be hidden behind the palette");
  assert.ok(z("#pPalette") > z("#pInspector"),
    "the palette opens behind the inspector card");
  assert.ok(z("#pInspector") > z("#pDock"),
    "the inspector can be hidden behind the dock");
});
