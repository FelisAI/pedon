// CUT A LEVEL SURFACE INTO THE SCAN.
//
// A terrace, a bench walk or a terraced bed carries `level_m`: it is built FLAT at
// that elevation, cut into the slope on its uphill side and filled on its downhill
// one. Drawing the flat surface without touching the scan leaves the photographed
// ground on top of it wherever the surface is in CUT: only the FILL side reads
// correctly, the cut side looks buried, and a 10.6 m2 terrace renders as a 5 m2
// oval sitting in raw ground — so every visual judgement of a sloped design would
// be made against the wrong picture.
//
// The scan is one photogrammetry mesh, so this does not cut geometry. It discards
// the scan's FRAGMENTS that fall inside a level surface's footprint and stand above
// its level — the capture material and its shadow catcher both — and design.js
// draws the cut face between the level and the ground at the edge. Raycasts are
// untouched: every height the tools measure is still the measured ground.
import * as THREE from "three";

export const MAX_SURFACES = 16;
export const MAX_VERTS = 2048;

const texels = new Float32Array(MAX_VERTS * 4);
const table = new THREE.DataTexture(texels, MAX_VERTS, 1, THREE.RGBAFormat, THREE.FloatType);
table.needsUpdate = true;

/** Shared by every carved material: one upload serves the scan and its shadow catcher. */
export const carveUniforms = {
  uCarveTable: { value: table },
  uCarveSurf: { value: Array.from({ length: MAX_SURFACES }, () => new THREE.Vector4()) },
  uCarveCount: { value: 0 },
  uCarveToDesign: { value: new THREE.Matrix4() },
};

/**
 * The level surfaces to cut, as rings in the DESIGN group's frame (x, z) with their
 * level. Returns how many were taken; a design past the table's size keeps the
 * first ones rather than failing the frame.
 */
// the same surfaces kept in JS, for what cannot run the shader (an export)
let current = [];

export function setCarveSurfaces(surfaces = []) {
  let at = 0, n = 0;
  current = [];
  for (const s of surfaces) {
    const ring = s.ring ?? [];
    if (ring.length < 3 || n >= MAX_SURFACES || at + ring.length > MAX_VERTS) continue;
    current.push({ ring, level: s.level });
    ring.forEach(([x, z], k) => texels.set([x, z, 0, 0], (at + k) * 4));
    carveUniforms.uCarveSurf.value[n].set(at, ring.length, s.level, 0);
    at += ring.length;
    n++;
  }
  carveUniforms.uCarveCount.value = n;
  table.needsUpdate = true;
  return n;
}

/** World -> design frame. The design hangs under the calibration's yaw, so this changes with north. */
export function setCarveFrame(designMatrixWorld) {
  carveUniforms.uCarveToDesign.value.copy(designMatrixWorld).invert();
}

const GLSL = /* glsl */`
uniform sampler2D uCarveTable;
uniform vec4 uCarveSurf[${MAX_SURFACES}];
uniform int uCarveCount;
uniform mat4 uCarveToDesign;
varying vec3 vCarveWorld;
bool carveInside(vec2 p, int start, int count) {
  bool inside = false;
  for (int k = 0; k < ${MAX_VERTS}; k++) {
    if (k >= count) break;
    vec2 a = texelFetch(uCarveTable, ivec2(start + k, 0), 0).xy;
    vec2 b = texelFetch(uCarveTable, ivec2(start + (k + 1 == count ? 0 : k + 1), 0), 0).xy;
    if ((a.y > p.y) != (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
bool carved() {
  if (uCarveCount == 0) return false;
  vec4 d = uCarveToDesign * vec4(vCarveWorld, 1.0);
  for (int s = 0; s < ${MAX_SURFACES}; s++) {
    if (s >= uCarveCount) break;
    vec4 S = uCarveSurf[s];
    if (d.y > S.z && carveInside(d.xz, int(S.x), int(S.y))) return true;
  }
  return false;
}
`;

/**
 * Patch a capture material so it is cut by the level surfaces. Idempotent, and it
 * keeps any onBeforeCompile the material already had.
 */
export function applyCarve(material) {
  if (!material || material.userData?.carve) return material;
  material.userData.carve = true;
  const before = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    before?.call(material, shader, renderer);
    Object.assign(shader.uniforms, carveUniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vCarveWorld;")
      .replace("#include <project_vertex>",
               "#include <project_vertex>\n  vCarveWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + GLSL)
      .replace("void main() {", "void main() {\n  if (carved()) discard;");
  };
  // no customProgramCacheKey of our own: three keys a program on onBeforeCompile's
  // source by default, which already tells a carved material from a plain one
  material.needsUpdate = true;
  return material;
}

/**
 * The scan's GEOMETRY cut the way the shader cuts its fragments, for what cannot run the
 * shader — a GLB that Blender reads for the photoreal look, where the terrace
 * otherwise sits buried in raw ground. A triangle goes when its centroid is inside a level
 * surface and above its level; at the capture's ~5 cm spacing that is the shader's edge to
 * within a triangle. Returns a NEW geometry sharing the vertex buffers — the one on screen
 * is never touched — or null when nothing is cut.
 */
export function carveGeometry(geometry, matrixWorld, surfaces = current,
                              toDesign = carveUniforms.uCarveToDesign.value) {
  const pos = geometry?.attributes?.position;
  if (!pos || !surfaces.length) return null;
  const toD = new THREE.Matrix4().multiplyMatrices(toDesign, matrixWorld);
  const idx = geometry.index;
  const tris = (idx ? idx.count : pos.count) / 3;
  const at = t => (idx ? idx.getX(t) : t);
  const v = new THREE.Vector3(), c = new THREE.Vector3();
  const keep = new Uint8Array(tris);
  let dropped = 0;
  for (let t = 0; t < tris; t++) {
    c.set(0, 0, 0);
    for (let k = 0; k < 3; k++) c.add(v.fromBufferAttribute(pos, at(3 * t + k)));
    c.divideScalar(3).applyMatrix4(toD);
    const cut = surfaces.some(s => c.y > s.level && insideRing([c.x, c.z], s.ring));
    keep[t] = cut ? 0 : 1;
    dropped += cut ? 1 : 0;
  }
  if (!dropped) return null;
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geometry.attributes)) out.setAttribute(name, attr);
  const index = [];
  // a multi-material capture keeps its groups, each shrunk to the triangles it kept
  const groups = geometry.groups.length ? geometry.groups : [{ start: 0, count: tris * 3, materialIndex: 0 }];
  for (const g of groups) {
    const start = index.length;
    for (let t = g.start / 3; t < (g.start + g.count) / 3; t++)
      if (keep[t]) index.push(at(3 * t), at(3 * t + 1), at(3 * t + 2));
    if (geometry.groups.length) out.addGroup(start, index.length - start, g.materialIndex);
  }
  out.setIndex(index);
  return out;
}

/**
 * Cut every carved mesh of an export CLONE, measured on the ORIGINAL it was cloned from
 * (same traversal order): the original knows where the scan stands in the world, and the
 * clone may have been re-parented for export. Returns how many meshes were cut.
 */
export function carveForExport(clone, original, surfaces = current,
                               toDesign = carveUniforms.uCarveToDesign.value) {
  const a = [], b = [];
  original.updateWorldMatrix(true, true);
  original.traverse(o => a.push(o));
  clone.traverse(o => b.push(o));
  let n = 0;
  a.forEach((o, i) => {
    const mats = [].concat(o.material ?? []);
    if (!o.isMesh || !b[i]?.isMesh || !mats.some(m => m?.userData?.carve)) return;
    const g = carveGeometry(o.geometry, o.matrixWorld, surfaces, toDesign);
    if (g) { b[i].geometry = g; n++; }
  });
  return n;
}

/** The same test the shader makes, for tests and for anything placing on designed ground. */
export function insideRing([x, z], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[j];
    if ((az > z) !== (bz > z) && x < (bx - ax) * (z - az) / (bz - az) + ax) inside = !inside;
  }
  return inside;
}
