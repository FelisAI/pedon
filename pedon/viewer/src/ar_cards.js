// THE GARDEN, AS A PHONE CAN CARRY IT INTO THE YARD.
//
// The phone must show the trees and plants clearly at their intended size.
//
// In RealityKit, the engine AR Quick Look runs on, a whole-site scan drawn as a flat
// grey shell can cover the design. Plants drawn as 3.5 cm rings and 2.4 cm posts are
// hard to see even without the scan on top. Real foliage is too large for the phone:
// full detail runs past a gigabyte, and even Fast preview is millions of triangles for
// a garden of a hundred-odd plants.
//
// So each plant travels as a PICTURE of itself — its own full-detail model, drawn once
// per species from the side and from above, on three crossed cards (and a card across
// the top for low spreading plants). About 30 triangles a plant instead of
// 6,000-155,000, and it looks like the plant, at mature size, where it will be planted.
//
// The scan is omitted: on site it duplicates what the camera shows and covers the
// garden. The owner's landmarks provide alignment — a post and their name for it —
// and the model's origin is the landmark nearest the planting, because Quick Look sets
// a model's ORIGIN down on the ground it finds.
import * as THREE from "three";
import { enuToWorld } from "./design.js";

export const CARD_PREFIX = "plant-card";        // ar_export.py never decimates these
export const LANDMARK_PREFIX = "ar-landmark";   // nor these
const ALPHA_CUT = 0.5;
const CARD_PX = 512;                            // the long side of a plant's side view
export const SIDES = 3;                         // cards crossed at 60 deg

const r2 = v => Number.isFinite(v) ? Math.round(v * 100) / 100 : "";

/** Plants that draw alike share one picture: species, model, size and colours. */
export function cardKey(p) {
  return [p.species ?? p.common ?? "?", p.asset ?? "", r2(p.mature_height_m), r2(p.mature_spread_m),
          p.foliage ?? "", p.flower ?? ""].join("|");
}

/** One stand-in per key, at the origin: the plant each picture is taken of. */
export function cardSubjects(plants) {
  const out = new Map();
  for (const p of plants ?? []) {
    const k = cardKey(p);
    if (!out.has(k)) out.set(k, { ...p, id: `card-subject-${out.size}`, position: [0, 0] });
  }
  return out;
}

/** Low and spreading plants are mostly seen from ABOVE, so they get a card across the top. */
export function wantsTopCard(height, spread) {
  return Number.isFinite(height) && Number.isFinite(spread) && height <= spread;
}

/** A plant's own turn, from its id, so a drift of one species is not forty identical stars. */
export function yawOf(id) {
  let h = 2166136261;
  for (const ch of String(id ?? "")) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) / 4294967296) * Math.PI * 2;
}

/**
 * Append one quad as TWO faces, front and back.
 *
 * Not one double-sided face: Quick Look lights a double-sided back face with its normal
 * turned away, so a card would go light and dark as it turned. Corners run bottom-left,
 * bottom-right, top-right, top-left, counter-clockwise seen from the front. `mirrorBack`
 * flips u on the back face, so text reads the right way round from behind.
 */
export function pushQuad(out, corners, { u = [0, 1], v = [0, 1], normal, mirrorBack = false }) {
  const uvs = [[u[0], v[0]], [u[1], v[0]], [u[1], v[1]], [u[0], v[1]]];
  const back = mirrorBack ? [[u[1], v[0]], [u[0], v[0]], [u[0], v[1]], [u[1], v[1]]] : uvs;
  for (const [tri, tex, face] of [[[0, 1, 2], uvs, 1], [[0, 2, 3], uvs, 1], [[0, 2, 1], back, -1], [[0, 3, 2], back, -1]])
    for (const i of tri) {
      const p = corners[i];
      out.pos.push(p.x, p.y, p.z);
      const n = normal(p, face);
      out.nor.push(n.x, n.y, n.z);
      out.uv.push(...tex[i]);
    }
}

function geometryOf(out) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(out.pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(out.nor, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(out.uv, 2));
  return g;
}

/**
 * The cards for every plant that shares one picture, as ONE mesh's geometry.
 *
 * `card` = { w, h, base, side: { u, v }, top: null | { w, d, y, u, v } }: metres, and
 * where each view sits in the atlas. `instances` = [{ x, y, z, yaw }], y the ground under
 * the plant. The normals are the PLANT's, not the card's — tipped up and out from its
 * stem, like a dome, and the same on both faces — so the three cards shade as one plant
 * instead of a star with one bright blade.
 */
export function cardGeometry(instances, card) {
  const out = { pos: [], nor: [], uv: [] };
  for (const it of instances) {
    const c = new THREE.Vector3(it.x, it.y, it.z);
    const normal = p => {
      const d = new THREE.Vector3(p.x - c.x, 0, p.z - c.z);
      if (d.lengthSq() > 1e-9) d.normalize().multiplyScalar(0.6);
      return d.add(new THREE.Vector3(0, 1, 0)).normalize();
    };
    for (let k = 0; k < SIDES; k++) {
      const a = (it.yaw ?? 0) + (k * Math.PI) / SIDES;
      const u = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a)).multiplyScalar(card.w / 2);
      const lo = c.clone().setY(it.y + card.base), hi = c.clone().setY(it.y + card.base + card.h);
      pushQuad(out, [lo.clone().sub(u), lo.clone().add(u), hi.clone().add(u), hi.clone().sub(u)],
               { ...card.side, normal });
    }
    if (card.top) {
      const a = it.yaw ?? 0;
      const u = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a)).multiplyScalar(card.top.w / 2);
      const f = new THREE.Vector3(-Math.sin(a), 0, -Math.cos(a)).multiplyScalar(card.top.d / 2);
      const at = (s, t) => c.clone().setY(it.y + card.top.y).addScaledVector(u, s).addScaledVector(f, t);
      // counter-clockwise seen from ABOVE, so the front faces the sky
      pushQuad(out, [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)], { u: card.top.u, v: card.top.v, normal });
    }
  }
  return geometryOf(out);
}

/**
 * Which landmark the model hangs from, and which one turns it.
 *
 * Quick Look puts a model's ORIGIN on the ground it finds, and a two-finger turn
 * rotates about it. So the origin is a landmark the user can stand on — nearest to the
 * planting — and the second is the nearest other one at least `minApart` metres from
 * it: two posts a metre apart fix the turn only to within degrees, and a degree is
 * 17 cm at a bed 10 m away. Owner landmarks only; they are ground truth.
 */
export function chooseAnchors(landmarks, centre, minApart = 4) {
  const lms = (landmarks ?? []).filter(l => Number.isFinite(l?.x) && Number.isFinite(l?.y));
  if (!lms.length) return { origin: null, second: null };
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const c = { x: centre[0], y: centre[1] };
  const byNear = [...lms].sort((a, b) => d(a, c) - d(b, c));
  const origin = byNear[0];
  const second = byNear.find(l => l !== origin && d(l, origin) >= minApart) ?? null;
  return { origin, second };
}

/** Where the planting is, as the mean of the plants: the landmarks are chosen against it. */
export function plantingCentre(plants) {
  const ps = (plants ?? []).filter(p => Array.isArray(p.position));
  if (!ps.length) return [0, 0];
  return [ps.reduce((s, p) => s + p.position[0], 0) / ps.length,
          ps.reduce((s, p) => s + p.position[1], 0) / ps.length];
}

/** "fence_corner_southeast" -> "fence corner southeast": the owner's name, as spoken. */
export const spokenName = name => String(name ?? "").replace(/_/g, " ").trim();

// ── what needs a browser: pictures and text ────────────────────────────────────

/**
 * Draw each stand-in plant from the side and from above, into one atlas per plant.
 *
 * A SEPARATE small renderer, not the viewer's: the viewer's is showing the site, and a
 * render target there would carry none of its tone mapping. The plant is lit evenly
 * (sky, ground bounce, a sun over the shoulder) because the picture is lit AGAIN on the
 * phone. The shadow disc is left out: seen from the side it is a black bar.
 * `subjects` = Map key -> the built plant, standing at the origin.
 */
export function renderCards(subjects, like) {
  const canvas = document.createElement("canvas");
  const r = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
  r.outputColorSpace = like?.outputColorSpace ?? THREE.SRGBColorSpace;
  r.toneMapping = like?.toneMapping ?? THREE.NoToneMapping;
  r.toneMappingExposure = like?.toneMappingExposure ?? 1;
  r.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xeef3ff, 0x6b5a45, 1.7));
  const sun = new THREE.DirectionalLight(0xffffff, 2.0);
  sun.position.set(2, 4, 5);
  scene.add(sun);
  const out = new Map();
  try {
    for (const [key, plant] of subjects) {
      const parent = plant.parent;
      plant.traverse(o => { if (o.name === "shadow") o.visible = false; });
      scene.add(plant);
      plant.position.set(0, 0, 0);
      plant.updateMatrixWorld(true);
      const box = new THREE.Box3();
      plant.traverse(o => { if (o.isMesh && o.visible) box.expandByObject(o, true); });
      if (!box.isEmpty()) {
        const halfW = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), 0.05);
        const halfD = Math.max(Math.abs(box.min.z), Math.abs(box.max.z), 0.05);
        const base = Math.max(Math.min(box.min.y, 0), -0.1), top = Math.max(box.max.y, base + 0.05);
        const side = shoot(r, scene, { w: 2 * halfW, h: top - base, from: "side", base });
        const above = wantsTopCard(top, 2 * Math.max(halfW, halfD))
          ? shoot(r, scene, { w: 2 * halfW, h: 2 * halfD, from: "top", top }) : null;
        // side and top side by side in ONE picture, so one material per species;
        // each sits on the atlas's bottom edge, which is v = 0
        const atlas = document.createElement("canvas");
        atlas.width = side.width + (above?.width ?? 0);
        atlas.height = Math.max(side.height, above?.height ?? 0);
        const ctx = atlas.getContext("2d");
        ctx.drawImage(side, 0, atlas.height - side.height);
        if (above) ctx.drawImage(above, side.width, atlas.height - above.height);
        const su = side.width / atlas.width;
        out.set(key, { atlas, card: {
          w: 2 * halfW, h: top - base, base,
          side: { u: [0, su], v: [0, side.height / atlas.height] },
          top: above ? { w: 2 * halfW, d: 2 * halfD, y: Math.min(top * 0.55, top - 0.05),
                         u: [su, 1], v: [0, above.height / atlas.height] } : null } });
      }
      scene.remove(plant);
      parent?.add(plant);
    }
  } finally {
    r.dispose();
    r.forceContextLoss();
  }
  return out;
}

function shoot(r, scene, { w, h, from, base = 0, top = 0 }) {
  const scale = CARD_PX / Math.max(w, h);
  const W = Math.max(16, Math.ceil(w * scale)), H = Math.max(16, Math.ceil(h * scale));
  const cam = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, 0.01, 200);
  if (from === "side") { cam.position.set(0, base + h / 2, 50); cam.lookAt(0, base + h / 2, 0); }
  else { cam.position.set(0, top + 50, 0); cam.up.set(0, 0, -1); cam.lookAt(0, 0, 0); }
  r.setSize(W, H, false);
  r.render(scene, cam);
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  c.getContext("2d").drawImage(r.domElement, 0, 0, W, H);
  return c;
}

/** The one mesh for every plant that shares a picture. */
export function cardMesh(species, instances, { atlas, card }) {
  const tex = new THREE.CanvasTexture(atlas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshStandardMaterial({
    name: `${CARD_PREFIX}:${species}`, map: tex, alphaTest: ALPHA_CUT, roughness: 1, metalness: 0,
    // the picture is already lit; a little of it glows so the side away from the
    // phone's light estimate reads as a plant in shade, not a black cut-out
    emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.35,
  });
  const mesh = new THREE.Mesh(cardGeometry(instances, card), mat);
  mesh.name = `${CARD_PREFIX}:${species}`;
  mesh.userData = { plants: instances.length };
  return mesh;
}

/**
 * An orange post, a ring on the ground and the owner's name for it, at one landmark.
 * The label turns to face `towards` (the planting, where the user looks from).
 */
export function landmarkPost(lm, heightAt, { origin = false, towards = null } = {}) {
  const g = new THREE.Group();
  g.name = `${LANDMARK_PREFIX}:${lm.name}`;
  const p = enuToWorld(lm.x, lm.y, 0);
  p.y = heightAt(p.x, p.z);
  if (!Number.isFinite(p.y)) p.y = 0;
  const colour = origin ? 0xff4d2e : 0xff9a1f;
  const mat = new THREE.MeshStandardMaterial({ name: `${LANDMARK_PREFIX}-paint`, color: colour,
                                               emissive: colour, emissiveIntensity: 0.4, roughness: 0.8 });
  const postH = 1.4;
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, postH, 10), mat);
  post.name = `${LANDMARK_PREFIX}-post`;
  post.position.set(p.x, p.y + postH / 2, p.z);
  // the ring is the exact point: the post's foot is hidden in grass, the ring is not
  const ring = { pos: [], nor: [], uv: [] };
  const up = () => new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < 32; i++) {
    const a0 = (i / 32) * Math.PI * 2, a1 = ((i + 1) / 32) * Math.PI * 2;
    const at = (r, a) => new THREE.Vector3(p.x + r * Math.cos(a), p.y + 0.01, p.z - r * Math.sin(a));
    pushQuad(ring, [at(0.1, a0), at(0.18, a0), at(0.18, a1), at(0.1, a1)], { normal: up });
  }
  const ringMesh = new THREE.Mesh(geometryOf(ring), mat);
  ringMesh.name = `${LANDMARK_PREFIX}-ring`;
  g.add(post, ringMesh);
  const label = labelCard(spokenName(lm.name) + (origin ? " — start here" : ""));
  if (label) {
    label.position.set(p.x, p.y + postH + 0.2, p.z);
    if (towards) label.rotation.y = Math.atan2(towards.x - p.x, towards.z - p.z);
    g.add(label);
  }
  return g;
}

function labelCard(text) {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  const font = "600 64px -apple-system, system-ui, sans-serif";
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 48;
  c.width = w; c.height = 96;
  ctx.font = font;                        // resizing a canvas resets its context
  ctx.fillStyle = "rgba(20,18,14,0.85)";
  ctx.fillRect(0, 0, w, 96);
  ctx.fillStyle = "#ffe9cf";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 24, 50);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const h = 0.22, hw = ((w / 96) * h) / 2;
  const quad = { pos: [], nor: [], uv: [] };
  const v = (x, y) => new THREE.Vector3(x, y, 0);
  // lit flat, facing whoever reads it
  pushQuad(quad, [v(-hw, -h / 2), v(hw, -h / 2), v(hw, h / 2), v(-hw, h / 2)],
           { normal: (_p, face) => new THREE.Vector3(0, 0, face), mirrorBack: true });
  const mat = new THREE.MeshStandardMaterial({ name: `${LANDMARK_PREFIX}-label`, map: tex, emissive: 0xffffff,
                                               emissiveMap: tex, emissiveIntensity: 0.8, roughness: 1 });
  const mesh = new THREE.Mesh(geometryOf(quad), mat);
  mesh.name = `${LANDMARK_PREFIX}-label`;
  return mesh;
}

/**
 * The whole AR scene for one design: hardscape as drawn, a picture card per plant, a
 * post at each landmark — shifted so the ORIGIN landmark's ground is (0, 0, 0).
 *
 * Only ONE plant per picture is built at full detail. Building every plant as the
 * review scene does, then discarding them for markers, adds most of a two-minute
 * export without contributing to the file.
 * `deps` carries what lives in other modules so this can be tested with stand-ins.
 */
export async function buildArScene(design, { heightAt, site, like, deps }) {
  const phases = {};
  let t = performance.now();
  const lap = name => { const now = performance.now(); phases[name] = Math.round(now - t); t = now; };
  const plants = design.plants ?? [];

  await deps.ensureObjectModels(deps.objectModelsNeededBy(design));
  const hardscape = await deps.buildDesignGroup({ ...design, plants: [] }, heightAt, 1, {});
  hardscape.name = "design";
  lap("hardscape_ms");

  const subjects = cardSubjects(plants);
  const standIns = { plants: [...subjects.values()] };
  await deps.preparePlantTextures();
  await deps.ensureAssets(deps.assetsNeededBy(standIns));
  const built = await deps.buildDesignGroup(standIns, () => 0, 1, { quality: "detailed" });
  const byId = new Map();
  for (const child of [...built.children]) if (child.userData?.id !== undefined) byId.set(child.userData.id, child);
  const models = new Map([...subjects].map(([k, p]) => [k, byId.get(p.id)]).filter(([, m]) => m));
  lap("plant_models_ms");
  const pictures = (deps.renderCards ?? renderCards)(models, like);
  lap("pictures_ms");

  const cards = new THREE.Group();
  cards.name = "planting";
  const groups = new Map();
  for (const p of plants) {
    const k = cardKey(p);
    if (!pictures.has(k)) continue;
    const w = enuToWorld(p.position[0], p.position[1], 0);
    const y = heightAt(w.x, w.z);
    (groups.get(k) ?? groups.set(k, { species: p.species ?? p.common ?? "plant", at: [] }).get(k))
      .at.push({ x: w.x, y: Number.isFinite(y) ? y : 0, z: w.z, yaw: yawOf(p.id) });
  }
  for (const [k, { species, at }] of groups) cards.add(cardMesh(species, at, pictures.get(k)));
  lap("cards_ms");

  const centre = plantingCentre(plants);
  const lms = site?.landmarks ?? [];
  const { origin, second } = chooseAnchors(lms, centre);
  const posts = new THREE.Group();
  posts.name = LANDMARK_PREFIX;
  const towards = enuToWorld(centre[0], centre[1], 0);
  for (const lm of lms) posts.add(landmarkPost(lm, heightAt, { origin: lm === origin, towards }));

  const root = new THREE.Group();
  root.name = "yard";
  root.add(hardscape, cards, posts);
  let shift = null;
  if (origin) {
    const o = enuToWorld(origin.x, origin.y, 0);
    o.y = heightAt(o.x, o.z);
    if (!Number.isFinite(o.y)) o.y = 0;
    root.position.copy(o).negate();
    shift = [o.x, o.y, o.z];
  }
  root.updateMatrixWorld(true);
  const d = (a, b) => a && b ? Math.round(Math.hypot(a.x - b.x, a.y - b.y) * 10) / 10 : null;
  // WHERE EACH LANDMARK IS IN THE FILE'S OWN FRAME — metres, Y up, origin on the start
  // landmark's ground. The phone app lines the garden up by two of these: the user taps the
  // real spots, and the turn and the move follow. The frame is the one RealityKit loads.
  const at = lm => {
    const p = enuToWorld(lm.x, lm.y, 0);
    p.y = heightAt(p.x, p.z);
    if (!Number.isFinite(p.y)) p.y = 0;
    p.add(root.position);
    return [p.x, p.y, p.z].map(v => Math.round(v * 1000) / 1000);
  };
  return { root, phases, info: {
    plants: [...groups.values()].reduce((s, g) => s + g.at.length, 0), plants_in_design: plants.length,
    species: groups.size, landmarks: lms.map(l => ({ name: l.name, at: at(l) })),
    plan: arPlan(design, root.position), ground: arGround(design, heightAt, root.position),
    origin: origin?.name ?? null, second: second?.name ?? null, apart_m: d(origin, second),
    shift } };
}


// ── WHAT THE PHONE NEEDS TO LET YOU PICK YOUR OWN MARKS ─────────────────────
//
// The user must be able to pick their own alignment marks for any site. The app draws
// this legacy plan for older consumers. Native alignment now picks measured surface
// points on the separate original capture (ar_scan.js); proposed features are not real
// reference points. All in the file's frame: metres, x and z on the ground, the origin on the
// start landmark (or the design's own origin).

const r2cm = v => Math.round(v * 100) / 100;

/** The design's outlines and things, as a plan in the file's frame. */
export function arPlan(design, shift) {
  const P = ([x, y]) => { const w = enuToWorld(x, y, 0).add(shift); return [r2cm(w.x), r2cm(w.z)]; };
  const named = o => o.name ?? o.label ?? o.id ?? "";
  return {
    beds: (design.beds ?? []).filter(b => b.polygon?.length > 2).map(b => ({ name: named(b), poly: b.polygon.map(P) })),
    patios: (design.patios ?? []).filter(b => b.polygon?.length > 2).map(b => ({ name: named(b), poly: b.polygon.map(P) })),
    // paths, edges (walls) and steps are drawn as `spline` in every saved design
    paths: [...(design.paths ?? []), ...(design.edges ?? []), ...(design.steps ?? [])]
      .filter(p => (p.spline ?? p.points)?.length > 1)
      .map(p => ({ name: named(p), pts: (p.spline ?? p.points).map(P), width: p.width_m ?? 0.3 })),
    plants: (design.plants ?? []).filter(p => Array.isArray(p.position))
      .map(p => ({ name: p.common ?? p.species ?? "plant", at: P(p.position), r: r2cm((p.mature_spread_m ?? 0.5) / 2),
                   colour: p.flower ?? p.foliage ?? null })),
    objects: (design.objects ?? []).filter(o => Array.isArray(o.position)).map(o => ({ name: o.kind ?? "object", at: P(o.position) })),
  };
}

/**
 * The ground's height over the design, every half metre, relative to the origin: a mark
 * on ANY picked point needs the height there, beyond the heights of named landmarks.
 */
export function arGround(design, heightAt, shift, step = 0.5, margin = 2) {
  const pts = [];
  for (const b of [...(design.beds ?? []), ...(design.patios ?? [])]) for (const q of b.polygon ?? []) pts.push(q);
  for (const p of [...(design.paths ?? []), ...(design.edges ?? []), ...(design.steps ?? [])])
    for (const q of p.spline ?? p.points ?? []) pts.push(q);
  for (const p of [...(design.plants ?? []), ...(design.objects ?? [])]) if (Array.isArray(p.position)) pts.push(p.position);
  if (!pts.length) return null;
  const xs = pts.map(q => enuToWorld(q[0], q[1], 0)).map(w => [w.x, w.z]);
  const x0 = Math.min(...xs.map(q => q[0])) - margin, z0 = Math.min(...xs.map(q => q[1])) - margin;
  const nx = Math.ceil((Math.max(...xs.map(q => q[0])) + margin - x0) / step) + 1;
  const nz = Math.ceil((Math.max(...xs.map(q => q[1])) + margin - z0) / step) + 1;
  const h = [];
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const y = heightAt(x0 + i * step, z0 + j * step);
    h.push(Number.isFinite(y) ? r2cm(y + shift.y) : null);
  }
  return { x0: r2cm(x0 + shift.x), z0: r2cm(z0 + shift.z), step, nx, nz, h };
}
