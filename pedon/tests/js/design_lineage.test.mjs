// node --test tests/js/design_lineage.test.mjs
//
// WHERE A DESIGN CAME FROM.
//
// Without a field for it, the only place a user can record this is the NAME:
// `huajing_A_asis` → `_B_smaller` → `_C_split` → `_D_drift`, `owned_v1` → `v2` →
// `v3`. Measured, **37 of 65 saved designs encode a version chain in their
// filename**; an app that cannot read it shows a flat "most recent" list, and
// choosing between four versions of the same border means reading four names.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeDesignDocument, REPLACED_KEYS, DESIGN_KINDS } from "../../viewer/src/design_doc.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const cfg = fs.readFileSync(path.join(ROOT, "viewer", "vite.config.js"), "utf8");

test("switching designs CLEARS the lineage rather than inheriting it", () => {
  // THE FAILURE THIS PREVENTS IS A CONFIDENT WRONG ANSWER, not a missing one.
  // Switching copies the whole saved document into the working file, so without
  // this a design saved from nothing would announce the parent of the design you
  // just left — lineage wrong in exactly the direction that makes it look right.
  assert.ok(REPLACED_KEYS.includes("from"),
    "`from` is inherited across a switch, so every design claims its predecessor's parent");
  const onDisk = { from: "huajing_C_split", plants: [1], units: "meters" };
  const incoming = { plants: [], units: "meters" };
  const next = mergeDesignDocument(onDisk, incoming, { replace: true });
  assert.equal(next.from, undefined,
    "the previous design's parent survived a whole-document replace");
  // and a document that DOES declare one keeps it
  const kept = mergeDesignDocument(onDisk, { ...incoming, from: "owned_v2" }, { replace: true });
  assert.equal(kept.from, "owned_v2");
});

test("`from` is not a design KIND — it is a fact about the document", () => {
  // it must not become something the geometry vocabulary iterates, or every
  // consumer of DESIGN_KINDS would look for a `from` element to draw
  assert.ok(!DESIGN_KINDS.some(([k]) => k === "from"),
    "`from` joined the element kinds, so something will try to render it");
});

test("Save-as drops the inherited value before writing its own", () => {
  // belt and braces with REPLACED_KEYS above, and the reason is the ORDER of
  // events: the user switches to a design (its `from` lands in the working file), then
  // saves under a new name. Trusting what is in the document would record the
  // grandparent.
  const at = main.indexOf('getElementById("btnDesignSaveAs")');
  assert.ok(at > 0, "Save-as is gone — retarget this test");
  const body = main.slice(at, main.indexOf("\n};", at));
  assert.match(body, /delete doc\.from/,
    "Save-as trusts the `from` already in the working document");
  assert.match(body, /workingFrom && workingFrom !== name/,
    "a design can be recorded as its own parent");
  assert.ok(body.indexOf("delete doc.from") < body.indexOf("doc.from = workingFrom"),
    "the inherited value is deleted AFTER the real one is written, wiping it");
});

test("the origin is recorded where the working design is REPLACED, not guessed at save time", () => {
  // `currentVariant` is not enough: restoring from the archive clears it, and
  // the design still came from somewhere. Each thing that replaces the working
  // design says where it came from.
  assert.match(main, /let workingFrom = null;/, "nothing tracks where the design came from");
  const loadAt = main.indexOf("async function loadVariant");
  const loadBody = main.slice(loadAt, main.indexOf("\n}", loadAt));
  assert.match(loadBody, /workingFrom = name/, "switching to a design records no origin");

  const histAt = main.indexOf("rebuildHistoryList");
  const histBody = main.slice(histAt, main.indexOf("async function rebuildDesignList", histAt));
  assert.match(histBody, /workingFrom = /, "restoring a version records no origin");

  const newAt = main.indexOf('getElementById("btnDesignNew")');
  const newBody = main.slice(newAt, main.indexOf("\n};", newAt));
  assert.match(newBody, /workingFrom = null/,
    "an empty design keeps the parent of the garden it replaced");
});

test("the list can SEE the lineage, and does not invent one", () => {
  assert.match(cfg, /counts\.from = typeof d\.from === "string"/,
    "/api/designs never reports `from`, so the list cannot show it");
  // A design saved with no recorded `from` has no parent. Deriving one
  // from `owned_v2` → `owned_v1` would be a guess printed as a fact — the same
  // error as inventing a date for an undated snapshot.
  assert.ok(!/from:\s*[^"]*(replace|match)\(\/_v\\d/.test(main),
    "a parent is being inferred from the filename rather than read from the file");
  const rowAt = main.indexOf("let from = null;");
  assert.ok(rowAt > 0, "the row never builds a lineage element");
  const rowBody = main.slice(rowAt, rowAt + 420);
  assert.match(rowBody, /if \(m\?\.from\)/,
    "a design with no recorded parent still gets a lineage line");
});

test("the lineage rides the mtime cache, like every other label", () => {
  // reading 65 documents on every poll for one label is the request storm the
  // cache exists to prevent
  const at = cfg.indexOf("counts.from =");
  const before = cfg.slice(Math.max(0, at - 1400), at);
  assert.match(before, /counts\._stamp !== stamp/,
    "`from` is read outside the mtime cache, so 65 files parse on every poll");
});
