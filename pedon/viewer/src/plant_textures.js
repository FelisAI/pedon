// One preparation path for the garden, picker and plant comparison sheet.
import {SPECIES} from './species.js';
import {setTextureDetail,textureDetail,markTexturesReady} from './plant_texture_loader.js';

/** Every builder's textures, at the size `quality` draws them — "fast" at 256 px: each
 *  library builder's own `prepare` (species.js). */
export function preparePlantTextures(quality='detailed'){
 setTextureDetail(quality);
 const key=textureDetail();
 return Promise.all(SPECIES.filter(s=>s.prepare).map(s=>s.prepare()))
  .then(all=>{ if(key===textureDetail()) markTexturesReady(key,all.every(Boolean)); return all; });
}
