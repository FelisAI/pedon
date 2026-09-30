/**
 * The transform gizmo — the arithmetic half.
 *
 * The user needs visible move and rotation handles, as in a 3D editor.
 * Moving, reshaping a control point, duplicating, and typing scalars all use
 * /api/ops, judged by the same execute() + validate() as a model op. A drag
 * that only engages on the object's body gives no visible sign it exists.
 *
 * TWO GROUND AXES, OPTIONAL LIFT AND ROTATION RINGS.
 * This is a garden. Every object stands on measured ground — `heightAt` puts it
 * there, `float_check` fails it if it leaves, `check_pad` prices the cut and fill
 * under it, and `level_m` is how a thing legitimately gets a bench. Unrestricted
 * vertical movement would fight all four and produce floating geometry. The lift
 * arrow therefore writes `level_m` and is offered only where that field is legal.
 *
 * PURE: no THREE, no DOM. Vectors are plain [x, y, z] arrays and a ray is
 * { origin, dir } in whatever frame the caller hands over — main.js works in
 * WORLD, because that is what a raycast returns. Nothing here knows which way
 * north is: the caller passes the gizmo's own east/north unit vectors, so the
 * maths is identical at yaw 0 (where ENU and world coincide) and at any other
 * yaw (where they do not). Hardcoding east as [1,0,0] is correct only at yaw 0
 * and silently wrong when "Set north" changes the frame.
 *
 * main.js only wires it. Keeping the arithmetic pure makes geometric behaviour
 * directly testable.
 */

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const ok3 = (v) => Array.isArray(v) && v.length >= 3 && v.every(Number.isFinite);

/** The parts a gizmo has. Vertical movement uses `level_m` — see the header. */
export const PARTS = ["centre", "x", "y", "lift", "ring", "tiltring"];

// Where each part lives, as a fraction of the gizmo's radius. Fractions, not
// metres, because the gizmo is sized in SCREEN space: a tolerance in metres
// would be a hair on a 30 m terrace and the whole yard on a 0.3 m set stone.
const CENTRE_R = 0.20;       // the free-drag disc
const AXIS_GRAB = 0.13;      // how far off an arrow still counts as the arrow
const AXIS_FROM = 0.18;      // arrows start outside the centre disc...
const AXIS_TO = 1.10;        // ...and end just past the arrowhead
const RING_IN = 1.12;        // the ring sits outside the arrows, so they never fight
const RING_OUT = 1.38;

/**
 * How big the gizmo must be, in METRES, to occupy `targetPx` pixels on screen.
 *
 * This is the difference between a usable tool and a joke: in world units a
 * gizmo is a speck on a 30 m yard and a monster on a 0.3 m set stone, and a
 * garden is edited at both scales in the same session. So measure the camera
 * distance — measure, not assume — and convert through the perspective camera's
 * own frustum: at distance d a pixel is `2·tan(fov/2)·d / viewportHeight` metres.
 *
 * The clamp is not a fudge factor. Nose-on the camera the distance goes to zero
 * and so would the gizmo, leaving an invisible unclickable thing; from orbit it
 * would grow past the property. Both ends are pinned so it stays a control.
 */
export function gizmoRadius(camPos, center, fovDeg = 50, viewportH = 800,
                            targetPx = 84, min = 0.05, max = 15) {
  if (!ok3(camPos) || !ok3(center) || !(fovDeg > 0) || !(viewportH > 0)) return min;
  const dist = len(sub(camPos, center));
  if (!Number.isFinite(dist)) return min;
  const metresPerPx = (2 * Math.tan((fovDeg / 2) * Math.PI / 180) * dist) / viewportH;
  const r = targetPx * metresPerPx;
  if (!Number.isFinite(r)) return min;
  return Math.min(max, Math.max(min, r));
}

/**
 * How far along `axis` the pointer is, in metres.
 *
 * The closest point on the axis LINE to the pointer ray. That projection is what
 * makes an axis drag feel right: the pointer wanders wherever the hand goes and
 * the object still only travels along the arrow. Two calls, subtracted, are the
 * metres to move.
 *
 * Returns null when the ray is parallel to the axis — looking straight down an
 * arrow, every point on it is equally close and the honest answer is "no
 * answer", not the far end. A caller that took a number here would teleport the
 * object the moment the camera lined up with the axis.
 */
export function axisParam(ray, center, axis) {
  if (!ray || !ok3(ray.origin) || !ok3(ray.dir) || !ok3(center) || !ok3(axis)) return null;
  const w0 = sub(ray.origin, center);
  const a = dot(ray.dir, ray.dir);
  const b = dot(ray.dir, axis);
  const c = dot(axis, axis);
  const d = dot(ray.dir, w0);
  const e = dot(axis, w0);
  const denom = a * c - b * b;
  if (!(Math.abs(denom) > 1e-9 * a * c)) return null;     // parallel
  const t = (a * e - b * d) / denom;
  return Number.isFinite(t) ? t : null;
}

/** Where the ray meets the plane through `point` with normal `normal`, or null. */
export function planeHit(ray, point, normal) {
  if (!ray || !ok3(ray.origin) || !ok3(ray.dir) || !ok3(point) || !ok3(normal)) return null;
  const denom = dot(ray.dir, normal);
  if (Math.abs(denom) < 1e-9) return null;                 // the ray lies in the plane
  const t = dot(sub(point, ray.origin), normal) / denom;
  if (!(t > 0) || !Number.isFinite(t)) return null;        // behind the camera
  return add(ray.origin, ray.dir, t);
}

/** How far the ray passes from a point, in metres. */
export function rayPointDistance(ray, p) {
  const w = sub(p, ray.origin);
  const dd = dot(ray.dir, ray.dir);
  if (!(dd > 0)) return Infinity;
  const t = dot(w, ray.dir) / dd;
  return len(sub(w, [ray.dir[0] * t, ray.dir[1] * t, ray.dir[2] * t]));
}

/** How far the ray passes from the point `t` metres along `axis` from `center`. */
function rayAxisDistance(ray, center, axis, t) {
  return rayPointDistance(ray, add(center, axis, t));
}

/**
 * The bearing of the pointer around the ring, in DEGREES, counter-clockwise from
 * the gizmo's own east — the same sense `rotateXY` turns a point list and the
 * same sense `rotation_deg` turns an object, so a ring dragged one way never
 * turns the thing the other.
 *
 * Two calls, subtracted through `normalizeDeg`, are the degrees to turn.
 * Returns null when the camera is IN the ground plane: the ring is edge-on, its
 * plane has no intersection to read, and inventing one would spin the object
 * wildly for a pixel of mouse movement.
 */
export function ringDeg(ray, center, east, north, up) {
  const hit = planeHit(ray, center, up);
  if (!hit) return null;
  const v = sub(hit, center);
  const deg = (Math.atan2(dot(v, north), dot(v, east)) * 180) / Math.PI;
  return Number.isFinite(deg) ? deg : null;
}

/** An angle folded into (-180, 180], so a drag past the wrap is 10 deg, not 350. */
export function normalizeDeg(deg) {
  if (!Number.isFinite(deg)) return deg;
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d + 0;                       // never hand back -0
}

/**
 * Which part of the gizmo the pointer ray is over, or null.
 *
 * `g` is { center, east, north, up, radius, ring }. Innermost first, because the
 * parts nest: the centre disc sits inside the arrows and the arrows inside the
 * ring, and the bands above are laid out so no two of them overlap. An axis the
 * ray is parallel to is not pickable at all — see axisParam.
 */
export function pickPart(ray, g) {
  if (!ray || !g || !ok3(g.center) || !(g.radius > 0)) return null;
  const R = g.radius;
  if (rayPointDistance(ray, g.center) <= CENTRE_R * R) return "centre";
  // NEAREST axis wins, not the first one listed. A ray aimed at the vertical
  // arrow can also pass within grabbing distance of the horizontal east axis.
  // First-match would answer "x" and move the object east instead of lifting it.
  let best = null;
  for (const [part, axis] of [["x", g.east], ["y", g.north],
                              ...(g.lift ? [["lift", g.up]] : [])]) {
    if (!ok3(axis)) continue;
    const t = axisParam(ray, g.center, axis);
    if (t === null || t < AXIS_FROM * R || t > AXIS_TO * R) continue;
    const d = rayAxisDistance(ray, g.center, axis, t);
    if (d <= AXIS_GRAB * R && (best === null || d < best.d)) best = { part, d };
  }
  if (best) return best.part;
  // LIFT, the vertical axis, writes `level_m` so vertical movement goes through
  // the same validate(), retaining rules and cut/fill check. float_check still
  // measures where the geometry really ends up. The centre disc takes priority
  // where the axes meet.
  if (g.ring) {
    const hit = planeHit(ray, g.center, g.up);
    if (hit) {
      const d = len(sub(hit, g.center));
      if (d >= RING_IN * R && d <= RING_OUT * R) return "ring";
    }
  }
  // The TILT ring: the same band in the VERTICAL plane whose normal is east, so
  // it turns the object's lean as well as allowing yaw. It is tested after the
  // flat ring, so where the two cross — two points on the east axis — the yaw
  // ring takes priority.
  if (g.tilt) {
    const hit = planeHit(ray, g.center, g.east);
    if (hit) {
      const d = len(sub(hit, g.center));
      if (d >= RING_IN * R && d <= RING_OUT * R) return "tiltring";
    }
  }
  return null;
}

/**
 * What a press grabs, decided in ONE place.
 *
 * The gizmo is drawn on top of everything — depth test off, highest render order
 * — so it wins: grabbing what you can see is the only rule a person can predict.
 * A control point sits on top of the object it belongs to, so it beats a drag on
 * that object's body. Anything left over is the camera's, which is why "orbit"
 * is the fall-through rather than a fourth case anyone has to remember.
 *
 * Ad-hoc if-order is how this becomes three different answers in three handlers.
 */
export function grabOrder(hits = {}) {
  // THE ORBIT MODIFIER WINS OUTRIGHT, before anything else is consulted.
  //
  // The user needs to orbit while holding Command anywhere in the view. On a
  // site with hundreds of objects, requiring empty ground means hunting for a gap. The
  // camera modifier must outrank the gizmo, a control point and a selected
  // object so it works wherever the cursor is.
  //
  // It stays in THIS function rather than becoming a fourth early return in the
  // pointerdown handler, because one place deciding what a press grabs is the
  // whole reason this function exists — three handlers each resolving it in
  // if-order is how they eventually disagree.
  //
  // A ⌘-CLICK still adds to the selection: the click path refuses anything that
  // moved more than 4 px, so the two gestures share a key and never collide.
  if (hits.orbitModifier) return "orbit";
  if (hits.gizmo) return "gizmo";
  if (hits.handle) return "handle";
  // A BODY DRAG MOVES THE CAMERA to prevent accidental object nudges. The gizmo
  // arrows and the control points are the two ways to move an object, and both
  // are things the user aims at deliberately.
  // `hits.object` is still taken, so the rule is stated rather than deleted.
  if (hits.object) return "orbit";
  return "orbit";
}

/**
 * Whether a kind can turn, and HOW — read out of its MOVE_AS spec so there is no
 * second hand-typed list of "what rotates" to drift from the op table.
 *
 *   "field"  an object carries rotation_deg: turning it is one number, and
 *            objects.js already renders it as `g.rotation.y`.
 *   "points" a path, edge, flight, bed or patio is a run of coordinates, and the
 *            only honest meaning of turning one is to swing the whole run about
 *            its own centre. That is a real design act — a terrace turned to
 *            face down the slope instead of across it — and it is expressible in
 *            the existing op, so it is built.
 *   null     a plant is a bare position with no facing. Turning it would do
 *            NOTHING, so it gets no ring: a control that does nothing is worse
 *            than an absent one, because the user will believe it worked.
 */
export function rotatable(spec) {
  if (!spec) return null;
  if ((spec.keep ?? []).includes("rotation_deg")) return "field";
  if (spec.point) return null;
  return ["spline", "polygon"].includes(spec.pts) ? "points" : null;
}

/** The mean of a point list — the centre a shape turns about. */
export function centroid(pts) {
  const good = (pts ?? []).filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!good.length) return null;
  let x = 0, y = 0;
  for (const p of good) { x += p[0]; y += p[1]; }
  return [x / good.length, y / good.length];
}

/**
 * A point list turned `deg` about `center`, counter-clockwise in ENU (east
 * swinging to north) — the sense the ring reads and the sense rotation_deg
 * turns an object.
 *
 * Unrounded on purpose: the caller stores to the centimetre with the same `m2`
 * every other hand edit uses; a second rounding rule here could disagree with
 * the shared rule. Note that a quarter turn
 * lands on -6.1e-17 rather than on 0 (cos 90 is not exactly zero in floating
 * point), so whoever rounds MUST kill the negative zero that produces — `m2`
 * does, and so does snap.js's `r2`.
 */
export function rotateXY(pts, center, deg) {
  if (!Array.isArray(pts) || !Array.isArray(center) || !Number.isFinite(deg)) return pts;
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const [cx, cy] = center;
  return pts.map((p) => {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return p;
    const dx = p[0] - cx, dy = p[1] - cy;
    return [cx + dx * c - dy * s, cy + dx * s + dy * c];
  });
}

/**
 * TYPE AN EXACT DISTANCE WHILE DRAGGING AN ARROW — the way a 3D editor lets you: hold
 * the east arrow, type 1.5, press Enter, and it moves exactly 1.5 m. One keystroke at a time:
 * digits, "." and a leading "-" build the number; Backspace takes one back; Enter applies;
 * Escape cancels the drag. Returns {handled, buffer, value, done, cancel}; `value` is metres,
 * or null while the buffer is not yet a number. Keys it does not own are left alone.
 */
export function typeDistance(buffer, key) {
  let b = String(buffer ?? "");
  if (key === "Escape") return { handled: true, buffer: "", value: null, done: false, cancel: true };
  if (key === "Enter") {
    const v = parseFloat(b);
    return { handled: true, buffer: b, value: Number.isFinite(v) ? v : null, done: Number.isFinite(v), cancel: false };
  }
  if (key === "Backspace") b = b.slice(0, -1);
  else if (/^[0-9]$/.test(key)) b += key;
  else if (key === "." && !b.includes(".")) b += b === "" || b === "-" ? "0." : ".";
  else if (key === "-" && b === "") b = "-";
  else return { handled: false, buffer: b, value: null, done: false, cancel: false };
  const v = parseFloat(b);
  return { handled: true, buffer: b, value: Number.isFinite(v) ? v : null, done: false, cancel: false };
}
