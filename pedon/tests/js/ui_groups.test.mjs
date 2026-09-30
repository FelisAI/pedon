// A design is a hierarchy, not 70 flat rows.
//
// A fire pit terrace and its two retaining walls form ONE unit for the owner.
// renderObjectList and the scene graph must represent that grouping so the
// objects can hide, lock or move as a unit.
//
// Grouping requires applyLayers and applySelectionHighlight to traverse a
// hierarchy instead of a flat designGroup, so this file is in three parts:
//
//   1. BEHAVIOUR — the group model itself, run for real. main.js cannot be
//      imported (it builds a WebGLRenderer at module scope), so the pure block
//      is extracted between two marker comments and evaluated. Extraction is
//      unsafe if indexOf(anchor) returns -1: `slice(-1)` is the file's LAST
//      CHARACTER, so a source assertion can pass without inspecting the code.
//      So both markers are asserted found, in order, before anything is run,
//      and every extracted name is asserted to be a function.
//   2. SCENE GRAPH — regroupScene run against a fake Object3D tree that
//      implements exactly the three.js parenting contract the function uses
//      (add/remove/children/parent/userData), the same trick
//      clean_scene.test.mjs uses. Idempotency is the assertion that matters:
//      the design is rebuilt on every poll, so a regroup that nested group
//      inside group would compound once a second.
//   3. WIRING — the callers. A perfect group model that renderObjectList never
//      calls is invisible to the user.
//
// Counts are asserted BEFORE deltas everywhere. Asserting only the gaps between
// stair levels lets a broken single-tread stair pass vacuously: it has no gaps.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const main = readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const html = readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");

// ── extraction ────────────────────────────────────────────────────────────
const START = "// ── GROUP-MODEL-START ──";
const END = "// ── GROUP-MODEL-END ──";

function groupModelSource() {
  const a = main.indexOf(START);
  const b = main.indexOf(END);
  assert.notEqual(a, -1, `${START} missing from main.js — nothing was extracted`);
  assert.notEqual(b, -1, `${END} missing from main.js — nothing was extracted`);
  assert.ok(b > a, "the group-model markers are in the wrong order");
  const block = main.slice(a + START.length, b);
  assert.ok(block.length > 200, `the extracted block is only ${block.length} chars`);
  return block;
}

const EXPORTED = ["groupIndex", "groupTree", "lockedIds", "selectableIds",
  "regroupScene", "applyGroupVisibility", "withFlatDesign", "withNewGroup",
  "pickableId", "clickSelects"];
const api = new Function(
  `${groupModelSource()}\nreturn { ${EXPORTED.join(", ")} };`)();

/** End index (exclusive) of the {...} block that opens at or after `from`. */
function blockEnd(s, from) {
  const open = s.indexOf("{", from);
  assert.notEqual(open, -1, "no block found");
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") { depth--; if (!depth) return i + 1; }
  }
  throw new Error("unbalanced braces");
}

/** The source text of a named function in main.js, asserted non-trivial. */
function fnBody(name) {
  const at = main.search(new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`));
  assert.notEqual(at, -1, `function ${name} not found in main.js`);
  const body = main.slice(at, blockEnd(main, at));
  assert.ok(body.length > 80, `${name} extracted as only ${body.length} chars`);
  return body;
}

// ── a fake scene graph ────────────────────────────────────────────────────
// Only what regroupScene actually touches. add() re-parents, exactly as
// three.js does — that behaviour is load-bearing: the function moves a mesh
// from the root into a group node without removing it from the root first.
function node(props = {}) {
  const o = {
    name: "", visible: true, userData: {}, children: [], parent: null,
    add(c) { if (c.parent) c.parent.remove(c); c.parent = o; o.children.push(c); return o; },
    remove(c) {
      const i = o.children.indexOf(c);
      if (i >= 0) { o.children.splice(i, 1); c.parent = null; }
      return o;
    },
  };
  return Object.assign(o, props);
}

const leaf = id => node({ userData: { id } });
const makeNode = () => node();

/** Every leaf under `root`, by id, in traversal order. */
function leaves(root) {
  const out = [];
  const walk = o => {
    if (o.userData.id !== undefined) out.push(o.userData.id);
    for (const c of o.children) walk(c);
  };
  for (const c of root.children) walk(c);
  return out;
}

const OBJS = [
  { id: "firepit", kind: "patio", meta: "" },
  { id: "wall_a", kind: "edge", meta: "" },
  { id: "wall_b", kind: "edge", meta: "" },
  { id: "walk", kind: "path", meta: "" },
  { id: "p1", kind: "plant", meta: "" },
];
const TERRACE = () => [{ id: "g1", name: "fire pit terrace", members: ["firepit", "wall_a", "wall_b"] }];


// ── 0. the harness itself, before anything is asserted with it ────────────
test("the group model was really extracted from main.js", () => {
  for (const name of EXPORTED) {
    assert.equal(typeof api[name], "function", `${name} is not a function in the extracted block`);
  }
});

test("the fake scene graph re-parents the way three.js does", () => {
  const a = node(), b = node(), m = leaf("x");
  a.add(m);
  assert.equal(a.children.length, 1);
  b.add(m);
  assert.equal(a.children.length, 0, "add() must detach from the previous parent");
  assert.equal(b.children.length, 1);
  assert.equal(m.parent, b);
});


// ── 1. behaviour: the group model ─────────────────────────────────────────
test("groupTree folds a group's members under it and leaves the rest loose", () => {
  const { rows, loose } = api.groupTree(TERRACE(), OBJS);
  assert.equal(rows.length, 1, "one group in, one row out");
  assert.equal(rows[0].group.id, "g1");
  assert.equal(rows[0].members.length, 3, "the terrace has three members");
  assert.deepEqual(rows[0].members.map(o => o.id), ["firepit", "wall_a", "wall_b"]);
  assert.equal(loose.length, 2, "the two ungrouped objects stay loose");
  assert.deepEqual(loose.map(o => o.id), ["walk", "p1"]);
});

test("with no groups every object is loose — the flat list is the empty case", () => {
  const { rows, loose } = api.groupTree([], OBJS);
  assert.equal(rows.length, 0);
  assert.equal(loose.length, OBJS.length);
  assert.deepEqual(loose.map(o => o.id), OBJS.map(o => o.id));
});

test("membership naming an object the design no longer has is dropped", () => {
  // remove_objects deletes from beds/paths/... and knows nothing about groups,
  // so a dangling id is the normal state after a delete, not a corruption.
  const groups = [{ id: "g1", name: "t", members: ["firepit", "ghost", "wall_a"] }];
  const { rows, loose } = api.groupTree(groups, OBJS);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].members.length, 2, "the ghost must not become a row");
  assert.deepEqual(rows[0].members.map(o => o.id), ["firepit", "wall_a"]);
  assert.equal(loose.length, 3);
});

test("an object listed in two groups is drawn once, under the first", () => {
  // it would otherwise be re-parented twice and vanish from the first group's
  // node — a "disappearing object" bug with a very confusing cause
  const groups = [{ id: "g1", members: ["firepit", "wall_a"] },
                  { id: "g2", members: ["firepit", "wall_b"] }];
  const { rows, loose } = api.groupTree(groups, OBJS);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].members.map(o => o.id), ["firepit", "wall_a"]);
  assert.deepEqual(rows[1].members.map(o => o.id), ["wall_b"], "g2 must not claim it again");
  const shown = [...rows.flatMap(r => r.members.map(o => o.id)), ...loose.map(o => o.id)];
  assert.equal(new Set(shown).size, shown.length, "an object appears exactly once");
  assert.equal(shown.length, OBJS.length, "and every object appears");
});

test("an emptied group still has a row, so it can be seen and removed", () => {
  const { rows } = api.groupTree([{ id: "g1", members: [] }], OBJS);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].members.length, 0);
});

test("lockedIds collects the members of locked groups and nothing else", () => {
  const groups = [{ id: "g1", members: ["firepit", "wall_a"], locked: true },
                  { id: "g2", members: ["walk"] }];
  const locked = api.lockedIds(groups);
  assert.equal(locked.size, 2, "two ids locked, not the whole design");
  assert.ok(locked.has("firepit") && locked.has("wall_a"));
  assert.ok(!locked.has("walk"), "an unlocked group must not lock its members");
  assert.equal(api.lockedIds([]).size, 0);
});


test("a new group takes its members out of the old one, which goes if emptied", () => {
  const before = [{ id: "g1", members: ["firepit", "wall_a"] },
                  { id: "g2", members: ["walk", "p1"] }];
  const after = api.withNewGroup(before, { id: "g3", name: "n", members: ["firepit", "wall_a", "wall_b"] });
  assert.equal(after.length, 2, `${after.length} groups, expected g2 and the new one`);
  assert.deepEqual(after.map(g => g.id), ["g2", "g3"], "g1 lost both members and should be gone");
  assert.deepEqual(after[0].members, ["walk", "p1"], "an untouched group must not be edited");
  assert.deepEqual(after[1].members, ["firepit", "wall_a", "wall_b"]);
  assert.deepEqual(before.map(g => g.members.length), [2, 2], "the input list was mutated");
});

test("a group that keeps some members survives with the rest", () => {
  const after = api.withNewGroup([{ id: "g1", members: ["firepit", "wall_a"] }],
                                 { id: "g2", name: "n", members: ["wall_a"] });
  assert.equal(after.length, 2);
  assert.deepEqual(after[0].members, ["firepit"], "the member that did not move was dropped too");
});

// ── 2. the scene graph ────────────────────────────────────────────────────
test("regroupScene builds one node per group and moves the members into it", () => {
  const root = node();
  for (const o of OBJS) root.add(leaf(o.id));
  assert.equal(root.children.length, 5, "five flat meshes to start");

  const nodes = api.regroupScene(root, TERRACE(), makeNode);
  assert.equal(nodes.length, 1, "one group node returned");
  assert.equal(root.children.length, 3, "one group node + the two loose meshes");

  const g = root.children.find(c => c.userData.groupId === "g1");
  assert.ok(g, "no child carries userData.groupId — nothing to hide or move as a unit");
  assert.equal(g.name, "group:g1", "the node must be findable by name in the scene graph");
  assert.equal(g.children.length, 3);
  assert.deepEqual(g.children.map(c => c.userData.id), ["firepit", "wall_a", "wall_b"]);
  assert.deepEqual(leaves(root).sort(), OBJS.map(o => o.id).sort(), "no mesh was lost");
});

test("regrouping twice is a no-op — the design rebuilds on every poll", () => {
  const root = node();
  for (const o of OBJS) root.add(leaf(o.id));
  api.regroupScene(root, TERRACE(), makeNode);
  const once = { kids: root.children.length, leaves: leaves(root).sort().join(","),
                 depth: root.children.map(c => c.children.length).join(",") };
  assert.equal(once.kids, 3, "guard: the first pass really did group something");

  api.regroupScene(root, TERRACE(), makeNode);
  assert.equal(root.children.length, once.kids, "a second pass nested group inside group");
  assert.equal(leaves(root).sort().join(","), once.leaves);
  assert.deepEqual(root.children.map(c => c.children.length).join(","), once.depth);
  const g = root.children.find(c => c.userData.groupId === "g1");
  assert.ok(g.children.every(c => c.userData.id !== undefined),
    "a group node ended up inside a group node");
});

test("an object taken out of a group comes back to the root", () => {
  const root = node();
  for (const o of OBJS) root.add(leaf(o.id));
  api.regroupScene(root, TERRACE(), makeNode);
  assert.equal(root.children.length, 3, "guard: grouped first");

  api.regroupScene(root, [{ id: "g1", members: ["firepit"] }], makeNode);
  const g = root.children.find(c => c.userData.groupId === "g1");
  assert.equal(g.children.length, 1);
  assert.deepEqual(leaves(root).sort(), OBJS.map(o => o.id).sort(), "the two walls were lost");
  const atRoot = root.children.filter(c => c.userData.id !== undefined).map(c => c.userData.id);
  assert.ok(atRoot.includes("wall_a") && atRoot.includes("wall_b"));
});

test("ungrouping everything restores the flat scene", () => {
  const root = node();
  for (const o of OBJS) root.add(leaf(o.id));
  api.regroupScene(root, TERRACE(), makeNode);
  assert.equal(root.children.length, 3, "guard: grouped first");
  api.regroupScene(root, [], makeNode);
  assert.equal(root.children.length, 5);
  assert.ok(root.children.every(c => c.userData.groupId === undefined), "a group node survived");
  assert.deepEqual(leaves(root).sort(), OBJS.map(o => o.id).sort());
});

test("applyGroupVisibility hides the group node and touches nothing else", () => {
  const root = node();
  for (const o of OBJS) root.add(leaf(o.id));
  api.regroupScene(root, TERRACE(), makeNode);
  const g = root.children.find(c => c.userData.groupId === "g1");
  const loose = root.children.filter(c => c.userData.id !== undefined);
  assert.equal(loose.length, 2, "guard: there are loose meshes to leave alone");

  api.applyGroupVisibility(root, new Set(["g1"]));
  assert.equal(g.visible, false, "the hidden group is still visible");
  assert.ok(loose.every(c => c.visible), "hiding a group hid the rest of the design");
  assert.ok(g.children.every(c => c.visible),
    "members must stay visible=true — the node is what hides, or unhiding is lossy");

  api.applyGroupVisibility(root, new Set());
  assert.equal(g.visible, true, "unhiding did not restore the group");
});


// ── 2b. the shallow scans one file over ───────────────────────────────────
// viewport.js resolves the design as enuGroup.getObjectByName("design") and
// then reads dg.children ONE LEVEL DEEP — in floatCheckOp (line ~376) and in
// subjectOf (line ~48, which is what `look` uses). Inserting a group node makes
// a grouped object a grandchild, so it stops having a userData.id at that level
// and drops out of BOTH without a word. float_check measures ground contact,
// so losing grouped objects from its coverage hides height errors.
//
// A subtree walk in viewport.js can reach grouped objects. main.js instead
// flattens around its own call, and these tests hold that mitigation in place.
test("withFlatDesign measures against a flat graph and puts the grouping back", () => {
  const root = node();
  for (const o of OBJS) root.add(leaf(o.id));
  api.regroupScene(root, TERRACE(), makeNode);
  assert.equal(root.children.length, 3, "guard: grouped before the measurement");

  let seen = null;
  const out = api.withFlatDesign(root, TERRACE(), makeNode, () => {
    seen = root.children.map(c => c.userData.id);
    return "measured";
  });
  assert.equal(out, "measured", "the return value must reach the caller");
  assert.equal(seen.length, 5, `a one-level scan saw ${seen.length} objects, not 5`);
  assert.ok(seen.every(id => id !== undefined),
    "a shallow scan still hit a group node — floatCheckOp would skip it");
  assert.equal(root.children.length, 3, "the grouping was not restored");
  assert.ok(root.children.find(c => c.userData.groupId === "g1"));
});

test("withFlatDesign restores the grouping even when the measurement throws", () => {
  const root = node();
  for (const o of OBJS) root.add(leaf(o.id));
  api.regroupScene(root, TERRACE(), makeNode);
  assert.throws(() => api.withFlatDesign(root, TERRACE(), makeNode, () => { throw new Error("boom"); }),
    /boom/);
  assert.equal(root.children.length, 3, "a thrown measurement left the design flat");
  assert.deepEqual(leaves(root).sort(), OBJS.map(o => o.id).sort());
});

test("the ground-contact check is run against the flat design", () => {
  const body = fnBody("updateGroundContactBadge");
  assert.match(body, /floatCheckOp\(/, "the badge no longer measures anything");
  assert.match(body, /withFlatDesign\(/,
    "floatCheckOp scans one level deep — every grouped object would drop out of it silently");
});

// ── 3. wiring: the callers ────────────────────────────────────────────────
test("the object list is rendered from the tree, not as a flat loop", () => {
  const body = fnBody("renderObjectList");
  assert.match(body, /groupTree\(/, "renderObjectList still renders a flat list");
});

test("every design build regroups the scene, after the group is attached", () => {
  const body = fnBody("loadDesign");
  const add = body.indexOf("designsGroup.add(g)");
  const regroup = body.indexOf("regroupScene(");
  assert.notEqual(add, -1, "loadDesign no longer attaches the design group");
  assert.notEqual(regroup, -1,
    "loadDesign never calls regroupScene — groups would exist in the file and never in the scene");
  assert.ok(regroup > add, "regroupScene runs before the design group is in the scene");
});

test("applyLayers honours per-group hiding", () => {
  const body = fnBody("applyLayers");
  assert.match(body, /applyGroupVisibility\(/,
    "applyLayers still assumes one designGroup with nothing inside it");
});

test("a click cannot reach a locked or a hidden group", () => {
  // three.js r185's Raycaster.intersect tests object.layers and NOT
  // object.visible, so setting visible=false on the group node hides it and
  // leaves it fully clickable — you would select something you cannot see.
  // pickDesignObject already checks designGroup.visible by hand for exactly
  // this reason; this is the same check one level down.
  const groups = [{ id: "g1", members: ["firepit", "wall_a"], locked: true },
                  { id: "g2", members: ["walk"] },
                  { id: "g3", members: ["wall_b"] }];
  const hidden = new Set(["g3"]);
  assert.equal(api.pickableId("p1", groups, hidden), "p1", "an ungrouped object must stay clickable");
  assert.equal(api.pickableId("walk", groups, hidden), "walk", "an ordinary group must stay clickable");
  assert.equal(api.pickableId("firepit", groups, hidden), null, "a locked group was grabbed");
  assert.equal(api.pickableId("wall_b", groups, hidden), null, "a hidden group was grabbed");
  assert.equal(api.pickableId(null, groups, hidden), null, "a miss must stay a miss");
  assert.equal(api.pickableId("wall_b", groups, new Set()), "wall_b", "unhiding did not restore the click");

  const body = fnBody("pickDesignObject");
  assert.match(body, /pickableId\(/, "clicking the yard can still grab a locked or hidden object");
});

test("selection refuses locked ids, so delete cannot reach them", () => {
  // A mention of lockedIds in setSelection does not prove the ids are filtered.
  // Run the filtering decision in the pure block; the source scan below only
  // has to prove setSelection asks it.
  const groups = [{ id: "g1", members: ["firepit", "wall_a"], locked: true },
                  { id: "g2", members: ["walk"] }];
  const asked = ["firepit", "wall_a", "walk", "p1"];
  const got = api.selectableIds(asked, groups);
  assert.equal(got.length, 2, `${got.length} ids admitted, expected the 2 unlocked ones`);
  assert.deepEqual(got, ["walk", "p1"]);
  assert.deepEqual(api.selectableIds(asked, []), asked, "nothing locked, nothing refused");
  assert.deepEqual(api.selectableIds(["firepit"], groups), [], "a wholly locked ask selects nothing");

  const body = fnBody("setSelection");
  assert.match(body, /selectableIds\(/,
    "setSelection admits locked ids — btnSelDelete would then delete them");
});

test("selection highlighting traverses the extra level in the graph", () => {
  // highlighting requires per-instance material cloning; the walk up to the
  // owning object must not stop at a group node
  const body = fnBody("applySelectionHighlight");
  assert.match(body, /userData\.id === undefined/,
    "the owner walk is gone — a group node has no id and would swallow the lookup");
  assert.ok(!/userData\.groupId === undefined/.test(body),
    "the owner walk must key on userData.id, not groupId");
});

test("groups are persisted with the design, not only in this tab", () => {
  const body = fnBody("saveGroups");
  // Through writeDesignDocument(), not writeJson() directly: design.json
  // reaches disk from exactly ONE place (tests/js/ui_write_paths.test.mjs holds
  // that line). Scattered writers with hand-typed key lists can omit kinds such
  // as `steps` from deletion. Grouping must survive a reload through this path.
  assert.match(body, /writeDesignDocument\(/,
    "grouping is lost on reload — it must be written to the design");
  assert.match(body, /tlPush\(/,
    "a group change that skips the timeline makes undo drop the grouping");
});

test("the Group control exists on the working panel and is wired", () => {
  assert.match(html, /id="btnSelGroup"/, "no way to make a group");
  assert.match(main, /getElementById\("btnSelGroup"\)\s*\.\s*(onclick|addEventListener)/,
    "btnSelGroup has markup but no handler");
});

test("the list has styling for the hierarchy it renders", () => {
  // match the base rule: matching any mention of .grow can pass on :hover or
  // .sel rules alone, even when the base rule is missing
  assert.match(html, /#objList \.grow \{/, "no style for a group header row");
  assert.match(html, /\.orow\.child/, "no indent for a grouped object — the tree reads flat");
});

// ── a group is the thing you pick ────────────────────────────────────────
//
// Clicking a grouped object in the 3D view must select the same members as its
// group row in Objects. The gizmo moves the selection together: for example,
// dragging three grouped plants by 0.32 m must move all three by that distance.
test("clicking a grouped object picks the whole group", () => {
  const groups = [{ id: "g1", members: ["p62", "p67", "p68"] }, { id: "g2", members: ["walk"] }];
  assert.deepEqual(api.clickSelects("p67", groups).sort(), ["p62", "p67", "p68"],
    "a click on one member still selects one member — grouping buys nothing");
  assert.deepEqual(api.clickSelects("p1", groups), ["p1"],
    "an ungrouped object must still select just itself");
  assert.deepEqual(api.clickSelects(null, groups), [],
    "a miss must stay a miss");
});

test("alt reaches inside a group, because a group you cannot open is a trap", () => {
  // the counterweight to the test above: adjusting ONE plant of a drift must
  // not require destroying the grouping first. shift and cmd already mean
  // "add to the selection", so the way in is alt.
  const groups = [{ id: "g1", members: ["p62", "p67", "p68"] }];
  assert.deepEqual(api.clickSelects("p67", groups, { inside: true }), ["p67"],
    "alt-click cannot reach a single member");
  assert.deepEqual(api.clickSelects("p1", groups, { inside: true }), ["p1"],
    "alt must not change what an ungrouped click does");
});

test("the click handler asks it, and alt is what opens the group", () => {
  // a UI defect is invisible in source, so this only proves the seam is wired;
  // selecting three grasses and moving them together requires verification by
  // clicking and dragging in the running viewer.
  // Anchor on the SELECT branch's own comment: `pickDesignObject(ev)` is also
  // called by the hover handler, so using it as the anchor can check hover
  // instead of the click path.
  const i = main.indexOf("// plain click selects a design object");
  assert.notEqual(i, -1, "the click-to-select path moved; fix this test");
  const body = main.slice(i, i + 1200);
  assert.match(body, /clickSelects\(id, designGroups\(\), \{ inside: ev\.altKey \}\)/,
    "the click still selects the bare picked id, so a group cannot be moved as one");
  assert.match(body, /known\.has/,
    "a member listed in a group but deleted from the design would enter the selection as a ghost");
});

// ── hiding a group must survive the next render ───────────────────────────
//
// `hiddenGroups()` and `applyLayers()` alone cannot preserve visibility:
// `renderObjectList` runs `updateGroundContactBadge` → `withFlatDesign`, which
// flattens the scene and regroups it. A regroup mints a FRESH `THREE.Group`,
// whose `visible` defaults to true, so a hidden group can reappear on the next
// render even when the panel state is correct.
//
// So a group node's visibility has to survive being destroyed and remade. That
// is regroupScene's business, because regroupScene is the only thing that makes
// them; relying on three callers to re-apply visibility can leave gaps.
test("regroupScene carries a group node's visibility across the rebuild", () => {
  const groups = [{ id: "g1", members: ["p1", "p2"] }, { id: "g2", members: ["walk"] }];
  const root = node();
  for (const id of ["p1", "p2", "walk", "bench"]) root.add(leaf(id));
  const made = api.regroupScene(root, groups, makeNode);
  for (const n of made) if (n.userData.groupId === "g1") n.visible = false;

  // the design is rebuilt about once a second, and every rebuild regroups
  const again = api.regroupScene(root, groups, makeNode);
  const g1 = again.find(n => n.userData.groupId === "g1");
  const g2 = again.find(n => n.userData.groupId === "g2");
  assert.equal(g1.visible, false, "a hidden group came back visible on the next rebuild");
  assert.equal(g2.visible, true, "a group that was never hidden must not inherit the hiding");
});

test("withFlatDesign puts the hiding back, since it flattens and regroups separately", () => {
  // flattening destroys the nodes, so by the time regroup runs there is nothing
  // left to copy from. withFlatDesign must preserve visibility separately;
  // carrying it only inside regroupScene cannot restore a hidden group.
  const groups = [{ id: "g1", members: ["p1", "p2"] }];
  const root = node();
  for (const id of ["p1", "p2", "bench"]) root.add(leaf(id));
  for (const n of api.regroupScene(root, groups, makeNode)) n.visible = false;

  let sawFlat = null;
  api.withFlatDesign(root, groups, makeNode, () => {
    sawFlat = root.children.filter(c => c.userData.groupId !== undefined).length;
  });
  assert.equal(sawFlat, 0, "withFlatDesign did not actually flatten — its whole point");
  const back = root.children.find(c => c.userData.groupId === "g1");
  assert.equal(back.visible, false,
    "the ground badge runs this on every render, so a hidden group must stay hidden");
});

// ── a group belongs to its design ────────────────────────────────────────
//
// Each design retains its own grouping across switches. Grouping must not
// vanish or copy implicitly into another design; transfer between designs
// requires an explicit clipboard.
test("switching designs hands over the incoming document whole", () => {
  const i = main.indexOf("async function loadVariant");
  assert.notEqual(i, -1, "loadVariant moved; fix this test");
  const body = main.slice(i, i + 1400);
  assert.doesNotMatch(body, /carriedGroups/,
    "the switch is copying grouping between designs");
  assert.match(body, /const doc = v;/,
    "the incoming design is being altered on the way in");
});

test("nothing else reaches for a cross-design group copy", () => {
  assert.doesNotMatch(main, /carriedGroups/,
    "carriedGroups copies grouping across a design boundary");
});

// ── select a section by drawing round it ──────────────────────────────────
//
// The user needs to select, group and hide a section of objects to focus on one
// thing. Shift-range in Objects, shift-click in the view, per-object and
// per-group hide, and Solo on ⇧S support this. The area-drawing lasso also lets
// the user choose a section by WHERE IT STANDS rather than by name.
const { idsInsidePolygon } = await import("../../viewer/src/areas.js");
const KINDS = [["plants", "plant"], ["objects", "object"], ["paths", "path"], ["beds", "bed"]];
const SQUARE = [[0, 0], [10, 0], [10, 10], [0, 10]];
const design = {
  plants: [{ id: "in1", position: [5, 5] }, { id: "in2", position: [1, 9] },
           { id: "out1", position: [11, 5] }, { id: "out2", position: [-1, 1] }],
  objects: [{ id: "lantern", position: [2, 2] }],
  paths: [{ id: "whole", spline: [[2, 2], [4, 4], [6, 6]] },
          { id: "half",  spline: [[2, 2], [4, 4], [20, 20]] }],
  beds: [{ id: "bed_in", polygon: [[1, 1], [3, 1], [3, 3], [1, 3]] }],
};

test("a point inside the loop comes with you; one outside does not", () => {
  const got = idsInsidePolygon(design, SQUARE, KINDS);
  assert.ok(got.includes("in1") && got.includes("in2"), "a plant inside the loop was missed");
  assert.ok(!got.includes("out1") && !got.includes("out2"), "a plant outside the loop was caught");
  assert.ok(got.includes("lantern"), "a garden object is a point too and should come");
});

test("a run comes only when it is WHOLLY inside", () => {
  // half a path is not a thing the user can hide; catching the whole contour walk
  // because one vertex clipped the loop is what makes a marquee infuriating
  const got = idsInsidePolygon(design, SQUARE, KINDS);
  assert.ok(got.includes("whole"), "a path entirely inside the loop was missed");
  assert.ok(!got.includes("half"), "a path running far outside the loop was caught by one end");
  assert.ok(got.includes("bed_in"), "a bed entirely inside the loop was missed");
});

test("a LOCKED group is not caught by a loop thrown across it", () => {
  // locking prevents a thing being grabbed; a marquee that ignores it
  // would make the lock worthless exactly when it matters
  const got = idsInsidePolygon(design, SQUARE, KINDS, new Set(["in1","lantern"]));
  assert.ok(!got.includes("in1") && !got.includes("lantern"),
    "a locked group's members were selected by the lasso");
  assert.ok(got.includes("in2"), "locking one group must not stop everything else");
});

test("an empty or degenerate loop selects nothing rather than everything", () => {
  assert.deepEqual(idsInsidePolygon(design, [], KINDS), []);
  assert.deepEqual(idsInsidePolygon(design, null, KINDS), []);
  assert.deepEqual(idsInsidePolygon({}, SQUARE, KINDS), []);
});

test("the stroke is wired to it, and shift adds instead of replacing", () => {
  const i = main.indexOf('if (mode === "pick") {');
  assert.notEqual(i, -1, "the lasso-select branch is gone");
  const body = main.slice(i, i + 1800);
  assert.match(body, /idsInsidePolygon\(currentDesign, poly, DESIGN_KINDS, lockedIds\(designGroups\(\)\)\)/,
    "the finished loop is never turned into a selection");
  assert.match(body, /lassoAdditive/, "shift no longer adds to the selection");
  assert.match(body, /selectableIds\(/,
    "the lasso bypasses selectableIds, so it can select a locked id anyway");
});
