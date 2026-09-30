// node --test tests/js/
//
// The TRANSFORM GIZMO. Users need visible move and rotation controls to edit
// objects directly, as in a regular 3D editing app.
//
// Everything underneath it already exists: select, drag-to-move, reshape,
// duplicate, every scalar typed, and every one of those emits an OP through
// /api/ops. The HANDLE on the selection shows where to grab and what a drag
// does. A drag that works only when you press on the object's own body is not
// a transform tool, it is a shortcut, and the user cannot see it.
//
// Two decisions are pinned here because they are the ones that would otherwise
// drift:
//
//   * A vertical arrow is offered only where `level_m` is legal. Everything
//     sits on measured ground, and `level_m` is how a thing gets a bench.
//     Lifting a bed freely into the air would fight float_check, the retaining
//     rules and the cut/fill check, so vertical edits write that field and
//     pass through the validators.
//
//   * The maths is PURE and lives in gizmo.js — no THREE, no DOM — so which
//     axis a ray picks, how far along it the pointer has travelled and how many
//     degrees a ring drag is worth can all be checked here, in node, without a
//     GPU. main.js only wires it. Keeping the arithmetic runnable in isolation
//     makes geometric errors testable.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DESIGN_KINDS } from "../../viewer/src/design_doc.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const gz = await import(path.join(ROOT, "viewer", "src", "gizmo.js"));
const snap = await import(path.join(ROOT, "viewer", "src", "snap.js"));
const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "schema", "design.schema.json"), "utf8"));
const code = main.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

function block(start, end, min) {
  const a = main.indexOf(start), b = main.indexOf(end);
  assert.notEqual(a, -1, `${start} missing`);
  assert.notEqual(b, -1, `${end} missing`);
  const s = main.slice(a + start.length, b);
  assert.ok(s.length > min, `block after ${start} is only ${s.length} chars`);
  // DESIGN_KINDS lives in design_doc.js so whole-document writes share the list
  // of kinds a replacement must CLEAR. The extracted source uses it as a free
  // variable, so hand it the REAL list rather than a copy — a stale copy can
  // omit steps and leave them undeletable. Inject it only when referenced, so
  // this stays inert for blocks that do not use it.
  if (/\bDESIGN_KINDS\b/.test(s))
    return `const DESIGN_KINDS = ${JSON.stringify(DESIGN_KINDS)};\n${s}`;
  return s;
}

// The hand-edit block is pure by construction (no DOM, no THREE) EXCEPT for the
// shared pure helpers it imports. Inject those, which also proves main.js reaches
// for gizmo.js's arithmetic instead of growing its own copy: if it had its own,
// these parameters would be shadowed and the tests below would still pass — so
// there is a separate assertion for that further down.
// `document` is injected too, so `snapAngle` can be CALLED here rather than
// pattern-matched. Finding "snapOn" near "toAngle(" does not prove snapAngle
// reads the switch, because the nearby `snapped` function reads the same id.
const dom = { snapOn: false };
const api = new Function(
  "rotateXY", "centroid", "rotatable", "normalizeDeg", "toAngle", "document",
  `${block("// ── HAND-EDIT-START ──", "// ── HAND-EDIT-END ──", 400)}
   return { rotateOps, MOVE_AS, geometryOf, snapAngle, snapStep };`)(
  gz.rotateXY, gz.centroid, gz.rotatable, gz.normalizeDeg, snap.toAngle,
  { getElementById: (id) => (id in dom ? { checked: dom[id], value: dom[id] } : null) });

// The LIFT commit, which needs the gizmo block as well as the hand-edit one:
// liftOps lives with the gizmo and calls MOVE_AS and carry, which live with the
// hand edits. Sliced together so the op a vertical drag actually posts can be
// tested here rather than only in a browser — where it is driven by a pointer
// capture and a raycast and is miserable to reach.
const liftApi = new Function(
  "rotateXY", "centroid", "rotatable", "normalizeDeg", "toAngle", "document",
  "THREE", "enuToWorld", "heightAt", "worldToEnu", "log", "postOps",
  `${block("// ── HAND-EDIT-START ──", "// ── HAND-EDIT-END ──", 400)}
   ${block("// ── GIZMO-START ──", "// ── GIZMO-END ──", 400)}
   return { liftOps };`)(
  gz.rotateXY, gz.centroid, gz.rotatable, gz.normalizeDeg, snap.toAngle,
  { getElementById: () => null }, {}, () => ({}), () => 0, () => [0, 0],
  () => {}, async () => true);

test("a lift posts each thing's own upsert with level_m rewritten", () => {
  const gate = { kind: "object", raw: { id: "moon_gate", kind: "moon gate",
                                        position: [13.5, -10.1], height_m: 2.2, width_m: 1.6 } };
  const ops = liftApi.liftOps([{ found: gate, base: -1.8 }], 0.7);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].tool, "place_object", "a lift must be the object's own upsert");
  assert.equal(ops[0].input.id, "moon_gate");
  assert.deepEqual(ops[0].input.position, [13.5, -10.1], "a lift must not move it sideways");
  assert.equal(ops[0].input.level_m, -1.1, "base -1.8 lifted 0.7 should land at -1.1");
  // the kind has to survive or place_object turns the lantern into a placeholder
  assert.equal(ops[0].input.kind, "moon gate");
  assert.equal(ops[0].input.height_m, 2.2);
});

test("two things lifted together keep their own elevations", () => {
  // the failure this guards: one shared datum would snap them level with each other
  const a = { kind: "object", raw: { id: "a", kind: "lantern", position: [1, 1] } };
  const b = { kind: "object", raw: { id: "b", kind: "basin", position: [2, 2] } };
  const ops = liftApi.liftOps([{ found: a, base: 0 }, { found: b, base: 2.5 }], 0.4);
  assert.equal(ops.length, 2);
  assert.equal(ops[0].input.level_m, 0.4);
  assert.equal(ops[1].input.level_m, 2.9);
  assert.notEqual(ops[0].input.level_m, ops[1].input.level_m);
});

test("a lift of nothing posts nothing, rather than an empty op", () => {
  assert.deepEqual(liftApi.liftOps([], 1), []);
  assert.deepEqual(liftApi.liftOps(null, 1), []);
  assert.deepEqual(liftApi.liftOps(undefined, 1), []);
});

test("a kind with no move spec is dropped, not posted malformed", () => {
  const weird = { kind: "landmark", raw: { id: "L", position: [0, 0] } };
  assert.deepEqual(liftApi.liftOps([{ found: weird, base: 0 }], 1), []);
});

// ── the frames this file works in ─────────────────────────────────────────
// A ray is {origin, dir} in WORLD, because that is what a raycast gives you.
// The gizmo's own axes are handed in as unit vectors, so the maths never has to
// know what north is — which is the point: ENU and world are IDENTICAL at yaw 0
// and separate the moment "Set north" is pressed. Hardcoding [1,0,0] as east
// works at yaw 0 and is silently wrong at a non-zero yaw.
const V = (x, y, z) => [x, y, z];
const DOWN = V(0, -1, 0);
const UP = V(0, 1, 0);
// yaw 0: ENU east is world +x, ENU north is world -z
const EAST0 = V(1, 0, 0), NORTH0 = V(0, 0, -1);
// yaw θ: geoGroup rotates about +y, so a local (x,y,z) becomes
// (x cosθ + z sinθ, y, −x sinθ + z cosθ)
const yawed = (deg) => {
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  return { east: V(c, 0, -s), north: V(-s, 0, -c) };
};
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
/** A pointer ray straight down through a world point — the commonest real case. */
const downAt = (p) => ({ origin: V(p[0], p[1] + 40, p[2]), dir: DOWN });

// ══ 1. SIZED IN SCREEN SPACE ══════════════════════════════════════════════
// A gizmo in metres is a speck on a 30 m yard and a monster on a 0.3 m set
// stone. Every real editor sizes it in pixels; that means measuring the camera
// distance, which is a measurement and not a guess.
const FOV = 50, VH = 900, PX = 84;
const pixelsWide = (r, dist) => (r * VH) / (2 * Math.tan((FOV / 2) * Math.PI / 180) * dist);

test("the gizmo is the same size on screen however far the camera is", () => {
  const near = gz.gizmoRadius(V(0, 3, 0), V(0, 0, 0), FOV, VH, PX);
  const far = gz.gizmoRadius(V(0, 45, 0), V(0, 0, 0), FOV, VH, PX);
  assert.ok(far > near * 10, `${far} m at 45 m is not bigger than ${near} m at 3 m`);
  assert.ok(Math.abs(pixelsWide(near, 3) - PX) < 0.5,
    `${pixelsWide(near, 3).toFixed(1)} px at 3 m, asked for ${PX}`);
  assert.ok(Math.abs(pixelsWide(far, 45) - PX) < 0.5,
    `${pixelsWide(far, 45).toFixed(1)} px at 45 m, asked for ${PX}`);
});

test("it measures the real camera distance, not the height above it", () => {
  // an oblique camera 45 m away is 45 m away whichever direction it lies in
  const straight = gz.gizmoRadius(V(0, 45, 0), V(0, 0, 0), FOV, VH, PX);
  const oblique = gz.gizmoRadius(V(31.82, 31.82, 0), V(0, 0, 0), FOV, VH, PX);
  assert.ok(Math.abs(straight - oblique) < 1e-3,
    `${straight} vs ${oblique} — the distance is not being measured`);
  const off = gz.gizmoRadius(V(14, 45, -6), V(14, 0, -6), FOV, VH, PX);
  assert.ok(Math.abs(off - straight) < 1e-9, "the centre is being ignored");
});

test("it cannot collapse to nothing or swallow the yard", () => {
  assert.ok(gz.gizmoRadius(V(0, 0.001, 0), V(0, 0, 0), FOV, VH, PX) >= 0.05,
    "nose-on the camera, the gizmo became unclickable");
  assert.ok(gz.gizmoRadius(V(0, 40000, 0), V(0, 0, 0), FOV, VH, PX) <= 15,
    "from orbit, the gizmo is bigger than the property");
  for (const bad of [0, -10, NaN, Infinity]) {
    const r = gz.gizmoRadius(V(0, bad, 0), V(0, 0, 0), FOV, VH, PX);
    assert.ok(Number.isFinite(r) && r > 0, `a ${bad} camera gave radius ${r}`);
  }
});

// ══ 2. A DRAG ALONG AN AXIS IS METRES ALONG THAT AXIS ═════════════════════
test("an axis drag reads metres along the axis, and ignores the rest of the pointer", () => {
  const c = V(0, 0, 0);
  assert.ok(Math.abs(gz.axisParam(downAt(V(5, 0, 0)), c, EAST0) - 5) < 1e-9);
  // the same 5 m east, but the pointer is 3 m off the axis: the drag is
  // CONSTRAINED, so it still reads 5 — that is the whole reason to grab an arrow
  assert.ok(Math.abs(gz.axisParam(downAt(V(5, 0, -3)), c, EAST0) - 5) < 1e-9,
    "an off-axis pointer moved the object sideways");
  // and north
  assert.ok(Math.abs(gz.axisParam(downAt(V(0, 0, -4)), c, NORTH0) - 4) < 1e-9);
  assert.ok(Math.abs(gz.axisParam(downAt(V(2, 0, -4)), c, NORTH0) - 4) < 1e-9);
});

test("the offset between two points on the drag is the metres to move", () => {
  const c = V(14, 0, 6);
  const t0 = gz.axisParam(downAt(V(14, 0, 6)), c, EAST0);
  const t1 = gz.axisParam(downAt(V(16.25, 0, 6)), c, EAST0);
  assert.ok(Math.abs((t1 - t0) - 2.25) < 1e-9, `${t1 - t0} m, expected 2.25`);
  // backwards is negative, or the arrow only works one way
  const back = gz.axisParam(downAt(V(12.5, 0, 6)), c, EAST0);
  assert.ok(Math.abs((back - t0) + 1.5) < 1e-9, `${back - t0} m, expected -1.5`);
});

test("an axis you are looking straight down cannot be dragged, and says so", () => {
  // the ray and the axis are parallel: every point on the axis is equally close
  // and the answer is not 'the far end', it is 'no answer'
  assert.equal(gz.axisParam({ origin: V(-20, 0, 0), dir: V(1, 0, 0) }, V(0, 0, 0), EAST0), null);
  assert.equal(gz.axisParam({ origin: V(-20, 0, 0), dir: V(-1, 0, 0) }, V(0, 0, 0), EAST0), null);
  // grazing but not parallel still answers
  assert.ok(Number.isFinite(
    gz.axisParam({ origin: V(-20, 1, 0), dir: V(0.9995, -0.0316, 0) }, V(0, 0, 0), EAST0)));
});

// ══ 3. A RING DRAG IS DEGREES ═════════════════════════════════════════════
test("the ring reads a bearing in the ground plane, counter-clockwise from east", () => {
  const c = V(0, 0, 0);
  const at = (p) => gz.ringDeg(downAt(p), c, EAST0, NORTH0, UP);
  assert.ok(Math.abs(at(V(3, 0, 0)) - 0) < 1e-6, `east read ${at(V(3, 0, 0))}`);
  assert.ok(Math.abs(at(V(0, 0, -3)) - 90) < 1e-6, `north read ${at(V(0, 0, -3))}`);
  assert.ok(Math.abs(Math.abs(at(V(-3, 0, 0))) - 180) < 1e-6);
  assert.ok(Math.abs(at(V(0, 0, 3)) + 90) < 1e-6, `south read ${at(V(0, 0, 3))}`);
});

test("a ring drag is the difference between where it started and where it is", () => {
  const c = V(0, 0, 0);
  const a0 = gz.ringDeg(downAt(V(Math.cos(0.1745) * 4, 0, -Math.sin(0.1745) * 4)),
                        c, EAST0, NORTH0, UP);        // 10 deg
  const a1 = gz.ringDeg(downAt(V(Math.cos(0.9599) * 4, 0, -Math.sin(0.9599) * 4)),
                        c, EAST0, NORTH0, UP);        // 55 deg
  assert.ok(Math.abs(gz.normalizeDeg(a1 - a0) - 45) < 1e-3,
    `${gz.normalizeDeg(a1 - a0)} deg, expected 45`);
  // and it must not report 350 for a 10 deg drag across the wrap
  assert.ok(Math.abs(gz.normalizeDeg(-175 - 175) - 10) < 1e-9,
    "dragging past the wrap reported the long way round");
  assert.equal(gz.normalizeDeg(380), 20);
  assert.equal(gz.normalizeDeg(-370), -10);
  assert.equal(gz.normalizeDeg(180), 180);
});

test("a camera in the ground plane cannot read the ring, rather than reading nonsense", () => {
  assert.equal(gz.ringDeg({ origin: V(-20, 0, 0), dir: V(1, 0, 0) }, V(0, 0, 0),
                          EAST0, NORTH0, UP), null);
});

// ══ 4. WHICH PART THE POINTER IS OVER ═════════════════════════════════════
test("the pointer picks the part it is actually over", () => {
  const R = 2;
  const g = { center: V(0, 0, 0), east: EAST0, north: NORTH0, up: UP, radius: R, ring: true };
  assert.equal(gz.pickPart(downAt(V(0, 0, 0)), g), "centre");
  assert.equal(gz.pickPart(downAt(V(0.6 * R, 0, 0)), g), "x");
  assert.equal(gz.pickPart(downAt(V(0, 0, -0.6 * R)), g), "y");
  assert.equal(gz.pickPart(downAt(V(1.22 * R, 0, 0)), g), "ring");
  assert.equal(gz.pickPart(downAt(V(0, 0, 1.22 * R)), g), "ring", "the ring is a whole circle");
  assert.equal(gz.pickPart(downAt(V(3 * R, 0, 0)), g), null, "it grabbed empty ground");
  assert.equal(gz.pickPart(downAt(V(0.6 * R, 0, -0.6 * R)), g), null,
    "the gap between the two arrows is not an arrow");
});

test("what it picks depends on the gizmo's size, not on metres", () => {
  // the same relative geometry on a 0.3 m stone and on a 30 m terrace
  for (const R of [0.12, 0.3, 2, 9]) {
    const g = { center: V(0, 0, 0), east: EAST0, north: NORTH0, up: UP, radius: R, ring: true };
    assert.equal(gz.pickPart(downAt(V(0, 0, 0)), g), "centre", `R=${R}`);
    assert.equal(gz.pickPart(downAt(V(0.6 * R, 0, 0)), g), "x", `R=${R}`);
    assert.equal(gz.pickPart(downAt(V(1.22 * R, 0, 0)), g), "ring", `R=${R}`);
    assert.equal(gz.pickPart(downAt(V(4 * R, 0, 0)), g), null, `R=${R}`);
  }
});

test("no ring means no ring is pickable", () => {
  const R = 2;
  const g = { center: V(0, 0, 0), east: EAST0, north: NORTH0, up: UP, radius: R, ring: false };
  assert.equal(gz.pickPart(downAt(V(1.22 * R, 0, 0)), g), null,
    "a plant with nothing to rotate still offered a rotation ring");
  assert.equal(gz.pickPart(downAt(V(0.6 * R, 0, 0)), g), "x", "the arrows went with it");
});

test("the vertical axis is OFFERED, not assumed — and only where level_m is legal", () => {
  // A garden sits on measured ground. Lifting a bed freely into the air would
  // fight float_check, the retaining rules and the cut/fill check at once.
  // The vertical handle exists only where `level_m` does, writes that field,
  // and sends the op through the same validate() as everything else. Every lift
  // must measure where the thing ends up.
  assert.deepEqual([...gz.PARTS].sort(),
                   ["centre", "lift", "ring", "tiltring", "x", "y"]);
  const base = { center: V(0, 0, 0), east: EAST0, north: NORTH0, up: UP, radius: 2, ring: true };
  // a ray crossing the vertical arrow from the side, well clear of the centre disc
  const across = { origin: V(6, 1.1, 0), dir: V(-1, 0, 0) };
  assert.equal(gz.pickPart(across, { ...base, lift: true }), "lift");
  // and WITHOUT the offer it must not be grabbable: a plant has no level_m, so a
  // selection containing one gets no vertical handle at all
  assert.notEqual(gz.pickPart(across, { ...base, lift: false }), "lift");
  // the centre disc still wins at the middle, so the two never fight
  assert.equal(gz.pickPart({ origin: V(6, 0, 0), dir: V(-1, 0, 0) },
                           { ...base, lift: true }), "centre");
});

// ══ 5. NORTH IS NOT UP — the frame rule ═══════════════════════════════════
// ENU and world are IDENTICAL at yaw 0, so every one of the tests above would
// also pass for maths that hardcoded east as world +x. Repeat the axis, ring and
// picker checks on a rotated basis.
test("an axis drag is metres along the axis at a non-zero north yaw", () => {
  for (const yaw of [23, -37, 90]) {
    const { east, north } = yawed(yaw);
    const c = V(14, 1.2, -6);
    const t = gz.axisParam(downAt(add(c, east, 5)), c, east);
    assert.ok(Math.abs(t - 5) < 1e-9, `yaw ${yaw}: east drag read ${t}, expected 5`);
    const u = gz.axisParam(downAt(add(c, north, -3.5)), c, north);
    assert.ok(Math.abs(u + 3.5) < 1e-9, `yaw ${yaw}: north drag read ${u}, expected -3.5`);
    // still constrained: 4 m off the east axis, along north
    const v = gz.axisParam(downAt(add(add(c, east, 5), north, 4)), c, east);
    assert.ok(Math.abs(v - 5) < 1e-9, `yaw ${yaw}: an off-axis pointer leaked in (${v})`);
  }
});

test("the ring reads from the gizmo's own east at a non-zero north yaw", () => {
  for (const yaw of [23, -37, 90]) {
    const { east, north } = yawed(yaw);
    const c = V(14, 1.2, -6);
    const e = gz.ringDeg(downAt(add(c, east, 4)), c, east, north, UP);
    assert.ok(Math.abs(e) < 1e-6, `yaw ${yaw}: east read ${e}, expected 0`);
    const n = gz.ringDeg(downAt(add(c, north, 4)), c, east, north, UP);
    assert.ok(Math.abs(n - 90) < 1e-6, `yaw ${yaw}: north read ${n}, expected 90`);
  }
});

test("the picker picks the same parts at a non-zero north yaw", () => {
  const { east, north } = yawed(23);
  const c = V(14, 1.2, -6);
  const g = { center: c, east, north, up: UP, radius: 2, ring: true };
  assert.equal(gz.pickPart(downAt(c), g), "centre");
  assert.equal(gz.pickPart(downAt(add(c, east, 1.2)), g), "x");
  assert.equal(gz.pickPart(downAt(add(c, north, 1.2)), g), "y");
  assert.equal(gz.pickPart(downAt(add(c, east, 2.44)), g), "ring");
});

// ══ 6. PRECEDENCE — one place decides what a press grabs ══════════════════
test("a gizmo drag is not an orbit, not an object drag and not a handle drag", () => {
  // The gizmo is drawn ON TOP of everything (depthTest off, highest renderOrder),
  // so grabbing what you can see is the only rule a person can predict. A control
  // point sits on top of the object it belongs to, so it beats a body drag. What
  // is left is the camera's.
  assert.equal(gz.grabOrder({ gizmo: true, handle: true, object: true }), "gizmo");
  assert.equal(gz.grabOrder({ gizmo: true, handle: false, object: false }), "gizmo");
  assert.equal(gz.grabOrder({ gizmo: false, handle: true, object: true }), "handle");
  // A BODY DRAG IS A CAMERA MOVE: allowing a drag from any point on an object
  // makes accidental moves too easy. The gizmo and the control points are the
  // two ways to move objects, and both are aimed at deliberately.
  assert.equal(gz.grabOrder({ gizmo: false, handle: false, object: true }), "orbit");
  assert.equal(gz.grabOrder({ gizmo: false, handle: false, object: false }), "orbit");
  assert.equal(gz.grabOrder({}), "orbit", "an empty press must fall through to the camera");
});

test("the orbit modifier outranks everything, because it means FROM ANYWHERE", () => {
  // ⌘-drag must orbit without requiring the user to find empty ground first:
  // they grab whatever is under the cursor and turn. It has to beat the gizmo,
  // the control points and the object body here, in the one pure place that
  // decides. A lower priority would let the gesture work over grass but fail
  // over the thing the user is looking at.
  assert.equal(gz.grabOrder({ orbitModifier: true, gizmo: true, handle: true, object: true }),
    "orbit", "⌘-drag over the gizmo did not orbit — it is not 'from anywhere'");
  assert.equal(gz.grabOrder({ orbitModifier: true, handle: true }), "orbit");
  assert.equal(gz.grabOrder({ orbitModifier: true, object: true }), "orbit");
  // and without it nothing changes: ⌘-CLICK still adds to the selection
  assert.equal(gz.grabOrder({ orbitModifier: false, gizmo: true }), "gizmo",
    "the modifier leaked into presses that do not carry it");
});

// ══ 7. WHAT CAN ACTUALLY TURN ═════════════════════════════════════════════
test("only things that can actually turn get a ring", () => {
  // read out of MOVE_AS, which is the one table of what each kind is — a second
  // hand-typed list of what rotates can drift from the shared kind definitions
  assert.equal(gz.rotatable(api.MOVE_AS.object), "field",
    "an object carries rotation_deg: turning it is a field, not a new point list");
  for (const kind of ["path", "edge", "steps"]) {
    assert.equal(gz.rotatable(api.MOVE_AS[kind]), "points",
      `${kind} is a run of points — turning it swings the whole run about its centre`);
  }
  for (const kind of ["bed", "patio"]) {
    assert.equal(gz.rotatable(api.MOVE_AS[kind]), "points");
  }
  // a plant is a bare position with no facing: a ring there would do NOTHING,
  // and a control that does nothing is worse than an absent one
  assert.equal(gz.rotatable(api.MOVE_AS.plant), null, "a plant has no rotation to offer");
  assert.equal(gz.rotatable(undefined), null);
  assert.equal(gz.rotatable({ tool: "x", pts: "position", point: true, keep: [] }), null);
});

test("turning a shape turns it about its own centre", () => {
  assert.deepEqual(gz.centroid([[0, 0], [2, 0], [2, 2], [0, 2]]), [1, 1]);
  const square = [[0, 0], [2, 0], [2, 2], [0, 2]];
  const spun = gz.rotateXY(square, gz.centroid(square), 90);
  // a square turned a quarter turn about its own centre is the same square
  // + 0 because a quarter turn lands on -6.1e-17, not on 0 (cos 90 is not exactly
  // zero), and rounding that gives -0 — which is what m2 kills on the way to disk
  const round = (p) => p.map(v => Math.round(v * 1e6) / 1e6 + 0);
  assert.deepEqual(spun.map(round), [[2, 0], [2, 2], [0, 2], [0, 0]]);
  // and the direction is ENU counter-clockwise: east swings to north, the same
  // sense the ring reads and the same sense rotation_deg turns an object
  const [p] = gz.rotateXY([[1, 0]], [0, 0], 90);
  assert.ok(Math.abs(p[0]) < 1e-12 && Math.abs(p[1] - 1) < 1e-12,
    `east turned to ${JSON.stringify(p)}, expected north`);
  assert.deepEqual(gz.rotateXY(square, gz.centroid(square), 0).map(round), square);
});

// ══ 8. THE OPS — because a hand edit is an op ═══════════════════════
const BED = { id: "b1", mulch: "shredded bark", level_m: -1.2,
              polygon: [[12, -8], [16, -8], [16, -4], [12, -4]] };
const LANTERN = { id: "lantern", kind: "lantern", position: [11.2, 3.4],
                  height_m: 1.4, rotation_deg: 20 };
const EDGE = { id: "bank_steel", material: "corten_steel", height_m: 0.3, level_m: -0.85,
               retains: "downhill",
               spline: [[10.8, -1.55], [11.2, -2.6], [11.4, -3.8]] };

test("turning a bed swings its whole outline and keeps every field", () => {
  const ops = api.rotateOps("bed", BED, 45);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].tool, "upsert_bed");
  const inp = ops[0].input;
  assert.equal(inp.polygon.length, 4, "the turn changed how many corners there are");
  // centre is (14,-6); corner (12,-8) is (-2,-2) from it, turned 45 deg CCW
  assert.deepEqual(inp.polygon[0], [14, -8.83]);
  assert.equal(inp.mulch, "shredded bark", "the mulch was dropped");
  assert.equal(inp.level_m, -1.2, "the level was dropped — the bed left its bench");
  assert.equal(inp.id, "b1");
});

test("turning an edge sends the material back under the name the op expects", () => {
  const inp = api.rotateOps("edge", EDGE, 30)[0].input;
  assert.equal(inp.edge_material, "corten_steel", JSON.stringify(inp));
  assert.equal(inp.material, undefined, "both names were sent");
  assert.equal(inp.spline.length, 3);
  assert.equal(inp.level_m, -0.85);
});

test("turning an object changes which way it FACES, not where it stands", () => {
  const inp = api.rotateOps("object", LANTERN, 40)[0].input;
  assert.equal(inp.rotation_deg, 60);
  assert.deepEqual(inp.position, [11.2, 3.4], "turning it in place moved it");
  assert.equal(inp.kind, "lantern", "turning it changed what it is");
  assert.equal(inp.height_m, 1.4);
  // and it wraps rather than accumulating to 4000 degrees
  assert.equal(api.rotateOps("object", LANTERN, 350)[0].input.rotation_deg, 10);
  assert.equal(api.rotateOps("object", { ...LANTERN, rotation_deg: undefined }, 30)[0]
                  .input.rotation_deg, 30, "an object with no facing yet could not be turned");
});

test("a turn that changes nothing posts nothing", () => {
  assert.deepEqual(api.rotateOps("object", LANTERN, 360), [],
    "a full turn cost a validator round trip and a timeline entry");
  assert.deepEqual(api.rotateOps("bed", BED, 0), []);
  assert.deepEqual(api.rotateOps("bed", BED, 360), []);
});

test("coordinates and angles land at the precision everything else is stored at", () => {
  for (const p of api.rotateOps("bed", BED, 37)[0].input.polygon) {
    assert.deepEqual(p, [+p[0].toFixed(2), +p[1].toFixed(2)], `${JSON.stringify(p)} is not cm`);
    assert.ok(!Object.is(p[0], -0) && !Object.is(p[1], -0), "negative zero reached the op");
  }
  const r = api.rotateOps("object", LANTERN, 7.3456)[0].input.rotation_deg;
  assert.equal(r, +r.toFixed(1), `${r} is finer than a tenth of a degree`);
});

test("turning something that cannot turn is refused, not silently ignored", () => {
  // a plant is a bare position: it has no facing and no line, so a ring would be
  // a control that does nothing
  assert.throws(() => api.rotateOps("plant", { id: "p1", position: [1, 2] }, 30), /rotat/i);
  assert.throws(() => api.rotateOps("bed", { polygon: [[0, 0]] }, 30));
  assert.throws(() => api.rotateOps("bed", BED, NaN));
  assert.throws(() => api.rotateOps("bed", { ...BED, id: undefined }, 30));
});

test("no turn can invent a key the schema rejects", () => {
  const cases = [["bed", BED, "beds"], ["object", LANTERN, "objects"], ["edge", EDGE, "edges"]];
  for (const [kind, raw, key] of cases) {
    const allowed = new Set(Object.keys(schema.properties[key].items.properties));
    for (const k of Object.keys(api.rotateOps(kind, raw, 33)[0].input)) {
      assert.ok(allowed.has(k) || k === "edge_material",
        `turning a ${kind} produced "${k}", which the schema rejects`);
    }
  }
});

// ══ 9. THE WIRING ═════════════════════════════════════════════════════════
test("main.js uses the shared maths and has not grown its own copy", () => {
  assert.match(code, /from\s*["']\.\/gizmo\.js["']/, "main.js does not import gizmo.js");
  for (const fn of ["pickPart", "axisParam", "ringDeg", "gizmoRadius", "grabOrder",
                    "rotateXY", "rotatable"]) {
    assert.ok(code.includes(fn), `${fn} is not used by main.js`);
  }
  // the two arithmetic shapes that would mean a second copy
  assert.doesNotMatch(code, /Math\.atan2\([^)]*\)\s*\*\s*180\s*\/\s*Math\.PI/,
    "main.js has grown its own bearing arithmetic — ringDeg is the one that exists");
  assert.doesNotMatch(code, /function\s+(axisParam|ringDeg|pickPart|gizmoRadius|rotateXY)/,
    "main.js redefines a gizmo function it imports");
});

test("the gizmo is drawn under enuGroup, like every other annotation", () => {
  assert.match(code, /function renderGizmo/, "nothing draws the gizmo");
  const body = code.slice(code.indexOf("function renderGizmo"),
                          code.indexOf("function renderGizmo") + 3000);
  assert.ok(body.length > 200, "renderGizmo is a stub");
  assert.match(body, /enuGroup\.add/,
    "the gizmo is parented to the scene, so it would slide off its own selection "
    + "the moment north is set");
  assert.match(body, /enuToWorld/, "the gizmo is not placed from stored ENU");
});

test("the ONE function that owns the selection draws the gizmo too", () => {
  // setSelection must call renderProperties, renderHandles and renderGizmo so
  // no selection path omits a control. Each renderer gets its own try/catch so
  // one failure cannot prevent the others from drawing.
  const body = code.slice(code.indexOf("function setSelection"),
                          code.indexOf("function setSelection") + 700);
  for (const fn of ["renderSelection", "renderProperties", "renderHandles", "renderGizmo"]) {
    assert.ok(body.includes(fn), `setSelection does not reach ${fn}`);
  }
  assert.match(body, /try\s*\{[^}]*\}\s*catch/, "one renderer throwing takes the rest down");
});

test("the gizmo keeps its size while the camera moves", () => {
  // it is sized from the camera, so it has to be re-sized whenever the camera
  // changes — which on an orbit control means every frame
  const loop = code.slice(code.indexOf("setAnimationLoop"), code.indexOf("setAnimationLoop") + 400);
  assert.match(loop, /[Gg]izmo/, "the gizmo is sized once and then never again");
  assert.match(code, /camera\.fov/, "nothing reads the field of view, so 'pixels' is a guess");
  assert.match(code, /clientHeight|innerHeight/, "nothing reads the viewport height");
});

test("one place decides what a press grabs", () => {
  const i = code.indexOf("grabOrder(");
  assert.notEqual(i, -1, "precedence is decided ad hoc, in if-order");
  const near = code.slice(Math.max(0, i - 900), i + 900);
  assert.match(near, /pickGizmo|gizmo/, "grabOrder is called without asking the gizmo");
  assert.match(near, /pickHandle/, "grabOrder is called without asking the handles");
  // A PURE FUNCTION IS HALF A GUARD. The precedence test above passes with this
  // argument deleted — grabOrder would simply never see the modifier and ⌘-drag
  // would silently stop orbiting, with the whole suite green.
  assert.match(near, /orbitModifier:\s*ev\.metaKey\s*\|\|\s*ev\.ctrlKey/,
    "the press never tells grabOrder whether ⌘ (or ctrl) is held, so "
    + "orbit-from-anywhere cannot fire however grabOrder ranks it");
});

test("a gizmo drag posts an OP — it does not write the file", () => {
  // Check MOVE and TURN separately. Accepting either moveSelection or postOps
  // in one source window can pass with MOVE deleted if TURN's postOps remains.
  assert.notEqual(code.indexOf("gizmoDrag"), -1, "no gizmo-drag state at all");
  const i = code.indexOf("async function endGizmoDrag");
  assert.notEqual(i, -1, "nothing finishes a gizmo drag");
  // the WHOLE function, by brace matching, not a fixed character count. With
  // lift and lean commit paths present, a 1600-character slice can miss MOVE
  // and fail even when the path is correct.
  const body = (() => {
    const open = code.indexOf("{", i);
    let depth = 0;
    for (let k = open; k < code.length; k++) {
      if (code[k] === "{") depth++;
      else if (code[k] === "}" && !--depth) return code.slice(i, k + 1);
    }
    assert.fail("unbalanced braces slicing endGizmoDrag");
  })();
  assert.ok(body.length > 400, `endGizmoDrag sliced to ${body.length} chars`);
  assert.match(body, /moveSelection\(/,
    "a gizmo MOVE bypasses /api/ops — every hand edit must pass through "
    + "the validators");
  assert.match(body, /rotateOps\(/, "a gizmo TURN builds no op");
  assert.match(body, /liftOps\(/, "a gizmo LIFT builds no op");
  assert.match(body, /tilt_deg:/, "a gizmo LEAN builds no op");
  assert.match(body, /postOps\(/, "a gizmo TURN never reaches the op poster");
  assert.doesNotMatch(body, /writeDesignDocument|fetch\(/,
    "the gizmo writes the design file directly");
});

test("angle snap comes from snap.js and is on the user's own switch", () => {
  const imp = code.match(/import\s*\{([^}]*)\}\s*from\s*["']\.\/snap\.js["']/);
  assert.ok(imp, "no named import from snap.js");
  assert.match(imp[1], /toAngle/, "toAngle is not imported — the ring has its own rounding");
  // and it is CALLED, not merely matched: snapping must be optional, because a
  // snap the user cannot turn off imposes a design rule
  dom.snapOn = false;
  assert.equal(api.snapAngle(43), 43,
    "it snapped with the switch off, which makes 15 degree steps a rule");
  assert.equal(api.snapAngle(-2.4), -2.4);
  dom.snapOn = true;
  assert.equal(api.snapAngle(43), 45, "the switch is on and nothing snapped");
  assert.equal(api.snapAngle(-2), 0);
  assert.equal(api.snapAngle(37), 37, "37 is 8 deg from 45 and was pulled anyway");
  dom.snapOn = false;
});

test("the ring is only drawn for kinds that can turn, and only grabbable when drawn", () => {
  // `rotatable` and `pickPart` are both proven behaviourally above; what is left
  // to check is that they are wired to each other. A ring drawn on a plant would
  // be a control that does nothing, and a ring grabbable but not drawn would be
  // an invisible one — the two must come from the same answer.
  const gizmo = block("// ── GIZMO-START ──", "// ── GIZMO-END ──", 800);
  assert.match(gizmo, /rotatable\(/,
    "the gizmo decides what can turn for itself, instead of asking the shared function");
  const body = code.slice(code.indexOf("function renderGizmo"),
                          code.indexOf("function renderGizmo") + 3000);
  assert.match(body, /if\s*\(\s*t\.how\s*\)[\s\S]{0,700}TorusGeometry/,
    "the ring is built unconditionally — a plant would get a control that does nothing");
  assert.match(body, /ring:\s*!!\s*t\.how/,
    "the picker is not told whether a ring was drawn, so it can be grabbed when "
    + "it is not there");
});

test("the owner can put the gizmo away", () => {
  // not a rule either way: the owner judges a design by eye, and an overlay
  // sitting on the thing being judged has to be dismissable
  assert.match(html, /id="gizmoOn"/, "no way to turn the gizmo off");
  assert.match(code, /gizmoOn/, "the switch is never read");
  assert.match(html, /id="gizmoHud"/, "a drag reports no numbers anywhere");
  assert.match(code, /gizmoHud/, "the readout is never written to");
});

// ══ 12. ⌘-DRAG MUST ROTATE, AND three.js BINDS THAT GESTURE TO PAN ════════
// `grabOrder` routes a ⌘-drag to the camera, but OrbitControls maps a right drag
// or a left drag with ctrl/meta/shiftKey to pan. The modifier for orbiting from
// anywhere therefore needs a compensating binding to rotate the view.
import { orbitAction, leftBindingFor, cameraGesture, holdsOrbitModifier }
  from "../../viewer/src/shell/navigate.js";

test("a left-drag rotates whether or not the modifier is held", () => {
  // THE INVARIANT, asserted through OrbitControls' OWN rule rather than by
  // checking we wrote the line we meant to write. `orbitAction` mirrors its
  // switch; if that switch ever changes, this fails instead of quietly panning.
  for (const held of [false, true]) {
    assert.equal(orbitAction(leftBindingFor(held), held), "rotate",
      `⌘ ${held ? "held" : "up"}: the camera ${orbitAction(leftBindingFor(held), held)}s instead of rotating`);
  }
});

test("the rule being inverted is three.js's, and it is symmetric", () => {
  // the compensation only works because PAN + modifier rotates; if this half is
  // wrong the fix above is a coincidence
  assert.equal(orbitAction("rotate", false), "rotate");
  assert.equal(orbitAction("rotate", true), "pan", "the modifier changes a rotate binding to pan");
  assert.equal(orbitAction("pan", true), "rotate", "the symmetry the fix relies on");
  assert.equal(orbitAction("pan", false), "pan");
});

test("orbit and pan are told apart by the TARGET, not by the camera moving", () => {
  // Camera movement alone cannot verify an orbit, because a pan moves the
  // camera too. An orbit swings around a target that stays put; a pan carries
  // the target with it.
  const at = (eye, target) => ({ camera: eye, target });
  assert.equal(cameraGesture(at([8, 6, 10], [0, 0, 0]), at([6, 6.4, 10.7], [0, 0, 0])),
    "orbit");
  assert.equal(cameraGesture(at([8, 6, 10], [0, 0, 0]), at([6, 6.4, 10.7], [-2, 0.4, 0.7])),
    "pan", "a moving target indicates a pan, not an orbit");
  assert.equal(cameraGesture(at([8, 6, 10], [0, 0, 0]), at([8, 6, 10], [0, 0, 0])), "none");
});

test("the modifier is ⌘ on a Mac and ctrl elsewhere, and nothing else", () => {
  assert.equal(holdsOrbitModifier({ metaKey: true }), true);
  assert.equal(holdsOrbitModifier({ ctrlKey: true }), true);
  assert.equal(holdsOrbitModifier({ shiftKey: true }), false,
    "shift also pans in OrbitControls, but shift is the RANGE modifier here");
  assert.equal(holdsOrbitModifier({}), false);
  assert.equal(holdsOrbitModifier(null), false);
});

test("the binding is flipped on the KEY, because the press is already too late", () => {
  // OrbitControls is constructed at main.js:91 and main.js adds its own
  // pointerdown listener a thousand lines later, so OrbitControls' handler runs
  // FIRST. A flip made when the press arrives would be read after it mattered.
  const setup = code.slice(code.indexOf("new OrbitControls"),
                           code.indexOf("new OrbitControls") + 1600);
  assert.match(setup, /function bindLeftFor/, "nothing binds the left button at all");
  assert.match(setup, /addEventListener\("keydown"[^)]*bindLeftFor/,
    "the binding never follows the modifier down");
  assert.match(setup, /addEventListener\("keyup"[^)]*bindLeftFor/,
    "the binding never comes back, so every plain drag would pan afterwards");
  assert.match(setup, /addEventListener\("blur"/,
    "⌘-Tab away with the key down and the keyup never arrives");
  assert.ok(code.indexOf("new OrbitControls") < code.indexOf('addEventListener("pointerdown"'),
    "premise: OrbitControls must be constructed before main.js's own listener");
});

// ══ 13. THE PIVOT IS WHERE THE USER IS POINTING ══════════════════════════
// The rotation point must be under the cursor. OrbitControls swings about
// `controls.target`; leaving it at the middle of the site swings the corner
// the user is looking at out of frame and forces them to pan it back.
import { orbitPivot } from "../../viewer/src/shell/navigate.js";

// THE TARGET IS DELIBERATELY NOT THE ORIGIN. With TGT = [0,0,0] every "keep the
// pivot you had" assertion is satisfied by a mutation that returns [0,0,0]
// instead — the fixture would hide a pivot incorrectly reset to the world
// origin on every miss.
const CAM = [4, 10, -2], TGT = [1.5, -0.5, 2.25];

test("the pivot moves to what is under the cursor", () => {
  assert.deepEqual(orbitPivot({ hit: [3, 0, 4], camera: CAM, target: TGT }), [3, 0, 4]);
});

test("pointing at nothing keeps the pivot it had", () => {
  // a drag over open sky should turn the view, not fling the pivot to wherever
  // a ray happens to end
  assert.deepEqual(orbitPivot({ hit: null, camera: CAM, target: TGT }), TGT);
});

test("a grazing hit a hundred metres off is refused", () => {
  // a ray along a slope hits ground far away, and orbiting about a point that
  // distant is indistinguishable from not orbiting at all
  assert.deepEqual(orbitPivot({ hit: [200, 0, 0], camera: CAM, target: TGT }), TGT);
  // and one comfortably inside the scene's own 60 m box is taken — distances
  // are measured from CAM, not from the origin
  assert.deepEqual(orbitPivot({ hit: [4, 10, 38], camera: CAM, target: TGT }), [4, 10, 38],
    "a hit 40 m away, well inside the scene, was refused");
});

test("a pivot on the camera's own nose is refused", () => {
  // it would spin the world rather than turn around anything
  assert.deepEqual(orbitPivot({ hit: [4.1, 10.05, -2.05], camera: CAM, target: TGT }), TGT);
});

test("the pivot is set only for the ⌘ gesture, and before the drag begins", () => {
  // A PURE FUNCTION IS HALF A GUARD. Every assertion above passes with the call
  // deleted, and the pivot never moves.
  //
  // Only for ⌘: a plain drag on empty ground must keep the pivot it has, or the
  // site swings about a different point every time the user grabs a different
  // patch of grass.
  const at = code.indexOf("const pivot = holdsOrbitModifier(ev) ? pivotUnderCursor(ev) : null;");
  assert.notEqual(at, -1, "nothing ever finds the point under the cursor to orbit");
  const grabAt = code.indexOf("const grab = grabOrder({", at);
  assert.ok(grabAt > at && grabAt - at < 400,
    "the pivot is found somewhere other than immediately before the press is resolved");

  const fn = code.slice(code.indexOf("function pivotUnderCursor"),
                        code.indexOf("function pickSurface"));
  assert.match(fn, /intersectObject\(designGroup/,
    "only the ground is picked, so pointing at a bench pivots on the soil behind it");
  assert.match(fn, /pickSurface\(ev\)/,
    "the scan is not picked, or the splat's height-field march is re-derived");
  // applied by the drag, not by the press: tests/js/pivot_orbit.test.mjs
  assert.match(fn, /pivotOrbit\(/, "the pivot is computed and never applied");
});

test("the snap step is the user's to set, and snapping reads it", () => {
  delete dom.snapStep;
  assert.equal(api.snapStep(), 0.5, "no control should mean the default 0.5 m grid");
  dom.snapStep = "0.1";
  assert.equal(api.snapStep(), 0.1, "the 10 cm choice was not read");
  dom.snapStep = "1";
  assert.equal(api.snapStep(), 1);
  delete dom.snapStep;
  const body = code.slice(code.indexOf("function snapped("), code.indexOf("function snapStep("));
  assert.match(body, /const step = snapStep\(\)/, "snapped does not use the chosen step");
  const html = fs.readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");
  assert.match(html, /id="snapStep"/, "there is no control to choose it with");
});

test("an exact distance can be typed during an arrow drag", () => {
  let s = { buffer: "" };
  for (const k of ["1", ".", "5"]) s = gz.typeDistance(s.buffer, k);
  assert.equal(s.value, 1.5);
  assert.equal(s.buffer, "1.5");
  const enter = gz.typeDistance(s.buffer, "Enter");
  assert.ok(enter.done && enter.value === 1.5, "Enter did not apply 1.5");
  assert.equal(gz.typeDistance("1.5", "Backspace").buffer, "1.");
  assert.equal(gz.typeDistance("", "-").buffer, "-");
  assert.equal(gz.typeDistance("-", "2").value, -2, "a move west / south is a negative distance");
  assert.equal(gz.typeDistance("", ".").buffer, "0.");
  assert.equal(gz.typeDistance("1.2", ".").buffer, "1.2", "a second point was accepted");
  assert.ok(gz.typeDistance("1", "Escape").cancel);
  assert.equal(gz.typeDistance("1", "f").handled, false, "a key it does not own was swallowed");
  assert.equal(gz.typeDistance("", "Enter").done, false, "Enter with nothing typed applied something");
  // and it is WIRED: the drag listens while an arrow is held, and pointer motion does not
  // overwrite what was typed
  assert.match(code, /typeDistance\(d\.typed \?\? "", ev\.key\)/, "no key handler during a drag");
  const upd = code.slice(code.indexOf("function updateGizmoDrag("), code.indexOf("function updateGizmoDrag(") + 900);
  assert.match(upd, /if \(d\.typed\)/, "moving the mouse overwrites the typed distance");
});
