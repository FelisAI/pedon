// node --test tests/js/design_history.test.mjs
//
// A DOOR ON THE DESIGN ARCHIVE.
//
// `snapshotWorking()` writes data/history/design-<stamp>.json on every design
// switch — on a real site, hundreds of files and over a hundred distinct
// versions of the garden. An /api/history endpoint that **nothing calls** is
// no use: a built thing with no way in is indistinguishable from one that was
// never built.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { docUrlFor, historyKey, isHistory, readStamp, compareLabel }
  from "../../viewer/src/shell/designref.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const cfg = fs.readFileSync(path.join(ROOT, "viewer", "vite.config.js"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");

test("a saved design and an archived snapshot resolve to different directories", () => {
  assert.equal(docUrlFor("back_yard_v2"), "/data/designs/back_yard_v2.json");
  assert.equal(docUrlFor(historyKey("design-20260912-091016.json")),
    "/data/history/design-20260912-091016.json");
});

test("the kind is carried by the key, never guessed from the name", () => {
  // `design-20260912-091016` is a perfectly legal thing for the user to type into
  // Save as…, so sniffing the shape of a name would send a saved design to the
  // archive directory and 404 it
  assert.equal(isHistory("design-20260912-091016"), false);
  assert.equal(docUrlFor("design-20260912-091016"),
    "/data/designs/design-20260912-091016.json",
    "a SAVED design whose name looks like a stamp was resolved to the archive");
  assert.equal(isHistory(historyKey("x.json")), true);
});

test("ONE resolver — the ghost, the table and restore cannot read different files", () => {
  // A second path builder drifts at once: a renderCompare with its own
  // `/data/designs/${n}.json` draws a ghosted history snapshot in the yard while
  // its column is silently missing from the numbers beside it.
  const paths = [...main.matchAll(/["'`]\/data\/(designs|history)\/\$\{/g)];
  assert.deepEqual(paths.map(m => m[0]), [],
    "main.js builds a design document path by hand instead of calling docUrlFor");
  for (const fn of ["setOverlay", "renderCompare"]) {
    const at = main.indexOf(`function ${fn}`);
    assert.ok(at > 0, `${fn} is gone — retarget this test`);
    const body = main.slice(at, main.indexOf("\n}", at));
    assert.match(body, /docUrlFor\(/, `${fn} does not resolve through docUrlFor`);
  }
});

test("an undated snapshot says so rather than showing a date nobody measured", () => {
  // an archived file can predate the naming convention; its mtime is from a
  // checkout, so deriving a date from it would sort it NEWEST and print a
  // confident lie about old work
  assert.equal(readStamp(null), "undated");
  assert.equal(readStamp(""), "undated");
  assert.equal(readStamp("dropped-112906"), "undated");
  assert.match(readStamp("20260912-091016"), /Sep 12 09:10/);
});

test("a history column is labelled by its date, a saved one by its own name", () => {
  assert.equal(compareLabel("back_yard_v2"), "back_yard_v2");
  assert.match(compareLabel(historyKey("design-20260912-091016.json")), /Sep 12/);
});

// ── the endpoint ─────────────────────────────────────────────────────────
test("there is exactly ONE /api/history handler", () => {
  // The first match wins, so a second handler is dead code that silently
  // shadows the live one.
  const n = (cfg.match(/url === "\/api\/history"/g) ?? []).length;
  assert.equal(n, 1, `${n} handlers for /api/history — the first one wins`);
});

test("the archive is listed chronologically BEFORE duplicates are collapsed", () => {
  // "collapse consecutive identical snapshots" is meaningless in alphabetical
  // order, and readdirSync is alphabetical
  const at = cfg.indexOf('url === "/api/history"');
  const body = cfg.slice(at, at + 4000);
  const sortAt = body.indexOf(".sort(");
  const dedupeAt = body.indexOf("prev.hash === hash");
  assert.ok(sortAt > 0, "the listing is never sorted");
  assert.ok(dedupeAt > 0, "consecutive duplicates are never collapsed");
  assert.ok(sortAt < dedupeAt,
    "duplicates are collapsed before the list is put in order, which collapses "
    + "whatever happened to be adjacent alphabetically");
  assert.match(body, /stampOf/, "the order comes from something other than the stamp");
});

test("it reports what is really on disk, with sizes it measured", () => {
  const at = cfg.indexOf('url === "/api/history"');
  const body = cfg.slice(at, at + 4000);
  assert.match(body, /statSync/, "sizes and dates are asserted rather than measured");
  // THE FIELD, not the word. `/archived/` also matches the prose explaining why
  // the field exists, so it passes with the field deleted.
  assert.match(body, /archived:\s*files\.length/,
    "the response never says how many files are really on disk, so a collapsed "
    + "list looks like the whole archive");
  assert.match(body, /repeats\+\+|repeats:\s*0/,
    "a collapsed run does not say how many snapshots it stands for");
});

// ── the way in ───────────────────────────────────────────────────────────
test("the archive has a visible way in, on the surface that owns designs", () => {
  assert.ok(html.includes('id="designSource"'), "no Saved/History control exists");
  assert.ok(html.includes('id="btnSrcHistory"'), "nothing opens the archive");
  const surfaces = fs.readFileSync(
    path.join(ROOT, "viewer", "src", "shell", "surfaces.js"), "utf8");
  assert.match(surfaces, /"designCur", "designSource"/,
    "the Designs surface does not adopt the source toggle, so it never appears");
  assert.match(main, /getElementById\("btnSrcHistory"\)\s*\.\s*onclick/,
    "the History button has no handler — the endpoint would have a door and no handle");
});

test("restoring a version archives the working design FIRST", () => {
  // going back must itself be undoable, or a door onto the history is also a
  // way to lose today's work
  const at = main.indexOf("rebuildHistoryList");
  const body = main.slice(at, main.indexOf("async function rebuildDesignList", at));
  assert.match(body, /snapshotWorking\(\)/,
    "restore overwrites the working design without archiving it");
  assert.ok(body.indexOf("snapshotWorking()") < body.indexOf("writeDesignDocument"),
    "the working design is archived AFTER it has already been overwritten");
  assert.match(body, /writeDesignDocument\([^)]*replace: true/s,
    "restore merges instead of replacing, so the old version keeps today's geometry");
});

test("which list the user is looking at is VIEW state, never a design field", () => {
  assert.match(main, /DESIGN_SOURCE_KEY = "yt\.designsource/,
    "the chosen list is not remembered, or is remembered somewhere it should not be");
  const at = main.indexOf("function setDesignSource");
  const body = main.slice(at, main.indexOf("\n}", at));
  assert.match(body, /localStorage\.setItem/, "the choice is not remembered at all");
  assert.ok(!/writeDesignDocument|\/api\/ops/.test(body),
    "choosing a list writes to the design document");
});
