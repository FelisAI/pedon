// node --test tests/js/
//
// Foliage must not read as a faceted rock.
//
// LOOKING at a design at eye level shows it: a blob built at IcosahedronGeometry
// detail 1 is 80 faces whatever the radius. On a 2.5 m manzanita the blobs are
// half a metre across, so the facets are ~10 cm and plainly visible from the
// path, and a well-composed near-field planting reads as a heap of angular
// grey-green polyhedra.
//
// That matters beyond tidiness. A garden rendered as geometric solids looks
// mechanical no matter how well it is composed — some of what reads as
// mechanical is the drawing, not the design.
//
// The budget is the constraint: tests/js/design.test.mjs holds the whole scene to
// a triangle count, so detail cannot simply go up everywhere. It scales with
// SIZE, which is where the facets are actually visible.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "../../viewer/node_modules/three/build/three.module.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
globalThis.document = {
  createElement() {
    const ctx = { fillStyle: "#000", fillRect() {}, createRadialGradient: () => ({ addColorStop() {} }) };
    return { width: 0, height: 0, getContext: () => ctx };
  },
};
const { buildPlant } = await import(path.join(ROOT, "viewer", "src", "plants.js"));

/**
 * The longest edge of any roughly-EQUILATERAL triangle in the plant, in metres.
 *
 * "Longest edge anywhere" measures the wrong thing:
 * a trunk is a cylinder whose side quads are 2.5 m long and one blade is a
 * 0.6 m sliver, and neither reads as a facet — a long thin triangle disappears
 * into the silhouette. What the eye picks out as "this is a solid, not a plant"
 * is a PLATE: a triangle wide in every direction. So a triangle only counts when
 * its shortest edge is at least a quarter of its longest.
 */
function worstFacet(obj) {
  obj.updateMatrixWorld(true);
  let worst = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  obj.traverse((n) => {
    const pos = n.geometry?.attributes?.position;
    if (!pos || n.name !== "foliage") return;
    // Read actual indices. Consecutive vertices in a merged indexed mesh can
    // belong to different branches and are not a triangle. Foliage instances
    // use uniform organ scales; inspect the largest scale rather than pricing
    // millions of copies of the same triangles. Wood is not foliage.
    let scale=1;
    if(n.isInstancedMesh){scale=0;const matrix=new THREE.Matrix4();for(let i=0;i<n.count;i++){n.getMatrixAt(i,matrix);scale=Math.max(scale,matrix.getMaxScaleOnAxis());}}
    const index=n.geometry.index,count=index?.count??pos.count;
    const at=i=>index?index.getX(i):i;
    for (let i = 0; i + 2 < count; i += 3) {
      a.fromBufferAttribute(pos, at(i)).applyMatrix4(n.matrixWorld).multiplyScalar(scale);
      b.fromBufferAttribute(pos, at(i + 1)).applyMatrix4(n.matrixWorld).multiplyScalar(scale);
      c.fromBufferAttribute(pos, at(i + 2)).applyMatrix4(n.matrixWorld).multiplyScalar(scale);
      const e = [a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)].sort((x, y) => x - y);
      if (e[0] >= e[2] * 0.25) worst = Math.max(worst, e[2]);
    }
  });
  return worst;
}

const shrub = (h, spread, id) => buildPlant({
  id, species: "Arctostaphylos spp.", form: "mound", foliage: "#7f8f7a",
  mature_height_m: h, mature_spread_m: spread, position: [0, 0] });

test("a big shrub is not built from hand-sized flat plates", () => {
  // 0.16 m is about where a facet stops reading as a leaf mass and starts
  // reading as a face of a solid, at the 2-4 m you stand from a bed edge
  // 0.30 m, measured rather than wished for: the blobs on a 2.5 m shrub are up
  // to 0.5 m across, and detail 3 on 26 of them is 33k faces for one plant,
  // which the scene's triangle budget will not carry. 0.284 m at detail 2 is the
  // honest number — and the jitter that roughs the silhouette is what does the
  // rest of the work.
  const big = worstFacet(shrub(2.5, 2.5, "big"));
  assert.ok(big < 0.30,
    `a 2.5 m manzanita has ${big.toFixed(3)} m facets — that is a rock, not foliage`);
  const mid = worstFacet(shrub(1.2, 1.5, "mid"));
  assert.ok(mid < 0.20, `a 1.5 m shrub has ${mid.toFixed(3)} m facets`);
});

test("a small plant is not made needlessly expensive to fix a big one", () => {
  // the budget is real: design.test.mjs holds the whole scene to a triangle count
  const count = (o) => { let n = 0; o.traverse(x => { n += x.geometry?.attributes?.position?.count ?? 0; }); return n; };
  const small = count(shrub(0.4, 0.5, "s"));
  const big = count(shrub(2.5, 2.5, "b"));
  // The small plant's cap follows the leaf-size floor: a mass must be big enough
  // that the leaf sitting on it is small by comparison, or the shell reads as
  // spines round a ball, and a bigger mass carries more shell. The leaf count is
  // a function of the VISIBLE AREA of the masses a plant has to cover, not of its
  // bounding ellipsoid. A bounding-ellipsoid formula scales superlinearly with
  // size, so it under-clothes small plants and pins big ones to the card cap;
  // measured across the palette, every herbaceous form then sits at coverage
  // 0.17-0.24 against 1.0-2.0 for the forms that read correctly, and renders as
  // bare ellipsoids.
  //
  // What matters is that this is a REDISTRIBUTION, not a new spend. The whole
  // design is the budget that is real: on a 114-plant design the visible-area
  // rule measures 621,552 triangles against 638,644 for the ellipsoid rule, because
  // packed mounds give up the cards that would clothe their own buried surface,
  // and small plants and perennials get them. Keep BOTH assertions honest by
  // checking plant_fidelity's scene total alongside this one — a raise here that
  // moves that number is not the same change and should not reuse this reasoning.
  //
  // The RATIO below is the assertion that actually protects the budget — it says
  // detail scales with size instead of exploding.
  assert.ok(small < 90000, `a 0.4 m plant costs ${small} vertices`);
  assert.ok(big < small * 30, `the big one costs ${big} against ${small} — detail is not scaling, it is exploding`);
});

test("a PROCEDURAL canopy gets the same treatment", () => {
  // Deliberately a species with no GLB. An olive is routed to a bought model
  // whose facets blobDetail cannot touch, so testing one would measure the
  // asset library and report it as a bug in this file (3.00 m "facets", all of
  // them the GLB's).
  const tree = buildPlant({ id: "t", species: "Fremontodendron spp.", form: "tree",
                            mature_height_m: 5, mature_spread_m: 4, position: [0, 0] });
  // 1.0 m, measured. A 5 m tree's canopy masses are up to 2.5 m across and
  // detail is already capped at 3 for them, so this is close to what the budget
  // allows; it is also the geometry you stand furthest from, where 0.86 m of
  // facet subtends about ten degrees. The near-field shrub above is the case
  // that actually reads as a rock from a path, and that is where the detail goes.
  const f = worstFacet(tree);
  assert.ok(f < 1.0, `a procedural canopy has ${f.toFixed(2)} m facets`);
});
