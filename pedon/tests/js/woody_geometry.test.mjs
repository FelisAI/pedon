import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../viewer/node_modules/three/build/three.module.js';
import {compileStaticCurve,InstanceTransforms,instanceBatch,woodyBranch,botanicalInstanceBounds} from '../../viewer/src/woody_geometry.js';

test('compiled botanical curves retain THREE arc lengths, points and tangents',()=>{
 for(const points of [[[0,0,0],[.1,.04,.07],[.25,.15,.1]],[[.03,.7,-.11],[.08,.73,.04],[-.08,.87,.13],[.1,1.08,.09]],[[0,0,0],[0,0,0],[.001,.03,0]]]){
  const original=new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p))),compiled=compileStaticCurve(original.clone());
  assert.equal(compiled.arcLengthDivisions,original.arcLengthDivisions);
  for(const divisions of [47,200,81]){
   const expected=compileStaticCurve(original.clone());
   assert.deepEqual(compiled.getLengths(divisions),THREE.Curve.prototype.getLengths.call(expected,divisions),'arc accumulation differs from THREE');
   const cached=compiled.getLengths(divisions);assert.equal(compiled.getLengths(divisions),cached);compiled.needsUpdate=true;assert.notEqual(compiled.getLengths(divisions),cached);
  }

  assert.ok(Math.abs(original.getLength()-compiled.getLength())<1e-12);
  for(let i=0;i<=250;i++){
   const t=i/250;
   assert.ok(original.getPointAt(t).distanceTo(compiled.getPointAt(t))<1e-11,'compiled curve changed a botanical node');
   assert.ok(original.getTangentAt(t).distanceTo(compiled.getTangentAt(t))<1e-8,'compiled curve changed a leaf direction');
  }
 }
 assert.throws(()=>compileStaticCurve(new THREE.CatmullRomCurve3([new THREE.Vector3(),new THREE.Vector3(0,1,0)],true)),/must be open/);
});

test('packed instances preserve every draw matrix and per-instance color across buffer growth',()=>{
 const rows=[],packed=new InstanceTransforms();
 for(let i=0;i<2100;i++){
  if(i===0)packed.reserve(97);if(i===1023)packed.reserve(1437);
  const row={at:new THREE.Vector3(Math.sin(i)*.2,i*.001,Math.cos(i)*.3),q:new THREE.Quaternion().setFromEuler(new THREE.Euler(i*.01,i*.03,i*.02)),scale:new THREE.Vector3(.001+i*.00001,.005,.007)};
  if(i>1023)row.color=new THREE.Color(.2,.3+i*.0001,.7);
  rows.push(row);packed.push(row);
 }
 const g=new THREE.BoxGeometry(),mat=new THREE.MeshStandardMaterial(),expected=instanceBatch(g,mat,rows,'original'),actual=instanceBatch(g,mat,packed,'packed');
 assert.equal(actual.count,2100);
 assert.ok(actual.instanceMatrix.array.every((x,i)=>x===expected.instanceMatrix.array[i]),'packing changed drawn transforms');
 assert.ok(actual.instanceColor.array.every((x,i)=>x===expected.instanceColor.array[i]),'packing changed visible instance colors');
 assert.deepEqual(actual.boundingBox,expected.boundingBox);
 assert.deepEqual(actual.boundingSphere,expected.boundingSphere);
 assert.throws(()=>packed.reserve(-1),/Invalid instance reservation/);
});

test('wood surface vertex colors remain in the portable glTF color range',()=>{
 for(const phase of [0,1,2,3,4,5]){
  const {geometry:g}=woodyBranch([new THREE.Vector3(),new THREE.Vector3(.04,.3,0),new THREE.Vector3(.2,.7,.1)],.02,.003,phase);
  assert.ok(g.attributes.color.array.every(c=>c>=0&&c<=1),'wood vertex color exceeds 0..1');
 }
});

test('small hooked flower axes follow the real curve without altering default branch geometry',()=>{
 const V=(x=0,y=0,z=0)=>new THREE.Vector3(x,y,z),points=[V(),V(.004,.1,0),V(.03,.20,0),V(.075,.174,0)],fine=woodyBranch(points,.0015,.001,0,.006),ordinary=woodyBranch(points,.0015,.001,0),explicit=woodyBranch(points,.0015,.001,0,.045);
 for(const name of Object.keys(ordinary.geometry.attributes))assert.deepEqual(ordinary.geometry.attributes[name].array,explicit.geometry.attributes[name].array);
 const p=fine.geometry.attributes.position,ids=fine.geometry.index.array,tri=new THREE.Triangle(),closest=V();
 for(let i=65;i<100;i++){
  const point=fine.curve.getPointAt(i/100);let distance=Infinity;
  for(let j=0;j<ids.length;j+=3){tri.a.fromBufferAttribute(p,ids[j]);tri.b.fromBufferAttribute(p,ids[j+1]);tri.c.fromBufferAttribute(p,ids[j+2]);tri.closestPointToPoint(point,closest);distance=Math.min(distance,point.distanceTo(closest));}
  assert.ok(distance<.0017,'hooked axis has detached chord segments');
 }
 for(const step of [0,-1,NaN,Infinity])assert.throws(()=>woodyBranch(points,.0015,.001,0,step),/positive and finite/);
});

test('fast botanical bounds match THREE transformed boxes and enclose all actual vertices',()=>{
 const g=new THREE.ConeGeometry(.07,.24,9,3);g.translate(.03,.09,-.04);
 const mesh=new THREE.InstancedMesh(g,new THREE.MeshBasicMaterial(),45),matrix=new THREE.Matrix4(),p=new THREE.Vector3();
 for(let i=0;i<mesh.count;i++)mesh.setMatrixAt(i,matrix.compose(new THREE.Vector3(Math.sin(i)*.3,i*.017,Math.cos(i)*.4),new THREE.Quaternion().setFromEuler(new THREE.Euler(i*.14,i*.07,i*.23)),new THREE.Vector3(i%2?-.4:.3,1+i*.03,.2+i*.01)));
 mesh.computeBoundingBox();const expected=mesh.boundingBox.clone(),transforms=mesh.instanceMatrix.array.slice();botanicalInstanceBounds(mesh);
 assert.ok(mesh.boundingBox.min.distanceTo(expected.min)<1e-12);assert.ok(mesh.boundingBox.max.distanceTo(expected.max)<1e-12);assert.deepEqual(mesh.instanceMatrix.array,transforms);
 for(let i=0;i<mesh.count;i++){
  mesh.getMatrixAt(i,matrix);
  for(let j=0;j<g.attributes.position.count;j++){
   p.fromBufferAttribute(g.attributes.position,j).applyMatrix4(matrix);
   assert.ok(mesh.boundingSphere.distanceToPoint(p)<1e-10,'culling sphere excludes actual botanical geometry');
  }
 }
 mesh.count=0;botanicalInstanceBounds(mesh);assert.ok(mesh.boundingBox.isEmpty());assert.ok(mesh.boundingSphere.isEmpty());
});
