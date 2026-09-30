// node --test tests/js/carve.test.mjs
//
// A LEVEL SURFACE IS CUT INTO THE SCAN.
//
// A terrace built flat at level_m is below the photographed ground on its uphill
// side. Drawing the terrace without touching the scan leaves the scan covering the
// cut: a 10.6 m2 terrace renders as a 5 m2 oval in raw ground, and a plant in a
// terraced bed stands on the original slope. The GPU half (a fragment discard)
// cannot run in node; these tests hold what
// it is FED — the rings, the levels, the frame, the patched shader — and the
// geometry half: the cut face and the ground things stand on.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ctx = { createRadialGradient: () => ({ addColorStop() {} }), fillRect() {}, set fillStyle(_) {} };
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
console.warn = () => {};

const THREE = await import(path.join(ROOT, "viewer", "node_modules", "three", "build", "three.module.js"));
const carve = await import(path.join(ROOT, "viewer", "src", "carve.js"));
const design = await import(path.join(ROOT, "viewer", "src", "design.js"));
const lighting = await import(path.join(ROOT, "viewer", "src", "lighting.js"));

const SQUARE = [[0, 0], [4, 0], [4, 3], [0, 3]];
const slope = (x) => 0.1 * x;                       // ground rises 0.1 m per metre east

test("the rings are the SAME outlines the surfaces are drawn from, in the design frame", () => {
  const d = { patios: [{ id: "t", polygon: SQUARE, level_m: 0.2 }],
              beds: [{ id: "b", polygon: [[5, 0], [8, 0], [8, 3], [5, 3]], level_m: 0.3 },
                     { id: "draped", polygon: [[9, 0], [10, 0], [10, 1]] }],
              paths: [{ id: "w", spline: [[0, 5], [6, 5]], width_m: 1, level_m: 0.1 }] };
  const f = design.levelFootprints(d);
  assert.deepEqual(f.map(s => [s.id, s.level]), [["b", 0.3], ["t", 0.2], ["w", 0.1]],
                   "only surfaces with level_m are cut, each at its own level");
  const t = f.find(s => s.id === "t");
  // world z is -ENU y: a point 1 m NORTH of the terrace's middle is outside, its middle inside
  assert.ok(carve.insideRing([2, -1.5], t.ring), "the terrace's middle is not inside its own ring");
  assert.ok(!carve.insideRing([2, 1.5], t.ring), "the ring is mirrored: ENU y was not turned into world -z");
  // the patio is eased ONCE (a built edge), so its ring stays inside the drawn polygon
  assert.ok(t.ring.every(([x, z]) => x >= 0 && x <= 4 && -z >= 0 && -z <= 3));
  const w = f.find(s => s.id === "w");
  assert.ok(carve.insideRing([3, -5.4], w.ring) && !carve.insideRing([3, -5.6], w.ring),
            "a level path's ring is its ribbon, half its width either side");
});

test("the table the shader reads holds every ring and its level, and never overflows", () => {
  const n = carve.setCarveSurfaces([{ ring: [[0, 0], [1, 0], [1, 1]], level: -1.9 },
                                    { ring: [[5, 5], [6, 5], [6, 6], [5, 6]], level: 0.4 }]);
  assert.equal(n, 2);
  assert.equal(carve.carveUniforms.uCarveCount.value, 2);
  const s = carve.carveUniforms.uCarveSurf.value;
  assert.deepEqual([s[0].x, s[0].y, s[0].z], [0, 3, -1.9]);
  assert.deepEqual([s[1].x, s[1].y, s[1].z], [3, 4, 0.4], "the second ring starts where the first ends");
  const px = carve.carveUniforms.uCarveTable.value.image.data;
  assert.deepEqual([px[12], px[13]], [5, 5], "texel 3 is the second ring's first point");
  const many = Array.from({ length: carve.MAX_SURFACES + 5 }, () => ({ ring: [[0, 0], [1, 0], [0, 1]], level: 0 }));
  assert.equal(carve.setCarveSurfaces(many), carve.MAX_SURFACES);
  assert.equal(carve.setCarveSurfaces([]), 0);
  assert.equal(carve.carveUniforms.uCarveCount.value, 0, "a design with no level surfaces cuts nothing");
});

test("the frame follows the design group, so a yaw set by north turns the cut with it", () => {
  const g = new THREE.Group();
  g.rotation.y = 0.4;
  g.position.set(3, 0, -2);
  g.updateMatrixWorld(true);
  carve.setCarveFrame(g.matrixWorld);
  const p = new THREE.Vector3(1, 0.5, -1).applyMatrix4(g.matrixWorld);       // design-frame (1, .5, -1)
  const back = p.applyMatrix4(carve.carveUniforms.uCarveToDesign.value);
  assert.ok(Math.abs(back.x - 1) < 1e-9 && Math.abs(back.z + 1) < 1e-9, "world -> design is not the inverse");
});

test("the capture's shader discards inside a ring above its level — and only once", () => {
  for (const [Mat, lib] of [[THREE.MeshBasicMaterial, "basic"], [THREE.ShadowMaterial, "shadow"]]) {
    const m = new Mat();
    carve.applyCarve(m);
    carve.applyCarve(m);                                                 // idempotent
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib[lib].vertexShader,
                     fragmentShader: THREE.ShaderLib[lib].fragmentShader };
    m.onBeforeCompile(shader, null);
    assert.match(shader.vertexShader, /vCarveWorld = \(modelMatrix \* vec4\(transformed, 1\.0\)\)\.xyz;/);
    assert.match(shader.fragmentShader, /void main\(\) \{\n  if \(carved\(\)\) discard;/);
    assert.equal(shader.fragmentShader.match(/bool carved\(\)/g).length, 1, "patched twice");
    assert.match(shader.fragmentShader, /d\.y > S\.z && carveInside\(d\.xz/,
                 "the test must be ABOVE the level and INSIDE the ring, in the design frame");
    assert.equal(shader.uniforms.uCarveTable, carve.carveUniforms.uCarveTable, "uniforms must be SHARED");
    assert.notEqual(m.customProgramCacheKey(), new Mat().customProgramCacheKey(),
                    "a carved program must not share a cache entry with a plain one");
  }
});

test("the lighting arms the CAPTURE with the cut, and its shadow catcher, and nothing in the design", () => {
  const scene = new THREE.Scene();
  const level = new THREE.Group();
  level.name = "level";
  const scan = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial());
  level.add(scan);
  const bed = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial());
  scene.add(level, bed);
  lighting.armSceneShadows(scene);
  assert.equal(scan.material.userData.carve, true, "the photograph is not cut");
  const catcher = scan.children.find(c => c.userData?.shadowCatcher);
  assert.equal(catcher?.material.userData.carve, true, "a shadow would hang in the air over the terrace");
  assert.notEqual(bed.material.userData.carve, true, "a design surface was cut");
});

test("the cut face runs from the level to the ground, and not along a seam inside one bench", () => {
  const ring = design.levelFootprints({ patios: [{ id: "t", polygon: SQUARE, level_m: 0.1 }] })[0].ring;
  const face = design.cutFaceMesh(ring, 0.1, slope);
  const pos = face.geometry.attributes.position;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < pos.count; i++) { lo = Math.min(lo, pos.getY(i)); hi = Math.max(hi, pos.getY(i)); }
  assert.ok(Math.abs(lo - 0) < 0.05 && Math.abs(hi - 0.4) < 0.05,
            `the face should span the fill (ground 0.0) to the cut (ground ~0.4), got ${lo}..${hi}`);
  // every vertex pair stands on the ring: one end at the level, the other at the ground there
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i), g = slope(pos.getX(i));
    assert.ok(Math.abs(y - 0.1) < 1e-6 || Math.abs(y - g) < 1e-6, `vertex at ${y} is neither level nor ground`);
  }
  // a second surface at the same level sharing the east edge: that edge is a seam
  const east = design.levelFootprints({ beds: [{ id: "e", polygon: [[4, 0], [7, 0], [7, 3], [4, 3]], level_m: 0.1 }] })[0];
  const sealed = design.cutFaceMesh(ring, 0.1, slope, [east]);
  let onSeam = 0;
  const sp = sealed.geometry.attributes.position;
  for (let i = 0; i < sp.count; i++) if (sp.getX(i) > 3.9) onSeam++;
  let before = 0;
  for (let i = 0; i < pos.count; i++) if (pos.getX(i) > 3.9) before++;
  assert.ok(before > 0 && onSeam < before / 2, `the seam still carries ${onSeam} of ${before} face vertices`);
  assert.equal(design.cutFaceMesh(ring, 0.1, () => 0.1), null, "flush ground needs no face");
});

test("what stands on the garden stands on it as built: a plant in a terraced bed, a bench on a terrace", async () => {
  const d = { beds: [{ id: "b", polygon: SQUARE, level_m: 0.3, mulch: "bark" }],
              plants: [{ id: "in", species: "Thymus vulgaris", common: "Thyme", form: "mat", position: [2, 1.5],
                         mature_height_m: 0.3, mature_spread_m: 0.6 },
                       { id: "out", species: "Thymus vulgaris", common: "Thyme", form: "mat", position: [6, 1.5],
                         mature_height_m: 0.3, mature_spread_m: 0.6 }],
              objects: [{ id: "bench", kind: "bench", position: [1, 1], height_m: 0.45 }] };
  const stand = design.designedGround(d, slope);
  assert.equal(stand(2, -1.5), 0.3);
  assert.equal(stand(6, -1.5), 0.6000000000000001);
  const g = await design.buildDesignGroup(d, slope, 1, { quality: "fast" });
  const byId = {};
  g.traverse(o => { if (o.userData?.id && !(o.userData.id in byId)) byId[o.userData.id] = o; });
  assert.equal(byId.in.position.y, 0.3, "the plant in the terraced bed stands on the ORIGINAL slope");
  assert.ok(Math.abs(byId.out.position.y - 0.6) < 1e-9, "a plant outside every level surface left the ground");
  assert.equal(byId.bench.position.y, 0.3, "the bench stands on the original slope, not the bench it is on");
  // and the bed carries its cut face
  assert.ok(byId.b.children.some(c => c.name === "cut-face"), "the terraced bed has no cut face");
});

test("a flight of steps starts on the terrace it leaves, not on the ground the terrace was cut from", async () => {
  // a pad cut in at 0.0 where the ground stands 0.15 m higher, and a flight leaving it downhill
  // to the north: its top end stands on the pad, so its top tread is at the PAD's level
  const d = { patios: [{ id: "t", polygon: SQUARE, level_m: 0.0 }],
              steps: [{ id: "s", spline: [[3.5, 1.5], [3.5, 5.5]], width_m: 1, riser_m: 0.15, going_m: 0.4 }] };
  const ground = (x, z) => 0.3 + 0.1 * z;             // falls to the north (world z = -ENU y)
  const g = await design.buildDesignGroup(d, ground, 1, { quality: "fast" });
  let flight = null;
  g.traverse(o => { if (!flight && o.userData?.id === "s" && o.geometry) flight = o; });
  assert.ok(flight, "no flight built");
  const pos = flight.geometry.attributes.position;
  let top = -Infinity;
  for (let i = 0; i < pos.count; i++) top = Math.max(top, pos.getY(i));
  // the first tread is one riser below the landing; from the TERRACE (0.00) down to the
  // ground at the foot (-0.25) at 0.15 m risers that is 2 risers, so the first tread is at
  // -0.125. From the ground the terrace was cut out of (0.15) it would be 3 risers, at 0.017.
  const bottom = ground(3.5, -5.5), n = Math.ceil((0 - bottom) / 0.15 - 1e-9);
  const want = 0 - (0 - bottom) / n;
  assert.ok(Math.abs(top - want) < 0.01,
            `the first tread is at ${top.toFixed(3)} m; leaving the terrace at 0.00 it should be ${want.toFixed(3)}`);
});

// ── the EXPORT is cut too ─────────────────────────────────────
// The shader cuts what the viewer draws; a GLB read by Blender for the photoreal look
// carries the scan's geometry, so uncut the terrace sits buried in raw ground there. The same
// cut, applied to a copy of the geometry, at a NON-ZERO yaw: world and design frames
// are identical at yaw 0, so a frame mistake would pass there unseen.
function scanSheet(n = 40, size = 4, y = 1) {
  // an n x n grid of quads over [0,size]^2 at height y, indexed like a real capture
  const pos = [], idx = [];
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) pos.push(i * size / n, y, j * size / n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const a = i * (n + 1) + j, b = a + n + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

test("the exported scan is cut where the shader cuts it, and the one on screen is not", () => {
  const yaw = THREE.MathUtils.degToRad(37);
  const toDesign = new THREE.Matrix4().makeRotationY(yaw).invert();     // the design hangs under the yaw
  const ring = [[1, 1], [3, 1], [3, 3], [1, 3]];                          // in the DESIGN frame
  const g = scanSheet(80, 8, 1);
  const meshWorld = new THREE.Matrix4().makeTranslation(-4, 0, -4);       // the scan: unrotated, in world
  const before = g.index.count;
  const cut = carve.carveGeometry(g, meshWorld, [{ ring, level: 0.5 }], toDesign);
  assert.ok(cut, "nothing was cut");
  assert.equal(g.index.count, before, "the geometry on screen was changed");
  const p = g.attributes.position, v = new THREE.Vector3();
  const centre = (index, t) => {
    const c = new THREE.Vector3();
    for (let k = 0; k < 3; k++) c.add(v.fromBufferAttribute(p, index(t + k)));
    return c.divideScalar(3).applyMatrix4(meshWorld).applyMatrix4(toDesign);
  };
  const keptKeys = new Set();
  for (let t = 0; t < cut.index.count; t += 3) {
    const c = centre(i => cut.index.getX(i), t);
    assert.ok(!carve.insideRing([c.x, c.z], ring), "a triangle inside the terrace survived");
    keptKeys.add([0, 1, 2].map(k => cut.index.getX(t + k)).join());
  }
  let dropped = 0;
  for (let t = 0; t < before; t += 3) {
    if (keptKeys.has([0, 1, 2].map(k => g.index.getX(t + k)).join())) continue;
    const c = centre(i => g.index.getX(i), t);
    assert.ok(carve.insideRing([c.x, c.z], ring), "a triangle outside the terrace was cut");
    dropped++;
  }
  // a 2 x 2 m terrace on 0.1 m quads: about 800 triangles
  assert.ok(Math.abs(dropped - 800) < 60, `cut ${dropped} triangles`);
});

test("ground BELOW the level is fill, and is kept", () => {
  const g = scanSheet(10, 4, 1);
  assert.equal(carve.carveGeometry(g, new THREE.Matrix4(), [{ ring: [[1, 1], [3, 1], [3, 3], [1, 3]], level: 2 }],
                                   new THREE.Matrix4()), null);
});

test("the export clone gets the cut geometry; the scene keeps its own", () => {
  const mat = carve.applyCarve(new THREE.MeshBasicMaterial());
  const scan = new THREE.Group();
  scan.add(new THREE.Mesh(scanSheet(), mat), new THREE.Mesh(scanSheet(), new THREE.MeshBasicMaterial()));
  scan.updateWorldMatrix(true, true);
  const clone = scan.clone(true);
  const n = carve.carveForExport(clone, scan, [{ ring: [[1, 1], [3, 1], [3, 3], [1, 3]], level: 0.5 }],
                                 new THREE.Matrix4());
  assert.equal(n, 1, "only the carved (capture) material is cut");
  assert.ok(clone.children[0].geometry.index.count < scan.children[0].geometry.index.count);
  assert.equal(clone.children[1].geometry, scan.children[1].geometry, "an uncarved mesh was touched");
});

test("the photoreal export actually calls the cut on the scan it exports", async () => {
  // the seam: a correct carveForExport that exportSceneOp never calls cuts nothing
  const fs = await import("node:fs");
  const src = fs.readFileSync(path.join(ROOT, "viewer", "src", "viewport.js"), "utf8");
  const i = src.indexOf("async function exportSceneOp");
  assert.ok(i > -1, "exportSceneOp moved — find the export and re-point this test");
  const body = src.slice(i, src.indexOf("\n}\n", i));
  assert.match(body, /if \(name === "scan"\) carved = carveForExport\(copy, node\)/,
    "the scan goes to Blender uncut");
});
