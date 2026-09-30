// node --test tests/js/walkthrough_stations.test.mjs
//
// The walkthrough must stand where the DESIGN means something.
//
// Cameras placed where the design means something judge it far better than eight
// standard stations sampled along the paths. A planStations that ignores
// `objects`, and uses a patio's `purpose` only as a caption, is blind to the
// things carrying a design's style, and stands in the MIDDLE of a terrace looking
// at its own corner.
//
// The faults that matter are about objects: a lantern filling the face of
// someone SITTING on the bench, the same lantern plugging the moon gate's
// opening, a pergola post cutting the line to the gate, a standing stone lost
// behind planting. None is visible from a point sampled every 5 m along a path.
import test from "node:test";
import assert from "node:assert/strict";
import { planStations } from "../../viewer/src/walkthrough.js";

const DESIGN = {
  paths: [{ id: "walk", spline: [[10, -14], [13, -10], [16, -6]], width_m: 1.1 }],
  patios: [{ id: "court", polygon: [[14, -9], [17, -9], [17, -4], [14, -4]],
             purpose: "one bench looking back west and UP the whole slope" }],
  objects: [
    { id: "court_bench", kind: "bench", position: [16.3, -6.4], rotation_deg: 90 },
    { id: "moon_gate", kind: "moon gate", position: [13.55, -10.5], rotation_deg: 0 },
    { id: "basin", kind: "stone water basin", position: [15.2, -5.6] },
    { id: "lantern", kind: "stone lantern", position: [15.85, -9.25] },
  ],
  beds: [], plants: [],
};

const names = () => planStations(DESIGN).map(s => s.name.toLowerCase());

test("you are sat ON the bench, not near it", () => {
  const st = planStations(DESIGN).find(s => /sitting on the bench/.test(s.name));
  assert.ok(st, "no station sits on the bench — the seat is where the garden is judged from");
  assert.deepEqual(st.eye, [16.3, -6.4], "the station is not actually on the seat");
});

test("a seat is judged from SEATED height", () => {
  const st = planStations(DESIGN).find(s => /sitting on the bench/.test(s.name));
  assert.ok(st.eye_m < 1.4,
    `the bench is viewed from ${st.eye_m} m — standing over a seat cannot show a `
    + "lantern planted a metre and a half in front of a seated face");
});

test("the seat looks at the nearest thing worth looking at", () => {
  const st = planStations(DESIGN).find(s => /sitting on the bench/.test(s.name));
  // basin at 1.4 m beats the lantern at 3.0 m
  assert.deepEqual(st.look, [15.2, -5.6], "the bench is not aimed at anything in particular");
  assert.match(st.name, /basin/, "the station name should say what it is looking at");
});

test("a threshold is looked THROUGH, both ways", () => {
  const through = planStations(DESIGN).filter(s => /through the moon gate/.test(s.name));
  assert.equal(through.length, 2,
    "a moon gate's job is to frame something, and that is invisible from beside it");
  const [a, b] = through;
  // the eye stands back from the gate and the target is past it
  const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  assert.ok(d(a.eye, [13.55, -10.5]) > 2, "the camera is standing in the gateway");
  assert.ok(d(a.look, [13.55, -10.5]) > 2, "it is not looking through to anything");
  assert.ok(d(a.eye, b.eye) > 5, "both stations are on the same side of the gate");
});

test("a focal object is a TARGET, never a station", () => {
  // you look AT a lantern; standing inside one is not a view of the garden
  for (const bad of ["sitting on the stone lantern", "through the stone water basin"]) {
    assert.ok(!names().some(n => n.includes(bad)), `made a station: ${bad}`);
  }
});

test("the path and patio stations still exist", () => {
  // the complement — object stations ADD to the walk, they do not replace it,
  // and a design with no objects must still be walkable
  const n = names();
  assert.ok(n.some(x => x.includes("walk")), "the path walk is gone");
  assert.ok(n.some(x => x.includes("court")), "the usable area is no longer stood in");
  const bare = planStations({ ...DESIGN, objects: [] });
  assert.ok(bare.length > 0, "a design with no objects produces no stations at all");
});
