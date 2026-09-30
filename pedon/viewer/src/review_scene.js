// A review has its own botanical detail and growth, independent of display preferences.
import { buildDesignGroup } from './design.js';
import { preparePlantTextures } from './plant_textures.js';
import { ensureAssets, assetsNeededBy, ensureObjectModels, objectModelsNeededBy } from './assets.js';
import { activeDesign } from './design_doc.js';

export async function buildReviewGroup(design, heightAt) {
  const drawn = activeDesign(design);
  const started = performance.now();
  const status = phase => console.info(`[YardEye] ${phase}: ${Math.round(performance.now() - started)} ms`);
  status('preparing full detail');
  await preparePlantTextures();
  status('textures ready');
  await ensureAssets(assetsNeededBy(drawn));
  status('plant assets ready');
  await ensureObjectModels(objectModelsNeededBy(drawn));
  status('object assets ready');
  const group = await buildDesignGroup(drawn, heightAt, 1, { quality: 'detailed' });
  status('geometry ready');
  return group;
}

// Keep one prepared proposal, including its compiled materials, between looks.
// The document is read afresh by executeView; edits or recalibration invalidate it.
export function createReviewCache(dispose, build = buildReviewGroup) {
  let cached = null;
  return async (design, heightAt, frame, terrain) => {
    const key = JSON.stringify([design, frame]);
    if (cached?.key === key && cached.terrain === terrain) return cached.group;
    if (cached) { dispose(cached.group); cached = null; }
    const group = await build(design, heightAt);
    cached = { key, terrain, group };
    return group;
  };
}

// Build before swapping anything. Polling may rebuild the owner's container while
// a walk awaits a frame; it stays detached until the review finishes.
export async function withReviewScene({ design, heightAt, parent, displayed,
                                       dispose, build = buildReviewGroup }, run) {
  const group = await build(design, heightAt);
  const index = parent.children.indexOf(displayed);
  parent.remove(displayed);
  parent.add(group);
  parent.updateMatrixWorld(true);
  try {
    return await run(group);
  } finally {
    parent.remove(group);
    parent.add(displayed);
    // Keep traversal order stable (selection and subject resolution use it).
    if (index >= 0) {
      parent.children.splice(parent.children.indexOf(displayed), 1);
      parent.children.splice(index, 0, displayed);
    }
    dispose(group);
  }
}
