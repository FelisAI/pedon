// Is the scene LIT like a garden on a sunny afternoon, or like a diagram?
//
// lighting.test.mjs proves the sun points the right way and that the shadow map
// is configured. Every one of those tests can pass while the viewer renders 468
// meshes of which EXACTLY ZERO cast or receive a shadow, and while the
// photogrammetry capture — the thing that fills most of every frame — is
// displayed at 0.66 x the brightness of the photograph it was made from.
//
// That is the gap this file exists for. Measured against the live viewer
// without what this file pins:
//
//   scene traverse         468 meshes, castShadow on 0, receiveShadow on 0
//   scene.environment      null — every indirect ray is one hemisphere term
//   capture material       MeshStandardMaterial, lit by the analytic sun
//   source albedo texture  8192^2, p05 49, p50 77, p95 181, 2.2% of pixels > 200
//   what reached the JPEG  p05  0, p50 43, p95 150, 0.01% of pixels > 200
//
// The last two lines are the whole story: the render is a copy of a photograph,
// developed two stops down. Working the pipeline by hand predicts it exactly —
// a texel of 180 goes linear 0.457, x0.6637 (the irradiance the analytic lights
// put on a horizontal surface), x1.15 exposure, through Neutral's -0.04 toe, and
// lands at 151 on screen against a measured p95 of 150. So without what this file
// pins, the cap on every render is arithmetic, not taste.
//
// The assertions below are therefore about PHYSICS, not about the module's constants:
//   - a photograph is displayed as the photograph
//   - sunlight beats skylight the way it does outdoors
//   - a sunlit surface renders at roughly its own albedo, which is what
//     "correctly exposed" means
//   - something added to the scene after the lights are up still casts
// Each one fails without the code that satisfies it.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const THREE = await import(path.join(ROOT, "viewer", "node_modules", "three", "build", "three.module.js"));
const L = await import(path.join(ROOT, "viewer", "src", "lighting.js"));

const YAW = 0.4069;   // 23.3 deg: world and ENU are IDENTICAL at 0, so 0 tests nothing

/** A scene shaped like the viewer's: geoGroup > levelGroup (the capture) + enuGroup. */
function rig({ yaw = YAW, tx = 1.8, tz = -2.4 } = {}) {
  const scene = new THREE.Scene();
  const geoGroup = new THREE.Group();
  geoGroup.name = "geo";
  geoGroup.rotation.set(0, yaw, 0);
  geoGroup.position.set(tx, 0, tz);
  const levelGroup = new THREE.Group();
  levelGroup.name = "level";
  const enuGroup = new THREE.Group();
  enuGroup.name = "enu";
  geoGroup.add(levelGroup, enuGroup);
  scene.add(geoGroup);
  // node has no WebGL. The stub carries only what a renderer must expose for
  // the parts of initLighting that are not GPU work; the sky is skipped for
  // want of a PMREMGenerator and that is asserted, not assumed.
  const renderer = { shadowMap: {} };
  return { scene, geoGroup, levelGroup, enuGroup, renderer };
}

/** The real thing: one lit material, one baseColorTexture, metalness 0. */
function fakeCapture(n = 1) {
  const g = new THREE.Group();
  g.name = "capture";
  for (let i = 0; i < n; i++) {
    const m = new THREE.MeshStandardMaterial({ metalness: 0 });
    m.map = { isTexture: true, id: `albedo${i}` };
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), m);
    mesh.name = "mesh";
    g.add(mesh);
  }
  return g;
}

const litMesh = (name = "leaf") =>
  new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial()).clone()
    .copy(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial()));

/** One frame's worth of the hook three calls before it renders the shadow map. */
const oneFrame = (scene, renderer) => scene.onBeforeRender(renderer, scene, null, null);


// ── 1. the capture is a photograph and must be shown as one ───────────────
test("the capture reaches the screen at the brightness it was photographed at", () => {
  const cap = fakeCapture(2);
  const maps = cap.children.map(o => o.material.map);

  const n = L.showCaptureAsPhotograph(cap);
  assert.equal(n, 2, `expected 2 materials converted, got ${n}`);

  cap.children.forEach((o, i) => {
    const m = o.material;
    assert.ok(m.isMeshBasicMaterial,
      `still ${m.type}: a lit material means the analytic sun shades a texture that ` +
      `already has the sun of capture day baked into it`);
    assert.equal(m.map, maps[i], "the albedo texture was dropped");
    // The two multipliers that darkened it. A photograph is display-referred
    // already: anything but 1.0 here re-develops somebody else's exposure.
    assert.equal(m.color.getHex(), 0xffffff,
      `capture tinted to #${m.color.getHexString()} — a gain of anything but 1 makes the ` +
      `scan darker (or brighter) than the photograph it came from`);
    assert.equal(m.toneMapped, false,
      "the capture is tone mapped, so the curve is applied to pixels a camera already " +
      "applied a curve to — measured, Neutral's toe took the scan's p05 from 49 to 11");
  });
});

test("showing the capture twice does not develop it twice", () => {
  const cap = fakeCapture(2);
  L.showCaptureAsPhotograph(cap);
  const before = cap.children.map(o => o.material.color.getHex());
  const n = L.showCaptureAsPhotograph(cap);
  assert.equal(n, 0, `converted ${n} materials on the second call — a reload would re-tint`);
  assert.deepEqual(cap.children.map(o => o.material.color.getHex()), before);
});


// ── 2. shadows land on the capture without lighting it ────────────────────
test("the capture catches the shadow of things that were not there on capture day", () => {
  const cap = fakeCapture(1);
  const mesh = cap.children[0];
  L.showCaptureAsPhotograph(cap);
  const catcher = L.makeCaptureShadowCatcher(cap);

  assert.ok(catcher, "no shadow catcher — a MeshBasicMaterial cannot receive a shadow map, " +
                     "so nothing the design casts would ever appear on the ground");
  assert.equal(catcher.geometry, mesh.geometry,
    "the catcher does not share the capture's own geometry — a separate height-field plane " +
    "is the thing that invents flat ground the scan never saw");
  assert.ok(catcher.material.isShadowMaterial,
    `catcher draws with ${catcher.material.type}; it must contribute zero except in shadow`);
  assert.equal(catcher.receiveShadow, true, "the catcher does not receive");
  assert.equal(catcher.castShadow, false, "the catcher shadows the yard with itself");
  assert.equal(catcher.parent, mesh,
    "the catcher must ride the capture mesh's own transform, or it slides off at any yaw");

  // main.js:658 and viewport.js scanGridOp both raycast the whole stage. A second
  // surface on the same triangles would double every ground query.
  const hits = [];
  catcher.raycast(new THREE.Raycaster(), hits);
  assert.equal(hits.length, 0,
    "the catcher is pickable, so it answers ground raycasts as a second copy of the scan");
});

test("a second call does not stack catchers on the capture", () => {
  const cap = fakeCapture(1);
  L.showCaptureAsPhotograph(cap);
  L.makeCaptureShadowCatcher(cap);
  L.makeCaptureShadowCatcher(cap);
  let n = 0;
  cap.traverse(o => { if (o.userData?.shadowCatcher) n++; });
  assert.equal(n, 1, `${n} shadow catchers stacked on one capture`);
});


// ── 3. things added AFTER the lights are up still cast ────────────────────
test("a plant planted after the sun was set up still casts a shadow", () => {
  const r = rig();
  L.initLighting(r);

  // the design arrives later — every plant, wall and boulder in this viewer is
  // built after initLighting has run, so without this pass every one has castShadow off
  const plant = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
  plant.name = "leaf";
  r.enuGroup.add(plant);
  assert.equal(plant.castShadow, false, "precondition: three defaults castShadow to false");

  oneFrame(r.scene, r.renderer);

  assert.equal(plant.castShadow, true,
    "a mesh added after initLighting never casts — the viewer ends up with " +
    "shadowMap.enabled true, sun.castShadow true, and 0 of 468 meshes casting");
  assert.equal(plant.receiveShadow, true, "and nothing receives, so no plant sits in another's shade");
});

test("the capture casts nothing: its own shadows are already in the pixels", () => {
  const r = rig();
  L.initLighting(r);
  const cap = fakeCapture(1);
  r.levelGroup.add(cap);

  oneFrame(r.scene, r.renderer);

  const mesh = cap.children[0];
  assert.equal(mesh.castShadow, false,
    "the house casts a second, analytic shadow beside the one baked into its own texture");
  assert.ok(mesh.material.isMeshBasicMaterial,
    "the capture under levelGroup was left on the analytic sun");
  let catchers = 0;
  cap.traverse(o => { if (o.userData?.shadowCatcher) catchers++; });
  assert.equal(catchers, 1, "the capture was never given anything that can receive a shadow");
});

test("the point cloud and the labels are left alone", () => {
  const r = rig();
  L.initLighting(r);
  const pts = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial());
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial());
  r.enuGroup.add(pts, sprite);

  oneFrame(r.scene, r.renderer);

  assert.equal(pts.castShadow, false,
    "a splat/point stage casts a rectangle of noise — it renders through its own shader");
  assert.equal(sprite.castShadow, false, "a text label casting a shadow is a floating rectangle");
});

test("the pass costs nothing on a frame where nothing was added", () => {
  const r = rig();
  L.initLighting(r);
  for (let i = 0; i < 50; i++)
    r.enuGroup.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial()));
  assert.equal(L.armSceneShadows(r.scene), 50, "first pass did not flag the 50 new meshes");
  assert.equal(L.armSceneShadows(r.scene), 0,
    "the pass re-flags everything every frame — at 60 fps that is work per object per frame");
});


// ── 4. sunlight beats skylight, the way it does outdoors ──────────────────
test("the sun is the light source and the sky is the fill, not the other way round", () => {
  const r = rig();
  const h = L.initLighting(r);
  const b = L.daylightBalance(h);

  // Clear midday: ~900 W/m2 normal beam, ~100 W/m2 diffuse, so on a horizontal
  // surface at this altitude the ratio is near 7:1. Overcast is 0. Anything
  // under ~2.5:1 has no readable form — every face of every object gets nearly
  // the same irradiance and the render is a diagram.
  assert.ok(b.sun_to_sky >= 2.5,
    `sun:sky is ${b.sun_to_sky.toFixed(2)}:1 — that is a bright overcast, not an afternoon. ` +
    `Nothing in the scene has a light side and a dark side.`);
  assert.ok(b.sun_to_sky <= 9,
    `sun:sky is ${b.sun_to_sky.toFixed(2)}:1 — shade goes to black and half the garden is unreadable`);
});

test("a sunlit surface renders at about its own albedo — which is what correct exposure means", () => {
  const r = rig();
  const h = L.initLighting(r);
  const g = L.daylightBalance(h).sunlit_gain;

  // A photograph exposed for daylight puts an 18% grey card at 0.18 linear,
  // i.e. sRGB 118. So for a horizontal surface in sun, irradiance/PI x exposure
  // should be about 1. At 0.6637 x 1.15 = 0.763, that single number makes every
  // render in data/views top out around 150/255 with no highlights.
  assert.ok(g >= 0.95 && g <= 1.4,
    `a white surface in full sun renders at ${g.toFixed(3)} of its albedo. ` +
    `Under ~0.95 the whole frame is developed down and the tone curve's shoulder ` +
    `is never reached, so no pixel is ever bright.`);
});

test("the exposure and the tone curve belong to the lighting, not to whoever made the renderer", () => {
  const r = rig();
  L.initLighting(r);
  assert.equal(r.renderer.toneMapping, THREE.NeutralToneMapping,
    "tone mapping is not set here, so re-tuning the sun in this module can clip the " +
    "whole garden white and nothing in this file would know");
  assert.ok(r.renderer.toneMappingExposure > 0, "no exposure set");
});


// ── 5. there is a sky, and it is a sky ────────────────────────────────────
test("the sky is brightest at the sun and darkest underfoot", () => {
  const dir = L.sunDirectionWorld(123.69, 47.97);
  const sky = L.skyEquirect({ width: 64, height: 32, sunDir: dir });

  const sample = v => {
    const n = v.clone().normalize();
    // inverse of the equirect mapping the builder uses
    const theta = Math.acos(THREE.MathUtils.clamp(n.y, -1, 1));
    const phi = Math.atan2(n.x, -n.z);
    const u = ((phi / (2 * Math.PI)) % 1 + 1) % 1;
    const j = Math.min(sky.height - 1, Math.floor((theta / Math.PI) * sky.height));
    const i = Math.min(sky.width - 1, Math.floor(u * sky.width));
    const k = (j * sky.width + i) * 4;
    return 0.2126 * sky.data[k] + 0.7152 * sky.data[k + 1] + 0.0722 * sky.data[k + 2];
  };

  const zenith = sample(new THREE.Vector3(0, 1, 0));
  const nadir = sample(new THREE.Vector3(0, -1, 0));
  const atSun = sample(dir);
  const awaySun = sample(new THREE.Vector3(-dir.x, dir.y, -dir.z));

  assert.ok(zenith > nadir * 2, `zenith ${zenith.toFixed(3)} vs ground ${nadir.toFixed(3)}: ` +
    `a sky that is as bright below the horizon as above it lights everything from everywhere`);
  assert.ok(atSun > awaySun * 1.3,
    `the sky is ${atSun.toFixed(3)} towards the sun and ${awaySun.toFixed(3)} away from it — ` +
    `it carries no directional information at all`);
});

test("the sky's own irradiance is measured, not guessed, and it comes from above", () => {
  const dir = L.sunDirectionWorld(123.69, 47.97);
  const sky = L.skyEquirect({ width: 64, height: 32, sunDir: dir });
  const up = L.skyIrradiance(sky, new THREE.Vector3(0, 1, 0));
  const down = L.skyIrradiance(sky, new THREE.Vector3(0, -1, 0));
  assert.ok(up > 0, "the sky delivers no light");
  assert.ok(up > down * 2,
    `up ${up.toFixed(3)} vs down ${down.toFixed(3)} — the underside of a leaf is lit as ` +
    `hard as the top of it, which is the flat-ambient look this is here to end`);
});

test("with no GPU the sky is skipped and the lights still work", () => {
  const r = rig();                       // renderer stub: no PMREMGenerator possible
  const h = L.initLighting(r);
  assert.equal(r.scene.environment, null,
    "an environment map was built without a real renderer — that throws in node and " +
    "would take frame_check and float_check down with it");
  assert.equal(h.env, null, "handle claims an environment it does not have");
  assert.ok(L.daylightBalance(h).sunlit_gain > 0,
    "the analytic lights must stand on their own when the sky cannot be built");
});

test("the sky texture is uploaded the way three.js reads it, not the way we write it", () => {
  // skyDirection is this file's ONE mapping and puts the zenith at row 0. three.js
  // samples an equirect with v = asin(y)/PI + 0.5 and a DataTexture does not flipY,
  // so it expects the zenith at the LAST row. Uploaded in our own order the sky
  // renders upside down — measured in the viewer as a near-black zenith over a pale
  // horizon, a sunset the wrong way up — while every numeric test passes because the
  // DATA is right.
  const dir = L.sunDirectionWorld(123.69, 47.97);
  const sky = L.skyEquirect({ width: 32, height: 16, sunDir: dir });
  const tex = L.skyTexture(sky);
  const w = sky.width, h = sky.height;
  const lumHalf = (j) => {
    const k = (j * w + Math.floor(w / 2)) * 4;
    const f = (x) => THREE.DataUtils.fromHalfFloat(tex.image.data[x]);
    return 0.2126 * f(k) + 0.7152 * f(k + 1) + 0.0722 * f(k + 2);
  };
  const top = lumHalf(0), bottom = lumHalf(h - 1);
  assert.ok(bottom > top * 2,
    `uploaded texture: first row ${top.toFixed(3)}, last row ${bottom.toFixed(3)} — ` +
    `three.js puts the zenith LAST, so the bright end must be at the bottom of the buffer`);
});
