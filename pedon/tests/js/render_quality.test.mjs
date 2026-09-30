import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from '../../viewer/node_modules/three/build/three.module.js';
import {readRenderQuality,saveRenderQuality,applyRenderQuality,
        readShadows,saveShadows,setShadows} from '../../viewer/src/render_quality.js';
import {buildPlant} from '../../viewer/src/plants.js';
import {buildDesignGroup} from '../../viewer/src/design.js';
import { resolvePath } from "../../viewer/project_paths.js";
import { catalogue, needsLibrary } from "./lib/library.mjs";
import { needsSite } from "./lib/site.mjs";
import { within } from "./lib/timing.mjs";   // wall-clock guards, stretched on a slow machine

globalThis.document={createElement(){return {width:0,height:0,getContext:()=>new Proxy({
  measureText:()=>({width:12}),createRadialGradient:()=>({addColorStop(){}}),
  createLinearGradient:()=>({addColorStop(){}})
},{get:(o,k)=>o[k]??(()=>{})})};}};
const read = name => JSON.parse(fs.readFileSync(resolvePath(name)));   // data/… is the active site's
function stats(g) {let triangles=0;g.traverse(o=>{if(o.isMesh)triangles+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3*(o.isInstancedMesh?o.count:1);});return triangles;}
function release(g){g.traverse(o=>{o.geometry?.dispose();for(const m of [o.material].flat())m?.dispose();});}

test('fast is the first-visit default; explicit full detail persists without requiring storage',()=>{
  const data=new Map(),storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)};
  assert.equal(readRenderQuality(storage),'fast');saveRenderQuality(storage,'detailed');
  assert.equal(readRenderQuality(storage),'detailed');
  assert.equal(readRenderQuality(storage,'?quality=fast'),'fast');
  assert.equal(readRenderQuality({getItem(){throw Error('denied');}},'?quality=detailed'),'detailed');
  assert.doesNotThrow(()=>saveRenderQuality({setItem(){throw Error('denied');}},'fast'));
  const r={setPixelRatio(n){this.ratio=n;},shadowMap:{}};
  applyRenderQuality(r,'fast',3);assert.equal(r.ratio,1);
  applyRenderQuality(r,'detailed',3);assert.equal(r.ratio,2);
});

test('the detail preset does not decide whether the sun casts a shadow',()=>{
  // Fast preview is the mode the owner views in, so as one setting the sun can
  // be dragged across the whole day and nothing casts a shadow — and shadows are
  // most of what seeing the garden at six in the evening means. One
  // is LOADING cost (how much botanical detail is built), the other is
  // PER-FRAME cost (how the scene is lit); they are not the same decision.
  const r={setPixelRatio(){},shadowMap:{enabled:true}};
  applyRenderQuality(r,'fast',1);
  assert.equal(r.shadowMap.enabled,true,'switching to Fast preview turned shadows off again');
  applyRenderQuality(r,'fast',1,false);assert.equal(r.shadowMap.enabled,false);
  applyRenderQuality(r,'detailed',1,true);assert.equal(r.shadowMap.enabled,true);
});

test('shadows default on, and the choice persists',()=>{
  const data=new Map(),storage={getItem:k=>data.has(k)?data.get(k):null,setItem:(k,v)=>data.set(k,v)};
  assert.equal(readShadows(storage),true,'a first visit gets no shadows');
  saveShadows(storage,false);assert.equal(readShadows(storage),false);
  saveShadows(storage,true);assert.equal(readShadows(storage),true);
  assert.equal(readShadows({getItem(){throw Error('denied');}}),true);
  assert.doesNotThrow(()=>saveShadows({setItem(){throw Error('denied');}},true));
});

test('turning shadows on REBUILDS the materials, or the flag changes nothing',()=>{
  // three compiles USE_SHADOWMAP into every program, so flipping
  // renderer.shadowMap.enabled after the first frame does nothing at all until
  // the materials are rebuilt. Measured on the live viewer: with the flag true,
  // all 977 meshes armed to cast and the sun casting, six renders across the
  // toggle come back BYTE-IDENTICAL. `shadowMap.needsUpdate` is not
  // this: it re-renders the map, it does not recompile the shaders that read it.
  const mats=[{needsUpdate:false},{needsUpdate:false},{needsUpdate:false}];
  const scene={traverse(fn){fn({material:mats[0]});fn({material:[mats[1],mats[2]]});fn({});}};
  const r={shadowMap:{enabled:false}};
  setShadows(r,scene,true);
  assert.equal(r.shadowMap.enabled,true);
  assert.equal(r.shadowMap.needsUpdate,true);
  assert.deepEqual(mats.map(m=>m.needsUpdate),[true,true,true],
    'a material was left compiled without USE_SHADOWMAP');
  assert.doesNotThrow(()=>setShadows({shadowMap:{}},undefined,false));
});

test('fast bypasses dense organs; default and explicit detailed builders retain identical geometry',needsLibrary,()=>{
  const plant=catalogue().find(p=>p.species==='Echeveria spp.');
  assert.ok(plant);const before=JSON.stringify(plant);
  const detailed=buildPlant(plant),explicit=buildPlant(plant,{quality:'detailed'}),fast=buildPlant(plant,{quality:'fast'});
  assert.equal(fast.userData.renderQuality,'fast');
  assert.ok(stats(fast)<stats(detailed)/10,'fast still constructs dense botanical organs');
  const actual=g=>{const out=[];g.traverse(o=>{if(o.isMesh)out.push([o.geometry.attributes.position.array,o.instanceMatrix?.array]);});return out;};
  assert.deepEqual(actual(explicit),actual(detailed));
  assert.equal(JSON.stringify(plant),before);
  for(const g of [detailed,explicit,fast])release(g);
});

test('fast design preserves every ID, position and growth scale without fetching explicit owner models',async()=>{
  const design={plants:[{id:'a',species:'Salvia officinalis Berggarten',asset:'must-not-fetch.glb',
    position:[3,7],mature_height_m:.6,mature_spread_m:.9,cat_safe:true},
    {id:'b',species:'Muhlenbergia rigens',position:[-2,4],mature_height_m:1.2,mature_spread_m:1.2}]};
  const before=JSON.stringify(design),old=globalThis.fetch;globalThis.fetch=()=>{throw Error('Unexpected model request');};
  try{
    const whole=await buildDesignGroup(design,()=>.4,1,{quality:'fast'});
    const young=await buildDesignGroup(design,()=>.4,.5,{quality:'fast'});
    assert.equal(whole.children.length,2);
    for(let i=0;i<2;i++){
      const g=whole.children[i];assert.equal(g.userData.id,design.plants[i].id);
      assert.equal(g.userData.renderQuality,'fast');
      assert.deepEqual(g.position.toArray(),[design.plants[i].position[0],.4,-design.plants[i].position[1]]);
      g.children.filter(o=>o.isSprite).forEach(o=>o.removeFromParent());
      young.children[i].children.filter(o=>o.isSprite).forEach(o=>o.removeFromParent());
      const h=new THREE.Box3().setFromObject(g).getSize(new THREE.Vector3()).y;
      const hy=new THREE.Box3().setFromObject(young.children[i]).getSize(new THREE.Vector3()).y;
      assert.ok(hy<h*.65 && hy>h*.35,'growth no longer reflects declared scale');
    }
    assert.equal(JSON.stringify(design),before);release(whole);release(young);
  }finally{globalThis.fetch=old;}
});

// WHAT THIS GUARD IS WORTH, measured. The same loop — buildPlant over the same 236
// plants — takes about 2.6 s here and 3.3 s in the app's own idle page, so node is
// within 1.3x of the browser. (A BACKGROUND tab reads ~31 s; that is the tab being
// throttled, not a measurement.) What this cannot see is everything that is not
// buildPlant: 17 lava rocks can be 7.4 s of the same build, and a garden built twice
// per page load doubles everything. `__pedon.plantTimings()` is the browser-side
// instrument for those; this stays the guard for plant CPU.
// THE CATALOGUE IS NOT BUILT AT ONCE. Fast draws the photoreal builders reduced —
// accurate rendering and one shared model are preferred to a cheaper stand-in that
// looks wrong — which puts the whole catalogue in Fast at about 20 s. So the asset
// window draws its pictures one at a time, deferred, and keeps them in the browser
// (thumbs.js). The yard keeps its six seconds, and what the catalogue must keep is
// that no ONE plant holds the page for long — each deferred picture is one build.
const SPECIES_GUARD_MS=4000;
test('fast saved yard constructs below the unchanged six-second interaction guard; no catalogue plant holds the page past SPECIES_GUARD_MS',needsSite,t=>{
  for(const [name,plants] of [['yard',read('data/design.json').plants],['catalog',catalogue()]]){
    const start=performance.now();let triangles=0,worst=[0,''];
    for(const p of plants){const t0=performance.now();const g=buildPlant(p,{quality:'fast'});const one=performance.now()-t0;if(one>worst[0])worst=[one,p.species];assert.ok(g.children.some(o=>o.isMesh),p.species);triangles+=stats(g);release(g);}
    const ms=performance.now()-start;t.diagnostic(JSON.stringify({name,plants:plants.length,ms,drawnTriangles:triangles,slowest:worst}));
    if(name==='yard')assert.ok(ms<within(6000),`${name}: ${ms.toFixed(0)} ms`);
    assert.ok(worst[0]<within(SPECIES_GUARD_MS),`${worst[1]} held the page ${worst[0].toFixed(0)} ms`);
  }
});
