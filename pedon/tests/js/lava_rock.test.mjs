// node --test tests/js/lava_rock.test.mjs
//
// A lava rock is VESICULAR, and that is not a colour.
//
// Large lava rocks (over 10 inches) hold soil on a slope. The obvious build is
// the existing boulder painted black, and that is the category error
// ASSET_FIDELITY.md rule 6 names: the one feature that makes the thing
// recognisable has to be in the GEOMETRY. Scoria froze with gas in it, so it is
// riddled with bubble cavities, and at arm's length that pitting is the whole
// difference between lava and any other dark rock.
//
// A build can FAIL this while passing every number. Triangle count fine,
// declared height fine — and it renders as a smooth brown pyramid when the
// vesicles are ~1.5 cm across while the mesh has ~3 cm between vertices, so
// nearly every bubble lands between vertices and moves nothing. Only rendering
// one close shows it. These tests measure the pitting itself.
import test from "node:test";
import assert from "node:assert/strict";

globalThis.document = { createElement(){ const ctx={fillStyle:"#000",fillRect(){}};
  return {width:0,height:0,getContext:()=>ctx}; } };
const { objectMesh, KNOWN_KINDS, OBJECT_META } = await import("../../viewer/src/objects.js");

function radii(kind, h, w) {
  const g = objectMesh({ kind, height_m: h, width_m: w, position: [0, 0] });
  const out = [];
  g.traverse(o => {
    if (!o.isMesh) return;
    const p = o.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) out.push(Math.hypot(p.getX(i), p.getY(i), p.getZ(i)));
  });
  return out;
}

test("the library knows it, so wants.py and the asset window can see it", () => {
  assert.ok(KNOWN_KINDS.includes("lava_rock"));
  assert.ok(OBJECT_META.lava_rock, "no OBJECT_META row, so a hand-placed one gets a default stub size");
  assert.ok(OBJECT_META.lava_rock.height_m * 39.37 > 10,
    "a lava rock here is over 10 inches; the default must not be gravel");
});

test("the surface is PITTED, not smooth", () => {
  // a vesicular rock has a wide spread of vertex radii: the pits sit well inside
  // the mean surface. A smooth stone's radii cluster.
  const r = radii("lava_rock", 0.32, 0.42);
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const inside = r.filter(x => x < mean * 0.80).length / r.length;
  assert.ok(inside > 0.04,
    `only ${(inside * 100).toFixed(1)}% of the surface sits deep inside the mean radius — `
    + "this is the smooth-brown-pyramid failure, where the bubbles are finer than "
    + "the mesh can resolve and so do not exist");
});

test("the pitting is MANY DISTINCT CAVITIES, not one rough surface", () => {
  // The obvious test -- "rougher than a boulder" -- is unsound and is
  // not used: the boulder's fracture planes give as much radius SPREAD as vesicles
  // do (cv 0.181 vs 0.174), and its mesh has 1,500 vertices to this one's 61,440,
  // so any neighbour-based comparison measures the tessellation rather than the
  // rock. Counting FEATURES survives that. A 0.42 m scoria has hundreds of visible
  // cavities; a faceted stone has a handful of broad flats.
  const g = objectMesh({ kind: "lava_rock", height_m: 0.32, width_m: 0.42, position: [0, 0] });
  const v = [];
  g.traverse(o => {
    if (!o.isMesh) return;
    const p = o.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const r = Math.hypot(x, y, z) || 1e-9;
      v.push([x / r, y / r, z / r, r]);
    }
  });
  const mean = v.reduce((a, b) => a + b[3], 0) / v.length;
  const deep = v.filter(q => q[3] < mean * 0.78);
  const clusters = [];
  for (const q of deep) {
    if (!clusters.some(c => q[0] * c[0] + q[1] * c[1] + q[2] * c[2] > Math.cos(0.10)))
      clusters.push(q);
  }
  // The threshold is set from a measurement, not a guess: built with the vesicle
  // displacement switched OFF this same rock yields 138 cavities from its fracture
  // facets alone, and 200 with them. Anything under ~170 means the bubbles have
  // stopped biting deeper than the cuts and are decorating a shape the planes
  // already made.
  assert.ok(clusters.length > 170,
    `only ${clusters.length} distinct cavities — at 138 the vesicles are contributing `
    + "nothing over the fracture planes, which is the smooth-rock failure again");
});

test("it draws the size it declares, above ground", () => {
  // objects.test.mjs's rule: a set stone is bedded, so the declared height is the
  // part that SHOWS
  const g = objectMesh({ kind: "lava_rock", height_m: 0.42, width_m: 0.55, position: [0, 0] });
  let lo = Infinity, hi = -Infinity;
  g.traverse(o => {
    if (!o.isMesh) return;
    const p = o.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i) + o.position.y;
      if (y < lo) lo = y; if (y > hi) hi = y;
    }
  });
  const above = hi - Math.max(lo, 0);
  assert.ok(Math.abs(above - 0.42) < 0.03, `draws ${above.toFixed(3)} m above ground for a declared 0.42`);
});
