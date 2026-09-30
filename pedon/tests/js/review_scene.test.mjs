import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as THREE from '../../viewer/node_modules/three/build/three.module.js';
import { withReviewScene, createReviewCache } from '../../viewer/src/review_scene.js';
import { executeView, cloneInWorld } from '../../viewer/src/viewport.js';
import { refuseForeign, readBody } from '../../viewer/server_http.js';

const source = fs.readFileSync(new URL('../../viewer/src/review_scene.js', import.meta.url), 'utf8');

test('the production builder awaits botanical dependencies and builds mature full detail', async () => {
  const start = source.indexOf('export async function buildReviewGroup(');
  const end = source.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start);
  const events = [];
  const build = new Function('activeDesign', 'preparePlantTextures', 'ensureAssets',
    'assetsNeededBy', 'ensureObjectModels', 'objectModelsNeededBy', 'buildDesignGroup',
    source.slice(start, end + 2).replace('export ', '') + '; return buildReviewGroup;')(
      d => ({...d, active: true}), async () => { await new Promise(resolve => setTimeout(resolve, 10)); events.push('textures'); },
      async () => { await Promise.resolve(); events.push('plants'); }, () => [],
      async () => { await Promise.resolve(); events.push('objects'); }, () => [],
      (d, ground, growth, opts) => {
        assert.deepEqual(events, ['textures', 'plants', 'objects']);
        assert.equal(d.active, true); assert.equal(growth, 1); assert.equal(opts.quality, 'detailed');
        return 'built';
      });
  assert.equal(await build({plants: []}, () => 0), 'built');
});

for (const fail of [false, true]) test(`review restores scene and frame on ${fail ? 'failure' : 'success'}`, async () => {
  const parent = new THREE.Group(), shown = new THREE.Group(), review = new THREE.Group();
  parent.rotation.y = 0.61; parent.position.set(4, 0, -3);
  parent.add(shown); shown.visible = false;
  const plant = new THREE.Object3D(); plant.position.set(2, 1, -7); review.add(plant);
  let release, disposed = false, entered = false;
  const prepared = new Promise(r => { release = r; });
  const work = withReviewScene({ design: {}, parent, displayed: shown,
    build: async () => { await prepared; return review; }, dispose: g => {
      assert.equal(g, review); disposed = true;
    } }, async group => {
      entered = true;
      assert.equal(shown.parent, null); assert.equal(group.parent, parent);
      const expected = plant.position.clone().applyMatrix4(parent.matrixWorld);
      assert.ok(expected.distanceTo(plant.getWorldPosition(new THREE.Vector3())) < 1e-9);
      // An owner poll can replace the contents without changing the review.
      shown.add(new THREE.Group());
      if (fail) throw Error('render failed');
      return 'frame';
    });
  assert.equal(entered, false); assert.equal(shown.parent, parent);
  release();
  if (fail) await assert.rejects(work, /render failed/); else assert.equal(await work, 'frame');
  assert.equal(disposed, true); assert.deepEqual(parent.children, [shown]);
  assert.equal(shown.parent, parent);
  assert.equal(shown.visible, false);
});

test('failed preparation leaves the owner scene in place', async () => {
  const parent = new THREE.Group(), displayed = new THREE.Group(); parent.add(displayed);
  await assert.rejects(withReviewScene({parent, displayed, build: async () => { throw Error('assets'); }},
    () => assert.fail('must not draw')), /assets/);
  assert.deepEqual(parent.children, [displayed]);
});

function renderContext() {
  const scene = new THREE.Scene(), enuGroup = new THREE.Group(); scene.add(enuGroup);
  enuGroup.rotation.y = 0.61; scene.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera(); camera.position.set(1, 2, 3);
  let inside = false, rendered = 0;
  const renderer = {
    shadowMap: {enabled: true}, getSize: p => p.set(700, 400), getPixelRatio: () => 2,
    setPixelRatio() {}, setSize() {},
    getContext: () => ({isContextLost: () => false, drawingBufferWidth: 1, drawingBufferHeight: 1,
      readPixels(x,y,w,h,fmt,type,buf) { buf[0] = 100; }}),
    render() { assert.equal(inside, true, 'render bypassed prepared review'); rendered++; },
    domElement: {toDataURL: () => 'data:image/jpeg;base64,AA=='},
  };
  return { scene, enuGroup, camera, renderer, getSite: () => ({}),
    getDesign: () => ({plants: [], paths: [{id:'walk', spline:[[0,0],[3,2]], width_m:1}]}),
    getPreviewSource: () => 'data/designs/_proposal.json',
    heightAt: () => 1, enuToWorld: (x,y,h) => new THREE.Vector3(x,h,-y),
    enuToWorldPoint: (x,y,h) => enuGroup.localToWorld(new THREE.Vector3(x,h,-y)),
    worldToEnu: p => { const v = enuGroup.worldToLocal(p.clone()); return [v.x, -v.z]; },
    withReview: async (d, run) => { inside = true; try { return await run(new THREE.Group()); }
      finally { inside = false; } }, rendered: () => rendered };
}

for (const op of ['look', 'walkthrough']) test(`${op} draws through the shared review and reports its source`, async () => {
  const ctx = renderContext();
  const before = ctx.camera.position.clone();
  const r = await executeView({op, eye:[1,2,1.65], look_at:[3,4,1], n:1}, ctx);
  assert.ok(ctx.rendered() > 0);
  const meta = r.meta ?? r.data;
  assert.equal(meta.render_quality, 'detailed'); assert.equal(meta.growth, 'mature');
  assert.equal(meta.design_source, 'data/designs/_proposal.json');
  assert.deepEqual(ctx.camera.position, before);
});

test('review readiness refuses instead of silently falling back to preview plants', async () => {
  const ctx = renderContext(); delete ctx.withReview;
  await assert.rejects(executeView({op:'look'}, ctx), /review is not ready/);
  assert.equal(ctx.rendered(), 0);
});

test('path-trace export keeps actual world placement at nonzero yaw', () => {
  const parent = new THREE.Group(), node = new THREE.Group();
  parent.rotation.y = 0.72; parent.position.set(3,4,-5); parent.add(node);
  node.position.set(2,1,-7);
  const child = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()); node.add(child);
  parent.updateMatrixWorld(true);
  const before = new THREE.Box3().setFromObject(node);
  const clone = cloneInWorld(node), exported = new THREE.Group(); exported.add(clone);
  exported.updateMatrixWorld(true);
  const after = new THREE.Box3().setFromObject(exported);
  assert.ok(before.min.distanceTo(after.min) < 1e-9);
  assert.ok(before.max.distanceTo(after.max) < 1e-9);
});

test('a look reads the current preview document before building, even between poll ticks', async () => {
  const ctx = renderContext(), current = {plants: [], paths: []};
  ctx.getReviewDesign = async () => current;
  const prepare = ctx.withReview;
  ctx.withReview = (d, run) => { assert.equal(d, current); return prepare(d, run); };
  await executeView({eye:[1,2], look_at:[3,4]}, ctx);
});

test('the real broker gives drawing requests time to prepare full detail', () => {
  const src = fs.readFileSync(new URL('../../viewer/vite.config.js', import.meta.url), 'utf8');
  const start = src.indexOf('function brokerRequest('), end = src.indexOf('\n/** Serve', start);
  assert.ok(start >= 0 && end > start);
  for (const op of [undefined, 'look', 'walkthrough', 'export_scene', 'preview']) {
    let timeout, onTimeout, result;
    const viewBroker = {subscribers:new Set([{write(){}}]), pending:new Map()};
    const call = new Function('viewBroker', 'randomUUID', 'setTimeout',
      src.slice(start,end) + ';return brokerRequest;')(viewBroker, () => 'test',
        (fn, ms) => { onTimeout = fn; timeout = ms; return 'timer'; });
    call({op}, r => {result = r;});
    assert.equal(timeout, op === 'preview' ? 30000 : 180000);
    onTimeout(); assert.equal(result.error, 'timeout');
    assert.ok(result.detail.includes(`${timeout / 1000} s`));
  }
});


test('unchanged proposals reuse detail, while edits and ground changes invalidate it', async () => {
  const disposed = [], built = [];
  const cached = createReviewCache(g => disposed.push(g), async design => {
    const g = {number:built.length, design}; built.push(g); return g;
  });
  const d = {plants:[]}, terrain = {};
  const first = await cached(d, () => 0, {yaw:0.4}, terrain);
  assert.equal(await cached({...d}, () => 0, {yaw:0.4}, terrain), first);
  assert.equal(built.length, 1);
  d.plants.push({id:'new'});
  const edited = await cached(d, () => 0, {yaw:0.4}, terrain);
  assert.notEqual(edited, first); assert.deepEqual(disposed, [first]);
  assert.notEqual(await cached(d, () => 0, {yaw:0.7}, terrain), edited);
  assert.equal(built.length, 3);
  await cached(d, () => 0, {yaw:0.7}, {});
  assert.equal(built.length, 4); assert.equal(disposed.length, 3);
});

test('concurrent snapshots keep their own bytes and manual exports keep one cache', async () => {
  const src = fs.readFileSync(new URL('../../viewer/vite.config.js', import.meta.url), 'utf8');
  const start = src.indexOf('if (req.method === "POST" && url === "/api/view/export")');
  const end = src.indexOf('\n        }', start) + '\n        }'.length;
  assert.ok(start >= 0 && end > start);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pedon-export-'));
  // the route reaches its folder through the active project's data/: give it one here
  const dataPath = (...p) => path.join(root, 'data', ...p);
  const route = new Function('req', 'res', 'url', 'fs', 'path', 'repoRoot', 'randomUUID', 'dataPath',
                             'refuseForeign', 'readBody', src.slice(start,end));
  const request = async (bytes, snapshot) => {
    const req = new EventEmitter(); req.method = 'POST';
    req.headers = {origin:'http://localhost:5178', ...(snapshot ? {'x-yardtwin-snapshot':'1'} : {})};
    let reply;
    const res = {setHeader(){}, end(body){reply = JSON.parse(body);}};
    route(req, res, '/api/view/export', fs, path, root, randomUUID, dataPath, refuseForeign, readBody);
    req.emit('data', Buffer.from(bytes)); req.emit('end');
    await new Promise(r => setImmediate(r));          // the body is read, then the route answers
    assert.equal(reply.ok, true);
    return path.join(root, reply.path);   // reply.path is data/photoreal/…, under root
  };
  try {
    const first = await request('proposal A', true), second = await request('proposal B', true);
    const cache = await request('manual export', false);
    assert.notEqual(first, second);
    assert.equal(fs.readFileSync(first, 'utf8'), 'proposal A');
    assert.equal(fs.readFileSync(second, 'utf8'), 'proposal B');
    assert.equal(path.basename(cache), 'scene.glb');
    assert.equal(await request('new manual export', false), cache);
    assert.equal(fs.readFileSync(cache, 'utf8'), 'new manual export');
    assert.equal(fs.readdirSync(path.dirname(cache)).length, 3);
  } finally { fs.rmSync(root, {recursive:true, force:true}); }
});
