import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from '../../viewer/node_modules/three/build/three.module.js';
import {botanicalHead, botanicalModel, grassBladeWidth, grassInflorescence} from '../../viewer/src/botanical.js';
import {buildPlant, rngFrom, leafMaskFraction} from '../../viewer/src/plants.js';
import { catalogue } from './lib/library.mjs';

globalThis.document={createElement:()=>({getContext:()=>null})};
const palette=catalogue();
const plant=sp=>({...palette.find(p=>p.species===sp),id:'botany-review'});
const bounds=g=>new THREE.Box3().setFromObject(g);

test('Hot Lips has a white hood and a distinct red lip on the actual rendered mesh',()=>{
 const p=buildPlant(plant("Salvia microphylla 'Hot Lips'")),m=p.getObjectByName('bloom');
 assert.ok(m);assert.equal(m.material.color.getHex(),0xffffff);
 // what is DRAWN: a flower's vertex colour times its instance's — the shoot model carries one flower
 // per floret, instanced; a merged mesh is the one-instance case of the same count
 const c=m.geometry.attributes.color,k=new THREE.Color();let red=0,white=0;
 for(let j=0;j<(m.isInstancedMesh?m.count:1);j++){
  if(m.isInstancedMesh)m.getColorAt(j,k);else k.set(0xffffff);
  // a flower tinted all red says nothing about the hood and the lip: judge the untinted ones
  if(Math.min(k.r,k.g,k.b)<.7)continue;
  for(let i=0;i<c.count;i++){
   const r=c.getX(i)*k.r,g=c.getY(i)*k.g,b=c.getZ(i)*k.b;
   if(r>g*3)red++;
   if(Math.min(r,g,b)>.7)white++;
  }
 }
 assert.ok(red>50&&white>50,{red,white});
});

test('a fan flower has five one-sided lobes, unlike a radial daisy',()=>{
 const b=botanicalHead('fan',.1,.025,rngFrom('fan'));
 assert.equal(b.heads.length,5);
 const all=new THREE.Group();for(const g of b.heads)all.add(new THREE.Mesh(g));
 const box=bounds(all);assert.ok(box.min.z>=-.001);
 assert.ok(box.max.x>0&&box.min.x<0&&box.max.z>.01);
});

test('Evergold stripes run within each blade rather than random whole-blade colours',()=>{
 const g=botanicalModel(plant("Carex oshimensis 'Evergold'"),rngFrom('carex'));
 const c=g.getObjectByName('foliage').geometry.attributes.color;
 const colours=new Set();for(let i=0;i<30;i++)colours.add([c.getX(i),c.getY(i),c.getZ(i)].map(n=>n.toFixed(3)).join(','));
 assert.ok(colours.size>=4,'no margin/centre variation on the first blade');
 const box=bounds(g);assert.ok(box.min.y>=-1e-6&&box.max.y>.2);
});

test('Doris Taylor is a fleshy rosette with pale surface hairs',()=>{
 const g=botanicalModel(plant("Echeveria 'Doris Taylor'"),rngFrom('doris'));
 assert.ok(g);const box=bounds(g),size=box.getSize(new THREE.Vector3());
 assert.ok(size.x>.16&&size.x<.24&&size.y<.15,'agave-like vertical silhouette');
 const c=g.getObjectByName('foliage').geometry.attributes.color;
 let hairs=0;for(let i=0;i<c.count;i++)if(c.getX(i)>.7&&c.getY(i)>.7&&c.getZ(i)>.6)hairs++;
 assert.ok(hairs>1000,'woolly leaves lost their pale hairs');
});

test('fescue blades are finer than deer grass and flowering height stays separate',()=>{
 assert.ok(grassBladeWidth({species:'Festuca idahoensis'})<grassBladeWidth({species:'Muhlenbergia rigens'}));
 const p=plant('Muhlenbergia rigens'),g=grassInflorescence(p,rngFrom('grass'));
 assert.ok(g&&bounds(g).max.y>p.mature_height_m);
 assert.ok(bounds(g).max.y<=p.flowering_height_range_m[1]*1.02);
});

test('leaf UVs crop the mask margin so broad sage leaves retain their stated width',()=>{
 // CARD SAGES, one of each width class. Not Salvia apiana: it has its own shoot
 // model and so builds no leaf CARDS at all — the test is about how a CARD's UVs
 // are cropped, so it asks plants that have cards.
 // The tight bound belongs to the narrow classes (`lance`); a `large`
 // leaf legitimately fills more of its mask and crops less, so it gets its own
 // bound rather than being excused. Both must be cropped: an uncropped 0..1 span
 // narrows the leaf a second time through the mask margin.
 const crop = species => {
   const g=buildPlant(plant(species));
   assert.ok(!g.userData.shootModel,`${species} moved to a shoot model; pick another card sage`);
   const m=g.children.filter(o=>o.name==='foliage').at(-1);
   assert.ok(m,`leaf shell absent for ${species}`);
   const u=m.geometry.attributes.uv;
   let lo=1,hi=0;for(let i=0;i<6;i++){lo=Math.min(lo,u.getX(i));hi=Math.max(hi,u.getX(i));}
   return [lo,hi];
 };
 const [nlo,nhi]=crop('Salvia mellifera');          // lance
 assert.ok(nlo>.3&&nhi<.7,`full-square UVs narrow the lance leaf a second time: ${nlo}..${nhi}`);
 const [blo,bhi]=crop('Salvia argentea');           // large, broad and woolly
 assert.ok(blo>.1&&bhi<.9,`a broad leaf's UVs are not cropped at all: ${blo}..${bhi}`);
 assert.ok(bhi-blo>nhi-nlo,'a broad leaf should keep MORE of its mask than a lance one');
 assert.ok(leafMaskFraction('needle')<leafMaskFraction('round'));
});
