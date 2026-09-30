import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../viewer/node_modules/three/build/three.module.js';
import { buildArScan } from '../../viewer/src/ar_scan.js';
import { setCarveSurfaces } from '../../viewer/src/carve.js';

test('original scan keeps its measured triangles, calibration and AR frame at nonzero north', () => {
  const world = new THREE.Group(), geo = new THREE.Group(), level = new THREE.Group(), enu = new THREE.Group();
  world.add(geo); geo.add(level, enu);
  geo.rotation.y = 25 * Math.PI / 180; geo.position.set(8, 0, -4);
  level.rotation.x = 0.14; level.scale.setScalar(1.8); level.position.y = 2;
  const stage = new THREE.Group(); level.add(stage);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(6, 2, 4), new THREE.MeshBasicMaterial({color: 0x999977}));
  const photo = new THREE.Texture(); mesh.material.map = photo;
  const shadow = new THREE.Mesh(mesh.geometry, new THREE.ShadowMaterial());
  shadow.name = 'capture-shadowcatcher'; mesh.add(shadow);
  mesh.position.set(3, 1, 2); stage.add(mesh); stage.visible = false;
  setCarveSurfaces([{ring: [[-100,-100],[100,-100],[100,100],[-100,100]], level: -20}]);
  const shift = [4, 1.2, -7], result = buildArScan(stage, enu, shift);
  assert.ok(result); result.updateMatrixWorld(true);
  const drawn = result.children[0].children[0];
  const input = new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position, 0);
  const expected = enu.worldToLocal(mesh.localToWorld(input.clone())).sub(new THREE.Vector3(...shift));
  const actual = drawn.localToWorld(input.clone());
  assert.ok(actual.distanceTo(expected) < 1e-6, `${actual.toArray()} != ${expected.toArray()}`);
  assert.equal(drawn.geometry, mesh.geometry, 'original triangle positions must not be carved or simplified');
  assert.equal(result.children[0].visible, true, 'hidden scan must still be available to align');
  assert.equal(stage.visible, false, 'export must not change the viewer');
  assert.notEqual(drawn.material, mesh.material);
  assert.equal(drawn.material.map, photo, 'keep the original photographic texture');
  assert.equal(drawn.material.isMeshStandardMaterial, true, 'USD needs a diffuse map, not an unlit emissive texture');
  assert.equal(result.getObjectByName('capture-shadowcatcher'), undefined, 'the shadow overlay hides the original scan');
  assert.equal(result.children.length, 1, 'proposed design must never enter the reference scan');
  setCarveSurfaces([]);
});

test('a missing or splat-only capture is unavailable, never replaced with the proposed design', () => {
  assert.equal(buildArScan(null, new THREE.Group()), null);
  assert.equal(buildArScan(new THREE.Group(), new THREE.Group()), null);
});
