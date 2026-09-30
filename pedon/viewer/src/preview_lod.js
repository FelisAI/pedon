// FAST PREVIEW DRAWS THE SAME PLANT, CHEAPER — for every builder.
//
// Fast must use each botanical builder's own model. In a 155-plant example, replacing
// 40 plants with generic forms makes lamb's ear 41% too short and bronze fennel 51%
// too wide. The builders are cheap to CONSTRUCT (the whole design at
// both qualities builds in under two seconds); what costs is thousands of instances
// each carrying a detailed leaf or floret. So Fast keeps every instance where the
// builder put it and draws it with a stand-in of a few triangles fitted to the
// prototype's own box: the silhouette, size and placement are the builder's by
// construction, and only the part's detail goes.
import * as THREE from "three";
import { MeshoptSimplifier } from "meshoptimizer";
import { translucent } from "./translucency.js";

/**
 * A copy of a builder's material that is still that material: Material.clone() does not carry
 * onBeforeCompile, so without it a translucent leaf's copy is opaque — and ~20% darker.
 */
function sameMaterial(m) {
  const c = m.clone();
  if (m.userData?.translucency) translucent(c, m.userData.translucency);
  return c;
}

/** A prototype at or under this many triangles is already a stand-in. A 12-triangle
 *  stem prism is NOT cheap: Rosie Posie has 14,850 of them, 178 k triangles a plant. */
export const CHEAP_TRIANGLES = 4;

const proxies = new WeakMap();                 // source geometry -> its stand-in

/**
 * A stand-in for one part: a rhombus in the plane of a flat part (leaf, petal, blade),
 * two crossed rhombi for a solid one (floret, bud). The rhombus covers half its box —
 * about what a leaf does — and every attribute the source has (normal, uv, colour) is
 * carried, taken from the nearest source vertex: a material asking for vertex colours
 * on a geometry without them draws BLACK.
 */
export function standIn(source, stretch = new THREE.Vector3(1, 1, 1)) {
  // THE PART AS IT IS DRAWN, not as it is stored. Builders keep unit prototypes and
  // stretch each instance: a stem is a unit cylinder drawn 1 mm by 10 cm, a grass blade
  // a unit strip drawn 2 mm by 40 cm. Judged unstretched, the stems become flat discs
  // and the blades broad sheets. So the shape is judged at the typical stretch, and the
  // stand-in is still built in the prototype's own space, where the instances put it.
  const key = [stretch.x, stretch.y, stretch.z].map(v => Math.round(Math.log2(Math.max(v, 1e-9)))).join();
  let byStretch = proxies.get(source);
  if (!byStretch) proxies.set(source, byStretch = new Map());
  if (byStretch.has(key)) return byStretch.get(key);
  const made = buildStandIn(source, stretch);
  byStretch.set(key, made);
  return made;
}

function buildStandIn(source, stretch) {
  source.computeBoundingBox();
  const box = source.boundingBox, size = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3());
  const drawn = size.clone().multiply(stretch);
  const axes = [0, 1, 2].sort((a, b) => drawn.getComponent(a) - drawn.getComponent(b));
  // A ONE-SIDED SURFACE (a leaf's top: its mean normal near 1 long) is flat whatever its box: a
  // rolled thyme leaf's box is nearly as thick as it is wide, and as crossed planes it faces
  // sideways and down and draws the plant 12-19% dark.
  const oneSided = meanNormal(source).lengthSq() > 0.25;
  const [n, a, b] = axes;                       // thinnest axis is the part's normal
  const flat = oneSided || drawn.getComponent(n) < 0.35 * drawn.getComponent(a);
  // A LONG FLAT PART MAY BE CURVED (a grass blade arches): its box cannot tell a curve
  // from a wide strip, so a box stand-in draws deer grass as stiff broad wedges. Instead,
  // its own shape is simplified instead — see cluster().
  // A CURVED STRIP, not a flat leaf: its thinnest drawn axis runs ACROSS its surface
  // (a blade's width) rather than along its normal, which the source's own normals say —
  // a planar leaf's point along its thin axis, a blade's lie across it. Its box is the
  // arch, not the blade, so it is clustered instead; kept only if that is actually cheap.
  if (flat && acrossSurface(source, n, stretch)) {
    const cells = [0, 0, 0];
    cells[n] = 2; cells[a] = 2; cells[b] = 4;
    const g = cluster(source, box, size, cells);
    if (g && g.attributes.position.count / 3 <= 16) return g;
  }
  // LONG AND THIN (a stem, a blade): a full-width ribbon. A rhombus would taper it to a
  // point at both ends and a stem would read as a string of beads.
  const long = drawn.getComponent(b) > 4 * drawn.getComponent(a);
  const corner = (u, v, w = 0) => {
    const p = mid.clone();
    p.setComponent(a, mid.getComponent(a) + u * size.getComponent(a) / 2);
    p.setComponent(b, mid.getComponent(b) + v * size.getComponent(b) / 2);
    p.setComponent(n, mid.getComponent(n) + w * size.getComponent(n) / 2);
    return p;
  };
  const ribbon = (u, w) => [corner(-u, -1, -w), corner(u, -1, w), corner(u, 1, w), corner(-u, 1, -w)];
  const quads = long
    ? (flat ? [ribbon(1, 0)] : [ribbon(1, 0), [corner(0, -1, -1), corner(0, -1, 1), corner(0, 1, 1), corner(0, 1, -1)]])
    : flat
    // A FLAT PART IS A HEXAGON ON ITS BOX: three quarters of it, where an oval leaf covers
    // four-fifths — a rhombus covers half, and a rhombus grown to the leaf's area draws a 6 cm
    // Berggarten leaf 7.2 cm long. True size and nearly true area, in four triangles.
    ? [[corner(-1, 0), corner(-0.5, -1), corner(0.5, -1), corner(1, 0)],
       [corner(-1, 0), corner(1, 0), corner(0.5, 1), corner(-0.5, 1)]]
    : [[corner(-1, 0), corner(0, -1), corner(1, 0), corner(0, 1)],        // across the long axes
       [corner(0, -1, -1), corner(0, 0, -1).setComponent(b, box.max.getComponent(b)), corner(0, 1, 1),
        corner(0, 0, 1).setComponent(b, box.min.getComponent(b))]];
  const pos = [];
  for (const [p0, p1, p2, p3] of quads) for (const p of [p0, p1, p2, p0, p2, p3]) pos.push(p.x, p.y, p.z);
  // FACE THE WAY THE PART DOES: a leaf's top and underside are separate one-sided
  // materials, so a stand-in wound the other way shows only its underside.
  if (flat && !long) {
    const nm = source.attributes.normal;
    let along = 0;
    if (nm) for (let i = 0; i < nm.count; i++) along += nm.array[i * 3 + n];
    const probe = new THREE.Vector3().subVectors(new THREE.Vector3(pos[3], pos[4], pos[5]), new THREE.Vector3(pos[0], pos[1], pos[2]))
      .cross(new THREE.Vector3(pos[6] - pos[0], pos[7] - pos[1], pos[8] - pos[2]));
    if (along * probe.getComponent(n) < 0)
      for (let t = 0; t < pos.length; t += 9) for (let c = 0; c < 3; c++) {
        const k = pos[t + 3 + c]; pos[t + 3 + c] = pos[t + 6 + c]; pos[t + 6 + c] = k;
      }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  // ONE COLOUR FOR THE WHOLE STAND-IN: every vertex takes the MEAN of the source's uv and
  // colour. Taken from the nearest source vertex, a corner samples the texture at the
  // leaf's EDGE — where the sage plate is a dark checkerboard — and Berggarten appears as
  // dark spiky fronds. A material with vertexColors still gets its colour attribute.
  const count = pos.length / 3;
  for (const name of ["uv", "color"]) {
    const src = source.attributes[name];
    if (!src) continue;
    const mean = new Float64Array(src.itemSize);
    for (let i = 0; i < src.count; i++) for (let c = 0; c < src.itemSize; c++) mean[c] += src.getComponent(i, c);
    const out = new Float32Array(count * src.itemSize);
    for (let i = 0; i < count; i++) for (let c = 0; c < src.itemSize; c++) out[i * src.itemSize + c] = mean[c] / src.count;
    g.setAttribute(name, new THREE.BufferAttribute(out, src.itemSize, false));   // real values
  }
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

/**
 * Vertex clustering: the source's vertices snapped to a coarse grid over its box (the
 * mean of each cell), its triangles rebuilt on those, and any that collapse dropped.
 * The shape — a blade's arch, its true width across the thin axis — survives at the
 * grid's resolution. Every attribute is averaged per cell.
 */
function cluster(source, box, size, cells) {
  const pos = source.attributes.position, idx = source.index;
  const cellOf = new Int32Array(pos.count), sums = new Map(), v = new THREE.Vector3();
  const names = ["position", ...["normal", "uv", "color"].filter(k => source.attributes[k])];
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    let key = 0;
    for (let ax = 0; ax < 3; ax++) {
      const ext = size.getComponent(ax) || 1;
      const c = Math.min(cells[ax] - 1, Math.floor((v.getComponent(ax) - box.min.getComponent(ax)) / ext * cells[ax]));
      key = key * 8 + Math.max(0, c);
    }
    cellOf[i] = key;
    if (!sums.has(key)) sums.set(key, { n: 0, a: names.map(k => new Float64Array(source.attributes[k].itemSize)) });
    const e = sums.get(key); e.n++;
    names.forEach((k, j) => { const at = source.attributes[k]; for (let c = 0; c < at.itemSize; c++) e.a[j][c] += at.getComponent(i, c); });
  }
  const tris = [], seen = new Set();
  const n = idx ? idx.count : pos.count;
  for (let t = 0; t < n; t += 3) {
    const k = [0, 1, 2].map(o => cellOf[idx ? idx.getX(t + o) : t + o]);
    if (k[0] === k[1] || k[1] === k[2] || k[0] === k[2]) continue;
    const id = [...k].sort((x, y) => x - y).join();
    if (seen.has(id)) continue;
    seen.add(id); tris.push(k);
  }
  if (!tris.length) return null;
  const g = new THREE.BufferGeometry();
  names.forEach((k, j) => {
    const size_ = source.attributes[k].itemSize, out = new Float32Array(tris.length * 3 * size_);
    tris.flat().forEach((key, i) => { const e = sums.get(key); for (let c = 0; c < size_; c++) out[i * size_ + c] = e.a[j][c] / e.n; });
    g.setAttribute(k, new THREE.BufferAttribute(out, size_, false));
  });
  if (g.attributes.normal) {                   // averaged normals are unnormalised
    const nm = g.attributes.normal;
    for (let i = 0; i < nm.count; i++) { v.fromBufferAttribute(nm, i).normalize(); nm.setXYZ(i, v.x, v.y, v.z); }
  } else g.computeVertexNormals();
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

function triangles(g) { return (g.index?.count ?? g.attributes.position.count) / 3; }

/** Do the source's normals, as drawn, lie across its thin axis `n` (a curved strip)? */
function acrossSurface(source, n, stretch) {
  const nm = source.attributes.normal;
  if (!nm) return false;
  const v = new THREE.Vector3();
  let along = 0;
  const step = Math.max(1, Math.floor(nm.count / 200));
  let k = 0;
  for (let i = 0; i < nm.count; i += step, k++) {
    // a normal transforms by the inverse of the stretch
    v.fromBufferAttribute(nm, i).divide(stretch).normalize();
    along += Math.abs(v.getComponent(n));
  }
  return along / k < 0.5;
}

/** The median per-axis scale of an InstancedMesh's instances (up to 64 sampled). */
export function typicalStretch(mesh) {
  const m = new THREE.Matrix4(), cols = [[], [], []], e = m.elements;
  const step = Math.max(1, Math.floor(mesh.count / 64));
  for (let i = 0; i < mesh.count; i += step) {
    mesh.getMatrixAt(i, m);
    for (let c = 0; c < 3; c++) cols[c].push(Math.hypot(e[c * 4], e[c * 4 + 1], e[c * 4 + 2]));
  }
  const med = a => { a.sort((x, y) => x - y); return a[a.length >> 1] ?? 1; };
  return new THREE.Vector3(med(cols[0]), med(cols[1]), med(cols[2]));
}

/**
 * Swap every expensive instanced prototype in a built plant for its stand-in, in place.
 * Merged (non-instanced) meshes are left as they are. Returns the group, marked.
 */
export function previewPrototypes(group) {
  if (!group) return group;
  group.traverse(o => {
    if (!o.isInstancedMesh || triangles(o.geometry) <= CHEAP_TRIANGLES) return;
    o.geometry = standIn(o.geometry, typicalStretch(o));
    o.computeBoundingBox(); o.computeBoundingSphere();
  });
  group.userData.renderQuality = "fast";
  group.userData.previewStandIns = true;
  return group;
}

// ── LEAF-CLUSTER CARDS ─────────────────────────────────────────
//
// Closing a shoot canopy with a sixth of the leaves drawn ~5x too big makes a 98 mm rosemary
// needle where the plant's is 20. Real-time foliage can instead use a card
// carrying a PICTURE of many leaves. Here the cards come from the full model itself: its
// true-size leaves are gathered where they grow (a grid of about four leaf-lengths), and each
// cluster becomes one crossed card at the cluster's own place, extent and average colour, whose
// texture is leaves drawn at their true size relative to the card. Size, silhouette and the
// scale of a leaf are the full model's; the canopy closes from the image, not from inflation.

const clusterTextures = new Map();

/** Leaf shapes on a transparent canvas, `aspect` = width / length, drawn at `leafPx` long. */
export function clusterTexture(aspect, leafPx, count) {
  const key = `${aspect.toFixed(2)}|${Math.round(leafPx)}|${count}`;
  if (clusterTextures.has(key)) return clusterTextures.get(key);
  let tex = null;
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const g = c.getContext("2d");
    if (g && typeof g.fillRect === "function" && typeof g.ellipse === "function") {
      g.clearRect(0, 0, 256, 256);
      let seed = 7;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < count; i++) {
        // denser toward the middle, the way leaves crowd along a shoot
        const r = 100 * Math.sqrt(rnd()), a = rnd() * Math.PI * 2;
        const x = 128 + Math.cos(a) * r, y = 128 + Math.sin(a) * r;
        const tone = Math.round(170 + rnd() * 85);
        g.save();
        g.translate(x, y); g.rotate(rnd() * Math.PI * 2);
        g.fillStyle = `rgb(${tone},${tone},${tone})`;
        g.beginPath(); g.ellipse(0, 0, leafPx / 2, Math.max(1.5, leafPx * aspect / 2), 0, 0, Math.PI * 2); g.fill();
        g.strokeStyle = `rgba(0,0,0,0.25)`; g.lineWidth = 1;          // the midrib
        g.beginPath(); g.moveTo(-leafPx / 2, 0); g.lineTo(leafPx / 2, 0); g.stroke();
        g.restore();
      }
      tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
    }
  } catch { tex = null; }                     // no canvas (a test): the cards are flat colour
  clusterTextures.set(key, tex);
  return tex;
}

/**
 * THE PARTS AT FOUR DENSITIES, in a 2 x 2 atlas: quadrant k covers DENSITIES[k] of a card
 * (parts over its inscribed oval). A card takes the quadrant nearest its own coverage, so its
 * density is IN the picture — where the shadow pass sees it too. Carried as vertex alpha, the
 * density reaches the colour pass only: three.js shadows an alpha-to-coverage material with a
 * fixed cut-off on the texture, so every card casts a solid oval and draws plants 15-28% dark.
 * Returns the texture with `userData.meanTone`, or null without a canvas (a test).
 */
// (every card is drawn, however sparse: skipping those under 3% drops the sparse cells at a
// plant's top and edge — the silhouette — and draws rosemary 7% short)
export const DENSITIES = [0.12, 0.3, 0.55, 0.85];
const atlases = new Map();
export function densityAtlas(aspect, leafPx) {
  const key = `${aspect.toFixed(2)}|${Math.round(leafPx)}`;
  if (atlases.has(key)) return atlases.get(key);
  let tex = null;
  try {
    const c = document.createElement("canvas");
    c.width = c.height = 512;
    const g = c.getContext("2d");
    if (g && typeof g.ellipse === "function" && typeof g.getImageData === "function") {
      let seed = 11;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const R = 128 - leafPx / 2, aPx = Math.PI / 4 * leafPx * Math.max(3, leafPx * aspect);
      DENSITIES.forEach((d, k) => {
        // the densest picture fills the whole card (a dense cluster really covers more than an
        // oval's 79% — westringia's canopy holds 56% of its leaf area with the densest at 71%);
        // the rest fill the inscribed oval, so a card reads as a cluster, not a tile
        const square = k === DENSITIES.length - 1;
        const area = square ? (256 - leafPx) ** 2 : Math.PI * R * R;
        const inside = Math.min(0.97, square ? d : d / (Math.PI / 4));
        const count = THREE.MathUtils.clamp(Math.ceil(-Math.log(1 - inside) * area / aPx), 1, 6000);
        const ox = (k % 2) * 256, oy = (1 - (k >> 1)) * 256;       // row 0 of uv is the canvas's bottom
        for (let i = 0; i < count; i++) {
          const rr = R * Math.sqrt(rnd()), an = rnd() * Math.PI * 2, tone = Math.round(215 + rnd() * 40);
          const px = square ? leafPx / 2 + rnd() * (256 - leafPx) : 128 + Math.cos(an) * rr;
          const py = square ? leafPx / 2 + rnd() * (256 - leafPx) : 128 + Math.sin(an) * rr;
          g.save(); g.translate(ox + px, oy + py); g.rotate(rnd() * Math.PI * 2);
          g.fillStyle = `rgb(${tone},${tone},${tone})`;
          g.beginPath(); g.ellipse(0, 0, leafPx / 2, Math.max(1.5, leafPx * aspect / 2), 0, 0, Math.PI * 2); g.fill();
          g.restore();
        }
      });
      tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const px = g.getImageData(0, 0, 512, 512).data;
      let sum = 0, n = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 127) { const v = px[i] / 255; sum += v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; n++; }
      tex.userData.meanTone = n ? sum / n : 1;
    }
  } catch { tex = null; }
  atlases.set(key, tex);
  return tex;
}

/**
 * Replace a built plant's `foliage` (and `leaf undersides`) instances with leaf-cluster cards,
 * in place. Returns the group, with `userData.leafCards` = {cards, leaves, leafLength}.
 */
export function leafClusterCards(group) {
  const foliage = [], drop = [];
  group.traverse(o => {
    if (!o.isInstancedMesh) return;
    if (o.name === "foliage") foliage.push(o);
    if (o.name === "foliage" || o.name === "leaf undersides") drop.push(o);
  });
  if (!foliage.length) return group;
  group.updateWorldMatrix(true, true);
  const toGroup = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const leaves = [], m = new THREE.Matrix4(), col = new THREE.Color();
  let lengths = [], aspect = 0;
  for (const mesh of foliage) {
    const geo = mesh.geometry;
    geo.computeBoundingBox();
    const b = geo.boundingBox, size = b.getSize(new THREE.Vector3()), mid = b.getCenter(new THREE.Vector3());
    const axes = [0, 1, 2].sort((p, q) => size.getComponent(p) - size.getComponent(q));
    const thin = new THREE.Vector3().setComponent(axes[0], 1);
    const base = new THREE.Color(1, 1, 1);
    const gc = geo.attributes.color;
    if (gc) {                                    // the leaf's own colour, averaged
      let r = 0, gg = 0, bb = 0;
      for (let i = 0; i < gc.count; i++) { r += gc.getX(i); gg += gc.getY(i); bb += gc.getZ(i); }
      base.setRGB(r / gc.count, gg / gc.count, bb / gc.count);
    }
    const matCol = mesh.material?.color ?? new THREE.Color(1, 1, 1);
    const world = new THREE.Matrix4().multiplyMatrices(toGroup, mesh.matrixWorld);
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      const mm = new THREE.Matrix4().multiplyMatrices(world, m);
      const s = new THREE.Vector3().setFromMatrixScale(mm);
      const len = size.getComponent(axes[2]) * Math.max(s.x, s.y, s.z);
      lengths.push(len);
      aspect += size.getComponent(axes[1]) / Math.max(1e-6, size.getComponent(axes[2]));
      const c = base.clone().multiply(matCol);
      if (mesh.instanceColor) { mesh.getColorAt(i, col); c.multiply(col); }
      leaves.push({ p: mid.clone().applyMatrix4(mm),
                    n: thin.clone().transformDirection(mm), c, len });
    }
  }
  lengths.sort((p, q) => p - q);
  const leafLen = lengths[lengths.length >> 1];
  aspect /= leaves.length;
  const cell = 4 * leafLen;
  const cells = new Map();
  for (const L of leaves) {
    const k = `${Math.floor(L.p.x / cell)},${Math.floor(L.p.y / cell)},${Math.floor(L.p.z / cell)}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(L);
  }
  const pos = [], nor = [], uv = [], rgb = [];
  const quad = (c, u, v, n, hu, hv, colour) => {
    const P = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => c.clone().addScaledVector(u, a * hu).addScaledVector(v, b * hv));
    for (const k of [0, 1, 2, 0, 2, 3]) {
      pos.push(P[k].x, P[k].y, P[k].z); nor.push(n.x, n.y, n.z);
      uv.push([0, 1, 1, 0][k] ?? 0, [0, 0, 1, 1][k] ?? 0);
      rgb.push(colour.r, colour.g, colour.b);
    }
  };
  let perCard = 0;
  for (const group_ of cells.values()) {
    const c = new THREE.Vector3(), n = new THREE.Vector3(), colour = new THREE.Color(0, 0, 0);
    for (const L of group_) {
      c.add(L.p);
      n.add(L.n.y < 0 ? L.n.clone().negate() : L.n);
      colour.r += L.c.r; colour.g += L.c.g; colour.b += L.c.b;
    }
    c.divideScalar(group_.length); colour.multiplyScalar(1 / group_.length);
    if (n.lengthSq() < 1e-9) n.set(0, 1, 0);
    n.normalize();
    const u = new THREE.Vector3().crossVectors(n, Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
    const v = new THREE.Vector3().crossVectors(n, u).normalize();
    let hu = leafLen / 2, hv = leafLen / 2;
    for (const L of group_) {
      const d = L.p.clone().sub(c);
      hu = Math.max(hu, Math.abs(d.dot(u)) + L.len / 2);
      hv = Math.max(hv, Math.abs(d.dot(v)) + L.len / 2);
    }
    quad(c, u, v, n, hu, hv, colour);           // the cluster's own plane
    quad(c, n, v, u, Math.min(hu, hv) * 0.7, hv, colour);   // and across it, so it never goes edge-on
    perCard += group_.length;
  }
  // THE PLANT'S COLOUR ON THE MATERIAL, each card's variation in its vertices: the same
  // product, and the colour stays where the rest of the app (and the schema tests) read it
  // the foliage material's OWN colour — the plant's identity (its form ramp or declared
  // foliage); the leaves' shading tones stay in the vertices
  const mean = (foliage[0].material?.color ?? new THREE.Color(1, 1, 1)).clone();
  for (let i = 0; i < rgb.length; i += 3) {
    rgb[i] /= Math.max(1e-4, mean.r); rgb[i + 1] /= Math.max(1e-4, mean.g); rgb[i + 2] /= Math.max(1e-4, mean.b);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(rgb, 3));
  const cards = cells.size;
  // the texture's leaves at their true size against a typical card (about cell wide)
  const leafPx = 256 * leafLen / (cell * 1.25), count = Math.max(6, Math.round(perCard / cards * 1.4));
  const map = clusterTexture(Math.min(1, aspect), leafPx, count);
  // HOW MUCH OF A CARD IS LEAF: the texture's leaves fall in a 100 px circle of the 256 px card;
  // overlapping at random they cover 1 - e^-density of it. So a canopy can be measured in leaf
  // area (tests/js/preview_lod.test.mjs), not card area.
  const disc = Math.PI * 100 * 100;
  const density = count * (Math.PI / 4) * leafPx * Math.max(3, leafPx * Math.min(1, aspect)) / disc;
  const cover = (disc / (256 * 256)) * (1 - Math.exp(-density));
  const mat = new THREE.MeshStandardMaterial({ color: mean, vertexColors: true, roughness: 0.85,
    side: THREE.DoubleSide, map, alphaTest: map ? 0.45 : 0, transparent: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "leaf cards";
  mesh.castShadow = mesh.receiveShadow = true;
  for (const o of drop) o.removeFromParent();
  group.add(mesh);
  const wood = thinWood(group);
  group.userData.leafCards = { cards, leaves: leaves.length, leafLength: +leafLen.toFixed(4), wood,
                               cover: +cover.toFixed(3) };
  return group;
}

/** Inside a canopy closed by cards, the thin twigs cannot be seen — 98,778 of them on a
 *  rosemary, 395 k triangles even as stand-ins. Keep the framework: the thickest 15%. */
export const WOOD_KEPT = 0.15;
function thinWood(group) {
  let kept = 0, was = 0;
  // collected FIRST: adding the thinned mesh during traversal visits it again and thins
  // the thinned wood (98,778 -> 14,817 -> 2,223)
  const woods = [];
  group.traverse(o => { if (o.isInstancedMesh && o.name === "wood" && o.count >= 40) woods.push(o); });
  for (const o of woods) {
    const m = new THREE.Matrix4(), s = new THREE.Vector3(), q = new THREE.Quaternion(), p = new THREE.Vector3();
    const radius = [];
    for (let i = 0; i < o.count; i++) { o.getMatrixAt(i, m); m.decompose(p, q, s); radius.push([Math.min(s.x, s.z), i]); }
    radius.sort((a, b) => b[0] - a[0]);
    const keep = radius.slice(0, Math.max(20, Math.round(o.count * WOOD_KEPT))).map(([, i]) => i);
    const out = new THREE.InstancedMesh(o.geometry, o.material, keep.length);
    const c = new THREE.Color();
    keep.forEach((i, j) => { o.getMatrixAt(i, m); out.setMatrixAt(j, m); if (o.instanceColor) { o.getColorAt(i, c); out.setColorAt(j, c); } });
    out.name = o.name; out.castShadow = o.castShadow; out.receiveShadow = o.receiveShadow;
    out.position.copy(o.position); out.quaternion.copy(o.quaternion); out.scale.copy(o.scale);
    out.computeBoundingBox(); out.computeBoundingSphere();
    was += o.count; kept += keep.length;
    o.parent.add(out); o.removeFromParent();
  }
  return { kept, was };
}

// ── THE PHOTOREAL BUILDERS, REDUCED ────────────────────────────────────────────
//
// Accurate rendering requires Fast and full detail to share the same model.
// A photoreal builder is heavy: a Ceanothus is 238 k leaves and 5.1 M florets
// on 5.9 M twigs, and
// even as stand-ins, part for part, that is 46 M triangles a plant. So Fast runs the SAME
// builder once per species and size and reduces what it made, in place:
//   - a layer of many small parts (over CARD_ABOVE: leaves, florets) becomes cluster cards
//     where those parts grow, each carrying a picture of them at their true size;
//   - what lies ON a part (undersides, hairs, wool, down) goes — a card already is the leaf;
//   - fine wood keeps its thickest FINE_WOOD_MAX pieces, under cards that close the canopy;
//   - a layer of few, larger parts (a daisy's head, a sedge's blade) keeps every one, each its
//     own shape simplified, sharing PLANT_BUDGET triangles a metre of spread with the others;
//   - a merged mesh past MERGED_MAX (a buckwheat's 1.5 M-triangle axes) is simplified to it.
// Where things are and how big they are stays the builder's; only detail goes.

export const OVERLAY = /undersides?$|pubescence|hairs$|wool$|\bdown$/i;
// ("wood" is a shoot plant's instanced twigs: omitting it cards rosemary's twigs as
// FLOWERS — brown bloom cards where its stems belong)
export const FINE_WOOD = /twigs|petioles?|pedicels?|^stems$|^wood$|axes$|^ray$/i;
/** A grass's culms and sheaths are its standing structure, not a mass of small parts: never
 *  carded (carding them loses a third of coastal reed grass's width). */
export const STRUCTURE = /culms?|sheaths?|stalks?|scapes?/i;
export const CARD_ABOVE = 5000;
export const FINE_WOOD_MAX = 3000;
/** Pieces narrower than this are under half a pixel from a metre away, the nearest anyone
 *  stands to a plant: a deer grass's 0.3 mm pedicels, 106 k a plant, batched with its
 *  culms, account for 310 k of its 509 k triangles and a quarter of the frame. */
export const SUBVISIBLE_M = 0.0005;
/** A part is a BLADE — drawn as a ribbon along its midline — when its longest side is this many
 *  times its thinnest. A grass blade is 20-150; a spikelet or a leaf 2-5. */
export const BLADE_ASPECT = 8;
/** Triangles a metre of spread for the parts kept one by one, shared by their layers. */
export const PLANT_BUDGET = 100000;
export const MERGED_MAX = 30000;
/** How far a reduced part may fall short of the full model's reach or height: the tolerance
 *  tests/js/preview_builders.test.mjs already holds every Fast builder to. */
export const REACH_TOLERANCE = 0.05;

// The simplifier is WebAssembly and starts asynchronously; building a plant is synchronous.
// The viewer (and a test) awaits prepareSimplifier() before the first Fast build; until then
// a large part falls back to its box stand-in and a merged mesh is left whole.
let simplifierReady = false;
export function prepareSimplifier() {
  return MeshoptSimplifier.ready.then(() => { simplifierReady = true; return true; },
                                      () => false);
}

/**
 * `geo` at about `target` triangles — every attribute kept, welded by position first
 * (a builder's parts are often triangle soup, and nothing collapses across a seam it cannot
 * see). Null when the simplifier is not ready or cannot get there.
 */
export function simplifyTo(geo, target) {
  if (!simplifierReady || target < 2) return null;
  const pos = geo.attributes.position;
  const P = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) { P[i * 3] = pos.getX(i); P[i * 3 + 1] = pos.getY(i); P[i * 3 + 2] = pos.getZ(i); }
  const remap = MeshoptSimplifier.generatePositionRemap(P, 3);
  const src = geo.index ? geo.index.array : Uint32Array.from({ length: pos.count }, (_, i) => i);
  const idx = new Uint32Array(src.length);
  for (let i = 0; i < src.length; i++) idx[i] = remap[src[i]];
  // a part of many separate pieces (a panicle's spikelets) cannot collapse along its edges; the
  // sloppy simplifier clusters it instead. Grey blocks at a fescue's foot are box stand-ins
  // of folded blades, not the result of clustering separate pieces.
  let [out] = MeshoptSimplifier.simplify(idx, P, 3, target * 3, 1, []);
  if (out.length / 3 > target * 2) [out] = MeshoptSimplifier.simplifySloppy(idx, P, 3, null, target * 3, 1);
  if (!out.length || out.length >= src.length) return null;
  // only the vertices still used, renumbered
  const used = new Map(), order = [];
  const tri = new Uint32Array(out.length);
  for (let i = 0; i < out.length; i++) {
    let k = used.get(out[i]);
    if (k === undefined) { k = order.length; used.set(out[i], k); order.push(out[i]); }
    tri[i] = k;
  }
  const g = new THREE.BufferGeometry();
  // through getComponent: a model file keeps its colours as NORMALISED integers (0-65535 for
  // 0-1), and copied raw into floats a library tree's branches draw white
  for (const [name, at] of Object.entries(geo.attributes)) {
    const n = at.itemSize, a = new Float32Array(order.length * n);
    order.forEach((v, j) => { for (let c = 0; c < n; c++) a[j * n + c] = at.getComponent(v, c); });
    g.setAttribute(name, new THREE.BufferAttribute(a, n, false));
  }
  g.setIndex(new THREE.BufferAttribute(tri, 1));
  shapeNormals(g);
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

/**
 * THE SIMPLIFIED SHAPE'S OWN NORMALS. Keeping original vertex normals on a catnip leaf cut
 * from 80 triangles to 19 spreads a curled margin's downturned normal across a whole coarse
 * triangle and draws a third of each leaf near-black, even without flipped triangles.
 * Recomputing normals removes those patches. Where the new normal
 * is degenerate (both windings of one surface meeting at a vertex) the old one is kept.
 */
function shapeNormals(g) {
  const old = g.attributes.normal;
  if (!old) return;
  const p = g.attributes.position, idx = g.index.array, sum = new Float32Array(p.count * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < idx.length; t += 3) {
    a.fromBufferAttribute(p, idx[t]); b.fromBufferAttribute(p, idx[t + 1]); c.fromBufferAttribute(p, idx[t + 2]);
    c.sub(b); b.sub(a); b.cross(c);                     // twice the face's area, along its normal
    for (let k = 0; k < 3; k++) { const v = idx[t + k] * 3; sum[v] += b.x; sum[v + 1] += b.y; sum[v + 2] += b.z; }
  }
  const out = new Float32Array(p.count * 3);
  for (let v = 0; v < p.count; v++) {
    const x = sum[v * 3], y = sum[v * 3 + 1], z = sum[v * 3 + 2], len = Math.hypot(x, y, z);
    if (len > 1e-12) { out[v * 3] = x / len; out[v * 3 + 1] = y / len; out[v * 3 + 2] = z / len; }
    else { out[v * 3] = old.getX(v); out[v * 3 + 1] = old.getY(v); out[v * 3 + 2] = old.getZ(v); }
  }
  g.setAttribute("normal", new THREE.BufferAttribute(out, 3));
}

/**
 * About the `k` instances farthest from the axis (by their placement), without sorting all of
 * them — a Ceanothus has 5 M: the cut is read off a sample, so the farthest always pass it.
 */
export function outermost(a, n, k) {
  const step = Math.max(1, Math.floor(n / 20000)), sample = [];
  for (let i = 0; i < n; i += step) sample.push(Math.hypot(a[i * 16 + 12], a[i * 16 + 14]));
  sample.sort((x, y) => y - x);
  const cut = sample[Math.min(sample.length - 1, Math.floor(sample.length * k / n))];
  const out = [];
  for (let i = 0; i < n && out.length < 2 * k; i++) if (Math.hypot(a[i * 16 + 12], a[i * 16 + 14]) >= cut) out.push(i);
  return out;
}

/**
 * How far a layer reaches from the plant's axis, and how high, with `geo` drawn at up to 300 of
 * its instances. What a reduction must not change: collapsing a curled fescue blade to 16
 * triangles keeps its bounding box within 3% and still takes 14% off the plant's width.
 */
function layerReach(m, geo, toGroup) {
  // the instances that decide it — the outermost and the highest placed — not every n-th
  const a = m.instanceMatrix.array, n = m.count;
  let which;
  if (n <= 128) which = Array.from({ length: n }, (_, i) => i);
  else {
    const byY = [], step = Math.max(1, Math.floor(n / 20000));
    for (let i = 0; i < n; i += step) byY.push([a[i * 16 + 13], i]);
    byY.sort((x, y) => y[0] - x[0]);
    const top = byY[Math.min(byY.length - 1, Math.floor(byY.length * 64 / n))][0];
    which = new Set(outermost(a, n, 64));
    for (let i = 0; i < n && which.size < 256; i++) if (a[i * 16 + 13] >= top) which.add(i);
  }
  const W = new THREE.Matrix4().multiplyMatrices(toGroup, m.matrixWorld), M = new THREE.Matrix4(), e = M.elements;
  const P = geo.attributes.position.array, stride = geo.attributes.position.itemSize;
  let r = 0, hi = -Infinity;
  for (const i of which) {
    M.fromArray(a, i * 16).premultiply(W);
    for (let k = 0; k < P.length; k += stride) {
      const x = P[k], y = P[k + 1], z = P[k + 2];
      const wx = e[0] * x + e[4] * y + e[8] * z + e[12], wy = e[1] * x + e[5] * y + e[9] * z + e[13], wz = e[2] * x + e[6] * y + e[10] * z + e[14];
      const rr = wx * wx + wz * wz;
      if (rr > r) r = rr;
      if (wy > hi) hi = wy;
    }
  }
  return { r: Math.sqrt(r), top: hi };
}

/**
 * A blade as a ribbon along its own midline, `segments` long: its texture coordinate runs from
 * base to tip (a builder's blade is a grid, `v` along it), so the vertices at each step of `v`
 * give the midline and the width there — the curl and the TIP kept exactly, at 2 triangles a
 * segment. Null when `v` does not run along the part (a folded or compound part).
 */
export function ribbonOf(geo, segments) {
  const uv = geo.attributes.uv, pos = geo.attributes.position;
  if (!uv || pos.count < 8) return null;
  let vmin = Infinity, vmax = -Infinity, umin = Infinity, umax = -Infinity;
  for (let i = 0; i < uv.count; i++) {
    vmin = Math.min(vmin, uv.getY(i)); vmax = Math.max(vmax, uv.getY(i));
    umin = Math.min(umin, uv.getX(i)); umax = Math.max(umax, uv.getX(i));
  }
  if (!(vmax - vmin > 1e-6) || !(umax - umin > 1e-6)) return null;
  // `v` must run ALONG the part: the ring positions must advance, base to tip
  const umid = (umin + umax) / 2, names = Object.keys(geo.attributes);
  const rings = Array.from({ length: segments + 1 }, () => [0, 1].map(() => ({ n: 0, du: 0, a: names.map(k => new Float64Array(geo.attributes[k].itemSize)) })));
  // each ring is the ROW of vertices nearest its step, not every vertex around it: banded, the
  // last ring is the mean of the blade's final sixteenth and the tip falls 4% short
  const at = i => (uv.getY(i) - vmin) / (vmax - vmin) * segments;
  const near = new Float64Array(segments + 1).fill(Infinity);
  for (let i = 0; i < pos.count; i++) { const r = Math.round(at(i)); near[r] = Math.min(near[r], Math.abs(at(i) - r)); }
  for (let i = 0; i < pos.count; i++) {
    const r = Math.round(at(i));
    if (Math.abs(at(i) - r) > near[r] + 1e-6) continue;
    const side = uv.getX(i) >= umid ? 1 : 0;
    const e = rings[r][side];
    e.n++; e.du += Math.abs(uv.getX(i) - umid);
    names.forEach((k, j) => { const at = geo.attributes[k]; for (let c = 0; c < at.itemSize; c++) e.a[j][c] += at.getComponent(i, c); });
  }
  if (rings.some(r => !r[0].n || !r[1].n)) return null;
  const pj = names.indexOf("position"), half = (umax - umin) / 2;
  const verts = [];                            // [ring][side] -> attribute arrays
  for (const [L, R] of rings) {
    const mean = e => e.a.map(a => Array.from(a, x => x / e.n));
    const l = mean(L), r = mean(R);
    const c = [0, 1, 2].map(k => (l[pj][k] + r[pj][k]) / 2);
    // the side means sit part-way across; push them out to the blade's edge
    for (const [m, e] of [[l, L], [r, R]]) {
      const out = half / Math.max(1e-6, e.du / e.n);
      for (let k = 0; k < 3; k++) m[pj][k] = c[k] + (m[pj][k] - c[k]) * Math.min(out, 4);
    }
    verts.push([l, r]);
  }
  // advancing: the midline must move along the part, or `v` was not its length
  let along = 0, jump = 0;
  for (let r = 1; r < verts.length; r++) {
    const d = [0, 1, 2].map(k => (verts[r][0][pj][k] + verts[r][1][pj][k] - verts[r - 1][0][pj][k] - verts[r - 1][1][pj][k]) / 2);
    const len = Math.hypot(...d); along += len; jump = Math.max(jump, len);
  }
  if (!(along > 0) || jump > along * 0.6) return null;
  const tri = [], P3 = ([r, sd]) => verts[r][sd][pj];
  for (let r = 0; r < segments; r++) for (const t3 of [[[r, 0], [r, 1], [r + 1, 1]], [[r, 0], [r + 1, 1], [r + 1, 0]]]) {
    // a pointed tip closes the last segment to a line: that triangle has no area and no facing
    const [p, q, w] = t3.map(P3), e1 = [0, 1, 2].map(k => q[k] - p[k]), e2 = [0, 1, 2].map(k => w[k] - p[k]);
    const area = Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]);
    if (area > 1e-12) tri.push(...t3);
  }
  const g = new THREE.BufferGeometry();
  names.forEach((k, j) => {
    const n = geo.attributes[k].itemSize, out = new Float32Array(tri.length * n);
    tri.forEach(([r, sd], i) => { for (let c = 0; c < n; c++) out[i * n + c] = verts[r][sd][j][c]; });
    g.setAttribute(k, new THREE.BufferAttribute(out, n, false));
  });
  // ITS OWN NORMALS, not the source's averaged: a blade or leaf is a thin closed solid, its top
  // and underside facing opposite ways, and their mean is nothing — drawing Bidens 54% dark
  if (g.attributes.normal) g.deleteAttribute("normal");
  if (g.attributes.tangent) g.deleteAttribute("tangent");
  g.computeVertexNormals();
  g.computeBoundingBox(); g.computeBoundingSphere();
  g.userData.ribbon = segments;
  return g;
}

// A TEXTURE'S COLOUR, WHERE THE PART USES IT. A card has no texture of the part's own, so
// it carries that texture's colour in its vertices — the mean of the texels at the part's own
// UVs (a buckwheat's atlas holds leaf and tepal side by side), in linear light as rendered.
const texels = new WeakMap();
function texelsOf(tex) {
  const img = tex?.image;
  if (!img?.width) return null;
  if (texels.has(tex)) return texels.get(tex);
  let out = null;
  try {
    const w = Math.min(128, img.width), h = Math.min(128, img.height);
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const g = c.getContext("2d"); g.drawImage(img, 0, 0, w, h);
    out = { w, h, data: g.getImageData(0, 0, w, h).data };
  } catch { out = null; }
  texels.set(tex, out);
  return out;
}
const toLinear = v => (v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
export function textureMean(tex, geo) {
  const T = texelsOf(tex), uv = geo.attributes.uv;
  if (!T || !uv) return null;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i) - Math.floor(uv.getX(i)), v = uv.getY(i) - Math.floor(uv.getY(i));
    const x = Math.min(T.w - 1, Math.floor(u * T.w)), y = Math.min(T.h - 1, Math.floor((tex.flipY ? 1 - v : v) * T.h));
    const k = (y * T.w + x) * 4;
    if (T.data[k + 3] < 128) continue;
    r += toLinear(T.data[k]); g += toLinear(T.data[k + 1]); b += toLinear(T.data[k + 2]); n++;
  }
  return n ? new THREE.Color(r / n, g / n, b / n) : null;
}

/**
 * The area a part shows from one side, across its thin axis `thin`: the larger of its two
 * faces. A blade is a thin closed solid — its surface counts both faces — and its ribbon has one,
 * so comparing surfaces rejects every ribbon and leaves a fescue at 2.3 M triangles.
 */
function visibleArea(geo, thin) {
  const p = geo.attributes.position, ix = geo.index, n = ix ? ix.count : p.count;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), x = new THREE.Vector3();
  let up = 0, down = 0;
  for (let t = 0; t < n; t += 3) {
    a.fromBufferAttribute(p, ix ? ix.getX(t) : t); b.fromBufferAttribute(p, ix ? ix.getX(t + 1) : t + 1); c.fromBufferAttribute(p, ix ? ix.getX(t + 2) : t + 2);
    x.crossVectors(b.sub(a), c.sub(a));
    const along = x.dot(thin) / 2;
    if (along > 0) up += along; else down -= along;
  }
  return Math.max(up, down);
}

/** The area a part covers seen along its thinnest axis: its triangles rasterised on a 48 x 48 grid. */
export function footprint(geo, axes) {
  geo.computeBoundingBox();
  const [, a, b] = axes, lo = geo.boundingBox.min, size = geo.boundingBox.getSize(new THREE.Vector3());
  const N = 48, du = (size.getComponent(a) || 1e-9) / N, dv = (size.getComponent(b) || 1e-9) / N;
  const hit = new Uint8Array(N * N), p = geo.attributes.position, ix = geo.index, n = ix ? ix.count : p.count;
  const at = (k, ax) => (ix ? p.getComponent(ix.getX(k), ax) : p.getComponent(k, ax));
  for (let t = 0; t < n; t += 3) {
    const U = [0, 1, 2].map(q => (at(t + q, a) - lo.getComponent(a)) / du), W = [0, 1, 2].map(q => (at(t + q, b) - lo.getComponent(b)) / dv);
    const d = (U[1] - U[0]) * (W[2] - W[0]) - (U[2] - U[0]) * (W[1] - W[0]);
    if (Math.abs(d) < 1e-12) continue;
    for (let x = Math.max(0, Math.floor(Math.min(...U))); x <= Math.min(N - 1, Math.floor(Math.max(...U))); x++)
      for (let y = Math.max(0, Math.floor(Math.min(...W))); y <= Math.min(N - 1, Math.floor(Math.max(...W))); y++) {
        const px = x + 0.5, py = y + 0.5;
        const l1 = ((U[1] - px) * (W[2] - py) - (U[2] - px) * (W[1] - py)) / d, l2 = ((U[2] - px) * (W[0] - py) - (U[0] - px) * (W[2] - py)) / d;
        if (l1 >= 0 && l2 >= 0 && l1 + l2 <= 1) hit[y * N + x] = 1;
      }
  }
  let k = 0; for (const h of hit) k += h;
  return k * du * dv;
}

/** How many of a layer's pieces are at least SUBVISIBLE_M across (a unit-radius part, scaled). */
function visiblePieces(o) {
  const a = o.instanceMatrix.array;
  o.geometry.computeBoundingBox();
  const b = o.geometry.boundingBox, across = Math.min(b.max.x - b.min.x, b.max.z - b.min.z);
  let n = 0;
  for (let i = 0; i < o.count; i++)
    if (across * Math.min(Math.hypot(a[i * 16], a[i * 16 + 1], a[i * 16 + 2]),
                          Math.hypot(a[i * 16 + 8], a[i * 16 + 9], a[i * 16 + 10])) >= SUBVISIBLE_M) n++;
  return n;
}

/** A part's area-weighted mean normal: near 1 long for a one-sided surface (a leaf's top), near
 *  0 for a closed solid. */
function meanNormal(geo) {
  const p = geo.attributes.position, ix = geo.index, n = ix ? ix.count : p.count;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), sum = new THREE.Vector3();
  let area = 0;
  for (let t = 0; t < n; t += 3) {
    a.fromBufferAttribute(p, ix ? ix.getX(t) : t); b.fromBufferAttribute(p, ix ? ix.getX(t + 1) : t + 1);
    c.fromBufferAttribute(p, ix ? ix.getX(t + 2) : t + 2);
    c.sub(a); b.sub(a); b.cross(c);
    area += b.length() / 2; sum.addScaledVector(b, 0.5);
  }
  return area > 0 ? sum.divideScalar(area) : sum;
}

/** Keep the `keep` thickest instances of a fine-wood layer (thickness: its narrower cross axis). */
function thinnest(o, keep) {
  const a = o.instanceMatrix.array, n = o.count;
  const thick = i => Math.min(Math.hypot(a[i * 16], a[i * 16 + 1], a[i * 16 + 2]),
                              Math.hypot(a[i * 16 + 8], a[i * 16 + 9], a[i * 16 + 10]));
  // the threshold from a sample, then one pass — sorting 5.9 M twigs costs seconds
  const sample = [];
  const step = Math.max(1, Math.floor(n / 20000));
  for (let i = 0; i < n; i += step) sample.push(thick(i));
  sample.sort((x, y) => y - x);
  const cut = sample[Math.min(sample.length - 1, Math.floor(sample.length * keep / n))];
  const kept = [];
  for (let i = 0; i < n && kept.length < keep; i++) if (thick(i) >= cut) kept.push(i);
  const out = new THREE.InstancedMesh(o.geometry, o.material, kept.length);
  if (o.instanceColor) out.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(kept.length * 3), 3);
  kept.forEach((i, j) => {
    out.instanceMatrix.array.set(a.subarray(i * 16, i * 16 + 16), j * 16);
    if (o.instanceColor) out.instanceColor.array.set(o.instanceColor.array.subarray(i * 3, i * 3 + 3), j * 3);
  });
  out.name = o.name; out.castShadow = o.castShadow; out.receiveShadow = o.receiveShadow;
  out.position.copy(o.position); out.quaternion.copy(o.quaternion); out.scale.copy(o.scale);
  out.computeBoundingBox(); out.computeBoundingSphere();
  o.parent.add(out); o.removeFromParent();
  return out;
}

/**
 * Cluster cards for every instance of `meshes` (one layer: all "foliage", or all "bloom"),
 * gathered in cells of about four part-lengths — never finer than `minCell` — each cell one
 * crossed card at the cluster's own place, extent and mean colour, carrying a picture of its
 * parts at their true size. Reads the instance arrays directly: a Ceanothus has 5.1 M florets.
 */
function cardsFor(group, meshes, name, minCell) {
  group.updateWorldMatrix(true, true);
  const toGroup = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const layers = meshes.map(mesh => {
    const geo = mesh.geometry;
    geo.computeBoundingBox();
    const b = geo.boundingBox, size = b.getSize(new THREE.Vector3()), mid = b.getCenter(new THREE.Vector3());
    const axes = [0, 1, 2].sort((p, q) => size.getComponent(p) - size.getComponent(q));
    const base = new THREE.Color(1, 1, 1), gc = geo.attributes.color;
    if (gc) {
      let r = 0, g = 0, bb = 0;
      for (let i = 0; i < gc.count; i++) { r += gc.getX(i); g += gc.getY(i); bb += gc.getZ(i); }
      base.setRGB(r / gc.count, g / gc.count, bb / gc.count);
    }
    base.multiply(mesh.material?.color ?? new THREE.Color(1, 1, 1));
    // ITS OWN FOOTPRINT — what it covers seen along its thin axis. As an ellipse of its length
    // and width a rolled westringia needle covers about half, and the canopy draws 56% of full
    // detail's leaf; halving a "closed" part misreads a rolled single sheet as two faces.
    const oneSide = footprint(geo, axes);
    const fromMap = mesh.material?.map && textureMean(mesh.material.map, geo);
    if (fromMap) base.multiply(fromMap);
    return { mesh, size, mid, axes, base, oneSide, W: new THREE.Matrix4().multiplyMatrices(toGroup, mesh.matrixWorld).elements };
  });
  // the typical part: its length drawn, from a sample
  const lengths = []; let aspect = 0, na = 0;
  for (const L of layers) {
    const a = L.mesh.instanceMatrix.array, step = Math.max(1, Math.floor(L.mesh.count / 4000));
    const long = L.axes[2], wide = L.axes[1];
    for (let i = 0; i < L.mesh.count; i += step) {
      const s = Math.hypot(a[i * 16 + long * 4], a[i * 16 + long * 4 + 1], a[i * 16 + long * 4 + 2]);
      lengths.push(L.size.getComponent(long) * s);
    }
    aspect += L.size.getComponent(wide) / Math.max(1e-6, L.size.getComponent(long)); na++;
  }
  lengths.sort((p, q) => p - q);
  const partLen = lengths[lengths.length >> 1] || 0.01;
  aspect = Math.min(1, aspect / na);
  const cell = Math.max(4 * partLen, minCell);
  // one pass: per cell the count, the sums of place, facing and colour, and the box of places
  const index = new Map(), acc = [];
  const col = new THREE.Color();
  let parts = 0;
  // the part's centre in the group's frame, for instance i of layer L
  const at = (L, i, out) => {
    const a = L.mesh.instanceMatrix.array, W = L.W, o = i * 16, [mx, my, mz] = [L.mid.x, L.mid.y, L.mid.z];
    const lx = a[o] * mx + a[o + 4] * my + a[o + 8] * mz + a[o + 12];
    const ly = a[o + 1] * mx + a[o + 5] * my + a[o + 9] * mz + a[o + 13];
    const lz = a[o + 2] * mx + a[o + 6] * my + a[o + 10] * mz + a[o + 14];
    out[0] = W[0] * lx + W[4] * ly + W[8] * lz + W[12];
    out[1] = W[1] * lx + W[5] * ly + W[9] * lz + W[13];
    out[2] = W[2] * lx + W[6] * ly + W[10] * lz + W[14];
    return out;
  };
  const cellOf = layers.map(L => new Int32Array(L.mesh.count));
  for (const [li, L] of layers.entries()) {
    const a = L.mesh.instanceMatrix.array, W = L.W, n = L.mesh.count, ic = L.mesh.instanceColor?.array;
    const [mx, my, mz] = [L.mid.x, L.mid.y, L.mid.z], t = L.axes[0];
    for (let i = 0; i < n; i++) {
      const o = i * 16;
      // the part's centre and its thin (facing) axis, instance then mesh-to-group
      const lx = a[o] * mx + a[o + 4] * my + a[o + 8] * mz + a[o + 12];
      const ly = a[o + 1] * mx + a[o + 5] * my + a[o + 9] * mz + a[o + 13];
      const lz = a[o + 2] * mx + a[o + 6] * my + a[o + 10] * mz + a[o + 14];
      const px = W[0] * lx + W[4] * ly + W[8] * lz + W[12];
      const py = W[1] * lx + W[5] * ly + W[9] * lz + W[13];
      const pz = W[2] * lx + W[6] * ly + W[10] * lz + W[14];
      const tx = a[o + t * 4], ty = a[o + t * 4 + 1], tz = a[o + t * 4 + 2];
      let nx = W[0] * tx + W[4] * ty + W[8] * tz, ny = W[1] * tx + W[5] * ty + W[9] * tz, nz = W[2] * tx + W[6] * ty + W[10] * tz;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const key = ((Math.floor(px / cell) + 2048) * 4096 + (Math.floor(py / cell) + 2048)) * 4096 + (Math.floor(pz / cell) + 2048);
      let k = index.get(key);
      if (k === undefined) {
        k = acc.length; index.set(key, k);
        acc.push({ n: 0, p: [0, 0, 0], f: [0, 0, 0], c: [0, 0, 0], lo: [px, py, pz], hi: [px, py, pz] });
      }
      cellOf[li][i] = k;
      const e = acc[k];
      e.n++; e.p[0] += px; e.p[1] += py; e.p[2] += pz; e.f[0] += nx; e.f[1] += ny; e.f[2] += nz;
      let cr = L.base.r, cg = L.base.g, cb = L.base.b;
      if (ic) { cr *= ic[i * 3]; cg *= ic[i * 3 + 1]; cb *= ic[i * 3 + 2]; }
      e.c[0] += cr; e.c[1] += cg; e.c[2] += cb;
      if (px < e.lo[0]) e.lo[0] = px; if (py < e.lo[1]) e.lo[1] = py; if (pz < e.lo[2]) e.lo[2] = pz;
      if (px > e.hi[0]) e.hi[0] = px; if (py > e.hi[1]) e.hi[1] = py; if (pz > e.hi[2]) e.hi[2] = pz;
    }
    parts += n;
  }
  const mean = layers[0].mesh.material?.color?.clone() ?? new THREE.Color(1, 1, 1);
  const pos = [], nor = [], uv = [], rgb = [];
  // LIT AS ITS LEAVES FACE, from either side. A quad's own plane is not what its parts face:
  // shading the upright one as a wall and flipping the flat one dark from below draws manzanita
  // in dark bands up close. Both windings carry the parts' mean facing.
  const quad = (c, u, v, facing, hu, hv, colour, level) => {
    const P = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => c.clone().addScaledVector(u, x * hu).addScaledVector(v, y * hv));
    const qx = level % 2, qy = level >> 1;
    for (const k of [0, 1, 2, 0, 2, 3, 0, 2, 1, 0, 3, 2]) {
      pos.push(P[k].x, P[k].y, P[k].z); nor.push(facing.x, facing.y, facing.z);
      uv.push((qx + [0.02, 0.98, 0.98, 0.02][k]) / 2, (qy + [0.02, 0.02, 0.98, 0.98][k]) / 2);
      rgb.push(colour.r / Math.max(1e-4, mean.r), colour.g / Math.max(1e-4, mean.g), colour.b / Math.max(1e-4, mean.b));
    }
  };

  const up = new THREE.Vector3(0, 1, 0), side = new THREE.Vector3(1, 0, 0);
  // each card's plane, then — second pass — its members' true extent IN that plane: an
  // axis-aligned box projected onto a tilted card overstates it up to root 3, and Sunset Gold
  // draws 16% wider than its own model
  const frames = acc.map(e => {
    const nn = new THREE.Vector3(e.f[0], e.f[1], e.f[2]);
    if (nn.lengthSq() < 1e-9) nn.set(0, 1, 0);
    nn.normalize();
    const u = new THREE.Vector3().crossVectors(nn, Math.abs(nn.y) < 0.9 ? up : side).normalize();
    const v = new THREE.Vector3().crossVectors(nn, u).normalize();
    const c = [(e.lo[0] + e.hi[0]) / 2, (e.lo[1] + e.hi[1]) / 2, (e.lo[2] + e.hi[2]) / 2];
    return { nn, u, v, c, ext: [Infinity, -Infinity, Infinity, -Infinity] };
  });
  // ...AND ALONG THE WAY ITS PARTS LIE: a diagonal line of spikelets fills a square card unless
  // it is aligned, making reed grass's seed heads broad pale flakes. The card turns to its parts' main
  // direction in its plane (their second moments), then fits them.
  const q = [0, 0, 0];
  const each = fn => { for (const [li, L] of layers.entries()) for (let i = 0; i < L.mesh.count; i++) {
    const F = frames[cellOf[li][i]], p = at(L, i, q);
    const dx = p[0] - F.c[0], dy = p[1] - F.c[1], dz = p[2] - F.c[2];
    fn(F, dx * F.u.x + dy * F.u.y + dz * F.u.z, dx * F.v.x + dy * F.v.y + dz * F.v.z);
  } };
  for (const F of frames) F.m = [0, 0, 0, 0, 0, 0];     // n, su, sv, suu, svv, suv
  each((F, du, dv) => { const m = F.m; m[0]++; m[1] += du; m[2] += dv; m[3] += du * du; m[4] += dv * dv; m[5] += du * dv; });
  for (const F of frames) {
    const [n, su, sv, suu, svv, suv] = F.m, cu = su / n, cv = sv / n;
    const a = suu / n - cu * cu, b = svv / n - cv * cv, c = suv / n - cu * cv;
    const th = 0.5 * Math.atan2(2 * c, a - b);
    const u = F.u.clone().multiplyScalar(Math.cos(th)).addScaledVector(F.v, Math.sin(th));
    const v = F.v.clone().multiplyScalar(Math.cos(th)).addScaledVector(F.u, -Math.sin(th));
    F.u = u; F.v = v;
  }
  each((F, du, dv) => {
    if (du < F.ext[0]) F.ext[0] = du; if (du > F.ext[1]) F.ext[1] = du;
    if (dv < F.ext[2]) F.ext[2] = dv; if (dv > F.ext[3]) F.ext[3] = dv;
  });
  const halves = [];
  let drawnArea = 0;                          // the leaf area the cards draw: each quad x its density
  // the typical part's own one-sided area, at the typical part's size
  const protoLen = layers.map(L => L.size.getComponent(L.axes[2])).sort((x, y) => x - y)[layers.length >> 1] || partLen;
  const partArea = layers.map(L => L.oneSide).sort((x, y) => x - y)[layers.length >> 1] * (partLen / protoLen) ** 2;
  acc.forEach((e, k) => {
    const F = frames[k];
    // centred on the members' extent in the card's plane, and just covering it
    const c = new THREE.Vector3(...F.c).addScaledVector(F.u, (F.ext[0] + F.ext[1]) / 2).addScaledVector(F.v, (F.ext[2] + F.ext[3]) / 2);
    const hu = (F.ext[1] - F.ext[0]) / 2 + partLen / 2, hv = (F.ext[3] - F.ext[2]) / 2 + partLen / 2;
    halves.push(Math.sqrt(hu * hv));
    col.setRGB(e.c[0] / e.n, e.c[1] / e.n, e.c[2] / e.n);
    // HOW MUCH OF A QUAD ITS PARTS COVER: n parts of area a laid at random over area A cover
    // 1 - e^(-n a / A), and the quad takes the atlas quadrant drawn nearest that. A made-up
    // linear fade here varies a Ceanothus between 8% and 18% blue against full detail's 29%.
    // EACH PART ONCE: the card is two crossed quads, and a picture of all n parts on both draws
    // every leaf twice — making solid canopies where full detail's are airy. Half each,
    // against each quad's own area.
    const levelOf = area => {
      const cover = 1 - Math.exp(-(e.n / 2) * partArea / area);
      const k = DENSITIES.reduce((best, d, k) => Math.abs(d - cover) < Math.abs(DENSITIES[best] - cover) ? k : best, 0);
      drawnArea += area * DENSITIES[k];
      return k;
    };
    const hx = Math.min(hu, hv) * 0.7;
    quad(c, F.u, F.v, F.nn, hu, hv, col, levelOf(4 * hu * hv));
    quad(c, F.nn, F.v, F.nn, hx, hv, col, levelOf(4 * hx * hv));
  });
  // NO CARD REACHES PAST ITS LEAVES: a card's corners stand out beyond an oval cluster, and at the
  // edge of the plant they draw a rosemary 6% wide and a 30 cm prostrate one 3.5 cm tall.
  // Each corner is kept inside the leaves' own reach and height, measured off the leaves.
  let reach = 0, top = -Infinity;
  for (const m of meshes) { const h = layerReach(m, m.geometry, toGroup); reach = Math.max(reach, h.r); top = Math.max(top, h.top); }
  for (let i = 0; i < pos.length; i += 3) {
    const d = Math.hypot(pos[i], pos[i + 2]);
    if (d > reach) { pos[i] *= reach / d; pos[i + 2] *= reach / d; }
    if (pos[i + 1] > top) pos[i + 1] = top;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(rgb, 3));
  geo.computeBoundingBox(); geo.computeBoundingSphere();
  // THE PICTURE IS A FULL CARD: its parts at their true size against the median card, and as
  // many as a full card holds — so it is as dense as the full model is there. Sized against
  // the grid cell and capped at 400, a Ceanothus's florets cover only 30% of their cards.
  halves.sort((x, y) => x - y);
  const half = halves[halves.length >> 1] || cell / 2;
  const leafPx = THREE.MathUtils.clamp(partLen * 128 / half, 2, 128);
  const map = densityAtlas(aspect, leafPx);
  const tone = map?.userData?.meanTone ?? 1;
  if (tone !== 1) { const cc = geo.attributes.color.array; for (let i = 0; i < cc.length; i++) cc[i] /= tone; }
  // THE PART'S OWN MATERIAL, carrying the card's picture: the same type, sheen and translucency
  // as full detail's leaf — a plain matte card draws coyote brush 15-20% darker than its leaves.
  // Not an alphaTest cut-off either: shrunk for distance, a 30%-covered card averages to 30%
  // alpha, which a cut-off of 0.45 discards entirely — removing the blue flowers in Fast.
  const src = layers[0].mesh.material;
  const mat = src?.isMeshStandardMaterial ? sameMaterial(src)
    : new THREE.MeshStandardMaterial({ color: mean, roughness: 0.85 });
  // HASHED ALPHA, not alpha-to-coverage: a card's density lives in its picture, and shrunk for
  // distance a sparse card averages to ~12% alpha — which 4x MSAA coverage rounds to NO samples,
  // making Sunset Gold's needles vanish into a haze. A hashed threshold draws 12% of the pixels at
  // any distance; the shadow pass gets the same, or every card would shadow as a solid quad.
  Object.assign(mat, { map, vertexColors: true, side: THREE.FrontSide, shadowSide: THREE.DoubleSide, alphaHash: true,
    alphaToCoverage: false, alphaTest: 0, transparent: false, alphaMap: null, normalMap: null, bumpMap: null, roughnessMap: null });
  mat.color.copy(mean);
  mat.needsUpdate = true;
  const mesh = new THREE.Mesh(geo, mat);
  // leaves are "leaf cards", as the shoot plants' are (leafClusterCards): one name for one thing
  mesh.name = name === "foliage" ? "leaf cards" : `${name} cards`;
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.userData.leafArea = drawnArea;
  mesh.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaHash: true, side: THREE.DoubleSide });
  for (const m of meshes) m.removeFromParent();
  group.add(mesh);
  return { name, cards: acc.length, parts, partLength: +partLen.toFixed(4), cell: +cell.toFixed(3) };
}

/**
 * Are these parts small enough against the plant to be carded — at least eight cells of four
 * part-lengths across its spread? Bidens 'Sunbeam''s 5 cm leaves on a 0.7 m plant make 69
 * coarse cards and draw it 8% wide; kept as leaves, it is its own shape.
 */
function cardable(meshes, spread) {
  const m = meshes[0], geo = m.geometry;
  geo.computeBoundingBox();
  const size = geo.boundingBox.getSize(new THREE.Vector3()).multiply(typicalStretch(m));
  return 4 * Math.max(size.x, size.y, size.z) * 8 <= (spread || 1);
}

/**
 * Are these parts COMPACT — a floret, an urn, a disc — rather than long? A card stands for a
 * cluster; reed grass's 1.4 cm spikelets strung along narrow spikes become broad pale
 * flakes. Leaves are carded by size alone (their cards are the canopy); flower parts only if compact.
 */
function compact(meshes) {
  const m = meshes[0], geo = m.geometry;
  geo.computeBoundingBox();
  const [, mid, long] = geo.boundingBox.getSize(new THREE.Vector3()).multiply(typicalStretch(m)).toArray().sort((x, y) => x - y);
  return mid >= long / 2;              // a spikelet is ~0.36; florets and urns are near round
}

// ── A PLANT DRAWN FROM A MODEL FILE ──────────────────────────────────────────────────
//
// Full detail draws a 2 m+ tree the builders do not claim from the library (olive, toyon, oak,
// citrus, maple, pine ... — 20+ models), and any plant from the model the design agent fetched or
// made for its species. Fast must reduce those same models, including the five catalogue
// species on this route and any tree on another site. A library tree is two plain meshes — its
// branches, ~1-2 k tubes, and its leaves, 120-163 k separate pieces of 6 vertices — up to 656 k
// triangles. So in Fast the branches are simplified, and the leaves THINNED keeping their area: a
// share of the pieces kept, each grown in its own plane by the same share (a simplifier would
// melt 163 k separate leaves into blobs).

// the axes a set of points spreads along, widest first (a 3x3 covariance, Jacobi rotations)
function principalAxes(cov) {
  const a = cov.map(r => r.slice()), v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 12; sweep++) {
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-18) continue;
      const th = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]), c = Math.cos(th), s = Math.sin(th);
      for (let k = 0; k < 3; k++) { const x = a[k][p], y = a[k][q]; a[k][p] = c * x - s * y; a[k][q] = s * x + c * y; }
      for (let k = 0; k < 3; k++) { const x = a[p][k], y = a[q][k]; a[p][k] = c * x - s * y; a[q][k] = s * x + c * y; }
      for (let k = 0; k < 3; k++) { const x = v[k][p], y = v[k][q]; v[k][p] = c * x - s * y; v[k][q] = s * x + c * y; }
    }
  }
  return [0, 1, 2].map(i => ({ value: a[i][i], axis: [v[0][i], v[1][i], v[2][i]] })).sort((x, y) => y.value - x.value);
}

/** Which separate piece each vertex belongs to (vertices joined by a triangle are one piece). */
function piecesOf(geo) {
  const pos = geo.attributes.position, idx = geo.index, n = pos.count;
  const parent = new Int32Array(n).map((_, i) => i);
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const tris = (idx ? idx.count : n) / 3, at = k => (idx ? idx.getX(k) : k);
  for (let t = 0; t < tris; t++) {
    const a = find(at(t * 3)); parent[find(at(t * 3 + 1))] = a; parent[find(at(t * 3 + 2))] = a;
  }
  const of = new Int32Array(n), ids = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); if (!ids.has(r)) ids.set(r, ids.size); of[i] = ids.get(r); }
  return { of, count: ids.size };
}

/**
 * Keep one piece in `every`, each grown about its own centre so the pieces kept carry the area of
 * all of them: a flat piece (a leaf) in both of its broad axes by the square root of `every`, a
 * long one (a needle) across its width by `every`. The choice of piece is stable, load to load.
 */
export function thinPieces(geo, every) {
  const pos = geo.attributes.position, { of, count } = piecesOf(geo);
  const keep = k => (Math.imul(k + 1, 2654435761) >>> 0) % every === 0;
  const sum = new Float64Array(count * 3), cnt = new Int32Array(count), cov = new Float64Array(count * 6);
  for (let i = 0; i < pos.count; i++) {
    const k = of[i]; if (!keep(k)) continue;
    sum[k * 3] += pos.getX(i); sum[k * 3 + 1] += pos.getY(i); sum[k * 3 + 2] += pos.getZ(i); cnt[k]++;
  }
  for (let k = 0; k < count; k++) if (cnt[k]) for (let j = 0; j < 3; j++) sum[k * 3 + j] /= cnt[k];
  for (let i = 0; i < pos.count; i++) {
    const k = of[i]; if (!keep(k)) continue;
    const x = pos.getX(i) - sum[k * 3], y = pos.getY(i) - sum[k * 3 + 1], z = pos.getZ(i) - sum[k * 3 + 2], c = k * 6;
    cov[c] += x * x; cov[c + 1] += x * y; cov[c + 2] += x * z; cov[c + 3] += y * y; cov[c + 4] += y * z; cov[c + 5] += z * z;
  }
  const grow = new Map();
  for (let k = 0; k < count; k++) {
    if (!cnt[k]) continue;
    const c = cov.subarray(k * 6, k * 6 + 6), m = cnt[k];
    const [l, mid] = principalAxes([[c[0] / m, c[1] / m, c[2] / m], [c[1] / m, c[3] / m, c[4] / m], [c[2] / m, c[4] / m, c[5] / m]]);
    grow.set(k, l.value > 9 * mid.value ? [[mid.axis, every - 1]] : [[l.axis, Math.sqrt(every) - 1], [mid.axis, Math.sqrt(every) - 1]]);
  }
  const map = new Int32Array(pos.count).fill(-1);
  let nv = 0;
  for (let i = 0; i < pos.count; i++) if (keep(of[i])) map[i] = nv++;
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geo.attributes)) {
    const arr = new Float32Array(nv * attr.itemSize);
    for (let i = 0; i < pos.count; i++) if (map[i] >= 0)
      for (let j = 0; j < attr.itemSize; j++) arr[map[i] * attr.itemSize + j] = attr.getComponent(i, j);
    out.setAttribute(name, new THREE.BufferAttribute(arr, attr.itemSize, false));   // real values, as above
  }
  const p = out.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    if (map[i] < 0) continue;
    const k = of[i], d = [pos.getX(i) - sum[k * 3], pos.getY(i) - sum[k * 3 + 1], pos.getZ(i) - sum[k * 3 + 2]];
    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    for (const [e, f] of grow.get(k)) { const t = (d[0] * e[0] + d[1] * e[1] + d[2] * e[2]) * f; x += e[0] * t; y += e[1] * t; z += e[2] * t; }
    p.setXYZ(map[i], x, y, z);
  }
  const idx = geo.index?.array ?? Uint32Array.from({ length: pos.count }, (_, i) => i), kept = [];
  for (let t = 0; t < idx.length; t += 3) if (map[idx[t]] >= 0) kept.push(map[idx[t]], map[idx[t + 1]], map[idx[t + 2]]);
  out.setIndex(kept);
  out.computeBoundingBox(); out.computeBoundingSphere();
  return out;
}

/**
 * A model-file plant, reduced for Fast: its meshes share the plant's budget by their size; a mesh of
 * many small separate pieces (leaves) is thinned keeping its area, any other simplified.
 */
const REDUCED = new WeakMap();                     // source geometry -> share -> its reduction
export function reduceModel(root, spread) {
  if (!root) return root;
  const meshes = [];
  root.traverse(o => { if (o.isMesh && !o.isInstancedMesh && o.name !== "shadow") meshes.push(o); });
  const tris = o => (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3;
  const total = meshes.reduce((s, o) => s + tris(o), 0);
  const budget = PLANT_BUDGET * THREE.MathUtils.clamp(spread || 1, 0.25, 2);
  const report = { thinned: [], simplified: [] };
  if (total > budget) for (const o of meshes) {
    const share = budget * tris(o) / total;
    if (tris(o) <= share) continue;
    // the same source at the same share is the same reduction: a kind's individuals share it
    const every = Math.ceil(tris(o) / share), memo = REDUCED.get(o.geometry) ?? new Map();
    REDUCED.set(o.geometry, memo);
    if (!memo.has(every)) {
      const { count } = piecesOf(o.geometry);
      memo.set(every, count >= 256 && o.geometry.attributes.position.count / count <= 12
        ? { geo: thinPieces(o.geometry, every), how: "thinned" }
        : { geo: simplifyTo(o.geometry, Math.round(share)), how: "simplified" });
    }
    const r = memo.get(every);
    if (r.geo) { o.geometry = r.geo; report[r.how].push(o.name); }
  }
  root.userData.reduced = report;
  return root;
}

/**
 * A photoreal builder's plant, reduced for Fast in place (see above). `spread` is the plant's
 * declared spread: cards are never finer than a fortieth of it, or a 6 m Ray Hartman would be
 * carded at its florets' 14 mm and keep a third of a million cards.
 */
export function reduceBuilt(group, spread) {
  if (!group) return group;
  const inst = [], merged = [];
  group.traverse(o => { if (o.isInstancedMesh) inst.push(o); else if (o.isMesh && o.name !== "shadow") merged.push(o); });
  const report = { dropped: [], cards: [], thinned: [], simplified: 0 };
  // what lies ON a part goes — but a leaf's UNDERSIDE only when the leaves become cards (a card is
  // two-sided): kept as themselves, leaves are one-sided, and without their undersides half of a
  // silver thyme's leaves vanish whenever they face away
  const leavesCarded = (() => {
    const leaves = inst.filter(o => o.name === "foliage"), total = leaves.reduce((s, o) => s + o.count, 0);
    return total > CARD_ABOVE && total * 8 > PLANT_BUDGET * THREE.MathUtils.clamp(spread || 1, 0.25, 2) && leaves.length && cardable(leaves, spread);
  })();
  for (const o of [...inst, ...merged])
    if (OVERLAY.test(o.name) && (leavesCarded || !/undersides?$/i.test(o.name))) { report.dropped.push(o.name); o.removeFromParent(); }
  const byName = new Map();
  for (const o of inst) {
    if (!o.parent || o.count < 1) continue;
    if (!byName.has(o.name)) byName.set(o.name, []);
    byName.get(o.name).push(o);
  }
  // about panicle-sized for a 3.7 m Ceanothus: a fortieth of the spread smears five panicles
  // into one even tile, and the blue spikes read as a lavender carpet
  const minCell = Math.max(0.02, (spread || 1) / 80);
  const kept = [], flowers = [];               // layers drawn part by part; flower parts to card
  for (const [name, meshes] of byName) {
    const total = meshes.reduce((s, m) => s + m.count, 0);
    if (STRUCTURE.test(name) && total > FINE_WOOD_MAX) {
      // a grass's standing structure is kept — all of it that can be seen
      meshes.forEach((m, j) => {
        const seen = visiblePieces(m);
        if (seen < m.count) meshes[j] = thinnest(m, Math.max(seen, Math.round(FINE_WOOD_MAX * m.count / total)));
      });
      report.thinned.push(name);
    } else if (FINE_WOOD.test(name)) {
      if (total > FINE_WOOD_MAX)
        meshes.forEach((m, j) => { meshes[j] = thinnest(m, Math.max(20, Math.round(FINE_WOOD_MAX * m.count / total))); });
      report.thinned.push(name);
    } else if (total > CARD_ABOVE && total * 8 > PLANT_BUDGET * THREE.MathUtils.clamp(spread || 1, 0.25, 2)
               && !STRUCTURE.test(name) && cardable(meshes, spread) && (name === "foliage" || compact(meshes))) {
      // (carded only when the plant's budget cannot draw them as themselves at ~8 triangles
      // each: a silver thyme's 5,500 leaves fit its 60 k, and as cards it reads as a faint haze)
      if (name === "foliage") report.cards.push(cardsFor(group, meshes, name, minCell));
      else flowers.push(...meshes);
      continue;
    }
    kept.push(meshes);
  }
  // A FLOWER IS ONE CARD, whatever it is made of: Sunset Gold's petals, centres, calyces and buds
  // as four sets of cards occupy the same places and cost 1.2 M triangles — use one set, colours mixed
  if (flowers.length) report.cards.push(cardsFor(group, flowers, "bloom", minCell));
  // THE PLANT HAS ONE BUDGET, shared by the layers kept part by part, and it follows the plant's
  // size as its share of the screen does. Per layer, California fuchsia's flower — nine layers,
  // tube, sepals, ovary... — takes nine budgets, 330 k triangles of flowers.
  const share = PLANT_BUDGET * THREE.MathUtils.clamp(spread || 1, 0.25, 2) / Math.max(1, kept.length);
  group.updateWorldMatrix(true, true);
  const toGroup = new THREE.Matrix4().copy(group.matrixWorld).invert();
  for (const meshes of kept) {
    const count = meshes.reduce((s, m) => s + m.count, 0);
    const budget = Math.max(8, Math.floor(share / Math.max(1, count)));
    for (const m of meshes) {
      const full = triangles(m.geometry);
      if (full <= budget) continue;
      // A REDUCTION MUST KEEP THE PLANT'S REACH AND HEIGHT (REACH_TOLERANCE). The ways to draw a
      // part: the box stand-in; a blade's ribbon along its own midline (curl and tip, 2 triangles
      // a step); the part's own shape simplified. THE MOST DETAILED WITHIN THE BUDGET first —
      // the cheapest that keeps the size draws Coreopsis's 25 daisies as diamonds — then above it
      // cheapest first, because collapsing edges takes a blade's tip first and a curled fescue
      // blade can need 96 triangles. If none keeps the size, the part stays as it is.
      const want = layerReach(m, m.geometry, toGroup);
      // A PART BIG ON SCREEN KEEPS ITS BODY too: at a few triangles an echeveria's plump leaf keeps
      // its tip — reach and height pass — but draws as a spike. Past a fifteenth of the plant,
      // a reduction must keep 85% of the area the part shows.
      m.geometry.computeBoundingBox();
      const box = m.geometry.boundingBox.getSize(new THREE.Vector3());
      const big = box.clone().multiply(typicalStretch(m)).length() > (spread || 1) / 15;
      const axes3 = [0, 1, 2].sort((i, j) => box.getComponent(i) - box.getComponent(j));
      const thin = new THREE.Vector3().setComponent(axes3[0], 1);
      const body = big ? visibleArea(m.geometry, thin) : 0;
      // (the body test is for the simplifier's output alone: a ribbon keeps a blade's width ring by
      // ring, and a closed blade's two faces make every ribbon look like half the area)
      const sized = g => { const h = layerReach(m, g, toGroup);
        return h.r >= want.r * (1 - REACH_TOLERANCE) && h.top >= want.top - Math.abs(want.top) * REACH_TOLERANCE; };
      // A ONE-SIDED PART KEEPS ITS FACING: a leaf's top is a surface facing one way (its
      // area-weighted mean normal near 1 long). A rolled thyme leaf's box is too thick to count as
      // flat, so a crossed-plane stand-in faces sideways and down, drawing silver thyme and
      // Cleveland sage 12-19% dark — simplifications of the leaf itself face up
      const facing = meanNormal(m.geometry), oneSided = facing.lengthSq() > 0.25;
      const faces = g => !oneSided || meanNormal(g).dot(facing) >= 0.75 * facing.lengthSq();
      const holds = (g, simplified) => sized(g) && faces(g) && (!big || !simplified || visibleArea(g, thin) >= body * 0.85);
      const ways = [{ tris: 8, make: () => standIn(m.geometry, typicalStretch(m)) }];
      // A RIBBON IS FOR A BLADE — a strip along its midline. As a ribbon a 2:1 silver thyme leaf draws
      // 12% dark and Cleveland sage 19%. A blade is LONG against its THINNEST side however it
      // arches: a deer grass blade is 28 cm by 2 mm, and judged against its middle side (the arch's
      // height) it is denied its ribbon and draws as flat plates across the plant's foot
      const drawn = box.clone().multiply(typicalStretch(m)).toArray().sort((x, y) => x - y);
      const across = drawn.find(v => v > drawn[2] * 1e-6) ?? drawn[2];
      if (drawn[2] > BLADE_ASPECT * across)
        for (const k of [4, 8, 16, 32]) ways.push({ tris: 2 * k, ribbon: true, make: () => ribbonOf(m.geometry, k) });
      for (let t = budget; t < full / 2; t *= 2) ways.push({ tris: t, simplified: true, make: () => simplifyTo(m.geometry, t) });
      const order = [...ways.filter(w => w.tris <= budget).sort((x, y) => y.tris - x.tris || !!y.ribbon - !!x.ribbon),
                     ...ways.filter(w => w.tris > budget).sort((x, y) => x.tris - y.tris)];
      // NONE KEEPS IT ALL: the cheapest that keeps the size, else the closest — never the full part
      // (kept whole, a California fescue's folded blades cost 15,588 triangles each)
      let pick = null, closest = null, best = -Infinity, sizedOnly = null;
      for (const w of order) {
        const g = w.make();
        // judged by what it IS: a request for 18 triangles can stop at 5,625
        if (!g || triangles(g) > Math.max(16, w.tris * 2)) continue;
        if (holds(g, w.simplified)) { pick = g; break; }
        if (!sizedOnly && sized(g) && (w.simplified || w.ribbon)) sizedOnly = g;
        // the fallback is never the box stand-in: for a folded fescue blade it is a flat rhombus
        // the size of the blade's whole box, drawing grey blocks round the plant's foot
        if (!w.simplified && !w.ribbon) continue;
        const h = layerReach(m, g, toGroup), score = Math.min(h.r / want.r, h.top / want.top);
        if (score > best) { best = score; closest = g; }
      }
      pick ??= sizedOnly ?? closest;
      if (!pick) continue;
      if (pick.userData.ribbon && m.material && m.material.side !== THREE.DoubleSide) {
        // a blade is a thin closed solid drawn front-faces only; its ribbon is one face
        m.material = sameMaterial(m.material); m.material.side = THREE.DoubleSide;
      }
      m.geometry = pick;
      m.computeBoundingBox(); m.computeBoundingSphere();
      report.simplified++;
    }
  }
  for (const m of merged) {
    if (!m.parent || triangles(m.geometry) <= MERGED_MAX) continue;
    const g = simplifyTo(m.geometry, MERGED_MAX);
    if (g) { m.geometry = g; report.simplified++; }
  }
  group.userData.renderQuality = "fast";
  group.userData.previewStandIns = true;
  group.userData.reduced = report;
  return group;
}
