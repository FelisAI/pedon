/**
 * A free camera — stand somewhere and turn your head.
 *
 * The owner needs to move the camera freely, like in a game.
 *
 * OrbitControls is the wrong instrument for judging a garden. It always looks AT
 * a point, so the one thing you actually do on site — stop, and look around from
 * where you are standing — is the one thing it cannot express. A fixed set of
 * viewpoints is no substitute for being able to just walk, and visual defects
 * show at eye level.
 *
 * Pure functions, no THREE and no DOM, because main.js builds a WebGLRenderer at
 * module scope and cannot be imported by a test. Everything here is vectors and
 * clamps — which is both the part worth pinning and the part that goes wrong.
 *
 * Convention is three.js's: yaw 0 looks down -Z, +pitch looks up, +X is right.
 */

export const DEFAULTS = {
  speed: 6,          // m/s — a brisk walk; a garden is tens of metres end to end
  sprint: 4,         // shift multiplier: crossing the yard should take a moment, not a minute
  sensitivity: 0.0022,   // radians per pixel
  mode: "fly",       // "fly" follows your gaze; "walk" keeps your height
};

// Just short of straight up. AT straight up the forward vector is degenerate and
// left/right invert as you cross it, which is the most disorienting thing a free
// camera can do.
const PITCH_LIMIT = Math.PI / 2 - 0.02;
const TAU = Math.PI * 2;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** New {yaw, pitch} after a mouse move of (dx, dy) pixels. */
export function look(view, dx, dy, sensitivity = DEFAULTS.sensitivity) {
  // yaw wraps rather than accumulating: a long session of turning one way should
  // not end with a number that has lost its low-order bits
  const yaw = ((view.yaw - dx * sensitivity) % TAU + TAU) % TAU;
  return { yaw, pitch: clamp(view.pitch - dy * sensitivity, -PITCH_LIMIT, PITCH_LIMIT) };
}

/** Unit forward for this view. In "walk" it is flattened onto the ground. */
export function forward(view, mode = DEFAULTS.mode) {
  const cp = mode === "walk" ? 1 : Math.cos(view.pitch);
  return {
    x: -Math.sin(view.yaw) * cp,
    y: mode === "walk" ? 0 : Math.sin(view.pitch),
    z: -Math.cos(view.yaw) * cp,
  };
}

/** Unit right. Always horizontal — strafing up a wall is not a thing. */
export function right(view) {
  return { x: Math.cos(view.yaw), y: 0, z: -Math.sin(view.yaw) };
}

/**
 * Advance the camera by `dt` SECONDS.
 *
 * dt, not frames. A per-frame delta makes the camera twice as fast on a 120 Hz
 * machine as on a 60 Hz one, and the person tuning the speed only ever feels
 * their own monitor.
 */
export function step(pos, keys, view, dt, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const f = forward(view, o.mode);
  const r = right(view);
  let x = 0, y = 0, z = 0;
  const on = k => keys.has(k);
  if (on("w") || on("arrowup")) { x += f.x; y += f.y; z += f.z; }
  if (on("s") || on("arrowdown")) { x -= f.x; y -= f.y; z -= f.z; }
  if (on("d") || on("arrowright")) { x += r.x; z += r.z; }
  if (on("a") || on("arrowleft")) { x -= r.x; z -= r.z; }
  if (on(" ")) y += 1;
  if (on("c")) y -= 1;

  const len = Math.hypot(x, y, z);
  if (len < 1e-9) return pos;
  // NORMALISE. Adding forward and right un-normalised is the oldest bug in
  // first-person movement: W+D travels 1.41x as fast as W, so the quickest way
  // across any garden is diagonally, which nobody intends.
  const v = (o.speed * (on("shift") ? o.sprint : 1) * dt) / len;
  return { x: pos.x + x * v, y: pos.y + y * v, z: pos.z + z * v };
}

/**
 * Where OrbitControls should aim when the free camera hands back.
 *
 * Handing back with a stale target makes the camera swing across the garden the
 * instant you drag — you get thrown away from the thing you just walked over to
 * look at. So the target becomes a point straight ahead of where you are looking.
 */
export function orbitTarget(pos, view, distance = 8) {
  const f = forward(view, "fly");
  return { x: pos.x + f.x * distance, y: pos.y + f.y * distance, z: pos.z + f.z * distance };
}

/** The view angles that reproduce the camera's current orientation. */
export function viewFrom(pos, target) {
  const dx = target.x - pos.x, dy = target.y - pos.y, dz = target.z - pos.z;
  const flat = Math.hypot(dx, dz);
  return {
    yaw: ((Math.atan2(-dx, -dz) % TAU) + TAU) % TAU,
    pitch: clamp(Math.atan2(dy, flat || 1e-9), -PITCH_LIMIT, PITCH_LIMIT),
  };
}
