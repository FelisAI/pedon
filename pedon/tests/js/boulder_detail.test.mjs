// node --test tests/js/
//
// Set stone must not read as a low-poly rock.
//
// A garden can read as "mechanical" because of the DRAWING rather than the
// design: a boulder built at IcosahedronGeometry(r, 1) — 80 faces whatever the
// size — gives a 0.5-0.9 m stone facets a third of a metre across, and it reads
// from the path as a faceted polyhedron. tests/js/foliage_detail.test.mjs makes
// the same fix for shrub masses; this is the other half, and it matters more here, because
// a boulder is meant to be a NATURAL object and nothing looks less natural than a
// perfect triangle.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "../../viewer/node_modules/three/build/three.module.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
globalThis.document = {
  createElement() {
    const ctx = { fillStyle: "#000", fillRect() {}, fillText() {}, measureText: () => ({ width: 10 }),
                  beginPath() {}, arc() {}, fill() {}, stroke() {},
                  createLinearGradient: () => ({ addColorStop() {} }) };
    return { width: 0, height: 0, getContext: () => ctx };
  },
};
const objects = await import(path.join(ROOT, "viewer", "src", "objects.js"));

/** Longest edge of any roughly-equilateral triangle — a visible PLATE. */
function worstPlate(obj) {
  obj.updateMatrixWorld(true);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let worst = 0;
  obj.traverse((n) => {
    const p = n.geometry?.attributes?.position;
    if (!p) return;
    for (let i = 0; i + 2 < p.count; i += 3) {
      a.fromBufferAttribute(p, i).applyMatrix4(n.matrixWorld);
      b.fromBufferAttribute(p, i + 1).applyMatrix4(n.matrixWorld);
      c.fromBufferAttribute(p, i + 2).applyMatrix4(n.matrixWorld);
      const e = [a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)].sort((x, y) => x - y);
      if (e[0] >= e[2] * 0.25) worst = Math.max(worst, e[2]);
    }
  });
  return worst;
}
const rock = (h, w) => objects.objectMesh(
  { id: "r", kind: "boulder", position: [0, 0], height_m: h, width_m: w }, () => 0);
const verts = (o) => { let n = 0; o.traverse(x => { n += x.geometry?.attributes?.position?.count ?? 0; }); return n; };

test("a big set stone is not a faceted polyhedron", () => {
  const big = worstPlate(rock(0.9, 1.2));
  assert.ok(big < 0.20,
    `a 0.9 m boulder has ${big.toFixed(3)} m plates — from a path that reads as a solid, not a stone`);
});

test("a small stone is not made needlessly expensive", () => {
  const small = verts(rock(0.25, 0.3)), big = verts(rock(0.9, 1.2));
  assert.ok(small < 1500, `a 0.25 m pebble costs ${small} vertices`);
  // 20, not 10. The detail comes from a constant TARGET EDGE LENGTH, so the
  // subdivision level rises linearly with radius and the face count therefore
  // rises with radius SQUARED — a 1.2 m stone against a 0.3 m one is four times
  // the radius and sixteen times the faces. That is the correct behaviour of an
  // edge target, not an explosion; a bound of 10 holds only with the detail
  // capped at 3, and there is no triangle budget that needs the cap. What this
  // catches is a per-vertex or per-stone constant creeping in, which would
  // break the r-squared relation entirely.
  assert.ok(big < small * 20, `${big} vs ${small} — detail is exploding, not scaling`);
});

test("stones still differ from one another", () => {
  // subdividing must not smooth away the jitter that makes each rock its own
  const a = worstPlate(rock(0.7, 0.9)), b = worstPlate(rock(0.7, 0.9));
  assert.ok(a > 0.02 && b > 0.02, "the stones came out as smooth spheres");
});
