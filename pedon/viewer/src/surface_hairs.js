import * as THREE from 'three';
import {surfaceGeometry,InstanceTransforms} from './woody_geometry.js';
const V=(x=0,y=0,z=0)=>new THREE.Vector3(x,y,z),UP=V(0,1,0),Z=V(0,0,1);
/** Area-weighted barycentric roots on the real triangles. Density is physical
 * (.25 mm spacing), not a fixed hair budget; larger blades receive more hairs. */
export function surfaceHairs(surface,seed=1,options={}){
 const poses=options.instances?new InstanceTransforms():null,rotation=new THREE.Quaternion();
 const {spacing=.00025,lengthMin=.00075,lengthRange=.00055,radiusM=.000019}=options;
 for(const value of [spacing,lengthMin,radiusM])if(!Number.isFinite(value)||value<=0)throw new RangeError('Hair dimensions must be positive and finite');
 if(!Number.isFinite(lengthRange)||lengthRange<0)throw new RangeError('Hair length range must be nonnegative and finite');
 const p=surface.attributes.position,n=surface.attributes.normal,idx=surface.index.array,areas=[],A=V(),B=V(),D=V(),cross=V();let area=0;
 for(let i=0;i<idx.length;i+=3){A.fromBufferAttribute(p,idx[i]);B.fromBufferAttribute(p,idx[i+1]).sub(A);D.fromBufferAttribute(p,idx[i+2]).sub(A);area+=cross.crossVectors(B,D).length()*.5;areas.push(area);}
 const count=Math.ceil(area/(spacing*spacing)),P=[],I=[],C=[],roots=[],normal=V(),base=V(),axis=V(),x=V(),z=V(),q=V();let state=seed*1234567+891;
 if(poses)poses.reserve(count);
 const rand=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
 for(let k=0;k<count;k++){
  const pick=(k+rand())/count*area;let lo=0,hi=areas.length-1;while(lo<hi){const m=(lo+hi)>>1;if(areas[m]<pick)lo=m+1;else hi=m;}
  const triangle=lo,ids=[idx[lo*3],idx[lo*3+1],idx[lo*3+2]],s=Math.sqrt(rand()),weights=[1-s,s*(1-rand()),0];weights[2]=1-weights[0]-weights[1];base.set(0,0,0);normal.set(0,0,0);
  for(let j=0;j<3;j++){base.addScaledVector(q.fromBufferAttribute(p,ids[j]),weights[j]);normal.addScaledVector(q.fromBufferAttribute(n,ids[j]),weights[j]);}normal.normalize();axis.copy(normal).multiplyScalar(.70).addScaledVector(Z,.75+rand()*.40).addScaledVector(V(1,0,0),(rand()-.5)*.4).normalize();x.crossVectors(axis,Math.abs(axis.z)>.9?UP:Z).normalize();z.crossVectors(axis,x);
  const length=lengthMin+rand()*lengthRange,bend=(rand()-.5)*.00027,start=P.length/3,phase=rand()*Math.PI*2;
  if(poses){rotation.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x,axis,z.clone().negate()));poses.push({at:base,q:rotation,scale:V(radiusM,length,radiusM)});if(k<32)roots.push({triangle,weights});continue;}
  for(let level=0;level<3;level++)for(let j=0;j<4;j++){
   const t=level/2,a=j*Math.PI/2+phase,radius=radiusM*(1-t),tone=.83+.15*t;
   q.copy(base).addScaledVector(axis,length*t).addScaledVector(x,Math.cos(a)*radius+bend*t*t).addScaledVector(z,Math.sin(a)*radius);P.push(q.x,q.y,q.z);C.push(tone*.94,tone,tone*.88);
  }
  for(let level=0;level<2;level++)for(let j=0;j<4;j++){const a=start+level*4+j,b=start+level*4+(j+1)%4;I.push(a,b,a+4,b,b+4,a+4);}
  if(k<32)roots.push({triangle,weights});
 }
 if(poses){const g=new THREE.ConeGeometry(1,1,4,2);g.translate(0,.5,0);g.deleteAttribute('uv');g.userData={area_m2:area,hairs:count,roots};return {geometry:g,poses};}
 const g=surfaceGeometry(P,I,null,C);g.userData={area_m2:area,hairs:count,roots};return g;
}
