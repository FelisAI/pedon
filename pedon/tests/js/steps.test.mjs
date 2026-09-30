// node --test tests/js/steps.test.mjs
//
// `steps` is a first-class element — schema properties, agent.DESIGN_KEYS,
// DESIGN_GEOM, a set_steps op and its validator rules — and it must also be
// DRAWN. If viewer/src/design.js iterates only beds/paths/edges/patios/plants,
// the validator can tell you to put a flight of steps across a 29% stretch, the
// op accepts it, and the yard looks exactly as it did before.
//
// That is the worst shape a bug can take here: the system reports success and
// shows you nothing.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

globalThis.document = {
  createElement() {
    const ops = [];
    const ctx = { fillStyle: "#000000", fillRect: (x, y, w, h) => ops.push({ style: ctx.fillStyle, x, y, w, h }) };
    return { width: 0, height: 0, ops, getContext: () => ctx };
  },
};

const design = await import(path.join(ROOT, "viewer", "src", "design.js"));
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "schema", "design.schema.json"), "utf8"));

// a 2 m fall over 6 m of run — steep enough that a walk is not allowed and
// steps are the only legal answer, which is exactly when they get built
const FLIGHT = { id: "steps_test", spline: [[0, 0], [0, 6]], width_m: 1.2,
                 riser_m: 0.16, going_m: 0.30, material: "stone" };
const groundFall = (x, z) => -(-z) * (2.0 / 6.0);      // world z = -y, drops 2 m over 6 m

test("the schema really does carry steps, so this is not testing a fiction", () => {
  assert.ok(schema.properties.steps, "schema has no steps array — retarget this test");
});

test("a flight of steps is actually built", async () => {
  const g = await design.buildDesignGroup({ steps: [FLIGHT] }, groundFall, 1);
  const found = g.children.filter(c => c.userData?.id === "steps_test");
  assert.ok(found.length, "buildDesignGroup ignored design.steps — the flight is invisible");
});

test("it spans the fall, in treads rather than a ramp", async () => {
  const g = await design.buildDesignGroup({ steps: [FLIGHT] }, groundFall, 1);
  const m = g.children.find(c => c.userData?.id === "steps_test");
  const pos = m.geometry ? m.geometry.attributes.position : null;
  const ys = [];
  m.traverse(o => {
    const p = o.geometry?.attributes?.position;
    if (!p) return;
    o.updateMatrixWorld(true);
    for (let i = 0; i < p.count; i++) ys.push(p.getY(i) + o.position.y);
  });
  assert.ok(ys.length, "the flight has no geometry at all");
  const span = Math.max(...ys) - Math.min(...ys);
  assert.ok(span > 1.5, `steps span only ${span.toFixed(2)} m of a 2 m fall`);

  // the tell that it is steps and not a ramp: heights cluster on discrete
  // treads, so the number of distinct levels is far below the vertex count
  const levels = new Set(ys.map(y => Math.round(y / FLIGHT.riser_m)));
  assert.ok(levels.size >= 3, `only ${levels.size} distinct levels — that is a ramp, not a flight`);
  assert.ok(levels.size < ys.length / 3, "heights are continuous, not stepped");
});

test("the whole design still builds with steps alongside everything else", async () => {
  const g = await design.buildDesignGroup({
    steps: [FLIGHT],
    paths: [{ id: "p", spline: [[3, 0], [3, 6]], width_m: 1.0, material: "gravel" }],
  }, groundFall, 1);
  assert.ok(g.children.some(c => c.userData?.id === "steps_test"));
  assert.ok(g.children.some(c => c.userData?.id === "p"));
});

test("no riser is ever taller than the one declared", async () => {
  // round() gives a 0.27 m fall a SINGLE 27 cm riser against a declared 18 cm max.
  // Rounding down is the unsafe direction for steps: a riser taller than code is
  // a trip hazard, while more and shallower risers is merely a longer flight. So
  // the count is a ceiling, never a rounding.
  // 0.26, not 0.27: 0.27/0.18 is exactly 1.5 and Math.round takes that UP, so a
  // test built on it passes without touching the bug. A real flight measures a
  // 0.266 m fall -> 1.48 -> rounds DOWN to a single 26.6 cm riser. Pick the case
  // that fails, not the one next to it.
  const fall = 0.26, riser = 0.18;
  const ground = (x, z) => (-z) < 0.01 ? 0 : -fall;      // a clean 0.27 m drop
  const g = await design.buildDesignGroup({ steps: [{
    id: "short", spline: [[0, 0], [0, 1.3]], width_m: 1.1,
    riser_m: riser, going_m: 0.28, material: "stone" }] }, ground, 1);
  const m = g.children.find(c => c.userData?.id === "short");
  const ys = [];
  m.traverse(o => {
    const pos = o.geometry?.attributes?.position;
    if (!pos) return;
    for (let i = 0; i < pos.count; i++) ys.push(pos.getY(i));
  });
  const levels = [...new Set(ys.map(y => +y.toFixed(4)))].sort((a, b) => a - b);

  // Assert the COUNT first. With a single tread there are no gaps to measure, so
  // a drops-only check passes vacuously on exactly the case that is broken.
  const need = Math.ceil(fall / riser);
  assert.ok(levels.length >= need + 1 || levels.length >= need,
    `a ${fall} m fall at a ${riser} m max riser needs at least ${need} treads, got ${levels.length} level(s)`);

  const drops = levels.slice(1).map((y, i) => y - levels[i]).filter(d => d > 1e-6);
  for (const d of drops)
    assert.ok(d <= riser + 1e-6, `a ${(d * 100).toFixed(0)} cm riser against a ${(riser * 100)} cm max`);
});
