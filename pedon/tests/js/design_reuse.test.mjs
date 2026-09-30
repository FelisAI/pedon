// node --test tests/js/design_reuse.test.mjs
//
// A HAND EDIT REBUILDS WHAT CHANGED, NOT THE GARDEN.
//
// A move has to drop into place at once, or designing by hand is unusable. The
// op round trip measures 0.6 s; regenerating every part of a 205-plant design
// after every edit takes several seconds more — 17 lava rocks alone are ~7 s of
// it. So buildDesignGroup keeps a part whose item and drape are unchanged. These
// tests hold both halves: a kept part is the SAME object, and nothing that should
// be rebuilt is kept.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// buildPlant needs a 2D canvas for its contact shadow and nothing else; a leaf
// texture it cannot paint here falls back and says so, which is not under test
const ctx = { createRadialGradient: () => ({ addColorStop() {} }), fillRect() {}, set fillStyle(_) {} };
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
const quiet = console.warn;
console.warn = () => {};

const { buildDesignGroup, reusableParts } = await import(path.join(ROOT, "viewer", "src", "design.js"));

const doc = () => ({
  beds: [{ id: "b1", polygon: [[0, 0], [3, 0], [3.5, 2], [1, 3], [-0.5, 1.5]], mulch: "bark" }],
  objects: [{ id: "rock1", kind: "lava_rock", position: [1, 1], height_m: 0.3, width_m: 0.4 },
            { id: "rock2", kind: "boulder", position: [2, 1], height_m: 0.5 }],
  plants: [{ id: "p1", species: "Thymus vulgaris", common: "Thyme", form: "mat",
             position: [0.5, 0.5], mature_height_m: 0.3, mature_spread_m: 0.6 },
           { id: "p2", species: "Salvia clevelandii", common: "Cleveland sage", form: "mound",
             position: [2, 2], mature_height_m: 1.2, mature_spread_m: 1.5 }],
});
const flat = () => 0;
const byId = g => {
  const m = new Map();
  g.traverse(o => { if (o.userData?.id !== undefined && !m.has(o.userData.id)) m.set(o.userData.id, o); });
  return m;
};
const OPTS = { quality: "fast", reuseSalt: "fast|0" };
// identity only: a failing assert.equal on two Object3Ds renders both graphs and
// runs node out of memory before it prints a word
const same = (a, b, msg) => assert.ok(a === b, msg);
const differ = (a, b, msg) => assert.ok(a !== b, msg);

test("moving one plant keeps every other part and rebuilds only that plant", async () => {
  const before = await buildDesignGroup(doc(), flat, 1, OPTS);
  const old = byId(before);
  const moved = doc();
  moved.plants[0].position = [0.9, 0.4];
  const after = byId(await buildDesignGroup(moved, flat, 1, { ...OPTS, reuse: reusableParts(before) }));
  for (const id of ["b1", "rock1", "rock2", "p2"])
    same(after.get(id), old.get(id), `${id} did not change and was rebuilt anyway`);
  differ(after.get("p1"), old.get("p1"), "the moved plant kept its old mesh");
});

test("a kept plant still stands where the design says", async () => {
  const before = await buildDesignGroup(doc(), flat, 1, OPTS);
  const was = byId(before).get("p2");        // read now: a kept part leaves `before`
  was.position.set(9, 9, 9);                 // wherever the last frame left it
  const after = byId(await buildDesignGroup(doc(), flat, 1, { ...OPTS, reuse: reusableParts(before) }));
  const p2 = after.get("p2");
  same(p2, was, "an unchanged plant was rebuilt");
  assert.ok(Math.abs(p2.position.x - 2) < 1e-9, `kept plant drawn at x=${p2.position.x}, design says 2`);
});

test("a refused drag snaps back: a kept part returns to its built pose", async () => {
  // a drag PREVIEWS by moving the mesh; a refused op leaves the file unchanged,
  // so the part is kept — and must not keep the preview's position
  const before = await buildDesignGroup(doc(), flat, 1, OPTS);
  const rock = byId(before).get("rock1");
  const built = rock.position.clone();
  rock.position.x += 3;
  const after = byId(await buildDesignGroup(doc(), flat, 1, { ...OPTS, reuse: reusableParts(before) }));
  same(after.get("rock1"), rock, "an unchanged rock was rebuilt");
  assert.ok(rock.position.distanceTo(built) < 1e-9, "the refused move stayed on screen");
});

test("a re-drape rebuilds what lies ON the ground and keeps the plants, which only stand on it", async () => {
  // Every page load re-drapes once, when the terrain arrives after the first
  // build — and rebuilding every plant then would rebuild them identically, for
  // nothing. A plant's mesh never reads the ground; its position does, and is set
  // either way.
  const before = await buildDesignGroup(doc(), flat, 1, OPTS);
  const old = byId(before);
  const hill = (x, z) => 0.5 + 0.1 * x;
  const redraped = byId(await buildDesignGroup(doc(), hill, 1,
    { ...OPTS, reuseSalt: "fast|1", reuse: reusableParts(before) }));
  differ(redraped.get("b1"), old.get("b1"), "the bed is draped ON the ground and must be rebuilt for a new one");
  for (const id of ["p1", "p2", "rock1", "rock2"])
    same(redraped.get(id), old.get(id), `${id} was rebuilt for a change of ground it never reads`);
  // rebuilt, 17 lava rocks are ~8 s of every re-drape: an object reads the ground for
  // its HEIGHT and nothing else, so a kept one is re-seated
  const rock = redraped.get("rock1");
  assert.ok(Math.abs(rock.position.y - hill(rock.position.x, rock.position.z)) < 1e-9,
    `rock1 is at y=${rock.position.y}, the new ground there is ${hill(rock.position.x, rock.position.z)}`);
  // kept, and STANDING ON THE NEW GROUND — a kept plant left at its old height floats
  const p2 = redraped.get("p2");
  assert.ok(Math.abs(p2.position.y - hill(p2.position.x, p2.position.z)) < 1e-9,
    `p2 is at y=${p2.position.y}, the new ground there is ${hill(p2.position.x, p2.position.z)}`);
});

test("an object set to a LEVEL stays on it through a re-drape", async () => {
  const d = doc(); d.objects[0].level_m = 1.25;
  const before = await buildDesignGroup(d, flat, 1, OPTS);
  const old = byId(before);            // read NOW: a kept part leaves `before` for the new group
  const after = byId(await buildDesignGroup(d, () => 9, 1,
    { ...OPTS, reuseSalt: "fast|1", reuse: reusableParts(before) }));
  same(after.get("rock1"), old.get("rock1"), "rock1 rebuilt");
  assert.equal(after.get("rock1").position.y, 1.25, "a plinth height was overwritten by the ground");
  assert.equal(after.get("rock2").position.y, 9);
});

test("a change of QUALITY rebuilds the plants too", async () => {
  const before = await buildDesignGroup(doc(), flat, 1, OPTS);
  const old = byId(before);
  const detailed = byId(await buildDesignGroup(doc(), flat, 1,
    { quality: "detailed", reuseSalt: "detailed|0", reuse: reusableParts(before) }));
  for (const id of ["p1", "p2"]) differ(detailed.get(id), old.get(id), `${id} kept across a change of quality`);
  // an object has ONE quality — "a scanned object has no simplified version" — so
  // switching plant detail must not regenerate the rocks
  for (const id of ["rock1", "rock2"]) same(detailed.get(id), old.get(id), `${id} rebuilt for a plant-detail change`);
});

test("a changed item is rebuilt, whatever field changed", async () => {
  const before = await buildDesignGroup(doc(), flat, 1, OPTS);
  const old = byId(before);
  const d = doc();
  d.beds[0].mulch = "gravel";
  d.objects[1].height_m = 0.9;
  const after = byId(await buildDesignGroup(d, flat, 1, { ...OPTS, reuse: reusableParts(before) }));
  differ(after.get("b1"), old.get("b1"), "a bed with new mulch kept its old mesh");
  differ(after.get("rock2"), old.get("rock2"), "a resized boulder kept its old mesh");
  same(after.get("rock1"), old.get("rock1"), "an unchanged rock was rebuilt");
});

test("without reuse, every build is fresh (overlays and reviews rely on this)", async () => {
  const a = byId(await buildDesignGroup(doc(), flat, 1, OPTS));
  const b = byId(await buildDesignGroup(doc(), flat, 1, OPTS));
  for (const [id, o] of a) differ(b.get(id), o, `${id} shared between two independent builds`);
});
