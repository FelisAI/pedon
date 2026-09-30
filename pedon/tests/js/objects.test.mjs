// node --test tests/js/objects.test.mjs
//
// The library must never veto the design.
//
// With only six element types — beds, paths, patios, plants, edges, steps — a
// bench, a boulder, a stone lantern, a water basin, a pergola or a fire pit cannot
// be written down at all. The fire pit ends up as a PATIO named `firepit_terrace`,
// and a Mediterranean, Japanese or Chinese fusion style comes back as gravel and
// planting: those objects ARE the style.
//
// The asset library's limitations must not limit the LLM.
// So `kind` is FREE TEXT, not an enum. The model asks for what the design needs,
// and this module always returns something honest:
//   * a known kind gets purpose-built procedural geometry;
//   * an unknown kind gets a placeholder at the RIGHT SIZE, marked as one;
//   * nothing is ever silently substituted, and nothing is ever refused.
// The unmatched kinds become a want list — the gap turns into a work item for the
// owner instead of an invisible downgrade nobody finds out about.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
globalThis.document = {
  createElement() {
    const ctx = { fillStyle: "#000", fillRect() {}, fillText() {}, measureText: () => ({ width: 10 }),
                  beginPath() {}, arc() {}, fill() {}, stroke() {}, createLinearGradient: () => ({ addColorStop() {} }) };
    return { width: 0, height: 0, getContext: () => ctx };
  },
};
// three resolves from viewer/src, not from tests/js — same route the other
// suites take rather than a second copy of the dependency
const THREE = await import(path.join(ROOT, "viewer", "node_modules", "three", "build", "three.module.js"));
const objects = await import(path.join(ROOT, "viewer", "src", "objects.js"));
const flat = () => 0;

const size = m => {
  let lo = Infinity, hi = -Infinity, wx = Infinity, wX = -Infinity, wz = Infinity, wZ = -Infinity;
  m.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  m.traverse(o => {
    const p = o.geometry?.attributes?.position;
    if (!p) return;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);   // WORLD, not local
      const y = v.y, x = v.x, z = v.z;
      lo = Math.min(lo, y); hi = Math.max(hi, y);
      wx = Math.min(wx, x); wX = Math.max(wX, x); wz = Math.min(wz, z); wZ = Math.max(wZ, z);
    }
  });
  return { bottom: lo, top: hi, height: hi - lo, width: Math.max(wX - wx, wZ - wz) };
};

test("the module knows some kinds — otherwise the fallback tests prove nothing", () => {
  assert.ok(Array.isArray(objects.KNOWN_KINDS), "KNOWN_KINDS must be enumerable");
  assert.ok(objects.KNOWN_KINDS.length >= 6,
    `only ${objects.KNOWN_KINDS.length} kinds; the style vocabulary needs more than that`);
});

test("a known kind is built, not placeholdered", () => {
  const kind = objects.KNOWN_KINDS[0];
  const m = objectMeshOf({ id: "o1", kind, position: [0, 0], height_m: 1.4 });
  assert.equal(m.userData.placeholder, false, `${kind} should have real geometry`);
  assert.ok(size(m).height > 0.1, `${kind} produced nothing`);
});

test("AN UNKNOWN KIND IS STILL BUILT — the library never refuses the design", () => {
  const m = objectMeshOf({ id: "o2", kind: "moon gate", position: [0, 0],
                           height_m: 2.4, width_m: 1.8 });
  const s = size(m);
  assert.ok(s.height > 0.1, "an unknown kind produced no geometry — the design was vetoed");
  assert.ok(Math.abs(s.height - 2.4) < 0.6, `asked for 2.4 m, got ${s.height.toFixed(2)} m`);
});

test("an unknown kind is MARKED, so it can become a want rather than a lie", () => {
  const m = objectMeshOf({ id: "o3", kind: "shishi-odoshi deer scarer", position: [0, 0], height_m: 2 });
  assert.equal(m.userData.placeholder, true,
    "an unmatched kind must say so; a silent substitution is how a gap stays invisible");
  assert.equal(m.userData.kind, "shishi-odoshi deer scarer", "the asked-for kind must survive for the want list");
});

test("nothing floats above the ground it was given", () => {
  // NOT "base == ground". A boulder is set INTO the earth — that is how stone
  // sits, and rendering one perched on the surface is the tell of a fake. Same
  // distinction float_check draws: it flags objects hanging clear of the ground
  // and deliberately does not flag a terrace cut into a slope. Buried is a
  // decision; floating is a bug.
  const ground = () => -3.2;
  for (const kind of [...objects.KNOWN_KINDS, "something nobody has modelled"]) {
    const s = size(objectMeshOf({ id: "g", kind, position: [4, -2], height_m: 1.2 }, ground));
    assert.ok(s.bottom <= -3.2 + 0.05,
      `${kind} FLOATS: base ${s.bottom.toFixed(2)} against ground -3.20`);
    assert.ok(s.bottom > -3.2 - 1.2,
      `${kind} is buried deeper than its own height — base ${s.bottom.toFixed(2)}`);
  }
});

test("wants() lists exactly the kinds nothing could build", () => {
  const design = { objects: [
    { id: "a", kind: objects.KNOWN_KINDS[0], position: [0, 0] },
    { id: "b", kind: "pagoda", position: [1, 0] },
    // "moon gate" does not belong here — it is BUILT (checked below). "tea
    // house" is genuinely unmodelled, and the sort of thing a garden style
    // will keep asking for.
    { id: "c", kind: "tea house", position: [2, 0] },
  ] };
  const w = objects.wants(design);
  assert.deepEqual(w.map(x => x.kind).sort(), ["pagoda", "tea house"]);
  assert.ok(!objects.wants({ objects: [{ id: "m", kind: "moon gate", position: [0, 0] }] }).length,
    "a moon gate is modelled and must not be reported as a want");
  assert.ok(w[0].ids?.length, "a want must say WHERE it was asked for, or it is not actionable");
});

function objectMeshOf(o, ground = flat) { return objects.objectMesh(o, ground); }

// ── an object is drawn at the height the design ASKED for ────────────
//
// A viewer that renders something other than what the file says makes every
// measurement in the project unfalsifiable. A builder that writes its profile in
// its own units has to reconcile it with `h`, or it draws the wrong size:
//
//   lantern  base 0.16 + shaft 0.62 + firebox 0.28 + cap 0.22 = 1.28 units,
//            divided by 1.6, stands every ishidoro at 0.8x its height — a
//            1.4 m lantern at 1.12 m.
//   basin    a lathe whose rim sits at h * 0.8 is a fifth short.
//
// Measuring the drawn bounding box against the declared height across the
// whole catalogue catches both, which is what this test does. The
// tolerance is per-kind because "height" honestly means different things: a
// bench declares its SEAT and the boards sit above it, and a boulder is set
// into the ground so part of it is below zero.

test("every object in the catalogue is drawn at its declared height", () => {
  const catalogue = objects.objectCatalog();
  assert.ok(catalogue.length >= 10, `only ${catalogue.length} objects in the catalogue`);
  const bad = [];
  for (const c of catalogue) {
    const m = objects.objectMesh(
      { kind: c.kind, position: [0, 0], height_m: c.height_m, width_m: c.width_m,
        id: `t_${c.kind}` }, flat);
    m.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(m);
    // a set boulder is partly buried, so measure what stands ABOVE ground
    const drawn = box.max.y - Math.max(box.min.y, 0);
    const ratio = drawn / c.height_m;
    // 12% either way: a bench's boards sit on top of the declared seat height and
    // a lumpy boulder's bounding box exceeds its nominal radius. 20% is the bug.
    if (!(ratio > 0.88 && ratio < 1.12))
      bad.push(`${c.kind} declared ${c.height_m} m, drawn ${drawn.toFixed(3)} m (${ratio.toFixed(2)}x)`);
  }
  assert.deepEqual(bad, [], `objects not drawn at their declared height:\n  ${bad.join("\n  ")}`);
});

test("a bench is made of boards, not one plank", () => {
  // A box for the seat and two for the legs (36 triangles) is too crude for the
  // object most often placed, because a bench is where a garden is actually sat
  // in. A bench reads as a bench because of the GAPS —
  // the line of shadow between the boards is most of what says "seat".
  const m = objects.objectMesh(
    { kind: "bench", position: [0, 0], height_m: 0.45, width_m: 1.6, id: "t_bench" }, flat);
  let meshes = 0, tris = 0;
  m.traverse(o => {
    if (!o.geometry?.attributes?.position) return;
    meshes++;
    tris += o.geometry.index ? o.geometry.index.count / 3
                             : o.geometry.attributes.position.count / 3;
  });
  assert.ok(meshes >= 7, `a bench of ${meshes} pieces is a plank on legs`);
  assert.ok(tris > 90, `${tris} triangles`);
  assert.ok(tris < 600, `${tris} triangles for one bench — it is furniture, not the view`);
});

// ── an object is the size it says it is ────────────────────────────────
//
// Every builder scales its profile by `h / <the profile's own total>`, and that
// total is a number written in a comment, so a profile that grows without its
// divisor draws too tall: a stack of 1.34 units divided by 1.28 draws a declared
// 1.4 m lantern at 1.47 m.
//
// So: measure, do not trust the arithmetic in the comment. This is the object
// half of what plants_base.test.mjs does for the plant library.
test("every object draws the height it was asked for", () => {
  for (const entry of objects.objectCatalog()) {
    const g = objects.objectMesh({ kind: entry.kind, height_m: entry.height_m,
                           width_m: entry.width_m || entry.height_m, position: [0, 0] });
    const box = new THREE.Box3().setFromObject(g);
    // ABOVE GROUND, not the bounding box. A boulder is bedded into the soil — its
    // box is 0.68 m tall while 0.60 of it shows, which is exactly its declared
    // height — and "how tall is this thing" means the part you can see, for the
    // design and for the eye alike.
    const drawn = box.max.y - Math.max(box.min.y, 0);
    const ratio = drawn / entry.height_m;
    // A SINGLE TOLERANCE CANNOT DO THIS: that lantern bug draws 104.7% while the
    // bench legitimately draws 105.0%, so any band admitting the bench admits the
    // bug — with one band, putting the divisor back to 1.28 leaves the test green.
    //
    // So most objects are held EXACT, because they are exact: lantern, basin, pot,
    // fire pit, screen and koi pond all land on 100.0%. The four below declare
    // something slightly other than their overall height, and each says what:
    const SLACK = {
      bench: 0.06,      // 0.45 is SEAT height; the slab sits proud of it
      moon_gate: 0.05,  // 2.4 is the opening it frames, plus the coping over it
      pergola: 0.03,    // 2.4 is the headroom you walk under, plus the beams
      boulder: 0.04,    // irregular on purpose; the declared size is nominal
    };
    const slack = SLACK[entry.kind] ?? 0.015;
    assert.ok(Math.abs(ratio - 1) <= slack,
      `${entry.kind} declares ${entry.height_m} m and draws ${drawn.toFixed(3)} m `
      + `(${(ratio * 100).toFixed(1)}%, allowed ${((1 + slack) * 100).toFixed(1)}%) — `
      + "check the divisor against the profile it actually scales");
  }
});

test("every object stands ON the ground, not in it or above it", () => {
  // The float/bury class, which is the single most common defect in this project.
  // SET STONE is the legitimate exception: it is BEDDED, and a stone perched on the
  // surface reads as a ball dropped on a lawn. Two kinds qualify and they bed to
  // different depths on purpose — a boulder settles into ground (0.09 of its
  // height), lava sits far shallower (0.05) because scoria is light, angular and
  // sits ON a slope rather than sinking into it.
  const BEDDED = { boulder: -0.12, lava_rock: -0.05 };
  for (const entry of objects.objectCatalog()) {
    const g = objects.objectMesh({ kind: entry.kind, height_m: entry.height_m,
                           width_m: entry.width_m || entry.height_m, position: [0, 0] });
    const base = new THREE.Box3().setFromObject(g).min.y;
    const floor = BEDDED[entry.kind] ?? -0.001;
    assert.ok(base >= floor && base < 0.02,
      `${entry.kind} has its base at ${base.toFixed(3)} m`);
  }
});
