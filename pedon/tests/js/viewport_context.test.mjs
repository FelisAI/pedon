// node --test tests/js/viewport_context.test.mjs
//
// A dead WebGL context must REFUSE to render, not return a black frame.
//
// MEASURED: full detail on a large design can lose the context, and after
// that renderer.render() returns in 0 ms with 0 draw calls and every frame is
// black. It does not throw. A broker that posts those frames back as
// successful `look` results fools agent.py's `looked_at_own_work`, which counts
// a look by its presence in the CALL LOG, not by what came back. So a design
// agent whose context has died would "look" at eight black pictures and satisfy
// the gate that exists to make it look at what it designed.
//
// An instrument that reports success while measuring nothing is worse than one
// that refuses.
import test from "node:test";
import assert from "node:assert/strict";
import { contextLost, renderRefusal } from "../../viewer/src/viewport.js";

const live = { getContext: () => ({ isContextLost: () => false }) };
const dead = { getContext: () => ({ isContextLost: () => true }) };
const angry = { getContext: () => { throw new Error("gone"); } };

test("a lost context is detected, and a live one is not", () => {
  assert.equal(contextLost(dead), true);
  assert.equal(contextLost(live), false, "a healthy renderer must not read as lost");
});

test("the check never fails a render on its own account", () => {
  // Instrumentation must not be able to break real work: an exotic or absent
  // renderer reads as "not lost" rather than throwing out of the handler.
  assert.equal(contextLost(angry), false);
  assert.equal(contextLost(null), false);
  assert.equal(contextLost(undefined), false);
  assert.equal(contextLost({}), false);
});

test("a drawing request on a dead context is refused, with the recovery in it", () => {
  for (const op of ["look", "preview", "walkthrough", undefined]) {
    const why = renderRefusal(op, dead);
    assert.ok(why, `op ${op} was allowed to render on a lost context`);
    assert.match(why, /context is lost/);
    assert.match(why, /Reload/, "a refusal that does not say how to recover is a dead end");
  }
});

test("a drawing request on a LIVE context is allowed", () => {
  // The complement, or a guard that refuses everything would pass the test above
  // and break the viewer entirely.
  for (const op of ["look", "preview", "walkthrough", undefined]) {
    assert.equal(renderRefusal(op, live), null, `op ${op} was refused on a healthy context`);
  }
});

test("the CPU ops still answer on a dead context", () => {
  // scan_grid raycasts the mesh and float_check measures geometry; neither draws,
  // and analyze_site depends on scan_grid working. Refusing them would turn one
  // broken tab into a broken onboarding.
  for (const op of ["scan_grid", "frame_check", "float_check"]) {
    assert.equal(renderRefusal(op, dead), null, `${op} needs no live context`);
  }
});
