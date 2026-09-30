// A PAGE SHOWS NO SOURCE. The tail of a comment whose opening has been deleted — "... and the
// history is behind a command. -->" — is drawn by the browser as text in the page, and nothing
// else notices. Every viewer page's comments open before they close, one at a time.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VIEWER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "viewer");
const pages = fs.readdirSync(VIEWER).filter(n => n.endsWith(".html"));

/** Where a page's comments go wrong: a close with no open, or an open never closed. */
function strayComment(html) {
  let open = null;
  for (const m of html.matchAll(/<!--|-->/g)) {
    if (m[0] === "<!--") { if (open === null) open = m.index; }
    else if (open === null) return { at: m.index, text: html.slice(Math.max(0, m.index - 60), m.index + 3) };
    else open = null;
  }
  return open === null ? null : { at: open, text: html.slice(open, open + 60) };
}

test("every viewer page is read, and a stray comment would be found", () => {
  assert.ok(pages.includes("index.html") && pages.length >= 5, `pages: ${pages}`);
  assert.ok(strayComment("<p>a</p>\n   and the history is behind a command. -->\n<div>"), "a lone close");
  assert.ok(strayComment("<p>a</p><!-- never closed"), "a lone open");
  assert.equal(strayComment("<!-- a --><p>b</p><!-- c -->"), null);
});

for (const page of pages) {
  test(`${page} shows no comment as text`, () => {
    const stray = strayComment(fs.readFileSync(path.join(VIEWER, page), "utf8"));
    assert.equal(stray, null, `${page}: ${JSON.stringify(stray)}`);
  });
}
