// node --test tests/js/salvia.test.mjs
//
// Nineteen salvias, one object.
//
// A Mediterranean-fusion palette needs many salvias, and "too few salvias" has two
// readings that need different work: either the LIST is short, or the list is
// fine and every entry RENDERS THE SAME, so a bed with six sages in it shows one
// sage six times.
//
// Build each palette salvia with the SAME id and the SAME size, so neither seed
// nor scale can be credited for a difference, and the second reading shows: with
// one shared default, eight of eleven come out bit-identical — 10,302 vertices,
// one shape hash. White sage (near-white, long felted leaves), Berggarten sage
// (broad grey culinary paddles) and autumn sage (wiry, 2 cm glossy leaves) become
// the same mesh at three scales in three colours; only a species with a rule of
// its own (rosemary's needle, creeping rosemary's mat, chia's meadow) escapes.
//
// The same holds for any family drawn as one form — manzanita, rosemary and
// santolina all as `mound` come out the same shape at different scales — and it
// is why this file measures the SHAPE, not the list length. A longer list of the
// same object is a longer nursery order.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as THREE from "../../viewer/node_modules/three/build/three.module.js";
import { dataPath } from "../../viewer/project_paths.js";   // the active site's files
import { catalogue } from "./lib/library.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// A canvas real enough that leafTexture actually DRAWS. The minimal stub other
// files use makes leafTexture throw and return null, which would leave every
// plant maskless — and the card mesh is found below by its alphaTest, so a null
// mask would make this whole file measure the wrong mesh and pass for it.
globalThis.document = {
  createElement() {
    const ctx = { fillStyle: "#000", strokeStyle: "#000", lineWidth: 1, globalAlpha: 1,
      globalCompositeOperation: "source-over",
      fillRect() {}, clearRect() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
      bezierCurveTo() {}, quadraticCurveTo() {}, arc() {}, ellipse() {}, fill() {}, stroke() {},
      save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
      createLinearGradient: () => ({ addColorStop() {} }),
      createRadialGradient: () => ({ addColorStop() {} }) };
    return { width: 0, height: 0, getContext: () => ctx };
  },
};
const plants = await import(path.join(ROOT, "viewer", "src", "plants.js"));
const PALETTE = catalogue();

const isSalvia = p => /salvia|rosmarinus|\bsage\b/i.test(`${p.species} ${p.common}`);
const SALVIAS = PALETTE.filter(isSalvia);

/** The plant record, built at ONE seed and ONE size so only the tables can differ. */
const probe = (p, over = {}) => ({
  id: "SAME", species: p.species, common: p.common, form: p.form,
  mature_height_m: 1.2, mature_spread_m: 1.2,
  foliage: p.foliage, flower: p.flower, position: [0, 0], ...over,
});

const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
};

/** Every triangle of every mesh matching `pick`, in the plant's own frame. */
function tris(obj, pick) {
  obj.updateMatrixWorld(true);
  const out = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  obj.traverse(node => {
    const pos = node.geometry?.attributes?.position;
    if (!pos || !pick(node)) return;
    const idx = node.geometry.index;
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i += 3) {
      const [i0, i1, i2] = idx ? [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)] : [i, i + 1, i + 2];
      a.fromBufferAttribute(pos, i0).applyMatrix4(node.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(node.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(node.matrixWorld);
      out.push(Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)));
    }
  });
  return out;
}

const isCard = node => node.name === "foliage" && node.material?.alphaTest > 0;
const isSolid = node => node.name === "foliage" && !(node.material?.alphaTest > 0);

/** What the plant is made of: how many leaf cards, and how big one is. */
function leafSig(p, over) {
  const g = plants.buildPlant(probe(p, over));
  if(g.userData.shootModel) {
    const sizes=[],matrix=new THREE.Matrix4();let solid=0;
    g.traverse(n=>{if(n.name==='foliage'){
      n.geometry.computeBoundingBox();const span=n.geometry.boundingBox.getSize(new THREE.Vector3()).length();
      for(let i=0;i<n.count;i++){n.getMatrixAt(i,matrix);sizes.push(span*new THREE.Vector3().setFromMatrixColumn(matrix,0).length());}
      solid+=n.geometry.index.count/3*n.count;
    }});
    return {cards:sizes.length,size:median(sizes),solid,form:plants.growthForm(probe(p,over)),leaf:plants.leafClass(probe(p,over))};
  }
  const cards = tris(g, isCard);
  return { cards: cards.length / 2, size: median(cards),
           solid: tris(g, isSolid).length,
           form: plants.growthForm(probe(p, over)),
           leaf: plants.leafClass(probe(p, over)) };
}

/** Every vertex plus instance poses, rounded and hashed. */
function shapeHash(p) {
  const g = plants.buildPlant(probe(p));
  g.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  const h = crypto.createHash("sha1");
  g.traverse(node => {
    const pos = node.geometry?.attributes?.position;
    if (!pos || node.name === "shadow") return;
    if(node.isInstancedMesh) {
      h.update(`instances:${node.count};`);
      for(const value of node.instanceMatrix.array)h.update(value.toFixed(4)+',');
    }
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(node.matrixWorld);
      h.update(`${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)};`);
    }
  });
  return h.digest("hex").slice(0, 12);
}

test("the fixture is the salvia genus", () => {
  assert.ok(SALVIAS.length >= 10, `only ${SALVIAS.length} salvias in the palette`);
  assert.ok(SALVIAS.some(p => /apiana/.test(p.species)) &&
            SALVIAS.some(p => /officinalis/.test(p.species)) &&
            SALVIAS.some(p => /greggii/.test(p.species)),
    "the three sages this file is about are not all in the palette");
});

test("the leaf mask is really being built, or every measurement below is of the wrong mesh", () => {
  // The classic false green: a guard that is green because the branch it
  // targets never ran. If leafTexture returns null there is no
  // alphaTest anywhere, isCard() matches nothing, and every count below is 0 —
  // equal, and silently passing.
  assert.ok(plants.leafTexture("medium"), "no leaf texture: the canvas stub is not good enough");
  // A CARD SALVIA, not SALVIAS[0]. Five of the genus have their own shoot models
  // and a shoot-built plant has no cards at all, so anchoring on the first row
  // of the palette would make this instrument check measure a plant it is not
  // about. Thirteen of the twenty take the card path; the check is about THOSE.
  const carded = SALVIAS.find(p => !plants.buildPlant(probe(p)).userData.shootModel);
  assert.ok(carded, "every salvia is shoot-built now — this whole file measures the wrong thing");
  const g = plants.buildPlant(probe(carded));
  let cards = 0;
  g.traverse(n => { if (isCard(n)) cards++; });
  assert.ok(cards > 0, "no mesh carries the leaf mask — isCard() would match nothing");
});

test("the salvias are not one object with many labels", () => {
  const groups = new Map();
  for (const p of SALVIAS) {
    const h = shapeHash(p);
    if (!groups.has(h)) groups.set(h, []);
    groups.get(h).push(p.common);
  }
  const worst = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  const report = [...groups.entries()]
    .map(([h, names]) => `  ${h} x${names.length}  ${names.join(", ")}`).join("\n");
  assert.ok(worst[1].length <= Math.ceil(SALVIAS.length / 3),
    `${worst[1].length} of ${SALVIAS.length} salvias are the BIT-IDENTICAL object at one ` +
    `seed and one size:\n${report}`);
});

test("three sages nobody would confuse are three different plants", () => {
  // White sage: 5-8 cm narrow white-felted lances. Berggarten: broad grey
  // culinary paddles. Autumn sage: 1-3 cm glossy ovals on wiry stems. If the
  // renderer cannot tell those apart it cannot tell any two salvias apart.
  const pick = n => SALVIAS.find(p => new RegExp(n, "i").test(p.species));
  const set = [["Salvia apiana", pick("apiana")], ["Salvia officinalis", pick("officinalis")],
               ["Salvia greggii", pick("greggii")]];
  for (const [n, p] of set) assert.ok(p, `${n} is not in the palette`);
  const sig = set.map(([n, p]) => ({ n, ...leafSig(p) }));
  const report = sig.map(s =>
    `${s.n}: leaf "${s.leaf}", ${s.cards} cards of ${s.size.toFixed(4)} m`).join("\n  ");
  assert.equal(new Set(sig.map(s => s.leaf)).size, 3,
    `three sages, ${new Set(sig.map(s => s.leaf)).size} leaf class(es):\n  ${report}`);
  const sizes = sig.map(s => s.size).sort((a, b) => a - b);
  assert.ok(sizes[2] >= sizes[0] * 1.25,
    `leaf sizes ${sizes.map(x => x.toFixed(4)).join(" / ")} — the same leaf on all three:\n  ${report}`);
  const counts = sig.map(s => s.cards).sort((a, b) => a - b);
  assert.ok(counts[2] >= counts[0] * 1.25,
    `card counts ${counts.join(" / ")} — the same density on all three:\n  ${report}`);
});

test("the palette carries a salvia with the border silhouette — a basal clump under spikes", () => {
  // The 花境 (mixed border) shape. A salvia drawn as `mound` is a dome; a mixed
  // border is built out of things that stand UP out of a clump, which is what the
  // renderer's `perennial` form draws — so at least one salvia must route to it.
  const forms = SALVIAS.map(p => [p.common, plants.growthForm(probe(p, {
    mature_height_m: p.mature_height_m, mature_spread_m: p.mature_spread_m }))]);
  assert.ok(forms.some(([, f]) => f === "perennial"),
    `no salvia draws as a border perennial: ${JSON.stringify(Object.fromEntries(forms))}`);
});

test("every salvia in the palette draws, at roughly the height it claims", () => {
  const bad = [];
  for (const p of SALVIAS) {
    const g = plants.buildPlant(probe(p, { mature_height_m: p.mature_height_m,
                                           mature_spread_m: p.mature_spread_m, id: `s_${p.species}` }));
    g.updateMatrixWorld(true);
    let n = 0;
    g.traverse(node => {
      const pos = node.geometry?.attributes?.position;
      if (!pos) return;
      n += pos.count*(node.isInstancedMesh?node.count:1);
    });
    // Box3 understands instance transforms; measuring the unit cylinder's
    // source vertices reports a 1 m stem on the 0.3 m trailing rosemary.
    const box=new THREE.Box3().setFromObject(g),drew=box.max.y-Math.min(0,box.min.y);
    // A SALVIA IS TALLER IN FLOWER, and the palette says so where it matters:
    // `mature_height_m` is the FOLIAGE mound, `flowering_height_m` the wands over
    // it. White sage is a 1.0 m mound throwing 1.8 m wands, so measuring a
    // flowering plant against its foliage height would demand the wands be
    // deleted. Where the field is absent, mature_height_m is the ceiling.
    const claims = p.flowering_height_m ?? p.mature_height_m;
    if (n < 12) bad.push(`${p.species}: draws as nothing`);
    else if (drew < p.mature_height_m * 0.45 || drew > claims * 1.75)
      bad.push(`${p.species}: claims ${claims} m, drew ${drew.toFixed(2)} m`);
  }
  assert.deepEqual(bad, [], `\n${bad.join("\n")}`);
});

test("the leaf routing says what each sage actually grows", () => {
  const want = {
    "Salvia apiana": "lance",                    // 5-8 cm narrow white-felted
    "Salvia leucophylla": "lance",               // narrow, woolly, rugose
    "Salvia officinalis 'Berggarten'": "round",  // broad blunt grey paddle
    "Salvia greggii": "small",                   // 1-3 cm glossy oval
    "Salvia microphylla": "small",               // the name means small-leaved
    "Salvia clevelandii": "small",               // 2-3 cm crinkled grey-green
    "Salvia rosmarinus": "needle",               // and the greedy /salvia/ rule must not take it
    "Salvia columbariae": "filigree",            // deeply divided basal leaves
  };
  const bad = [];
  for (const [sp, cls] of Object.entries(want)) {
    const p = PALETTE.find(x => x.species === sp);
    if (!p) { bad.push(`${sp}: not in the palette`); continue; }
    const got = plants.leafClass(probe(p));
    if (got !== cls) bad.push(`${sp}: routed to "${got}", grows "${cls}"`);
  }
  assert.deepEqual(bad, [], `\n${bad.join("\n")}`);
});

test("every leaf class draws its OWN mask — a new class with no LEAF_SHAPE entry is not a new class", () => {
  // This lives here because `lance` and `round` exist for the salvias. leafTexture
  // falls back to the `medium` mask for any class LEAF_SHAPE does not name, and
  // it does it SILENTLY — so a class can be routed to, sized differently, and
  // still render the picture it was created to escape. Nothing else would catch
  // that: leaf_texture.test.mjs iterates a hardcoded five.
  //
  // Recorded as the full argument list, not as a count of drawing calls. Two
  // classes with the same number of teeth make the same NUMBER of calls, so a
  // count would call `small` and `lance` the same mask.
  const ops = [];
  const rec = new Proxy({}, {
    get: (_, fn) => (...args) => { ops.push(`${String(fn)}(${args.join(",")})`); },
  });
  const real = globalThis.document;
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => rec }) };
  const sigs = {};
  try {
    for (const cls of plants.LEAF_WORDS) {
      plants.forgetLeafTextures();
      ops.length = 0;
      plants.leafTexture(cls);
      sigs[cls] = ops.join("|");
      assert.ok(ops.length > 3, `"${cls}" drew ${ops.length} calls — the mask is empty`);
    }
  } finally {
    globalThis.document = real;
    plants.forgetLeafTextures();
  }
  const same = [];
  for (const a of plants.LEAF_WORDS)
    for (const b of plants.LEAF_WORDS)
      if (a < b && sigs[a] === sigs[b]) same.push(`${a} == ${b}`);
  assert.deepEqual(same, [], `these leaf classes draw the identical mask: ${same.join(", ")}`);
});
