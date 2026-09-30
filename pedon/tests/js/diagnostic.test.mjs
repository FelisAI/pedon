// node --test tests/js/diagnostic.test.mjs
//
// Make it perceivable, then let the model design.
//
// The renders the model sees show GEOMETRY ONLY — the same photograph a person
// would take. Every measurement it needs arrives separately, as numbers in a text
// block, which it must fuse with the image in its head and must remember to ask
// for at all. Without this layer "do not design past the scan" is a rule it obeys
// blindly rather than a boundary it can see, and a path crossing a 25% face looks
// exactly like a path crossing a 5% one.
//
// The model should see everything and act like a real designer. A real designer
// standing in a yard cannot read grade as a number either — they feel it
// underfoot. We HAVE the measurements. The eye is the place to put them, and
// then the model can see MORE than a person can, not less.
//
// So: a diagnostic layer that paints what is true onto what is visible. Not a new
// measurement — every number here already exists — a new way of showing it.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const THREE = await import(path.join(ROOT, "viewer", "node_modules", "three", "build", "three.module.js"));
const diag = await import(path.join(ROOT, "viewer", "src", "diagnostic.js"));

// a 20x20 m patch: flat in the west, a 25% face in the east, unscanned past x=8
const grid = {
  cell_m: 1, x0: -10, x1: 10, y0: -10, y1: 10,
  rows: Array.from({ length: 21 }, () =>
    Array.from({ length: 21 }, (_, c) => {
      const x = -10 + c;
      if (x > 8) return null;                 // beyond the scan
      return x < 0 ? 0 : -0.25 * x;           // flat, then a 25% fall
    })),
};

test("the fixture is what the tests below assume", () => {
  assert.equal(diag.gradeAt(grid, -5, 0), 0, "west should be flat");
  assert.ok(Math.abs(diag.gradeAt(grid, 4, 0) - 0.25) < 0.03, "east should be ~25%");
  assert.equal(diag.gradeAt(grid, 9, 0), null, "past x=8 is unscanned");
});

test("grade is banded the way the validator judges it", () => {
  // the same three thresholds validate() uses, so what the model SEES and what it
  // is JUDGED on cannot drift apart
  assert.equal(diag.band(0.03), "walkable");
  assert.equal(diag.band(0.12), "steep");
  assert.equal(diag.band(0.25), "needs_steps");
});

test("the scan boundary is drawable — where the data ends is a visible line", () => {
  const edge = diag.coverageEdge(grid);
  assert.ok(edge.length > 5, `only ${edge.length} boundary points; the edge is not traced`);
  for (const [x] of edge)
    assert.ok(x > 6 && x < 10, `boundary point at x=${x} is nowhere near the real edge (x=8)`);
});

test("a slope layer colours the ground by what it can carry", () => {
  const m = diag.slopeLayer(grid, { cell: 1 });
  const col = m.geometry.attributes.color;
  assert.ok(col, "no vertex colours — nothing is communicated");
  assert.ok(col.count > 100, `only ${col.count} coloured vertices`);
  // the flat half and the steep half must not be the same colour, or the layer
  // is decoration rather than information
  const pos = m.geometry.attributes.position;
  let west = null, east = null;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    if (x < -4 && !west) west = [col.getX(i), col.getY(i), col.getZ(i)];
    if (x > 3 && x < 7 && !east) east = [col.getX(i), col.getY(i), col.getZ(i)];
  }
  assert.ok(west && east, "could not sample both halves");
  const dist = Math.hypot(west[0] - east[0], west[1] - east[1], west[2] - east[2]);
  assert.ok(dist > 0.25, `flat and 25% differ by only ${dist.toFixed(2)} in colour`);
});

test("unscanned ground is not coloured as if it were measured", () => {
  const m = diag.slopeLayer(grid, { cell: 1 });
  const pos = m.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++)
    assert.ok(pos.getX(i) <= 8.5,
      `the slope layer paints x=${pos.getX(i)}, past the scan — inventing ground is ` +
      `the exact failure this project keeps meeting`);
});
