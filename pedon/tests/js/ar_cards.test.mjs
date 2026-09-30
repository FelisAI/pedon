// node --test tests/js/ar_cards.test.mjs
//
// THE PLANTS GO TO THE PHONE AS PICTURES OF THEMSELVES.
//
// The plants are what the user needs to see on the phone. Measured in RealityKit, the
// engine AR Quick Look runs on: with the scan, the scan is a grey shell over the whole
// yard and the planting 3.5 cm rings underneath it. Real foliage is 1.5 GB; Fast preview
// is 3.9 M triangles. So each species is photographed once at full detail and every
// plant is crossed cards of that picture — and what is tested here is that every plant
// is there, where it stands, at its size, and that the model hangs from one of the
// owner's landmarks.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "../../viewer/node_modules/three/build/three.module.js";

// a canvas that draws nothing: the labels need a 2D context, not pixels
globalThis.document ??= { createElement() { return { width: 0, height: 0, getContext: () => new Proxy({
  measureText: () => ({ width: 120 }) }, { get: (o, k) => o[k] ?? (() => {}) }) }; } };

const { cardKey, cardSubjects, cardGeometry, chooseAnchors, plantingCentre, yawOf, wantsTopCard,
        buildArScene, arPlan, arGround, SIDES, CARD_PREFIX, LANDMARK_PREFIX } = await import("../../viewer/src/ar_cards.js");

const CARD = { w: 1.2, h: 0.9, base: -0.02, side: { u: [0, 0.6], v: [0, 1] },
               top: { w: 1.2, d: 1.0, y: 0.5, u: [0.6, 1], v: [0, 0.8] } };

/** geometric normal of triangle t — the winding, which is what culling reads */
function faceNormal(pos, t) {
  const v = i => new THREE.Vector3().fromBufferAttribute(pos, t * 3 + i);
  const a = v(0), b = v(1), c = v(2);
  return b.clone().sub(a).cross(c.clone().sub(a)).normalize();
}

test("plants that draw alike share one picture, and each picture is taken of ONE stand-in at the origin", () => {
  const plants = [
    { id: "a", species: "Salvia apiana", mature_height_m: 1, mature_spread_m: 1.4, position: [3, 4] },
    { id: "b", species: "Salvia apiana", mature_height_m: 1, mature_spread_m: 1.4, position: [5, 1] },
    { id: "c", species: "Salvia apiana", mature_height_m: 1.5, mature_spread_m: 1.4, position: [0, 0] },
    { id: "d", species: "Salvia apiana", mature_height_m: 1, mature_spread_m: 1.4, flower: "#ffffff", position: [0, 0] },
  ];
  assert.equal(cardKey(plants[0]), cardKey(plants[1]));
  assert.notEqual(cardKey(plants[0]), cardKey(plants[2]), "a taller plant drawn from a shorter one's picture is the wrong size");
  assert.notEqual(cardKey(plants[0]), cardKey(plants[3]), "a white-flowered one drawn from the other's picture is the wrong colour");
  const subjects = cardSubjects(plants);
  assert.equal(subjects.size, 3);
  const ids = [...subjects.values()].map(p => p.id);
  assert.equal(new Set(ids).size, 3, "stand-ins share an id, so one would be found for another");
  for (const p of subjects.values()) assert.deepEqual(p.position, [0, 0]);
  assert.deepEqual(plants[0].position, [3, 4], "the design's own plant was moved");
});

test("every plant is three crossed cards at its mature size, standing on its own ground", () => {
  const at = [{ x: 2, y: 1.3, z: -4, yaw: 0.4 }, { x: -1, y: 0.2, z: 7, yaw: 2.1 }];
  const g = cardGeometry(at, { ...CARD, top: null });
  const pos = g.getAttribute("position");
  // two faces per quad, two triangles per face
  assert.equal(pos.count, at.length * SIDES * 4 * 3);
  const per = SIDES * 4 * 3;
  at.forEach((it, i) => {
    const ys = [], reach = [];
    for (let k = i * per; k < (i + 1) * per; k++) {
      ys.push(pos.getY(k));
      reach.push(Math.hypot(pos.getX(k) - it.x, pos.getZ(k) - it.z));
    }
    assert.ok(Math.abs(Math.min(...ys) - (it.y + CARD.base)) < 1e-6, "the card does not start at the plant's ground");
    assert.ok(Math.abs(Math.max(...ys) - (it.y + CARD.base + CARD.h)) < 1e-6, "the card is not the plant's height");
    assert.ok(Math.abs(Math.max(...reach) - CARD.w / 2) < 1e-6, "the card is not the plant's spread");
  });
});

test("each card has a FRONT and a BACK face, and both are shaded as the one plant", () => {
  const g = cardGeometry([{ x: 0, y: 0, z: 0, yaw: 1 }], CARD);
  const pos = g.getAttribute("position"), nor = g.getAttribute("normal");
  const quads = pos.count / 12;
  assert.equal(quads, SIDES + 1, "a low spreading plant has its card across the top");
  for (let q = 0; q < quads; q++) {
    const front = faceNormal(pos, q * 4), back = faceNormal(pos, q * 4 + 2);
    assert.ok(front.dot(back) < -0.999, `quad ${q}: the back face is not wound the other way, so one side is culled away`);
    for (let k = q * 12; k < q * 12 + 12; k++) assert.ok(nor.getY(k) > 0.5, "a card normal points sideways: the three cards shade as a star");
  }
  // the top card lies flat at its height and faces the sky
  const topFront = faceNormal(pos, SIDES * 4);
  assert.ok(topFront.y > 0.999, "the top card's front faces the ground");
  for (let k = SIDES * 12; k < SIDES * 12 + 12; k++) assert.ok(Math.abs(pos.getY(k) - CARD.top.y) < 1e-6);
  // and every u reads from its own half of the atlas
  const uv = g.getAttribute("uv");
  for (let k = 0; k < SIDES * 12; k++) assert.ok(uv.getX(k) <= 0.6 + 1e-6, "a side card reads the top view");
  for (let k = SIDES * 12; k < uv.count; k++) assert.ok(uv.getX(k) >= 0.6 - 1e-6, "the top card reads the side view");
});

test("a card goes across the top of low spreading plants, not of tall ones", () => {
  assert.equal(wantsTopCard(0.3, 0.6), true);
  assert.equal(wantsTopCard(2.1, 1.2), false);
  assert.equal(wantsTopCard(undefined, 1), false);
  assert.equal(yawOf("p12"), yawOf("p12"), "a plant turns differently every time the file is made");
  assert.notEqual(yawOf("p12"), yawOf("p13"));
});

test("the model hangs from the landmark nearest the planting, and turns on one far enough to fix the turn", () => {
  const lms = [{ name: "far", x: 20, y: 0 }, { name: "near", x: 1, y: 1 }, { name: "beside", x: 2, y: 1 },
               { name: "mid", x: 6, y: 2 }];
  const { origin, second } = chooseAnchors(lms, [0, 0]);
  assert.equal(origin.name, "near");
  assert.equal(second.name, "mid", "a post a metre from the first fixes the turn to within degrees");
  assert.deepEqual(chooseAnchors([], [0, 0]), { origin: null, second: null });
  assert.equal(chooseAnchors([lms[1], lms[2]], [0, 0]).second, null, "a second post too close is offered anyway");
  assert.deepEqual(plantingCentre([{ position: [0, 0] }, { position: [4, 2] }, {}]), [2, 1]);
});

test("the scene: hardscape without plants, ONE full-detail plant per picture, every plant carded, origin on the landmark", async () => {
  const design = {
    beds: [{ id: "bed" }],
    plants: [
      { id: "p1", species: "Muhlenbergia capillaris", mature_height_m: 0.95, mature_spread_m: 0.95, position: [10, -3] },
      { id: "p2", species: "Muhlenbergia capillaris", mature_height_m: 0.95, mature_spread_m: 0.95, position: [11, -4] },
      { id: "p3", species: "Salvia clevelandii", mature_height_m: 1.2, mature_spread_m: 2.4, position: [12, -2] },
    ],
  };
  const site = { landmarks: [{ name: "side_yard_hedge_row", x: 8.21, y: -1.88 }, { name: "south_fence_mid", x: -1.26, y: -13.81 }] };
  const heightAt = (x, z) => 0.1 * x - 0.05 * z;     // a slope, so ground matters
  const calls = [];
  const deps = {
    ensureObjectModels: async () => {}, objectModelsNeededBy: () => [],
    preparePlantTextures: async () => {}, ensureAssets: async () => {}, assetsNeededBy: () => [],
    buildDesignGroup: async (d, h, growth, opts) => {
      calls.push({ plants: (d.plants ?? []).length, quality: opts?.quality, beds: (d.beds ?? []).length });
      const g = new THREE.Group();
      for (const p of d.plants ?? []) { const m = new THREE.Group(); m.userData.id = p.id; g.add(m); }
      if (!(d.plants ?? []).length) g.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
      return g;
    },
    renderCards: models => new Map([...models.keys()].map(k => [k, {
      atlas: { width: 64, height: 64 }, card: { w: 1, h: 1, base: 0, side: { u: [0, 1], v: [0, 1] }, top: null } }])),
  };
  const { root, info } = await buildArScene(design, { heightAt, site, like: null, deps });

  const hard = calls.find(c => c.quality === undefined), full = calls.find(c => c.quality === "detailed");
  assert.equal(hard.plants, 0, "the hardscape was built WITH the plants, at full detail, for nothing");
  assert.equal(hard.beds, 1, "the hardscape lost its beds");
  assert.equal(full.plants, 2, "every plant was built at full detail: two pictures need two models, not three");

  const cards = root.children.find(c => c.name === "planting");
  const meshes = cards.children.filter(m => m.name.startsWith(CARD_PREFIX));
  assert.equal(meshes.length, 2);
  assert.equal(meshes.reduce((s, m) => s + m.userData.plants, 0), 3, "a plant is missing from the phone");
  assert.equal(info.plants, 3);
  assert.equal(info.plants_in_design, 3);

  // ORIGIN: the landmark nearest the planting, with its ground at (0, 0, 0)
  assert.equal(info.origin, "side_yard_hedge_row");
  assert.equal(info.second, "south_fence_mid");
  const o = new THREE.Vector3(8.21, heightAt(8.21, 1.88), 1.88);
  assert.ok(root.position.clone().add(o).length() < 1e-9, "the model does not hang from the landmark");
  // and the plant stands on ITS ground, relative to that
  const muhly = meshes.find(m => m.name.includes("Muhlenbergia"));
  muhly.geometry.computeBoundingBox();
  const lowest = muhly.geometry.boundingBox.min.y + root.position.y;
  const expect = Math.min(heightAt(10, 3), heightAt(11, 4)) - o.y;
  assert.ok(Math.abs(lowest - expect) < 1e-6, `the planting floats or sinks: ${lowest} vs ${expect}`);

  // each landmark's place in the FILE's frame, for the phone to line up by: the origin
  // landmark is (0, 0, 0) and the other is where its post stands
  const lmAt = Object.fromEntries(info.landmarks.map(l => [l.name, l.at]));
  assert.deepEqual(lmAt.side_yard_hedge_row, [0, 0, 0]);
  const fence = new THREE.Vector3(-1.26, heightAt(-1.26, 13.81), 13.81).add(root.position);
  assert.ok(new THREE.Vector3(...lmAt.south_fence_mid).distanceTo(fence) < 1e-3,
    "the app would line the garden up on a landmark that is not where its post is");
  const posts = root.children.find(c => c.name === LANDMARK_PREFIX);
  assert.equal(posts.children.length, 2, "a landmark has no post to line up on");
  assert.ok(!root.getObjectByName("scan") && !root.getObjectByName("stage"), "the scan came back");
});

test("the seams: the phone's scene skips the full-garden review build, is a snapshot, and is coloured", async () => {
  // A pure function is half a guard: all of the above passes with the call to it deleted.
  const fs = await import("node:fs");
  const read = p => fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
  const code = s => s.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const vp = code(read("viewer/src/viewport.js"));
  const exec = vp.slice(vp.indexOf("export async function executeView"));
  const branch = exec.indexOf('if (cmd.op === "export_scene" && cmd.plants === "cards")');
  assert.ok(branch > 0 && branch < exec.indexOf("return ctx.withReview("),
    "the phone's scene waits for every plant in the garden to be built at full detail, then throws them away");
  assert.match(exec.slice(branch, branch + 400), /const r = await execute\(full\);/);
  const op = vp.slice(vp.indexOf("async function exportSceneOp"));
  assert.match(op, /if \(cmd\.plants === "cards"\) \{[\s\S]{0,300}buildArScene\(design,[\s\S]{0,400}postGlb\(root, true\)/,
    "the phone's scene is not built, or is saved over photoreal's scene.glb");
  assert.match(code(read("viewer/src/main.js")), /colour: d => colourFromPalette\(d\)/,
    "the pictures are drawn without the palette's flower colours");
  assert.match(code(read("tools/ar_export.py")), /\{"op": "export_scene", "plants": "cards"\}/);
});


test("the phone gets a PLAN to pick its own marks on, and the ground's height all over it", () => {
  // The user picks the marks rather than being handed two fixed ones. Paths, edges and
  // steps are `spline` in every saved design; reading `points` instead draws none.
  const design = {
    beds: [{ id: "b", polygon: [[1, 1], [3, 1], [3, 2]] }],
    paths: [{ id: "walk", spline: [[0, 0], [4, 0]], width_m: 1 }],
    edges: [{ id: "wall", spline: [[0, 5], [2, 5]] }],
    steps: [{ id: "st", spline: [[5, 5], [5, 6]] }],
    plants: [{ id: "p", common: "Cleveland sage", position: [2, 1.5], mature_spread_m: 2.4 }],
    objects: [{ id: "o", kind: "bench", position: [4, 4] }],
  };
  const shift = new THREE.Vector3(-1, -0.5, 2);          // the origin landmark's ground, negated
  const plan = arPlan(design, shift);
  assert.deepEqual(plan.paths.map(p => p.name), ["walk", "wall", "st"], "a path, wall or steps is missing from the plan");
  assert.deepEqual(plan.paths[0].pts, [[-1, 2], [3, 2]], "ENU (x, y) is not the file's (x, z) = (x, -y) + shift");
  assert.deepEqual(plan.plants[0], { name: "Cleveland sage", at: [1, 0.5], r: 1.2, colour: null });
  assert.equal(plan.objects[0].name, "bench");
  const ground = arGround(design, (x, z) => 0.1 * x, shift);
  assert.ok(ground.nx > 4 && ground.nz > 4 && ground.h.length === ground.nx * ground.nz);
  // the height at a grid point is the ground there, relative to the origin
  const i = 3, j = 2, x = ground.x0 + i * ground.step;
  assert.ok(Math.abs(ground.h[j * ground.nx + i] - (0.1 * (x - shift.x) + shift.y)) < 0.011);
});
