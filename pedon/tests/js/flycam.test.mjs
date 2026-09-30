// node --test tests/js/
//
// The owner needs to move the camera freely, like in a game.
//
// OrbitControls is the wrong instrument for judging a garden. It always looks AT
// a point, so you cannot stand somewhere and turn your head — and visual defects
// show at eye level, by looking around. A fixed set of viewpoints is no
// substitute for being able to just walk.
//
// The maths lives here rather than in main.js because main.js builds a
// WebGLRenderer at module scope and cannot be imported. Nothing in this file
// needs a GPU: it is vectors and clamps, which is exactly the part that is worth
// pinning and exactly the part that goes wrong.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fly = await import(path.join(ROOT, "viewer", "src", "flycam.js"));

const held = (...keys) => new Set(keys);

test("looking around is clamped so the camera can never flip over", () => {
  // past straight up, the view vector inverts and left/right reverse — the
  // single most disorienting bug a free camera can have
  let a = fly.look({ yaw: 0, pitch: 0 }, 0, -100000);
  assert.ok(a.pitch < Math.PI / 2 && a.pitch > Math.PI / 2 - 0.2, `pitch ${a.pitch}`);
  let b = fly.look({ yaw: 0, pitch: 0 }, 0, 100000);
  assert.ok(b.pitch > -Math.PI / 2 && b.pitch < -Math.PI / 2 + 0.2, `pitch ${b.pitch}`);
});

test("yaw wraps instead of growing without bound", () => {
  const a = fly.look({ yaw: 0, pitch: 0 }, 100000, 0);
  assert.ok(Math.abs(a.yaw) <= Math.PI * 2 + 1e-6, `yaw ran away to ${a.yaw}`);
});

test("moving is frame-rate independent", () => {
  // A per-frame delta makes the camera twice as fast on a 120 Hz machine as on a
  // 60 Hz one, which is the classic version of this bug.
  const at = { x: 0, y: 2, z: 0 };
  const one = fly.step(at, held("w"), { yaw: 0, pitch: 0 }, 0.2, {});
  let many = at;
  for (let i = 0; i < 10; i++) many = fly.step(many, held("w"), { yaw: 0, pitch: 0 }, 0.02, {});
  for (const k of ["x", "y", "z"]) {
    assert.ok(Math.abs(one[k] - many[k]) < 1e-6,
      `${k}: one 0.2 s step gave ${one[k]}, ten 0.02 s steps gave ${many[k]}`);
  }
});

test("W goes where you are looking, and A/D strafe square to it", () => {
  const at = { x: 0, y: 0, z: 0 };
  // yaw 0 looks down -Z in three.js
  const f = fly.step(at, held("w"), { yaw: 0, pitch: 0 }, 1, { speed: 1 });
  assert.ok(f.z < -0.9 && Math.abs(f.x) < 1e-6, `forward went to ${JSON.stringify(f)}`);
  const r = fly.step(at, held("d"), { yaw: 0, pitch: 0 }, 1, { speed: 1 });
  assert.ok(r.x > 0.9 && Math.abs(r.z) < 1e-6, `right went to ${JSON.stringify(r)}`);
  // turned 90 degrees, forward becomes what right used to be
  const t = fly.step(at, held("w"), { yaw: Math.PI / 2, pitch: 0 }, 1, { speed: 1 });
  assert.ok(t.x < -0.9, `after turning, forward went to ${JSON.stringify(t)}`);
});

test("in FLY you can climb by looking up; in WALK you never leave your height", () => {
  const at = { x: 0, y: 5, z: 0 };
  const up = fly.step(at, held("w"), { yaw: 0, pitch: 0.7 }, 1, { speed: 1, mode: "fly" });
  assert.ok(up.y > 5.2, `fly forward while looking up did not climb: ${up.y}`);
  const walk = fly.step(at, held("w"), { yaw: 0, pitch: 0.7 }, 1, { speed: 1, mode: "walk" });
  assert.equal(walk.y, 5, "walking forward while looking up changed height");
  assert.ok(walk.z < -0.9, `walking forward did not move: ${JSON.stringify(walk)}`);
});

test("space and c go straight up and down whatever you are looking at", () => {
  const at = { x: 0, y: 5, z: 0 };
  const u = fly.step(at, held(" "), { yaw: 0.9, pitch: -1.2 }, 1, { speed: 1 });
  assert.ok(u.y > 5.9 && Math.abs(u.x) < 1e-6 && Math.abs(u.z) < 1e-6, JSON.stringify(u));
  const d = fly.step(at, held("c"), { yaw: 0.9, pitch: -1.2 }, 1, { speed: 1 });
  assert.ok(d.y < 4.1, JSON.stringify(d));
});

test("shift sprints, and holding nothing stands still", () => {
  const at = { x: 0, y: 0, z: 0 };
  const walk = fly.step(at, held("w"), { yaw: 0, pitch: 0 }, 1, { speed: 1 });
  const run = fly.step(at, held("w", "shift"), { yaw: 0, pitch: 0 }, 1, { speed: 1 });
  assert.ok(Math.abs(run.z) > Math.abs(walk.z) * 2, `sprint ${run.z} vs walk ${walk.z}`);
  const still = fly.step(at, held(), { yaw: 0, pitch: 0 }, 1, { speed: 1 });
  assert.deepEqual(still, at);
});

test("diagonals are not faster than straight lines", () => {
  // the oldest bug in first-person movement: W+D adds two unit vectors and you
  // sprint sideways at 1.41x
  const at = { x: 0, y: 0, z: 0 };
  const len = p => Math.hypot(p.x, p.y, p.z);
  const straight = len(fly.step(at, held("w"), { yaw: 0, pitch: 0 }, 1, { speed: 1 }));
  const diagonal = len(fly.step(at, held("w", "d"), { yaw: 0, pitch: 0 }, 1, { speed: 1 }));
  assert.ok(Math.abs(diagonal - straight) < 1e-6,
    `diagonal travels ${diagonal.toFixed(3)} against ${straight.toFixed(3)} straight`);
});

test("handing back to orbit leaves the target where you are looking", () => {
  // Returning to OrbitControls with a stale target makes the camera swing across
  // the garden the moment you drag — you look away from what you just walked to.
  const t = fly.orbitTarget({ x: 3, y: 2, z: -4 }, { yaw: Math.PI / 2, pitch: 0 }, 6);
  assert.ok(Math.abs(t.x - (3 - 6)) < 1e-6, `target x ${t.x}`);
  assert.ok(Math.abs(t.z - -4) < 1e-6, `target z ${t.z}`);
  assert.ok(Math.abs(t.y - 2) < 1e-6, `target y ${t.y}`);
});

// ══ the wiring ════════════════════════════════════════════════════════════
// The maths above is worth nothing if nothing calls it — a capability with no
// caller does not exist.
import { readFileSync } from "node:fs";
const main = readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const code = main.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const html = readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");

test("the viewer actually uses flycam rather than its own copy of the maths", () => {
  assert.match(code, /import\s*\*\s*as\s+flycam\s+from\s+["']\.\/flycam\.js["']/,
    "main.js does not import flycam.js");
  for (const fn of ["flycam.step(", "flycam.look(", "flycam.orbitTarget(", "flycam.viewFrom("]) {
    assert.ok(code.includes(fn), `main.js never calls ${fn}`);
  }
  assert.doesNotMatch(code, /Math\.sin\(\s*fly\.view\.yaw/,
    "main.js has grown its own copy of the forward vector");
});

test("it is reachable without knowing a keyboard shortcut", () => {
  assert.match(html, /id="btnFly"/, "no button — the feature is invisible");
  assert.match(code, /getElementById\("btnFly"\)\.onclick/, "the button does nothing");
});

test("the free camera and OrbitControls are never both driving", () => {
  // two controllers writing camera.position in one frame is a fight the user sees
  // as jitter, and it is the reason area-draw already disables controls
  assert.match(code, /controls\.enabled\s*=\s*!on/,
    "entering the free camera does not disable OrbitControls");
  assert.match(code, /if\s*\(!fly\.on\)\s*controls\.update\(\)/,
    "the frame loop still runs controls.update() while flying");
});

test("dt is seconds, and a backgrounded tab cannot fling the camera", () => {
  const body = code.slice(code.indexOf("function stepFly"), code.indexOf("// ── FLY-END"));
  assert.ok(body.includes("/ 1000"), "dt is not converted to seconds");
  assert.match(body, /Math\.min\(\s*0?\.\d+\s*,/,
    "dt is not clamped — returning to a background tab hands you a multi-second "
    + "frame and the first step teleports the camera");
});

test("losing focus stops you walking", () => {
  assert.match(code, /addEventListener\("blur",\s*\(\)\s*=>\s*fly\.keys\.clear\(\)\)/,
    "alt-tabbing mid-stride leaves the key held and the camera drifting for ever");
});
