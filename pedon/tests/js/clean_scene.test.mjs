// The app's own furniture must not reach the model.
//
// A render path that skips the clean-up draws the reference GridHelper in green
// across the terrain and the design of a frame a critique is written from. Every
// render path has to strip it — the walkthrough, the structure-naming pass
// (renderViews) and the render broker alike. So there are two halves here, and
// BOTH are needed:
//
//   1. withCleanScene() does the right thing (behaviour), and
//   2. every render path that produces a picture for a model goes through it
//      (structure) — the half that is easy to miss.
//
// The helper lives in its own module (viewer/src/clean.js) precisely so it
// can be imported here AND by viewport.js — main.js cannot be imported at all,
// it builds a WebGLRenderer and reads the DOM at module scope. This test
// exercises the real shipped module rather than a copy extracted from main.js,
// so the thing under test and the thing that ships cannot
// drift apart. The behaviour half runs against a fake scene graph of plain
// objects, which is enough — the function is deliberately three.js-free and only
// walks .children and flips .visible.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { withCleanScene } from "../../viewer/src/clean.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = f => readFileSync(path.join(HERE, "..", "..", "viewer", "src", f), "utf8");
const src = SRC("main.js");
const viewportSrc = SRC("viewport.js");


// ── source-scanning helpers (the STRUCTURAL half: does every render path use it) ──
/** End index (exclusive) of the {...} block that starts at or after `from`. */
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

/** End index (exclusive) of the (...) that starts at `open`. */
function parenEnd(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") { depth--; if (!depth) return i + 1; }
  }
  throw new Error("unbalanced parens");
}

// ── a fake of the real scene graph ────────────────────────────────────────
const obj = (props, children = []) =>
  ({ type: "Object3D", name: "", visible: true, userData: {}, children, ...props });

function fakeScene() {
  const scan = obj({ type: "Mesh", name: "scan" });
  const bed = obj({ type: "Mesh", name: "bed_1" });
  const knob = obj({ type: "Mesh", name: "" });          // a cyan landmark pin
  const outline = obj({ type: "Line", name: "houseOutline" });
  const nodes = {
    grid: obj({ type: "GridHelper" }),
    axes: obj({ type: "AxesHelper" }),
    arrow: obj({ type: "ArrowHelper" }),
    sun: obj({ type: "DirectionalLight" }),
    scan, bed, knob, outline,
    markers: obj({ type: "Group", name: "markers" }, [obj({ type: "Mesh" })]),
    proposals: obj({ type: "Group", name: "proposals" }, [obj({ type: "Mesh" })]),
    areas: obj({ type: "Group", name: "areas" }, [obj({ type: "Mesh" })]),
    footprint: null, design: null, scene: null,
  };
  nodes.footprint = obj({ type: "Group", name: "footprint" }, [knob, outline]);
  nodes.design = obj({ type: "Group", name: "design" }, [bed]);
  nodes.scene = obj({ type: "Scene" }, [
    nodes.grid, nodes.axes, nodes.arrow, nodes.sun,
    obj({ type: "Group", name: "geo" }, [
      obj({ type: "Group", name: "level" }, [scan]),
      obj({ type: "Group", name: "enu" }, [
        nodes.markers,
        obj({ type: "Group", name: "designs" }, [nodes.design]),
        nodes.footprint, nodes.proposals, nodes.areas,
      ]),
    ]),
  ]);
  return nodes;
}

// ── 1. behaviour ──────────────────────────────────────────────────────────
/** slice from an anchor, FAILING if the anchor is gone.
 *  indexOf returns -1 when it is, and slice(-1) is the file's last character —
 *  so the regex below could never match and the test would pass green with the
 *  duplicate it forbids sitting live in the file. */
function sliceFrom(src, anchor) {
  const i = src.indexOf(anchor);
  assert.notStrictEqual(i, -1, `anchor "${anchor}" is gone — this test cannot check anything`);
  return src.slice(i);
}

test("the reference grid, axes and north arrow are hidden while rendering", () => {
  const n = fakeScene();
  withCleanScene(n.scene, () => {
    assert.equal(n.grid.visible, false, "GridHelper — the one in v_0011.jpg");
    assert.equal(n.axes.visible, false);
    assert.equal(n.arrow.visible, false);
  });
});

test("the cyan pins, drawn areas and calibration markers are hidden too", () => {
  const n = fakeScene();
  withCleanScene(n.scene, () => {
    assert.equal(n.markers.visible, false);
    assert.equal(n.proposals.visible, false);
    assert.equal(n.areas.visible, false);
    assert.equal(n.knob.visible, false, "landmark pin inside the footprint overlay");
  });
});

test("the garden, the scan and the house outline stay in the picture", () => {
  const n = fakeScene();
  withCleanScene(n.scene, () => {
    assert.equal(n.scan.visible, true);
    assert.equal(n.bed.visible, true);
    assert.equal(n.design.visible, true);
    assert.equal(n.outline.visible, true, "measured site truth, not furniture");
    assert.equal(n.sun.visible, true);
  });
});

test("everything is restored afterwards", () => {
  const n = fakeScene();
  withCleanScene(n.scene, () => {});
  for (const k of ["grid", "axes", "arrow", "markers", "proposals", "areas", "knob"])
    assert.equal(n[k].visible, true, `${k} was left hidden`);
});

test("restore does not switch on a layer the owner had switched off", () => {
  const n = fakeScene();
  n.areas.visible = false;                 // "markers" unchecked in the panel
  withCleanScene(n.scene, () => {});
  assert.equal(n.areas.visible, false);
});

test("keep names the group the caller is photographing", () => {
  const n = fakeScene();
  withCleanScene(n.scene, () => {
    // the naming pass exists to photograph the numbered discs
    assert.equal(n.proposals.visible, true);
    assert.equal(n.grid.visible, false);
  }, { keep: ["proposals"] });
  assert.equal(n.proposals.visible, true);
});

test("the scene is restored when the render throws", () => {
  const n = fakeScene();
  assert.throws(() => withCleanScene(n.scene, () => { throw new Error("render failed"); }),
                /render failed/);
  assert.equal(n.grid.visible, true);
});

test("an async render keeps the scene clean until its promise settles", async () => {
  const n = fakeScene();
  let duringAwait;
  // renderWalkthrough is async; restoring on return would put the grid back
  // before the later frames were taken
  const p = withCleanScene(n.scene, async () => {
    await new Promise(r => setTimeout(r, 5));
    duringAwait = n.grid.visible;
    return "frames";
  });
  assert.equal(n.grid.visible, false, "restored while the render was still running");
  assert.equal(await p, "frames");
  assert.equal(duringAwait, false);
  assert.equal(n.grid.visible, true);
});

test("a sync render's return value passes through", () => {
  assert.equal(withCleanScene(fakeScene().scene, () => 42), 42);
});


// The render BROKER is the path `mcp__yardeye__look` uses, i.e. the frames the
// design agent is actually shown. A broker render outside withCleanScene ships the
// grid, the axes and the cyan pins to the model, and no test of main.js alone
// can see it — so this one reads viewport.js.
test("the render broker renders inside withCleanScene", () => {
  assert.ok(/import\s*\{[^}]*withCleanScene[^}]*\}\s*from\s*["'][^"']*clean\.js["']/.test(viewportSrc),
    "viewport.js does not import withCleanScene — the broker ships the app's furniture to the model");
  const ranges = cleanSceneRanges(viewportSrc);
  assert.ok(ranges.length, "viewport.js imports withCleanScene but never calls it");
  const shots = [];
  for (let i = viewportSrc.indexOf("renderer.render("); i !== -1;
       i = viewportSrc.indexOf("renderer.render(", i + 1)) shots.push(i);
  assert.ok(shots.length, "the broker no longer renders — retarget this test");
  for (const i of shots)
    assert.ok(ranges.some(([a, b]) => i > a && i < b),
      `the render broker draws the app's furniture into the model's picture (offset ${i})`);
});

// ── 2. structure: no render path may skip it ──────────────────────────────
// This is the half that is easy to miss. renderViews() feeds the naming pass and the
// "look at the yard first" design pass; unwrapped, it bakes the grid into both.
function cleanSceneRanges(text = src) {
  const out = [];
  for (let i = text.indexOf("withCleanScene("); i !== -1; i = text.indexOf("withCleanScene(", i + 1)) {
    if (/function\s+$/.test(text.slice(Math.max(0, i - 12), i))) continue;   // the declaration
    out.push([i, parenEnd(text, text.indexOf("(", i))]);
  }
  return out;
}
const inside = (ranges, i) => ranges.some(([a, b]) => i > a && i < b);

test("every renderViews() shot is taken inside withCleanScene", () => {
  const ranges = cleanSceneRanges();
  const decl = src.indexOf("function renderViews(");
  assert.notEqual(decl, -1, "renderViews is gone — retarget this test");
  const end = blockEnd(src, decl);
  const shots = [];
  for (let i = src.indexOf("renderer.render(", decl); i !== -1 && i < end;
       i = src.indexOf("renderer.render(", i + 1)) shots.push(i);
  assert.ok(shots.length, "renderViews no longer renders — retarget this test");
  for (const i of shots)
    assert.ok(inside(ranges, i),
      `renderViews renders the app's furniture into the model's picture (offset ${i})`);
});

test("every walkthrough is rendered inside withCleanScene", () => {
  const ranges = cleanSceneRanges();
  const calls = [];
  for (let i = src.indexOf("renderWalkthrough("); i !== -1;
       i = src.indexOf("renderWalkthrough(", i + 1)) calls.push(i);
  assert.ok(calls.length, "no renderWalkthrough call sites — retarget this test");
  for (const i of calls)
    assert.ok(inside(ranges, i), `renderWalkthrough call at offset ${i} is unwrapped`);
});

test("the walkthrough no longer hand-rolls the hiding it now shares", () => {
  // the extracted block, left behind in one copy, is a second implementation
  // that will drift from the shared one
  assert.ok(!/\["GridHelper", "AxesHelper", "ArrowHelper"\]/.test(
    sliceFrom(src, "btnWalk")), "the helper list is still inlined at the walkthrough");
});
