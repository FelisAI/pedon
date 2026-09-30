// node --test tests/js/sitekey.test.mjs
//
// What the browser remembers is kept PER SITE: browser-wide, a NEW site opens labelled with
// another site's design name. Old browser-wide values go to the site that opens first — the
// one they came from — and nowhere else.
import test from "node:test";
import assert from "node:assert/strict";
import { siteOf, siteKey, adoptLegacy } from "../../viewer/src/shell/sitekey.js";

function storage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
           removeItem: k => m.delete(k), dump: () => Object.fromEntries(m) };
}

test("a key is per site, and unchanged when no site is active", () => {
  assert.equal(siteKey("yardtwin.currentVariant", "home"), "yardtwin.currentVariant@home");
  assert.equal(siteKey("yardtwin.currentVariant", ""), "yardtwin.currentVariant");
});

test("the first site to open inherits the browser-wide value, and a NEW site does not", () => {
  const s = storage({ "yardtwin.currentVariant": "huajing_manual_02_violet_reach_manul" });
  adoptLegacy(s, "yardtwin.currentVariant", "home");
  assert.equal(s.getItem("yardtwin.currentVariant@home"), "huajing_manual_02_violet_reach_manul");
  adoptLegacy(s, "yardtwin.currentVariant", "oak-lane");
  assert.equal(s.getItem("yardtwin.currentVariant@oak-lane"), null, "the new site got another site's design name");
  assert.equal(s.getItem("yardtwin.currentVariant"), null, "the browser-wide value was left to be inherited again");
});

test("a site that already has its own value keeps it", () => {
  const s = storage({ "k": "old", "k@home": "mine" });
  adoptLegacy(s, "k", "home");
  assert.equal(s.getItem("k@home"), "mine");
});

test("the site comes from the page the dev server stamped", () => {
  const doc = { querySelector: sel => sel.includes("pedon-project") ? { getAttribute: () => "home" } : null };
  assert.equal(siteOf(doc), "home");
  assert.equal(siteOf({ querySelector: () => null }), "");
});
