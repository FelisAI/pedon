// node --test tests/js/stylesheet_intact.test.mjs
//
// THE STYLESHEET MUST BALANCE, and a broken one is easy not to notice.
//
// Deleting the LINES CONTAINING a selector leaves a multi-line rule's body
// behind — and an orphaned body closes a brace that was never opened. A CSS
// parser discards everything after an unbalanced block, so nothing from that
// point on is styled: a panel computes `position: static` and renders
// 1472 × 1540 from the top-left corner.
//
// The surfaces are then not merely unstyled — they are DEstyled, by a fix to
// something else, and every source-scanning test stays green throughout.
//
// NEVER DELETE CSS BY MATCHING A SELECTOR LINE.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = fs.readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");
const pedon = fs.readFileSync(path.join(ROOT, "viewer", "src", "pedon.css"), "utf8");

/** Depth-scan a stylesheet, reporting the first line where it goes wrong. */
function balance(css, firstLine = 1) {
  let depth = 0;
  const lines = css.split("\n");
  for (let i = 0; i < lines.length; i++) {
    depth += (lines[i].match(/\{/g) ?? []).length - (lines[i].match(/\}/g) ?? []).length;
    if (depth < 0) return { ok: false, line: firstLine + i, text: lines[i].trim(), depth };
  }
  return { ok: depth === 0, line: null, depth };
}

test("the inline stylesheet in index.html balances", () => {
  const i = html.indexOf("<style"), j = html.indexOf("</style>");
  assert.ok(i >= 0 && j > i, "no <style> block found — retarget this test");
  const r = balance(html.slice(i, j), html.slice(0, i).split("\n").length);
  assert.ok(r.ok, r.line
    ? `a rule closes that was never opened at line ${r.line}: ${r.text}\n`
      + "  This is what a deleted selector line leaves behind, and everything after it is discarded."
    : `unbalanced by ${r.depth} braces — the tail of the stylesheet is dead`);
});

test("pedon.css balances", () => {
  const r = balance(pedon);
  assert.ok(r.ok, r.line ? `line ${r.line}: ${r.text}` : `unbalanced by ${r.depth}`);
});

test("no orphaned property line sits outside a rule", () => {
  // the shape a deleted selector leaves: a declaration at depth 0
  // COMMENTS STRIPPED FIRST. A continuation line inside a /* … */ block holds a
  // colon and no brace and looks exactly like an orphaned declaration.
  // Strip, then scan.
  const i = html.indexOf("<style"), j = html.indexOf("</style>");
  const lines = html.slice(i, j).replace(/\/\*[\s\S]*?\*\//g, "").split("\n");
  let depth = 0;
  const orphans = [];
  for (const line of lines) {
    const before = depth;
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    const t = line.trim();
    if (before === 0 && t && t.includes(":") && !t.includes("{")
        && !t.startsWith("/*") && !t.startsWith("*") && !t.startsWith("@")) {
      orphans.push(t.slice(0, 60));
    }
  }
  assert.deepEqual(orphans, [],
    "these declarations are outside any rule — their selector line was deleted");
});

test("every comment in the inline stylesheet is opened before it is closed", () => {
  // THE SECOND WAY TO KILL A STYLESHEET, and a brace counter is structurally
  // blind to it: comments contain no braces, so a stylesheet can balance 111/111
  // at depth 0 while a rule is being eaten.
  //
  // Deleting CSS can take a comment's OPENING `/*` with it and leave the body
  // and its `*/` behind. A CSS parser reads that dangling prose as a SELECTOR
  // and keeps reading until it finds a block to use as the body — so it
  // swallows the next rule, e.g. `#settings { position: fixed; }`, whole. The
  // settings window then computes `position: static` and opens at 0,0 over the
  // top bar: the same symptom as an orphaned rule body, a different cause.
  //
  // Measured: the browser parsed 110 rules from a block that declares 111.
  const i = html.indexOf("<style"), j = html.indexOf("</style>");
  const css = html.slice(i, j);
  const firstLine = html.slice(0, i).split("\n").length;
  let open = -1;
  for (let k = 0; k < css.length - 1; k++) {
    if (css[k] === "/" && css[k + 1] === "*") {
      assert.equal(open, -1, `a comment opened at line ${lineOf(css, open, firstLine)} `
        + `is still open when another opens at line ${lineOf(css, k, firstLine)}`);
      open = k; k++;
    } else if (css[k] === "*" && css[k + 1] === "/") {
      assert.notEqual(open, -1,
        `line ${lineOf(css, k, firstLine)} closes a comment that was never opened: `
        + `${css.slice(Math.max(0, k - 60), k + 2).split("\n").pop().trim()}\n`
        + "  Everything from the orphaned text to the NEXT rule body is read as one "
        + "selector, and that rule is discarded. Braces cannot see this.");
      open = -1; k++;
    }
  }
  assert.equal(open, -1, `a comment opened at line ${lineOf(css, open, firstLine)} is never closed`);
});

/** line number of an offset, for a message that points at the fault */
function lineOf(css, off, firstLine) {
  return off < 0 ? "?" : firstLine + css.slice(0, off).split("\n").length - 1;
}

test("the settings window still has its own positioning rule", () => {
  // The symptom that makes the comment breakage visible. #settings is the
  // surface whose positioning the inline block owns; the classic panel is
  // deleted completely, so nothing else carries this check.
  //
  // Its `position` lives in index.html and its geometry in pedon.css BY DESIGN
  // — so losing this one line leaves top/right inert rather than absent, and
  // the window opens at the viewport origin with a plausible computed
  // `top: 52px` sitting right there in the rule.
  const m = html.match(/#settings\s*\{([^}]*)\}/);
  assert.ok(m, "#settings has no rule in index.html at all");
  assert.match(m[1], /position:\s*fixed/,
    "#settings is not positioned — top/right are inert and it opens at 0,0");

  const geo = pedon.match(/#settings\s*\{([^}]*)\}/);
  assert.ok(geo, "#settings has no geometry rule in pedon.css");
  assert.match(geo[1], /top:/, "#settings has no top — it will sit under the top bar");
  assert.match(geo[1], /right:/, "#settings has no right edge");
});

test("the classic panel is gone, and nothing still reaches for it", () => {
  // Not "hidden" — deleted. #shellStore holds the few controls that were
  // genuinely its own, and the panel itself is not in the document.
  assert.doesNotMatch(html, /id="panel"/,
    "#panel is still in index.html — it is to be deleted completely, not hidden");
  const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
  assert.doesNotMatch(main, /getElementById\("panel"\)/,
    "main.js still looks up #panel, which no longer exists");
  assert.doesNotMatch(main, /PANEL_KEY/,
    "the panel preference is still read — a stale one could resurrect a deleted surface");
});
