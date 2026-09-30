// One shared GLTFLoader for the whole app.
//
// Kept in its own module so both design.js (scan + inline assets) and
// assets.js (the plant library) can reach it without importing each other —
// design.js already imports plants.js, which imports assets.js.
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";

let gltfLoader = null;

export function getLoader() {
  if (!gltfLoader) {
    gltfLoader = new GLTFLoader();
    const draco = new DRACOLoader();
    // three's own decoder, served by the dev server as the files three ships (vite.config.js):
    // it matches this three's DRACOLoader, and needs no network — a CDN decoder makes every
    // scan load online-only
    draco.setDecoderPath("/draco/");
    gltfLoader.setDRACOLoader(draco);
  }
  return gltfLoader;
}
