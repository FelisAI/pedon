// node --test tests/js/lighting.test.mjs
//
// What this file is for: viewer/src/lighting.js gives the viewer its shadows. An
// object sitting on the ground with no contact shadow is the single loudest cue
// that a thing has been comped in rather than grown there.
//
// Two things are locked down here, and neither is obvious:
//
//   1. THE FRAME. A sun is a BEARING, and world and ENU are identical at yaw 0,
//      so a frame confusion is perfectly invisible until someone presses "Set
//      north". Every aim test here runs at yaw 0.4069 rad (23.3 deg — the yaw
//      actually measured on the reference site's PLY capture) as well as at 0,
//      and asserts the sun's LOCAL position differs between the two. A test that
//      only ran at yaw 0 would pass against a module that ignored the frame
//      entirely.
//
//   2. NOT DOUBLE-LIGHTING THE CAPTURE. Measured, not assumed: the reference
//      site's Scaniverse capture carries exactly one material,
//      `{"name":"main","pbrMetallicRoughness":{"baseColorTexture":
//      {"index":0},"metallicFactor":0.0}}`, which GLTFLoader turns into a LIT
//      MeshStandardMaterial. Its texture is photogrammetry albedo with the
//      scan-day sun and the house's own shadow already baked into the pixels.
//      Aiming a second, analytic sun at it shades it twice. So the capture is
//      taken off the analytic sun and shown at exactly the brightness the lit
//      path gives it.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// three has no node_modules above tests/, so reach the viewer's copy directly.
// It is the SAME module instance lighting.js imports (verified: instanceof holds
// across the two), which is what makes the type assertions below meaningful.
const THREE = await import(path.join(ROOT, "viewer", "node_modules", "three", "build", "three.module.js"));
const L = await import(path.join(ROOT, "viewer", "src", "lighting.js"));

// 23.3 deg: the yaw Set north measured on the reference site's PLY capture
// (calibration.json). Any non-zero yaw would do; using the real one keeps the
// failure message honest about the scale of the error being guarded against.
const YAW = 0.4069;
const YAW_DEG = THREE.MathUtils.radToDeg(YAW);

const near = (a, b, tol, what) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);
/** Shortest angular distance between two compass bearings, degrees. */
const bearingGap = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);
const nearBearing = (a, b, tol, what) =>
  assert.ok(bearingGap(a, b) <= tol, `${what}: bearing ${a} is not within ${tol} deg of ${b}`);

function rig({ yaw = 0, tx = 0, tz = 0 } = {}) {
  const scene = new THREE.Scene();
  const geoGroup = new THREE.Group();
  geoGroup.name = "geo";
  geoGroup.rotation.set(0, yaw, 0);
  geoGroup.position.set(tx, 0, tz);
  scene.add(geoGroup);
  // initLighting only touches renderer.shadowMap, so a stub is the whole
  // renderer here — node has no WebGL and never will.
  const renderer = { shadowMap: {} };
  return { scene, geoGroup, renderer };
}

/**
 * Where the sun is aimed as the RENDERER sees it: the direction from the light's
 * target to the light, in WORLD space, read back off the matrices.
 *
 * This is deliberately computed from matrixWorld rather than from the module's
 * own numbers — it is the observable that decides which way a shadow falls, and
 * reading it independently is what stops these tests from measuring themselves.
 */
function worldAim({ sun, target }) {
  sun.updateWorldMatrix(true, false);
  target.updateWorldMatrix(true, false);
  const p = new THREE.Vector3().setFromMatrixPosition(sun.matrixWorld);
  const t = new THREE.Vector3().setFromMatrixPosition(target.matrixWorld);
  const d = p.sub(t).normalize();
  return {
    azimuth_deg: (THREE.MathUtils.radToDeg(Math.atan2(d.x, -d.z)) + 360) % 360,
    altitude_deg: THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(d.y, -1, 1))),
  };
}

/** The same bearing, but of the sun's LOCAL offset inside its parent. */
function localBearing({ sun, target }) {
  const d = sun.position.clone().sub(target.position).normalize();
  return (THREE.MathUtils.radToDeg(Math.atan2(d.x, -d.z)) + 360) % 360;
}

const sunLocal = h => h.sun.position.clone();

const fakeCapture = (n = 2) => {
  const g = new THREE.Group();
  g.name = "capture";
  for (let i = 0; i < n; i++) {
    // the real thing: one lit material, one baseColorTexture, metalness 0
    const m = new THREE.MeshStandardMaterial({ metalness: 0 });
    m.map = { isTexture: true, id: `albedo${i}` };
    g.add(new THREE.Mesh(new THREE.BufferGeometry(), m));
  }
  g.add(new THREE.Object3D());          // a non-mesh child, must be left alone
  return g;
};


// ── 1. the frame the sun lives in ─────────────────────────────────────────
test("the sun rides the calibrated frame; the sky, which has no bearing, does not", () => {
  const { scene, geoGroup, renderer } = rig({ yaw: YAW, tx: 12, tz: -9 });
  const h = L.initLighting({ renderer, scene, geoGroup });

  // presence and COUNT before any delta: a scene with no sun, or with the old
  // one still parented to the scene alongside the new one, must not pass.
  const dirs = [];
  scene.traverse(o => { if (o.isDirectionalLight) dirs.push(o); });
  assert.equal(dirs.length, 1, `expected exactly one DirectionalLight, got ${dirs.length}`);
  assert.equal(dirs[0], h.sun, "the handle's sun is not the light in the scene");

  const ancestors = o => { const a = []; for (let p = o.parent; p; p = p.parent) a.push(p); return a; };
  assert.ok(ancestors(h.sun).includes(geoGroup),
    `the sun hangs off ${h.sun.parent?.name || h.sun.parent?.type} — not geoGroup. ` +
    `A sun outside the yaw points its shadows 23.3 deg wrong the moment north is set.`);
  assert.ok(ancestors(h.target).includes(geoGroup),
    "the sun's TARGET is outside geoGroup — a directional light's direction is " +
    "position minus target, so splitting the two across frames aims it at nothing.");

  // The hemisphere is the opposite case and it is not symmetric. three derives a
  // HemisphereLight's axis from its WORLD POSITION, so under a geoGroup carrying
  // tx/tz = (12,-9) its (0,1,0) would land at (12,1,-9): an "up" 85 deg off
  // vertical, i.e. sky light coming in sideways. Sky has no compass bearing, so
  // it belongs in the scene.
  assert.ok(!ancestors(h.sky).includes(geoGroup),
    "the hemisphere light is under geoGroup; its axis will tilt with tx/tz");
  h.sky.updateWorldMatrix(true, false);
  const skyWorld = new THREE.Vector3().setFromMatrixPosition(h.sky.matrixWorld);
  near(skyWorld.normalize().y, 1, 1e-6, "hemisphere axis is not straight up");
});


test("no geoGroup, no sun — the module refuses rather than quietly using the scene", () => {
  // Parenting to the scene is the ONE failure this module exists to prevent, and
  // it looks perfect until Set north. So a caller who forgets geoGroup gets an
  // error, not a scene that renders beautifully and lies by 23.3 deg.
  const { scene, renderer } = rig();
  assert.throws(() => L.initLighting({ renderer, scene }), /geoGroup/i);
});

// ── 2. the convention, pinned to explicit vectors ─────────────────────────
test("azimuth is sun.py's compass bearing of the SKY: 0 = north, 90 = east", () => {
  // sun.py solar_position(): "Azimuth is a compass bearing of the SKY (0 = north,
  // 90 = east, clockwise)". The viewer's world frame is x = east, y = up,
  // z = -north (design.js enuToWorld). Pinned against literals so the whole
  // suite cannot drift onto a self-consistent but wrong convention.
  const cases = [
    [0, 0, [0, 0, -1]],           // due north, on the horizon
    [90, 0, [1, 0, 0]],           // due east
    [180, 0, [0, 0, 1]],          // due south
    [270, 0, [-1, 0, 0]],         // due west
    [180, 90, [0, 1, 0]],         // overhead
    [180, 45, [0, Math.SQRT1_2, Math.SQRT1_2]],
  ];
  assert.equal(cases.length, 6);
  for (const [az, alt, [x, y, z]] of cases) {
    const d = L.sunDirectionWorld(az, alt);
    near(d.x, x, 1e-9, `az ${az} alt ${alt}: x`);
    near(d.y, y, 1e-9, `az ${az} alt ${alt}: y`);
    near(d.z, z, 1e-9, `az ${az} alt ${alt}: z`);
  }

  // The physical consequence, stated the way a gardener would: at the reference site's
  // June solstice noon the sun is nearly overhead and slightly south
  // (`python3 tools/sun.py season` -> noon_altitude_deg 75.911), so a 1 m post
  // throws a 0.25 m shadow to the NORTH, which is -z.
  const noon = L.sunDirectionWorld(180, 75.911);
  // shadow of a 1 m post = height / tan(altitude), laid down the HORIZONTAL
  // component of the sun direction, reversed
  const away = new THREE.Vector3(noon.x, 0, noon.z).normalize()
    .multiplyScalar(-1 / Math.tan(THREE.MathUtils.degToRad(75.911)));
  assert.ok(away.z < 0, `June-noon shadow should run north (-z), got z=${away.z}`);
  near(Math.hypot(away.x, away.z), 0.2509, 1e-3, "1 m post's June-noon shadow length");
});


test("the compass convention gets ONE home: bearing -> vector -> bearing", () => {
  // main.js needs `Math.atan2(x, -z)` twice — once for the Set-north pick and
  // once for the terrain downhill fact. Every transcription is a chance to
  // mirror the yard, so the inverse ships beside the forward direction and
  // main.js can import it.
  const bearings = [0, 37, 90, 123.69, 180, 259.4, 359.9];
  assert.equal(bearings.length, 7);
  for (const az of bearings) {
    near(L.worldBearingOf(L.sunDirectionWorld(az, 30)), az, 1e-9, `round trip at ${az}`);
  }
  // pinned against a literal, not against the forward function: the fallback
  // sun at (30, 40, 20) bears 123.69007 deg by main.js's own formula
  near(L.worldBearingOf(new THREE.Vector3(30, 40, 20)), 123.69007, 1e-4, "legacy sun bearing");
  near(L.worldBearingOf(new THREE.Vector3(0, 9, -4)), 0, 1e-9, "straight north, ignoring height");
});

// ── 3. the frame test that only fails at a non-zero yaw ───────────────────
test("the sun holds its TRUE bearing at yaw 0 and at 23.3 deg — and the local aim differs", () => {
  const aim = { azimuth_deg: 200, altitude_deg: 35, northSet: true };

  const flat = rig({ yaw: 0 });
  const hf = L.initLighting(flat);
  L.setSunFromAzimuthAltitude(hf, aim);

  const turned = rig({ yaw: YAW, tx: 12, tz: -9 });
  const ht = L.initLighting(turned);
  L.setSunFromAzimuthAltitude(ht, aim);

  for (const [name, h] of [["yaw 0", hf], ["yaw 23.3 deg", ht]]) {
    const w = worldAim(h);
    nearBearing(w.azimuth_deg, 200, 1e-6, `${name}: world azimuth`);
    near(w.altitude_deg, 35, 1e-6, `${name}: world altitude`);
  }

  // The anti-vacuity half. If the module ignored geoGroup and just wrote a world
  // direction into a local position, both rigs would hold the SAME local aim and
  // the yawed one would be 23.3 deg wrong on screen. Inside geoGroup the stored
  // bearing must be the true bearing plus the yaw — sun.py's `true = stored -
  // degrees(yaw)`, read the other way round.
  nearBearing(localBearing(hf), 200, 1e-6, "yaw 0: local aim");
  nearBearing(localBearing(ht), 200 + YAW_DEG, 1e-6, "yaw 23.3: local aim");
  assert.ok(bearingGap(localBearing(hf), localBearing(ht)) > 20,
    "the two rigs hold the same LOCAL aim, so the module never looked at the yaw");
});


test("aiming works on a yaw set this instant, with no render in between", () => {
  // applyCalib() writes geoGroup.rotation and returns; matrixWorld is not
  // refreshed until the next frame. A module that read a stale matrixWorld would
  // be correct on the second call and wrong on the first — which is the kind of
  // bug that only shows up as a one-frame flicker, or never, until someone
  // screenshots for the critique.
  const r = rig({ yaw: 0 });
  const h = L.initLighting(r);
  r.geoGroup.rotation.y = YAW;                    // no updateMatrixWorld, no render
  L.setSunFromAzimuthAltitude(h, { azimuth_deg: 110, altitude_deg: 20, northSet: true });
  nearBearing(worldAim(h).azimuth_deg, 110, 1e-6, "world azimuth after a fresh yaw");
});


// ── 4. Set north must re-aim, and the drift it repairs must be real ───────
test("refresh() re-aims after Set north — and without it the sun really does drift", () => {
  const r = rig({ yaw: 0 });
  const h = L.initLighting(r);
  L.setSunFromAzimuthAltitude(h, { azimuth_deg: 200, altitude_deg: 35, northSet: true });
  const before = sunLocal(h);

  r.geoGroup.rotation.y = YAW;                    // Set north
  // Not refreshed yet: the sun is rigid with the yard, so it swung with it. This
  // assertion is what proves refresh() below is doing work rather than nothing.
  nearBearing(worldAim(h).azimuth_deg, 200 - YAW_DEG, 1e-6,
    "a sun inside geoGroup should swing with the yard until it is re-aimed");

  h.refresh();
  nearBearing(worldAim(h).azimuth_deg, 200, 1e-6, "world azimuth after refresh()");
  assert.ok(before.distanceTo(sunLocal(h)) > 1,
    "refresh() left the sun's local position untouched, so it cannot have re-aimed");
});


// ── 5. the north gate, mirroring tools/sun.py ─────────────────────────────
test("with north unset the compass bearing is REFUSED, and the altitude still honoured", () => {
  // tools/sun.py splits exactly here: sun position needs a latitude and a clock,
  // so altitude always answers; anything about the GROUND's orientation needs the
  // scan tied to true north, and until it is, `python3 tools/sun.py north`
  // returns {"refused": true, ...}. Applying a real solar azimuth to a scene
  // whose heading is unknown fails OPEN: an answer-shaped thing with nothing
  // behind it, and a shadow is very answer-shaped.
  const r = rig({ yaw: 0 });
  const h = L.initLighting(r);
  const st = L.setSunFromAzimuthAltitude(h, { azimuth_deg: 180, altitude_deg: 75.9, northSet: false });

  assert.equal(st.azimuth_trusted, false, "an azimuth was trusted with north unset");
  assert.match(st.reason ?? "", /north/i, "refusal carries no reason mentioning north");
  nearBearing(worldAim(h).azimuth_deg, L.UNTRUSTED_AZIMUTH_DEG, 1e-6,
    "north is unset, so the sun must sit at the documented arbitrary bearing, not at 180");
  assert.ok(bearingGap(worldAim(h).azimuth_deg, 180) > 45,
    "the supplied compass bearing was applied even though north is not set");
  near(worldAim(h).altitude_deg, 75.9, 1e-6,
    "altitude needs no bearing — sun.py always answers it, so it must be honoured");

  // and the other side of the gate
  const st2 = L.setSunFromAzimuthAltitude(h, { azimuth_deg: 180, altitude_deg: 75.9, northSet: true });
  assert.equal(st2.azimuth_trusted, true);
  nearBearing(worldAim(h).azimuth_deg, 180, 1e-6, "with north set the real bearing must be used");
});


test("a sun.py refusal object aims nothing, even if northSet is passed true", () => {
  // sun.py hands back {"refused": true, "quantity": ..., "north": {...}} with no
  // number in it. Reading `.azimuth_deg` off that gives undefined; the module
  // must notice rather than aim at NaN.
  const r = rig({ yaw: 0 });
  const h = L.initLighting(r);
  const st = L.setSunFromAzimuthAltitude(h,
    { refused: true, quantity: "any bearing-dependent quantity", northSet: true });
  assert.equal(st.azimuth_trusted, false, "a refusal was read back as an answer");
  const w = worldAim(h);
  assert.ok(Number.isFinite(w.azimuth_deg) && Number.isFinite(w.altitude_deg),
    `refusal aimed the sun at NaN: ${JSON.stringify(w)}`);
  nearBearing(w.azimuth_deg, L.UNTRUSTED_AZIMUTH_DEG, 1e-6, "azimuth after a refusal");
});


// ── 6. shadows are actually switched on ───────────────────────────────────
test("shadow mapping is enabled with the settings preview.html already proved here", () => {
  const r = rig();
  const h = L.initLighting(r, { radius: 30 });
  assert.equal(r.renderer.shadowMap.enabled, true, "shadowMap never enabled — nothing casts");
  assert.equal(r.renderer.shadowMap.type, THREE.PCFSoftShadowMap, "hard shadow edges");
  assert.equal(h.sun.castShadow, true, "the sun does not cast");
  assert.equal(h.sky.castShadow, false, "a hemisphere light cannot cast; asking for it is a stall");
  assert.equal(h.sun.shadow.mapSize.x, 2048);
  assert.equal(h.sun.shadow.mapSize.y, 2048);

  const c = h.sun.shadow.camera;
  assert.ok(c.right - c.left >= 60, `shadow camera only ${c.right - c.left} m across, yard is 60 m`);
  assert.ok(c.top - c.bottom >= 60, `shadow camera only ${c.top - c.bottom} m deep`);
  // the light must sit between near and far or the whole yard clips out
  assert.ok(c.near > 0 && c.near < h.distance && h.distance < c.far,
    `light at ${h.distance} m is outside the shadow camera's ${c.near}..${c.far} range`);
  // acne on a 13 deg slope is what normalBias is for; 0 would stripe the yard
  assert.ok(h.sun.shadow.normalBias > 0, "no normalBias — expect shadow acne on the slope");
});


// ── 7. the capture, and not double-lighting it ────────────────────────────
test("the capture is taken off the analytic sun, keeping its texture and its brightness", () => {
  const r = rig();
  const h = L.initLighting(r);
  const cap = fakeCapture(2);
  const maps = cap.children.filter(o => o.isMesh).map(o => o.material.map);

  const n = L.makeCaptureUnlit(cap, h);
  assert.equal(n, 2, `expected 2 materials converted, got ${n}`);   // COUNT first

  const meshes = cap.children.filter(o => o.isMesh);
  assert.equal(meshes.length, 2);
  meshes.forEach((m, i) => {
    assert.equal(m.material.isMeshBasicMaterial, true,
      "still a lit material: the analytic sun will shade albedo that is already shaded");
    assert.equal(m.material.map, maps[i], "the albedo texture was dropped on the way through");
    assert.equal(m.receiveShadow, false,
      "an unlit material cannot receive a shadow map; claiming it can hides the need for a catcher");
    assert.equal(m.castShadow, false,
      "the house's own shadow is already baked into the albedo — casting a second one doubles it");
  });

  // Brightness must not change ACROSS THIS CALL: an unlit material left at
  // colour 1.0 would render the capture 1/gain brighter than the lit path does.
  //
  // The gain is derived from the irradiance TARGETS rather than from the light
  // intensities, so this still fails if someone re-tunes SUN_INTENSITY without
  // saying what irradiance they meant. A sun at 2.0 and a sky at 1.0 give a
  // gain of 0.6637, and those two intensities render the whole viewer two
  // stops down.
  //
  // NOTE this is not the path the viewer takes. `makeCaptureUnlit(stage,
  // handle)` preserves whatever the analytic lights happened to be giving the
  // capture; `showCaptureAsPhotograph` — tested in light_quality.test.mjs — puts
  // the photograph on screen at the values it was photographed at, which is the
  // only one of the two that is a claim about the real world. This variant is
  // kept because "preserve the brightness of the path you are replacing" is the
  // right move for any OTHER lit surface being taken off the sun.
  const gain = L.capturedLightGain(h);
  near(gain, (L.DIRECT_IRRADIANCE + L.AMBIENT_IRRADIANCE) / Math.PI, 5e-4,
    "captured-light gain drifted from the irradiance the lights are declared to deliver");
  const c = meshes[0].material.color;
  near(c.r, gain, 1e-6, "unlit capture colour does not carry the gain");
  near(c.g, gain, 1e-6, "unlit capture colour is not neutral");
  near(c.b, gain, 1e-6, "unlit capture colour is not neutral");

  // and it has to be idempotent. stageReady() and refreshGroundTruth() both run
  // more than once per capture, and a second pass that re-multiplied the gain
  // would drop the scan to 0.44x — a slow browning nobody would trace back here.
  assert.equal(L.makeCaptureUnlit(cap, h), 0, "a second pass converted already-unlit materials");
  near(meshes[0].material.color.r, gain, 1e-6, "a second pass squared the gain");
});


test("the gain tracks the lights, so re-tuning the sun cannot silently rebrighten the capture", () => {
  const mk = i => {
    const r = rig();
    const h = L.initLighting(r);
    h.sun.intensity = i;
    L.setSunFromAzimuthAltitude(h, { azimuth_deg: 0, altitude_deg: 47.969, northSet: false });
    return L.capturedLightGain(h);
  };
  const [g0, g2, g4] = [mk(0), mk(2), mk(4)];
  assert.ok(g0 < g2 && g2 < g4, `gain is not monotone in sun intensity: ${g0}, ${g2}, ${g4}`);
  // the sun term is linear in intensity; the sky term is the constant left at g0
  near(g4 - g2, g2 - g0, 1e-9, "the sun's contribution to the gain is not linear in its intensity");
  // With no GPU there is no environment map, so the hemisphere light carries the
  // WHOLE ambient budget — which is the fallback initLighting is built around.
  near(g0, L.AMBIENT_IRRADIANCE / Math.PI, 1e-4,
    "with the sun off, the gain must be the hemisphere alone");
});


// ── 8. design objects ─────────────────────────────────────────────────────
test("enableShadows flags every mesh under a design group, and says how many", () => {
  const g = new THREE.Group();
  for (let i = 0; i < 3; i++) g.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial()));
  g.add(new THREE.Object3D());
  const sprite = new THREE.Sprite();
  g.add(sprite);                                  // labels must not cast

  const n = L.enableShadows(g);
  assert.equal(n, 3, `expected 3 meshes flagged, got ${n}`);
  const meshes = g.children.filter(o => o.isMesh);
  assert.equal(meshes.length, 3);
  for (const m of meshes) {
    assert.equal(m.castShadow, true);
    assert.equal(m.receiveShadow, true);
  }
  assert.equal(sprite.castShadow, false, "a text label was made to cast a shadow");
});


// ── 9. the shadow catcher: the ONLY thing that adds the new shadow ────────
test("the shadow catcher draws nothing but the shadow, and follows the real ground", () => {
  // This is what makes shadows possible over the primary stage at all. The splat
  // (SplatMesh) and the point-cloud fallback both render through unlit materials
  // and cannot receive a shadow map; the mesh capture is deliberately unlit here
  // for the same reason. A ShadowMaterial surface draped on the height field
  // contributes zero everywhere except where something new occludes the sun, so
  // what lands on the capture is the DELTA and nothing else.
  const heightAt = (x, z) => 0.3 * x - 0.2 * z + 5;
  const c = L.makeShadowCatcher({ heightAt, size: 8, cell: 2 });

  assert.equal(c.material.type, "ShadowMaterial",
    `catcher uses ${c.material.type}; anything else paints its own colour over the capture`);
  assert.equal(c.receiveShadow, true, "the catcher does not receive — it will show nothing");
  assert.equal(c.castShadow, false, "the catcher casting would shadow the yard with itself");

  const pos = c.geometry.attributes.position;
  assert.equal(pos.count, 25, `expected a 5x5 grid of vertices for size 8 / cell 2, got ${pos.count}`);

  // it must lie in the XZ plane, not stand up like a raw PlaneGeometry
  const span = a => Math.max(...a) - Math.min(...a);
  const xs = [], ys = [], zs = [];
  for (let i = 0; i < pos.count; i++) { xs.push(pos.getX(i)); ys.push(pos.getY(i)); zs.push(pos.getZ(i)); }
  near(span(xs), 8, 1e-6, "catcher width");
  near(span(zs), 8, 1e-6, "catcher depth");

  // and it must be DRAPED, not flat: count the displaced vertices before
  // trusting any per-vertex comparison. A flat plane satisfies "every y equals
  // heightAt + lift" vacuously when heightAt is 0.
  const lift = c.userData.lift_m;
  assert.ok(lift > 0, "the catcher sits exactly on the scan and will z-fight");
  let displaced = 0;
  for (let i = 0; i < pos.count; i++) {
    const want = heightAt(pos.getX(i), pos.getZ(i)) + lift;
    near(pos.getY(i), want, 1e-6, `vertex ${i} is not on the ground`);
    if (Math.abs(pos.getY(i) - lift) > 1e-6) displaced++;
  }
  assert.equal(displaced, 25, `only ${displaced} of 25 vertices were draped onto the height field`);
  assert.ok(span(ys) > 1, `catcher is flat (y spans ${span(ys)} m) — it never read the ground`);
});
