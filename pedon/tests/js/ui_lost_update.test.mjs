// node --test tests/js/ui_lost_update.test.mjs
//
// The viewer must not write back a design it read minutes ago.
//
// Not hypothetical: a python tool adds two flights of steps to design.json, the
// viewer's currentDesign still holds the pre-steps document, and one click of
// Group writing `{...currentDesign, groups}` back deletes the `steps` key from
// the file entirely.
//
// Nothing is wrong with the spread; the snapshot it spreads is stale. In this
// project the design file is written constantly from outside the browser — the
// agent, site_api apply-ops, and the owner's own scripts all touch it — so a
// cached whole-document write is a lost update waiting for the next tool run.
//
// updateSite() solves exactly this for site.json, and says so in its own
// comment: "viewer must never write back a cached snapshot: re-read immediately
// before saving and touch only the key it owns." The design path needs the
// same treatment.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");

function fnBody(anchor) {
  const i = src.indexOf(anchor);
  assert.notStrictEqual(i, -1, `anchor "${anchor}" is gone — retarget this test`);
  const open = src.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) return src.slice(i, j + 1); }
  }
  throw new Error("unbalanced braces");
}

test("the functions this file guards still exist", () => {
  // assert the sample before the property; a source scan whose anchor moved
  // passes by finding nothing
  assert.ok(src.includes("async function writeDesignDocument"), "the write helper is gone");
  assert.ok(src.includes("async function saveGroups"), "saveGroups is gone");
});

test("the document write re-reads the file first", () => {
  const body = fnBody("async function writeDesignDocument");
  assert.match(body, /fetchJson\(\s*["'`]\/data\/design\.json/,
    "writeDesignDocument writes without re-reading — a design changed by a tool " +
    "since the last poll is silently clobbered, which is how two flights of steps " +
    "were lost to one click of Group");
});

test("the re-read happens BEFORE the write, not after", () => {
  const body = fnBody("async function writeDesignDocument");
  const read = body.search(/fetchJson\(\s*["'`]\/data\/design\.json/);
  const write = body.search(/writeJson\(\s*["'`]data\/design\.json/);
  assert.ok(read >= 0 && write >= 0, "both calls should be present");
  assert.ok(read < write, "the re-read must precede the write or it protects nothing");
});

test("saveGroups does not spread a cached document", () => {
  const body = fnBody("async function saveGroups");
  assert.doesNotMatch(body, /\{\s*\.\.\.currentDesign\s*,\s*groups\s*\}/,
    "saveGroups spreads the cached currentDesign; it must hand the groups to " +
    "writeDesignDocument and let that merge onto a fresh read");
});

test("a document write is refused while previewing someone else's design", () => {
  // preview_design points the viewer at a scratch file so the design agent can
  // see its own proposal — and loadDesign sets currentDesign from whatever it
  // loaded, so after a preview the viewer is holding the SCRATCH design. Any
  // document write would then persist the agent's scratch over the owner's
  // working file, flip-flopping data/design.json between the two designs.
  //
  // Refuse rather than redirect. Writing to the previewed file instead would let a
  // stray click edit an agent's scratch, and silently doing something other than
  // what the button says is how a handler ends up missing a kind such as `steps`.
  const body = fnBody("async function writeDesignDocument");
  assert.match(body, /previewSource|getPreviewSource/,
    "writeDesignDocument does not check whether the viewer is previewing — a save " +
    "while previewing overwrites the owner's design with the agent's scratch");
});
