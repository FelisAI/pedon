// node --test tests/js/pivot_orbit.test.mjs
//
// A ⌘-drag rotates about the point under the cursor WITHOUT the view shifting.
//
// Moving `controls.target` to the point under the cursor at the ⌘-press keeps the
// camera POSITION, but OrbitControls.update() ends in lookAt(target), so the
// ORIENTATION snaps to the new target: measured 20.2° with the real controls. The
// off-axis pivot is orbited by pivotOrbit instead.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "../../viewer/node_modules/three/build/three.module.js";
import { OrbitControls } from "../../viewer/node_modules/three/examples/jsm/controls/OrbitControls.js";
import { pivotOrbit } from "../../viewer/src/shell/navigate.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = a => { const l = Math.hypot(...a); return a.map(v => v / l); };

// a camera looking down into the yard, and a pivot well OFF its view axis
const POS = [10, 6, 10], TARGET = [0, 0, 0];
const FWD = unit(sub(TARGET, POS));
const PIVOT = [4, 0, -3];

/** Where a world point sits in the camera's own frame: right, up, forward. */
function inCameraFrame(pos, fwd, p) {
  const right = unit(cross(fwd, [0, 1, 0])), up = cross(right, fwd), rel = sub(p, pos);
  return [dot(rel, right), dot(rel, up), dot(rel, fwd)];
}

function controlsAt(pos, target) {
  const el = { style: {}, addEventListener() {}, removeEventListener() {}, clientWidth: 1000, clientHeight: 600,
               ownerDocument: { addEventListener() {}, removeEventListener() {} },
               getRootNode() { return { addEventListener() {}, removeEventListener() {} }; } };
  const camera = new THREE.PerspectiveCamera(50, 1000 / 600, 0.1, 500);
  camera.position.set(...pos);
  const controls = new OrbitControls(camera, el);
  controls.target.set(...target);
  camera.lookAt(controls.target);
  controls.update();
  return { camera, controls };
}

test("the bug, in the real OrbitControls: a target moved off-axis turns the view", () => {
  // the instrument, seen positive — or the next test proves nothing
  const { camera, controls } = controlsAt(POS, TARGET);
  const before = camera.quaternion.clone();
  controls.target.set(...PIVOT);                 // moving the target at the press
  controls.update();
  const turned = camera.quaternion.angleTo(before) * 180 / Math.PI;
  assert.ok(turned > 5, `expected moving the target to turn the view; it turned ${turned.toFixed(1)}°`);
});

test("pressing ⌘ does not turn the view, even when OrbitControls runs after it", () => {
  const next = pivotOrbit({ position: POS, forward: FWD, pivot: PIVOT });
  const { camera, controls } = controlsAt(POS, TARGET);
  const before = camera.quaternion.clone();
  camera.position.set(...next.position);
  controls.target.set(...next.target);
  controls.update();
  const turned = camera.quaternion.angleTo(before) * 180 / Math.PI;
  assert.ok(turned < 0.01, `the view turned ${turned.toFixed(2)}° at the press`);
});

test("dragging keeps the pointed-at spot where it was on screen", () => {
  const frame0 = inCameraFrame(POS, FWD, PIVOT);
  for (const [dx, dy] of [[60, 0], [0, 40], [-35, -25], [120, 80]]) {
    const n = pivotOrbit({ position: POS, forward: FWD, pivot: PIVOT, dx, dy, height: 600 });
    const frame = inCameraFrame(n.position, n.forward, PIVOT);
    for (let i = 0; i < 3; i++)
      assert.ok(Math.abs(frame[i] - frame0[i]) < 1e-6,
        `after a (${dx}, ${dy}) drag the pivot moved in the view: ${frame.map(v => v.toFixed(3))} vs ${frame0.map(v => v.toFixed(3))}`);
  }
});

test("it really turns, at OrbitControls' own rate, about the pivot", () => {
  const n = pivotOrbit({ position: POS, forward: FWD, pivot: PIVOT, dx: 100, height: 600 });
  const yaw = Math.atan2(n.forward[0], n.forward[2]) - Math.atan2(FWD[0], FWD[2]);
  const expect = -2 * Math.PI * 100 / 600;
  const wrapped = Math.atan2(Math.sin(yaw - expect), Math.cos(yaw - expect));
  assert.ok(Math.abs(wrapped) < 1e-6, `yawed ${yaw} rad, OrbitControls would turn ${expect}`);
  const r0 = Math.hypot(...sub(POS, PIVOT)), r1 = Math.hypot(...sub(n.position, PIVOT));
  assert.ok(Math.abs(r1 - r0) < 1e-9, "the camera did not stay the same distance from the pivot");
});

test("the target handed back is on the view axis, and pitch never flips over the top", () => {
  const n = pivotOrbit({ position: POS, forward: FWD, pivot: PIVOT, dx: 30, dy: 50, height: 600 });
  const off = cross(unit(sub(n.target, n.position)), n.forward);
  assert.ok(Math.hypot(...off) < 1e-9, "target is off the view axis, so OrbitControls would re-aim");
  // drag down and keep dragging: the camera must stop at the pole, never tip over
  // it, which would flip the heading by 180° and turn the yard upside down
  const heading = f => Math.atan2(f[0], f[2]);
  for (const dy of [15, -15]) {
    let st = { position: POS, forward: FWD };
    for (let i = 0; i < 60; i++) {
      st = pivotOrbit({ ...st, pivot: PIVOT, dy, height: 600 });
      assert.ok(Math.abs(st.forward[1]) <= 0.985 + 1e-9, `step ${i}: past the pole, forward.y ${st.forward[1].toFixed(3)}`);
      const dh = Math.atan2(Math.sin(heading(st.forward) - heading(FWD)), Math.cos(heading(st.forward) - heading(FWD)));
      assert.ok(Math.abs(dh) < 1e-6, `step ${i}: pitching alone swung the heading by ${dh.toFixed(3)} rad`);
    }
  }
});

test("the ⌘ press hands the turn to pivotOrbit and never writes the target itself", () => {
  const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
  const fn = main.slice(main.indexOf("function pivotUnderCursor"), main.indexOf("function pickSurface"));
  assert.ok(fn.length > 0, "pivotUnderCursor is gone — retarget this test");
  assert.doesNotMatch(fn.slice(0, fn.indexOf("let pivotDrag")), /controls\.target\.set/,
    "the press writes controls.target again — that is the jump");
  assert.match(main, /if \(pivot\) \{ pivotDrag = \{ pivot, x: ev\.clientX, y: ev\.clientY \}; controls\.enabled = false; \}/,
    "a ⌘-drag does not start the pivot orbit");
  assert.match(fn, /pivotOrbit\(\{[\s\S]*?pivot: pivotDrag\.pivot/, "the drag does not turn about the pivot");
  assert.match(fn, /addEventListener\("pointerup", endPivotDrag/, "OrbitControls is never handed back the mouse");
});
