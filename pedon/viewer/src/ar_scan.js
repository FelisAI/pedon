import * as THREE from "three";

/** The original capture in the AR design's frame. No design, carving, or inferred ground.
 * North rotates the scan AND the design; remove that common world transform before
 * applying the exported design's origin. Keep calibration (levelling and scale).
 */
export function buildArScan(stage, designFrame, shift = null) {
  if (!stage || !designFrame) return null;
  let meshes = 0;
  stage.traverse(o => { if (o.isMesh && o.geometry?.attributes?.position) meshes++; });
  if (!meshes) return null;
  stage.updateWorldMatrix(true, true);
  designFrame.updateWorldMatrix(true, false);
  const copy = stage.clone(true);
  copy.matrix.copy(designFrame.matrixWorld).invert().multiply(stage.matrixWorld);
  copy.matrixAutoUpdate = false;
  copy.visible = true;
  const shadows = [];
  copy.traverse(o => {
    if (o.name === "capture-shadowcatcher") { shadows.push(o); return; }
    if (!o.isMesh) return;
    const material = m => {
      // USD/SceneKit can lose KHR_materials_unlit's emissive texture. Export the
      // photograph as a standard diffuse map; the picker displays it unlit.
      const c = new THREE.MeshStandardMaterial({map: m.map, color: m.color,
        vertexColors: m.vertexColors, side: m.side, roughness: 1, metalness: 0,
        transparent: m.transparent, opacity: m.opacity, alphaTest: m.alphaTest});
      const gain = m.userData?.capturedLightGain;
      if (Number.isFinite(gain) && gain > 0) c.color.multiplyScalar(1 / gain);
      c.onBeforeCompile = () => {};
      return c;
    };
    o.material = Array.isArray(o.material) ? o.material.map(material) : material(o.material);
  });
  shadows.forEach(o => o.removeFromParent());
  const root = new THREE.Group();
  root.name = "original-scan";
  if (shift) root.position.fromArray(shift).negate();
  root.add(copy);
  root.updateMatrixWorld(true);
  return root;
}
