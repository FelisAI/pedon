// Camera navigation that does not make you enter a MODE first.
//
// The user must be able to move the camera freely with WASD while viewing,
// without enabling a separate walking mode.
//
// This is the convention every 3D editor converged on, and it is worth following
// exactly because the user already knows it from elsewhere:
//
//   DRAG on empty ground  orbit
//   CMD-DRAG              orbit from ANYWHERE — see gizmo.grabOrder. A site with
//                         hundreds of objects has little empty ground to drag on.
//   RIGHT-DRAG            look around
//   WASD while right-held fly, at the speed the scroll wheel sets
//   RIGHT-CLICK (no drag) a context menu on whatever is under the cursor
//
// The last line is why drag and click have to be told apart rather than one
// winning: right-click is both "look" and "menu" in Unity and Unreal too, and the
// distinction is movement past a threshold. Get that wrong and either the menu
// opens every time you finish turning the camera, or it never opens at all.

export const DRAG_PX = 4;

/**
 * Decide what a right-button release meant. Pure, because it is the whole
 * subtlety and it is invisible to look at: a 3 px wobble while clicking a mouse
 * is normal, and a menu that refuses to open for it reads as a broken button.
 */
export function rightUpIntent(down, up, threshold = DRAG_PX) {
  if (!down) return "none";
  const moved = Math.hypot(up.x - down.x, up.y - down.y);
  return moved > threshold ? "looked" : "menu";
}

/**
 * Which movement keys are held, normalised to what flycam.step expects.
 *
 * Exists so the answer is one function rather than a Set built in three places,
 * and so "is anything held" is cheap enough to ask every frame.
 */
export const MOVE_KEYS = new Set(["w", "a", "s", "d", " ", "c",
                                  "arrowup", "arrowdown", "arrowleft", "arrowright"]);
export const isMoveKey = k => MOVE_KEYS.has((k ?? "").toLowerCase());

/**
 * Should this keypress drive the camera?
 *
 * NOT while focus is in a field — typing a landmark name must not move the
 * camera when the user presses W A S D. And not while a
 * modifier is held, or ⌘S would strafe.
 */
export function movesCamera(ev, activeTag) {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(activeTag ?? "")) return false;
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return false;
  return isMoveKey(ev.key);
}

/**
 * Fly speed from accumulated wheel notches, the way a game does it.
 *
 * Geometric, not linear: the useful range across a 30 m yard runs from a
 * centimetre-per-second nudge when placing a stone to a stride when crossing it,
 * and a linear scale spends most of its travel in the wrong half.
 */
export function speedFor(notches, base = 3.2) {
  const s = base * Math.pow(1.18, Math.max(-14, Math.min(14, notches)));
  return Math.max(0.25, Math.min(40, +s.toFixed(2)));
}

// ── ⌘-DRAG MUST ROTATE, AND OrbitControls DISAGREES ──────────────────────
//
// ⌘-drag must rotate. `grabOrder` hands the gesture to the camera, whose
// bindings must compensate for OrbitControls' modifier handling.
//
// OrbitControls pans on right mouse or left mouse + ctrl/meta/shiftKey. So the
// modifier that means orbit from anywhere is the modifier three.js reserves for
// panning; routing the drag to the camera alone makes it slide sideways.
//
// The inversion is in OrbitControls' own switch, and it is symmetric — a LEFT
// button bound to PAN and a modifier held ROTATES. So binding LEFT to PAN for
// exactly as long as the modifier is down lands on rotate in both states.
//
// Camera POSITION alone cannot verify an orbit: a pan moves the position too.
// Orbit and pan are told apart by the TARGET — an orbit swings the camera around
// a fixed target, a pan carries the target along with it — which is what
// `cameraGesture` below names, so a test cannot confuse the two.

/**
 * What OrbitControls actually does with a left-drag.
 *
 * This mirrors ITS switch, not ours — it is the rule being compensated for, so
 * the test can assert the compensation lands on "rotate" rather than asserting
 * we wrote the line we meant to write.
 */
export function orbitAction(leftBinding, modifierHeld) {
  if (leftBinding === "rotate") return modifierHeld ? "pan" : "rotate";
  if (leftBinding === "pan") return modifierHeld ? "rotate" : "pan";
  return leftBinding;
}

/** The LEFT binding that makes a left-drag rotate whether or not ⌘ is held. */
export function leftBindingFor(modifierHeld) {
  return modifierHeld ? "pan" : "rotate";
}

/** Does this key event hold the orbit modifier? ⌘ on a Mac, ctrl elsewhere. */
export const holdsOrbitModifier = ev => !!(ev?.metaKey || ev?.ctrlKey);

/**
 * Which gesture a camera move was, from before/after readings.
 *
 * An ORBIT swings the camera around a target that does not move; a PAN carries
 * the target with it. Position alone cannot tell them apart, so both camera
 * position and target must be measured.
 */
export function cameraGesture(before, after, eps = 1e-3) {
  const moved = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const cam = moved(before.camera, after.camera);
  const tgt = moved(before.target, after.target);
  if (cam < eps && tgt < eps) return "none";
  return tgt > eps ? "pan" : "orbit";
}

// ── ORBIT ABOUT WHAT IS UNDER THE CURSOR ─────────────────────────────────
//
// The rotation point must be under the cursor.
//
// OrbitControls swings about `controls.target`, which sits wherever it was left —
// usually the middle of the site. So turning to look at one corner swings that
// corner out of frame, requiring a pan to bring it back. Every 3D editor pivots
// about what you are pointing at for exactly this reason.
//
// Setting `controls.target` to the hit turns the view even if the camera
// POSITION stays fixed: OrbitControls.update() ends in `lookAt(target)`, so the
// ORIENTATION snaps to aim at it. A measured example with real OrbitControls is
// a 20.2° turn, with the pointed-at spot jumping from (716, 312) to screen centre.
// Verification must read orientation as well as position. OrbitControls can only
// orbit a point on its view axis, so an off-axis pivot is orbited here, in
// `pivotOrbit`, and the target is kept ON the axis.

/**
 * The point to orbit about, given what the cursor is over.
 *
 * Pure, because every one of these refusals is a judgement that would otherwise
 * be buried in an event handler:
 *
 *  - NOTHING UNDER THE CURSOR keeps the old pivot. A drag over open sky should
 *    turn the view, not fling the pivot to wherever a ray happens to end.
 *  - TOO FAR keeps the old pivot. A grazing ray across a slope hits ground a
 *    hundred metres away, and orbiting about a point that far off is
 *    indistinguishable from not orbiting at all.
 *  - TOO CLOSE keeps the old pivot. A pivot on the camera's own nose spins the
 *    world rather than turning around anything.
 */
export function orbitPivot({ hit, camera, target, maxM = 60, minM = 0.5 } = {}) {
  if (!hit || !camera) return target ?? null;
  const d = Math.hypot(hit[0] - camera[0], hit[1] - camera[1], hit[2] - camera[2]);
  if (!(d >= minM && d <= maxM)) return target ?? null;
  return hit;
}

// ── ORBITING A POINT OFF THE VIEW AXIS ───────────────────────────────────
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = a => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
/** Rodrigues: `v` turned by `ang` radians about the unit axis `k`. */
function turn(v, k, ang) {
  const c = Math.cos(ang), s = Math.sin(ang), kv = cross(k, v), d = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * d, v[1] * c + kv[1] * s + k[1] * d, v[2] * c + kv[2] * s + k[2] * d];
}

/**
 * One step of a ⌘-drag: turn the camera about `pivot` by a mouse delta.
 *
 * Yaw about world up and pitch about the camera's own right axis, both THROUGH
 * the pivot and applied to where the camera is AND where it faces, so the pivot
 * holds its place on screen while the camera turns around it.
 * The angles are OrbitControls' own (2π · pixels / height, same signs),
 * so a ⌘-drag and a plain drag turn at the same rate. Pitch stops short of
 * straight up or down, where "right" stops being defined. Returns the target to
 * hand OrbitControls — ON the view axis at the pivot's depth — so its lookAt
 * reproduces this orientation instead of re-aiming.
 */
export function pivotOrbit({ position, forward, pivot, dx = 0, dy = 0, height = 1, speed = 1, maxUpDot = 0.985 }) {
  const Y = [0, 1, 0];
  const yaw = -speed * 2 * Math.PI * dx / height;
  const pitch = -speed * 2 * Math.PI * dy / height;
  let f = unit(forward);
  let rel = sub(position, pivot);
  if (yaw) { rel = turn(rel, Y, yaw); f = turn(f, Y, yaw); }
  if (pitch) {
    const right = unit(cross(f, Y));
    const f2 = turn(f, right, pitch);
    if (Math.abs(f2[1]) <= maxUpDot) { rel = turn(rel, right, pitch); f = f2; }
  }
  const pos = add(pivot, rel);
  const depth = Math.max(dot(sub(pivot, pos), f), 0.5);
  return { position: pos, forward: f, target: add(pos, [f[0] * depth, f[1] * depth, f[2] * depth]) };
}

// ── A RELOAD REOPENS WHERE YOU WERE ──────────────────────────────────────
//
// Reloading must restore the most recent camera position, rather than an older
// manual Save view bookmark. The camera is remembered as it moves — view state,
// so localStorage — and read back through this.

/** The remembered camera, if it is usable here: finite, and taken of this capture. */
export function readLastCamera(raw, capture) {
  let v;
  try { v = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
  const ok = a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
  if (!v || !ok(v.pos) || !ok(v.target)) return null;
  // a camera placed over a different capture is a camera over nothing
  if ((v.capture ?? null) !== (capture ?? null)) return null;
  if (Math.hypot(v.pos[0] - v.target[0], v.pos[1] - v.target[1], v.pos[2] - v.target[2]) < 1e-6) return null;
  return { pos: v.pos, target: v.target };
}
