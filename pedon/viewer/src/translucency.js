/**
 * Leaves are lit from BEHIND as well as in front.
 *
 * Plants must look photorealistic, not like simple 3D models. The shrubs have
 * leaf-sized geometry, the cards alpha-masked leaf shapes, and the whole garden a
 * sky to be lit by. This adds the single strongest cue that a leaf is a LEAF and
 * not a painted chip: a leaf is thin, and the sun
 * behind it comes THROUGH. Stand in any garden in the afternoon and the plants
 * between you and the sun are the bright ones.
 *
 * A `MeshStandardMaterial` cannot do that. Its diffuse term is `max(dot(N, L), 0)`,
 * so a leaf facing away from the sun gets exactly zero direct light and reads as a
 * flat dark chip — which is precisely how the backlit half of every plant reads
 * without this.
 *
 * WHY NOT `transmission`. `MeshPhysicalMaterial.transmission` is the physically
 * right answer and is unusable here: it renders the scene to a transmission target
 * and re-samples it per material. A single manzanita is ~39,000 card vertices and
 * a garden holds a hundred or more plants; that is a slideshow. The cheap standard model is a
 * view-dependent lobe — light travelling through the leaf continues in roughly its
 * own direction, so you see it when you are looking back down the sun's own ray —
 * and it costs a few instructions in a shader that is already running.
 *
 * The amount is per LEAF CLASS, because that is a real physical property and this
 * project already classifies every plant by it. A rosemary needle is thick, waxy
 * and nearly opaque; a big thin blade is a stained-glass window. Giving every leaf
 * the same transmission would be the same mistake as giving every salvia the same
 * silhouette.
 */
import * as THREE from "three";

/**
 * How much light gets THROUGH, by leaf class, and how tight the glow lobe is.
 *
 * `scale` is the fraction of the light behind the leaf that reaches the eye at
 * the lobe's peak. `power` is the lobe exponent: high is a tight highlight seen
 * only when looking almost straight into the sun, low is a broad wash. Thin
 * leaves scatter widely (low power), waxy needles barely transmit at all.
 */
export const TRANSLUCENCY = {
  tiny:     { scale: 0.22, power: 5.0 },   // small and often thick-cuticled
  needle:   { scale: 0.10, power: 6.0 },   // rosemary: thick, waxy, nearly opaque
  scale:    { scale: 0.10, power: 6.0 },   // succulent scale leaves, ditto
  small:    { scale: 0.30, power: 4.5 },
  medium:   { scale: 0.40, power: 4.0 },
  lance:    { scale: 0.42, power: 4.0 },
  filigree: { scale: 0.45, power: 3.5 },   // finely divided, so almost all edge
  round:    { scale: 0.50, power: 3.5 },
  large:    { scale: 0.55, power: 3.0 },   // a big thin blade is the stained glass
};

/** A petal is thinner than any leaf, and backlighting is most of what a flower does. */
export const BLOOM_TRANSLUCENCY = { scale: 0.62, power: 3.0 };

/** Anything with no class of its own transmits like a middling leaf. */
export const DEFAULT_TRANSLUCENCY = TRANSLUCENCY.medium;

/**
 * The colour light becomes on the way through.
 *
 * Chlorophyll absorbs blue and red and passes green and yellow, which is why a
 * backlit leaf is a warmer, more saturated green than the same leaf lit from the
 * front — not simply a brighter one. Tinting is what stops this reading as a
 * generic bloom filter stuck on the plants.
 */
export const LEAF_TRANSMIT_TINT = [1.15, 1.32, 0.55];
/** A petal passes its own colour much more evenly; barely tinted. */
export const BLOOM_TRANSMIT_TINT = [1.10, 1.05, 0.95];

/**
 * The lobe, in plain JS, so the curve can be pinned by a test with no GPU.
 *
 * `dotVL` is dot(-L, V): +1 when you are looking straight down the ray the sun is
 * travelling (the leaf is directly between you and the sun), 0 side-on, negative
 * when the sun is behind YOU and the leaf is front-lit, where transmission must
 * contribute nothing at all.
 *
 * Kept in exact step with the GLSL below — the two are one expression written
 * twice, and two copies drift, so the test asserts the GLSL still contains this
 * same `pow(max(...), power)` shape.
 */
export function backlitResponse(dotVL, power = 4, scale = 1) {
  if (!Number.isFinite(dotVL) || !Number.isFinite(power) || !Number.isFinite(scale)) return 0;
  return Math.pow(Math.max(dotVL, 0), power) * scale;
}

/** The settings for a leaf of this class. */
export function translucencyFor(leafClass) {
  return TRANSLUCENCY[leafClass] ?? DEFAULT_TRANSLUCENCY;
}

// The two chunks patched below. Exported so a test can assert they still EXIST in
// the three.js that is installed: `String.replace` with a pattern that does not
// match is a silent no-op, so a renamed chunk would leave every leaf opaque with
// the whole suite green — this repo's most expensive failure shape.
export const ANCHORS = ["#include <common>", "#include <lights_fragment_end>"];

const DECLS = `
uniform float uTransScale;
uniform float uTransPower;
uniform vec3  uTransTint;
`;

// `directionalLights[i].direction` is view-space and points from the surface
// TOWARD the light (three.js builds it as lightPos - targetPos). vViewPosition
// points from the fragment toward the camera. Light that passes through the leaf
// keeps travelling in -L, so the eye catches it when -L lines up with V.
const LOBE = `
#if defined( RE_Direct ) && ( NUM_DIR_LIGHTS > 0 )
{
  vec3 vTrans = normalize( vViewPosition );
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
    vec3 lTrans = normalize( directionalLights[ i ].direction );
    float back = pow( max( dot( -lTrans, vTrans ), 0.0 ), uTransPower );
    reflectedLight.directDiffuse += diffuseColor.rgb * uTransTint
                                  * directionalLights[ i ].color * back * uTransScale;
  }
  #pragma unroll_loop_end
}
#endif
`;

/**
 * Give a material a back-lit term. Returns the material.
 *
 * Applied through `onBeforeCompile` rather than by writing a whole ShaderMaterial,
 * so the material keeps every other thing MeshStandardMaterial does — the sky
 * environment, the alpha-tested leaf mask, vertex colours, shadows — and gains
 * one term. A hand-rolled leaf shader would have to
 * re-implement all of that and would drift from it.
 */
export function translucent(material, { scale, power, tint } = {}) {
  if (!material) return material;
  const s = Number.isFinite(scale) ? scale : DEFAULT_TRANSLUCENCY.scale;
  const p = Number.isFinite(power) ? power : DEFAULT_TRANSLUCENCY.power;
  const t = tint ?? LEAF_TRANSMIT_TINT;
  if (s <= 0) return material;                 // opaque by request: leave it alone

  material.userData.translucency = { scale: s, power: p, tint: t };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTransScale = { value: s };
    shader.uniforms.uTransPower = { value: p };
    shader.uniforms.uTransTint = { value: new THREE.Color(t[0], t[1], t[2]) };
    for (const a of ANCHORS) {
      if (!shader.fragmentShader.includes(a))
        // loud, because the silent version is a garden of flat dark chips and a
        // green test suite
        console.warn(`translucency: three.js no longer has "${a}" — leaves stay opaque`);
    }
    shader.fragmentShader = shader.fragmentShader
      .replace(ANCHORS[0], ANCHORS[0] + DECLS)
      .replace(ANCHORS[1], ANCHORS[1] + LOBE);
    material.userData.shader = shader;
  };
  // Two leaves with different transmission must not share one compiled program.
  material.customProgramCacheKey = () => `translucent|${s}|${p}|${t.join(",")}`;
  return material;
}

/** The GLSL, for the test that keeps it in step with backlitResponse(). */
export const SOURCE = { DECLS, LOBE };
