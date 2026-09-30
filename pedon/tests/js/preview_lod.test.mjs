// node --test tests/js/
//
// Fast preview builds the SAME plant, cheaper.
//
// A separate preview builder gives rosemary and coast rosemary a different
// silhouette and size in the mode the owner actually works in; Fast must be a
// sampled-down version of full detail, the same size, so the site looks the same
// in both modes.
//
// A reduced level of detail fails by looking leafless, and the eye sees that
// before a formula does. So the assertions here are on MEASURED GEOMETRY: the
// built triangles' own area, not an arithmetic model of what the constants ought
// to produce. Such a model can say 90% while the mesh holds 7%.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../viewer/node_modules/three/build/three.module.js";
import { needsLibrary } from "./lib/library.mjs";   // about the user's library: skips without one

globalThis.document = { createElement() { return { width: 0, height: 0,
  getContext: () => new Proxy({ measureText: () => ({ width: 12 }),
    createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }) },
    { get: (o, k) => o[k] ?? (() => {}) }) }; } };

const { buildPlant } = await import("../../viewer/src/plants.js");
const { shootLeaf } = await import("../../viewer/src/shoots.js");
const { footprint } = await import("../../viewer/src/preview_lod.js");

const PLANT = { id: "w1", species: "Westringia fruticosa", common: "Coast Rosemary",
  position: [15, -5], mature_height_m: 1.8, mature_spread_m: 1.8,
  form: "mound", foliage: "#6a7d5e", flower: "#f6f4ef" };

/** Surface area of a geometry's triangles, in m². */
function unitArea(g) {
  const pos = g.attributes.position, idx = g.index;
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  let a = 0;
  const n = idx ? idx.count : pos.count;
  for (let i = 0; i < n; i += 3) {
    const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1,
          i2 = idx ? idx.getX(i + 2) : i + 2;
    A.fromBufferAttribute(pos, i0); B.fromBufferAttribute(pos, i1); C.fromBufferAttribute(pos, i2);
    a += B.clone().sub(A).cross(C.clone().sub(A)).length() / 2;
  }
  return a;
}

function built(quality) {
  const g = buildPlant(PLANT, { quality });
  let leafArea = 0, triangles = 0;
  const box = new THREE.Box3();
  g.traverse(o => {
    if (!o.isMesh || o.name === "shadow") return;
    const n = o.isInstancedMesh ? o.count : 1;
    triangles += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3 * n;
    // WHAT A LEAF COVERS, not its surface: a rolled needle's surface is ~1.7x the area it covers,
    // and cards draw coverage — measured by surface, a card canopy as dense as full detail's
    // read 59%. Each full leaf: its footprint along its thin axis, at its drawn size.
    if (/foliage/i.test(o.name) && o.isInstancedMesh) {
      o.geometry.computeBoundingBox();
      const sz = o.geometry.boundingBox.getSize(new THREE.Vector3());
      const axes = [0, 1, 2].sort((p, q) => sz.getComponent(p) - sz.getComponent(q));
      const f = footprint(o.geometry, axes), m = new THREE.Matrix4(), sc = new THREE.Vector3();
      for (let i = 0; i < n; i++) { o.getMatrixAt(i, m); sc.setFromMatrixScale(m); leafArea += f * sc.getComponent(axes[1]) * sc.getComponent(axes[2]); }
    } else if (/foliage/i.test(o.name)) leafArea += unitArea(o.geometry) * n;
    // leaf-CLUSTER cards: the leaf area they draw — each quad's area times its picture's
    // density (the shoot plants draw reduceBuilt's cards, preview_lod.js)
    if (o.name === "leaf cards") leafArea += o.userData.leafArea;
    o.geometry.computeBoundingBox();
    if (o.isInstancedMesh) {
      const m = new THREE.Matrix4();
      for (let i = 0; i < n; i++) { o.getMatrixAt(i, m); box.union(o.geometry.boundingBox.clone().applyMatrix4(m)); }
    } else box.union(o.geometry.boundingBox.clone());
  });
  return { leafArea, triangles, size: box.getSize(new THREE.Vector3()), shootModel: !!g.userData.shootModel };
}

test("the preview is the same builder, not a stand-in", needsLibrary, () => {
  assert.equal(built("fast").shootModel, true,
    "Fast preview is back on the generic form builder — a different plant");
  assert.equal(built("detailed").shootModel, true);
});

test("and therefore the same SIZE, which is what the user sees", needsLibrary, () => {
  const f = built("fast"), d = built("detailed");
  for (const axis of ["x", "y", "z"]) {
    const off = Math.abs(f.size[axis] - d.size[axis]) / d.size[axis];
    assert.ok(off < 0.05,
      `${axis} differs by ${(off * 100).toFixed(0)}% between fast and full (${f.size[axis].toFixed(2)} vs ${d.size[axis].toFixed(2)})`);
  }
});

test("the canopy still HOLDS — measured leaf area, not a formula", () => {
  // 7% of full is a bare plant; an arithmetic model can claim 90% for the same
  // mesh, which is why this asserts on the mesh.
  const ratio = built("fast").leafArea / built("detailed").leafArea;
  assert.ok(ratio > 0.7, `the preview canopy holds only ${(ratio * 100).toFixed(0)}% of full's leaf area — it will read bare`);
  assert.ok(ratio < 1.6, `the preview canopy is ${(ratio * 100).toFixed(0)}% of full — it is not a preview any more`);
});

test("a preview leaf is never degenerate", () => {
  // rows:1 samples the needle outline at t=0 and t=1, where it is ZERO at both
  // ends, so every leaf would be a sliver with no width. This checks that directly.
  const profile = { leaf: "rosemary", length: .020, width: .0036 };
  const preview = shootLeaf(profile, 0, { preview: true });
  const garden = shootLeaf(profile, 0, {});
  const pa = unitArea(preview), ga = unitArea(garden);
  assert.ok(pa > ga * 0.35,
    `a preview needle has ${(pa * 1e6).toFixed(0)} mm² against the garden leaf's ${(ga * 1e6).toFixed(0)} mm² — it is a degenerate sliver`);
});

test("and it is still much cheaper, which is the entire point", () => {
  const f = built("fast"), d = built("detailed");
  assert.ok(f.triangles < d.triangles * 0.12,
    `preview costs ${(f.triangles / d.triangles * 100).toFixed(0)}% of full — not a preview`);
});
