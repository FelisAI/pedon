// The viewer's eyes-for-hire: renders views that a headless model asks for.
//
// A `claude -p` subprocess has no display, so it cannot render. The browser has
// the loaded scan, the live design, the calibration and the growth scale. This
// subscribes to the dev server's render channel, executes requests against the
// LIVE scene, and posts the frame back.
//
// The camera is saved and restored exactly, so a render never disturbs what the
// owner is looking at.
import { buildArScan } from "./ar_scan.js";
import { buildArScene } from "./ar_cards.js";
import { carveForExport } from "./carve.js";
import { buildDesignGroup } from "./design.js";
import { preparePlantTextures } from "./plant_textures.js";
import { ensureAssets, assetsNeededBy, ensureObjectModels, objectModelsNeededBy } from "./assets.js";
import * as THREE from "three";
import { readMaxLuma, blankFrameReason, duplicateStations, holdView } from "./framecheck.js";
import { withCleanScene } from "./clean.js";
import { planStations, renderWalkthrough } from "./walkthrough.js";
import { slopeLayer, edgeLayer } from "./diagnostic.js";
import { activeDesign } from "./design_doc.js";

const EYE_M = 1.65;

/** Where the model is pointing: a design id, a landmark, an area, or "x,y". */
function resolveSubject(subject, ctx) {
  const { enuGroup, heightAt, enuToWorld, site, design } = ctx;

  const asXY = String(subject).match(/^\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*$/);
  if (asXY) {
    const x = +asXY[1], y = +asXY[2];
    return { name: `point ${x},${y}`, enu: [x, y], radius: 6 };
  }

  for (const a of site?.areas ?? []) {
    if (a.name.toLowerCase() === String(subject).toLowerCase()) {
      const xs = a.polygon.map(p => p[0]), ys = a.polygon.map(p => p[1]);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      return { name: `area ${a.name}`, enu: [cx, cy],
               radius: Math.max(Math.max(...xs) - Math.min(...xs),
                                Math.max(...ys) - Math.min(...ys)) / 2 + 2 };
    }
  }

  for (const lm of site?.landmarks ?? []) {
    if (lm.name.toLowerCase() === String(subject).toLowerCase()) {
      return { name: `landmark ${lm.name}`, enu: [lm.x, lm.y], radius: 5 };
    }
  }

  // a design object, by id. getObjectByName, NOT children.find: designs are
  // layers under a "designs" container, so the working design is a grandchild of
  // enuGroup and a shallow scan silently finds nothing — `look` would not
  // resolve a single design object.
  const dg = ctx.designGroup?.() ?? enuGroup.getObjectByName("design");
  const hit = dg?.children.find(c => String(c.userData?.id) === String(subject));
  if (hit) {
    const box = new THREE.Box3().setFromObject(hit);
    const c = box.getCenter(new THREE.Vector3());
    const s = box.getSize(new THREE.Vector3());
    // the box is WORLD; subjects are quoted in ENU, so come back through the frame
    const e = enuGroup.worldToLocal(c.clone());
    return { name: `${subject}`, enu: [e.x, -e.z],
             radius: Math.max(s.x, s.z) / 2 + 3, box };
  }
  return null;
}

const DIRS = { n: [0, 1], ne: [0.7, 0.7], e: [1, 0], se: [0.7, -0.7],
               s: [0, -1], sw: [-0.7, -0.7], w: [-1, 0], nw: [-0.7, 0.7] };

/**
 * Place the camera for one request and render.
 *
 * "grazing" puts the camera at the SUBJECT'S OWN elevation looking level at it.
 * That is the view where an object standing on a deck instead of the ground, or
 * floating above it, is unmissable — from above or from an oblique it can look
 * perfectly seated.
 */
function renderOne(cmd, ctx) {
  const { renderer, scene, camera, heightAt, enuToWorld, enuToWorldPoint } = ctx;

  // FREE CAMERA. A subject plus one of eleven presets is a viewer; a designer
  // drives the camera. Give ENU eye and look_at and the framing is the caller's —
  // stand at the entrance and look up the slope, sight along a wall to see whether
  // it reads straight, drop to 0.3 m to check what a bed hides. None of those is
  // expressible as "a compass direction around a named object".
  if (Array.isArray(cmd.eye) && Array.isArray(cmd.look_at)) {
    const [ex, ey, ez] = cmd.eye, [lx, ly, lz] = cmd.look_at;
    // z is OPTIONAL and means height above the ground at that point, not an
    // absolute: a model reasoning in plan should not have to know the datum to
    // put its own eye at head height.
    const eG = heightAt(...(v => [v.x, v.z])(enuToWorld(ex, ey, 0)));
    const lG = heightAt(...(v => [v.x, v.z])(enuToWorld(lx, ly, 0)));
    const eW = enuToWorldPoint(ex, ey, 0), lW = enuToWorldPoint(lx, ly, 0);
    const eye = new THREE.Vector3(eW.x, (Number.isFinite(eG) ? eG : 0) + (ez ?? 1.65), eW.z);
    const look = new THREE.Vector3(lW.x, (Number.isFinite(lG) ? lG : 0) + (lz ?? 1.2), lW.z);
    return renderFrom(cmd, ctx, eye, look, {
      subject: `eye ${ex},${ey} -> ${lx},${ly}`,
      ground_under_eye_m: Number.isFinite(eG) ? +eG.toFixed(2) : null,
      ground_under_target_m: Number.isFinite(lG) ? +lG.toFixed(2) : null,
    });
  }

  const subj = resolveSubject(cmd.subject, ctx);
  if (!subj) return { error: `cannot find "${cmd.subject}" — not a design id, landmark, area or "x,y"` };

  // heightAt is an ENU-frame lookup (it reads the height field); the camera is
  // placed in world. Keep the two straight or the view misses by the yaw.
  const local = enuToWorld(subj.enu[0], subj.enu[1], 0);
  const g = heightAt(local.x, local.z);
  const w = enuToWorldPoint(subj.enu[0], subj.enu[1], 0);
  const ground = Number.isFinite(g) ? g : 0;
  const dist = cmd.distance_m ?? Math.max(8, subj.radius * 2.4);
  const from = (cmd.from ?? "grazing").toLowerCase();

  let eye, look;
  if (from === "above") {
    eye = new THREE.Vector3(w.x, ground + dist, w.z + 0.001);
    look = new THREE.Vector3(w.x, ground, w.z);
  } else if (from === "eye") {
    const d = DIRS.s;
    eye = new THREE.Vector3(w.x + d[0] * dist, ground + EYE_M, w.z - d[1] * dist);
    look = new THREE.Vector3(w.x, ground + EYE_M * 0.7, w.z);
  } else {
    const d = DIRS[from] ?? DIRS.se;
    // grazing: the camera sits at the subject's own height, so anything hovering
    // above the ground reads as a gap of sky beneath it
    const lift = from === "grazing" ? 0.9 : dist * 0.35;
    eye = new THREE.Vector3(w.x + d[0] * dist, ground + lift, w.z - d[1] * dist);
    look = new THREE.Vector3(w.x, ground + 0.5, w.z);
  }

  // OVERLAYS THE CALLER ASKED FOR. Not painted by default: the model decides what
  // it needs to see, the way a surveyor chooses to put a level on a thing rather
  // than being handed a reading. Feeding it a fixed picture is us deciding what
  // matters; `show` lets it pull.
  return renderFrom(cmd, ctx, eye, look, {
    subject: subj.name,
    subject_centre_enu: [+subj.enu[0].toFixed(2), +subj.enu[1].toFixed(2)],
    ground_under_subject_m: +ground.toFixed(2),
    camera_from: from,
    ...(subj.box ? { object_bottom_m: +subj.box.min.y.toFixed(2),
                     object_top_m: +subj.box.max.y.toFixed(2),
                     gap_under_object_m: +(subj.box.min.y - ground).toFixed(2) } : {}),
  });
}

/**
 * Render from an explicit eye and target. The one place a frame is taken.
 *
 * Split out so the free camera and the eleven presets share a single renderer —
 * two copies of the save/restore, the double render for the splat sort, and the
 * overlay teardown would drift apart, the way separate broker clients drift
 * apart on error handling.
 */
/**
 * Stand in the design and look, at every station along its own routes.
 *
 * The critique — eight eye-level viewpoints and "Ask what's wrong" — runs INSIDE
 * the design loop, so the design agent stands in what it built before a run
 * finishes. That matters here more than anywhere, because visual defects are
 * caught by eye and not by a number: beds standing on a deck, planting launched
 * skyward after "Set north", a spine that measures perfectly and looks ugly.
 *
 * planStations and renderWalkthrough are the SAME two functions the viewer's own
 * button uses. A second walk would drift, and the whole point is that the model
 * sees exactly what the owner sees.
 */
async function walkthroughOp(cmd, ctx) {
  const design = ctx.design;
  if (!design) return { error: "no design is loaded" };
  const n = Math.max(1, Math.min(10, Number(cmd.n) || 6));
  const stations = planStations(design, n);
  if (!stations.length) {
    return { data: { frames: [], note:
      "this design has no paths or usable areas to stand on yet, so there is "
      + "nowhere to walk. Put the circulation in first, then walk it." } };
  }
  // At MATURE size. Designs are made to mature plant size, not nursery-pot
  // size, and the viewer draws at ~5 years by default — so without this the model judges a garden 30% smaller than the one
  // that gets built, and every spacing and enclosure judgement it makes is about
  // a garden nobody ends up with.
  const frames = await withCleanScene(ctx.scene, () => renderWalkthrough(
    { renderer: ctx.renderer, scene: ctx.scene, camera: ctx.camera,
      heightAt: ctx.heightAt, enuToWorld: ctx.enuToWorld,
      enuToWorldPoint: ctx.enuToWorldPoint },
    stations, { width: 720, height: 460 }));
  // A BLACK SET MUST NOT REACH DISK. Reported as an error rather than returned
  // with a note, because `looked_at_own_work` counts a walkthrough that came
  // back, and eight black pictures would satisfy the gate that requires a
  // design to have been looked at.
  const blank = frames.filter(f => blankFrameReason(f.maxLuma));
  if (frames.length && blank.length === frames.length)
    return { error: blankFrameReason(0) };
  const dupes = duplicateStations(frames);
  return { data: { frames, growth: "mature",
    ...(blank.length ? { blank_frames: blank.length } : {}),
    ...(dupes.length ? { wasted_stations: dupes } : {}),
    note:
    `${frames.length} views at 1.65 m, standing on this design's own paths and `
    + "usable areas, with the planting at MATURE size — which is what the owner "
    + "designs to, and 30% larger than the viewer's default ~5-year view. This is "
    + "the garden that gets built."
    + (dupes.length ? ` ${dupes.length} station(s) produced a picture identical to `
       + "an earlier one — those viewpoints are duplicates and saw nothing new." : "")
    + (blank.length ? ` ${blank.length} frame(s) came back black and were not saved.` : "") } };
}

function renderFrom(cmd, ctx, eye, look, extraMeta = {}) {
  const { renderer, scene, camera } = ctx;
  const shown = [];
  const want = new Set(Array.isArray(cmd.show) ? cmd.show : cmd.show ? [cmd.show] : []);
  if (want.size && ctx.scanGrid) {
    if (want.has("slope")) shown.push(slopeLayer(ctx.scanGrid()));
    if (want.has("scan_edge")) shown.push(edgeLayer(ctx.scanGrid()));
  }
  for (const layer of shown) scene.add(layer);

  const restoreView = holdView(renderer, camera);
  const width = Math.min(1400, cmd.width ?? 900);
  const height = Math.round(width * 0.64);
  let dataUrl, drawn = null;
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    camera.up.set(0, 1, 0);
    camera.fov = cmd.fov_deg ?? 55;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    camera.position.copy(eye);
    camera.lookAt(look);
    camera.updateMatrixWorld(true);
    // Hide the app's own furniture first. This is the path `look` uses, so without
    // it every frame the design agent is shown has the grid, the axes and the
    // cyan pins drawn over the garden — and a model reads those as design.
    withCleanScene(scene, () => {
      // twice: the splat renderer sorts against the PREVIOUS frame's camera, so a
      // single render after a camera jump captures a stale sort
      renderer.render(scene, camera);
      renderer.render(scene, camera);
      // LOOK AT WHAT WAS DRAWN before encoding it. renderRefusal checks the
      // context BEFORE the render; a context that dies DURING one leaves the
      // API silent and the buffer black.
      drawn = readMaxLuma(renderer);
      dataUrl = renderer.domElement.toDataURL("image/jpeg", 0.82);
    });
  } finally {
    for (const layer of shown) { scene.remove(layer); layer.geometry?.dispose?.(); layer.material?.dispose?.(); }
    restoreView();
  }

  // The text half matters as much as the picture: an image alone lets a model
  // confidently describe the wrong object.
  // Only what renderFrom itself knows. Everything about the SUBJECT arrives as
  // extraMeta from the caller — the free camera has no subject, and building meta
  // here from a `subj` that only one caller has breaks it.
  const blank = blankFrameReason(drawn);
  if (blank) throw new Error(blank);
  const meta = {
    camera_world: { eye: eye.toArray(), look: look.toArray(), fov_deg: cmd.fov_deg ?? 55 },
    brightest_pixel: drawn,            // evidence that something was drawn
    camera_eye_enu: (e => [+e[0].toFixed(2), +e[1].toFixed(2)])(ctx.worldToEnu(eye)),
    // WHERE IT WAS AIMED, in the same frame as the design: the design agent's gate
    // asks whether a look pointed at what the round changed, and an eye alone cannot say
    camera_look_enu: (e => [+e[0].toFixed(2), +e[1].toFixed(2)])(ctx.worldToEnu(look)),
    fov_deg: cmd.fov_deg ?? 55,
    camera_height_m: +eye.y.toFixed(2),
    overlays_shown: [...want],
    overlays_available: ["slope", "scan_edge"],   // so it knows what else it may ask for
  };
  return { dataUrl, meta: { ...meta, ...extraMeta } };
}



/**
 * Raycast the loaded scan on a grid and return TRUE ground with true coverage.
 *
 * A new site cannot be onboarded without this step: everything downstream
 * (zones, grade bands, the gentlest pocket, the pad-width limit) derives from
 * it. The browser is the only place it can happen — the scan mesh
 * lives here — so the broker carries the request and Python does the analysis.
 *
 * Takes the LOWEST hit per column, not the highest: under a deck or a canopy the
 * ground is what matters, and the highest surface is the structure. That single
 * choice is what the BFS-filled height field gets wrong.
 */
function scanGridOp(cmd, ctx) {
  const { levelGroup, THREE } = ctx;
  const meshes = [];
  levelGroup.traverse(o => { if (o.isMesh) meshes.push(o); });
  if (!meshes.length) return { error: "no scan loaded — open a capture first" };

  const cell = cmd.cell_m ?? 1;
  const R = cmd.extent_m ?? 26;
  const rc = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const rows = [];
  let scanned = 0;
  for (let y = R; y >= -R; y -= cell) {           // north first, like terrain.json
    const row = [];
    for (let x = -R; x <= R; x += cell) {
      const col = ctx.enuToWorldPoint(x, y, 200);
      rc.set(col, down);
      const its = rc.intersectObjects(meshes, true);
      if (its.length) { row.push(+its[its.length - 1].point.y.toFixed(2)); scanned++; }
      else row.push(null);
    }
    rows.push(row);
  }
  return { data: { cell_m: cell, x0: -R, x1: R, y0: -R, y1: R, rows,
                   scanned_cells: scanned, total_cells: rows.length * rows[0].length,
                   source: "1 m downward raycast onto the scan mesh, lowest hit per column" } };
}

/**
 * The scan's surface ALONG A LINE, every few centimetres.
 *
 * scan_grid feeds a 1 m grid, and everything `site_api` answers is interpolated
 * from it — so a 0.2 m railroad tie, a kerb or the lip of a step is not in any
 * answer the ground tools can give: they return a smooth ramp where the ground is a
 * staircase. The mesh only exists here, so the fine question has to be asked here.
 * `z` is the LOWEST hit (the ground under anything overhanging, scan_grid's own
 * convention) and `top` the highest, so a caller can tell a canopy from a step.
 */
function scanProfileOp(cmd, ctx) {
  const { levelGroup, THREE } = ctx;
  const meshes = [];
  levelGroup.traverse(o => { if (o.isMesh) meshes.push(o); });
  if (!meshes.length) return { error: "no scan loaded — open a capture first" };
  const a = cmd.from, b = cmd.to;
  if (!Array.isArray(a) || !Array.isArray(b)) return { error: "scan_profile needs from:[x,y] and to:[x,y]" };
  const step = Math.min(1, Math.max(0.02, cmd.step_m ?? 0.05));
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(1, Math.round(length / step));
  if (n > 4000) return { error: `${n} samples is too many — raise step_m or shorten the line` };
  const rc = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const points = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
    rc.set(ctx.enuToWorldPoint(x, y, 200), down);
    const its = rc.intersectObjects(meshes, true);
    points.push({ d: +(length * t).toFixed(3), x: +x.toFixed(3), y: +y.toFixed(3),
                  z: its.length ? +its[its.length - 1].point.y.toFixed(3) : null,
                  top: its.length ? +its[0].point.y.toFixed(3) : null });
  }
  return { data: { from: a, to: b, step_m: +(length / n).toFixed(4), length_m: +length.toFixed(3), points } };
}

/**
 * Assert the ENU/world frames still agree — at a yaw that is NOT zero.
 *
 * Every frame bug is invisible at yaw 0, because there world and ENU are the
 * same numbers. "Set north" is what pulls them apart, and three separate code
 * paths can silently store world coordinates as ENU: the design/area groups
 * (drawings left behind when the scan rotates), landmark reprojection (which
 * WRITES the error to site.json), and structure detection.
 *
 * So this rotates the yard to a deliberately odd angle, checks the invariants,
 * and puts it back. Run it after touching anything that converts coordinates.
 */
function frameCheckOp(cmd, ctx) {
  const { scene, enuGroup, levelGroup, worldToEnu, enuToWorld, enuToWorldPoint, THREE, site } = ctx;
  const geo = enuGroup.parent;
  if (!geo) return { error: "enuGroup has no parent — scene graph is not built" };
  const stage = levelGroup.children[0];
  const yaw = cmd.yaw ?? 0.7;                    // odd on purpose: 40 deg
  const saved = geo.rotation.y;
  const checks = [];
  try {
    geo.rotation.y = yaw;
    geo.updateMatrixWorld(true);

    // 1. annotations must hang off enuGroup, or they stay put while the scan turns.
    //    Resolve from the live scene, not from the ctx reference, and always emit
    //    a row: a check that silently skips a group it cannot find reports "ok"
    //    while the bug is present.
    for (const name of ["design", "areas", "footprint"]) {
      const found = scene.getObjectByName(name);
      if (!found) {
        checks.push({ check: `${name} is in the ENU frame`, pass: true,
                      detail: "not loaded — nothing to check" });
        continue;
      }
      // walk up to see whether enuGroup is genuinely an ancestor
      let p = found.parent, inEnu = false, chain = [];
      while (p) { chain.push(p.name || p.type); if (p === enuGroup) { inEnu = true; break; } p = p.parent; }
      checks.push({ check: `${name} is in the ENU frame`, pass: inEnu,
                    detail: inEnu ? `under ${chain.join(" < ")}`
                                  : `parented to ${chain.join(" < ")} — it will NOT follow the scan` });
    }

    // 2. ENU -> world -> ENU is the identity
    let worst = 0;
    for (const [x, y] of [[0, 0], [14.2, 1.7], [-10.6, 1.6], [8.2, -1.9]]) {
      const back = worldToEnu(enuToWorldPoint(x, y, 0));
      worst = Math.max(worst, Math.hypot(back[0] - x, back[1] - y));
    }
    checks.push({ check: "ENU -> world -> ENU round-trips", pass: worst < 0.01,
                  detail: `worst ${worst.toFixed(4)} m` });

    // 3. a landmark's stage-local copy must reproject to its stored ENU unchanged.
    //    Say so out loud when the scan is not up yet: emitting one row fewer and
    //    still printing "frames agree" is a regression tool quietly reporting a
    //    pass it never actually ran.
    if (!stage) {
      checks.push({ check: "landmarks reproject to their stored ENU", pass: false,
                    detail: "SCAN NOT LOADED — this check did not run; open a capture and retry" });
    }
    if (stage) {
      stage.updateWorldMatrix(true, false);
      const v = new THREE.Vector3();
      let lw = 0, lname = null, n = 0;
      for (const lm of site?.landmarks ?? []) {
        if (!lm.local) continue;
        n++;
        v.fromArray(lm.local).applyMatrix4(stage.matrixWorld);
        enuGroup.worldToLocal(v);
        const d = Math.hypot(v.x - lm.x, -v.z - lm.y);
        if (d > lw) { lw = d; lname = lm.name; }
      }
      checks.push({ check: "landmarks reproject to their stored ENU", pass: lw < 0.05,
                    detail: `${n} checked, worst ${lw.toFixed(3)} m${lname ? ` at ${lname}` : ""}` });
    }
    // 4. THE ground invariant: the height under a fixed ENU point must not
    //    depend on the viewing yaw. The fallback height field is BFS-filled, so
    //    when it is built in the wrong frame it does not return null — it
    //    returns invented ground, and whatever stands on it launches skyward.
    //    Probe well outside the raycast coverage, which is where the fallback
    //    is actually consulted.
    if (ctx.rebuildTerrain && ctx.heightAt) {
      const probes = [[0, 0], [14, 2], [-10, 2], [8, -2], [22, -14], [-20, 14], [24, 16], [-24, -16]];
      geo.rotation.y = 0; geo.updateMatrixWorld(true);
      ctx.rebuildTerrain();
      const at0 = probes.map(([x, y]) => { const w = enuToWorld(x, y, 0); return ctx.heightAt(w.x, w.z); });
      geo.rotation.y = yaw; geo.updateMatrixWorld(true);
      ctx.rebuildTerrain();
      const atYaw = probes.map(([x, y]) => { const w = enuToWorld(x, y, 0); return ctx.heightAt(w.x, w.z); });
      let worst = 0, where = null;
      for (let i = 0; i < probes.length; i++) {
        const a = at0[i], b = atYaw[i];
        if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
        const d = Math.abs(a - b);
        if (d > worst) { worst = d; where = probes[i]; }
      }
      checks.push({ check: "ground height is independent of the viewing yaw",
                    pass: worst < 0.05,
                    detail: `worst ${worst.toFixed(2)} m${where ? ` at ENU ${where[0]},${where[1]}` : ""}` });
    }
    // 5. float_check itself must be yaw-invariant. A bounding box built in WORLD
    //    with its min/max corners pushed through worldToLocal is not: an
    //    axis-aligned box is not rigid under rotation, so the sampled footprint
    //    changes shape with the yaw (a 10 x 2 m bed becomes 11.5 x 1.4 m at
    //    23 deg) and the reported gaps move with it.
    if (enuGroup.getObjectByName("design")) {
      geo.rotation.y = 0; geo.updateMatrixWorld(true);
      const a = floatCheckOp({ limit: 999 }, ctx).data;
      geo.rotation.y = yaw; geo.updateMatrixWorld(true);
      const b = floatCheckOp({ limit: 999 }, ctx).data;
      let worst = 0, where = null;
      if (a && b) {
        const byId = new Map(b.worst.map(r => [r.id, r]));
        for (const r of a.worst) {
          const q = byId.get(r.id);
          if (!q) continue;
          const d = Math.abs(r.gap_m - q.gap_m);
          if (d > worst) { worst = d; where = r.id; }
        }
      }
      checks.push({ check: "float_check reports the same gaps at any yaw",
                    pass: worst < 0.02,
                    detail: `worst ${worst.toFixed(3)} m${where ? ` at ${where}` : ""}` });
    }
    // 6. A click must land where it was aimed, at any yaw. pickSurface's march
    //    is the single most dangerous frame path in the app: its result is what
    //    gets written into site.json as a landmark or an area vertex. Aim a ray
    //    straight down at a known ENU column and require it back.
    if (ctx.marchRayToGround) {
      const probes = [[6, 4], [14, 2], [-8, 3], [12, -6]];
      let worst = 0, where = null, tested = 0;
      for (const [x, y] of probes) {
        const from = enuToWorldPoint(x, y, 120);
        const dir = new THREE.Vector3(0, -1, 0);      // straight down: world and ENU agree on Y
        const hit = ctx.marchRayToGround(from, dir);
        if (!hit) continue;                            // outside coverage; not a failure
        tested++;
        const back = worldToEnu(hit);
        const d = Math.hypot(back[0] - x, back[1] - y);
        if (d > worst) { worst = d; where = [x, y]; }
      }
      checks.push({ check: "a click lands where it was aimed", pass: tested > 0 && worst < 0.1,
                    detail: tested ? `${tested} probes, worst ${worst.toFixed(3)} m${where ? ` at ENU ${where[0]},${where[1]}` : ""}`
                                   : "NO PROBE HIT THE GROUND — check did not run" });
    }
  } finally {
    geo.rotation.y = saved;
    geo.updateMatrixWorld(true);
    if (ctx.rebuildTerrain) ctx.rebuildTerrain();   // leave the field in the saved frame
  }
  const failed = checks.filter(c => !c.pass);
  return { data: { tested_at_yaw_rad: yaw, tested_at_yaw_deg: +(yaw * 180 / Math.PI).toFixed(1),
                   checks, passed: checks.length - failed.length, failed: failed.length,
                   verdict: failed.length ? "FRAMES DISAGREE" : "frames agree" } };
}

/**
 * Which design objects are not sitting on the ground?
 *
 * This is the failure that measurements miss and eyes catch: a bed standing on
 * a deck (the height field reads the deck as ground), a section of planting
 * launched into the sky (the fallback field built in the wrong frame). Looking
 * at the screen does not scale and does not run in a headless design loop.
 *
 * So: ask every object at once, in metres, and sort the worst to the top.
 */
export function floatCheckOp(cmd, ctx) {
  const { enuGroup, heightAt, enuToWorld, THREE } = ctx;
  const dg = enuGroup.getObjectByName("design");
  if (!dg) return { error: "no design loaded" };
  const tol = cmd.tolerance_m ?? 0.4;
  const rows = [];
  enuGroup.updateWorldMatrix(true, false);
  const toLocal = new THREE.Matrix4().copy(enuGroup.matrixWorld).invert();
  for (const o of dg.children) {
    const id = o.userData?.id;
    if (!id) continue;
    // Build the bounding box IN THE ENU FRAME, not by converting a world box.
    // An axis-aligned box is not rigid under rotation: pushing its min and max
    // corners through worldToLocal gives two points that no longer span the
    // local box. At a 23 deg yaw a 10 x 2 m bed comes out 11.5 x 1.4 m, so the
    // ground is sampled over the wrong footprint and gap_m is wrong with it.
    const box = new THREE.Box3();
    o.updateWorldMatrix(true, true);
    o.traverse(n => {
      const g = n.geometry;
      if (!g) return;
      if (!g.boundingBox) g.computeBoundingBox();
      if (!g.boundingBox) return;
      const m = new THREE.Matrix4().multiplyMatrices(toLocal, n.matrixWorld);
      box.union(g.boundingBox.clone().applyMatrix4(m));
    });
    if (box.isEmpty()) continue;

    // Sample the object's whole FOOTPRINT, not its centre: a bed draped across a
    // 13 deg slope has its lowest vertex half a width downhill of its centre, so
    // centre-ground would call every sloped bed "buried" by (half-width x slope)
    // and the signal would be worthless.
    const x0 = box.min.x, x1 = box.max.x;
    const y0 = -box.max.z, y1 = -box.min.z;
    const bottom = box.min.y;

    const steps = 5;
    let gMin = Infinity, gMax = -Infinity, n = 0;
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps; j++) {
        const w = enuToWorld(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * j / steps, 0);
        const g = heightAt(w.x, w.z);
        if (!Number.isFinite(g)) continue;
        gMin = Math.min(gMin, g); gMax = Math.max(gMax, g); n++;
      }
    }
    if (!n) continue;

    // Strict test, chosen to have no false positives: the object's LOWEST point
    // is above the HIGHEST ground beneath it, i.e. it hangs in the air over its
    // entire footprint. A level terrace cut into a slope is legitimately above
    // ground on its downhill side, and this test does not flag that.
    rows.push({ id,
                enu: [+((x0 + x1) / 2).toFixed(2), +((y0 + y1) / 2).toFixed(2)],
                bottom_m: +bottom.toFixed(2),
                ground_min_m: +gMin.toFixed(2), ground_max_m: +gMax.toFixed(2),
                gap_m: +(bottom - gMax).toFixed(2),
                buried_m: +(gMin - bottom).toFixed(2) });
  }
  rows.sort((a, b) => b.gap_m - a.gap_m);
  const floating = rows.filter(r => r.gap_m > tol);
  const buried = rows.filter(r => r.buried_m > tol);
  return { data: { checked: rows.length, tolerance_m: tol,
                   floating: floating.length, buried: buried.length,
                   worst: rows.slice(0, cmd.limit ?? 15),
                   verdict: floating.length
                     ? `${floating.length} object(s) hang in the air over their whole footprint`
                     : "no object floats clear of its ground" } };
}


/**
 * Render a DIFFERENT design file, so the model can look at its own proposal.
 *
 * agent.py applies a proposed op list only after the run ends, and the viewer
 * renders data/design.json — so without this every `look` in a run shows the
 * owner's existing design while the model reasons about it as its own work.
 * A tool that answers confidently about the wrong subject is worse than no tool.
 *
 * The loop this enables: apply the proposal to a scratch file
 * (`site_api apply-ops --design <scratch>`), preview it, look, iterate — and the
 * owner's working design is never touched. Passing no path returns to it.
 */
/**
 * Switch which design the viewer is showing — and WAIT for it to load.
 *
 * The await is the point. setPreviewSource() returns loadDesign()'s promise;
 * dropping it lets preview_design answer "now rendering X" while the scene still
 * holds the previous design. Every render that follows — `look`, `walk_through`,
 * a float check — then sees the OLD one, and says nothing, so the model reasons
 * about somebody else's garden. Walking two designs in a row exposes the race:
 * both walks come back with the FIRST design's paths.
 */
async function previewOp(cmd, ctx) {
  if (!ctx.setPreviewSource) return { error: "this viewer cannot switch design source" };
  const path = cmd.path ? String(cmd.path) : null;
  if (path && !/^\/?data\/[\w./-]+\.json$/.test(path))
    return { error: `refusing to preview ${path}: only data/*.json paths, no traversal` };
  const url = path ? (path.startsWith("/") ? path : "/" + path) : null;
  await ctx.setPreviewSource(url);
  return { data: { previewing: url ?? "data/design.json (the owner's working design)",
                   note: url ? "the viewer is NOT showing the working design until you "
                             + "call preview_design with no path"
                             : "back on the working design" } };
}

/**
 * Has the GPU dropped this page's WebGL context?
 *
 * MEASURED: full detail on a large design can submit billions of triangles a
 * frame, and the context is LOST. After that the renderer's draw call returns in
 * 0 ms with 0 draw calls and every frame is black — it does not throw. (Note the
 * phrasing: naming the three.js call literally here makes clean_scene.test.mjs
 * count this comment as a render outside withCleanScene.) Unchecked, `look` keeps
 * answering `ok` with a black picture, and `looked_at_own_work` counts a look by
 * its presence in the call log rather than by what came back: a design agent
 * whose context had died would "look" at eight black frames and satisfy the gate
 * that requires it to look at what it designed.
 *
 * An instrument that reports success while measuring nothing is worse than one
 * that refuses, so a drawing request on a dead context is an ERROR with the
 * recovery in it, not a frame.
 */
export function contextLost(renderer) {
  try { return !!renderer?.getContext?.()?.isContextLost?.(); }
  catch { return false; }          // never fail a render over the check itself
}

/** Ops that compute on the CPU and do not need a live context. */
const NON_DRAWING = new Set(["scan_grid", "scan_profile", "frame_check", "float_check", "export_scene"]);

/**
 * Hand the whole scene to something that can path-trace it.
 *
 * The user wants a photorealistic rendering of a view.
 *
 * The decision behind this is the whole point: a TRUTHFUL photoreal render
 * path-traces the real geometry, so every pixel still corresponds to measured
 * ground and to the plant that is actually specified. A generative one is
 * prettier and **it will lie** — change species, invent windows, move stones —
 * which is exactly the failure this project guards against.
 *
 * EXPORTED FROM THE VIEWER, not rebuilt in Blender. The viewer is the only place
 * that knows the ENU-to-world yaw, the ground height under every object, which
 * GLB each species routes to and what growth scale is applied — rebuilding any
 * of that on the python side would be a second copy of the nastiest bug class in
 * this project. What crosses the boundary is geometry that has already
 * been placed.
 *
 * At MATURE size and with the app's own furniture hidden, for the same reasons
 * the walkthrough is: the owner designs to mature size, and the grid, the
 * axes and the cyan pins are not part of the garden.
 */
async function exportSceneOp(cmd, ctx) {
    // THE PHONE'S SCENE: pictures of the plants and the owner's landmarks, no scan. It is
    // not a clone of anything on screen, so it has no view and nothing to restore.
    if (cmd.plants === "cards") {
      const design = ctx.colour ? ctx.colour(ctx.design) : ctx.design;
      if (!design) return { error: "no design is loaded" };
      const { root, phases, info } = await buildArScene(design, {
        heightAt: ctx.heightAt, site: ctx.site, like: ctx.renderer,
        deps: { buildDesignGroup, preparePlantTextures, ensureAssets, assetsNeededBy,
                ensureObjectModels, objectModelsNeededBy } });
      const t0 = performance.now();
      const saved = await postGlb(root, true);
      if (saved.error) return saved;
      phases.glb_ms = Math.round(performance.now() - t0);
      const scan = buildArScan(ctx.stage?.(), ctx.enuGroup, info.shift);
      let scanSaved = null, scanBounds = null;
      if (scan) {
        const bounds = new THREE.Box3().setFromObject(scan, true);
        scanBounds = { min: bounds.min.toArray(), max: bounds.max.toArray() };
        try { scanSaved = await postGlb(scan, true); }
        finally { scan.traverse(o => { if (o.isMesh) for (const m of [o.material].flat()) m.dispose(); }); }
        if (scanSaved.error) return scanSaved;
      }
      return { data: { ...saved, ...info, phases, scan_path: scanSaved?.path ?? null, scan_bounds: scanBounds } };
    }
    const view = cmd.view ? renderOne(cmd.view, ctx) : null;
    if (view?.error) return view;
    const what = new THREE.Group();
    // the SAME subtree the camera sees, so nothing can be in one and not the other
    let carved = 0;
    for (const name of (cmd.include ?? ["design", "scan"])) {
      const node = name === "scan" ? ctx.stage?.() : ctx.designGroup?.();
      if (!node) continue;
      const copy = cmd.view ? cloneInWorld(node) : node.clone(true);
      // CUT WHERE THE DESIGN IS BUILT FLAT. On screen a shader discards the
      // scan above a terrace; Blender reads geometry, so the copy is cut instead.
      if (name === "scan") carved = carveForExport(copy, node);
      what.add(copy);
    }
    if (!what.children.length) return { error: "nothing to export — no design and no scan" };
    // LEAVE OUT WHAT THE CALLER IS ABOUT TO THROW AWAY. `drop` names mesh
    // classes (a mesh's `name`, as the plant builders set it), and they are removed
    // from the CLONE, so the scene on screen is never touched.
    let dropped = 0;
    if (Array.isArray(cmd.drop) && cmd.drop.length) {
      const names = new Set(cmd.drop);
      const gone = [];
      what.traverse(o => { if (o.isMesh && names.has(String(o.name).replace(/\.\d+$/, ""))) gone.push(o); });
      for (const o of gone) o.removeFromParent();
      dropped = gone.length;
    }
    const saved = await postGlb(what, !!cmd.view);
    if (saved.error) return saved;
    return { data: { ...saved, dropped, carved, ...(view ? { view: view.meta } : {}) } };
}

/**
 * Serialise a subtree to GLB and hand it to the dev server, which says where it went.
 * A SNAPSHOT gets its own file, which the caller deletes; otherwise it replaces
 * data/photoreal/scene.glb, photoreal's --reuse-scene cache — which is why the AR
 * export asks for a snapshot: otherwise it would overwrite that cache on every run.
 */
async function postGlb(what, snapshot) {
  const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
  const glb = await new Promise((res, rej) => {
    new GLTFExporter().parse(what, res, rej, { binary: true, onlyVisible: true });
  });
  // POSTED AS BYTES, not returned as base64 in the reply. Encoding it throws
  // "Invalid string length" on a real design: base64 of a scene this size is
  // past what a JS string can hold. The broker's reply is
  // for small answers, and a mesh is not one.
  const r = await fetch("/api/view/export", {
    method: "POST", headers: { "Content-Type": "application/octet-stream",
      ...(snapshot ? { "X-YardTwin-Snapshot": "1" } : {}) },
    body: glb,
  });
  const out = await r.json();
  if (!out.ok) return { error: `could not save the scene: ${out.error}` };
  return { path: out.path, bytes: out.bytes };
}

export function cloneInWorld(node) {
  node.updateWorldMatrix(true, true);
  const clone = node.clone(true);
  clone.matrix.copy(node.matrixWorld);
  clone.matrixAutoUpdate = false;
  clone.matrixWorldNeedsUpdate = true;
  return clone;
}

/**
 * Why this render must be refused, or null to go ahead.
 *
 * A separate pure function because the decision is the part worth testing, and
 * the handler around it needs an EventSource and a live scene to reach.
 */
export function renderRefusal(op, renderer) {
  if (NON_DRAWING.has(op)) return null;          // raycasts still work on a dead context
  if (!contextLost(renderer)) return null;
  return "the WebGL context is lost, so this render would be a black frame. "
       + "Reload the viewer tab and retry the render.";
}

// Shared dispatch is also exercised without WebGL by the regression suite.
export async function executeView(cmd, ctx) {
  const full = { ...ctx, THREE, site: ctx.getSite(), design: ctx.getDesign() };
  const refusal = renderRefusal(cmd.op, ctx.renderer);
  if (refusal) throw new Error(refusal);
  const execute = async full => {
    const r = cmd.op === "export_scene" ? await exportSceneOp(cmd, full)
            : cmd.op === "scan_grid" ? scanGridOp(cmd, full)
            : cmd.op === "scan_profile" ? scanProfileOp(cmd, full)
            : cmd.op === "frame_check" ? frameCheckOp(cmd, full)
            : cmd.op === "float_check" ? floatCheckOp(cmd, full)
            : cmd.op === "preview" ? await previewOp(cmd, full)
            : cmd.op === "walkthrough" ? await walkthroughOp(cmd, full)
            : renderOne(cmd, full);
    return r;
  };
  if (["scan_grid", "scan_profile", "frame_check", "float_check", "preview"].includes(cmd.op))
    return execute(full);
  const source = ctx.getPreviewSource?.() ?? "data/design.json";
  // The phone's scene builds its own few full-detail plants — one per picture — so it
  // does not wait for the whole garden to be built at full detail first.
  if (cmd.op === "export_scene" && cmd.plants === "cards") {
    full.design = activeDesign(ctx.getReviewDesign ? await ctx.getReviewDesign() : full.design);
    const r = await execute(full);
    if (r.data) r.data.design_source = source;
    return r;
  }
  // A file can change between two looks before the owner's next polling tick.
  // Review the document now on disk, not the last frame the tab happened to load.
  full.design = activeDesign(ctx.getReviewDesign ? await ctx.getReviewDesign() : full.design);
  if (!full.design || !ctx.withReview)
    throw new Error("Full-detail review is not ready. Wait for the design to load or reload the viewer.");
  return ctx.withReview(full.design, async group => {
    const refusal = renderRefusal(cmd.op, ctx.renderer);
    if (refusal) throw new Error(refusal);
    const r = await execute({ ...full, designGroup: () => group });
    if (!r.error) {
      const evidence = { render_quality: "detailed", growth: "mature",
                         design_source: source,
                         shadows: !!ctx.renderer.shadowMap?.enabled };
      if (r.data) Object.assign(r.data, evidence);
      else r.meta = { ...r.meta, ...evidence };
    }
    return r;
  });
}

export function initViewport(ctx) {
  let es;
  let pending = Promise.resolve();
  const connect = () => {
    es = new EventSource("/api/view/subscribe");
    es.addEventListener("render", ev => {
      // Requests share a camera and scene. A preview or second look must wait
      // until a walkthrough/export has restored them, including after a refusal.
      pending = pending.catch(() => {}).then(async () => {
        let id, cmd;
        try { ({ id, cmd } = JSON.parse(ev.data)); } catch { return; }
        let body;
        try {
          const r = await executeView(cmd, ctx);
          body = r.error ? { id, error: r.error }
               : r.data ? { id, data: r.data }
               : { id, dataUrl: r.dataUrl, meta: r.meta };
        } catch (e) {
          body = { id, error: String(e?.message ?? e) };
        }
        await fetch("/api/view/result", { method: "POST",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
          .catch(() => {});
      });
    });
    es.onerror = () => { /* EventSource retries on its own via the retry: hint */ };
  };
  connect();
  return () => es?.close();
}
