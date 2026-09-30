// node --test tests/js/translucency.test.mjs
//
// Leaves are lit from behind as well as in front.
//
// Plants must read as photographs, not simple 3D models. A MeshStandardMaterial
// diffuses with max(dot(N, L), 0), so a leaf facing away from the sun receives
// exactly zero direct light and reads as a flat dark chip. In a real garden the
// plants between you and the afternoon sun are the BRIGHT ones. That is the cue
// this adds.
//
// What can be tested without a GPU, and what each test is really for:
//
//   1. The LOBE, as pure arithmetic — front-lit contributes nothing, the peak is
//      looking straight down the sun's own ray, and a higher exponent is a tighter
//      glow. This is the shape of the effect.
//   2. The AMOUNT is per leaf class and is not one number wearing eight hats. A
//      rosemary needle is waxy and nearly opaque; a big thin blade is stained
//      glass. Giving every leaf the same transmission makes different plants
//      read as one.
//   3. THE ANCHORS STILL EXIST. This is the valuable one. The effect is installed
//      by String.replace on three.js's own shader source, and a replace whose
//      pattern does not match is a SILENT NO-OP — a three.js upgrade that renamed
//      a chunk would leave every leaf opaque with this whole suite green. So the
//      anchors are asserted against the three.js that is actually installed.
//   4. The WIRING: leaves and petals get it, WOOD does not, because a glowing
//      branch would undo the cue the leaves are giving.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
// three has no node_modules above tests/, so reach the viewer's copy directly —
// the same path lighting.test.mjs uses. It resolves to the identical file the
// viewer's own modules import, so this is one module instance, not two.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const THREE = await import(path.join(ROOT, "viewer", "node_modules", "three", "build", "three.module.js"));
import {
  TRANSLUCENCY, BLOOM_TRANSLUCENCY, DEFAULT_TRANSLUCENCY, LEAF_TRANSMIT_TINT,
  backlitResponse, translucencyFor, translucent, ANCHORS, SOURCE,
} from "../../viewer/src/translucency.js";

// plants.js draws its leaf masks on a 2D canvas; node has no DOM, and the module
// is written to survive that (it returns null and the cards go unmasked). The shim
// is only here so buildPlant() can run at all.
globalThis.document = {
  createElement() {
    const ctx = new Proxy({}, {
      get: (_, k) => (k === "canvas" ? { width: 128, height: 128 } : () => ctx),
      set: () => true,
    });
    return { width: 0, height: 0, getContext: () => ctx };
  },
};
const { buildPlant, leafClass } = await import("../../viewer/src/plants.js");

// ── 1. the lobe ───────────────────────────────────────────────────────────

test("a front-lit leaf transmits nothing at all", () => {
  // dot(-L, V) <= 0 means the sun is behind the VIEWER: there is nothing coming
  // through the leaf toward the eye, and any positive value here would be a
  // uniform glow stuck on every plant in the garden
  for (const d of [-1, -0.5, -0.001, 0])
    assert.equal(backlitResponse(d, 4, 1), 0, `dotVL=${d} must transmit nothing`);
});

test("the peak is looking straight down the sun's own ray", () => {
  assert.equal(backlitResponse(1, 4, 1), 1);
  assert.equal(backlitResponse(1, 4, 0.4), 0.4, "scale is the peak fraction");
});

test("the response rises monotonically toward the sun", () => {
  const xs = [0, 0.2, 0.4, 0.6, 0.8, 1];
  const ys = xs.map(x => backlitResponse(x, 4, 1));
  for (let i = 1; i < ys.length; i++)
    assert.ok(ys[i] > ys[i - 1], `not monotonic at ${xs[i]}: ${ys[i - 1]} -> ${ys[i]}`);
});

test("a higher exponent is a TIGHTER glow, not a brighter one", () => {
  // same peak, less spread — this is what separates a rosemary's hard glint from
  // a bergenia's broad wash
  assert.equal(backlitResponse(1, 8, 1), backlitResponse(1, 2, 1));
  assert.ok(backlitResponse(0.5, 8, 1) < backlitResponse(0.5, 2, 1),
    "the higher exponent must fall off faster off-axis");
});

test("nonsense in is zero out, not NaN spread across the garden", () => {
  for (const bad of [NaN, undefined, null, Infinity])
    assert.equal(backlitResponse(bad, 4, 1), 0);
  assert.equal(backlitResponse(1, NaN, 1), 0);
  assert.equal(backlitResponse(1, 4, NaN), 0);
});

// ── 2. the amount is a property of the leaf ───────────────────────────────

test("a waxy needle transmits far less than a big thin blade", () => {
  assert.ok(TRANSLUCENCY.needle.scale < TRANSLUCENCY.large.scale / 3,
    "rosemary and a broad blade cannot have comparable transmission");
  assert.ok(TRANSLUCENCY.needle.power > TRANSLUCENCY.large.power,
    "a thick needle's transmission is a tight glint; a thin blade's is a wash");
});

test("transmission is not one number wearing eight hats", () => {
  const scales = new Set(Object.values(TRANSLUCENCY).map(t => t.scale));
  assert.ok(scales.size >= 5,
    `only ${scales.size} distinct transmission values across ${Object.keys(TRANSLUCENCY).length} leaf classes`);
  for (const [k, v] of Object.entries(TRANSLUCENCY)) {
    assert.ok(v.scale > 0 && v.scale < 1, `${k}: transmission ${v.scale} is not a fraction`);
    assert.ok(v.power > 0, `${k}: exponent ${v.power} would not be a lobe`);
  }
});

test("a petal transmits more than any leaf", () => {
  const maxLeaf = Math.max(...Object.values(TRANSLUCENCY).map(t => t.scale));
  assert.ok(BLOOM_TRANSLUCENCY.scale > maxLeaf,
    "backlighting is most of what a flower does");
});

test("an unknown leaf class falls back rather than going opaque or NaN", () => {
  assert.deepEqual(translucencyFor("no_such_class"), DEFAULT_TRANSLUCENCY);
  assert.deepEqual(translucencyFor(undefined), DEFAULT_TRANSLUCENCY);
  assert.ok(translucencyFor("no_such_class").scale > 0);
  // and a real class routes to its own entry
  assert.deepEqual(translucencyFor("needle"), TRANSLUCENCY.needle);
});

test("the transmitted colour is warmer and greener than white", () => {
  // chlorophyll passes green and yellow and absorbs blue: the tint is what stops
  // this reading as a brightness filter stuck on the plants
  const [r, g, b] = LEAF_TRANSMIT_TINT;
  assert.ok(g > r, "transmitted light must be greener than it is red");
  assert.ok(r > b, "transmitted light must be warmer than it is blue");
  assert.ok(b < 0.8, "blue is what a leaf absorbs");
});

// ── 3. the anchors — the silent-no-op guard ───────────────────────────────

test("the chunks this patches still exist in the three.js that is installed", () => {
  const src = THREE.ShaderLib.standard.fragmentShader;
  assert.ok(src.length > 500, "could not read the standard fragment shader at all");
  for (const a of ANCHORS)
    assert.ok(src.includes(a),
      `three.js no longer contains "${a}" — String.replace would silently no-op `
      + "and every leaf in the garden would go opaque with this suite still green");
});

test("patching a REAL shader really inserts the term", () => {
  const mat = translucent(new THREE.MeshStandardMaterial(), { scale: 0.4, power: 4 });
  const shader = {
    uniforms: {},
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    vertexShader: THREE.ShaderLib.standard.vertexShader,
  };
  mat.onBeforeCompile(shader);
  assert.match(shader.fragmentShader, /uniform float uTransScale/);
  assert.match(shader.fragmentShader, /reflectedLight\.directDiffuse \+=/);
  assert.equal(shader.uniforms.uTransScale.value, 0.4);
  assert.equal(shader.uniforms.uTransPower.value, 4);
  assert.ok(shader.uniforms.uTransTint.value.isColor, "the tint must be a THREE.Color");
  // the declarations must land BEFORE the use, or the shader will not compile
  assert.ok(shader.fragmentShader.indexOf("uniform float uTransScale")
            < shader.fragmentShader.indexOf("uTransScale;\n") + shader.fragmentShader.length);
  assert.ok(shader.fragmentShader.indexOf("uniform float uTransPower")
            < shader.fragmentShader.lastIndexOf("uTransPower"),
    "uTransPower is used before it is declared");
});

test("the GLSL and the JS are the same expression", () => {
  // backlitResponse() is the curve every test above pins, and the shader is where
  // it actually runs. Two copies of one expression drift apart, so the shapes
  // are asserted to match.
  assert.match(SOURCE.LOBE, /pow\(\s*max\(\s*dot\(\s*-lTrans,\s*vTrans\s*\),\s*0\.0\s*\),\s*uTransPower\s*\)/,
    "the GLSL lobe is no longer pow(max(dot(-L,V),0), power) — it has drifted from backlitResponse");
  assert.match(SOURCE.LOBE, /uTransScale/, "the shader ignores the transmission amount");
  assert.match(SOURCE.LOBE, /uTransTint/, "the shader ignores the transmitted colour");
});

test("two different leaves do not share one compiled program", () => {
  const a = translucent(new THREE.MeshStandardMaterial(), TRANSLUCENCY.needle);
  const b = translucent(new THREE.MeshStandardMaterial(), TRANSLUCENCY.large);
  assert.notEqual(a.customProgramCacheKey(), b.customProgramCacheKey(),
    "a needle and a blade would render identically out of the program cache");
});

test("asking for no transmission leaves the material alone", () => {
  const m = translucent(new THREE.MeshStandardMaterial(), { scale: 0 });
  assert.equal(m.userData.translucency, undefined);
  assert.equal(m.onBeforeCompile.toString(), new THREE.MeshStandardMaterial().onBeforeCompile.toString(),
    "a material asked for zero transmission must not be patched at all");
});

// ── 4. the wiring ─────────────────────────────────────────────────────────

const materialsOf = (plant) => {
  const out = [];
  plant.traverse(o => { if (o.material) out.push([o.name, o.material]); });
  return out;
};

test("a real plant's leaves are translucent and its wood is not", () => {
  const p = buildPlant({ id: "t1", species: "Arctostaphylos densiflora", common: "manzanita",
                         position: [0, 0], mature_height_m: 1.8, mature_spread_m: 1.8 });
  const mats = materialsOf(p);
  assert.ok(mats.length, "buildPlant produced nothing to inspect");
  const foliage = mats.filter(([n]) => n === "foliage");
  const wood = mats.filter(([n]) => n === "wood");
  assert.ok(foliage.length, "no foliage material on a manzanita");
  assert.ok(wood.length, "no wood material on a manzanita");
  for (const [, m] of foliage)
    assert.ok(m.userData.translucency?.scale > 0, "a leaf material is not translucent");
  for (const [, m] of wood)
    assert.equal(m.userData.translucency, undefined,
      "wood is translucent — a glowing branch undoes the cue the leaves give");
});

test("the plant's transmission is the one its LEAF CLASS calls for", () => {
  const rosemary = buildPlant({ id: "t2", species: "Salvia rosmarinus", common: "rosemary",
                               position: [0, 0], mature_height_m: 1.2, mature_spread_m: 1.2 });
  const bergenia = buildPlant({ id: "t3", species: "Bergenia crassifolia", common: "bergenia",
                                position: [0, 0], mature_height_m: 0.4, mature_spread_m: 0.6 });
  const scaleOf = (p) => {
    const m = materialsOf(p).find(([n]) => n === "foliage");
    return m?.[1]?.userData?.translucency?.scale;
  };
  // stated as identities, not just a delta: the classes themselves are asserted,
  // so this cannot pass because both plants happened to route somewhere else
  assert.equal(leafClass({ species: "Salvia rosmarinus" }), "needle");
  assert.equal(scaleOf(rosemary), TRANSLUCENCY.needle.scale);
  const bClass = leafClass({ species: "Bergenia crassifolia" });
  assert.equal(scaleOf(bergenia), TRANSLUCENCY[bClass].scale);
  assert.ok(scaleOf(bergenia) > scaleOf(rosemary),
    `a bergenia (${bClass}) must transmit more than a rosemary needle`);
});

test("every leaf class the shape table knows has a transmission", () => {
  // a class with a shape and no transmission silently falls back to `medium`, and
  // a silent fallback like that draws eight different salvias as one plant
  const shapes = Object.keys(TRANSLUCENCY);
  for (const cls of ["needle", "filigree", "scale", "small", "round", "lance", "medium", "large"])
    assert.ok(shapes.includes(cls), `leaf class "${cls}" has a shape but no transmission`);
});
