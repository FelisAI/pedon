/**
 * A granular surface texture — the one generator, for ground AND for objects.
 *
 * Flat colour is the most obviously computer-generated thing in any frame — a
 * bed rendered as flat #4a3423 and a walk as flat #c2a878 — and nothing in that
 * argument is about the ground: a stone lantern, a dry-stone wall, a timber bench
 * and a boulder in one unbroken hue fail the same way. So objects.js uses this
 * generator as well as design.js.
 *
 * It is a MODULE rather than an export from design.js because design.js already
 * imports objects.js, so the other direction would be a cycle. A second speckle
 * generator would drift from this one, like any copied lookup.
 */
import * as THREE from "three";

const cache = new Map();
export function groundTexture(hex, grain, coarse, bond = null, chips = false, steppers = false,
                              strands = false) {
  const key = `${hex}|${grain}|${coarse}|${bond ? `${bond.courses}x${bond.units}` : "-"}`
            + `|${chips ? "chip" : "-"}|${steppers ? "step" : "-"}|${strands ? "strand" : "-"}`;
  if (cache.has(key)) return cache.get(key);
  // 512, not 128. Tiled over the 1.4 m these surfaces use, 128 px is 91 px per
  // METRE — blurry from two metres away, which is where a path is looked at, and
  // it is why the tile repeat reads as a grid rather than as gravel. 512 gives
  // 366 px/m. It costs one canvas per material, generated once and cached, and
  // fidelity is worth a slower render here — there is no budget to trade it against.
  const S = 512;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const ctx = c.getContext("2d");
  const base = new THREE.Color(hex);
  // STEPPING STONES ARE THE GAP. Everything else here paints a full tile; this one
  // must not, because a stepping stone path is discrete stones with the ground
  // showing between them, and drawn as an unbroken ribbon with a joint pattern it
  // is simply a paved path — the same class of error as a screen that does not
  // screen, where the object's defining property is missing rather than merely
  // coarse.
  //
  // A fresh canvas is already transparent, so the gaps cost nothing: skip the base
  // fill, paint only the stones, and let design.js put an alphaTest on the
  // material. The path ribbon keeps its geometry and the real ground shows through
  // — no change to pathMesh, and the stones follow the path because the UVs do.
  if (!steppers) {
    ctx.fillStyle = `#${base.getHexString()}`;
    ctx.fillRect(0, 0, S, S);
  }
  // deterministic speckle so a reload never reshuffles the ground
  let seed = 0;
  for (let i = 0; i < key.length; i++) seed = (seed * 31 + key.charCodeAt(i)) >>> 0;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  // Speck counts are DERIVED from S so the grain stays the same size on the
  // ground when the resolution changes. Constant counts are tuned for one tile
  // size: raising S from 128 alone quadruples the tile's area while leaving the
  // speckle count alone — the same gravel, spread four times thinner, which is a
  // smooth beige plane again.
  const density = (S / 128) ** 2;
  if (steppers) {
    // Two stones per tile, staggered, each about 0.5 x 0.42 m on the 1.4 m tile
    // these surfaces use — a real stepping stone is a slab you put one foot on.
    // Rectangles because the shim in tests/js/design.test.mjs provides fillRect
    // and nothing else, and because a cut flag IS rectangular; the jitter below
    // is what keeps two of them from reading as tiling.
    for (const [cx, cy] of [[0.30, 0.26], [0.68, 0.74]]) {
      const w = S * (0.34 + rand() * 0.06), hgt = S * (0.27 + rand() * 0.06);
      const x0 = cx * S - w / 2 + (rand() - 0.5) * S * 0.04;
      const y0 = cy * S - hgt / 2 + (rand() - 0.5) * S * 0.04;
      // each stone its own tone, as in the wall bond above: stones were found,
      // not cut from one block
      ctx.fillStyle = `#${base.clone().multiplyScalar(0.88 + rand() * 0.22).getHexString()}`;
      ctx.fillRect(x0, y0, w, hgt);
      // Speckle CONFINED TO THIS STONE, inset so a speck cannot straddle the edge.
      // The obvious shortcut — speckle the whole tile and let the gaps stay
      // transparent — does not work: fillStyle is an opaque colour, so a speck
      // landing on a transparent pixel makes it opaque. The gaps would fill in
      // with confetti.
      const inset = (S / 128) * 1.5;
      for (let i = 0; i < 620 * density; i++) {
        const k = 1 + (rand() - 0.5) * 2 * grain;
        ctx.fillStyle = `#${base.clone().multiplyScalar(k).getHexString()}`;
        const r = (S / 128) * (0.6 + rand() * 1.4);
        ctx.fillRect(x0 + inset + rand() * (w - 2 * inset - r),
                     y0 + inset + rand() * (hgt - 2 * inset - r), r, r);
      }
    }
  } else if (strands) {
    // SHREDDED BARK IS STRANDS, not speckle. It is a common mulch — "shredded
    // cedar bark", "shredded redwood bark" — and an even fine mottle over flat
    // brown is what a bed of it looks like from fifty metres and nothing like
    // what it looks like from the two metres a bed is actually seen from.
    //
    // A shred is long, thin and lies FLAT with its neighbours going every which
    // way, and the dark between them is deep because the mulch is loose and open.
    // fillRect can only draw axis-aligned boxes, so the direction has to come from
    // alternating long-and-thin with thin-and-long — which at shred scale is
    // enough, because what the eye reads is the elongation and the tangle, not the
    // precise angle of each piece.
    ctx.fillStyle = `#${base.clone().multiplyScalar(0.45).getHexString()}`;
    ctx.fillRect(0, 0, S, S);
    const unit = S / 128;
    for (const [count, len, wide] of [[900 * density, coarse * unit * 5.0, unit * 1.5],
                                      [1400 * density, coarse * unit * 3.0, unit * 1.1],
                                      [2200 * density, coarse * unit * 1.6, unit * 0.9]]) {
      for (let i = 0; i < count; i++) {
        const k = 0.62 + rand() * 0.72;
        ctx.fillStyle = `#${base.clone().multiplyScalar(k).getHexString()}`;
        const l = len * (0.5 + rand()), w2 = wide * (0.7 + rand() * 0.7);
        // half the shreds lie the other way, which is the whole tangle
        const [dx, dy] = rand() < 0.5 ? [l, w2] : [w2, l];
        ctx.fillRect(rand() * S, rand() * S, dx, dy);
      }
    }
  } else if (chips) {
    // A LOOSE AGGREGATE IS STONES WITH SHADOW BETWEEN THEM.
    //
    // gravel, decomposed granite and the free-text mulches that route to
    // `aggregate` are the most used surfaces in the whole corpus by a distance —
    // about 210 instances against 40 for flagstone. An even ±25% mottle over a
    // flat beige renders them as sandpaper, which at the 1-3 m a path is looked
    // at from averages back to the flat beige it started as.
    //
    // Two things matter and neither is the speck size (a 7 px chip on a 366 px/m
    // tile is 2 cm). INTERSTITIAL SHADOW — the dark between stones is most of
    // what makes a loose surface read as loose rather than as a poured one — and
    // a wide tonal range: a real crushed granite runs from near-white quartz to
    // near-black mafic in the same handful.
    //
    // Angular chips rather than rounded pebbles, deliberately: the corpus says
    // "3/4 inch crushed granite", "decomposed granite", "crushed rock". Crushed
    // stone IS angular, so the fillRect the generator already uses is the honest
    // shape, and it keeps this to the one canvas API the node test shims provide.
    ctx.fillStyle = `#${base.clone().multiplyScalar(0.42).getHexString()}`;
    ctx.fillRect(0, 0, S, S);
    // three grades, coarse to fine, each filling the gaps the last left — which
    // is how a graded aggregate actually packs, and what stops the shadow reading
    // as holes
    for (const [count, size, lo, hi] of [[1500 * density, coarse * (S / 128) * 1.7, 0.62, 1.42],
                                         [3000 * density, coarse * (S / 128) * 0.9, 0.55, 1.35],
                                         [6000 * density, (S / 128) * 0.8, 0.50, 1.25]]) {
      for (let i = 0; i < count; i++) {
        const k = lo + rand() * (hi - lo);
        ctx.fillStyle = `#${base.clone().multiplyScalar(k).getHexString()}`;
        const r = size * (0.45 + rand() * 1.1);
        // a chip is longer one way than the other, and never square-on
        ctx.fillRect(rand() * S, rand() * S, r, r * (0.6 + rand() * 0.8));
      }
    }
  } else {
    for (const [count, size, amp] of [[900 * density, coarse * (S / 128), grain],
                                      [4200 * density, S / 128, grain * 0.6]]) {
      for (let i = 0; i < count; i++) {
        const k = 1 + (rand() - 0.5) * 2 * amp;
        const col = base.clone().multiplyScalar(k);
        ctx.fillStyle = `#${col.getHexString()}`;
        const r = size * (0.5 + rand());
        ctx.fillRect(rand() * S, rand() * S, r, r);
      }
    }
  }
  // Courses and joints, over the grain. What makes masonry read as masonry is
  // the JOINTS: without them a stone wall and a poured wall differ only in
  // hue, and a stone wall renders as flat #9a958a.
  // The tile is a whole number of courses (WALL_SURFACES states it and
  // tests/js/design.test.mjs asserts it), so the bond runs unbroken across the
  // tile seam; alternate rows step half a unit, because anything stacked is
  // laid in a running bond and a stacked bond reads as a printed pattern.
  if (bond) {
    const w = Math.max(1, Math.round(S / 64));
    const rowH = S / bond.courses;
    for (let r = 0; r < bond.courses; r++) {
      // EVERY STONE ITS OWN FACE. Uniform stones and evenly spaced joints read as
      // a concrete block wall, the most obviously built thing in the frame. A
      // dry-stone wall is stones that were found, not cut: each face
      // takes its own tone here, within a range that keeps them the same rock.
      //
      // The JOINTS move too, but only the vertical ones. Course heights have to
      // stay uniform because the tile is a whole number of courses (WALL_SURFACES
      // states it and design.test.mjs asserts it), and that is what lets the bond
      // run unbroken across the tile seam. Widths can vary freely as long as the
      // row still starts at 0 and ends at S, so the seam stays invisible.
      const cuts = [0];
      for (let j = 1; j < bond.units; j++) {
        const even = j / bond.units;
        cuts.push(even + (rand() - 0.5) * (0.55 / bond.units));
      }
      cuts.push(1);
      const shift = (r % 2) * 0.5 / bond.units;      // running bond, still
      for (let j = 0; j < cuts.length - 1; j++) {
        const x0 = (cuts[j] + shift) * S, x1 = (cuts[j + 1] + shift) * S;
        // TRANSLUCENT, or the face paints over the speckle laid down above and
        // every stone becomes a flat tone block: irregular, bonded, and smoother
        // than the concrete it is meant to stop looking like. The grain has to
        // survive the tone.
        const face = base.clone().multiplyScalar(0.88 + rand() * 0.24);
        // globalAlpha set and reset directly rather than save()/restore(): the
        // node suites shim a canvas context with only the methods this file
        // calls, and save/restore are not among them — a property assignment is
        // safe on the shim where a missing method is a crash.
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = `#${face.getHexString()}`;
        ctx.fillRect(x0, r * rowH, x1 - x0, rowH);
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = `#${base.clone().multiplyScalar(0.62).getHexString()}`;
      ctx.fillRect(0, r * rowH, S, w);
      for (const c0 of cuts.slice(0, -1))
        ctx.fillRect((c0 + shift) * S, r * rowH, w, rowH);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, t);
  return t;
}

