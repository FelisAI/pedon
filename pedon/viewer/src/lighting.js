// Sun, sky and shadows — lighting that makes the site look real.
//
// Contact shadows ground trees and walls visually. Flagging meshes alone is
// insufficient: the renderer's shadow map and the light's shadow pass must also
// be enabled.
//
// Two constraints govern the lighting.
//
// 1. THE CAPTURE IS ALREADY LIT, so the analytic sun must not light it again.
//    A measured Scaniverse capture carries exactly one material
//    — {"name":"main","pbrMetallicRoughness":{"baseColorTexture":{"index":0},
//    "metallicFactor":0.0}} — which GLTFLoader turns into a MeshStandardMaterial.
//    That texture is photogrammetry albedo: the captured sun, sky and the house's
//    own shadow are already in the pixels. Aiming a second sun at
//    it shades it twice, and at a different bearing the two disagree visibly. The
//    splat and point-cloud stages have the opposite problem: they render through
//    their own unlit shaders, so they can neither be lit nor RECEIVE a shadow map.
//
//    So the capture is taken off the analytic sun entirely (makeCaptureUnlit) and
//    the new shadows arrive on a separate ShadowMaterial surface draped on the
//    height field (makeShadowCatcher), which contributes exactly zero everywhere
//    it is not shadowed. What lands on the capture is the DELTA — the shadow of
//    things that were not there on capture day — and nothing else. That is the
//    only honest composite available: the baked shadows cannot be removed, so the
//    scan stays a photograph of its own afternoon and the design is lit on top.
//
//    Brightness is preserved rather than re-guessed. With the reference lights,
//        albedo/PI * (2.0*sin(47.969 deg)*lum(0xfff2dd) + lum(0xcfe6d8)) = albedo * 0.6637
//    is the on-screen value; capturedLightGain() recomputes it from live lights,
//    so a later intensity change cannot silently rebrighten the scan by 1.5x.
//
// 2. A SUN IS A BEARING, so it lives in the calibrated frame. World and ENU are
//    identical at yaw 0, so frame errors are invisible until north is set.
//    geoGroup carries the yaw; a light hanging off the scene keeps pointing in
//    the same direction while the site turns, for example by 23.3 deg.
//    So `sun` and `sun.target` are geoGroup children, with positions derived by
//    pushing a world direction back through geoGroup's live matrix. Never copy
//    the yaw trigonometry by hand: a sign error can mirror the site.
//
//    The hemisphere light is the opposite case and it is NOT symmetric: three
//    reads a HemisphereLight's axis off its WORLD POSITION, so under a geoGroup
//    carrying tx/tz the default (0,1,0) would land at (tx,1,tz) and the sky would
//    come in sideways. Sky has no compass bearing. It stays in the scene.
//
// The north gate is tools/sun.py's, not a second one. That file answers altitude
// from a latitude and a clock and REFUSES every bearing-dependent quantity while
// the scan's heading is unknown, because an unknown must not look like a pass.
// A shadow can look like a verified bearing, so
// setSunFromAzimuthAltitude honours the altitude and refuses the azimuth under
// exactly the same condition, falling back to the viewer's arbitrary bearing
// and saying so in `azimuth_trusted`.
import * as THREE from "three";
import { applyCarve } from "./carve.js";

// Colours are main.js's. The INTENSITIES follow irradiance targets: 1.337 of
// direct irradiance against 0.748 of ambient on a horizontal surface is 1.79:1,
// which resembles bright overcast. Their sum divided by PI is 0.6637, so a white
// surface in full sun renders at two thirds of its own albedo. Measured frames
// with that balance top out near 150/255.
//
// So the two numbers below are derived from irradiance targets rather than
// picked, and `daylightBalance()` reports what they actually produce.
export const SUN_COLOR = 0xfff2dd;
export const SKY_COLOR = 0xcfe6d8;
export const GROUND_COLOR = 0x2a2420;

// Clear sky, sun at 48 deg: about 900 W/m2 of beam (669 on the horizontal) against
// 110 of diffuse. Scaled so the total lands at PI — see SUNLIT_GAIN below — that is
// 2.85 direct and 0.72 ambient, a ratio of 3.96:1. Kept a little softer than the
// real 6:1 because this garden is judged from eye level in its own shade and a
// physically clear sky puts foliage under a shrub at single-digit sRGB.
export const DIRECT_IRRADIANCE = 2.85;
export const AMBIENT_IRRADIANCE = 0.72;
// Of the ambient, the share the sky ENVIRONMENT carries when the GPU can build
// one; the hemisphere light carries the rest, and all of it when it cannot. This
// is the part that gives ambient a direction — a hemisphere light alone lights the
// underside of a leaf as hard as the top, which is the flat look this exists to end.
export const ENV_IRRADIANCE = 0.50;

// Rec.709 luminance of a colour already in the linear working space. THREE.Color
// converts an sRGB hex on construction (ColorManagement is on by default in
// r155+), so .r/.g/.b here are linear and directly comparable to a light's
// irradiance in the shader.
const luminance = c => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

const SUN_LUM = luminance(new THREE.Color(SUN_COLOR));
const SKY_LUM = luminance(new THREE.Color(SKY_COLOR));

// A DirectionalLight's contribution is intensity * colour * N.L, so the intensity
// that delivers DIRECT_IRRADIANCE depends on where the sun is. Defined at the
// altitude the viewer falls back to when north is unset; a real altitude from
// sun.py then scales it by sin(alt) on its own, which is what should happen.
export const SUN_INTENSITY = DIRECT_IRRADIANCE / (Math.sin(THREE.MathUtils.degToRad(47.969)) * SUN_LUM);
// The FALLBACK ambient: the whole budget, for the case where no environment could
// be built. initLighting drops it to the remainder once the sky map is installed.
export const SKY_INTENSITY = AMBIENT_IRRADIANCE / SKY_LUM;

// Tone mapping and exposure belong with the lighting. Tuning the sun separately
// from its response curve can clip the site to white without this module being
// able to account for it.
export const TONE_MAPPING = THREE.NeutralToneMapping;
// Chosen so (direct + ambient)/PI * exposure is about 1: a surface facing the sky
// in full sun renders at its own albedo, which is the definition of a correctly
// exposed photograph. The scan's own texture is exactly such a photograph, so
// this is also what makes the design and the plate sit in one tonal range.
export const EXPOSURE = 1.0;
export const SUNLIT_GAIN = ((DIRECT_IRRADIANCE + AMBIENT_IRRADIANCE) / Math.PI) * EXPOSURE;

// The viewer's default direction, read back as a compass bearing so the trusted
// and untrusted states are the same kind of number. It is arbitrary, not a
// measurement, so it makes no claim about the heading when north is unset.
const LEGACY_SUN = new THREE.Vector3(30, 40, 20).normalize();
export const UNTRUSTED_AZIMUTH_DEG =
  (THREE.MathUtils.radToDeg(Math.atan2(LEGACY_SUN.x, -LEGACY_SUN.z)) + 360) % 360;   // 123.690
export const UNTRUSTED_ALTITUDE_DEG =
  THREE.MathUtils.radToDeg(Math.asin(LEGACY_SUN.y));                                 // 47.969

const NO_NORTH =
  "north is not set on this capture, so the scan's heading is unknown and a " +
  "compass bearing would be a guess (tools/sun.py north refuses for the same " +
  "reason). Altitude is honoured — it needs only a latitude and a clock. Set " +
  "north in the viewer to make the shadow direction mean something.";
const REFUSED =
  "tools/sun.py refused this query, so it carries no bearing to aim at.";

const DEFAULTS = {
  radius: 30,          // half-width of the shadowed area; main.js's grid is 60 m
  distance: null,      // how far out the light sits; defaults to 2.5 * radius
  mapSize: 2048,       // 2048 over 60 m is 2.9 cm a texel — enough for a leaf edge
  normalBias: 0.03,    // 3 cm. Without it a 13 deg slope stripes with acne
  bias: -0.0005,
};

/** Unit vector pointing from the ground TOWARDS the sun, in WORLD space.
 *
 * Consumes tools/sun.py's convention verbatim: azimuth is a compass bearing of
 * the SKY (0 = north, 90 = east, clockwise) and altitude is degrees above the
 * horizon. The viewer's world frame is x = east, y = up, z = -north — the same
 * mapping design.js enuToWorld uses, so this is the one place it is written.
 */
export function sunDirectionWorld(azimuth_deg, altitude_deg) {
  const a = THREE.MathUtils.degToRad(azimuth_deg);
  const e = THREE.MathUtils.degToRad(altitude_deg);
  return new THREE.Vector3(Math.cos(e) * Math.sin(a), Math.sin(e), -Math.cos(e) * Math.cos(a));
}

/** The inverse: the compass bearing a WORLD vector points along, 0-360, height
 * ignored. The Set-north pick and terrain downhill fact use `Math.atan2(x, -z)`.
 * Keeping the convention here lets callers share it and avoids sign errors
 * that can mirror a bearing.
 */
export function worldBearingOf(v) {
  return (THREE.MathUtils.radToDeg(Math.atan2(v.x, -v.z)) + 360) % 360;
}

// ── the sky ───────────────────────────────────────────────────────────────
//
// A null scene.environment and dark scene.background leave a black void above
// the site and all indirect light to one HemisphereLight. A hemisphere light
// has no direction beyond up/down: the underside of a leaf gets the same fill
// as the top of it, flattening the site's appearance.
//
// The sky is built here rather than downloaded — the standing constraint is no
// keys and no fetched assets — and it is built in LINEAR radiance so its
// irradiance can be integrated rather than guessed. `skyIrradiance` does that
// integration over the same texels the texture is made of, which is what lets
// `daylightBalance` report a true total whether or not a GPU was available.

const SKY_ZENITH = 0x4d7fc4;      // deep blue overhead
const SKY_HORIZON = 0xdfe9ee;     // haze, always paler and brighter than the zenith
const SKY_GROUND = 0x6b6355;      // what bounces back up off dry ground and paving

/**
 * Which world direction texel (i, j) of an equirect map stands for.
 *
 * This is the inverse of three's own `equirectUv`, which every equirect sampler
 * in the renderer goes through:
 *
 *     u = atan(dir.z, dir.x) / 2PI + 0.5
 *     v = asin(dir.y) / PI + 0.5
 *
 * and a DataTexture is flipY:false, so data row 0 is v = 0 — the NADIR, not the
 * zenith. Uploading a top-down map without reversing its rows puts the ground
 * overhead and the sky underfoot, producing a dark ceiling and a pale floor.
 * The mapping is written ONCE here and the builder, the irradiance integral
 * and the test all go through it; skyTexture adapts the rows for upload.
 */
export function skyDirection(sky, i, j, out = new THREE.Vector3()) {
  // theta measured from +Y, so ROW 0 IS THE ZENITH — the standard equirect
  // convention, and the one skyIrradiance and the tests both assume.
  //
  // `sin((v - 0.5) * PI)` puts row 0 at the NADIR, opposite to `cos(theta)`
  // measured from the top. Mixing them puts ground brown at the zenith and blue
  // underfoot, and measures more light under a leaf than above it. There is ONE
  // mapping; skyIrradiance calls it so the writer and reader agree on row order.
  const u = (i + 0.5) / sky.width;
  const theta = ((j + 0.5) / sky.height) * Math.PI;
  const phi = u * 2 * Math.PI;
  const r = Math.sin(theta);
  return out.set(r * Math.sin(phi), Math.cos(theta), -r * Math.cos(phi));
}

/** The solid angle texel row j subtends — sin(theta) d(theta) d(phi). */
function skyTexelSolidAngle(sky, j) {
  const theta = ((j + 0.5) / sky.height) * Math.PI;   // from +Y, as skyDirection
  return Math.sin(theta) * (Math.PI / sky.height) * ((2 * Math.PI) / sky.width);
}

/**
 * An equirectangular sky as LINEAR radiance, RGBA, laid out the way three reads
 * one (see skyDirection).
 *
 * Radiances are absolute, in the same units as a light's irradiance, not
 * normalised: a clear zenith is dimmer than a sunlit paving slab and the horizon
 * is brighter than both, and that ordering is the whole reason a sky map gives
 * objects form where a hemisphere light cannot.
 */
export function skyEquirect({ width = 256, height = 128, sunDir = null,
                              zenith = SKY_ZENITH, horizon = SKY_HORIZON,
                              ground = SKY_GROUND,
                              zenithRadiance = 0.115, horizonRadiance = 0.42,
                              groundRadiance = 0.055, sunGlow = 1.8 } = {}) {
  const cz = new THREE.Color(zenith), ch = new THREE.Color(horizon), cg = new THREE.Color(ground);
  const nz = cz.clone().multiplyScalar(zenithRadiance / Math.max(1e-6, luminance(cz)));
  const nh = ch.clone().multiplyScalar(horizonRadiance / Math.max(1e-6, luminance(ch)));
  const ng = cg.clone().multiplyScalar(groundRadiance / Math.max(1e-6, luminance(cg)));
  const sd = sunDir ? sunDir.clone().normalize() : null;
  const sc = new THREE.Color(SUN_COLOR);

  const sky = { width, height, data: new Float32Array(width * height * 4) };
  const col = new THREE.Color();
  const d = new THREE.Vector3();
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      skyDirection(sky, i, j, d);
      if (d.y >= 0) {
        // brighter towards the horizon, and the falloff is steep near it —
        // pow(y, 0.45) is a plain haze curve, not a Preetham fit
        col.copy(nh).lerp(nz, Math.pow(d.y, 0.45));
        if (sd) {
          const c = Math.max(0, d.dot(sd));
          // a broad halo plus a soft disc: the halo is what actually tilts the
          // ambient towards the sun, which is the directional half of "form"
          const glow = sunGlow * (0.35 * Math.pow(c, 4) + Math.pow(c, 220));
          col.r += sc.r * glow; col.g += sc.g * glow; col.b += sc.b * glow;
        }
      } else {
        col.copy(ng).lerp(nh, Math.pow(Math.max(0, 1 + d.y * 6), 3) * 0.35);
      }
      const k = (j * width + i) * 4;
      sky.data[k] = col.r; sky.data[k + 1] = col.g; sky.data[k + 2] = col.b; sky.data[k + 3] = 1;
    }
  }
  return sky;
}

/**
 * Irradiance a surface with this normal receives from that sky, integrated over
 * the texels — the cosine-weighted sum, with each texel's solid angle.
 *
 * MEASURED, not assumed. It is the number `daylightBalance` needs to say what
 * the ambient really is once part of it is carried by an environment map rather
 * than a hemisphere light, and it is what the hemisphere light's remaining share is
 * computed from, so the two can never double-count.
 */
export function skyIrradiance(sky, normal) {
  const n = normal.clone().normalize();
  const { width, height, data } = sky;
  const dir = new THREE.Vector3();
  let sum = 0;
  for (let j = 0; j < height; j++) {
    const dOmega = skyTexelSolidAngle(sky, j);
    for (let i = 0; i < width; i++) {
      // THE SAME mapping the sky is written with. Re-deriving it here risks
      // putting the zenith and the nadir on each other's rows.
      const d = skyDirection(sky, i, j, dir).dot(n);
      if (d <= 0) continue;
      const k = (j * width + i) * 4;
      sum += (0.2126 * data[k] + 0.7152 * data[k + 1] + 0.0722 * data[k + 2]) * d * dOmega;
    }
  }
  return sum;
}

/** The sky as a texture three can use for background and environment. */
export function skyTexture(sky) {
  // HalfFloat, not Float: linear filtering of a FLOAT texture needs
  // OES_texture_float_linear, and a sky that cannot be filtered is 256 visible
  // bands across the horizon.
  // ROWS REVERSED on upload. skyDirection is this file's one mapping and puts the
  // ZENITH AT ROW 0; three.js samples an equirect with v = asin(y)/PI + 0.5, and a
  // DataTexture does not flipY, so it expects the zenith at the LAST row. Uploading
  // in our own order therefore renders the sky upside down, with a near-black
  // zenith over a pale horizon.
  //
  // Reversed HERE rather than by changing skyDirection: the irradiance integral,
  // the sun glow and the tests all share that mapping. Keeping the texture upload
  // convention separate keeps the writer and reader in agreement: one mapping,
  // one place that adapts it to three.js.
  const half = new Uint16Array(sky.data.length);
  const row = sky.width * 4;
  for (let j = 0; j < sky.height; j++) {
    const src = (sky.height - 1 - j) * row;
    for (let i = 0; i < row; i++) half[j * row + i] = THREE.DataUtils.toHalfFloat(sky.data[src + i]);
  }
  const t = new THREE.DataTexture(half, sky.width, sky.height, THREE.RGBAFormat, THREE.HalfFloatType);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.LinearSRGBColorSpace;   // the data IS radiance already
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = THREE.RepeatWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}


// ── shadows on things that arrive after the lights ────────────────────────
//
// shadowMap.enabled and sun.castShadow alone cannot produce shadows: every
// participating mesh also needs castShadow and receiveShadow. Otherwise the
// renderer draws an empty shadow map every frame.
//
// EVERY mesh in this viewer — the capture, plants, walls and boulders — is built
// after initLighting runs, and something has to flag them. Rather than ask each
// module to remember, the lighting arms the scene itself, on the hook
// three calls immediately before it renders the shadow map. A WeakSet means each
// object is touched once; a measured full traverse of a scene with 773 objects
// is 38 us, which is 0.2% of a 60 fps frame.
const ARMED = new WeakSet();

/**
 * Flag every mesh in the scene to cast and receive, EXCEPT the photogrammetry
 * capture — which is taken off the analytic sun and given a surface that can
 * catch a shadow instead. Returns how many meshes were newly handled.
 *
 * `captureGroup` is the name of the group the capture hangs under; main.js's
 * scene graph is geoGroup("geo") > levelGroup("level") > the scan, and that
 * name is the one durable way to tell the photograph from the design.
 */
export function armSceneShadows(root, { captureGroup = "level" } = {}) {
  let n = 0;
  (function walk(o, inCapture) {
    const here = inCapture || o.name === captureGroup;
    // isMesh only: Points is the point-cloud stage and Sprite is a text label,
    // and both render as camera-facing quads whose shadow is a rectangle.
    if (o.isMesh && !ARMED.has(o)) {
      ARMED.add(o);
      n++;
      if (here) {
        showCaptureAsPhotograph(o);
        o.castShadow = false;         // the house's own shadow is in its texture
        o.receiveShadow = false;      // a MeshBasicMaterial cannot receive one anyway
        makeCaptureShadowCatcher(o);
        // cut where the design is built flat — the photograph AND the shadow
        // it catches, or a shadow would hang in the air over a terrace
        for (const m of [].concat(o.material)) applyCarve(m);
        for (const ch of o.children) if (ch.userData?.shadowCatcher) applyCarve(ch.material);
      } else {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    }
    // snapshot: makeCaptureShadowCatcher adds a child, and mutating the array
    // being iterated is how a for..of quietly skips the next sibling
    for (const ch of [...o.children]) walk(ch, here);
  })(root, false);
  return n;
}

/**
 * Set up shadow-casting sun + sky against an existing scene.
 *
 * cfg: { renderer, scene, geoGroup, sun?, sky? } — an existing DirectionalLight
 * or HemisphereLight is ADOPTED rather than duplicated, so main.js can hand over
 * the lights it already made. opts merges over cfg (radius, distance, mapSize…).
 *
 * Returns a handle: { sun, sky, target, state, radius, distance, focus,
 * refresh(), setFocus(x,y,z), dispose() }.
 */
export function initLighting(cfg = {}, opts = {}) {
  const c = { ...DEFAULTS, ...cfg, ...opts };
  const { renderer, scene, geoGroup } = c;
  if (!scene) throw new Error("initLighting needs the scene the lights go into");
  if (!geoGroup) {
    // Fail closed. Defaulting to the scene would render perfectly at yaw 0 and be
    // wrong by the calibrated yaw (e.g. 23.3 deg) the moment north is set.
    throw new Error("initLighting needs geoGroup: the sun carries a compass " +
                    "bearing and must live in the frame that carries the yaw");
  }
  const radius = c.radius;
  const distance = c.distance ?? 2.5 * radius;

  if (renderer?.shadowMap) {
    renderer.shadowMap.enabled = true;
    // PCFSoft is what viewer/preview.html already uses on this library's plants;
    // plain PCF hard-edges every leaf and reads as cardboard.
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }
  if (renderer) {
    // The response curve belongs with the light that feeds it, so the exposure
    // and the intensities that reach it stay together.
    renderer.toneMapping = c.toneMapping ?? TONE_MAPPING;
    renderer.toneMappingExposure = c.exposure ?? EXPOSURE;
  }

  const sky = c.sky ?? new THREE.HemisphereLight(SKY_COLOR, GROUND_COLOR, SKY_INTENSITY);
  sky.name = sky.name || "sky";
  sky.position.set(0, 1, 0);            // the axis three reads off the world position
  if (sky.parent !== scene) scene.add(sky);

  const sun = c.sun ?? new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
  sun.name = sun.name || "sun";
  sun.castShadow = true;
  sun.shadow.mapSize.set(c.mapSize, c.mapSize);
  sun.shadow.normalBias = c.normalBias;
  sun.shadow.bias = c.bias;
  const cam = sun.shadow.camera;
  cam.left = -radius; cam.right = radius;
  cam.top = radius; cam.bottom = -radius;
  // The light sits `distance` out along its own direction; +-2*radius each side of
  // it brackets everything the ortho box can see, including a 7 m oak at the far
  // corner. Kept off 0 because a near plane at 0 wastes the whole depth range.
  cam.near = Math.max(0.5, distance - 2 * radius);
  cam.far = distance + 2 * radius;
  cam.updateProjectionMatrix();

  // BOTH the light and its target: a directional light's direction is
  // position - target, so leaving the target in the scene while the light rides
  // geoGroup would re-introduce the yaw error through the back door.
  geoGroup.add(sun);
  geoGroup.add(sun.target);

  const prevOnBefore = scene.onBeforeRender;
  const h = {
    sun, sky, target: sun.target, geoGroup, scene, renderer, radius, distance,
    focus: new THREE.Vector3(0, 0, 0),
    exposure: renderer?.toneMappingExposure ?? EXPOSURE,
    env: null,                          // the PMREM'd sky, once there is a GPU to build it
    envIrradianceUp: 0,                 // and the irradiance it delivers, measured
    state: { azimuth_deg: UNTRUSTED_AZIMUTH_DEG, altitude_deg: UNTRUSTED_ALTITUDE_DEG,
             azimuth_trusted: false, reason: NO_NORTH },
    refresh: () => applyAim(h),
    setFocus(x, y, z) { h.focus.set(x, y, z); applyAim(h); return h; },
    /**
     * Point the shadow camera AT THE GARDEN and shrink it to fit.
     *
     * With the default 60 m box, a measured shadow map costs 10 ms a frame and
     * changes no pixels in an eye-level shot with 977 meshes. 2048 texels over
     * 60 m is 2.9 cm each, and the normal bias that keeps a 13° slope
     * from striping with acne is 3 cm — so the sample point is pushed clean
     * through a 2 cm leaf and a 3 mm grass blade, preventing their shadows.
     *
     * The box spans the whole 60 m site; a design usually covers a fraction of
     * it, 9 by 29 m, say. Fitting the box to
     * the planting takes a texel from 2.9 cm to under a centimetre, and the
     * bias down with it, at no extra cost — the same 2048 map over less ground.
     *
     * `pad` keeps a shadow that falls OUT of the planted area (a low sun throws
     * a 3 m shadow off a 1.5 m shrub) inside the box that can draw it.
     */
    fitTo(box, { pad = 6, min = 8, max = 60 } = {}) {
      if (!box || box.isEmpty?.()) return h;
      const c = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const r = Math.min(max, Math.max(min, Math.max(size.x, size.z) / 2 + pad));
      h.radius = r;
      h.distance = 2.5 * r;
      const cam = sun.shadow.camera;
      cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
      cam.near = Math.max(0.5, h.distance - 2 * r);
      cam.far = h.distance + 2 * r;
      cam.updateProjectionMatrix();
      // ONE TEXEL, which is what a normal bias is for: it offsets the lookup by
      // the distance a sloped surface can drift within a single depth sample.
      // At 2.2 texels, the bias can still be 4.5 cm on a fitted box, larger than
      // the default 3 cm. The bias must be priced in texels and then converted,
      // never chosen as a length.
      //
      // The honest consequence, measured: 2048 texels over a 41 m box is 2 cm
      // each, so a 2 cm leaf is one texel and CANNOT cast a resolvable shadow at
      // site scale. This supports body-scale shadows — boulders, the lantern,
      // benches, the moon gate, a shrub mass, a tree canopy — for viewing how
      // the site looks at different times of day.
      sun.shadow.normalBias = Math.max(0.004, (2 * r / sun.shadow.mapSize.x) * 1.0);
      sun.shadow.needsUpdate = true;
      // the focus is in the light's PARENT frame (geoGroup), which is the frame
      // the box was measured in when it came from enuGroup's own subtree
      h.focus.set(c.x, c.y, c.z);
      applyAim(h);
      return h;
    },
    rebuildSky: () => installSky(h, c),
    dispose() {
      scene.onBeforeRender = prevOnBefore;
      sun.parent?.remove(sun);
      sun.target.parent?.remove(sun.target);
      sky.parent?.remove(sky);
      sun.dispose?.();
      h.env?.dispose?.();
      h.skyTex?.dispose?.();
      if (scene.environment === h.env) scene.environment = null;
    },
  };
  applyAim(h);                          // start exactly where the viewer already was
  installSky(h, c);

  // Three calls scene.onBeforeRender immediately BEFORE shadowMap.render (r185
  // three.module.js:17644 and :17702), so a mesh armed here casts on the very
  // frame it was added rather than one frame later. Chained, not replaced: a
  // debug hook someone else hangs here must survive.
  scene.onBeforeRender = function (...args) {
    armSceneShadows(scene, { captureGroup: c.captureGroup ?? "level" });
    prevOnBefore?.apply(this, args);
  };
  armSceneShadows(scene, { captureGroup: c.captureGroup ?? "level" });
  return h;
}

/**
 * Build the sky, hang it behind the garden and use it as the environment.
 *
 * Guarded on the renderer being a real one: node has no WebGL and never will,
 * and PMREMGenerator throws without a context — which would take initLighting
 * down and with it frame_check, float_check and every test in this directory.
 * The handle then says `env: null` rather than pretending, and the hemisphere
 * light keeps the WHOLE ambient budget so the balance is unchanged.
 */
function installSky(h, c = {}) {
  const { renderer, scene } = h;
  if (c.sky === false) return h;
  // Checked BEFORE the sky is built, not after: skyEquirect + skyIrradiance is a
  // 32k-texel double loop, and running it in node on every initLighting only to
  // throw the answer away adds a measured 6 ms per test.
  const canGpu = !!(renderer && renderer.capabilities && typeof renderer.setRenderTarget === "function");
  if (!canGpu) {
    h.env = null;
    h.envIrradianceUp = 0;
    h.sky.intensity = AMBIENT_IRRADIANCE / SKY_LUM;
    return h;
  }
  // the world direction the sun is ACTUALLY pointing from, read off the matrices
  // rather than off h.state — a yaw change without a refresh() moves one and not
  // the other, and the glow must sit where the shadows come from
  h.sun.updateWorldMatrix(true, false);
  h.target.updateWorldMatrix(true, false);
  const dir = new THREE.Vector3().setFromMatrixPosition(h.sun.matrixWorld)
    .sub(new THREE.Vector3().setFromMatrixPosition(h.target.matrixWorld)).normalize();

  const sky = skyEquirect({ sunDir: dir });
  const up = skyIrradiance(sky, new THREE.Vector3(0, 1, 0));
  // Scale the whole map so it delivers exactly the share of the ambient budget
  // it is meant to. Everything downstream — the hemisphere light's remainder,
  // daylightBalance, the exposure — is then one arithmetic chain rather than
  // three numbers tuned by eye against each other.
  const k = up > 0 ? ENV_IRRADIANCE / up : 0;
  for (let i = 0; i < sky.data.length; i++) if (i % 4 !== 3) sky.data[i] *= k;
  h.skyTex?.dispose?.();
  h.env?.dispose?.();
  const tex = skyTexture(sky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromEquirectangular(tex);
  pmrem.dispose();
  h.skyTex = tex;
  h.env = rt.texture;
  h.envIrradianceUp = ENV_IRRADIANCE;
  scene.background = tex;
  scene.environment = rt.texture;
  scene.environmentIntensity = 1;
  scene.backgroundIntensity = 1;
  // whatever the environment now delivers, the hemisphere light carries the rest
  h.sky.intensity = Math.max(0, (AMBIENT_IRRADIANCE - ENV_IRRADIANCE)) / SKY_LUM;
  return h;
}

/**
 * Aim the sun from a compass bearing and an altitude — sun.py's own JSON keys, so
 * `setSunFromAzimuthAltitude(h, { ...JSON.parse(sunPy), northSet })` works.
 *
 * The gate is sun.py's: with north unset (or a refusal object handed straight
 * through) the AZIMUTH is refused and the viewer's arbitrary
 * bearing is used instead, while the ALTITUDE — which needs only a latitude and
 * a clock — is honoured. The returned snapshot says which happened; a caller
 * that draws a sun dial or writes a critique must read `azimuth_trusted` before
 * describing a shadow as pointing anywhere in particular.
 */
export function setSunFromAzimuthAltitude(handle, input = {}) {
  const az = Number(input.azimuth_deg);
  const alt = Number(input.altitude_deg);
  const refused = input.refused === true;
  const trusted = input.northSet === true && !refused && Number.isFinite(az);

  handle.state.altitude_deg = Number.isFinite(alt) ? alt : UNTRUSTED_ALTITUDE_DEG;
  handle.state.azimuth_deg = trusted ? ((az % 360) + 360) % 360 : UNTRUSTED_AZIMUTH_DEG;
  handle.state.azimuth_trusted = trusted;
  handle.state.reason = trusted ? null : (refused ? REFUSED : NO_NORTH);
  applyAim(handle);
  return { ...handle.state };
}

/**
 * Write the current state into the light's LOCAL transform inside geoGroup.
 *
 * The conversion goes through geoGroup's own matrix rather than through the yaw
 * angle. A hand-written frame conversion risks mirroring the site through a
 * sign error that is invisible at yaw 0; matrixWorld provides the transform
 * directly. Positions are converted rather than directions so geoGroup's tx/tz
 * cancel in the difference.
 *
 * updateWorldMatrix() first because applyCalib() sets geoGroup.rotation and
 * returns: nothing has re-rendered yet, so matrixWorld is a frame stale, and a
 * sun aimed off a stale matrix is wrong on exactly the frame Set north lands.
 */
function applyAim(h) {
  const parent = h.sun.parent;
  parent.updateWorldMatrix(true, false);
  const dir = sunDirectionWorld(h.state.azimuth_deg, h.state.altitude_deg);
  const targetWorld = h.focus.clone().applyMatrix4(parent.matrixWorld);
  const sunWorld = targetWorld.clone().addScaledVector(dir, h.distance);
  const inv = new THREE.Matrix4().copy(parent.matrixWorld).invert();
  h.target.position.copy(h.focus);
  h.sun.position.copy(sunWorld.applyMatrix4(inv));
  h.target.updateMatrixWorld();
  h.sun.updateMatrixWorld();
  return h;
}

/**
 * How much of its albedo a horizontal surface shows under these lights.
 *
 * three's standard shader is `albedo * RECIPROCAL_PI * irradiance`, and for a
 * ground-facing normal the irradiance is the sun's `intensity * colour * N.L`
 * plus the hemisphere's sky colour at full weight. Measuring it off the LIVE
 * lights rather than hardcoding 0.6637 is the point: someone re-tunes the sun,
 * the unlit capture follows, and the scan stays as bright as the equivalent
 * lit path.
 */
export function capturedLightGain(handle) {
  const { sun, sky, target } = handle;
  sun.updateWorldMatrix(true, false);
  target.updateWorldMatrix(true, false);
  const p = new THREE.Vector3().setFromMatrixPosition(sun.matrixWorld);
  const t = new THREE.Vector3().setFromMatrixPosition(target.matrixWorld);
  const ndotl = Math.max(0, p.sub(t).normalize().y);
  const direct = sun.intensity * ndotl * luminance(sun.color);
  const ambient = sky.intensity * luminance(sky.color);      // .color IS skyColor
  return (direct + ambient) / Math.PI;
}

/**
 * What the lights actually do to a horizontal surface in the open, in the units
 * that decide what a pixel comes out as.
 *
 * Two measurements describe the lighting balance:
 *
 *   sun_to_sky   direct irradiance over ambient irradiance. Outdoors at midday
 *                this is near 7:1 (roughly 900 W/m2 of beam against 100 of
 *                diffuse). Under about 2.5:1 nothing has a light side and a dark
 *                side, and the render reads as a diagram; 1.79:1 is too flat.
 *
 *   sunlit_gain  what fraction of its own albedo a surface facing the sky shows
 *                on screen: irradiance/PI times the renderer's exposure. A
 *                correctly exposed photograph puts an 18% grey card at 0.18
 *                linear, so this wants to be about 1. A gain of 0.6637 x 1.15 =
 *                0.763 leaves measured frames near a maximum of 150/255,
 *                without highlights.
 *
 * `env` is the measured irradiance of the sky environment when one was built —
 * integrated over the same texels the texture is made of, not assumed — so the
 * answer stays true whether or not the GPU could give us an environment map.
 */
export function daylightBalance(handle) {
  const { sun, sky, target } = handle;
  sun.updateWorldMatrix(true, false);
  target.updateWorldMatrix(true, false);
  const p = new THREE.Vector3().setFromMatrixPosition(sun.matrixWorld);
  const t = new THREE.Vector3().setFromMatrixPosition(target.matrixWorld);
  const ndotl = Math.max(0, p.sub(t).normalize().y);
  const direct = sun.intensity * ndotl * luminance(sun.color);
  const hemi = sky.intensity * luminance(sky.color);
  const env = handle.envIrradianceUp ?? 0;
  const ambient = hemi + env;
  const exposure = handle.exposure ?? 1;
  return {
    direct: +direct.toFixed(4),
    ambient: +ambient.toFixed(4),
    hemisphere: +hemi.toFixed(4),
    environment: +env.toFixed(4),
    sun_to_sky: ambient > 0 ? direct / ambient : Infinity,
    sunlit_gain: ((direct + ambient) / Math.PI) * exposure,
    exposure,
  };
}

/**
 * Take a photogrammetry capture off the analytic sun without changing how bright
 * it looks: every LIT material becomes an unlit one carrying the same albedo
 * texture, pre-multiplied by the gain the lit path was giving it.
 *
 * Only lit materials are converted, so this is idempotent — call it again after
 * a reload and it returns 0 rather than dimming the scan by the gain a second
 * time. Returns the number of materials converted.
 *
 * castShadow stays false deliberately: the house's own shadow is already in the
 * albedo, and a second analytic one would land beside it as a visible double.
 */
export function makeCaptureUnlit(stage, handleOrGain, { toneMapped = null } = {}) {
  if (!stage) return 0;
  const gain = typeof handleOrGain === "number" ? handleOrGain
    : handleOrGain ? capturedLightGain(handleOrGain) : 1;
  let n = 0;
  stage.traverse(o => {
    if (!o.isMesh) return;
    const many = Array.isArray(o.material);
    const mats = many ? o.material : [o.material];
    const out = mats.map(m => {
      if (!m || !isLit(m)) return m;
      const b = new THREE.MeshBasicMaterial({
        map: m.map ?? null,
        vertexColors: m.vertexColors,
        side: m.side,
        transparent: m.transparent,
        opacity: m.opacity,
        alphaTest: m.alphaTest,
        alphaMap: m.alphaMap ?? null,
        depthWrite: m.depthWrite,
        toneMapped: toneMapped === null ? m.toneMapped : toneMapped,
        fog: m.fog,
      });
      b.name = m.name;
      b.color.copy(m.color).multiplyScalar(gain);
      b.userData.capturedLightGain = gain;
      m.dispose?.();          // the textures are handed on, not owned by the old material
      n++;
      return b;
    });
    o.material = many ? out : out[0];
    o.castShadow = false;
    o.receiveShadow = false;
  });
  return n;
}

/**
 * Show the capture as the photograph it is: its own texture, at its own values,
 * with nothing done to it.
 *
 * This is what the viewer uses, and it is NOT `makeCaptureUnlit(stage, handle)`.
 * That variant preserves the LIT path's brightness, which darkens the capture.
 * A measured capture's albedo texture has p05 49, p50 77, p95 181 and 2.2% of its
 * pixels over 200; the lit path gives p05 0, p50 43, p95 150 and 0.01% over 200.
 * The pipeline predicts this: texel 180 goes linear 0.457, x0.6637 for
 * the irradiance, x1.15 for the exposure, through Neutral's -0.04 toe, and lands
 * at 151 against a measured p95 of 150. The scan resembles a photograph
 * developed two stops down, and everything composited over it inherits the cap.
 *
 * So: gain 1, and toneMapped false. A photogrammetry texture is display-referred
 * already — a camera's own curve is in those pixels — and putting a second curve
 * on it takes the measured p05 from 49 to 11. The DESIGN is still tone mapped, and
 * `SUNLIT_GAIN` is set so a sunlit surface lands at its own albedo, which is
 * where the photograph puts one. That is what makes the two agree.
 */
export function showCaptureAsPhotograph(stage) {
  return makeCaptureUnlit(stage, 1, { toneMapped: false });
}

/**
 * A surface that draws nothing but the shadow falling on it, on the capture's
 * OWN triangles.
 *
 * `makeShadowCatcher` below drapes a plane over the height field instead, and
 * that is the weaker of the two: the height field is a filled grid that invents
 * flat ground past the scan edge, it needs a `heightAt` from the caller, and it
 * cannot catch a shadow on a wall, a step or the side of the house. Sharing the
 * capture's geometry has none of those problems and costs no memory — the same
 * BufferGeometry, a second material.
 *
 * Added as a CHILD of the capture mesh with an identity transform, so it rides
 * the mesh's own matrix and cannot drift at any yaw. Made invisible to raycasts,
 * because main.js:658 and viewport.js's scan_grid both raycast the whole stage
 * recursively and would otherwise get two hits per column off one surface.
 */
export function makeCaptureShadowCatcher(stage, { opacity = 0.42 } = {}) {
  if (!stage) return null;
  let made = null;
  const targets = [];
  stage.traverse(o => {
    if (o.isMesh && o.geometry && !o.userData?.shadowCatcher) targets.push(o);
  });
  for (const mesh of targets) {
    if (mesh.children.some(ch => ch.userData?.shadowCatcher)) continue;
    const m = new THREE.Mesh(mesh.geometry, new THREE.ShadowMaterial({
      opacity, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }));
    m.name = "capture-shadowcatcher";
    m.userData.shadowCatcher = true;
    m.receiveShadow = true;
    m.castShadow = false;               // it would shadow the yard with itself
    m.renderOrder = 1;                  // after the capture, so it blends over it
    m.matrixAutoUpdate = false;         // identity: it IS the capture's transform
    m.raycast = () => {};
    ARMED.add(m);                       // never re-armed as a design mesh
    mesh.add(m);
    made = made ?? m;
  }
  return made;
}

const isLit = m => !!(m.isMeshStandardMaterial || m.isMeshPhysicalMaterial ||
                      m.isMeshLambertMaterial || m.isMeshPhongMaterial ||
                      m.isMeshToonMaterial);

/**
 * Flag every mesh under a design group to cast and receive. Returns the count,
 * because "shadows are on" is not observable from a still frame if the group was
 * empty — and a design group can legitimately be empty.
 *
 * Only isMesh: sprites are the text labels, and Points is the point-cloud stage.
 * Both render as camera-facing quads whose shadow is a rectangle of noise.
 */
export function enableShadows(root, { cast = true, receive = true } = {}) {
  let n = 0;
  root?.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = cast;
    o.receiveShadow = receive;
    n++;
  });
  return n;
}

/**
 * A surface that draws nothing but the shadow falling on it, draped on the real
 * ground.
 *
 * This is what makes shadows visible at all over the primary stage. SplatMesh
 * renders through Spark's own shader and the point cloud through PointsMaterial;
 * neither samples a shadow map, and the mesh capture is deliberately unlit here
 * for the double-lighting reason above. ShadowMaterial contributes zero except
 * where the sun is occluded, so this adds the DELTA — the shadow of things that
 * were not on site when the scan was taken — and nothing else.
 *
 * `heightAt(x, z)` is the caller's ground lookup in the frame this mesh is added
 * to (main.js's heightAt, an ENU-frame function — do not hand it a world point).
 * Never hand-roll the height lookup here; inconsistent frame conventions can
 * mirror the site.
 */
export function makeShadowCatcher({ heightAt, size = 60, cell = 1,
                                    center = [0, 0], opacity = 0.32, lift = 0.02 } = {}) {
  const seg = Math.max(1, Math.round(size / cell));
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);            // PlaneGeometry is upright; the ground is not
  geo.translate(center[0], 0, center[1]);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    // lift: a catcher exactly on the scan z-fights with it across the whole yard
    pos.setY(i, (heightAt?.(pos.getX(i), pos.getZ(i)) ?? 0) + lift);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();           // normalBias needs a normal that follows the slope

  const mesh = new THREE.Mesh(geo, new THREE.ShadowMaterial({
    opacity, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  }));
  mesh.name = "shadowcatcher";
  mesh.receiveShadow = true;
  mesh.castShadow = false;              // it would shadow the yard with itself
  mesh.renderOrder = 1;                 // after the stage, so it blends over it
  mesh.userData.lift_m = lift;
  return mesh;
}
