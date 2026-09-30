// FEWER PARTS WHERE A PART IS UNDER A PIXEL.
//
// Measured in saved views (frameBreakdown), nearly all the GPU's time goes to plants, and
// halving the pixels saves little: triangles dominate. Plants stand several metres from
// the camera, where a deer grass draws ~30 triangles for every pixel it covers. At
// that distance a 1 mm spikelet or a 3 mm blade is a fraction of a pixel wide, and a thousand of
// them are a texture, not a thousand things.
//
// So a layer of many small parts gets coarser LEVELS: a quarter of its parts, each four times
// the area, then a sixteenth, sixteen times — the same leaf area, so the same coverage and
// colour. A layer switches to a level only where that level's enlarged part is still under a
// pixel on screen, so nothing that can be seen changes; a leaf big enough to see never switches
// in that view. Only the design in the viewer carries levels: buildPlant, the tests and
// the exporters see the plant as generated.
//
// INSTANCED LAYERS ONLY. Reducing merged layers (a generic grass's blades as one mesh) piece
// by piece about each piece's own axes changes a measured garden view 2.3x as much for 5 ms:
// a curved blade's second axis is its BEND, not its width, so scaling bends it further instead
// of widening it, and the grass thins. Merged layers therefore keep their original geometry.
import * as THREE from "three";

/** A layer with fewer parts than this is left as it is. */
export const LEVEL_MIN_PARTS = 256;
/** On-screen width, in pixels, an enlarged part may have. */
export const LEVEL_MAX_PX = 1;
// the pixel limit, changeable without a rebuild so a comparison can try another (__pedon.levels)
const tune = { px: LEVEL_MAX_PX };
export function tuneLevels(t = {}) { if (Number.isFinite(t.px)) tune.px = t.px; return { ...tune }; }
const STEPS = [4, 16];                            // parts per kept part, level by level

const LEVELS = new WeakMap();                     // instanceMatrix attribute -> its levels
// plant -> its layers' meshes, level by level. Not in userData: every clone copies userData as
// JSON, and a mesh there is serialised whole through its own toJSON
const PLANT_LEVELS = new WeakMap();

// a stable pseudo-random choice of parts, so a level keeps the same ones every load
const keepPart = (i, every) => (Math.imul(i + 1, 2654435761) >>> 0) % every === 0;

/**
 * The coarser levels of one instanced layer, derived once and shared by every plant drawn as
 * that individual: [{ every, matrices, colours, count, width }] with `width` the enlarged
 * part's width in metres — the level is used where that is under LEVEL_MAX_PX.
 */
export function layerLevels(o) {
  if (LEVELS.has(o.instanceMatrix)) return LEVELS.get(o.instanceMatrix);
  let out = [];
  if (o.isInstancedMesh && o.count >= LEVEL_MIN_PARTS) {
    o.geometry.computeBoundingBox();
    const size = o.geometry.boundingBox.getSize(new THREE.Vector3()).toArray();
    const axes = [0, 1, 2].sort((a, b) => size[a] - size[b]);     // thin, middle, long
    // elongated (a blade, a stem, a spikelet): widen it; flat or round: grow both in-plane axes
    const elongated = size[axes[2]] > 3 * size[axes[1]];
    const a = o.instanceMatrix.array, n = o.count;
    // the part's width on the ground: the middle axis, as the instances scale it (the median)
    const widths = [];
    for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 512))) {
      const c = axes[1] * 4;
      widths.push(size[axes[1]] * Math.hypot(a[i * 16 + c], a[i * 16 + c + 1], a[i * 16 + c + 2]));
    }
    widths.sort((x, y) => x - y);
    const width = widths[widths.length >> 1];
    const grow = [1, 1, 1];
    out = STEPS.map(every => {
      grow.fill(1);
      if (elongated) grow[axes[1]] = every;
      else { grow[axes[1]] = Math.sqrt(every); grow[axes[2]] = Math.sqrt(every); }
      const kept = [];
      for (let i = 0; i < n; i++) if (keepPart(i, every)) kept.push(i);
      const matrices = new Float32Array(kept.length * 16);
      const colours = o.instanceColor ? new Float32Array(kept.length * 3) : null;
      kept.forEach((i, j) => {
        for (let c = 0; c < 3; c++) for (let r = 0; r < 4; r++)
          matrices[j * 16 + c * 4 + r] = a[i * 16 + c * 4 + r] * (r < 3 ? grow[c] : 1);
        for (let r = 12; r < 16; r++) matrices[j * 16 + r] = a[i * 16 + r];
        if (colours) colours.set(o.instanceColor.array.subarray(i * 3, i * 3 + 3), j * 3);
      });
      return { every, matrices, colours, count: kept.length,
               width: width * (elongated ? every : Math.sqrt(every)) };
    });
  }
  LEVELS.set(o.instanceMatrix, out);
  return out;
}

/**
 * Give every Fast plant in `root` its levels: beside each instanced layer, its coarser levels as
 * hidden meshes sharing the layer's geometry and materials. Returns the plants that have levels
 * (those given them now and those that had them), for updatePlantLevels.
 */
export function addPlantLevels(root) {
  const plants = [];
  root.traverse(o => { if (o.userData?.fastIndividual !== undefined) plants.push(o); });
  for (const plant of plants) {
    if (PLANT_LEVELS.has(plant)) continue;
    const entries = [];
    const meshes = [];
    plant.traverse(o => { if (o.isInstancedMesh && !o.userData.levelOf) meshes.push(o); });
    for (const o of meshes) {
      const levels = layerLevels(o);
      if (!levels.length) continue;
      const shown = [o];
      for (const L of levels) {
        const m = new THREE.InstancedMesh(o.geometry, o.material, 0);
        m.instanceMatrix = new THREE.InstancedBufferAttribute(L.matrices, 16);
        if (L.colours) m.instanceColor = new THREE.InstancedBufferAttribute(L.colours, 3);
        m.count = L.count;
        m.name = o.name; m.castShadow = o.castShadow; m.receiveShadow = o.receiveShadow;
        m.customDepthMaterial = o.customDepthMaterial; m.customDistanceMaterial = o.customDistanceMaterial;
        m.position.copy(o.position); m.quaternion.copy(o.quaternion); m.scale.copy(o.scale);
        m.frustumCulled = o.frustumCulled; m.renderOrder = o.renderOrder;
        m.visible = false;
        m.userData.levelOf = o.name;
        o.parent.add(m);
        shown.push(m);
      }
      entries.push({ meshes: shown, widths: levels.map(L => L.width) });
    }
    PLANT_LEVELS.set(plant, entries);
  }
  return plants.filter(p => PLANT_LEVELS.get(p)?.length);
}

/** The level each of a plant's layers shows now: [{ name, level, parts }] (the instrument). */
export function plantLevels(plant) {
  return (PLANT_LEVELS.get(plant) ?? []).map(({ meshes }) => {
    const k = Math.max(0, meshes.findIndex(m => m.visible));
    return { name: meshes[0].name, level: k, parts: meshes[k].count };
  });
}

const at = new THREE.Vector3();
/**
 * Show each plant's layers at the level the camera can resolve: the coarsest whose enlarged
 * part is under LEVEL_MAX_PX at the plant's distance. `pxHigh`: the drawn image's height in
 * pixels. `on` false shows every layer as generated (to compare).
 */
export function updatePlantLevels(plants, camera, pxHigh, on = true) {
  // metres a drawn pixel spans at distance d: perspective grows with d, orthographic does not
  const span = camera.isOrthographicCamera
    ? () => (camera.top - camera.bottom) / camera.zoom / pxHigh
    : d => d * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / camera.zoom / pxHigh;
  for (const plant of plants) {
    const entries = PLANT_LEVELS.get(plant);
    if (!entries?.length) continue;
    plant.getWorldPosition(at);
    const px = span(Math.max(0.01, at.distanceTo(camera.position)));
    for (const { meshes, widths } of entries) {
      let level = 0;
      if (on) for (let k = 0; k < widths.length; k++) if (widths[k] <= tune.px * px) level = k + 1;
      for (let k = 0; k < meshes.length; k++) meshes[k].visible = k === level;
    }
  }
}
