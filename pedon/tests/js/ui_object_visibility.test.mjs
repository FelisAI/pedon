// node --test tests/js/ui_object_visibility.test.mjs
//
// Show and hide ONE object, not only a whole group.
//
// A 3D editor shows and hides single objects. With an eye only on groups, the
// only way to look at the garden without one bench, wall or boulder in it would
// be to put that thing in a group of its own.
//
// Three things are tested, and the second is the one that bites:
//
//   1. Hiding is INDEPENDENT of group hiding. A group hides its own NODE and
//      leaves members visible=true, precisely so unhiding a group can tell
//      "hidden with the group" from "hidden on its own". Per-object hiding writes
//      the object nodes. Those two facts must not overwrite each other.
//   2. A hidden object cannot be PICKED. three.js's raycaster does not skip
//      invisible objects — it tests layers and never looks at .visible — so
//      without an explicit check you can select, drag and delete something you
//      cannot see. main.js already documents this for groups; it is the same trap
//      one level down, and it is why pickableId takes the hidden-object set.
//   3. Visibility is a VIEW state and must never reach design.json. Hiding a bench
//      is how the owner is looking at the garden today, not a fact about the
//      garden, and the design agent reads that file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const html = readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");

// main.js builds a WebGLRenderer at module scope, so the pure parts are sliced
// between markers and evaluated. Both markers are asserted present and in order
// and the slice asserted non-trivial — indexOf can return -1, and slice(-1) is
// the file's LAST CHARACTER.
function block(start, end, min) {
  const a = main.indexOf(start), b = main.indexOf(end);
  assert.notEqual(a, -1, `${start} missing from main.js`);
  assert.notEqual(b, -1, `${end} missing from main.js`);
  assert.ok(b > a, `${start}/${end} out of order`);
  const s = main.slice(a + start.length, b);
  assert.ok(s.length > min, `the block after ${start} is only ${s.length} chars`);
  return s;
}
const api = new Function(
  `${block("// ── GROUP-MODEL-START ──", "// ── GROUP-MODEL-END ──", 400)}
   return { applyGroupVisibility, applyObjectVisibility, pickableId, groupIndex };`)();

const codeOnly = s => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

// A minimal stand-in for the scene graph regroupScene builds: a root holding one
// GROUP node (carrying groupId, no id) whose children are object nodes, plus two
// loose object nodes. Traverse mirrors three.js's own depth-first walk.
function node(userData, children = []) {
  const n = {
    userData, visible: true, children,
    traverse(fn) { fn(n); for (const c of children) c.traverse(fn); },
  };
  return n;
}
function scene() {
  const bench = node({ id: "bench_1" });
  const wall = node({ id: "wall_1" });
  const grouped = node({ groupId: "g1" }, [bench, wall]);
  const boulder = node({ id: "boulder_1" });
  const path1 = node({ id: "path_1" });
  const root = node({}, [grouped, boulder, path1]);
  return { root, bench, wall, grouped, boulder, path1 };
}

// ── 1. hiding one object ──────────────────────────────────────────────────

test("hiding one object hides exactly that object", () => {
  const s = scene();
  api.applyObjectVisibility(s.root, new Set(["boulder_1"]));
  assert.equal(s.boulder.visible, false, "the boulder was not hidden");
  // identities, not just a count: name every other node and assert it is untouched
  assert.equal(s.path1.visible, true, "an unrelated loose object was hidden too");
  assert.equal(s.bench.visible, true, "an object inside a group was hidden too");
  assert.equal(s.wall.visible, true);
  assert.equal(s.grouped.visible, true, "the group node must not be touched");
});

test("it reaches an object nested INSIDE a group node", () => {
  // regroupScene inserts a group node above the object, so root.children is not
  // enough — this is why the function traverses
  const s = scene();
  api.applyObjectVisibility(s.root, new Set(["bench_1"]));
  assert.equal(s.bench.visible, false, "an object inside a group was not reached");
  assert.equal(s.wall.visible, true, "its sibling was hidden too");
  assert.equal(s.grouped.visible, true, "the whole group was hidden instead of the one object");
});

test("unhiding puts it back, and only it", () => {
  const s = scene();
  api.applyObjectVisibility(s.root, new Set(["boulder_1", "bench_1"]));
  assert.equal(s.boulder.visible, false);
  assert.equal(s.bench.visible, false);
  api.applyObjectVisibility(s.root, new Set(["bench_1"]));
  assert.equal(s.boulder.visible, true, "unhiding did not restore the boulder");
  assert.equal(s.bench.visible, false, "the still-hidden object came back on");
});

test("an empty hidden set shows everything", () => {
  const s = scene();
  api.applyObjectVisibility(s.root, new Set(["boulder_1"]));
  api.applyObjectVisibility(s.root, new Set());
  for (const [name, n] of [["bench", s.bench], ["wall", s.wall],
                           ["boulder", s.boulder], ["path", s.path1]])
    assert.equal(n.visible, true, `${name} stayed hidden`);
});

test("it survives a missing or childless root instead of throwing", () => {
  assert.doesNotThrow(() => api.applyObjectVisibility(null, new Set(["x"])));
  assert.doesNotThrow(() => api.applyObjectVisibility(undefined, new Set()));
});

// ── 2. group hiding and object hiding are independent ─────────────────────

test("hiding a group leaves its members' own visibility alone", () => {
  // the documented split: members keep visible=true so unhiding the group can
  // tell "hidden with the group" from "hidden on its own"
  const s = scene();
  api.applyGroupVisibility(s.root, new Set(["g1"]));
  assert.equal(s.grouped.visible, false, "the group node was not hidden");
  assert.equal(s.bench.visible, true, "group hiding wrote the member's own flag");
  assert.equal(s.wall.visible, true);
});

test("the two facts do not overwrite each other", () => {
  const s = scene();
  api.applyGroupVisibility(s.root, new Set(["g1"]));   // group off
  api.applyObjectVisibility(s.root, new Set(["bench_1"])); // and the bench off on its own
  assert.equal(s.grouped.visible, false, "the group came back on");
  assert.equal(s.bench.visible, false);
  // now show the group again: the bench must STAY off, because it was hidden on its own
  api.applyGroupVisibility(s.root, new Set());
  assert.equal(s.grouped.visible, true);
  assert.equal(s.bench.visible, false,
    "showing the group turned an individually hidden object back on");
  assert.equal(s.wall.visible, true, "its sibling did not come back with the group");
});

// ── 3. a hidden object cannot be picked ───────────────────────────────────

test("a hidden object is not pickable", () => {
  // the raycaster does not skip invisible objects, so this check is the only
  // thing standing between the owner and dragging something they cannot see
  assert.equal(api.pickableId("boulder_1", [], new Set(), new Set(["boulder_1"])), null);
  assert.equal(api.pickableId("boulder_1", [], new Set(), new Set()), "boulder_1",
    "a visible object stopped being pickable");
});

test("a hidden object inside a visible group is still not pickable", () => {
  const groups = [{ id: "g1", members: ["bench_1", "wall_1"] }];
  assert.equal(api.pickableId("bench_1", groups, new Set(), new Set(["bench_1"])), null);
  assert.equal(api.pickableId("wall_1", groups, new Set(), new Set(["bench_1"])), "wall_1",
    "hiding one member made its sibling unpickable");
});

test("the existing group rules still hold with the new argument", () => {
  const groups = [{ id: "g1", members: ["bench_1"], locked: true }];
  assert.equal(api.pickableId("bench_1", groups, new Set(), new Set()), null, "locked must stay unpickable");
  const groups2 = [{ id: "g1", members: ["bench_1"] }];
  assert.equal(api.pickableId("bench_1", groups2, new Set(["g1"]), new Set()), null,
    "hidden group must stay unpickable");
  assert.equal(api.pickableId(null, [], new Set(), new Set()), null);
  assert.equal(api.pickableId(undefined, [], new Set(), new Set()), null);
});

test("omitting the hidden-object set keeps the old behaviour", () => {
  // called from anywhere that has not been updated, it must not throw
  assert.equal(api.pickableId("boulder_1", [], new Set()), "boulder_1");
});

// ── 4. the wiring, and the view/design split ──────────────────────────────

test("visibility is stored as VIEW state, never written to the design", () => {
  const src = codeOnly(main);
  // localStorage, never the design file — and ONE STORE KEYED BY DESIGN, because
  // a thing hidden in one design must not be hidden in every other.
  const vs = readFileSync(path.join(ROOT, "viewer", "src", "shell", "viewstate.js"), "utf8");
  assert.match(vs, /export const VIEW_STORE_KEY = "yt\.view\.v2"/, "no view store for visibility");
  assert.match(src, /localStorage\.setItem\(VIEW_KEY/, "visibility is not persisted");   // VIEW_STORE_KEY, per site
  assert.match(src, /writeViewScope\(viewStore, viewScope, \{ objects: objectView, groups: groupView \}\)/,
    "object and group visibility are no longer stored together, per design");
  // It must not become a field on a design OBJECT. Note `groups[].hidden` DOES
  // exist in the schema and is left alone here: that is a group field, and this
  // test is about per-object visibility, which is stored in
  // localStorage and must stay out of the file the design agent reads.
  const schema = JSON.parse(readFileSync(path.join(ROOT, "schema", "design.schema.json"), "utf8"));
  for (const key of ["objects", "beds", "paths", "patios", "edges", "steps", "plants"]) {
    const item = schema.properties?.[key]?.items?.properties;
    assert.ok(item, `schema has no ${key} items to check`);
    assert.ok(!("hidden" in item),
      `\`hidden\` became a field on ${key} — that is a view preference in a file the design agent reads`);
  }
  assert.ok(!/setObjectView\([^)]*\)\s*;?\s*await\s+postOps/.test(src),
    "hiding an object posted an op — it must not touch the design");
});

test("the eye is actually rendered on an object row and wired to the scene", () => {
  const src = codeOnly(main);
  const i = src.indexOf("function objectRow");
  assert.notEqual(i, -1, "objectRow not found — this test slices nothing");
  const body = src.slice(i, i + 2200);
  assert.match(body, /hiddenObjectIds\(\)/, "the row does not read the hidden set");
  assert.match(body, /setObjectView\(o\.id/, "the eye does not write the hidden state");
  assert.match(body, /applyLayers\(\)/, "hiding does not update the scene");
  assert.match(body, /stopPropagation/, "the eye click falls through and selects the row");
  // and the scene is actually told about it
  assert.match(src, /applyObjectVisibility\(designGroup, hiddenObjectIds\(\)\)/,
    "applyObjectVisibility is never called with the real hidden set — the shelf is dead code");
  // picking is told too
  // one call, carrying BOTH sets; [^)]* cannot be used here because the arguments
  // themselves contain parentheses
  assert.match(src, /pickableId\([\s\S]{0,160}?hiddenGroups\(\)[\s\S]{0,60}?hiddenObjectIds\(\)/,
    "pickDesignObject does not pass the hidden objects, so you can click what you cannot see");
});

test("hiding a selected object drops it from the selection", () => {
  // Sliced to the EYE HANDLER only. A slice of the whole of objectRow passes on
  // the row's own onclick, which also contains `selection.has(o.id)` and
  // `setSelection` — it stays green with the deselect deleted.
  const src = codeOnly(main);
  const i = src.indexOf("eye.onclick");
  assert.notEqual(i, -1, "the object row has no eye handler — this test slices nothing");
  const end = src.indexOf("row.append(eye)", i);
  assert.ok(end > i, "could not find the end of the eye handler");
  const body = src.slice(i, end);
  assert.ok(body.length > 80, `the eye handler slice is only ${body.length} chars`);
  assert.match(body, /selection\.has\(o\.id\)[\s\S]{0,120}setSelection/,
    "hiding a selected object leaves the gizmo and inspector on something invisible");
});

test("the row has styling for the switched-off state", () => {
  assert.match(html, /#objList \.orow \.eye/, "the per-object eye is unstyled");
  assert.match(html, /#objList \.orow\.off/, "a hidden row looks identical to a visible one");
});
