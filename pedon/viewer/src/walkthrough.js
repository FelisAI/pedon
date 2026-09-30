// Eye-level walkthrough: render the design the way a person standing in the
// yard would see it, from several places, and hand those frames to the model.
//
// A critique made from a render taken from outside the scene looking in judges
// the garden from the one viewpoint it is never experienced from. A design
// reads completely differently at 1.65 m standing on its own
// path: you find out that a bed edge is a straight line, that a walk aims at
// nothing, that a shrub blocks the view you were routing toward, and that the
// slope you terraced is now a wall in your face. None of that is visible in
// plan or from a drone height.
//
// Stations come from where a person actually is: along the design's own paths
// (both directions, because half of every real walk is the return) and standing
// IN each usable area looking out and back — a terrace is judged by the view
// from sitting on it, not by how it looks from the path going past.
import * as THREE from "three";
import { readMaxLuma, holdView } from "./framecheck.js";

const EYE_M = 1.65;

/** Sample points along a polyline at roughly `every` metres, in ENU. */
function walkPoints(spline, every = 4) {
  const out = [];
  let carry = 0;
  for (let i = 0; i < spline.length - 1; i++) {
    const [ax, ay] = spline[i], [bx, by] = spline[i + 1];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-6) continue;
    for (let d = carry; d < len; d += every) {
      const t = d / len;
      out.push({ p: [ax + (bx - ax) * t, ay + (by - ay) * t],
                 dir: [(bx - ax) / len, (by - ay) / len] });
    }
    carry = (carry + Math.ceil((len - carry) / every) * every) - len;
    if (carry < 0) carry = 0;
  }
  const last = spline[spline.length - 1], prev = spline[spline.length - 2] ?? last;
  const dl = Math.hypot(last[0] - prev[0], last[1] - prev[1]) || 1;
  out.push({ p: last, dir: [(last[0] - prev[0]) / dl, (last[1] - prev[1]) / dl] });
  return out;
}

/**
 * Stations to shoot from: walking the paths, plus a look back from each end.
 * Returns [{name, eye:[x,y], look:[x,y]}] in ENU metres.
 */
export function planStations(design, maxStations = 8) {
  const stations = [];
  const paths = (design.paths ?? []).slice().sort(
    (a, b) => (b.spline?.length ?? 0) - (a.spline?.length ?? 0));

  for (const path of paths) {
    if (!path.spline || path.spline.length < 2) continue;
    for (const { p, dir } of walkPoints(path.spline, 5)) {
      stations.push({ name: `${path.id} looking ahead`, rank: 1,
                      eye: p, look: [p[0] + dir[0] * 12, p[1] + dir[1] * 12] });
    }
    // one look back down the route: a path almost always reads differently
    // in the return direction, and that is half of every actual walk
    const pts = walkPoints(path.spline, 5);
    if (pts.length > 1) {
      const end = pts[pts.length - 1], start = pts[0];
      stations.push({ name: `${path.id} looking back`, rank: 1, eye: end.p, look: start.p });
    }
  }

  // Stand IN each usable area and look out from it. This is the view the owner
  // will actually spend time in — a terrace is judged by what you see sitting
  // on it, not by what it looks like from the path going past.
  for (const pad of design.patios ?? []) {
    const xs = pad.polygon.map(v => v[0]), ys = pad.polygon.map(v => v[1]);
    const cx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const cy = ys.reduce((a, b) => a + b, 0) / ys.length;
    // look downhill (the view) and back uphill (what you sit against)
    let far = pad.polygon[0], fd = -1;
    for (const [x, y] of pad.polygon) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > fd) { fd = d; far = [x, y]; }
    }
    const label = pad.purpose ? `${pad.id} (${pad.purpose})` : pad.id;
    stations.push({ name: `sitting on ${label}`, rank: 0, eye: [cx, cy],
                    look: [cx + (far[0] - cx) * 6, cy + (far[1] - cy) * 6] });
    stations.push({ name: `${label}, looking back`, rank: 0, eye: [cx, cy],
                    look: [cx - (far[0] - cx) * 6, cy - (far[1] - cy) * 6] });
  }

  // ── THE DESIGN'S OWN FURNITURE AND THRESHOLDS ────────────────────────────
  //
  // A design agent driving its own cameras makes much more sense than eight
  // standard stations, so the stations must see what the design is about. A
  // planner that ignores `objects`, and uses a patio's `purpose` only as a
  // caption, is blind to the things that carry a design's style, and stands in
  // the MIDDLE of a terrace looking at its own corner.
  //
  // The faults that matter are about objects: a lantern filling the face of
  // someone sitting on the bench, the same lantern plugging the moon gate's
  // opening, a pergola post cutting the line to the gate, a standing stone and a
  // koi pond invisible behind planting. None of those is visible from a point
  // sampled every five metres along a path.
  //
  // The taxonomy is the one ASSET_FIDELITY.md already uses, because it is about
  // the body: "a bench seat is knee-high, a moon gate is walked through". A SEAT
  // is a place you look FROM, sitting. A THRESHOLD is a thing you look THROUGH. A
  // FOCAL object is a thing you look AT — so it is a target, never a station.
  const SEAT = /bench|seat|chair|stool|sofa/i;
  const THRESHOLD = /gate|arch|torii|doorway|portal/i;
  const FOCAL = /lantern|basin|stone|boulder|pond|jar|pot|fountain|sculpture|urn/i;
  const objs = (design.objects ?? []).filter(o => Array.isArray(o.position));
  const focal = objs.filter(o => FOCAL.test(o.kind ?? ""));
  // A patio's `purpose` is written by the designer and usually NAMES the view:
  // "one bench looking back west and UP the whole slope to a standing stone".
  // That sentence is better evidence than any distance heuristic — measured on
  // a real design, nearest-object picks a 0.6 m glazed pot at 2.3 m over the
  // 1.6 m standing stone the purpose actually names, and height-over-distance
  // picks a lantern the designer has just moved OUT of that view.
  const named = (() => {
    const text = (design.patios ?? []).map(p => p.purpose || "").join(" ").toLowerCase();
    if (!text) return null;
    const hits = objs.filter(o => o.kind && text.includes(o.kind.toLowerCase()));
    return hits.length ? hits : null;
  })();
  const nearestFocal = (from, notId) => {
    let best = null, bd = Infinity;
    // prefer something the design SAID it was looking at, if one is in range
    const pool = (named && named.filter(o => FOCAL.test(o.kind ?? "") && o.id !== notId).length)
      ? named.filter(o => FOCAL.test(o.kind ?? ""))
      : focal;
    for (const f of pool) {
      if (f.id === notId) continue;
      const d = Math.hypot(f.position[0] - from[0], f.position[1] - from[1]);
      if (d < bd && d > 0.4) { bd = d; best = f; }
    }
    return bd <= 12 ? best : null;      // past ~12 m it is scenery, not the view
  };

  for (const o of objs) {
    const kind = o.kind ?? "";
    if (SEAT.test(kind)) {
      // Sit on it and look where it is pointed: at the nearest thing worth
      // looking at, or, failing that, along its own facing.
      const tgt = nearestFocal(o.position, o.id);
      let look;
      if (tgt) {
        look = tgt.position;
      } else {
        const th = ((o.rotation_deg ?? 0) * Math.PI) / 180;
        look = [o.position[0] + Math.sin(th) * 10, o.position[1] + Math.cos(th) * 10];
      }
      stations.push({ name: `sitting on the ${kind}` + (tgt ? `, looking at the ${tgt.kind}` : ""),
                      id: o.id, rank: 0, eye: o.position, look, eye_m: 1.15 });
    } else if (THRESHOLD.test(kind)) {
      // Stand back and look THROUGH it. A moon gate's whole job is to frame
      // something, and whether it does cannot be seen from beside it.
      const th = ((o.rotation_deg ?? 0) * Math.PI) / 180;
      const ax = [Math.sin(th + Math.PI / 2), Math.cos(th + Math.PI / 2)];   // through the opening
      const back = 3.5, ahead = 9;
      stations.push({
        rank: 0, id: o.id,
        name: `through the ${kind}`,
        eye: [o.position[0] - ax[0] * back, o.position[1] - ax[1] * back],
        look: [o.position[0] + ax[0] * ahead, o.position[1] + ax[1] * ahead],
      });
      stations.push({
        rank: 0,
        name: `through the ${kind}, the other way`,
        eye: [o.position[0] + ax[0] * back, o.position[1] + ax[1] * back],
        look: [o.position[0] - ax[0] * ahead, o.position[1] - ax[1] * ahead],
      });
    }
  }

  // If the design has no paths or pads yet, stand off each bed and look at it.
  if (!stations.length) {
    for (const bed of design.beds ?? []) {
      const xs = bed.polygon.map(v => v[0]), ys = bed.polygon.map(v => v[1]);
      const cx = xs.reduce((a, b) => a + b, 0) / xs.length;
      const cy = ys.reduce((a, b) => a + b, 0) / ys.length;
      const r = Math.max(...bed.polygon.map(([x, y]) => Math.hypot(x - cx, y - cy)));
      stations.push({ name: `standing off ${bed.id}`, rank: 1,
                      eye: [cx + (r + 6), cy], look: [cx, cy] });
    }
  }

  // WHAT SURVIVES THE BUDGET IS DECIDED BY MEANING, NOT BY ARRAY POSITION.
  //
  // Spreading the picks evenly across the list does not work. Paths are pushed
  // first and sampled every five metres, so on a design with real furniture the
  // walk fills up with connective tissue and thins out the seats and the gate —
  // the two places the design is actually about.
  //
  // So: the design's INTENTIONS are kept whole (where you sit, what you look
  // through, the ground you occupy), and the path samples — which are a
  // reasonable thing to thin, because one stretch of walk resembles the next —
  // are spread across whatever budget is left.
  if (stations.length <= maxStations) return uniqueNames(stations);
  const intended = stations.filter(s => s.rank === 0);
  const rest = stations.filter(s => s.rank !== 0);
  const room = Math.max(0, maxStations - intended.length);
  if (!room) return uniqueNames(intended.slice(0, maxStations));
  const step = rest.length / room;
  const thinned = Array.from({ length: room }, (_, i) => rest[Math.floor(i * step)]);
  return uniqueNames([...intended, ...thinned].filter(Boolean));
}

/**
 * No two stations may have the same name.
 *
 * A station's name IS its address: it captions the frame, it is what the
 * critique writes about, and it is what the owner reads to know which corner is
 * being discussed. A design with two benches would otherwise get two photographs
 * captioned "sitting on the bench, looking at the lantern" — from different
 * places, looking at different lanterns — with nothing in the picture or the
 * caption saying which is which.
 *
 * Disambiguated by the object's own ID, because that is the address everything
 * else in this project uses: an op names `bench_tea`, the objects list shows it,
 * and a critique saying "the bench (bench_tea)" can be acted on. A bare "(2)"
 * would say only that there is another one.
 */
export function uniqueNames(stations) {
  const count = new Map();
  for (const s of stations ?? []) count.set(s.name, (count.get(s.name) ?? 0) + 1);
  const seen = new Map();
  return (stations ?? []).map(s => {
    if ((count.get(s.name) ?? 0) < 2) return s;
    const n = (seen.get(s.name) ?? 0) + 1;
    seen.set(s.name, n);
    return { ...s, name: `${s.name} (${s.id ?? n})` };
  });
}

/**
 * Render each station and return data URLs.
 * `ctx` supplies the live scene: {renderer, scene, camera, heightAt, enuToWorld,
 * enuToWorldPoint}. The last two are NOT interchangeable — enuToWorld stays in the
 * ENU frame (what heightAt wants), enuToWorldPoint reaches world (what the camera
 * wants). They are identical until north is set, which makes them easy to confuse.
 */
export async function renderWalkthrough(ctx, stations, { width = 1280, height = 800, fov = 62 } = {}) {
  const { renderer, scene, camera, heightAt, enuToWorld, enuToWorldPoint } = ctx;
  // fall back to the ENU-frame function only if a caller has not been updated;
  // correct at yaw 0, and the frame_check assertion will catch it otherwise
  const toWorld = enuToWorldPoint ?? enuToWorld;
  const restoreView = holdView(renderer, camera);
  const frames = [];
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    camera.up.set(0, 1, 0);
    camera.fov = fov;                       // close to a human's comfortable view
    camera.aspect = width / height;
    camera.updateProjectionMatrix();

    for (const st of stations) {
      // TWO frames, deliberately. heightAt() is an ENU lookup, so the ground
      // query uses the ENU point; the camera lives in WORLD, so its position
      // must go through enuToWorldPoint(). Using enuToWorld() for both puts every
      // station 5.6 m + tx/tz from where it belongs the moment north is set —
      // and at the ground height of a place it is no longer standing.
      const e = enuToWorld(st.eye[0], st.eye[1], 0);
      const l = enuToWorld(st.look[0], st.look[1], 0);
      const gEye = heightAt(e.x, e.z), gLook = heightAt(l.x, l.z);
      if (!Number.isFinite(gEye)) continue;   // station is off the scanned ground
      const ew = toWorld(st.eye[0], st.eye[1], 0);
      const lw = toWorld(st.look[0], st.look[1], 0);
      // A station may carry its own eye height. A bench is judged from SEATED
      // height — a lantern a metre and a half in front of a seated person's
      // face is a fact about sitting down, and standing at 1.65 m over the same
      // spot does not show it.
      const eyeM = Number.isFinite(st.eye_m) ? st.eye_m : EYE_M;
      camera.position.set(ew.x, gEye + eyeM, ew.z);
      // look slightly down-slope-aware: aim at eye height at the target, so the
      // horizon sits naturally rather than pitching at the ground
      camera.lookAt(lw.x, (Number.isFinite(gLook) ? gLook : gEye) + eyeM * 0.9, lw.z);
      camera.updateMatrixWorld(true);
      renderer.render(scene, camera);
      // measured BEFORE encoding, and carried with the frame: otherwise a black
      // frame is saved and handed on with nothing anywhere saying so
      frames.push({ name: st.name, eye: st.eye, look: st.look,
                    ground_m: +gEye.toFixed(2),
                    maxLuma: readMaxLuma(renderer),
                    dataUrl: renderer.domElement.toDataURL("image/jpeg", 0.82) });
    }
  } finally {
    restoreView();
  }
  return frames;
}
