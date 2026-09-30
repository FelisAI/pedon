import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { fitGroundAuto, umeyama2d } from "./fit.js";
import {preparePlantTextures} from './plant_textures.js';
import { prepareSimplifier } from './preview_lod.js';
import {readRenderQuality, saveRenderQuality, applyRenderQuality,
        readShadows, saveShadows, setShadows} from './render_quality.js';
import { buildDesignGroup, reusableParts, buildFootprintOverlay, getLoader, textLabel, labelTexture, enuToWorld, materialWants, plantBuildStats, plantBuildHistory, levelFootprints, sizedPlantsOf } from "./design.js";
import { setCarveSurfaces, setCarveFrame } from "./carve.js";
import { loadPlantLibrary, ensureAssets, assetsNeededBy, assetName, catalogNames,
         ensureObjectModels, objectModelsNeededBy, buildAssetObject,
         libraryNames, MANIFEST_URL, MIN_ASSET_HEIGHT_M,
         normalizeForm } from "./assets.js";
// The palette groups by growth form, and growthForm() is the function the
// RENDERER routes with — so a header is a promise about what the viewer draws
// rather than a second classification living in the picker.
import { growthForm, fastModelKey, drawnByCode } from "./plants.js";
import { planStations, renderWalkthrough } from "./walkthrough.js";
import { Lasso, areaMesh, polygonArea, pointInPolygon, idsInsidePolygon } from "./areas.js";
import { withReviewScene, createReviewCache } from "./review_scene.js";
import { initViewport, floatCheckOp } from "./viewport.js";
import { wants, PLACEHOLDER_COLOUR, objectCatalog, resolveKind } from "./objects.js";
import * as flycam from "./flycam.js";
import { createRegistry } from "./extensions.js";
import { createCommands } from "./shell/commands.js";
import { mountPalette, opensPalette } from "./shell/palette.js";
import { mountTopBar } from "./shell/topbar.js";
import { mountDock } from "./shell/dock.js";
import { mountInspector } from "./shell/inspector.js";
import { mountHud } from "./shell/hud.js";
import { mountToasts, formatHistory, newSince } from "./shell/toast.js";
import { mountContextMenu, contextItemsFor } from "./shell/contextmenu.js";
import { mountTooltips } from "./shell/tooltip.js";
import { rightUpIntent, movesCamera, speedFor,
         leftBindingFor, holdsOrbitModifier, orbitPivot, pivotOrbit, readLastCamera } from "./shell/navigate.js";
import { mountSidePanel } from "./shell/sidepanel.js";
import { sortRows, withKindHeadings, ORDERS, rangeBetween } from "./shell/treesort.js";
import { rowOf, kindPlural, polyLen, crowdedLine } from "./shell/rowtext.js";
import { upsertLandmark, pinParts } from "./landmarks.js";
import { whatIs, honoured, VIEW_STORE_KEY, viewScopeOf, readViewScope, writeViewScope, dropViewScope } from "./shell/viewstate.js";
import { DOCK_TOOLS } from "./shell/docktools.js";
import { mountArSheet } from "./shell/arsheet.js";
import { historyKey, docUrlFor, readStamp, compareLabel } from "./shell/designref.js";
import { setupSteps, calibrationWarning, setupProgress } from "./shell/setup.js";
import { sunAt, dayRange, hhmm, minutesOf, twoSunsWarning, seasonDates }
  from "./shell/sunpath.js";
import { compareTable, diffText, coverageNote } from "./shell/compare.js";
import { setUnits, units as displayUnits, len as fmtLen, small as fmtSmall, area as fmtArea, pair as sizePair,
         span as sizeSpan, size as plantSize, parseLen, lenField, lengthUnit } from "./shell/units.js";
import { photoFor, isOwner, provenanceOf } from "./shell/refphotos.js";
import { viewpointFrom, viewpointProblems, upsertViewpoint, stepViewpoint } from "./shell/viewpoints.js";
import { icon } from "./shell/icons.js";
import { SURFACES } from "./shell/surfaces.js";
import plantInspector from "./extensions/plant-inspector/ui.js";
import { measure as measureRun, describe as describeRun } from "./measure.js";
import { plantThumb, plantThumbLater, setPlantBuild, objectThumb, forgetThumbs } from "./thumbs.js";
import { storeStats, forgetModels, restoreModels, keptModel } from "./plant_store.js";
import { addPlantLevels, updatePlantLevels, plantLevels, tuneLevels } from "./plant_lod.js";
import { toNearest, toGrid, toAngle } from "./snap.js";
import { gizmoRadius, axisParam, planeHit, ringDeg, pickPart, grabOrder,
         rotatable, centroid, rotateXY, normalizeDeg, typeDistance } from "./gizmo.js";
import { withCleanScene } from "./clean.js";
import { initLighting, worldBearingOf, setSunFromAzimuthAltitude } from "./lighting.js";
import { captureSunTime, sunQuery, sunLabel, utcOffsetHoursFor } from "./sunclock.js";
import { isSplatPly, loadPlyPointCloud } from "./ply.js";
import { buildHeightField } from "./terrain.js";
import { detectStructures } from "./detect.js";
import { setBotanicalDetail } from "./woody_geometry.js";
import { DESIGN_KINDS, mergeDesignDocument, activeDesign, alternativeSets,
         chosenAlternative, inactiveIds } from "./design_doc.js";
import { siteOf, siteKey, adoptLegacy } from "./shell/sitekey.js";
import { welcomeDue, showWelcome } from "./shell/welcome.js";
import { OWNED_FILE, ownedSet, withOwned } from "./shell/owned.js";
// the site this page is for, stamped in by the dev server — per-site browser memory keys on it
const SITE = siteOf();

// THE YARD IS ALWAYS DRAWN AT GARDEN DETAIL, in both quality modes.
//
// "Full detail" uses the real botanical builders at garden detail. Repeating an
// inspection model for every plant in a garden can exhaust the WebGL context and GPU process.
// The masters keep every hair in compare.html: that page does not call this,
// so it keeps the 'inspection' default.
setBotanicalDetail("garden");

// ------------------------------------------------------------------ scene
const app = document.getElementById("app");
let qualityStorage;
try { qualityStorage = window.localStorage; } catch { /* disabled storage */ }
let renderQuality = readRenderQuality(qualityStorage, window.location.search);
// SHADOWS ARE THEIR OWN SETTING, so Fast preview can show cast shadows as the
// user moves the sun through the day.
let shadowsOn = readShadows(qualityStorage);
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
// Without tone mapping a 2.0-intensity sun clips foliage to flat grey-white and
// every plant loses its colour; Neutral keeps hues where ACES pushes them warm,
// which matters when the point is judging planting against a real scan.
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.15;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14191a);
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.05, 2000);
camera.position.set(8, 6, 10);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// ⌘-DRAG MUST ROTATE, AND OrbitControls BINDS THAT GESTURE TO PAN.
//
// A ⌘-drag rotates the camera. `grabOrder` routes it to the camera, but
// OrbitControls reserves ctrl/meta/shift + left for PANNING. Its switch is
// symmetric, so binding LEFT to PAN for exactly as long as the modifier is held
// gives rotate in both states — see `leftBindingFor` for the rule it inverts.
//
// IT IS BOUND ON KEYDOWN, NOT AT THE PRESS. OrbitControls is constructed here,
// long before main.js adds its own pointerdown listener, so its handler runs
// FIRST and a flip made at press time would arrive too late.
const MOUSE_ACTION = { rotate: THREE.MOUSE.ROTATE, pan: THREE.MOUSE.PAN };
function bindLeftFor(modifierHeld) {
  controls.mouseButtons.LEFT = MOUSE_ACTION[leftBindingFor(modifierHeld)];
}
bindLeftFor(false);
addEventListener("keydown", ev => bindLeftFor(holdsOrbitModifier(ev)), true);
addEventListener("keyup", ev => bindLeftFor(holdsOrbitModifier(ev)), true);
// ⌘-Tab away with the key down and the keyup never arrives, which would leave
// every plain drag panning until the user presses and releases ⌘ again
addEventListener("blur", () => bindLeftFor(false));

const spark = new SparkRenderer({ renderer });
scene.add(spark);

const grid = new THREE.GridHelper(60, 60, 0x3a5c46, 0x22301f);
grid.position.y = -0.001;
scene.add(grid);
scene.add(new THREE.AxesHelper(2));
// design-frame north is world -z; true after "Set north" (or footprint alignment)
scene.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0.02, 0), 3, 0x66aaff, 0.6, 0.3));
const northLabel = textLabel("N", "north");
northLabel.position.set(0, 0.4, -3.6);
scene.add(northLabel);

// calibration hierarchy: geoGroup (yaw+xz) > levelGroup (plane quat + scale + y) > splat
//
// enuGroup is geoGroup's OTHER child, and it is the frame every annotation lives
// in: designs, areas, landmark pins, the footprint overlay, detect proposals.
//
// It has to hang off geoGroup rather than off the scene. "Set north" rotates
// geoGroup about the origin. At a 23 deg yaw, a scan bbox centre 1.9 m out moves
// little, while a design 14.3 m out is displaced 5.8 m if left in scene space.
// Under geoGroup the whole site turns as one rigid body, so north costs nothing
// and no stored coordinate ever needs migrating.
//
// It deliberately skips levelGroup: annotations are built against the already
// levelled height field, so the plane quaternion would be applied to them twice.
const geoGroup = new THREE.Group();
const levelGroup = new THREE.Group();
const enuGroup = new THREE.Group();
geoGroup.name = "geo";
levelGroup.name = "level";
enuGroup.name = "enu";
geoGroup.add(levelGroup);
geoGroup.add(enuGroup);
scene.add(geoGroup);

// A picked point comes back in WORLD space from a raycast against the scan, but
// everything we store (design.json, site.json areas and landmarks, terrain.json)
// is ENU in the enuGroup frame. At yaw 0 the two are identical; set north and
// a pick stored without conversion lands metres away.
const worldToEnu = p => { const q = enuGroup.worldToLocal(p.clone()); return [q.x, -q.z]; };
const enuToWorldPoint = (x, y, h = 0) => enuGroup.localToWorld(enuToWorld(x, y, h));

const markers = new THREE.Group();
markers.name = "markers";            // named so withCleanScene can keep it out of model views
enuGroup.add(markers);
// Designs are LAYERS, not one swapped-in group. designsGroup holds them all;
// designGroup is whichever one is currently being edited, and `overlays` holds
// the saved variants being shown alongside it for comparison. Show/hide,
// displaying several designs at once and telling them apart all use this
// one container rather than needing a button each.
const designsGroup = new THREE.Group();
designsGroup.name = "designs";
enuGroup.add(designsGroup);
// The sun goes in the GEO frame, not the scene. It carries a compass bearing, so
// parenting it to the scene would light the site correctly at yaw 0 but be
// 23.3 deg wrong at a 23.3 deg yaw. initLighting refuses to run without geoGroup
// for that reason, so this call sits here rather than up with the camera.
const lighting = initLighting({ renderer, scene, geoGroup });
// The scan is cut where the design is built flat (carve.js). The cut is
// tested in the DESIGN frame, which turns with north, so the frame is refreshed on
// every render — including the render broker's, which calls renderer.render itself
// rather than going through the animation loop. Chained after lighting's hook.
{
  const before = scene.onBeforeRender;
  const buffer = new THREE.Vector2();
  scene.onBeforeRender = function (...args) {
    setCarveFrame(designsGroup.matrixWorld);
    // each plant's layers at the level THIS camera can resolve — the shadow pass draws the same
    const [r, , cam, target] = args;
    if (levelPlants.length && cam) updatePlantLevels(levelPlants, cam,
      target ? target.height : r.getDrawingBufferSize(buffer).y, levelsOn);
    before?.apply(this, args);
  };
}
applyRenderQuality(renderer, renderQuality, window.devicePixelRatio, shadowsOn);

// ── SUNCLOCK-START ──
// The sun, aimed at a real hour instead of at LEGACY_SUN.
//
// setSunFromAzimuthAltitude aims the light at the capture's sun position.
// An arbitrary 47.969 deg / 123.690 deg light disagrees with a scan photographed
// under any other sun.
//
// The DEFAULT is the capture's own hour, not noon and not now: the plate is most
// of what an eye-level shot shows, its shadows are baked in, and lighting the
// design at a different hour is the one lighting error you cannot art-direct
// around. sun.py refuses the bearing while north is unset and lighting.js falls
// back to its arbitrary one — that refusal is honoured, not worked around.
let sunWhen = null;                       // {date,time} or null for "now"
let sunState = null;

async function aimSun(when = sunWhen) {
  sunWhen = when;
  try {
    // concatenated, not a template literal: tests/test_dry2.py extracts the
    // endpoint literal from this file to check the dev server actually serves it,
    // and "/api/sun${...}" is not a route anyone can match
    const r = await fetch("/api/sun" + sunQuery(when));
    const j = await r.json();
    if (j?.error) { log(`sun: ${String(j.error).slice(0, 120)}`, "warn"); return null; }
    sunState = setSunFromAzimuthAltitude(lighting, { ...j, northSet: !!calib.northSet });
    lighting.rebuildSky?.();
    const el = document.getElementById("sunLabel");
    if (el) el.textContent = sunLabel(sunState, when);
    const t = document.getElementById("sunTime");
    if (t && when?.time) t.value = when.time;
    const c = document.getElementById("sunClock");
    if (c && when?.time) c.textContent = when.time;
    const sl = document.getElementById("sunSlider");
    if (sl && when?.time) sl.value = String(minutesOf(when.time));
    loadSunDay(when?.date ?? currentSunDate());
    syncTwoSuns();
    return sunState;
  } catch (e) {
    // a viewer that throws here would lose the whole scene over a clock
    console.warn("sun: could not aim —", e);
    return null;
  }
}

// ── THE SUN ON A SLIDER ───────────────────────────────────────────────────
//
// The whole day's track is fetched ONCE per date and interpolated locally while
// the handle moves, avoiding a python subprocess round trip per position.
// sun.py owns the astronomy — `sun.py day` supplies the track — so there is no
// second solar model in JS to drift from it.
let sunDay = null;                        // the fetched track for sunDayDate
let sunDayDate = null;

function captureWhen() { return captureSunTime(calib.captureUrl ?? calib.capture); }
function currentSunDate() {
  return sunWhen?.date ?? captureWhen()?.date ?? new Date().toISOString().slice(0, 10);
}

async function loadSunDay(date) {
  if (sunDayDate === date && sunDay) return sunDay;
  try {
    const r = await fetch("/api/sun/day?step=10&date=" + encodeURIComponent(date));
    const j = await r.json();
    if (j?.error || !Array.isArray(j?.track)) return null;
    sunDay = j; sunDayDate = date;
    const sl = document.getElementById("sunSlider");
    if (sl) {
      const { start, end } = dayRange(j, utcOffsetHoursFor({ date }));
      sl.min = String(start); sl.max = String(end);
      // keep the handle where it was if that hour still exists on this date
      const want = minutesOf(document.getElementById("sunTime")?.value) ?? +sl.value;
      sl.value = String(Math.min(end, Math.max(start, want || (start + end) / 2)));
    }
    return j;
  } catch { return null; }
}

/**
 * Aim the sun from the LOCAL track, with no server round trip.
 *
 * Interpolated, so dragging is instant. `aimSun` is still the authority for a
 * typed hour and for the first load — this is the same answer arrived at
 * cheaply, and `sunAt` is tested against the real track.
 */
function scrubSun(localMinutes) {
  if (!sunDay) return;
  const pos = sunAt(sunDay, localMinutes, utcOffsetHoursFor({ date: sunDayDate }));
  if (!pos) return;
  sunWhen = { date: sunDayDate, time: hhmm(localMinutes) };
  sunState = setSunFromAzimuthAltitude(lighting, { ...pos, northSet: !!calib.northSet });
  lighting.rebuildSky?.();
  const t = document.getElementById("sunTime");
  if (t) t.value = sunWhen.time;
  const c = document.getElementById("sunClock");
  if (c) c.textContent = sunWhen.time;
  const el = document.getElementById("sunLabel");
  if (el) el.textContent = sunLabel(sunState, sunWhen);
  syncTwoSuns();
}

/**
 * Say when the frame has two suns in it.
 *
 * The scan is a PHOTOGRAPH and its shadows are painted into the texture, so
 * moving the light away from the capture hour puts the ground's shadows and the
 * design's pointing different ways. Viewing other hours is allowed, but the
 * mismatch is reported with the remedy: hide the plate and judge the design on
 * measured ground.
 */
function syncTwoSuns() {
  const el = document.getElementById("sunTwoSuns");
  if (!el) return;
  const cap = captureWhen();
  const msg = twoSunsWarning({
    litMinutes: minutesOf(sunWhen?.time),
    captureMinutes: minutesOf(cap?.time),
    scanShown: !!document.getElementById("layScan")?.checked,
  });
  el.textContent = msg ?? "";
  el.parentElement?.classList.toggle("empty", !msg);
}

document.getElementById("sunSlider")?.addEventListener("input", ev => {
  scrubSun(+ev.target.value);
});
document.getElementById("sunSeason")?.addEventListener("change", async ev => {
  const which = ev.target.value;
  const dates = seasonDates(null, new Date(currentSunDate()).getFullYear());
  const date = which === "capture" ? (captureWhen()?.date ?? currentSunDate())
             : which === "today" ? new Date().toISOString().slice(0, 10)
             : dates[which];
  sunDay = null; sunDayDate = null;
  await loadSunDay(date);
  const sl = document.getElementById("sunSlider");
  if (sl) scrubSun(+sl.value);
});
// typing an hour re-aims the sun, and "capture hour" puts it back to the plate's
// own time rather than to noon
document.getElementById("sunTime")?.addEventListener("change", ev => {
  const t = ev.target.value;
  if (!/^\d{2}:\d{2}$/.test(t)) return;
  const sl = document.getElementById("sunSlider");
  if (sl) sl.value = String(minutesOf(t));
  aimSun({ date: currentSunDate(), time: t });
});
document.getElementById("sunCapture")?.addEventListener("click", () => {
  const w = captureWhen();
  if (!w) { log("this capture's filename carries no date — the hour is unknown", "warn"); return; }
  const el = document.getElementById("sunTime");
  if (el) el.value = w.time;
  aimSun(w);
});
// ── SUNCLOCK-END ──

const overlays = new Map();          // variant name -> { group, design }
let designGroup = null, footprintGroup = null;
// the design's Fast plants that have coarser levels, and whether they are used (plant_lod.js)
let levelPlants = [], levelsOn = true;
let stage = null, stageKind = null;   // stageKind: 'splat' | 'points' | 'mesh'

const calib = {
  plane: null,           // {nx,ny,nz,d} in splat-local coords
  scale: 1,
  yaw: 0, tx: 0, tz: 0,
  spans: [],             // measured spans {p1:[x,z], p2:[x,z], lenM}
  bookmarks: {},
};

// ------------------------------------------------------------------ status log
// Acknowledgements appear briefly and go. Refusals, errors and reasons an edit
// did not apply stay until dismissed, so a rejected hand edit is refused
// VISIBLY.
//
// Messages raised before the shell mounts are queued rather than dropped: the
// first thing this file does is log that the viewer is ready.
const preToast = [];
let toasts = null;
function log(msg, cls = "") {
  if (toasts) toasts.push(msg, cls);
  else preToast.push([msg, cls]);
  console.log(msg);
}
// No "ready — open settings" toast: a site with steps left says so in the top bar, and that
// chip opens them; a site that is set up needs no instruction; no site at all gets the first screen.

// ------------------------------------------------------------------ HTML labels
// Every object carrying userData.label gets a <div> tracked to its world
// position each frame. Deliberately NOT in-scene sprites: those render into
// the naming screenshots (where only the numbered discs belong) and can render
// text rotated by 180 degrees.
const labelLayer = document.getElementById("labels");
const labelEls = new Map();            // object uuid -> element
const _lp = new THREE.Vector3();

function syncLabels() {
  const seen = new Set();
  const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
  // Declutter: 25 overlapping chips is noise, not information. Labels are
  // placed nearest-first and later ones are dropped where they would collide,
  // and low-priority kinds (individual plants) give way to named places.
  const placed = [];
  const PRIORITY = { landmark: 0, proposal: 1, north: 2, corner: 3, plant: 4, plain: 3 };
  const pending = [];
  scene.traverse(o => {
    const text = o.userData.label;
    if (text === undefined) return;
    // .visible is per-object, not inherited — without walking up, hiding a
    // layer leaves its labels floating over the scene
    for (let a = o; a; a = a.parent) if (!a.visible) return;
    seen.add(o.uuid);
    let el = labelEls.get(o.uuid);
    if (!el) {
      el = document.createElement("div");
      el.className = "lbl " + (o.userData.labelKind ?? "plain");
      const span = document.createElement("span");
      span.textContent = text;
      el.appendChild(span);
      if (o.userData.labelKind === "landmark") {
        const del = document.createElement("button");
        del.textContent = "✕";
        del.title = `delete "${text}"`;
        del.onclick = ev => { ev.stopPropagation(); deleteLandmark(text); };
        el.appendChild(del);
      }
      labelLayer.appendChild(el);
      labelEls.set(o.uuid, el);
    } else if (el.firstChild.textContent !== text) {
      el.firstChild.textContent = text;
    }
    const dist = o.getWorldPosition(_lp).distanceTo(camera.position);
    _lp.project(camera);
    if (_lp.z > 1 || _lp.x < -1.05 || _lp.x > 1.05 || _lp.y < -1.05 || _lp.y > 1.05) {
      el.style.display = "none";       // behind the camera or off-screen
      return;
    }
    pending.push({ el, dist, kind: o.userData.labelKind ?? "plain",
      x: (_lp.x + 1) / 2 * w, y: (-_lp.y + 1) / 2 * h });
  });

  pending.sort((a, b) =>
    (PRIORITY[a.kind] - PRIORITY[b.kind]) || (a.dist - b.dist));
  for (const p of pending) {
    // plants only earn a label once you are close enough to be placing them
    if (p.kind === "plant" && p.dist > 22) { p.el.style.display = "none"; continue; }
    const collides = placed.some(q =>
      Math.abs(q.x - p.x) < 78 && Math.abs(q.y - p.y) < 15);
    if (collides) { p.el.style.display = "none"; continue; }
    placed.push(p);
    p.el.style.display = "";
    p.el.style.left = `${p.x}px`;
    p.el.style.top = `${p.y}px`;
    p.el.style.opacity = p.dist > 45 ? "0.55" : "1";
  }
  for (const [uuid, el] of labelEls) {
    if (seen.has(uuid)) continue;
    el.remove();
    labelEls.delete(uuid);
  }
}

// ------------------------------------------------------------------ calibration application
let calibEpoch = 0;
// THE CALIBRATION SAVES ITSELF.
//
// Levelling, north and scale give every coordinate meaning. Keeping changes
// only in memory loses them on tab close and silently invalidates designs.
//
// Autosave hangs off `applyCalib`, the single place every change reaches the
// scene. An object watcher would duplicate the source of calibration state.
//
// Debounced, because Set north and a solved alignment call applyCalib several
// times as they converge, and quiet, because a toast per keystroke is noise.
// The button saves immediately and writes the terrain facts with it.
let calibSaveTimer = null;
let restoringCalib = false;
function autoSaveCalib() {
  if (restoringCalib) return;          // reading it back is not a change to it
  clearTimeout(calibSaveTimer);
  calibSaveTimer = setTimeout(() => {
    stashCalib(calib.captureUrl ?? calib.capture);
    fetch("/api/save", { method: "POST",
      body: JSON.stringify({ file: "data/calibration.json", json: calib }) })
      .catch(e => log(`could not save the calibration: ${e.message}`, "err"));
  }, 800);
}

function applyCalib() {
  calibEpoch++;
  autoSaveCalib();
  if (calib.plane) {
    const n = new THREE.Vector3(calib.plane.nx, calib.plane.ny, calib.plane.nz);
    levelGroup.quaternion.setFromUnitVectors(n, new THREE.Vector3(0, 1, 0));
    levelGroup.scale.setScalar(calib.scale);
    levelGroup.position.set(0, calib.scale * calib.plane.d, 0);
  }
  geoGroup.rotation.set(0, calib.yaw, 0);
  geoGroup.position.set(calib.tx, 0, calib.tz);
}

// ── BEARING-START ──
/** Yaw increment that turns a picked WORLD direction into north (-z).
 *
 * "Set north" is two clicks along something the owner knows runs north, and this
 * is the rotation about +Y that applyCalib then carries (geoGroup.rotation.y).
 * The bearing itself is NOT computed here: atan2(x, -z) has one home in
 * lighting.js, whose docstring names this call site and terrainFacts as the two
 * reasons it is exported. Sharing the lookup prevents row-indexing rules from
 * differing between callers.
 *
 * The result stays SIGNED, in (-pi, pi]: it is added to calib.yaw, saved, and
 * reversed by tools/sun.py (`true = stored - degrees(yaw)`), and it is printed
 * to the owner as "scene rotated N deg". A raw 0-360 bearing would land the
 * direction on north just as well while reporting a 23 deg nudge west as 337
 * and winding the stored yaw on by a full turn per click.
 *
 * Takes anything with .x/.z in the world frame, so the click handler's plain
 * {x, z} delta needs no Vector3.
 */
function northYawIncrement(d) {
  const bearing = worldBearingOf(d);
  return THREE.MathUtils.degToRad(bearing > 180 ? bearing - 360 : bearing);
}
// ── BEARING-END ──

// ------------------------------------------------------------------ stage loading
// The stage is whatever 3D capture the design is drawn over:
//   splat  — Gaussian-splat PLY/SPZ/... via Spark (photoreal; the primary path)
//   points — plain point-cloud PLY from a Scaniverse MESH scan (measurable fallback)
//   mesh   — textured GLB exported from a mesh scan (measurable fallback, better looks)
function disposeObj(obj, kind) {
  if (kind === "splat") obj.dispose?.();
  else obj.traverse(o => {
    // NOTE: every THREE.Sprite shares one module-level geometry, and label
    // textures are cached and reused — disposing either breaks other labels.
    if (o.isSprite) { o.material?.dispose?.(); return; }
    if (o.isInstancedMesh) o.dispose();
    o.geometry?.dispose?.();
    for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
      for (const key in m) if (m[key]?.isTexture && !m[key].userData.sharedPlantTexture) m[key].dispose();
      m.dispose();
    }
  });
}
function clearMarkers() {
  for (const m of markers.children) {
    m.geometry?.dispose?.();
    m.material?.dispose?.();
  }
  markers.clear();
}
function disposeStage() {
  if (!stage) return;
  levelGroup.remove(stage);
  disposeObj(stage, stageKind);
  stage = null;
  stageKind = null;
  terrain = null;      // the height field belongs to the stage that's going away
}

// round sprite so near-camera points don't render as big squares; created per
// load because disposeStage disposes the material's textures
function discTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.beginPath();
  g.arc(32, 32, 30, 0, Math.PI * 2);
  g.fill();
  return new THREE.CanvasTexture(c);
}

// generation token: a newer loadStage invalidates any still-awaiting older one,
// so a slow/failing stale load can neither add a second stage nor dispose the
// current one
let loadGen = 0;
let knownCaptures = [];    // filenames in data/captures/, filled at boot

// Calibration fields that describe ONE capture's placement in the design frame.
// Everything else in `calib` (bookmarks, the active capture) is global.
const CALIB_KEYS = ["plane", "scale", "yaw", "tx", "tz", "spans",
                    "groundNormal", "slopeDeg", "northSet"];

function stashCalib(url) {
  if (!url) return;
  calib.captures = calib.captures ?? {};
  const snap = {};
  for (const k of CALIB_KEYS) if (calib[k] !== undefined) snap[k] = calib[k];
  calib.captures[url] = snap;
}

function stageReady(captureName) {
  // A calibration belongs to the capture it is fitted on. Keep one per capture
  // so switching between GLB and PLY preserves each one's north and alignment.
  if (calib.capture && captureName && calib.capture !== captureName) {
    stashCalib(calib.capture);
    const saved = calib.captures?.[captureName];
    if (saved) {
      for (const k of CALIB_KEYS) delete calib[k];
      Object.assign(calib, { scale: 1, yaw: 0, tx: 0, tz: 0, spans: [] }, saved);
      log(`restored the calibration saved for this capture`, "ok");
    } else {
      calib.plane = null; calib.groundNormal = null;
      calib.northSet = false; calib.yaw = 0; calib.tx = 0; calib.tz = 0; calib.scale = 1;
      log(`no calibration for this capture yet — fitting the ground; set north and scale again for it`, "warn");
    }
  }
  if (captureName) {
    calib.capture = captureName;
    // remember a served path so the next session can reopen it by itself. A
    // hand-picked File has no path, but if a file of that name sits in
    // data/captures/ it is the same capture, so remember that instead.
    if (captureName.startsWith("/data/captures/")) calib.captureUrl = captureName;
    else if (knownCaptures.includes(captureName)) calib.captureUrl = "/data/captures/" + captureName;
    else calib.captureUrl = null;
  }
  autoFit();            // no-op when a saved calibration exists
  // calibrations saved before terrain facts existed lack groundNormal; the fit
  // is deterministic, so re-running it backfills without changing the result
  if (calib.plane && !calib.groundNormal) {
    try { fitGround(); } catch { /* keep restored calibration */ }
  }
  refreshGroundTruth(); // sample terrain, re-drape the design onto it
}

async function loadStage(input) {
  const gen = ++loadGen;
  // NOTE: the working stage is kept until the replacement is ready, so a failed
  // load leaves the viewer as it was instead of emptying the scene.
  const stale = () => gen !== loadGen;
  const commit = (obj, kind, alreadyAdded = false) => {
    if (stale()) {
      if (alreadyAdded) levelGroup.remove(obj);
      disposeObj(obj, kind);
      return false;
    }
    disposeStage();                 // drop the previous stage only now
    stage = obj; stageKind = kind;
    if (!alreadyAdded) levelGroup.add(obj);
    return true;
  };
  // keep the real, case-preserved source for identity/persistence; lowercase
  // only for extension sniffing
  const source = typeof input === "string" ? input.split("?")[0] : input.name;
  const name = source.toLowerCase();
  const bytes = async () =>
    typeof input === "string" ? await (await fetch(input)).arrayBuffer() : await input.arrayBuffer();
  try {
    if (name.endsWith(".gltf")) {
      log("use a GLB export instead — .gltf references external files the viewer can't fetch", "err");
      return;
    }
    if (name.endsWith(".glb")) {
      const gltf = await getLoader().parseAsync(await bytes(), "");
      if (!commit(gltf.scene, "mesh")) return;
      let tris = 0;
      stage.traverse(o => {
        if (o.isMesh) tris += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3;
      });
      log(`mesh stage loaded: ${Math.round(tris).toLocaleString()} triangles`, "ok");
      // the plate's shadows are baked in at the hour it was photographed, so the
      // design is lit at that hour unless the owner moves the clock
      aimSun(captureSunTime(calib.captureUrl ?? calib.capture ?? input));
      stageReady(source);
      return;
    }
    let splatOpts;
    if (name.endsWith(".ply")) {
      const buf = await bytes();
      if (stale()) return;
      if (!isSplatPly(buf)) {
        const { positions, colors, count } = await loadPlyPointCloud(buf);
        if (stale()) return;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        if (colors) {
          // PLY colors are sRGB display values; three.js vertex colors are linear
          for (let i = 0; i < colors.length; i++) {
            const c = colors[i];
            colors[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
          }
          geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
        }
        const pts = new THREE.Points(geo,
          new THREE.PointsMaterial({ size: 0.02, vertexColors: !!colors, sizeAttenuation: true,
            map: discTexture(), alphaTest: 0.5 }));
        if (!commit(pts, "points")) return;
        log(`point-cloud stage loaded: ${count.toLocaleString()} points (mesh-scan PLY — fine for scale/align; re-capture in Splat mode for the photoreal stage)`, "ok");
        stageReady(source);
        return;
      }
      splatOpts = { fileBytes: new Uint8Array(buf), fileName: name.split("/").pop() };
    } else {
      splatOpts = typeof input === "string" ? { url: input }
        : { fileBytes: new Uint8Array(await input.arrayBuffer()), fileName: input.name };
      if (stale()) return;
    }
    const mesh = new SplatMesh(splatOpts);
    levelGroup.add(mesh);                 // Spark renders it as it streams in
    try {
      await mesh.initialized;
    } catch (e) {
      levelGroup.remove(mesh);
      disposeObj(mesh, "splat");
      throw e;
    }
    if (!commit(mesh, "splat", true)) return;
    log(`splat loaded: ${mesh.packedSplats?.numSplats ?? "?"} splats`, "ok");
    stageReady(source);
  } catch (e) {
    if (stale()) return;
    // nothing was committed, so the previous stage is still live and correct
    log(`stage load failed: ${e?.message ?? e}`, "err");
  }
}

function sampleCenters(maxPoints = 60000) {
  if (!stage) throw new Error("no stage loaded");
  if (stageKind === "splat") {
    const n = stage.packedSplats?.numSplats ?? 0;
    if (!n) throw new Error("splat not ready");
    const step = Math.max(1, Math.floor(n / maxPoints));
    const out = new Float32Array(Math.ceil(n / step) * 3);
    let k = 0;
    stage.forEachSplat((index, center) => {
      if (index % step === 0 && k * 3 + 2 < out.length) {
        out[k * 3] = center.x; out[k * 3 + 1] = center.y; out[k * 3 + 2] = center.z; k++;
      }
    });
    return out.slice(0, k * 3);
  }
  // points/mesh stage: sample vertex positions in the stage root's local frame
  // (a GLB may nest transformed meshes, so map each through invRoot * matrixWorld)
  stage.updateMatrixWorld(true);
  const invRoot = new THREE.Matrix4().copy(stage.matrixWorld).invert();
  const chunks = [];
  let total = 0;
  stage.traverse(o => {
    const attr = o.geometry?.attributes?.position;
    if (!attr || (!o.isMesh && !o.isPoints)) return;
    chunks.push({ attr, mat: new THREE.Matrix4().multiplyMatrices(invRoot, o.matrixWorld) });
    total += attr.count;
  });
  if (!total) throw new Error("stage has no vertices");
  const step = Math.max(1, Math.floor(total / maxPoints));
  const out = new Float32Array(Math.ceil(total / step) * 3);
  const v = new THREE.Vector3();
  let k = 0, idx = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.attr.count; i++, idx++) {
      if (idx % step) continue;
      v.fromBufferAttribute(c.attr, i).applyMatrix4(c.mat);
      out[k * 3] = v.x; out[k * 3 + 1] = v.y; out[k * 3 + 2] = v.z; k++;
    }
  }
  return out.slice(0, k * 3);
}

function fitGround() {
  const pts = sampleCenters();
  const g = fitGroundAuto(pts);
  calib.plane = { nx: g.normal.x, ny: g.normal.y, nz: g.normal.z, d: g.d };
  calib.groundNormal = g.groundNormal;
  calib.slopeDeg = g.slopeDeg;
  applyCalib();
  if (g.snapped) {
    log(`ground fit: up snapped to gravity axis ${g.axisName}, grid at main ground level`
      + (g.slopeDeg > 3 ? `; terrain slopes ~${g.slopeDeg.toFixed(1)} deg (real slope — verticals stay vertical)` : ""), "ok");
  } else {
    log(`ground fit: dominant plane (no gravity-axis support), inliers ${(g.inlierRatio * 100).toFixed(0)}%`, "ok");
  }
}

function autoFit() {
  if (calib.plane) return;   // keep a restored/saved calibration
  try { fitGround(); } catch (e) { log(`auto ground fit skipped: ${e.message}`, "warn"); }
}

// ------------------------------------------------------------------ terrain
// Height field over the stage in world coords; the design drapes onto it.
// Rebuilt whenever the stage or any calibration transform changes.
let terrain = null;
// Bumped whenever heightAt() can answer differently, so a rebuild never keeps a
// part draped on the old ground (see buildDesignGroup's reuse).
let drapeEpoch = 0;
// data/terrain_scan.json: a 1 m raycast of the actual scan mesh, with TRUE
// coverage and no fill. It is loaded once and preferred over the BFS-filled
// height field, because the fill propagates STRUCTURE heights into unscanned
// cells and stands objects on invented ground. A filled height of +0.50 m
// against a mesh height of -1.20 m puts a plant nearly two metres in the air;
// the raycast agrees with the mesh to 1 cm. Both site_api.py and the viewer
// prefer this measured source.
let scanGrid = null;

async function loadScanGrid() {
  try { scanGrid = await fetchJson("/data/terrain_scan.json"); }
  catch { scanGrid = null; }
  drapeEpoch++;
}

/** Scanned elevation at ENU (x, y), bilinear, or null where nothing was seen. */
function scanHeight(ex, ey) {
  const t = scanGrid;
  if (!t) return null;
  const fc = (ex - t.x0) / t.cell_m, fr = (t.y1 - ey) / t.cell_m;
  const c0 = Math.floor(fc), r0 = Math.floor(fr);
  const tx = fc - c0, ty = fr - r0;
  const at = (r, c) => (r >= 0 && r < t.rows.length && c >= 0 && c < t.rows[r].length)
    ? t.rows[r][c] : null;
  const q = [at(r0, c0), at(r0, c0 + 1), at(r0 + 1, c0), at(r0 + 1, c0 + 1)];
  if (q.every(v => v !== null)) {
    const top = q[0] * (1 - tx) + q[1] * tx, bot = q[2] * (1 - tx) + q[3] * tx;
    return top * (1 - ty) + bot * ty;
  }
  // never interpolate across the edge of coverage — that is what invents ground
  return at(Math.round(fr), Math.round(fc));
}

const heightAt = (x, z) => {
  const s = scanHeight(x, -z);            // world z -> ENU y
  if (s !== null && s !== undefined) return s;
  return terrain ? terrain.heightAt(x, z) : 0;
};

function rebuildTerrain() {
  terrain = null;
  drapeEpoch++;
  if (!stage) return;
  try {
    // updateWorldMatrix(true, ...) recomputes ANCESTORS first. applyCalib()
    // only sets local transforms on geoGroup/levelGroup, and callers rebuild
    // terrain in the same task with no render in between — plain
    // updateMatrixWorld() would multiply by a stale parent matrixWorld and
    // build the height field one calibration step behind.
    stage.updateWorldMatrix(true, false);
    const local = sampleCenters(60000);
    // stage-local -> world -> ENU. heightAt() queries this field with ENU
    // coordinates, so building it in world space silently rotates the ground out
    // from under every lookup once north is set. It is the FALLBACK field (BFS
    // filled), so it answers everywhere rather than returning null — which is
    // why the failure shows up as a section of plants launching into the sky
    // instead of as a visible hole.
    const enu = new Float32Array(local.length);
    const v = new THREE.Vector3();
    for (let i = 0; i < local.length / 3; i++) {
      v.set(local[i * 3], local[i * 3 + 1], local[i * 3 + 2]).applyMatrix4(stage.matrixWorld);
      enuGroup.worldToLocal(v);
      enu[i * 3] = v.x; enu[i * 3 + 1] = v.y; enu[i * 3 + 2] = v.z;
    }
    terrain = buildHeightField(enu);
    if (!terrain) log("terrain height field unavailable — design will sit flat at ground level", "warn");
  } catch (e) {
    log(`terrain sampling skipped: ${e.message}`, "warn");
  }
}

// after a stage load or calibration change: re-sample terrain, re-drape design
function refreshGroundTruth() {
  rebuildTerrain();
  exportTerrain();
  reprojectLandmarks();
  if (proposals.length && proposalsCapture !== stageToken()) {
    clearProposals();
    log("detected structures cleared — the scan moved, run Detect again", "warn");
  }
  loadDesign(true);
  if (siteCache) redrawSite();
}

// ------------------------------------------------------------------ picking
const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
function pickGround(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = new THREE.Vector3();
  return raycaster.ray.intersectPlane(groundPlane, hit) ? hit : null;
}
// Pick the real captured surface, not the flat y=0 plane — on a sloped yard
// the two diverge by meters, and a plane pick lands the click meters away
// horizontally from the spot the user aimed at.
//   points/mesh stage: raycast the geometry directly
//   splat stage (no raycastable geometry): march the ray against the terrain
//   height field, then bisect
/**
 * March a WORLD ray onto the scanned ground and return the WORLD point it hits.
 *
 * Separate from pickSurface's DOM event handling so frame_check can drive the
 * ground intersection directly at a non-zero yaw.
 *
 * The whole march happens in the ENU frame. The ray arrives in WORLD, but
 * heightAt() and terrain.contains() are ENU-frame lookups, so marching a world
 * ray against them bisects the height of a DIFFERENT patch of ground the moment
 * north is set, and the hit slides along the ray. At a 23.3 deg yaw over a
 * scanned yard that is a median 0.80 m, p90 2.25 m, max 5.92 m — and this pick is
 * what gets written to site.json.
 */
function marchRayToGround(worldOrigin, worldDir) {
  if (!terrain) return null;
  const inv = new THREE.Matrix4().copy(enuGroup.matrixWorld).invert();
  const o = worldOrigin.clone().applyMatrix4(inv);
  const d = worldDir.clone().transformDirection(inv);
  const at = t => new THREE.Vector3().copy(d).multiplyScalar(t).add(o);
  const above = t => { const p = at(t); return p.y - heightAt(p.x, p.z); };
  // march until the ray crosses the surface, from whichever side it starts
  // (the camera can sit below terrain when orbiting a steep yard)
  const startSign = Math.sign(above(0)) || 1;
  let prev = 0, hit = null;
  for (let t = 0.5; t <= 200 && !hit; t += 0.5) {
    if (Math.sign(above(t)) !== startSign) {
      let lo = prev, hi = t;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (Math.sign(above(mid)) === startSign) lo = mid; else hi = mid;
      }
      hit = at((lo + hi) / 2);
    }
    prev = t;
  }
  // a crossing outside the sampled envelope is the flat border extrusion, not
  // measured ground. hit is ENU; callers expect WORLD.
  if (hit && terrain.contains(hit.x, hit.z)) return enuGroup.localToWorld(hit);
  return null;
}

/**
 * What a ⌘-drag turns around: whatever is under the cursor.
 *
 * THE DESIGN FIRST, THEN THE SCAN. Pointing at a bench turns around the bench;
 * picking only the ground puts the pivot on the soil BEHIND it and swings the
 * subject out of frame. `pickSurface` handles mesh, points and the splat's
 * height-field march, so the ground half is not re-derived here.
 *
 * It RETURNS the point and never writes `controls.target`: OrbitControls
 * aims the camera at its target on every update, so moving that target to an
 * off-centre point turns the whole view to face it. `pivotOrbit` does the turn.
 */
function pivotUnderCursor(ev) {
  let hit = null;
  const r = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1,
                                -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const onDesign = designGroup ? raycaster.intersectObject(designGroup, true)[0] : null;
  if (onDesign) hit = onDesign.point.clone();
  if (!hit) hit = pickSurface(ev) ?? pickGround(ev);
  return orbitPivot({
    hit: hit ? [hit.x, hit.y, hit.z] : null,
    camera: [camera.position.x, camera.position.y, camera.position.z],
    target: [controls.target.x, controls.target.y, controls.target.z],
  });
}

// A ⌘-DRAG IN PROGRESS: { pivot, x, y }. OrbitControls sits it out (enabled=false)
// so it cannot re-aim the camera at its own target mid-gesture.
let pivotDrag = null;
function endPivotDrag() {
  if (!pivotDrag) return;
  pivotDrag = null;
  controls.enabled = true;
}
addEventListener("pointermove", ev => {
  if (!pivotDrag) return;
  const dx = ev.clientX - pivotDrag.x, dy = ev.clientY - pivotDrag.y;
  pivotDrag.x = ev.clientX; pivotDrag.y = ev.clientY;
  if (!dx && !dy) return;
  const f = camera.getWorldDirection(new THREE.Vector3());
  const next = pivotOrbit({
    position: [camera.position.x, camera.position.y, camera.position.z],
    forward: [f.x, f.y, f.z], pivot: pivotDrag.pivot, dx, dy,
    height: renderer.domElement.clientHeight, speed: controls.rotateSpeed,
  });
  camera.position.set(...next.position);
  controls.target.set(...next.target);        // on the view axis: update() keeps the aim
  camera.lookAt(controls.target);
  controls.update();
}, true);
addEventListener("pointerup", endPivotDrag, true);
addEventListener("pointercancel", endPivotDrag, true);
addEventListener("blur", endPivotDrag);

function pickSurface(ev, { quiet = false } = {}) {
  if (stage && stageKind !== "splat") {
    const r = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    raycaster.params.Points.threshold = 0.06;
    const hit = raycaster.intersectObject(stage, true)[0];
    if (hit) return hit.point.clone();
  }
  if (stage && terrain) {
    const r = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = marchRayToGround(raycaster.ray.origin, raycaster.ray.direction);
    if (hit) return hit;
    if (!quiet) log("click missed the scanned ground (sky, background, or outside the capture) — aim at the ground", "warn");
    return null;
  }
  return pickGround(ev);   // no stage/terrain yet: the plane pick is all there is
}
function pickFootprintMarker(ev) {
  if (!footprintGroup) return null;
  const r = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(footprintGroup.children.filter(o => o.userData.pickable === "footprint"), false);
  return hits[0]?.object ?? null;
}
// Callers hand us a WORLD point (that is what a raycast returns); markers live
// in the enuGroup frame, so convert here rather than at every call site.
function addMarker(p, color = 0x7fc69a, r = 0.09) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), new THREE.MeshBasicMaterial({ color }));
  m.position.copy(enuGroup.worldToLocal(p.clone()));
  markers.add(m);
  return m;
}

// ------------------------------------------------------------------ modes
let mode = "orbit";
let spanPts = [];             // clicked ground points for current span
let northPts = [];            // clicked points for the north direction
let alignPairs = [];          // {scene:[x,z], fp:[x,z]}
let awaiting = "scene";       // in align mode: 'scene' | 'marker'

/**
 * The trade's drawings, for the beds THE USER SELECTS. A whole yard does not fit
 * a sheet at 1:50 and nobody plants a whole yard in a day; with nothing selected the
 * tool picks the walk with the most planting beside it and the beds along it.
 */
function openPlantingPlan() {
  const beds = [...selection].filter(id => (currentDesign?.beds ?? []).some(b => b.id === id));
  window.open(`/api/plan${beds.length ? `?beds=${encodeURIComponent(beds.join(","))}` : ""}`, "_blank", "noopener");
  log(beds.length ? `making planting drawings for ${beds.join(", ")} — they open in a new tab`
                  : "making planting drawings — select the beds you are planting first to get just those", "ok");
}

// The marker a Places row armed for moving: the next click on the ground
// puts it there. Declared above setMode because setMode clears it, and setMode
// runs during start-up — below it, that first call would hit the dead zone.
let arSheet = null;                  // mounted with the rest of the shell
let soloMemory = null;               // what was hidden before a Solo; cleared when the design changes
let relocating = null;
let armedMove = null;                 // set by a Places row just before it calls setMode
function setMode(m) {
  // any change of mode abandons a pending move; only a row's own call carries one in
  relocating = m === "landmark" ? armedMove : null;
  armedMove = null;
  // Leaving `measure` has to take its overlay with it, or a green line and a
  // readout survive into the next mode describing a run nobody is looking at,
  // with the Measure button still lit. setMode is the ONE owner of mode state,
  // so the cleanup belongs here rather than in each button.
  if (mode === "measure" && m !== "measure") clearMeasure();
  mode = m;
  // not scoped to #panel: north, span and align live in the settings
  // window, and a scoped selector would leave them working but never looking
  // pressed — a mode you cannot see you are in
  document.querySelectorAll("button[data-mode]").forEach(b =>
    b.classList.toggle("active", b.dataset.mode === m));
  syncRail();
  if (m === "span") { spanPts = []; log("Span mode: click 2 points on the ground along your taped span."); }
  if (m === "north") { northPts = []; log("North mode: click a start point, then a second point in the TRUE-NORTH direction from it (read the bearing off your phone's Compass app or Google Maps)."); }
  if (m === "landmark" && !relocating) { log("Landmark mode: type a name (e.g. stairs_bottom), then click that spot in the scene. Repeat for more; click the button again to exit."); }
  if (m !== "place") clearPlaceGhost();
  if (m === "place") {
    buildPlaceGhost();
    const what = document.getElementById("placeWhat").selectedOptions[0]?.textContent ?? "nothing picked";
    log(`Place mode: click the ground to put down ${what}. It goes through the same checks the `
      + "model places, so it can be refused — Back undoes it either way. Click the button again to exit.");
  }
  if (m === "pick") {
    log("Select a section: hold and drag a loop around the plants you want. "
      + "Hold shift to add to the selection. Then \u21e7S shows only those, or use "
      + "the eye in the Objects list to hide them. Esc leaves.");
  }
  if (m === "align") { alignPairs = []; awaiting = "scene"; clearMarkers(); log("Align mode: click a house corner in the scene, then its red footprint post. 1 pair = position only (set north first); 3 pairs = full solve."); }
}

// ------------------------------------------------------------------ drag pins
// Detection and clicking put a pin close to the right spot; nudging it onto the
// exact corner of a structure is quicker than retyping coordinates.
let drag = null;
function pickPin(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const targets = [
    ...proposalGroup.children.filter(o => o.userData.proposalId !== undefined),
    ...(footprintGroup?.children ?? []).filter(o => o.userData.landmark !== undefined),
  ];
  return raycaster.intersectObjects(targets, false)[0]?.object ?? null;
}

renderer.domElement.addEventListener("pointerdown", ev => {
  renderer.domElement._down = [ev.clientX, ev.clientY];
  if (mode !== "orbit") return;
  const pin = pickPin(ev);
  if (!pin) return;
  drag = { pin, moved: false };
  renderer.domElement.style.cursor = "grabbing";
  controls.enabled = false;
  renderer.domElement.setPointerCapture?.(ev.pointerId);
});

renderer.domElement.addEventListener("pointermove", ev => {
  if (mode === "place") movePlaceGhost(ev);
  if (!drag) {
    // hover feedback: light the object under the cursor and show it's clickable
    if (mode === "orbit" && !renderer.domElement._down) {
      const id = pickDesignObject(ev);
      if (id !== hoverId) {
        hoverId = id;
        applySelectionHighlight();
        renderObjectList();
        renderer.domElement.style.cursor = id ? "pointer" : "";
      }
      // Show that a marker is grabbable. The pin wins over a plant behind it
      // because it also wins the PRESS: pointerdown asks pickPin first.
      renderer.domElement.style.cursor = pickPin(ev) ? "grab" : id ? "pointer" : "";
    }
    return;
  }
  const p = pickSurface(ev);
  if (!p) return;
  drag.moved = true;
  drag.pos = p;
  const id = drag.pin.userData.proposalId;
  if (id !== undefined) {
    const prop = proposals.find(q => q.id === id);
    if (prop) { const e = worldToEnu(p); prop.x = +e[0].toFixed(2); prop.y = +e[1].toFixed(2); }
    drawProposals();
    drag.pin = proposalGroup.children.find(o => o.userData.proposalId === id) ?? drag.pin;
  } else {
    // Move THE WHOLE PIN, each part at its own height, so the ring marking the
    // coordinate follows even when the user grabs the stem.
    const lp = enuGroup.worldToLocal(p.clone());
    for (const [part, lift] of pinParts(footprintGroup?.children, drag.pin.userData.landmark))
      part.position.set(lp.x, lp.y + lift, lp.z);
  }
});

renderer.domElement.addEventListener("pointerup", async ev => {
  if (!drag) return;
  const { pin, moved, pos } = drag;
  drag = null;
  renderer.domElement.style.cursor = "";
  controls.enabled = true;
  renderer.domElement.releasePointerCapture?.(ev.pointerId);
  if (!moved || !pos) return;
  const name = pin.userData.landmark;
  if (name !== undefined) {
    if (await addLandmark(name, pos)) log(`moved "${name}" to ENU (${pos.x.toFixed(1)}, ${(-pos.z).toFixed(1)})`, "ok");
  } else {
    log(`candidate ${pin.userData.proposalId} moved — press keep to save it there`);
  }
}, true);

// ------------------------------------------------------------ drag to move
// Direct manipulation lets the user nudge a bed without asking the model.
// The drag is only a PREVIEW — on release it emits the object's own upsert op
// through the same validators the model's ops face, so the ground gets a vote.
//
// Only something already SELECTED can be dragged. A first click only selects.
// A dead zone before a drag engages, in SCREEN PIXELS.
//
// Selection alone cannot prevent accidental edits: pointer jitter after a
// selected handle is pressed must not post an op, write design.json or add a
// timeline entry. The drag engages only after the pointer clears the dead zone.
//
// Pixels, not metres, and that is the whole point. moveOps already refuses a move
// under a stored centimetre — but at a zoomed-out view four pixels of tremor is
// 20 cm of yard and clears that easily, while zoomed in a deliberate 5 cm nudge is
// half a pixel and would be thrown away. One threshold in world units cannot
// separate "the hand slipped" from "the hand meant it" at two different zooms; the
// hand works in pixels. Same reasoning as the lasso, which thins sub-10 cm samples
// as tremor rather than intent.
//
// 5 px: under 3 does not cover tremor on a trackpad, over ~12 makes a deliberate
// short drag feel broken.
const DRAG_THRESHOLD_PX = 5;
// A body drag controls the camera to avoid accidental moves. The gizmo keeps
// its own drag state, and `previewMove` is shared.

renderer.domElement.addEventListener("pointerdown", ev => {
  if (mode !== "orbit" || ev.button !== 0 || drag || gizmoDrag) return;
  // ONE place decides what a press grabs, rather than three handlers each
  // resolving it in if-order and eventually disagreeing. grabOrder is pure and
  // tested: the gizmo is drawn on top of everything so it wins; a control point
  // sits on top of the object it belongs to so it beats a body drag; whatever is
  // left belongs to the camera.
  const gpart = pickGizmo(ev);
  const h = pickHandle(ev);
  const id = pickDesignObject(ev);
  // ORBIT ABOUT WHAT THE USER POINTS AT. Set BEFORE the drag turns into
  // anything, and only for the ⌘ gesture — a plain drag on empty ground should
  // keep its pivot, or the site swings about a different point whenever the user
  // grabs a different patch of grass.
  const pivot = holdsOrbitModifier(ev) ? pivotUnderCursor(ev) : null;
  const grab = grabOrder({ gizmo: !!gpart, handle: !!h,
                           object: id !== null && selection.has(id),
                           // ⌘ (or ctrl) turns any drag into an orbit, wherever
                           // the cursor is — see grabOrder for why it outranks
                           // the gizmo rather than sitting below it
                           orbitModifier: ev.metaKey || ev.ctrlKey });
  if (grab === "gizmo" && startGizmoDrag(ev, gpart)) return;
  if (grab === "orbit") {
    // the turn is ours, about the pointed-at spot; OrbitControls already took
    // the press and would otherwise re-aim at its target on the first move
    if (pivot) { pivotDrag = { pivot, x: ev.clientX, y: ev.clientY }; controls.enabled = false; }
    return;
  }
  if (h && h.userData.midpoint) {
    // a faint midpoint: clicking it ADDS a corner there
    const m = h.userData.midpoint;
    const found = rawById(currentDesign, m.id);
    if (found) {
      controls.enabled = false;
      (async () => {
        try {
          await postOps(insertPointOps(m.kind, found.raw, m.after, m.at),
                        `${m.id}: point added`);
        } catch (e) { log(String(e?.message ?? e), "warn"); }
        controls.enabled = true;
      })();
      return;
    }
  }
  if (h) {
    const found = rawById(currentDesign, h.userData.handle.id);
    if (found) {
      handleDrag = { ...h.userData.handle, raw: found.raw, node: h };
      controls.enabled = false;
      renderer.domElement.setPointerCapture?.(ev.pointerId);
      return;
    }
  }
  // nothing else grabs a press: `grabOrder` sends a body drag to the camera, so
  // the only ways to move a thing are the gizmo and its control points
});

renderer.domElement.addEventListener("pointermove", ev => {
  if (gizmoDrag) { updateGizmoDrag(ev); return; }
  if (handleDrag) {
    const p = pickSurface(ev);
    if (!p) return;
    const [x, y] = worldToEnu(p);
    handleDrag.to = [x, y];
    const g = heightAt(p.x, p.z);
    handleDrag.node.position.copy(enuToWorld(x, y, (Number.isFinite(g) ? g : 0) + 0.12));
    return;
  }
});

renderer.domElement.addEventListener("pointerup", async ev => {
  if (gizmoDrag) { await endGizmoDrag(ev); return; }
  if (handleDrag) {
    const d = handleDrag;
    handleDrag = null;
    controls.enabled = true;
    renderer.domElement.releasePointerCapture?.(ev.pointerId);
    if (!d.to) { renderHandles(); return; }          // never left the handle
    try {
      const ops = reshapeOps(d.kind, d.raw, d.index, snapped(d.to, d.raw.id));
      if (ops.length) {
        await postOps(ops, `${d.raw.id} point ${d.index + 1} moved`);
      } else {
        renderHandles();                              // unchanged: put it back
      }
    } catch (e) {
      log(String(e?.message ?? e), "warn");
      renderHandles();
    }
    return;
  }
}, true);

renderer.domElement.addEventListener("pointercancel", () => {
  if (gizmoDrag) {
    for (const n of gizmoDrag.nodes) { n.o.position.copy(n.base); n.o.rotation.y = n.baseRotY; }
    gizmoDrag = null;
    controls.enabled = true;
    showGizmoHud(null);
    clearGhost();
    renderGizmo();
  }
  if (!drag) return;                 // never leave orbit disabled
  drag = null;
  controls.enabled = true;
});

// `_down` MUST BE CLEARED, or the only affordance in the app dies on first click.
//
// It is set on every pointerdown and read in two places: to tell a click from a
// drag on pointerup, and to SUPPRESS HOVER FEEDBACK while the button is held —
// `if (mode === "orbit" && !renderer.domElement._down)`. Clearing it restores
// object highlighting and the hand cursor after release, so clickable things
// remain discoverable.
//
// On WINDOW, not on the canvas, and deliberately: window handlers run in the
// bubble phase after every listener on the element, so the click-versus-drag
// test at the end of the canvas's own pointerup still sees the value. A release
// OUTSIDE the canvas (a drag that ended off-screen) has to clear it too, and
// only a window listener hears that one at all.
addEventListener("pointerup", () => { renderer.domElement._down = null; });
addEventListener("pointercancel", () => { renderer.domElement._down = null; });

let lassoAdditive = false;
renderer.domElement.addEventListener("pointerdown", ev => {
  if ((mode !== "area" && mode !== "pick") || ev.button !== 0) return;
  lassoAdditive = ev.shiftKey || ev.metaKey;
  // OrbitControls owns the pointer otherwise, and the camera would swing while
  // you draw. Disable it for the duration of the stroke and restore on release.
  controls.enabled = false;
  lasso.reset();
  const p = pickSurface(ev);
  if (p) lasso.push(...worldToEnu(p));
  drawLiveLasso();
});

renderer.domElement.addEventListener("pointermove", ev => {
  if ((mode !== "area" && mode !== "pick") || controls.enabled) return;
  const p = pickSurface(ev);
  if (p && lasso.push(...worldToEnu(p))) drawLiveLasso();
});

renderer.domElement.addEventListener("pointerdown", ev => {
  if (mode === "measure") measDownAt = [ev.clientX, ev.clientY];
});

renderer.domElement.addEventListener("pointerup", ev => {
  if (mode === "measure") {
    // an orbit drag ends in a pointerup too, and dropping a measuring point
    // every time you turn the camera makes the tool unusable
    if (measDownAt && Math.hypot(ev.clientX - measDownAt[0],
                                 ev.clientY - measDownAt[1]) >= DRAG_THRESHOLD_PX) return;
    const p = pickSurface(ev);
    if (!p) { log("that click missed the ground", "warn"); return; }
    const e = worldToEnu(p);
    meas.pts.push([+e[0].toFixed(2), +e[1].toFixed(2)]);
    drawMeasure();
    return;
  }
  if (mode === "pick") {
    // SELECT A SECTION OF THE YARD BY DRAWING ROUND IT.
    //
    // Select objects by where they stand so the user can hide a section and
    // focus on one area. Shift-range in the Objects list, shift-click in the
    // view, per-object and per-group hide, and Solo on ⇧S handle selection by
    // name or individual object; the lasso supplies the spatial gesture.
    controls.enabled = true;
    const poly = lasso.finish();
    lasso.reset();
    if (liveAreaGroup) { enuGroup.remove(liveAreaGroup); disposeObj(liveAreaGroup, "mesh"); liveAreaGroup = null; }
    if (!poly) { log("that was too small — hold and drag a loop around what you want", "warn"); return; }
    const hit = idsInsidePolygon(currentDesign, poly, DESIGN_KINDS, lockedIds(designGroups()));
    if (!hit.length) { log("nothing inside that loop", "warn"); return; }
    // holding shift adds to what is already selected, the same as a shift-click
    const add = lassoAdditive;
    setSelection(selectableIds(add ? [...new Set([...selection, ...hit])] : hit, designGroups()));
    log(`${hit.length} selected — ⇧S to show only these, or hide them from the Objects list`, "ok");
    return;
  }
  if (mode === "area") {
    controls.enabled = true;
    const poly = lasso.finish();
    lasso.reset();
    if (liveAreaGroup) { enuGroup.remove(liveAreaGroup); disposeObj(liveAreaGroup, "mesh"); liveAreaGroup = null; }
    if (!poly) { log("that was too small to be an area — hold and drag across the ground", "warn"); return; }
    const nameEl = document.getElementById("areaName");
    // a typed name is a shortcut, never a precondition: draw first, and it is
    // called `area 6` until you say otherwise
    const taken = new Set((siteCache?.areas ?? []).map(a => a.name));
    let n = (siteCache?.areas ?? []).length + 1;
    while (taken.has(`area ${n}`)) n++;
    const name = nameEl.value.trim() || `area ${n}`;
    mode = "orbit";
    document.getElementById("btnDrawArea").classList.remove("active");
    nameEl.value = "";
    saveArea(name, poly);
    return;
  }
  const d = renderer.domElement._down;
  if (!d || Math.hypot(ev.clientX - d[0], ev.clientY - d[1]) > 4) return;  // it was a drag
  if (mode === "orbit") {
    // plain click selects a design object; shift/cmd adds to the selection
    const id = pickDesignObject(ev);
    if (id === null) { if (!ev.shiftKey && !ev.metaKey) setSelection([]); return; }
    // a grouped object is picked as its GROUP; alt reaches inside it
    const known = new Set(designObjects().map(o => o.id));
    const ids = clickSelects(id, designGroups(), { inside: ev.altKey })
      .filter(x => known.has(x));
    if (!ids.length) return;
    if (ev.shiftKey || ev.metaKey) {
      // the group joins or leaves as one thing: toggling member by member would
      // leave half a group selected off a single click
      const all = ids.every(x => selection.has(x));
      for (const x of ids) all ? selection.delete(x) : selection.add(x);
      applySelectionHighlight(); renderSelection(); renderProperties(); renderHandles();
      renderGizmo();
    } else {
      const same = selection.size === ids.length && ids.every(x => selection.has(x));
      setSelection(same ? [] : ids);
    }
    return;
  }
  if (mode === "span") {
    const p = pickSurface(ev);
    if (!p) return;
    spanPts.push(p.clone());
    addMarker(p);
    if (spanPts.length === 2) {
      const dist = spanPts[0].distanceTo(spanPts[1]);
      log(`span picked: ${dist.toFixed(2)} m = ${(dist / 0.3048).toFixed(2)} ft (capture's own metric scale). Enter the taped length and press "Set scale", then check it on a second span.`);
      setMode("orbit");
    }
  } else if (mode === "north") {
    const p = pickSurface(ev);
    if (!p) return;
    northPts.push(p.clone());
    addMarker(p, 0x66aaff);
    if (northPts.length === 2) {
      const d = { x: northPts[1].x - northPts[0].x, z: northPts[1].z - northPts[0].z };
      if (Math.hypot(d.x, d.z) < 0.2) {
        log("points too close together — click again, farther apart", "warn");
        northPts = []; clearMarkers(); return;
      }
      // world yaw increment g mapping the clicked direction onto -z (north);
      // rotate about the clicked midpoint so the scene doesn't swing away
      const g = northYawIncrement(d);
      const cos = Math.cos(g), sin = Math.sin(g);
      const rot = (x, z) => [x * cos + z * sin, -x * sin + z * cos];
      const mid = { x: (northPts[0].x + northPts[1].x) / 2, z: (northPts[0].z + northPts[1].z) / 2 };
      const [mrx, mrz] = rot(mid.x, mid.z);
      const [trx, trz] = rot(calib.tx, calib.tz);
      calib.yaw += g;
      calib.tx = trx + (mid.x - mrx);
      calib.tz = trz + (mid.z - mrz);
      calib.northSet = true;
      aimSun();          // the azimuth sun.py refused is trustworthy now
      applyCalib();
      log(`north set: scene rotated ${(g * 180 / Math.PI).toFixed(1)} deg — the blue N arrow now points true north. Save calibration to keep it.`, "ok");
      northPts = []; clearMarkers();
      setMode("orbit");
      refreshGroundTruth();
    }
  } else if (mode === "landmark") {
    const p = pickSurface(ev);
    if (!p) return;
    const nameInput = document.getElementById("lmName");
    // Landmarks auto-number a blank name, and the new row opens for renaming.
    // blank name -> auto-number against the file's CURRENT contents, not a
    // possibly-empty cache, or the first click after a reload overwrites spot_1
    if (relocating) {
      // armed from a Places row's "move": one click puts that marker here
      const moving = relocating;
      relocating = null;
      setMode("orbit");
      addLandmark(moving, p).then(done => { if (done) log(`moved "${moving}"`, "ok"); });
      return;
    }
    const name = nameInput.value.trim().replace(/\s+/g, "_").toLowerCase() || null;
    nameInput.value = "";
    addLandmark(name, p);
  } else if (mode === "place") {
    placeHere(ev);
  } else if (mode === "align") {
    if (awaiting === "scene") {
      const p = pickSurface(ev);
      if (!p) return;
      alignPairs.push({ scene: [p.x, p.z], fp: null });
      addMarker(p, 0x7fc69a);
      awaiting = "marker";
      log(`corner ${alignPairs.length}: scene point set — now click the matching red footprint marker.`);
    } else {
      const m = pickFootprintMarker(ev);
      if (!m) { log("click a red footprint marker", "warn"); return; }
      const last = alignPairs[alignPairs.length - 1];
      last.fp = [m.position.x, m.position.z];
      addMarker(new THREE.Vector3(m.position.x, 0.05, m.position.z), 0xffd166, 0.13);
      awaiting = "scene";
      log(`corner ${alignPairs.length}: paired with footprint vertex #${m.userData.footprintIndex}.`);
      if (alignPairs.length >= 3) { log("3 pairs collected — press Solve alignment.", "ok"); setMode("orbit"); }
    }
  }
});

// ------------------------------------------------------------------ scale + align actions
function spanLengthMeters() {
  const v = parseFloat(document.getElementById("spanLen").value);
  if (!(v > 0)) { log("enter the span's real length first", "warn"); return null; }
  return document.getElementById("spanUnit").value === "ft" ? v * 0.3048 : v;
}

// ACCEPT THE CAPTURE'S OWN SCALE. Marking the step done without a measurement is
// a decision, and it is recorded as one: `scale_source` says "capture" rather
// than "measured", so nothing downstream can mistake an accepted number for a
// checked one. The distinction matters the way north's does — except far less,
// because a LiDAR capture really is in metres to about a percent, whereas an
// unset north is off by whatever angle the scanner happened to be facing.
document.getElementById("btnAcceptScale")?.addEventListener("click", () => {
  calib.scaleAccepted = true;
  calib.scaleSource = "capture";
  applyCalib();                        // autosaves
  renderSetupPath();
  renderScaleState();
  log("using the capture's own scale — measure a taped span when you want it "
    + "checked, it is usually right to about a percent", "ok");
});

/** What the scale IS right now, and where the number came from. */
function renderScaleState() {
  const el = document.getElementById("scaleNow");
  if (!el) return;
  const measured = (calib.spans ?? []).length > 0;
  const factor = Number(calib.scale) || 1;
  el.textContent = measured
    ? `measured — ×${factor.toFixed(4)} against the capture`
    : calib.scaleAccepted
      ? `the capture's own scale, accepted — not checked against anything`
      : `the capture's own scale — not accepted or checked yet`;
  el.className = "hint" + (measured ? "" : " dim");
  const btn = document.getElementById("btnAcceptScale");
  if (btn) btn.hidden = measured || !!calib.scaleAccepted;
}

document.getElementById("btnApplyScale").onclick = () => {
  if (spanPts.length !== 2) { log("pick a span first (2 points)", "warn"); return; }
  const L = spanLengthMeters();
  if (!L) return;
  const d = spanPts[0].distanceTo(spanPts[1]);
  const f = L / d;
  calib.scale *= f;
  applyCalib();
  calib.spans.push({ kind: "lock", sceneDist: d, lenM: L });
  log(`scale set: ×${f.toFixed(4)} (total ${calib.scale.toFixed(4)}). Re-pick the SECOND taped span and check it there.`, "ok");
  spanPts = []; clearMarkers();
  refreshGroundTruth();
  renderScaleState();
  renderSetupPath();
};

document.getElementById("btnCheckSpan").onclick = () => {
  if (spanPts.length !== 2) { log("pick the check span first (2 points)", "warn"); return; }
  const L = spanLengthMeters();
  if (!L) return;
  const d = spanPts[0].distanceTo(spanPts[1]);   // world units == meters after scale
  const errPct = Math.abs(d - L) / L * 100;
  calib.spans.push({ kind: "check", measuredM: d, lenM: L, errPct });
  log(`residual: measured ${d.toFixed(3)} m vs real ${L.toFixed(3)} m -> ${errPct.toFixed(2)}%  ${errPct < 5 ? "PASS (<5%)" : "FAIL (>=5%)"}`, errPct < 5 ? "ok" : "err");
  spanPts = []; clearMarkers();
};

document.getElementById("btnSolveAlign").onclick = () => {
  const pairs = alignPairs.filter(p => p.fp);
  if (pairs.length < 1) { log("pick at least 1 scene→footprint pair first", "warn"); return; }
  if (pairs.length === 1) {
    // position-only snap: rotation is trusted (from Set north), translate the
    // scene so the clicked corner lands on its footprint post
    const [sx, sz] = pairs[0].scene, [fx, fz] = pairs[0].fp;
    calib.tx += fx - sx;
    calib.tz += fz - sz;
    applyCalib();
    log(`position locked from 1 corner pair (rotation untouched — assumes Set north was done). Check visually that the red outline sits on the house; add 3 pairs for a solved fit with a residual.`, "ok");
    alignPairs = []; awaiting = "scene"; clearMarkers();
    refreshGroundTruth();
    return;
  }
  if (pairs.length === 2) log("solving from 2 pairs — the minimum; a 3rd corner makes the residual check meaningful", "warn");
  // src: scene points in geoGroup-less frame. Our clicked scene points are world coords,
  // which already include current geoGroup transform; solve incrementally.
  const src = pairs.map(p => p.scene), dst = pairs.map(p => p.fp);
  const { s, theta, tx, tz, residuals } = umeyama2d(src, dst, false);
  // The clicked scene points already include the current geoGroup transform, so the
  // solve is an INCREMENT mapping world -> footprint frame: fp = R(theta)·w + t.
  // three.js yaw `a` acts on (x,z) as R(-a), so composing R(theta)·R(-oldYaw)
  // gives newYaw = oldYaw - theta; translation composes as R(theta)·t_old + t.
  const oldYaw = calib.yaw, oldTx = calib.tx, oldTz = calib.tz;
  const incYaw = -theta;
  calib.yaw = oldYaw + incYaw;
  calib.tx = oldTx * Math.cos(theta) - oldTz * Math.sin(theta) + tx;
  calib.tz = oldTx * Math.sin(theta) + oldTz * Math.cos(theta) + tz;
  calib.northSet = true;   // a solved footprint fit orients the scene too
  applyCalib();
  const maxRes = Math.max(...residuals);
  const ft = maxRes / 0.3048;
  log(`alignment solved: yaw ${(incYaw * 180 / Math.PI).toFixed(1)} deg, t (${tx.toFixed(2)}, ${tz.toFixed(2)}) m; max corner residual ${maxRes.toFixed(2)} m (${ft.toFixed(2)} ft) ${ft < 1 ? "PASS (<1 ft)" : "FAIL (>=1 ft)"}`, ft < 1 ? "ok" : "err");
  const chk = umeyama2d(src, dst, true);
  if (Math.abs(chk.s - 1) > 0.01)
    log(`(cross-check: free-scale solve suggests ×${chk.s.toFixed(3)} — re-verify the tape scale)`, "warn");
  alignPairs = [];              // consume pairs: a second Solve must re-collect
  awaiting = "scene";
  clearMarkers();
  refreshGroundTruth();
};

// ------------------------------------------------------------------ data loading
async function fetchJson(url) {
  const r = await fetch(url + "?ts=" + Date.now());
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}
// Which design the viewer is rendering. Normally data/design.json — the owner's
// working file. The design agent's op list is applied only after the run ends,
// so a preview source applies the proposal to a scratch file for `look`.
// This lets the model see its proposal without touching the working design.
let previewSource = null;
const designSource = () => previewSource ?? "/data/design.json";
let lastDesignText = "";
let lastDesignError = "";
let designLoading = false;
let designForcePending = false;
// WHERE A HAND EDIT'S SECONDS GO. Time the op round trip, re-read, asset loading,
// rebuild and first frame separately so the slow stage is measured, not guessed.
// __pedon.editTimings() reads them.
const editTimings = [];
let editOpsMs = null;
async function loadDesign(force = false) {
  if (designLoading) {
    // a forced re-drape (calibration changed) must not be lost to an in-flight
    // poll — it would leave the design draped on the old terrain
    if (force) designForcePending = true;
    return;
  }
  designLoading = true;
  const T = { at: performance.now() };
  const lap = k => { T[k] = +(performance.now() - T.at).toFixed(0); };
  try {
    const design = await fetchJson(designSource());
    lap("fetch");
    const text = JSON.stringify(design);
    if (!force && text === lastDesignText) return;
    lastDesignError = "";
    currentDesign = design;
    // ONE GARDEN IS DRAWN; THE WHOLE DOCUMENT IS KEPT. A design may carry
    // two proposals for one corner, and `currentDesign` has to stay whole —
    // the timeline stores it and restore writes it straight back, so a resolved
    // copy landing there would delete the proposal the user did not choose. Only the
    // BUILD sees one alternative.
    const drawn = activeDesign(design);
    const quality = renderQuality;
    // Fast reduces the photoreal builders with a WebAssembly simplifier; building is
    // synchronous, so it has to be ready first. Loaded once, a few milliseconds after.
    await prepareSimplifier();
    // the builders' textures in BOTH modes — Fast at 256 px, or it draws them dark
    await preparePlantTextures(quality);
    await ensurePlantModels(drawn, quality);
    lap("assets");
    // OUTSIDE the quality guard, deliberately. Fast preview simplifies botanical
    // detail, but a scanned object has no simplified version: the alternative is
    // a PRESET OF SOMETHING ELSE. An uncached model draws as that preset (a generic
    // boulder is 980 triangles); __pedon.probeModel reports the cache state.
    //
    // objectMesh is synchronous, so await the model BEFORE the build or that
    // frame draws the preset.
    await ensureObjectModels(objectModelsNeededBy(drawn));
    lap("objects");
    if (quality !== renderQuality) { designForcePending = true; return; }
    // Unchanged parts are KEPT from the group on screen, so a one-plant move
    // rebuilds only that plant. The salt is everything a part is drawn from
    // besides its own item — render quality and the ground it drapes on.
    const g = await buildDesignGroup(colourFromPalette(drawn), heightAt, growthScale(),
      { quality, reuse: reusableParts(designGroup), reuseSalt: `${quality}|${drapeEpoch}` });
    lap("build");
    // commit the seen-text marker only after the build succeeds, or a design
    // that throws once is never retried by the poll
    lastDesignText = text;
    if (designGroup) { designsGroup.remove(designGroup); disposeObj(designGroup, "mesh"); }
    designGroup = g;
    designsGroup.add(g);
    levelPlants = addPlantLevels(designGroup);
    // the edited design cuts the scan where it is built flat; overlays do not
    setCarveSurfaces(levelFootprints(drawn));
    // buildDesignGroup returns a flat bag of meshes and knows nothing about
    // groups; the hierarchy is re-imposed here, before applyLayers reads it
    regroupScene(designGroup, drawn.groups ?? [], () => new THREE.Group());
    // FIT THE SHADOW CAMERA TO THE PLANTING. A 60 m box costs 10 ms per
    // frame without a visible shadow, because 2048 texels over
    // 60 m is 2.9 cm each and the normal bias that stops a steep slope
    // striping is 3 cm — the sample point goes clean through a 2 cm leaf. A
    // garden-sized design (say 9 m by 29) fitted to the box takes a texel under a
    // centimetre for the same money.
    try { lighting.fitTo?.(new THREE.Box3().setFromObject(designGroup)); } catch { /* never lose the design over the light */ }
    lap("swap");
    applyLayers();
    tlPush(design);
    applySelectionHighlight();
    renderSelection();
    renderProperties();
    renderHandles();
    renderGizmo();
    renderPalette();              // a species the model just planted is now pickable by hand
    // WHERE THE DESIGN CHANGED, not where the tree redraws: renderObjectList
    // runs on every hover, and rebuilding this there would churn the DOM sixty
    // times a second for a control that is usually not even shown.
    renderAlternatives();
    refreshDesignList();          // the live file changed; re-identify what is on screen
    lap("ui");
    T.quality = quality; T.plants = drawn.plants?.length ?? 0; T.force = force;
    if (editOpsMs != null) { T.ops = editOpsMs; editOpsMs = null; }
    // Recorded NOW, not from the frame callback: a hidden tab runs no frames.
    // The first frame after the swap carries the GPU upload, so its timing is
    // filled in when it runs.
    T.hidden = document.hidden;
    editTimings.push(T);
    if (editTimings.length > 20) editTimings.shift();
    requestAnimationFrame(() => requestAnimationFrame(() => lap("frame")));
    // COUNTS OF WHAT IS DRAWN, and it says so when the document holds more. A
    // design carrying two proposals has more geometry in it than in the yard,
    // so numbers under a picture of one proposal must describe that proposal.
    const held = (design.plants?.length ?? 0) - (drawn.plants?.length ?? 0);
    log(`design loaded: ${drawn.beds?.length ?? 0} beds, ${drawn.paths?.length ?? 0} paths, `
      + `${drawn.edges?.length ? `${drawn.edges.length} edges, ` : ""}`
      + `${drawn.plants?.length ?? 0} plants`
      + (held > 0 ? ` (${held} more in the other proposal)` : "")
      // HOW LONG IT TOOK, where the user can see it. A background tab can build
      // the same plants several times slower than an idle visible page, so
      // report the timing and whether the tab is hidden.
      // Quiet for an ordinary edit — those are tens of milliseconds.
      + (T.build - T.objects >= 1000
          ? ` — drawn in ${((T.build - T.objects) / 1000).toFixed(1)} s`
            + (document.hidden ? " (this tab was in the background, which is several times slower)" : "")
          : ""), "ok");
  } catch (e) {
    // no site at all — a fresh install: the first screen, not a red 404 every second
    if (/: 404$/.test(e.message) && welcomeDue({ site: siteOf(), designMissing: true })) firstScreen();
    else if (e.message !== lastDesignError) { log("design.json: " + e.message, "err"); lastDesignError = e.message; }
  } finally {
    designLoading = false;
    if (designForcePending) { designForcePending = false; loadDesign(true); }
  }
}
let siteCache = null;
function redrawSite() {
  if (!siteCache) return;
  if (footprintGroup) { enuGroup.remove(footprintGroup); disposeObj(footprintGroup, "mesh"); }
  footprintGroup = buildFootprintOverlay(siteCache, heightAt);
  enuGroup.add(footprintGroup);
  applyLayers();
  renderLandmarkList();
  drawAreas();
  renderAreaList();
  // Populate both Views lists when site.json loads, including their empty
  // states. Saving a viewpoint or area is not a prerequisite for showing the
  // views already stored on the site.
  renderViewpointList();
  renderShotList();
  renderPhotorealChoices();
  // north may have been set since the page loaded, and the badge is the only
  // thing that says a design is being drawn on an unregistered capture
  if (typeof syncCalibrationBadge === "function") syncCalibrationBadge();
}
async function loadSite(frame = true) {
  try {
    const site = await fetchJson("/data/site.json");
    siteCache = site;
    redrawSite();
    log(`site loaded: zone ${site.usda_zone ?? "?"}, footprint ${site.footprint?.length ?? 0} vertices (red), ${site.landmarks?.length ?? 0} landmarks`, "ok");
    if (frame && site.footprint?.length) {
      // frame the camera on the footprint so the red posts are on screen
      let cx = 0, cz = 0;
      for (const [x, y] of site.footprint) { cx += x / site.footprint.length; cz += -y / site.footprint.length; }
      controls.target.set(cx, 0, cz);
      camera.position.set(cx + 22, 16, cz + 22);
      controls.update();
      log("camera framed on the footprint (numbered red posts). Orbit to find the matching house corners in the scan.");
    }
  } catch (e) {
    // a NEW site has no site file yet, and that is a step on its setup path, not a
    // failure; anything but a missing file is still an error
    // — with no site at all, the first screen is up and says what to do instead
    if (/: 404$/.test(e.message)) { if (siteOf()) log("no site file yet — the setup path in Project settings says what makes one"); }
    else log("site.json: " + e.message, "err");
  }
}

/** The survey and the address lookup, run by the dev server for this site. */
async function runSetupStep(url, body, what, button) {
  if (button) button.disabled = true;
  log(`${what}…`);
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
                                 body: JSON.stringify(body ?? {}) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.ok) { log(`${what} did not finish: ${out.error ?? r.status}`, "err"); return false; }
    log(`${what} — done`, "ok");
    await loadSite(false);
    renderSetupPath();
    renderProject();
    return true;
  } finally { if (button) button.disabled = false; }
}
document.getElementById("btnSurvey")?.addEventListener("click", ev =>
  runSetupStep("/api/setup/survey", {}, "surveying the ground (a minute or two)", ev.currentTarget));
document.getElementById("btnAddress")?.addEventListener("click", ev => {
  const address = document.getElementById("siteAddress").value.trim();
  if (!address) { document.getElementById("siteAddress").focus(); return; }
  runSetupStep("/api/setup/address", { address }, `looking up ${address}`, ev.currentTarget);
});

// ------------------------------------------------------------------ auto-detect
// Geometry finds candidate structures, a vision pass names them, you approve.
const proposalGroup = new THREE.Group();
proposalGroup.name = "proposals";
enuGroup.add(proposalGroup);
let proposals = [];
// Proposal positions are world coordinates captured at detect time. Any change
// that moves the scan inside the design frame (a new stage, ground fit, scale,
// north, alignment) invalidates them — keeping one afterwards would write a
// position that no longer sits on the structure.
let proposalsCapture = -1;
const stageToken = () => calibEpoch;
// A signature that survives a reload (calibEpoch does not): the review list is
// only valid for the same capture under the same calibration.
const calibSignature = () =>
  JSON.stringify([calib.captureUrl, calib.plane, calib.scale, calib.yaw, calib.tx, calib.tz]);

function saveProposals() {
  fetch("/api/save", {
    method: "POST",
    body: JSON.stringify({
      file: "data/detect/proposals.json",
      json: { signature: calibSignature(), proposals },
    }),
  }).catch(() => {});
}

async function restoreProposals() {
  try {
    const saved = await fetchJson("/data/detect/proposals.json");
    if (!saved?.proposals?.length || saved.signature !== calibSignature()) return;
    proposals = saved.proposals;
    proposalsCapture = stageToken();
    drawProposals();
    renderProposalList();
    log(`restored ${proposals.length} candidate(s) still awaiting review`, "ok");
  } catch { /* nothing saved yet */ }
}

// Big high-contrast discs keep ids legible in downscaled naming renders;
// plain labels at ~4 px tall are too small for reliable identification.
function numberLabel(n) {
  const tex = labelTexture("n:" + n, g => {
    g.fillStyle = "#ff8c00";
    g.beginPath(); g.arc(128, 128, 118, 0, Math.PI * 2); g.fill();
    g.lineWidth = 14; g.strokeStyle = "#1a1a1a"; g.stroke();
    g.fillStyle = "#ffffff";
    g.font = "bold 150px system-ui, sans-serif";
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(String(n), 128, 134);
  }, [256, 256]);
  // constant screen size: with distance attenuation the near markers balloon
  // and hide the very structures they point at
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, depthTest: false, sizeAttenuation: false }));
  spr.scale.set(0.045, 0.045, 1);
  return spr;
}

function drawProposals() {
  for (const c of proposalGroup.children) {
    // sprite geometry and label textures are shared — drop only the material
    if (!c.isSprite) c.geometry?.dispose?.();
    c.material?.dispose?.();
  }
  proposalGroup.clear();
  for (const p of proposals) {
    const wx = p.x, wz = -p.y;
    const ground = heightAt(wx, wz);
    // float the marker just above the structure, not proportional to it: a
    // 20-strong set of 8 m spikes over the trees buries the yard
    const base = ground + Math.min(p.height_m, 2.2);
    const col = p.confident === false ? 0xe4b25c : 0xffb020;
    // ring on the ground = the coordinate that gets saved; the stem shows how
    // far above it the marker floats, so the height is never a guess
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.22, 0.34, 24),
      new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide, transparent: true, opacity: 0.95, depthTest: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(wx, ground + 0.02, wz);
    ring.renderOrder = 3;
    ring.userData.proposalId = p.id;
    proposalGroup.add(ring);
    const stemH = Math.max(0.3, base + 0.6 - ground);
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.025, stemH, 6),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.5 }));
    stem.position.set(wx, ground + stemH / 2, wz);
    proposalGroup.add(stem);
    const pin = new THREE.Mesh(
      new THREE.ConeGeometry(0.18, 0.6, 8),
      new THREE.MeshBasicMaterial({ color: col }));
    pin.position.set(wx, base + 0.6, wz);
    pin.rotation.x = Math.PI;                  // point down at the structure
    pin.userData.proposalId = p.id;            // draggable
    proposalGroup.add(pin);
    // before naming show only the number (big, legible from the render camera)
    // — putting the geometry's own guess in the picture would just invite the
    // model to agree with it
    const lbl = p.name ? textLabel(`${p.id}. ${p.name}`, "proposal") : numberLabel(p.id);
    lbl.position.set(wx, base + 1.15, wz);
    proposalGroup.add(lbl);
  }
}

// ------------------------------------------------------------------ clean renders
// Everything the app draws for its own benefit — the reference grid, the axes,
// the north arrow, the cyan landmark pins, the drawn-area tints — is not part of
function renderViews() {
  const shots = [];
  // drive the camera directly and restore its full orientation: routing this
  // through OrbitControls.update() leaves the camera flipped (labels render
  // upside down afterwards)
  const savedPos = camera.position.clone();
  const savedQuat = camera.quaternion.clone();
  const savedUp = camera.up.clone();
  // frame the detected structures, not the whole capture
  const box = new THREE.Box3();
  for (const p of proposals) box.expandByPoint(new THREE.Vector3(p.x, 0, -p.y));
  if (box.isEmpty()) box.expandByPoint(new THREE.Vector3(0, 0, 0));
  // the box came from ENU proposal coordinates; the camera is placed in WORLD.
  // Without this the naming pass photographs a spot rotated by the yaw about the
  // origin (~5.6 m at 23 deg) and the numbered discs fall out of frame — a marker
  // the model cannot see is a candidate it cannot name.
  const c = enuGroup.localToWorld(box.getCenter(new THREE.Vector3()));
  // 1.1x the diagonal keeps edge candidates inside both oblique views; at 0.7
  // they can fall outside, and an unseen marker cannot be named.
  const r = Math.max(14, box.getSize(new THREE.Vector3()).length() * 1.1);
  // keep the discs: they are the whole subject of the naming pass, and they are
  // furniture to every other render path
  withCleanScene(scene, () => {
    for (const [az, el] of [[0, 0.85], [Math.PI * 0.66, 0.5], [Math.PI * 1.33, 0.5]]) {
      camera.up.set(0, 1, 0);
      camera.position.set(c.x + Math.sin(az) * r * Math.cos(el), r * Math.sin(el) + 4, c.z + Math.cos(az) * r * Math.cos(el));
      camera.lookAt(c);
      camera.updateMatrixWorld(true);
      // HTML labels aren't in the WebGL canvas, so the naming screenshots show
      // exactly the numbered discs and nothing else — which is what we want
      // render twice: Spark sorts splats against the camera used for the PREVIOUS
      // frame, so a single render after a camera jump captures a stale sort
      renderer.render(scene, camera);
      renderer.render(scene, camera);
      // downscale to JPEG: a full-res PNG is ~2 MB and the naming call crawls;
      // ~1400 px reads the markers just as reliably at a tenth the size
      const src = renderer.domElement;
      const k = Math.min(1, 1400 / Math.max(src.width, src.height));
      const c2 = document.createElement("canvas");
      c2.width = Math.round(src.width * k);
      c2.height = Math.round(src.height * k);
      c2.getContext("2d").drawImage(src, 0, 0, c2.width, c2.height);
      shots.push(c2.toDataURL("image/jpeg", 0.82));
    }
  }, { keep: ["proposals"] });
  camera.position.copy(savedPos);
  camera.quaternion.copy(savedQuat);
  camera.up.copy(savedUp);
  camera.updateMatrixWorld(true);
  return shots;
}

let detectBusy = false;
let detectGen = 0;

function clearProposals() {
  proposals = [];
  drawProposals();
  renderProposalList();
}

async function detectAndName() {
  if (!stage || !terrain) { log("load a capture first", "warn"); return; }
  if (detectBusy) { log("already detecting — wait for the current pass to finish", "warn"); return; }
  const gen = ++detectGen;
  detectBusy = true;
  const btn = document.getElementById("btnDetect");
  btn.disabled = true;
  btn.textContent = "Detecting…";
  try {
    await runDetect(gen);
  } finally {
    detectBusy = false;
    btn.disabled = false;
    btn.textContent = "Find walls and structures";
  }
}

async function runDetect(gen) {
  clearProposals();     // never leave the previous run's pins/rows on screen
  stage.updateWorldMatrix(true, false);
  const local = sampleCenters(90000);
  // stage-local -> world -> ENU. The last hop matters: heightAt is an ENU-frame
  // lookup and the proposal x/y we save are read back as ENU, so feeding world
  // coordinates here would measure every structure against the wrong ground and
  // then store it rotated once north is set.
  const enu = new Float32Array(local.length);
  const v = new THREE.Vector3();
  for (let i = 0; i < local.length / 3; i++) {
    v.set(local[i * 3], local[i * 3 + 1], local[i * 3 + 2]).applyMatrix4(stage.matrixWorld);
    enuGroup.worldToLocal(v);
    enu[i * 3] = v.x; enu[i * 3 + 1] = v.y; enu[i * 3 + 2] = v.z;
  }
  proposals = detectStructures(enu, heightAt);
  if (!proposals.length) { log("no structures found above the ground", "warn"); return; }
  proposalsCapture = stageToken();      // pin these to the current stage+calibration
  drawProposals();
  log(`${proposals.length} candidate structures found — asking the model to name them (takes a minute)…`);
  renderProposalList();
  let images;
  try { images = renderViews(); } catch (e) { log("render failed: " + e.message, "err"); return; }
  try {
    const r = await fetch("/api/name-landmarks", {
      method: "POST",
      body: JSON.stringify({ images, candidates: proposals, backend: document.getElementById("nameBackend").value }),
    });
    const j = await r.json();
    if (gen !== detectGen) return;          // a newer run owns the proposals now
    if (!j.ok) { log("naming failed: " + j.error + " — candidates kept, rename them yourself", "err"); return; }
    const byId = new Map((j.landmarks ?? []).map(l => [l.id, l]));
    let skipped = 0;
    for (const p of proposals) {
      const l = byId.get(p.id);
      // a candidate the model skipped keeps its shape name and stays on the
      // list — it is a real detected structure the user can still name
      if (l && l.name) { p.name = l.name; p.confident = l.confident; p.note = l.note; }
      else { p.confident = false; p.note = "not named by the model"; skipped++; }
    }
    drawProposals();
    renderProposalList();
    const sure = proposals.filter(p => p.confident).length;
    log(`named ${proposals.length - skipped} of ${proposals.length} structures (${sure} confident`
      + (skipped ? `, ${skipped} unnamed` : "") + ") — review the list, keep what's right", "ok");
  } catch (e) {
    log("naming failed: " + e.message + " — candidates kept, rename them yourself", "err");
  }
}

// keep several at once; each still goes through addLandmark's validation
async function keepMany(list) {
  if (proposalsCapture !== stageToken()) {
    log("these candidates are stale (the scan moved) — run Detect again", "warn");
    clearProposals();
    return;
  }
  let saved = 0, failed = 0;
  for (const p of [...list]) {
    // ENU despite the name — see the keep-row handler below. addLandmark takes
    // WORLD, so convert, or the point is transformed twice and lands ~5.7 m off
    // the structure it was detected on, on disk.
    const enu = new THREE.Vector3(p.x, 0, -p.y);
    enu.y = heightAt(enu.x, enu.z);
    const world = enuGroup.localToWorld(enu.clone());
    const name = (p.name ?? p.kind).trim().replace(/\s+/g, "_").toLowerCase() || `spot_${p.id}`;
    if (await addLandmark(name, world)) { proposals = proposals.filter(q => q !== p); saved++; }
    else failed++;
  }
  drawProposals(); renderProposalList();
  log(`kept ${saved} landmark(s)${failed ? `, ${failed} failed` : ""}`, failed ? "warn" : "ok");
}

document.getElementById("btnKeepAll").onclick = () => keepMany(proposals);
document.getElementById("btnKeepSure").onclick = () => {
  const sure = proposals.filter(p => p.confident);
  if (!sure.length) { log("none are marked confident — review them individually", "warn"); return; }
  keepMany(sure);
};
document.getElementById("btnDropAll").onclick = () => {
  clearProposals();
  log("candidates discarded (nothing was written to site.json)");
};

function renderProposalList() {
  const box = document.getElementById("proposals");
  box.innerHTML = "";
  document.getElementById("proposalActions").hidden = !proposals.length;
  saveProposals();      // the review list survives a reload
  if (!proposals.length) return;
  for (const p of proposals) {
    const row = document.createElement("div");
    row.className = "prow";
    const input = document.createElement("input");
    input.type = "text";
    input.value = p.name ?? p.kind;
    input.title = p.note ?? p.kind;
    input.style.width = "128px";
    if (p.confident === false) input.style.borderColor = "#e4b25c";
    // keep the typed name on the proposal: any redraw rebuilds these rows from
    // p, so an unsaved edit would otherwise vanish when another row is touched
    input.oninput = () => { p.name = input.value; };
    const keep = document.createElement("button");
    keep.textContent = "keep";
    keep.onclick = async () => {
      if (proposalsCapture !== stageToken()) {
        log("these candidates are stale (the scan moved) — run Detect again", "warn");
        clearProposals();
        return;
      }
      keep.disabled = true;
      // p.x/p.y and heightAt are ENU despite the local variable's name.
      // addLandmark's contract is WORLD, so convert through the frame or it
      // applies the inverse transform twice, writing ~5.7 m of error to site.json.
      const enu = new THREE.Vector3(p.x, 0, -p.y);
      enu.y = heightAt(enu.x, enu.z);
      const world = enuGroup.localToWorld(enu.clone());
      const name = input.value.trim().replace(/\s+/g, "_").toLowerCase() || `spot_${p.id}`;
      if ((siteCache?.landmarks ?? []).some(l => l.name === name))
        log(`replacing the existing landmark "${name}" (Back undoes it)`, "warn");
      const ok = await addLandmark(name, world);
      keep.disabled = false;
      if (!ok) return;                 // save failed — leave the row so it can be retried
      proposals = proposals.filter(q => q !== p);
      drawProposals(); renderProposalList();
    };
    const drop = document.createElement("button");
    drop.textContent = "✕";
    drop.onclick = () => {
      proposals = proposals.filter(q => q !== p);
      drawProposals(); renderProposalList();
    };
    input.onchange = saveProposals;      // persist renames as they are made
    row.append(document.createTextNode(`${p.id}.`), input, keep, drop);
    box.appendChild(row);
  }
}

// ------------------------------------------------------------------ persistence
// site.json has other writers (tools/geodata.py re-runs, a second tab), so the
// viewer must never write back a cached snapshot: re-read immediately before
// saving and touch only the key it owns. Writes are chained so two fast clicks
// can't interleave read-modify-write and lose one.
let siteWriteChain = Promise.resolve();
function updateSite(mutate) {
  const next = siteWriteChain.then(async () => {
    let site;
    try {
      site = await fetchJson("/data/site.json");        // fetchJson cache-busts
    } catch (e) {
      if (!/: 404$/.test(e.message)) {
        log("site.json unreadable — not overwriting it: " + e.message, "err");
        return null;
      }
      site = { version: 1 };                            // genuinely no file yet
    }
    const before = JSON.stringify(site);
    mutate(site);
    // Send only what CHANGED to /api/site, which merges it into the owner half
    // and refuses anything else. /api/save does not enforce that ownership
    // boundary; owner data cannot be regenerated.
    const patch = {};
    for (const k of Object.keys(site))
      if (JSON.stringify(site[k]) !== JSON.stringify(JSON.parse(before)[k])) patch[k] = site[k];
    if (!Object.keys(patch).length) return site;        // nothing to write
    const r = await fetch("/api/site", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!r.ok) {
      const why = await r.json().catch(() => ({}));
      log(`site.json not written — ${why.error ?? r.status}`, "err");
      return null;                                      // cache untouched on failure
    }
    siteCache = site;
    redrawSite();
    return site;
  });
  siteWriteChain = next.catch(() => {});
  return next;
}

// Landmark = named ground-truth spot in ENU meters, saved into site.json so the
// design agent can anchor to real structures instead of guessing positions.
// returns true only when site.json actually took the landmark
async function addLandmark(name, p) {
  if (!(Math.abs(p.x) <= 120 && Math.abs(p.z) <= 120)) {
    log(`landmark "${name}" rejected: ${p.x.toFixed(0)}, ${(-p.z).toFixed(0)} m is outside the scanned site — re-aim at the ground`, "err");
    return false;
  }
  let saved = name;
  // OUT HERE, not inside the callback: the confirmation log below reads it.
  // Callback scope would throw a ReferenceError after a successful write.
  const e = worldToEnu(p);
  const site = await updateSite(s => {
    s.landmarks = s.landmarks ?? [];
    if (!saved) {                       // auto-name against the fresh file
      let i = s.landmarks.length + 1;
      while (s.landmarks.some(l => l.name === `spot_${i}`)) i++;
      saved = `spot_${i}`;
    }
    s.landmarks_frame = calib.captureUrl ?? calib.capture ?? null;
    const lm = { name: saved, x: +e[0].toFixed(2), y: +e[1].toFixed(2) };
    // stage-local copy: invariant under later calibration changes, so the pin
    // can be re-projected instead of silently drifting off the structure
    if (stage) {
      stage.updateWorldMatrix(true, false);
      const l = p.clone().applyMatrix4(new THREE.Matrix4().copy(stage.matrixWorld).invert());
      lm.local = [+l.x.toFixed(4), +l.y.toFixed(4), +l.z.toFixed(4)];
    }
    // in place when it already exists: a moved marker is a correction, and a row
    // that jumps to the bottom of Places reads as one deleted and another added
    s.landmarks = upsertLandmark(s.landmarks, lm);
  });
  if (!site) { log("landmark save failed", "err"); return false; }
  tlPush(currentDesign ?? { version: 1 });
  log(`landmark "${saved}" saved at ENU (${e[0].toFixed(1)}, ${e[1].toFixed(1)}) — the agent will use it`, "ok");
  return true;
}

// A coarse height grid the design agent can read: it already knows the yard
// slopes, but not WHERE the level benches and the steep runs are.
function exportTerrain() {
  if (!terrain || !stage) return;
  const CELL = 2;
  const lms = siteCache?.landmarks ?? [];
  const xs = [0], ys = [0];
  for (const l of lms) { xs.push(l.x); ys.push(l.y); }
  for (const p of siteCache?.footprint ?? []) { xs.push(p[0]); ys.push(p[1]); }
  const pad = 8;
  const x0 = Math.floor((Math.min(...xs) - pad) / CELL) * CELL;
  const x1 = Math.ceil((Math.max(...xs) + pad) / CELL) * CELL;
  const y0 = Math.floor((Math.min(...ys) - pad) / CELL) * CELL;
  const y1 = Math.ceil((Math.max(...ys) + pad) / CELL) * CELL;
  const rows = [];
  let lo = Infinity, hi = -Infinity;
  for (let y = y1; y >= y0; y -= CELL) {          // north at the top
    const row = [];
    for (let x = x0; x <= x1; x += CELL) {
      if (!terrain.contains(x, -y)) { row.push(".."); continue; }
      const h = heightAt(x, -y);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
      row.push(h.toFixed(1).padStart(5));
    }
    rows.push(row);
  }
  if (!Number.isFinite(lo)) return;
  fetch("/api/save", {
    method: "POST",
    body: JSON.stringify({
      file: "data/terrain.json",
      json: { cell_m: CELL, x0, x1, y0, y1, min_m: +lo.toFixed(2), max_m: +hi.toFixed(2), rows },
    }),
  }).catch(() => {});
}

async function deleteLandmark(name) {
  const site = await updateSite(s => {
    s.landmarks = (s.landmarks ?? []).filter(l => l.name !== name);
  });
  if (!site) { log(`could not delete "${name}"`, "err"); return; }
  tlPush(currentDesign ?? { version: 1 });
  renderLandmarkList();
  log(`landmark "${name}" deleted`, "ok");
}

/**
 * Rename a drawn area. Areas are OWNER GROUND TRUTH and saved designs scope to
 * them BY NAME, so this goes through `updateSite` — the one write path that
 * merges into the owner half and refuses anything else — and refuses a
 * duplicate rather than silently orphaning whatever pointed at the old name.
 */
async function renameArea(oldName, raw) {
  const name = raw.trim();
  if (!name || name === oldName) { renderAreaList(); return; }
  if ((siteCache?.areas ?? []).some(a => a.name === name)) {
    log(`an area named "${name}" already exists`, "warn");
    renderAreaList();
    return;
  }
  const site = await updateSite(s2 => {
    const t = (s2.areas ?? []).find(a => a.name === oldName);
    if (t) t.name = name;
  });
  if (!site) { log(`could not rename "${oldName}"`, "err"); return; }
  await loadSite(false);
  drawAreas(); renderAreaList();
  log(`renamed "${oldName}" to "${name}" — designs scoped to the old name will not find it`, "warn");
}

async function renameLandmark(oldName, raw) {
  const name = raw.trim().replace(/\s+/g, "_").toLowerCase();
  if (!name || name === oldName) { renderLandmarkList(); return; }
  if ((siteCache?.landmarks ?? []).some(l => l.name === name)) {
    log(`a landmark named "${name}" already exists`, "warn");
    renderLandmarkList();
    return;
  }
  const site = await updateSite(s => {
    const t = (s.landmarks ?? []).find(l => l.name === oldName);
    if (t) t.name = name;
  });
  if (!site) { log(`could not rename "${oldName}"`, "err"); return; }
  log(`renamed "${oldName}" to "${name}"`, "ok");
}

// The saved landmarks, listed where you can actually find them — the pins alone
// are easy to lose against a busy point cloud.
function renderLandmarkList() {
  const box = document.getElementById("lmList");
  const lms = siteCache?.landmarks ?? [];
  document.getElementById("lmCount").textContent = lms.length ? `(${lms.length})` : "(none yet)";
  box.innerHTML = "";
  for (const lm of lms) {
    const row = document.createElement("div");
    row.className = "lrow";
    // Editable so renaming needs no deletion or re-marking. onchange (not
    // oninput) prevents a redraw from eating the user's typing.
    const label = document.createElement("input");
    label.type = "text";
    label.className = "nm";
    label.value = lm.name;
    label.title = `${lm.x}, ${lm.y} m — edit to rename`;
    label.onchange = () => renameLandmark(lm.name, label.value);
    const go = document.createElement("button");
    go.textContent = "show";
    go.title = "fly the camera to this landmark";
    go.onclick = () => {
      const t = new THREE.Vector3(lm.x, heightAt(lm.x, -lm.y), -lm.y);
      controls.target.copy(t);
      camera.position.set(t.x + 9, t.y + 7, t.z + 9);
      controls.update();
      log(`showing "${lm.name}"`);
    };
    // MOVE IT. Dragging the pin works, but a pin is a 16 cm knob in a
    // 40 m scene; the row is where the user is already reading this marker's name.
    const mv = document.createElement("button");
    mv.textContent = "move";
    mv.title = "then click the ground where this marker should be — or drag its pin";
    mv.onclick = () => {
      armedMove = lm.name;             // setMode takes it; set any other way it would be cleared
      setMode("landmark");
      log(`click the ground where "${lm.name}" should be — Esc to leave it where it is`);
    };
    const del = document.createElement("button");
    del.textContent = "✕";
    del.onclick = () => deleteLandmark(lm.name);
    row.append(label, go, mv, del);
    box.appendChild(row);
  }
}

// Re-calibrating the SAME capture moves the scan inside the fixed design
// frame, so each landmark's ENU has to follow the structure it marks — that is
// what lm.local is for.
//
// A DIFFERENT capture is a different local coordinate system entirely: a GLB
// export does not share the PLY's frame, so re-projecting PLY-local points
// through it produces drift (6.7 m measured) that can overwrite good values.
// ENU is the durable truth — it is the design
// frame every other file shares — so on a capture switch we KEEP the ENU and
// re-derive local for the new scan instead.
function reprojectLandmarks() {
  if (!stage || !siteCache?.landmarks?.length) return;
  stage.updateWorldMatrix(true, false);
  const frame = calib.captureUrl ?? calib.capture ?? null;
  const sameCapture = siteCache.landmarks_frame == null || siteCache.landmarks_frame === frame;
  const v = new THREE.Vector3();
  const inv = new THREE.Matrix4().copy(stage.matrixWorld).invert();

  if (!sameCapture) {
    // rebase: ENU stays put, local is recomputed against the new capture.
    // lm.x/lm.y are enuGroup-frame; `inv` undoes a WORLD matrix — so the point
    // has to be lifted into world before it can be pushed into stage-local.
    const rebased = [];
    for (const lm of siteCache.landmarks) {
      v.set(lm.x, heightAt(lm.x, -lm.y), -lm.y);
      enuGroup.localToWorld(v).applyMatrix4(inv);
      rebased.push([lm.name, [+v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4)]]);
    }
    updateSite(s => {
      s.landmarks_frame = frame;
      for (const [name, loc] of rebased) {
        const t = (s.landmarks ?? []).find(l => l.name === name);
        if (t) t.local = loc;
      }
    }).then(ok => ok && log(
      `capture changed — ${rebased.length} landmark(s) kept their positions and were re-based onto this scan`, "ok"));
    return;
  }

  const moved = [];
  let legacy = 0;
  for (const lm of siteCache.landmarks) {
    if (!lm.local) { legacy++; continue; }
    // stage-local -> WORLD -> enuGroup frame. Skipping that last hop is what
    // makes this destructive: stage.matrixWorld carries geoGroup's north yaw,
    // so the world coords get stored as if they were ENU and then the frame
    // rotates them a SECOND time on the next render. It writes to site.json,
    // so the damage is on disk, not just on screen.
    v.fromArray(lm.local).applyMatrix4(stage.matrixWorld);
    enuGroup.worldToLocal(v);
    const nx = +v.x.toFixed(2), ny = +(-v.z).toFixed(2);
    if (Math.hypot(nx - lm.x, ny - lm.y) > 0.05) { moved.push([lm.name, nx, ny]); }
  }
  if (legacy) log(`${legacy} landmark(s) predate calibration tracking — re-mark them`, "warn");
  if (!moved.length) return;
  updateSite(s => {
    s.landmarks_frame = frame;
    for (const [name, nx, ny] of moved) {
      const t = (s.landmarks ?? []).find(l => l.name === name);
      if (t) { t.x = nx; t.y = ny; }
    }
  }).then(ok => ok && log(`${moved.length} landmark(s) re-projected onto the new calibration`, "ok"));
}

// Measured terrain facts for the agent: slope magnitude + downhill compass
// bearing (the ground normal's horizontal component points downhill). Bearing
// is only meaningful once Set north (or footprint alignment) has been done.
function terrainFacts() {
  if (!calib.groundNormal || !(calib.slopeDeg > 1)) return null;
  const facts = { slope_deg: +calib.slopeDeg.toFixed(1) };
  // A bearing is only a compass bearing once the scene is oriented; before
  // that the yaw is arbitrary, and the agent would site retaining walls off a
  // meaningless number.
  if (calib.northSet) {
    const n = new THREE.Vector3(calib.groundNormal.x, calib.groundNormal.y, calib.groundNormal.z)
      .applyQuaternion(levelGroup.quaternion)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), calib.yaw);
    facts.downhill_azimuth_deg = Math.round(worldBearingOf(n));   // world: east=x, north=-z
  }
  return facts;
}

async function saveCalib() {
  stashCalib(calib.captureUrl ?? calib.capture);   // keep the per-capture copy current
  const body = { file: "data/calibration.json", json: calib };
  const r = await fetch("/api/save", { method: "POST", body: JSON.stringify(body) });
  log(r.ok ? "calibration saved -> data/calibration.json" : "save failed", r.ok ? "ok" : "err");
  const facts = terrainFacts();
  if (!facts) {
    log("no terrain facts to save (ground fit found no measurable slope)", "warn");
    return;
  }
  const site = await updateSite(s => { s.terrain = facts; });
  if (site) {
    log(`terrain facts -> site.json: slope ${facts.slope_deg} deg`
      + (facts.downhill_azimuth_deg !== undefined
        ? `, downhill toward ${facts.downhill_azimuth_deg} deg (compass)`
        : " (downhill bearing needs Set north first)"), "ok");
  }
}
async function tryLoadCalib() {
  try {
    const c = await fetchJson("/data/calibration.json");
    Object.assign(calib, c);
    // yaw only becomes non-zero through Set north or a solved alignment, so a
    // restored calibration from before northSet existed is already oriented
    if (calib.northSet === undefined && Math.abs(calib.yaw) > 1e-9) calib.northSet = true;
    restoringCalib = true;
    try { applyCalib(); } finally { restoringCalib = false; }
    log("calibration.json restored", "ok");
  } catch { /* first run */ }
}

// ------------------------------------------------------------------ UI wiring
document.getElementById("splatFile").addEventListener("change", async ev => {
  const f = ev.target.files?.[0];
  if (!f) return;
  // KEPT, not just shown: a hand-picked File has no persistent path. Copy it into
  // the site's own captures/ and open it from there so it reopens next session.
  log(`copying ${f.name} into this site's captures…`);
  let kept = null;
  try {
    const r = await fetch(`/api/captures?name=${encodeURIComponent(f.name)}`, { method: "POST", body: f });
    const out = await r.json().catch(() => ({}));
    if (r.ok && out.ok) kept = out.url;
    else log(`could not keep ${f.name} (${out.error ?? r.status}) — showing it, but it will not reopen next time`, "warn");
  } catch (e) { log(`could not keep ${f.name} (${e.message}) — showing it, but it will not reopen next time`, "warn"); }
  if (kept) { await refreshCaptures(kept); log(`loading ${f.name}…`); await loadStage(kept); }
  else { log(`loading ${f.name}…`); await loadStage(f); }
});
document.getElementById("btnDemo").onclick = async () => {
  log("loading demo splat (sparkjs.dev butterfly)…");
  await loadStage("https://sparkjs.dev/assets/splats/butterfly.spz");
};
document.getElementById("btnLevel").onclick = () => {
  try { fitGround(); refreshGroundTruth(); } catch (e) { log(e.message, "err"); }
};
document.getElementById("btnSpan").onclick = () => setMode(mode === "span" ? "orbit" : "span");
document.getElementById("btnNorth").onclick = () => setMode(mode === "north" ? "orbit" : "north");
document.getElementById("btnMark").onclick = () => setMode(mode === "landmark" ? "orbit" : "landmark");
document.getElementById("btnDetect").onclick = () => detectAndName();

// ------------------------------------------------------------------ camera
// Framing and keyboard control — the things that make a 3D view navigable
// rather than something you fight.
function boundsOf(objects) {
  const box = new THREE.Box3();
  for (const o of objects) if (o) box.expandByObject(o);
  return box.isEmpty() ? null : box;
}

function frameBox(box, pad = 1.5) {
  if (!box) return;
  const c = box.getCenter(new THREE.Vector3());
  const r = Math.max(2, box.getSize(new THREE.Vector3()).length() / 2) * pad;
  const dir = camera.position.clone().sub(controls.target).normalize();
  if (!Number.isFinite(dir.x) || dir.lengthSq() < 1e-6) dir.set(0.6, 0.55, 0.6).normalize();
  controls.target.copy(c);
  camera.position.copy(c).addScaledVector(dir, r / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * 0.6 + r);
  controls.update();
}

function frameSelection() {
  const objs = [];
  designGroup?.traverse(o => {
    let owner = o;
    while (owner && owner.userData.id === undefined) owner = owner.parent;
    if (owner && selection.has(owner.userData.id) && (o.isMesh || o.isPoints)) objs.push(o);
  });
  if (!objs.length) { frameAll(); return; }
  frameBox(boundsOf(objs), 2.2);
  log(`framed ${selection.size} selected object(s)`);
}

/**
 * THE YARD, which is not the same thing as the capture.
 *
 * A scan can extend far beyond the design: a capture reaching across
 * neighbouring ground can be several times the size of the garden inside it.
 * Framing that scan pulls the camera far back and spends most of the
 * picture outside the site.
 *
 * The site is what the OWNER claims: the design, drawn regions and marked
 * points. All three are owner ground truth; the scan's extent depends only on
 * what the scanner can see.
 *
 * A property with nothing on it yet falls back to the scan, because on a fresh
 * capture the scan IS all there is to look at.
 */
function yardBounds() {
  const owned = boundsOf([
    designGroup?.children?.length ? designGroup : null,
    areaGroup?.children?.length ? areaGroup : null,
    markers?.children?.length ? markers : null,
  ]);
  return owned ?? boundsOf([stage]);
}

function frameAll() {
  const box = yardBounds();
  if (!box) { log("nothing to frame yet", "warn"); return; }
  frameBox(box);
}

function topView() {
  const box = yardBounds();
  if (!box) return;
  const c = box.getCenter(new THREE.Vector3());
  const r = Math.max(6, box.getSize(new THREE.Vector3()).length() / 2);
  camera.up.set(0, 1, 0);
  controls.target.copy(c);
  camera.position.set(c.x, c.y + r * 1.9, c.z + 0.001);   // epsilon avoids a degenerate up vector
  controls.update();
  log("top view");
}

document.getElementById("btnFrameAll").onclick = frameAll;
document.getElementById("btnFrameSel").onclick = frameSelection;
/**
 * The standard views.
 *
 * Presets make repeated views from the north or across the slope readily
 * available without orbiting there by hand.
 *
 * Every preset frames the design's OWN BOUNDS rather than a fixed position: a
 * design can sit fifteen metres off the origin, so a hardcoded camera
 * would look at empty ground.
 */
function setView(which) {
  const box = yardBounds();
  if (!box) { log("nothing loaded to look at", "warn"); return; }
  const c = box.getCenter(new THREE.Vector3());
  const r = Math.max(6, box.getSize(new THREE.Vector3()).length() / 2);
  const dir = {                       // world space: ENU +y is world -z
    top:   [0, 1.9, 0.001],
    front: [0, 0.28, 1.9],            // looking north, from the south
    side:  [1.9, 0.28, 0],            // looking west, a section across the site
    iso:   [1.25, 0.95, 1.25],
  }[which] ?? [1.25, 0.95, 1.25];
  camera.up.set(0, 1, 0);
  controls.target.copy(c);
  camera.position.set(c.x + dir[0] * r, c.y + dir[1] * r, c.z + dir[2] * r);
  controls.update();
  log(`${which} view`);
}

for (const which of ["top", "front", "side", "iso"]) {
  const b = document.getElementById("view" + which[0].toUpperCase() + which.slice(1));
  if (b) b.onclick = () => setView(which);
}

document.getElementById("btnTopView").onclick = topView;

addEventListener("keydown", ev => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "")) return;
  const k = ev.key.toLowerCase();
  if (k === "f") { ev.preventDefault(); selection.size ? frameSelection() : frameAll(); }
  else if (k === "escape") {
    // the overlay is modal, so it gets Escape first; settings next, because a
    // window you opened is what Escape is expected to shut
    if (fly.on) setFly(false);
    else if (assetWindowOpen()) showAssets(false);
    else if (mode === "measure") clearMeasure();
    else if (document.getElementById("walkOverlay")?.hasAttribute("open")) closeWalk();
    else if (!document.getElementById("settings").hidden) showSettings(false);
    else setSelection([]);
  }
  else if ((k === "delete" || k === "backspace") && selection.size) {
    ev.preventDefault();
    document.getElementById("btnSelDelete").click();
  }
});

// (#shellStore is never rendered, so there is nothing to collapse. Clear the
//  obsolete `yt.sec.*` keys so a stale surface preference cannot be reused.)
try {
  for (const k of Object.keys(localStorage))
    if (k.startsWith("yt.sec.")) localStorage.removeItem(k);
} catch { /* storage blocked */ }

// Project settings: the one-time calibration for a property (level, north,
// scale, footprint, which capture) off the surface used every day. It is a
// second window rather than a modal because Set north, Click span and Corner
// pairs are all "press this, then click the ground", so the scene has to stay
// live underneath while it is open.
/**
 * Draw the setup path, and say out loud when the property is not calibrated.
 *
 * Read calibration from the actual frame state. `siteCache.registration`
 * does not exist in site.json, so it cannot distinguish an unset north from a
 * calibrated site. A warning that is always on hides real calibration faults.
 */
function currentSetup() {
  return setupSteps({ calib, site: siteCache });
}

/**
 * The project: what it is called, what it is made of, and where it lives.
 *
 * A project is the data for ONE property. List its parts and paths so the user
 * can find each file and see what it contains.
 *
 * Every part, including calibration, saves when it changes. Calibration must
 * persist because designs depend on it for their coordinates to remain valid.
 */
let projectInfo = null;
async function renderProject() {
  const parts = document.getElementById("projParts");
  if (!parts) return;
  try { projectInfo = await (await fetch("/api/project", { cache: "no-store" })).json(); }
  catch { projectInfo = null; }
  if (!projectInfo?.ok) { parts.innerHTML = ""; return; }
  const nameEl = document.getElementById("projName");
  if (nameEl && document.activeElement !== nameEl)
    nameEl.value = projectInfo.named ? projectInfo.name : "";
  if (nameEl) nameEl.placeholder = projectInfo.address || "name this site";
  topBar?.setSite(projectInfo.project ? projectInfo.name : null);
  renderProjectSwitch();

  const where = document.getElementById("projWhere");
  if (where) where.textContent =
    `Everything below is on disk under ${projectInfo.folder}/ — it saves itself as you work, there is nothing to press.`;

  parts.innerHTML = "";
  for (const p of projectInfo.parts) {
    const row = document.createElement("div");
    row.className = "proj-part" + (p.exists ? "" : " missing");
    const what = document.createElement("b"); what.textContent = p.what;
    const size = document.createElement("span");
    size.className = "meta";
    size.textContent = !p.exists ? "not yet"
      : p.items !== undefined ? `${p.items} file${p.items === 1 ? "" : "s"}`
      : p.bytes > 1e6 ? `${(p.bytes / 1e6).toFixed(1)} MB`
      : `${Math.max(1, Math.round(p.bytes / 1024))} KB`;
    const why = document.createElement("span");
    why.className = "hint"; why.textContent = p.why;
    const at = document.createElement("code"); at.textContent = p.path;
    row.append(what, size, why, at);
    parts.appendChild(row);
  }
  const how = document.getElementById("newProjectHow");
  if (how) how.textContent =
    "Every site is its own project — its scan, its ground truth, its designs — started "
    + "with New project at the top of this window and opened from the list there. "
    + "Only the plant catalogue and the model library are shared: a landmark or a drawn "
    + "area belongs to one site.";
}

/**
 * PROJECTS. List existing sites and offer New project to create an empty site
 * and open its setup path. A switch reloads the page: the scan, calibration,
 * design and saved list all belong to that site. A complete reload prevents
 * state from different sites being mixed.
 */
async function renderProjectSwitch() {
  const row = document.getElementById("projSwitchRow"), sel = document.getElementById("projSwitch");
  if (!row || !sel) return;
  let list = null;
  try { list = await (await fetch("/api/projects", { cache: "no-store" })).json(); } catch { /* answered below */ }
  const projects = list?.ok ? list.projects : [];
  row.hidden = projects.length < 2;
  sel.innerHTML = "";
  for (const p of projects) {
    const o = document.createElement("option");
    o.value = p.slug; o.textContent = p.name; o.selected = p.slug === list.active;
    sel.appendChild(o);
  }
}

/** The first screen: the demo garden, or a site of the owner's own (shell/welcome.js). */
function firstScreen() {
  const go = async (body, what) => {
    const out = await projectRequest(body, what);
    if (out) location.reload();
    return !!out;
  };
  showWelcome({ onDemo: () => go({ action: "demo" }, "could not open the demo garden"),
                onNew: name => go({ action: "new", name }, "could not start the site") });
}

async function projectRequest(body, what) {
  const r = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" },
                                           body: JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok || !out.ok) { log(`${what}: ${out.error ?? r.status}`, "err"); return null; }
  return out;
}

document.getElementById("projSwitch")?.addEventListener("change", async ev => {
  if (await projectRequest({ action: "open", slug: ev.target.value }, "could not open that site"))
    location.reload();
});
document.getElementById("btnProjNew")?.addEventListener("click", () => {
  const form = document.getElementById("projNewForm");
  form.hidden = !form.hidden;
  if (!form.hidden) document.getElementById("projNewName").focus();
});
async function createProject() {
  const name = document.getElementById("projNewName").value.trim();
  if (!name) { document.getElementById("projNewName").focus(); return; }
  const out = await projectRequest({ action: "new", name }, "could not start the project");
  if (out) { log(`started "${name}" — loading its setup`, "ok"); location.reload(); }
}
document.getElementById("btnProjCreate")?.addEventListener("click", createProject);
document.getElementById("btnProjDemo")?.addEventListener("click", async () => {
  if (await projectRequest({ action: "demo" }, "could not open the demo garden")) location.reload();
});
document.getElementById("projNewName")?.addEventListener("keydown", ev => { if (ev.key === "Enter") createProject(); });

/**
 * MERGE onto what is on disk, never write a snapshot over it.
 *
 * Writing `{name, named_on}` as the whole file would reset other fields, such
 * as units. Merge changes so renaming preserves them, using the same rule as
 * updateDesign() and updateSite().
 */
async function updateProject(patch, what) {
  let onDisk = {};
  try { onDisk = await fetchJson("/data/project.json"); }
  catch (e) { if (!/: 404$/.test(e.message)) { log(`${what}: project.json unreadable — not overwriting it`, "err"); return null; } }
  const next = { ...onDisk, ...patch };
  const r = await fetch("/api/save", { method: "POST",
    body: JSON.stringify({ file: "data/project.json", json: next }) });
  if (!r.ok) { log(`could not save the ${what}`, "err"); return null; }
  return next;
}

document.getElementById("projName")?.addEventListener("change", async ev => {
  const name = ev.target.value.trim();
  if (!await updateProject({ name, named_on: new Date().toISOString().slice(0, 10) },
                           "project name")) return;
  log(name ? `this site is "${name}" now` : "project name cleared", "ok");
  renderProject();
});

// SIZES ON SCREEN. Metres remain the only thing stored or checked; this
// is the last step before a number becomes text, and it belongs to the PROPERTY
// rather than to this browser — a quote, a delivery and a neighbour all read the
// same yard.
document.getElementById("projUnits")?.addEventListener("change", async ev => {
  const want = ev.target.value;
  setUnits(want);
  if (!await updateProject({ units: want }, "unit setting")) return;
  log(want === "imperial" ? "sizes shown in feet and inches" : "sizes shown in metres", "ok");
  renderObjectList();
  renderProperties();
  refreshDesignList();
});

// What THIS site asks of its planting (project.json "policy"): e.g. cats_have_access, which
// excludes plants known toxic to them. The site's, not the library's; none until stated.
let projectPolicy = {};

/** What the property says its sizes should look like — metric until told — and its policy. */
async function restoreUnits() {
  let doc = null;
  try { doc = await fetchJson("/data/project.json"); } catch { /* no project.json yet */ }
  projectPolicy = doc?.policy ?? {};
  const want = setUnits(doc?.units);
  const sel = document.getElementById("projUnits");
  if (sel) sel.value = want;
  return want;
}
restoreUnits();

function renderSetupPath() {
  const box = document.getElementById("setupPath");
  if (!box) return;
  renderScaleState();
  const steps = currentSetup();
  const { done, total } = setupProgress(steps);
  box.innerHTML = "";
  const head = document.createElement("div");
  head.className = "row subhead";
  head.innerHTML = `<span>Setting up this site <span class="hint">${done} of ${total}</span></span>`;
  box.appendChild(head);
  for (const st of steps) {
    const row = document.createElement("div");
    row.className = `setup-step ${st.state}` + (st.blocking ? " blocking" : "");
    const mark = document.createElement("span");
    mark.className = "setup-mark";
    mark.textContent = st.done ? "✓" : st.state === "next" ? "→" : "·";
    const text = document.createElement("span");
    text.className = "setup-text";
    text.innerHTML = `<b>${st.title}</b><span class="hint">${st.why}</span>`;
    row.append(mark, text);
    // the step's own control, so the path is the way IN rather than a legend
    if (!st.done && st.action) {
      const go = document.createElement("button");
      go.className = "setup-go"; go.textContent = "Do it";
      go.onclick = () => {
        const el = document.getElementById(st.action);
        el?.scrollIntoView({ block: "center", behavior: "smooth" });
        if (el?.tagName === "BUTTON") el.click(); else el?.focus();
      };
      row.appendChild(go);
    }
    box.appendChild(row);
  }
  syncCalibrationBadge();
}

/** The top bar carries it, because a warning inside a menu is not a warning. */
function syncCalibrationBadge() {
  const warn = calibrationWarning(currentSetup());
  topBar?.setWarning?.(warn && {
    text: warn.short, title: warn.long,
    onClick: () => { showSettings(true); },
  });
}

function showSettings(on) {
  if (on) { renderSetupPath(); renderProject(); }
  document.getElementById("settings").hidden = !on;
  document.getElementById("btnSettings").classList.toggle("active", on);
  // closing it hides the button that says which mode you are in, and the next
  // click on the yard would still be consumed by that mode
  if (!on && ["north", "span", "align"].includes(mode)) setMode("orbit");
}
document.getElementById("btnSettings").onclick = () =>
  showSettings(document.getElementById("settings").hidden);
document.getElementById("btnSettingsClose").onclick = () => showSettings(false);

// SAVED / HISTORY on the Designs surface. The archive's /api/history endpoint
// needs a visible entry so the user can find and restore earlier versions.
document.getElementById("btnSrcSaved").onclick = () => setDesignSource("saved");
document.getElementById("btnSrcHistory").onclick = () => setDesignSource("history");

// ------------------------------------------------------------------ selection
// Click things in the scene and talk about "these" instead of naming ids in
// prose. The selection is passed to the agent as the scope of the request.
const selection = new Set();

function objectsFor(id) {
  const out = [];
  designGroup?.traverse(o => { if (o.userData.id === id) out.push(o); });
  return out;
}

function applySelectionHighlight() {
  if (!designGroup) return;
  // hovering a group header lights everything in it, so you can see what the
  // one row you are about to click actually covers
  const idx = hoverGroup ? groupIndex(designGroups()) : null;
  designGroup.traverse(o => {
    if (!o.material || o.isSprite) return;
    // the walk stops at the OWNING OBJECT: a group node carries groupId and no
    // id, so the extra level regroupScene inserts is passed straight through
    let owner = o;
    while (owner && owner.userData.id === undefined) owner = owner.parent;
    const id = owner?.userData.id;
    const on = id !== undefined
      && (selection.has(id) || id === hoverId || idx?.get(id)?.id === hoverGroup);
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m.emissive) continue;
      if (on) {
        if (m.userData.__prevEmissive === undefined) m.userData.__prevEmissive = m.emissive.getHex();
        m.emissive.setHex(selection.has(id) ? 0x2a6ea8 : 0x145070);   // dimmer for hover
        m.emissiveIntensity = 1;
      } else if (m.userData.__prevEmissive !== undefined) {
        m.emissive.setHex(m.userData.__prevEmissive);
        delete m.userData.__prevEmissive;
      }
    }
  });
}

// One-line human summary per object, so the list reads as "path · 1.2 m
// flagstone" rather than a wall of near-identical ids.
let currentDesign = null;
let hoverId = null;
let hoverGroup = null;      // a hovered group header lights all of its members

// Real quantities, not just field echoes — a design tool should tell you how
// long the path is and how big the bed is, because that is what you buy.
// polyLen and the row vocabulary live in shell/rowtext.js, because the review
// sheet builds the same rows and a second copy can drift from the app.


export function measure(o, kind) {
  if (kind === "path") {
    const L = polyLen(o.spline);
    return { len: L, area: L * o.width_m,
      text: `${fmtLen(L)} · ${fmtLen(o.width_m, 2)} wide · ${fmtArea(L * o.width_m)}` };
  }
  if (kind === "edge") {
    const L = polyLen(o.spline);
    return { len: L, text: `${fmtLen(L)} run · ${fmtLen(o.height_m, 2)} high` };
  }
  if (kind === "bed" || kind === "patio") {
    const A = polygonArea(o.polygon ?? []);
    return { area: A, text: `${fmtArea(A)} · ${fmtLen(polyLen([...(o.polygon ?? []), (o.polygon ?? [])[0]]))} edge` };
  }
  if (kind === "plant") {
    return { text: `${plantSize(o.mature_spread_m) || "?"} spread · ${plantSize(o.mature_height_m) || "?"} tall` };
  }
  if (kind === "steps") {
    const L = polyLen(o.spline);
    return { len: L, text: `${fmtLen(L)} run · ${fmtSmall(o.riser_m)} risers · ${fmtSmall(o.going_m)} going` };
  }
  return { text: "" };
}

/** Every object in a design as a row. Defaults to the one on screen; carrying
 *  grouping across a switch needs to ask the same question of the
 *  document being opened, which is not `currentDesign` yet. */
function designObjects(design = currentDesign) {
  const out = [];
  for (const [key, kind] of DESIGN_KINDS) {
    for (const o of design?.[key] ?? []) out.push(rowOf(o, kind));
  }
  return out;
}

// ------------------------------------------------------------------ groups
// A design is a hierarchy, not dozens of flat rows. "The fire pit terrace and its two
// retaining walls" is one thing to the owner and should hide, lock and move as
// one, so it gets one node in the scene graph and one foldable row in the list.
//
// Groups live in design.json as `groups: [{id, name, members:[objectId]}]`.
// That is deliberate: they are a fact about the design, they travel with a
// saved variant, and agent.py's ops mutate the loaded dict in place so an
// unknown top-level key survives a round trip. Which groups are FOLDED or
// HIDDEN is not a fact about the design — that is this browser looking at it,
// so it lives in localStorage exactly like the panel's collapsed sections.
//
// The block below is pure — no DOM, no THREE, no closure over module state —
// because tests/js/ui_groups.test.mjs extracts it between the two markers and
// runs it. Everything that renders, picks or hides reads through it rather than
// re-deriving membership; one owner keeps every caller's answer consistent.
// ── GROUP-MODEL-START ──
/**
 * objectId -> its group. First group wins.
 *
 * An id claimed by two groups would be re-parented twice in the scene graph and
 * disappear from the first group's node, which reads as "an object vanished"
 * with a cause nobody would find. One owner, decided in one place.
 */
function groupIndex(groups) {
  const m = new Map();
  for (const g of groups ?? []) {
    for (const id of g.members ?? []) if (!m.has(id)) m.set(id, g);
  }
  return m;
}

/**
 * The object list as a hierarchy: {rows} is one entry per group with its
 * resolved members, {loose} is everything belonging to no group.
 *
 * Membership naming an id the design no longer has is dropped rather than
 * rendered — remove_objects deletes from beds/paths/... and knows nothing about
 * groups, so a dangling id is the normal state after a delete.
 */
function groupTree(groups, objs) {
  const idx = groupIndex(groups);
  const byId = new Map((objs ?? []).map(o => [o.id, o]));
  const claimed = new Set();
  const rows = [];
  for (const g of groups ?? []) {
    const members = [];
    for (const id of g.members ?? []) {
      const o = byId.get(id);
      if (!o || claimed.has(id) || idx.get(id) !== g) continue;
      claimed.add(id);
      members.push(o);
    }
    rows.push({ type: "group", group: g, members });
  }
  return { rows, loose: (objs ?? []).filter(o => !claimed.has(o.id)) };
}

/** Ids the owner has locked: not pickable, not selectable, so not deletable. */
function lockedIds(groups) {
  const out = new Set();
  for (const g of groups ?? []) {
    if (g.locked) for (const id of g.members ?? []) out.add(id);
  }
  return out;
}

/**
 * Which of these ids a selection may actually hold.
 *
 * The rule lives here rather than inline in setSelection because it is a
 * DECISION — "locked means it cannot be deleted" is only true if every route
 * into the selection asks the same question. Keeping it pure permits direct
 * behavioural checks; inspecting a DOM function's source cannot prove it works.
 */
function selectableIds(ids, groups) {
  const locked = lockedIds(groups);
  return [...ids].filter(id => !locked.has(id));
}

/**
 * Fold designGroup's flat children into one node per group, and return them.
 *
 * `makeNode` builds an empty container (THREE.Group here, a plain object in the
 * test); the function only uses add/remove/children/userData, which is the whole
 * of three.js's parenting contract. A group node carries no userData.id, so the
 * "walk up to the owning object" in applySelectionHighlight and
 * pickDesignObject passes straight through it.
 *
 * Idempotent: existing group nodes are flattened back to the root first. The
 * design is rebuilt on every poll, so a regroup that nested group inside group
 * would compound about once a second.
 */
function regroupScene(root, groups, makeNode) {
  if (!root) return [];
  const list = groups ?? [];
  if (!list.length && !root.children.some(c => c.userData?.groupId !== undefined)) return [];
  const flat = [];
  // A GROUP NODE IS DESTROYED AND REMADE HERE, so its visibility must survive
  // the swap. renderObjectList's ground badge runs withFlatDesign each render,
  // and regroup creates a fresh THREE.Group with visible = true by default.
  // Carrying visibility HERE keeps hidden groups hidden for all three callers:
  // the poll, saveGroups and withFlatDesign.
  const wasVisible = new Map();
  for (const c of [...root.children]) {
    if (c.userData?.groupId !== undefined) {
      wasVisible.set(c.userData.groupId, c.visible);
      for (const m of [...c.children]) flat.push(m);
      root.remove(c);
    } else flat.push(c);
  }
  const nodes = new Map();
  for (const g of list) {
    const n = makeNode();
    n.name = `group:${g.id}`;
    n.userData.groupId = g.id;
    if (wasVisible.has(g.id)) n.visible = wasVisible.get(g.id);
    nodes.set(g.id, n);
    root.add(n);
  }
  const idx = groupIndex(list);
  for (const o of flat) {
    const g = idx.get(o.userData?.id);
    (g && nodes.get(g.id) ? nodes.get(g.id) : root).add(o);   // add() re-parents
  }
  return [...nodes.values()];
}

/**
 * The id a click on this object should yield, or null if it must not be picked.
 *
 * Hidden as well as locked, because three.js's raycaster does NOT skip
 * invisible objects — r185's Raycaster.intersect tests object.layers and never
 * looks at object.visible. So a hidden group node stays fully clickable and you
 * would select something you cannot see. pickDesignObject already checks
 * designGroup.visible by hand for that reason; this is the same check one level
 * down, where the group nodes live.
 */
function pickableId(id, groups, hidden, hiddenObjects = new Set()) {
  if (id === null || id === undefined) return null;
  // the same reason as the group case in the comment above: the raycaster does
  // not skip invisible objects, so without this you can select, drag and delete
  // something you cannot see
  if (hiddenObjects.has(id)) return null;
  const g = groupIndex(groups).get(id);
  if (!g) return id;
  return g.locked || hidden.has(g.id) ? null : id;
}

/**
 * WHAT A CLICK ON `id` SELECTS — the whole group it belongs to, or just it.
 *
 * A grouped object selects the whole group so the gizmo moves all members by
 * the same distance. `inside` (alt/option held) reaches the individual member
 * so the user can adjust it without destroying the group. Shift and cmd add
 * to the selection, which is why reaching inside uses alt.
 *
 * Returns a LIST, because "what this click selects" is a set of ids whether or
 * not a group is involved; the caller should not have to branch on grouping.
 */
function clickSelects(id, groups, { inside = false } = {}) {
  if (id === null || id === undefined) return [];
  const g = groupIndex(groups).get(id);
  if (!g || inside) return [id];
  // a member listed in the group but no longer in the design is normal after a
  // delete (groupTree says so); selecting a dangling id would put a ghost in
  // the selection, so the caller filters — here we only say what the group is
  return [...(g.members ?? [])];
}

/**
 * The group list after `g` is added, without mutating the one passed in.
 *
 * An object belongs to one group, so the ids moving into `g` leave whatever
 * held them; a group emptied by that move disappears rather than lingering as
 * a row with nothing in it. Returned as a new list because saveGroups compares
 * it against the design it is replacing.
 */
function withNewGroup(groups, g) {
  const moving = new Set(g.members ?? []);
  const kept = (groups ?? [])
    .map(x => ({ ...x, members: (x.members ?? []).filter(id => !moving.has(id)) }))
    .filter(x => x.members.length);
  return [...kept, g];
}

/**
 * Run `fn` against a temporarily FLAT design group, then put the grouping back.
 *
 * viewport.js resolves the design as getObjectByName("design") and then reads
 * dg.children ONE LEVEL DEEP — floatCheckOp does, and so does the subject
 * lookup behind `look`. A grouped object is a grandchild, so it loses its
 * userData.id at that level and drops out of both measurements. Ground contact
 * must still be checked for grouped objects.
 *
 * A subtree walk in viewport.js would handle groups directly. This adapter
 * instead flattens, measures and regroups at the main.js boundary.
 * regroupScene is idempotent and returns immediately when there are no groups,
 * so this costs nothing on an ungrouped design.
 */
function withFlatDesign(root, groups, makeNode, fn) {
  // Flatten and regroup are two calls, so regroupScene's own carry-over cannot
  // span them: the flatten destroys the nodes and the regroup finds none to
  // copy from. Visibility must span the pair, or the ground badge restores
  // hidden groups every time it runs.
  const wasVisible = new Map();
  for (const c of root?.children ?? [])
    if (c.userData?.groupId !== undefined) wasVisible.set(c.userData.groupId, c.visible);
  regroupScene(root, [], makeNode);
  try { return fn(); } finally {
    for (const n of regroupScene(root, groups, makeNode))
      if (wasVisible.has(n.userData.groupId)) n.visible = wasVisible.get(n.userData.groupId);
  }
}

/**
 * Per-group show/hide. The NODE is what hides — members keep visible=true, or
 * unhiding could not tell "hidden with the group" from "hidden on its own".
 */
function applyGroupVisibility(root, hidden) {
  for (const c of root?.children ?? []) {
    const gid = c.userData?.groupId;
    if (gid !== undefined) c.visible = !hidden.has(gid);
  }
}

/**
 * Per-OBJECT show/hide.
 *
 * A group hides its NODE and leaves its members visible=true, so that unhiding a
 * group can tell "hidden with the group" from "hidden on its own". This is the
 * other half of that split and it must stay independent: it writes only nodes
 * that carry an `id`, so hiding a group and hiding an object inside it are two
 * facts, and turning either back on does not silently turn the other on too.
 *
 * It walks the whole tree rather than root.children, because an object node sits
 * one level deeper once regroupScene has inserted a group node above it.
 */
function applyObjectVisibility(root, hiddenIds) {
  root?.traverse?.(o => {
    const id = o.userData?.id;
    if (id !== undefined) o.visible = !hiddenIds.has(id);
  });
}
// ── GROUP-MODEL-END ──

const designGroups = () => currentDesign?.groups ?? [];

// Folded/hidden is how this browser is LOOKING at the design, not part of it —
// and it belongs to ONE design (shell/viewstate.js). These two maps are the
// CURRENT design's; `switchViewScope` swaps them when the design changes, and every
// write goes through `persistView`, the one place this reaches storage.
const VARIANT_KEY = siteKey("yardtwin.currentVariant", SITE);  // read here first; setCurrentVariant owns it
adoptLegacy(localStorage, "yardtwin.currentVariant", SITE);
const VIEW_KEY = siteKey(VIEW_STORE_KEY, SITE);               // each design's hidden objects and folds, per site
adoptLegacy(localStorage, VIEW_STORE_KEY, SITE);
let viewStore = (() => {
  try { return JSON.parse(localStorage.getItem(VIEW_KEY)) || {}; } catch { return {}; }
})();
let viewScope = (() => {
  try { return viewScopeOf(localStorage.getItem(VARIANT_KEY) || ""); } catch { return viewScopeOf(""); }
})();
let { objects: objectView, groups: groupView } = readViewScope(viewStore, viewScope);
// THE OLD GLOBAL MAPS ARE NOT CARRIED IN: they do not identify their design.
// A wrongly SHOWN object costs one click; a wrongly HIDDEN one makes a design
// look broken. Leave those maps unread and explain the reset once.
const viewStateWasShared = (() => {
  try {
    return !localStorage.getItem(VIEW_KEY)
      && !!(localStorage.getItem("yt.objectview") || localStorage.getItem("yt.groupview"));
  } catch { return false; }
})();
/** THE ONE PLACE the view reaches storage, so writers cannot overwrite each
 *  other's changes to the same key. */
function saveViewStore() {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(viewStore)); } catch { /* storage blocked */ }
}
function persistView() {
  viewStore = writeViewScope(viewStore, viewScope, { objects: objectView, groups: groupView });
  saveViewStore();
}
if (viewStateWasShared) {
  persistView();
  log("hide / show is kept per design now — every design starts with everything shown", "ok");
}
/**
 * The design changed: restore the user's last view of THAT design.
 * `carry` is for Save as… — the new name is the garden already on screen, so what is
 * hidden stays hidden rather than reappearing while the user works.
 */
function switchViewScope(variant, { carry = false } = {}) {
  const next = viewScopeOf(variant);
  if (next === viewScope) return;
  persistView();
  const kept = carry ? { objects: objectView, groups: groupView } : null;
  viewScope = next;
  ({ objects: objectView, groups: groupView } = kept ?? readViewScope(viewStore, viewScope));
  if (kept) persistView();
  soloMemory = null;                 // a solo belongs to the design it was taken in
  try { applyLayers(); renderObjectList(); } catch { /* boot: nothing drawn yet */ }
}
function setGroupView(gid, patch) {
  groupView[gid] = { ...groupView[gid], ...patch };
  persistView();
}
const isFolded = gid => !!groupView[gid]?.folded;
const hiddenGroups = () => new Set(Object.keys(groupView).filter(k => groupView[k]?.hidden));

/** The one write of the view to disk. Solo replaces the whole object map, so this
 *  cannot stay inline in setObjectView without becoming a second copy. */
function persistObjectView() { persistView(); }

function setObjectView(id, patch) {
  objectView[id] = { ...(objectView[id] ?? {}), ...patch };
  if (!objectView[id].hidden) delete objectView[id];      // don't accumulate dead keys
  // remember WHAT it hid: `p27` is a different plant after a replant
  else objectView[id].what = whatIs(rawById(currentDesign, id));
  persistObjectView();
}
/** The ids hidden IN THIS DESIGN. An entry whose id now belongs to something else is
 *  dropped here, once, and said out loud so stale ids cannot hide different objects. */
function hiddenObjectIds() {
  const { hidden, stale } = honoured(objectView, id => rawById(currentDesign, id));
  if (stale.length) {
    for (const id of stale) delete objectView[id];
    persistObjectView();
    log(`${stale.length} hidden object(s) are different things now (${stale.slice(0, 4).join(", ")}`
      + `${stale.length > 4 ? ", …" : ""}) — showing them`, "warn");
  }
  return hidden;
}

/**
 * Write a new group list into the design.
 *
 * Grouping is a re-parenting, not a rebuild, so the scene is updated here and
 * the poll is told the new text has already been seen — otherwise every eye
 * click would rebuild every object, plant models included. tlPush keeps the
 * timeline in step: an undo that restored a pre-group snapshot without it would
 * silently drop the grouping.
 */
/**
 * Make the selection a PROPOSAL, alongside another one for the same spot.
 *
 * An alternative group lets the user compare proposals for one area of the site
 * by showing one while hiding the other.
 *
 * The two halves are written together on purpose — the groups and the choice are
 * one decision, and writing them in two calls would leave a moment where the
 * document declares a set with nothing chosen. Both keys go through
 * `writeDesignDocument`, which merges onto a fresh read, so this is still the one
 * write path.
 */
/**
 * The proposals this design carries, and which one is live.
 *
 * ABOVE the object list rather than inside it, because choosing between two
 * proposals is a question about the whole design and the tree can be hundreds of rows deep.
 * Hidden entirely when there are none — the overwhelming majority of designs —
 * so it costs nothing to the normal case.
 */
/**
 * Make the selection one PROPOSAL for a part of the yard.
 *
 * A group represents an alternative for one area so the user can compare ideas.
 *
 * The FIRST proposal in a set is the geometry already there — naming it as an
 * option leaves the view unchanged. A second proposal creates the choice.
 */
async function proposeSelection() {
  if (selection.size < 2) { log("pick more than one object first", "err"); return; }
  const sets = [...alternativeSets(currentDesign).keys()];
  const where = (prompt(
    "Which part of the site is this a proposal for?"
    + (sets.length ? `\n\nAlready named: ${sets.join(", ")}` : ""),
    sets[0] || "the east corner") ?? "").trim();
  if (!where) return;
  const name = (prompt(`What is THIS proposal called?`, "as it is") ?? "").trim();
  if (!name) return;

  const id = `alt_${Date.now().toString(36)}`;
  const groups = [...(currentDesign?.groups ?? []),
                  { id, name, members: [...selection], alt_of: where }];
  const alternatives = { ...(currentDesign?.alternatives ?? {}) };
  // a set with no choice yet chooses THIS one; an existing set keeps its choice,
  // because naming a second idea must not silently swap the yard out from
  // under the user
  if (!alternatives[where]) alternatives[where] = id;
  if (!await saveAlternatives(groups, alternatives)) return;
  const others = alternativeSets(currentDesign).get(where)?.length ?? 1;
  log(others > 1
    ? `"${name}" is now one of ${others} proposals for ${where} — switch between them above the object list`
    : `"${name}" is a proposal for ${where}. Make another one the same way and you can switch between them`,
    "ok");
}

function renderAlternatives() {
  const box = document.getElementById("objAlts");
  if (!box) return;
  const sets = alternativeSets(currentDesign);
  box.hidden = !sets.size;
  box.innerHTML = "";
  if (!sets.size) return;
  const byId = new Map((currentDesign?.groups ?? [])
    .filter(g => g?.id).map(g => [String(g.id), g]));
  for (const [setId, options] of sets) {
    const row = document.createElement("div");
    row.className = "alt-set";
    const label = document.createElement("span");
    label.className = "alt-name";
    label.textContent = setId;
    label.title = "two proposals for this part of the site — only the one you "
      + "choose is drawn, measured or judged";
    row.appendChild(label);
    const live = chosenAlternative(currentDesign, setId);
    for (const gid of options) {
      const g = byId.get(gid);
      const b = document.createElement("button");
      b.textContent = g?.name || gid;
      b.className = gid === live ? "active" : "";
      const n = (g?.members ?? []).length;
      b.title = gid === live
        ? `showing "${g?.name || gid}" — ${n} object${n === 1 ? "" : "s"}`
        : `switch to "${g?.name || gid}" — ${n} object${n === 1 ? "" : "s"}`;
      b.onclick = async () => {
        if (gid === live) return;
        b.disabled = true;
        await chooseAlternative(setId, gid);
        log(`showing "${g?.name || gid}" for ${setId}`, "ok");
      };
      row.appendChild(b);
    }
    box.appendChild(row);
  }
}

async function saveAlternatives(groups, alternatives) {
  if (!currentDesign) return false;
  const next = await writeDesignDocument({ groups, alternatives }, "alternatives");
  if (!next) return false;
  currentDesign = next;
  lastDesignText = JSON.stringify(next);
  tlPush(next);
  await loadDesign(true);          // a different proposal is a different garden
  renderObjectList();
  renderAlternatives();
  return true;
}

/**
 * Switch which proposal is live.
 *
 * IN THE DOCUMENT, not in localStorage. A viewing preference can be local, but
 * the proposal the design CLAIMS must be shared by every measurement and the
 * design agent. Hiding objects for viewing remains browser state.
 */
async function chooseAlternative(setId, groupId) {
  const alternatives = { ...(currentDesign?.alternatives ?? {}), [setId]: groupId };
  return saveAlternatives(currentDesign?.groups ?? [], alternatives);
}

async function saveGroups(groups) {
  if (!currentDesign) return false;
  // only the key this caller owns; the merge happens onto a fresh read
  const next = await writeDesignDocument({ groups }, "groups");
  if (!next) return false;
  currentDesign = next;
  lastDesignText = JSON.stringify(next);
  tlPush(next);
  regroupScene(designGroup, groups, () => new THREE.Group());
  applyLayers();
  renderSelection();
  // the stored object is a NEW object after any design change, so an inspector
  // still bound to the old one would post the previous values back
  renderProperties();
  renderHandles();
  renderGizmo();
  refreshDesignList();          // design.json changed; re-identify what is on screen
  showWhichDesign();
  return true;
}

/** Group the current selection; ids already in another group move into this one. */
async function groupSelection() {
  if (!selection.size || !currentDesign) { log("select the objects to group first", "warn"); return; }
  const ids = [...selection];
  const next = withNewGroup(designGroups(), { id: `grp_${Date.now().toString(36)}`, name: "", members: ids });
  const g = next[next.length - 1];
  g.name = `group ${next.length}`;
  if (await saveGroups(next)) log(`grouped ${ids.length} objects as "${g.name}"`, "ok");
}

async function ungroup(gid) {
  const g = designGroups().find(x => x.id === gid);
  if (await saveGroups(designGroups().filter(x => x.id !== gid))) {
    setGroupView(gid, { folded: false, hidden: false });
    log(`ungrouped "${g?.name ?? gid}"`);
  }
}

async function setGroupField(gid, patch) {
  await saveGroups(designGroups().map(g => (g.id === gid ? { ...g, ...patch } : g)));
}

// Floating geometry can be missed unless the user sees the right object from
// the right angle. Measure ground contact on every design change and report
// it in the panel; the check is cheap.
function updateGroundContactBadge() {
  const el = document.getElementById("groundWarn");
  if (!el) return;
  el.textContent = ""; el.className = "hint"; el.title = "";
  try {
    // measured against the FLAT design: floatCheckOp scans designGroup one level
    // deep, so anything the owner grouped would silently stop being checked
    const r = withFlatDesign(designGroup, designGroups(), () => new THREE.Group(),
      () => floatCheckOp({}, { enuGroup, heightAt, enuToWorld, THREE }));
    if (r.error || !r.data || !r.data.floating) return;
    const bad = r.data.worst.filter(w => w.gap_m > r.data.tolerance_m);
    el.textContent = `⚠ ${r.data.floating} floating`;
    el.className = "hint bad";
    el.title = "hanging clear of the ground over their whole footprint:\n"
      + bad.map(w => `  ${w.id} — ${w.gap_m} m up, at ENU ${w.enu[0]},${w.enu[1]}`).join("\n");
  } catch { /* a badge must never break the panel */ }
}

function objectRow(o, opts = {}) {
  const row = document.createElement("div");
  row.dataset.objectId = o.id;              // so the selection can find its row
  row.className = "orow" + (selection.has(o.id) ? " sel" : "")
    + (opts.child ? " child" : "") + (opts.locked ? " locked" : "");
  // NAME then MEASURE. The kind is already in the section heading, and an id
  // alone does not identify the object to a reader. Keep the name prominent.
  const k = document.createElement("span"); k.className = "kind"; k.textContent = o.kind;
  const n = document.createElement("span"); n.className = "nm"; n.textContent = o.name || o.id;
  n.title = `${o.name || o.id}${o.meta ? ` — ${o.meta}` : ""}`;
  const m = document.createElement("span"); m.className = "meta"; m.textContent = o.meta;
  row.append(k, n, m);

  // Show/hide this ONE object. Same control, same glyphs and same position as the
  // group eye, because it is the same idea one level down and a second visual
  // language for it would be the thing to explain rather than the feature.
  const off = hiddenObjectIds().has(o.id);
  if (off) row.classList.add("off");
  // NOT IN THE YARD, and the tree must say so. The list shows BOTH
  // proposals on purpose — the user has to see the other one to switch to it — but a
  // row that reads like every other row while its object is not drawn is the
  // tree claiming more objects than the garden holds. Marked, not hidden: the
  // difference between "you cannot see this" and "this is not there".
  if (notDrawn.has(o.id)) {
    row.classList.add("unbuilt");
    row.title = "in the other proposal for this part of the site — not drawn, "
      + "not measured, still in the file";
  }
  const eye = document.createElement("button");
  eye.className = "eye" + (off ? "" : " on");
  eye.textContent = off ? "◌" : "◉";
  eye.title = off ? "show this object" : "hide this object";
  eye.onclick = ev => {
    ev.stopPropagation();                       // never let it reach the row's select
    // Deselect on hide: the gizmo, the handles and the property inspector would
    // otherwise sit on something invisible, and a drag would move what the user cannot
    // see. pickableId already refuses to SELECT a hidden object; this is the same
    // rule applied to a selection that already existed.
    if (!off && selection.has(o.id)) setSelection([...selection].filter(id => id !== o.id));
    setObjectView(o.id, { hidden: !off });
    applyLayers();
    renderObjectList();
  };
  row.append(eye);

  // hovering a row lights the object in the scene, and vice versa
  row.onmouseenter = () => { hoverId = o.id; applySelectionHighlight(); };
  row.onmouseleave = () => { hoverId = null; applySelectionHighlight(); };
  if (opts.locked) {
    row.title = "locked with its group — unlock it to select";
    return row;
  }
  // THREE GESTURES: plain click selects, Shift selects a range, and ⌘ toggles
  // one row. A range must follow the rendered order.
  row.onclick = ev => {
    if (ev.shiftKey && treeAnchor) {
      // the range their EYE ran over, so it follows the sort on screen
      const span = rangeBetween(treeOrderIds, treeAnchor, o.id);
      if (span.length) {
        for (const id of span) selection.add(id);
        applySelectionHighlight(); renderSelection(); renderProperties();
        renderHandles(); renderGizmo();
        return;
      }
    }
    if (ev.metaKey || ev.ctrlKey) {
      selection.has(o.id) ? selection.delete(o.id) : selection.add(o.id);
      treeAnchor = o.id;
      applySelectionHighlight(); renderSelection();
    } else {
      setSelection(selection.size === 1 && selection.has(o.id) ? [] : [o.id]);
      treeAnchor = o.id;
    }
  };
  // RIGHT-CLICK IN THE TREE acts on the selection where it is made. Share the
  // canvas's contextItemsFor so the two menus cannot drift.
  //
  // A right-click outside the selection selects that row first, so commands
  // act on the object the user points at.
  row.oncontextmenu = ev => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!selection.has(o.id)) setSelection([o.id]);
    treeAnchor = o.id;
    ctxMenu.open(contextItemsFor({ kind: o.kind, id: o.id },
                                 { hasSelection: selection.size > 0,
                                   multi: selection.size > 1,
                                   group: groupIndex(designGroups()).get(o.id) ?? null }),
                 { x: ev.clientX, y: ev.clientY });
  };
  return row;
}

// One row for the whole thing: fold, hide, lock or select every member.
// Each control stops the click reaching the row's own select.
function groupHeaderRow(g, members) {
  const row = document.createElement("div");
  const folded = isFolded(g.id);
  const hidden = !!groupView[g.id]?.hidden;
  const ids = members.map(o => o.id);
  const allSelected = ids.length > 0 && ids.every(id => selection.has(id));
  row.className = "grow" + (allSelected ? " sel" : "") + (hidden ? " off" : "");

  const twisty = document.createElement("button");
  twisty.className = "twisty";
  twisty.textContent = folded ? "▸" : "▾";
  twisty.title = folded ? "show what is in it" : "fold it shut";
  twisty.onclick = ev => { ev.stopPropagation(); setGroupView(g.id, { folded: !folded }); renderObjectList(); };

  const name = document.createElement("input");
  name.type = "text"; name.className = "gn"; name.value = g.name ?? g.id;
  name.title = "rename";
  name.onclick = ev => ev.stopPropagation();
  name.onchange = () => setGroupField(g.id, { name: name.value.trim() || g.id });

  const count = document.createElement("span");
  count.className = "meta"; count.textContent = `${members.length}`;

  const eye = document.createElement("button");
  eye.className = "eye" + (hidden ? "" : " on");
  eye.textContent = hidden ? "◌" : "◉";
  eye.title = hidden ? "show this group" : "hide this group";
  eye.onclick = ev => {
    ev.stopPropagation();
    setGroupView(g.id, { hidden: !hidden });
    applyLayers();
    renderObjectList();
  };

  const lock = document.createElement("button");
  lock.className = "eye" + (g.locked ? " on" : "");
  lock.textContent = g.locked ? "🔒" : "🔓";
  lock.title = g.locked ? "unlock" : "lock — stops it being clicked or deleted";
  lock.onclick = async ev => {
    ev.stopPropagation();
    // locking something already selected would leave it deletable through the
    // selection it is still sitting in
    if (!g.locked) for (const id of ids) selection.delete(id);
    await setGroupField(g.id, { locked: !g.locked });
  };

  const un = document.createElement("button");
  un.textContent = "×"; un.title = "ungroup (the objects stay)";
  un.onclick = ev => { ev.stopPropagation(); ungroup(g.id); };

  row.append(twisty, name, count, eye, lock, un);
  if (!g.locked) {
    row.onclick = () => setSelection(allSelected ? [] : ids);
    row.onmouseenter = () => { hoverGroup = g.id; applySelectionHighlight(); };
    row.onmouseleave = () => { hoverGroup = null; applySelectionHighlight(); };
  }
  return row;
}

// VIEW state, like every other ordering and visibility preference here.
/** The sort control, created once beside the Objects heading. */
function ensureTreeSortControl() {
  // BESIDE THE FILTER: narrowing by name and ordering both help find objects,
  // so keep them together on one row.
  const host = document.getElementById("objFind");
  if (!host || host.querySelector(".tree-sort")) return;
  const sel = document.createElement("select");
  sel.className = "tree-sort";
  sel.title = "how to order the list — a view preference, not a change to the design";
  for (const o of ORDERS) {
    const opt = document.createElement("option");
    opt.value = o.id; opt.textContent = o.label;
    sel.appendChild(opt);
  }
  sel.value = treeOrder;
  sel.onchange = () => setTreeOrder(sel.value);
  host.appendChild(sel);
  const filt = document.getElementById("objFilter");
  if (filt && !filt.dataset.wired) {
    filt.dataset.wired = "1";
    // `input`, not `change`: narrowing a list of hundreds should happen as you type
    filt.oninput = () => renderObjectList();
  }
}

// The rows in the order they are ON SCREEN, and the row a range is measured
// from. Written by renderObjectList, because the list's own sort and filter
// decide both — a second derivation would disagree with the screen exactly when
// the sort is not the default.
let treeOrderIds = [];
let notDrawn = new Set();   // ids in a proposal that is not the live one
let treeAnchor = null;

document.getElementById("btnShowAllObjects")?.addEventListener("click", () => {
  commands.run("edit.showAll");
});

const TREE_ORDER_KEY = "pedon.treeorder";
let treeOrder = (() => {
  try { return localStorage.getItem(TREE_ORDER_KEY) || "kind"; } catch { return "kind"; }
})();
function setTreeOrder(v) {
  treeOrder = v;
  try { localStorage.setItem(TREE_ORDER_KEY, v); } catch { /* private mode */ }
  renderObjectList();
}

function renderObjectList() {
  // once per render; `inactiveIds` walks every group and a tree of hundreds of
  // rows would otherwise ask it once per row
  notDrawn = inactiveIds(currentDesign);
  const box = document.getElementById("objList");
  const objs = designObjects();
  const { rows, loose } = groupTree(designGroups(), objs);
  ensureTreeSortControl();
  document.getElementById("objCount").textContent = objs.length
    ? `(${objs.length}${rows.length ? ` · ${rows.length} group${rows.length > 1 ? "s" : ""}` : ""})`
    : "";
  // the panel header already says OBJECTS; this row exists for the ground
  // warning and the sort control, and reads as a second title without it
  document.getElementById("objRow")?.classList.toggle("bare", !rows.length);
  updateGroundContactBadge();
  box.innerHTML = "";
  if (!objs.length) {
    const e = document.createElement("div");
    e.className = "hint";
    e.textContent = "nothing designed yet — pick a plant or object from the dock, then click the ground";
    box.appendChild(e);
    return;
  }
  // SORTED. Finding one row among hundreds is the actual job, and a 2D editor's
  // layer order — what covers what — has nothing to mean in a scene where
  // geometry sits in space and is drawn by kind. Which order you like is VIEW
  // state: writing it into design.json would put a preference into the file the
  // design agent reads.
  // THE ORDER ON SCREEN, recorded as it is built. A shift-range is the rows their
  // eye ran over, so it has to be the rendered sequence — including group members
  // in their folded/unfolded state — and not a second sort computed elsewhere.
  treeOrderIds = [];
  for (const r of rows) {
    box.appendChild(groupHeaderRow(r.group, r.members));
    if (isFolded(r.group.id)) continue;
    for (const o of sortRows(r.members, treeOrder)) {
      box.appendChild(objectRow(o, { child: true, locked: !!r.group.locked }));
      if (!r.group.locked) treeOrderIds.push(o.id);
    }
  }
  // FILTERED. Scrolling through hundreds of rows is not finding. Matching on kind as
  // well as id lets "bed" narrow to beds without knowing their names.
  const q = (document.getElementById("objFilter")?.value ?? "").trim().toLowerCase();
  const hit = o => !q || `${o.id} ${o.kind} ${o.meta ?? ""}`.toLowerCase().includes(q);
  const shownLoose = sortRows(loose, treeOrder).filter(hit);
  // THE COUNT SAYS WHAT IS HAPPENING TO THE LIST — narrowed by a filter, and how
  // much of the design is currently hidden. "Show all" appears only when that
  // second number is not zero, because a reset for a state you are not in is a
  // button that can only do nothing.
  const hiddenNow = hiddenObjectIds().size;
  const shownEl = document.getElementById("objShown");
  if (shownEl) shownEl.textContent = (q
    ? `${shownLoose.length} of ${objs.length}`
    : `${objs.length} object${objs.length === 1 ? "" : "s"}`)
    + (hiddenNow ? ` · ${hiddenNow} hidden` : "")
    // AND HOW MANY ARE NOT DRAWN. The tree lists every proposal, but the garden
    // draws only one; its count must distinguish document objects from drawn ones.
    + (notDrawn.size ? ` · ${notDrawn.size} not built` : "");
  const showAll = document.getElementById("btnShowAllObjects");
  if (showAll) showAll.hidden = !hiddenNow;
  if (q && !shownLoose.length) {
    const e = document.createElement("div");
    e.className = "hint";
    e.textContent = `nothing matches “${q}”`;
    box.appendChild(e);
  }
  // the kind column is redundant under a kind heading and is the only thing
  // saying what a row is in the other two orders
  box.dataset.order = treeOrder;
  for (const item of withKindHeadings(shownLoose, treeOrder)) {
    if (item.type === "heading") {
      const h = document.createElement("div");
      h.className = "p-label tree-heading";
      h.textContent = kindPlural(item.kind);
      const c = document.createElement("span");
      c.className = "hint"; c.textContent = item.count;
      h.appendChild(c);
      box.appendChild(h);
    } else {
      box.appendChild(objectRow(item.row));
      treeOrderIds.push(item.row.id);
    }
  }
  renderWants();
}

/**
 * Show the owner, unprompted, what this design asked for that nothing modelled.
 *
 * In the object list's own flow, NOT a floating overlay that can block scene
 * clicks. index.html owns every fixed element so ui_no_overlap.test.mjs can
 * check them; a positioned element created here would be invisible to that check.
 */
/**
 * Fill a design's plant colours in from the owner's own shortlist.
 *
 * RENDER-TIME ONLY — nothing here reaches disk. Designs on disk write
 * `foliage: "dark_green"`, a WORD, which collapses dozens of species through nine ramps
 * into a handful of greens. Without flower colours, perennialClump paints
 * flower heads leaf-green. data/plant_palette.json supplies precise foliage
 * and flower hex values for every species it lists.
 *
 * Fills gaps, never overwrites: a plant that states its own colour is making a
 * promise about that plant, exactly like `plant.asset` beating the species table.
 */
/**
 * The model files a build of `design` will draw from, loaded before it builds (building is
 * synchronous). BOTH MODES: Fast draws a library tree or a species' own model reduced,
 * not the generic shape. In Fast the kept plants are read back first, and only the kinds still to
 * be generated load their file — a kept olive does not fetch 8 MB again.
 */
async function ensurePlantModels(design, quality) {
  const sized = sizedPlantsOf(colourFromPalette(design), growthScale());
  // Only plants that DRAW from a file: fetching manzanita.glb for a 2 m+ plant
  // claimed by its own builder (Dr. Hurd) decodes 12.8 MB that is never drawn.
  const fromFile = plants => assetsNeededBy({ plants: plants.filter(p => assetName(p) && !drawnByCode(p)) });
  if (quality !== "fast") return ensureAssets(fromFile(sized));
  await restoreModels(sized.map(fastModelKey));
  return ensureAssets(fromFile(sized.filter(p => keptModel(fastModelKey(p)) === undefined)));
}

function colourFromPalette(design) {
  if (!plantCatalog.length || !design?.plants?.length) return design;
  const by = new Map(plantCatalog.flatMap(c => [c.species, ...(c.aliases ?? [])]
    .map(name => [String(name ?? "").trim().toLowerCase(), c])));
  let touched = false;
  const plants = design.plants.map((p) => {
    const c = by.get(String(p.species ?? "").trim().toLowerCase());
    if (!c) return p;
    const add = {};
    // a WORD is not a colour: the palette's hex is more specific, so it wins over
    // "dark_green" while an explicit #rrggbb on the plant is left alone
    if (!/^#[0-9a-f]{6}$/i.test(String(p.foliage ?? "")) && c.foliage) add.foliage = c.foliage;
    if (!p.flower && c.flower) add.flower = c.flower;
    if (!p.flowering_height_range_m && c.flowering_height_range_m)
      add.flowering_height_range_m = c.flowering_height_range_m;
    if (!Object.keys(add).length) return p;
    touched = true;
    return { ...p, ...add };
  });
  return touched ? { ...design, plants } : design;
}

function renderWants() {
  const objList = document.getElementById("objList");
  if (!objList) return;
  const areas = siteCache?.areas ?? [];
  const placeOf = (x, y) => {
    // The ONE ray-crossing test, imported from areas.js so callers cannot drift.
    for (const a of areas) if (pointInPolygon(x, y, a.polygon)) return a.name;
    return null;
  };
  // objects.js owns "no model for this KIND", design.js owns "no surface for this
  // MATERIAL". Concatenated here so neither module has to know the other exists,
  // and so both reach the owner through one strip rather than two.
  const everything = d => [...wants(d), ...materialWants(d)];
  for (const row of wantRows(currentDesign, { wants: everything, placeOf })) {
    const el = document.createElement("div");
    el.className = "row want";
    el.style.borderLeft = `3px solid #${PLACEHOLDER_COLOUR.toString(16).padStart(6, "0")}`;
    el.title = "no model for this yet — it is drawn as a marked placeholder";
    const what = document.createElement("div");
    what.textContent = row.label;
    const where = document.createElement("div");
    where.className = "hint";
    where.textContent = row.where;
    el.append(what, where);
    el.onclick = () => {
      const box = new THREE.Box3();
      for (const id of row.ids) for (const node of objectsFor(id)) box.expandByObject(node);
      if (!box.isEmpty()) frameBox(box);
    };
    objList.appendChild(el);
  }
}

/**
 * The property inspector: change anything the model decided.
 *
 * Every property of a model-created path, wall or other object is editable.
 *
 * Every edit is an OP through /api/ops, so a wall raised past what the ground
 * can retain is REJECTED with the reason, and edits remain undoable.
 * Bypassing validators would admit floating or off-scan geometry through a
 * hand edit the owner expects to be trustworthy.
 */
/**
 * Say which design is on screen.
 *
 * Name the design and distinguish THREE states: saved, unsaved and PREVIEW.
 * A preview shows the agent's scratch design instead of the working design.
 * It refuses writes while active, so both the source and that restriction
 * must be visible.
 */
function showWhichDesign() {
  const el = document.getElementById("whichDesign");
  if (!el) return;
  const preview = typeof previewSource !== "undefined" && previewSource;
  el.classList.toggle("preview", !!preview);
  if (preview) {
    // AND A WAY OUT. The MCP bridge can set previewSource through preview_design
    // without a user action. Offer a control to clear it so held hand edits can
    // resume; naming the restriction alone leaves a dead end.
    const name = String(preview).split("/").pop().replace(/\.json$/, "");
    el.textContent = `previewing ${name} — NOT your working design, and edits are held. `;
    const out = document.createElement("button");
    out.textContent = "Back to my design";
    out.className = "linkish";
    out.title = "stop previewing an agent's file and edit your own design again";
    out.onclick = () => {
      previewSource = null;
      showWhichDesign();
      log("back on your working design — edits are live again", "ok");
      loadDesign(true);
    };
    el.appendChild(out);
  } else if (currentVariant) {
    el.textContent = `editing ${currentVariant}`;
  } else {
    el.textContent = "editing the working design (data/design.json)";
  }
}

// ── RESHAPE-START ──
//
// Control-point handles on the selected object, so its LINE can be changed.
// Under enuGroup, never the scene: a scene-parented handle slides off its design
// the moment north is set.
let handleGroup = null;
let handleDrag = null;      // { kind, raw, index, node }

function renderHandles() {
  if (handleGroup) { enuGroup.remove(handleGroup); disposeObj(handleGroup, "mesh"); handleGroup = null; }
  const ids = [...selection];
  // ONE object only: a vertex index means nothing across a multi-selection
  if (ids.length !== 1 || handleDrag) return;
  const found = rawById(currentDesign, ids[0]);
  if (!found) return;
  const pts = geometryOf(found.kind, found.raw);
  if (!pts.length) return;

  const g = new THREE.Group();
  g.name = "handles";

  // MIDPOINT handles — click one to add a corner there. A line can only be
  // redistributed by moving the points it has; this is how it gains one.
  for (const { after, at } of midpointsFor(found.kind, pts)) {
    const [mx, my] = at;
    const mg = heightAt(...(() => { const w = enuToWorld(mx, my, 0); return [w.x, w.z]; })());
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.075, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0x7fc69a, depthTest: false,
                                    transparent: true, opacity: 0.5 }));
    dot.renderOrder = 3;
    dot.position.copy(enuToWorld(mx, my, (Number.isFinite(mg) ? mg : 0) + 0.12));
    dot.userData.midpoint = { kind: found.kind, id: found.raw.id, after, at };
    g.add(dot);
  }

  pts.forEach(([x, y], i) => {
    const h = heightAt(...(() => { const w = enuToWorld(x, y, 0); return [w.x, w.z]; })());
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 12, 10),
      new THREE.MeshBasicMaterial({ color: 0x7fc69a, depthTest: false }));
    dot.renderOrder = 3;                       // visible through the planting it edits
    const w = enuToWorld(x, y, (Number.isFinite(h) ? h : 0) + 0.12);
    dot.position.copy(w);
    dot.userData.handle = { kind: found.kind, id: found.raw.id, index: i };
    g.add(dot);
  });
  enuGroup.add(g);
  handleGroup = g;
}

// Double-click a real control point to REMOVE it. Deliberately a double-click:
// a single click there starts a reshape drag, and a modifier would be a thing to
// remember. The op refuses to take a polygon below a triangle or a line below two
// ends, and says so where the click happened.
renderer.domElement.addEventListener("dblclick", async (ev) => {
  if (mode !== "orbit" || !handleGroup) return;
  const h = pickHandle(ev);
  const hit = h?.userData?.handle;
  if (!hit) return;
  ev.preventDefault();
  const found = rawById(currentDesign, hit.id);
  if (!found) return;
  try {
    await postOps(deletePointOps(hit.kind, found.raw, hit.index),
                  `${hit.id}: point ${hit.index + 1} removed`);
  } catch (e) {
    log(String(e?.message ?? e), "warn");
  }
});

/**
 * Aim the shared raycaster at the pointer, and hand back the same ray as plain
 * arrays — WORLD, because that is what a raycast returns.
 *
 * Both halves are wanted: THREE's intersect tests read `raycaster`, and gizmo.js
 * is pure and reads numbers. Sharing the ndc arithmetic keeps the two callers'
 * ray calculations consistent.
 */
function pointerRay(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1,
                                -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const { origin: o, direction: d } = raycaster.ray;
  return { origin: [o.x, o.y, o.z], dir: [d.x, d.y, d.z] };
}

/** The handle under the pointer, or null. */
function pickHandle(ev) {
  if (!handleGroup) return null;
  pointerRay(ev);
  const hit = raycaster.intersectObjects(handleGroup.children, false)[0];
  return hit?.object ?? null;
}
// ── RESHAPE-END ──

// ── GIZMO-START ──
//
// The transform gizmo: two ground-plane arrows, a centre handle and a rotation
// ring, on whatever is selected.
//
// Visible handles show where to grab and what each drag does. Selection,
// reshaping and scalar edits all use ops through /api/ops.
//
// Vertical movement must use `level_m`, the validated field for a raised bench.
// A free lift would fight float_check, retaining rules and cut/fill checks by
// allowing floating geometry. Objects otherwise stand on measured ground.
//
// The arithmetic is in gizmo.js and is pure, so which part a ray picks, how far
// along an axis the pointer has travelled and how many degrees a ring drag is
// worth are all tested in node. This is only wiring.
let gizmoGroup = null;
let gizmoState = null;   // { center:[x,y], h, radius, ring, how, id, kind }
let gizmoDrag = null;

// How big the gizmo is, in PIXELS. The one number that matters: in metres it
// would be a speck on a 30 m yard and a monster on a 0.3 m set stone, and a
// garden gets edited at both scales in the same session.
const GIZMO_PX = 84;

const GIZMO_COLOURS = {
  x: 0xff6b5e,        // east — warm red, which nothing in a photogrammetry scan is
  y: 0x4ea8ff,        // north — blue, for the same reason. NOT green: the handles
                      // are green and so is every plant it will be standing in
  centre: 0xf2f2f2,
  ring: 0xffc857,
  lift: 0xc78bff,     // violet — red, blue, green and amber are all already taken
  tilt: 0x5fe0c8,     // teal, for the lean ring: distinct from the amber yaw ring

};

/**
 * The gizmo's own east and north, in WORLD, at its ENU centre.
 *
 * DERIVED from enuToWorldPoint rather than assumed. At yaw 0 these come out as
 * world +x and world -z, so a hardcoded pair looks correct at yaw 0 but is wrong
 * by the yaw as soon as "Set north" is pressed.
 */
function gizmoFrame(cx, cy, h) {
  const c = enuToWorldPoint(cx, cy, h);
  const east = enuToWorldPoint(cx + 1, cy, h).sub(c).normalize();
  const north = enuToWorldPoint(cx, cy + 1, h).sub(c).normalize();
  return { center: [c.x, c.y, c.z], east: [east.x, east.y, east.z],
           north: [north.x, north.y, north.z], up: [0, 1, 0] };
}

/**
 * Where the gizmo goes and what it may offer, from the selection.
 *
 * The centre is the mean of every point in the selection, so it lands inside a
 * bed and on a lantern. The RING is offered for one object only: turning a
 * multi-selection about a shared centre would have to move every member AND
 * re-face the ones carrying rotation_deg, requiring a different op list.
 */
function gizmoTarget() {
  const ids = [...selection];
  if (!ids.length || !currentDesign) return null;
  const pts = [];
  let only = null;
  for (const id of ids) {
    const found = rawById(currentDesign, id);
    if (!found) continue;
    if (ids.length === 1) only = found;
    const spec = MOVE_AS[found.kind];
    // A plant is special-cased in moveOps rather than MOVE_AS. It still gets
    // movement arrows, but has no facing and therefore no rotation ring.
    const list = spec ? (spec.point ? [found.raw[spec.pts]] : found.raw[spec.pts] ?? [])
                      : (found.kind === "plant" ? [found.raw.position] : []);
    for (const p of list) if (Array.isArray(p) && p.length >= 2) pts.push(p);
  }
  const center = centroid(pts);
  if (!center) return null;
  // The vertical arrow is offered only where `level_m` is a legal field for
  // EVERY selected thing, because it is the field it writes. A plant has no
  // level_m — it grows out of the ground — so a mixed selection gets no lift
  // rather than a handle that silently does nothing to half of it.
  const lift = ids.length > 0 && ids.every(id => {
    const f = rawById(currentDesign, id);
    return !!f && !!MOVE_AS[f.kind]?.keep?.includes("level_m");
  });
  // The TILT ring is offered for ONE object only, and only where `tilt_deg` is a
  // legal field. Leaning a multi-selection about a shared axis needs a different
  // op list, just as yawing one does.
  const tilt = ids.length === 1 && !!only
               && !!MOVE_AS[only.kind]?.keep?.includes("tilt_deg");
  return { center, how: only ? rotatable(MOVE_AS[only.kind]) : null, only, lift, tilt };
}

/** One arrow, built along +x at unit radius; `spin` swings it to another axis. */
function gizmoArrow(colour, spin) {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: colour, depthTest: false });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.72, 8), mat);
  shaft.rotation.z = -Math.PI / 2;
  shaft.position.x = 0.55;
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.22, 12), mat);
  head.rotation.z = -Math.PI / 2;
  head.position.x = 1.02;
  g.add(shaft, head);
  g.rotation.y = spin;
  for (const m of [shaft, head]) m.renderOrder = 4;
  return g;
}

/**
 * Draw the gizmo on the selection.
 *
 * Built at UNIT radius and scaled every frame by sizeGizmo(), so the screen-space
 * sizing is one scalar rather than a rebuild per camera move. Under enuGroup,
 * never the scene — a gizmo parented to the scene would slide off its own
 * selection the moment north is set, exactly as the handles would.
 */
function renderGizmo() {
  if (gizmoGroup) { enuGroup.remove(gizmoGroup); disposeObj(gizmoGroup, "mesh"); gizmoGroup = null; }
  gizmoState = null;
  if (gizmoDrag) return;                       // mid-drag it is already on screen
  if (!document.getElementById("gizmoOn")?.checked) return;
  const t = gizmoTarget();
  if (!t) return;
  const [cx, cy] = t.center;
  const flat = enuToWorld(cx, cy, 0);
  const g0 = heightAt(flat.x, flat.z);
  const h = (Number.isFinite(g0) ? g0 : 0) + 0.14;

  const g = new THREE.Group();
  g.name = "gizmo";
  g.position.copy(enuToWorld(cx, cy, h));
  // ENU east is local +x and ENU north is local -z (enuToWorld), so the north
  // arrow is the east arrow swung a quarter turn about +y
  g.add(gizmoArrow(GIZMO_COLOURS.x, 0));
  g.add(gizmoArrow(GIZMO_COLOURS.y, Math.PI / 2));
  // The vertical arrow is offered ONLY where `level_m` is legal. That field
  // lets a thing leave the ground through validation, while float_check still
  // measures where the geometry ends up.
  if (t.lift) {
    const up = gizmoArrow(GIZMO_COLOURS.lift, 0);
    up.rotation.z = Math.PI / 2;               // swing the +x arrow onto +y
    g.add(up);
  }

  const hub = new THREE.Mesh(
    new THREE.SphereGeometry(0.17, 14, 10),
    new THREE.MeshBasicMaterial({ color: GIZMO_COLOURS.centre, depthTest: false,
                                  transparent: true, opacity: 0.85 }));
  hub.renderOrder = 4;
  g.add(hub);

  if (t.how) {
    // a pivot, so the ring can be turned live while the drag is happening
    const pivot = new THREE.Group();
    pivot.name = "gizmoRing";
    const mat = new THREE.MeshBasicMaterial({ color: GIZMO_COLOURS.ring, depthTest: false });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.25, 0.028, 8, 64), mat);
    ring.rotation.x = -Math.PI / 2;
    const tick = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.05), mat);
    tick.position.x = 1.25;
    pivot.add(ring, tick);
    for (const m of [ring, tick]) m.renderOrder = 4;
    g.add(pivot);
  }
  if (t.tilt) {
    // The same band stood upright turns LEAN, independently of the yaw ring.
    const pivot = new THREE.Group();
    pivot.name = "gizmoTiltRing";
    const mat = new THREE.MeshBasicMaterial({ color: GIZMO_COLOURS.tilt, depthTest: false });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.25, 0.026, 8, 64), mat);
    // TorusGeometry lies in XY; the yaw ring lays it flat, this one stands it in
    // the plane whose normal is EAST, which is the plane a lean happens in
    ring.rotation.y = Math.PI / 2;
    const tick = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 0.05), mat);
    tick.position.y = 1.25;
    pivot.add(ring, tick);
    for (const m of [ring, tick]) m.renderOrder = 4;
    g.add(pivot);
  }
  enuGroup.add(g);
  gizmoGroup = g;
  gizmoState = { center: [cx, cy], h, radius: null, ring: !!t.how, how: t.how,
                 lift: !!t.lift, tilt: !!t.tilt,
                 id: t.only?.raw?.id ?? null, kind: t.only?.kind ?? null };
  sizeGizmo();
}

/**
 * Keep the gizmo the same size on screen. Called every frame, because an orbit
 * control changes the camera distance continuously and a gizmo that is only
 * sized when the selection changes is the wrong size for the rest of the session.
 */
function sizeGizmo() {
  if (!gizmoGroup || !gizmoState) return;
  const c = enuToWorldPoint(gizmoState.center[0], gizmoState.center[1], gizmoState.h);
  gizmoState.radius = gizmoRadius(
    [camera.position.x, camera.position.y, camera.position.z], [c.x, c.y, c.z],
    camera.fov, renderer.domElement.clientHeight || window.innerHeight, GIZMO_PX);
  gizmoGroup.scale.setScalar(gizmoState.radius);
}

/** Which part of the gizmo the pointer is over, or null. */
function pickGizmo(ev) {
  if (!gizmoGroup || !gizmoState?.radius) return null;
  const f = gizmoFrame(gizmoState.center[0], gizmoState.center[1], gizmoState.h);
  return pickPart(pointerRay(ev), { ...f, radius: gizmoState.radius,
                                    ring: gizmoState.ring, lift: gizmoState.lift,
                                    tilt: gizmoState.tilt });
}

/** The live readout — a 3D app tells you how far you have dragged. */
function showGizmoHud(text) {
  const el = document.getElementById("gizmoHud");
  if (!el) return;
  el.textContent = text ?? "";
  el.hidden = !text;
}

/**
 * Show a move before it is an op.
 *
 * ENU +y is world -z (enuToWorld) and these nodes hang under enuGroup, so this
 * is a translation in the frame their coordinates were written in. One copy,
 * shared by the body drag and the gizmo — they are the same gesture reached two
 * ways, and two copies would drift.
 */
function previewMove(nodes, dx, dy) {
  for (const { o, base } of nodes) o.position.set(base.x + dx, base.y, base.z - dy);
}

/**
 * A live outline of where a turned point list will land.
 *
 * A bed's mesh has its coordinates BAKED into geometry at position (0,0,0), so
 * the position-and-rotation trick that previews an object's facing cannot preview
 * a polygon's turn — it would slide the whole thing sideways. A ghost line built
 * from the same rotateXY the op uses cannot be wrong about it.
 */
let ghostLine = null;
function makeGhost(pts, closed) {
  clearGhost();
  const n = pts.length + (closed ? 1 : 0);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  ghostLine = new THREE.Line(geo, new THREE.LineBasicMaterial(
    { color: GIZMO_COLOURS.ring, depthTest: false, transparent: true, opacity: 0.9 }));
  ghostLine.renderOrder = 4;
  enuGroup.add(ghostLine);
}
function updateGhost(pts, closed) {
  if (!ghostLine) return;
  const arr = ghostLine.geometry.getAttribute("position");
  const n = pts.length + (closed ? 1 : 0);
  for (let i = 0; i < n; i++) {
    const [x, y] = pts[i % pts.length];
    const w = enuToWorld(x, y, 0);
    const g = heightAt(w.x, w.z);
    const p = enuToWorld(x, y, (Number.isFinite(g) ? g : 0) + 0.06);
    arr.setXYZ(i, p.x, p.y, p.z);
  }
  arr.needsUpdate = true;
  ghostLine.geometry.computeBoundingSphere();
}
function clearGhost() {
  if (!ghostLine) return;
  enuGroup.remove(ghostLine);
  ghostLine.geometry.dispose();
  ghostLine.material.dispose();
  ghostLine = null;
}

/**
 * Snap a gizmo move, on the owner's own switch and against the same targets a
 * reshape snaps to. An AXIS drag snaps only the axis it is on: a gizmo that
 * pulled the object sideways to reach a grid line would not be an axis drag.
 */
function snapMove(dx, dy, part) {
  const [cx, cy] = gizmoState.center;
  const s = snapped([cx + dx, cy + dy], gizmoState.id);
  return [part === "y" ? dx : s[0] - cx, part === "x" ? dy : s[1] - cy];
}

function startGizmoDrag(ev, part) {
  if (!gizmoState) return false;
  const f = gizmoFrame(gizmoState.center[0], gizmoState.center[1], gizmoState.h);
  const ray = pointerRay(ev);
  const d = { part, frame: f, at: [ev.clientX, ev.clientY], engaged: false,
              dx: 0, dy: 0, deg: 0, pointerId: ev.pointerId, typed: "",
              nodes: [...selection].flatMap(objectsFor)
                       .map(o => ({ o, base: o.position.clone(), baseRotY: o.rotation.y,
                                    baseRotX: o.rotation.x })) };
  if (part === "x" || part === "y") {
    const t = axisParam(ray, f.center, part === "x" ? f.east : f.north);
    if (t === null) {
      log("you are looking straight down that arrow — turn the camera a little", "warn");
      return false;
    }
    d.t0 = t;
  } else if (part === "centre") {
    const p = planeHit(ray, f.center, f.up);
    if (!p) return false;
    d.from = worldToEnu(new THREE.Vector3(p[0], p[1], p[2]));
  } else if (part === "lift") {
    const t = axisParam(ray, f.center, f.up);
    if (t === null) {
      log("you are looking straight down the lift arrow — turn the camera a little", "warn");
      return false;
    }
    d.t0 = t;
    d.dz = 0;
    // every selected thing's CURRENT base, so the drag is an offset from where
    // each one actually is rather than from a shared datum they do not share
    d.bases = [...selection].map(id => {
      const found = rawById(currentDesign, id);
      if (!found) return null;
      const cur = Number(found.raw.level_m);
      if (Number.isFinite(cur)) return { found, base: cur };
      // no level yet: it is standing on the ground, so that is its base
      const pt = MOVE_AS[found.kind]?.point ? found.raw.position
                                            : (found.raw[MOVE_AS[found.kind]?.pts] ?? [])[0];
      if (!Array.isArray(pt)) return null;
      const w = enuToWorld(pt[0], pt[1], 0);
      const g0 = heightAt(w.x, w.z);
      return { found, base: Number.isFinite(g0) ? g0 : 0 };
    }).filter(Boolean);
  } else if (part === "tiltring") {
    // the SAME ringDeg, on a permuted basis: the plane whose normal is east, with
    // the angle measured from north toward up. One implementation of "where round
    // a ring is this pointer", not two.
    const a = ringDeg(ray, f.center, f.north, f.up, f.east);
    if (a === null) {
      log("the lean ring is edge-on from here — turn the camera a little", "warn");
      return false;
    }
    const found = gizmoState.id ? rawById(currentDesign, gizmoState.id) : null;
    if (!found) return false;
    d.a0 = a;
    d.raw = found.raw;
    d.kind = found.kind;
    d.base = Number(found.raw.tilt_deg) || 0;
  } else if (part === "ring") {
    const a = ringDeg(ray, f.center, f.east, f.north, f.up);
    if (a === null) {
      log("the ring is edge-on from here — lift the camera to turn it", "warn");
      return false;
    }
    const found = gizmoState.id ? rawById(currentDesign, gizmoState.id) : null;
    if (!found) return false;
    d.a0 = a;
    d.raw = found.raw;
    d.kind = found.kind;
    d.how = gizmoState.how;
    d.base = d.how === "field" ? (Number(found.raw.rotation_deg) || 0) : 0;
    if (d.how === "points") {
      d.pts = geometryOf(found.kind, found.raw);
      d.pivot = centroid(d.pts);
      d.closed = MOVE_AS[found.kind]?.pts === "polygon";
      makeGhost(d.pts, d.closed);
      updateGhost(d.pts, d.closed);
    }
  }
  gizmoDrag = d;
  controls.enabled = false;
  try { renderer.domElement.setPointerCapture?.(ev.pointerId); } catch { /* fine */ }
  return true;
}

function updateGizmoDrag(ev) {
  const d = gizmoDrag;
  const f = d.frame;
  // a TYPED distance is exact: the mouse moving on no longer changes it
  if (d.typed) return;
  // the same dead zone the body drag has, for the same reason: at a zoomed-out
  // view four pixels of tremor is 20 cm of yard, and that clears every "is this
  // actually a change" test downstream
  if (!d.engaged) {
    if (Math.hypot(ev.clientX - d.at[0], ev.clientY - d.at[1]) < DRAG_THRESHOLD_PX) return;
    d.engaged = true;
  }
  const ray = pointerRay(ev);
  if (d.part === "x" || d.part === "y") {
    const t = axisParam(ray, f.center, d.part === "x" ? f.east : f.north);
    if (t === null) return;
    const off = t - d.t0;
    [d.dx, d.dy] = snapMove(d.part === "x" ? off : 0, d.part === "y" ? off : 0, d.part);
    previewMove(d.nodes, d.dx, d.dy);
    showGizmoHud(`${d.part === "x" ? "east" : "north"} ${fmtLen(d.part === "x" ? d.dx : d.dy, 2)}`);
    return;
  }
  if (d.part === "lift") {
    const t = axisParam(ray, f.center, f.up);
    if (t === null) return;
    d.dz = t - d.t0;
    // preview in the scene: the nodes ride up with the drag, exactly as the
    // horizontal arrows preview a move, and are put back by endGizmoDrag either
    // way so the file stays the only truth
    for (const n of d.nodes) n.o.position.set(n.base.x, n.base.y + d.dz, n.base.z);
    showGizmoHud(`${d.dz >= 0 ? "+" : ""}${fmtLen(d.dz, 2)}`);
    return;
  }
  if (d.part === "tiltring") {
    const a = ringDeg(ray, f.center, f.north, f.up, f.east);
    if (a === null) return;
    d.deg = snapAngle(normalizeDeg(a - d.a0));
    const node = gizmoGroup?.getObjectByName("gizmoTiltRing");
    if (node) node.rotation.x = -(d.deg * Math.PI) / 180;
    for (const n of d.nodes) n.o.rotation.x = (d.base + d.deg) * Math.PI / 180;
    showGizmoHud(`lean ${(d.base + d.deg).toFixed(0)}°`);
    return;
  }
  if (d.part === "centre") {
    const p = planeHit(ray, f.center, f.up);
    if (!p) return;
    const to = worldToEnu(new THREE.Vector3(p[0], p[1], p[2]));
    [d.dx, d.dy] = snapMove(to[0] - d.from[0], to[1] - d.from[1], d.part);
    previewMove(d.nodes, d.dx, d.dy);
    showGizmoHud(`${fmtLen(d.dx, 2)} east, ${fmtLen(d.dy, 2)} north`);
    return;
  }
  const a = ringDeg(ray, f.center, f.east, f.north, f.up);
  if (a === null) return;
  // snap the RESULTING facing, not the delta — 15 deg steps are only useful if
  // they land on 15, 30, 45
  const target = snapAngle(normalizeDeg(d.base + normalizeDeg(a - d.a0)));
  d.deg = normalizeDeg(target - d.base);
  const rad = (d.deg * Math.PI) / 180;
  const ring = gizmoGroup?.getObjectByName("gizmoRing");
  if (ring) ring.rotation.y = rad;
  if (d.how === "field") {
    // objects.js draws rotation_deg as rotation.y, and local +y CCW is ENU CCW,
    // so this preview is the op
    for (const n of d.nodes) n.o.rotation.y = n.baseRotY + rad;
  } else {
    updateGhost(rotateXY(d.pts, d.pivot, d.deg), d.closed);
  }
  showGizmoHud(`${d.deg.toFixed(1)}°`);
}

/**
 * The ops for "these things, lifted by dz metres" — the whole of what the vertical
 * drag commits, kept pure so it can be tested without a browser.
 *
 * Each op is the object's OWN upsert with `level_m` rewritten, exactly as a move is
 * the upsert with the geometry rewritten: it runs back through execute() and
 * validate(), so a lift that buries a wall or floats a lantern is judged by the same
 * rules a model's op faces.
 *
 * The base is per THING, not shared: two objects at different elevations dragged
 * together must each keep their own offset, and a single shared datum would snap
 * them level with each other.
 */
function liftOps(bases, dz) {
  return (bases ?? []).map(({ found, base }) => {
    const spec = MOVE_AS[found.kind];
    if (!spec) return null;
    return { tool: spec.tool, input: {
      id: found.raw.id,
      ...(spec.point ? { position: found.raw.position }
                     : { [spec.pts]: found.raw[spec.pts] }),
      ...carry(found.raw, spec.keep),
      level_m: +(base + dz).toFixed(3),
    } };
  }).filter(Boolean);
}

async function endGizmoDrag(ev) {
  const d = gizmoDrag;
  gizmoDrag = null;
  controls.enabled = true;
  // Guarded, and it is not defensive noise: releasePointerCapture THROWS
  // NotFoundError when the element does not hold capture for that pointer, and
  // it sits ahead of every commit below — so one throw here silently abandons
  // the whole drag, for x and y and the ring as much as for lift. The drag looks
  // right the entire time (the preview moves, the HUD counts) and then simply
  // does not happen, which is the worst shape a bug can have in a direct
  // manipulation tool.
  try { renderer.domElement.releasePointerCapture?.(ev.pointerId); } catch { /* not held */ }
  showGizmoHud(null);
  clearGhost();
  // the preview is put back unconditionally: either the ops apply and loadDesign
  // rebuilds from the file, or nothing applied and the scene would otherwise sit
  // where it was dropped while the file says otherwise
  for (const n of d.nodes) { n.o.position.copy(n.base); n.o.rotation.y = n.baseRotY;
                             n.o.rotation.x = n.baseRotX; }
  if (!d.engaged) { renderGizmo(); return; }
  if (d.part === "lift") {
    try {
      const ops = liftOps(d.bases, d.dz);
      if (ops.length) await postOps(ops, `lifted ${d.dz >= 0 ? "+" : ""}${fmtLen(d.dz, 2)}`);
      else renderGizmo();
    } catch (e) {
      log(String(e?.message ?? e), "warn");
      renderGizmo();
    }
    return;
  }
  if (d.part === "tiltring") {
    try {
      const spec = MOVE_AS[d.kind];
      const next = +normalizeDeg(d.base + d.deg).toFixed(1);
      const ops = spec ? [{ tool: spec.tool, input: { id: d.raw.id,
        ...(spec.point ? { position: d.raw.position } : { [spec.pts]: d.raw[spec.pts] }),
        ...carry(d.raw, spec.keep), tilt_deg: next } }] : [];
      if (ops.length) await postOps(ops, `${d.raw.id} leans ${next}°`);
      else renderGizmo();
    } catch (e) {
      log(String(e?.message ?? e), "warn");
      renderGizmo();
    }
    return;
  }
  if (d.part === "ring") {
    try {
      const ops = rotateOps(d.kind, d.raw, d.deg);
      if (ops.length) await postOps(ops, `${d.raw.id} turned ${d.deg.toFixed(1)}°`);
      else renderGizmo();
    } catch (e) {
      log(String(e?.message ?? e), "warn");
      renderGizmo();
    }
    return;
  }
  if (!(await moveSelection(d.dx, d.dy, []))) renderGizmo();
}
// ── GIZMO-END ──

// TYPE AN EXACT DISTANCE WHILE AN ARROW IS HELD: 1 . 5 then Enter moves exactly 1.5 m
// along it (a minus goes west, south or down); Escape cancels the drag. In the capture phase,
// so a digit or F does not also reach the shortcuts while the user types a number.
addEventListener("keydown", ev => {
  const d = gizmoDrag;
  if (!d || !["x", "y", "lift"].includes(d.part)) return;
  const t = typeDistance(d.typed ?? "", ev.key);
  if (!t.handled) return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  if (t.cancel) { d.engaged = false; endGizmoDrag({ pointerId: d.pointerId }); return; }
  d.typed = t.buffer;
  d.engaged = true;
  const v = t.value ?? 0;
  if (d.part === "lift") {
    d.dz = v;
    for (const n of d.nodes) n.o.position.set(n.base.x, n.base.y + v, n.base.z);
  } else {
    d.dx = d.part === "x" ? v : 0;
    d.dy = d.part === "y" ? v : 0;
    previewMove(d.nodes, d.dx, d.dy);
  }
  const which = d.part === "x" ? "east" : d.part === "y" ? "north" : "up";
  showGizmoHud(`${which} ${t.buffer || "0"} m — typed · Enter to apply, Esc to cancel`);
  if (t.done) endGizmoDrag({ pointerId: d.pointerId });
}, true);


// ── EXTENSIONS ────────────────────────────────────────────────────────────
//
// pedon/EXTENSIONS.md is the contract. `host` is the full set of capabilities
// this app can hand out; extensions.js gives each extension only the slices its
// manifest declared, which is why an over-broad manifest is visible in review
// rather than being the silent default.
//
// Note what is NOT here: no filesystem, no `currentDesign` by reference, no
// `fetch`. `ops.apply` is POST /api/ops — the one write path every hand drag and
// model op already takes — so an extension's edit is judged by the
// same execute() + validate(), and a refusal reaches the user the same way.
const extensions = createRegistry();
const extensionHost = {
  ops: () => ({ apply: (ops, what) => postOps(ops, what) }),
  // a COPY, so an extension cannot mutate the live document behind the ops path
  design: () => ({ get: () => structuredClone(currentDesign ?? {}),
                   byId: id => structuredClone(rawById(currentDesign, id) ?? null) }),
  site: () => ({ get: () => structuredClone(siteCache ?? {}) }),
  // plantCatalog, NOT `palette`: `palette` is the picker's merged list of this
  // design's plants plus the model library, while plantCatalog is the full
  // record from data/plant_palette.json — the only one carrying cat_safe and its
  // evidence. An extension asking "is this safe" must get the cited record.
  assets: () => ({ plant: species => structuredClone(
                     plantCatalog.find(p => p.species === species) ?? null) }),
  selection: perm => (perm === "selection:write"
    ? { get: () => [...selection], set: ids => setSelection(ids) }
    : { get: () => [...selection] }),
  // talking to the user includes writing a size the way the project reads sizes (units.js):
  // an extension shows a plant's mature size in feet and inches without importing the app
  ui: () => ({ log: (msg, level) => log(msg, level), size: plantSize, pair: sizePair,
              parseLen, lenField, lengthUnit }),
  storage: () => ({
    get: k => { try { return localStorage.getItem(`ext:${k}`); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(`ext:${k}`, v); } catch { /* private mode */ } },
  }),
};
for (const ext of [plantInspector]) extensions.load(ext, extensionHost);
for (const p of extensions.problems()) log(`extension — ${p}`, "warn");

/**
 * Where on screen the single selected object is, so the inspector can sit beside
 * it. Returns null when nothing is selected or the object has no geometry yet —
 * the card then stays hidden rather than parking itself in a corner.
 */
function selectionAnchor() {
  if (selection.size !== 1 || !designGroup) return null;
  const want = [...selection][0];
  let node = null;
  designGroup.traverse(o => {
    if (node || o.isSprite) return;
    let owner = o;
    while (owner && owner.userData.id === undefined) owner = owner.parent;
    if (owner?.userData.id === want) node = owner;
  });
  if (!node) return null;
  const box = new THREE.Box3().setFromObject(node);
  if (box.isEmpty()) return null;
  // the TOP centre: a card beside an object's middle overlaps it on a tall shrub,
  // and the thing you are editing must stay visible while you edit it
  const p = new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y,
                              (box.min.z + box.max.z) / 2).project(camera);
  if (p.z > 1) return null;                       // behind the camera
  const r = renderer.domElement.getBoundingClientRect();
  return { x: r.left + (p.x * 0.5 + 0.5) * r.width,
           y: r.top + (-p.y * 0.5 + 0.5) * r.height };
}

/**
 * Save where the camera is now, by name, into the owner half of site.json.
 *
 * The height is stored ABOVE THE GROUND at that point, not as an absolute: that
 * is `look`'s convention, so the saved record IS a stored look() call and needs
 * no second frame anywhere. It also survives the terrain being re-derived — the
 * camera follows the ground, which is what a garden viewpoint should do.
 */
async function saveViewpointHere() {
  const name = (window.prompt("Name this view (e.g. from the kitchen window)") ?? "").trim();
  if (!name) return;
  const t = controls.target;
  const gEye = heightAt(camera.position.x, camera.position.z);
  const eyeEnu = worldToEnu(camera.position);
  const tgtEnu = worldToEnu(t);
  const gTgt = heightAt(t.x, t.z);
  const v = viewpointFrom({
    eye: { x: eyeEnu[0], z: eyeEnu[1], y: camera.position.y },
    target: { x: tgtEnu[0], z: tgtEnu[1], h: t.y - (Number.isFinite(gTgt) ? gTgt : 0) },
    ground: gEye, name,
  });
  const bad = viewpointProblems(v);
  if (bad.length) { log(`not saved — ${bad.join("; ")}`, "err"); return; }
  const ok = await updateSite(site => {
    site.viewpoints = upsertViewpoint(site.viewpoints, v);
  });
  if (!ok) { log("could not save the viewpoint", "err"); return; }
  await loadSite(false);
  renderViewpointList();
  log(`view "${name}" saved — any session can now look from here`, "ok");
}

/** The dock's "Go to a view" menu: every saved view, then saving this one. */
function viewPickItems() {
  const vs = siteCache?.viewpoints ?? [];
  return [...(vs.length ? vs.map(v => ({ id: `view.goto:${v.name}`, title: v.name }))
                        // not a command: a line that says why the list is empty
                        : [{ title: "No saved views yet — save one below", id: "" }]),
          "-",
          { id: "view.saveViewpoint", title: "Save this view as…" },
          { id: "app.views", title: "All views and photos…" }];
}

/** Put the camera back where a saved viewpoint was standing. */
let lastViewpoint = null;               // what [ and ] step from
function goToViewpoint(v) {
  lastViewpoint = v.name;
  const [ex, ey, eh] = v.eye;
  const [lx, ly, lh] = v.look_at;
  const eW = enuToWorldPoint(ex, ey, 0), lW = enuToWorldPoint(lx, ly, 0);
  const eG = heightAt(...(w => [w.x, w.z])(enuToWorld(ex, ey, 0)));
  const lG = heightAt(...(w => [w.x, w.z])(enuToWorld(lx, ly, 0)));
  camera.position.set(eW.x, (Number.isFinite(eG) ? eG : 0) + (eh ?? 1.65), eW.z);
  controls.target.set(lW.x, (Number.isFinite(lG) ? lG : 0) + (lh ?? 1.2), lW.z);
  controls.update();
  log(`looking from "${v.name}"`, "ok");
}

/**
 * The eye-level shots, as a browsable strip rather than only a modal.
 *
 * A browsable strip makes recent passes easy to compare, while the modal
 * supports studying one frame closely. The stills are numbered files on disk;
 * list them beside the other existing views.
 */
async function renderShotList() {
  const box = document.getElementById("shotsList");
  if (!box) return;
  box.innerHTML = "";
  // List THE PHOTOGRAPHS THAT EXIST. Broker ids are v_<uuid>; hard-coded
  // v_0001 through v_0008 would show obsolete files instead of current renders.
  let r;
  try { r = await fetch("/api/views?n=8").then(x => x.json()); }
  catch { r = null; }
  const views = r?.ok ? r.views : [];
  if (!views.length) {
    const e = document.createElement("div");
    e.className = "hint";
    e.textContent = "no photographs yet — “Retake photos” takes eight from standing "
                  + "height on the design's own paths";
    box.appendChild(e);
    return;
  }
  // STALE IS A FACT THE PANEL MUST STATE. A photograph older than the design it
  // claims to show is worse than none: it is the previous garden, presented as
  // this one, and every judgement made from it is about something that no
  // longer exists.
  const newest = views[0].mtime;
  if (r.design_mtime && r.design_mtime > newest + 1000) {
    const warn = document.createElement("div");
    warn.className = "hint bad";
    warn.textContent = `these are ${describeAge(newest)} — the design has changed since. `
                     + "Press “Retake photos”.";
    box.appendChild(warn);
  }
  for (const v of views) {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "shot";
    const img = document.createElement("img");
    img.src = v.url; img.loading = "lazy";
    img.alt = `photograph of the garden, ${describeAge(v.mtime)}`;
    img.onerror = () => cell.remove();
    cell.appendChild(img);
    cell.onclick = () => window.open(v.url, "_blank");
    cell.title = `${describeAge(v.mtime)} · ${(v.bytes / 1024).toFixed(0)} KB`
               + " — click to open it full size";
    box.appendChild(cell);
  }
}

/**
 * The path-traced render, from the Views surface.
 *
 * Expose the capability in the viewer where the user works. The button runs
 * tools/photoreal.py through the dev server rather than reimplementing it:
 * the sun, standing point, which-way-is-up measurement and BEARING-UNVERIFIED
 * naming all live there.
 */
function renderPhotorealChoices() {
  const sel = document.getElementById("prSubject");
  if (!sel) return;
  const was = sel.value;
  sel.innerHTML = "";
  const add = (value, label, group) => {
    const o = document.createElement("option");
    o.value = value; o.textContent = label; o.dataset.group = group;
    sel.appendChild(o);
  };
  // SAVED VIEWS FIRST: places the user identifies as important viewing positions
  for (const v of siteCache?.viewpoints ?? []) add(`vp:${v.name}`, v.name, "saved");
  for (const [key] of DESIGN_KINDS) {
    if (key === "plants" || key === "objects") continue;   // too small to frame
    for (const o of currentDesign?.[key] ?? []) add(`id:${o.id}`, o.id, "design");
  }
  for (const a of siteCache?.areas ?? []) add(`id:${a.name}`, a.name, "area");
  if (was) sel.value = was;
  if (!sel.options.length) add("", "nothing to point at yet", "");
}

document.getElementById("btnPhotoreal")?.addEventListener("click", async () => {
  const btn = document.getElementById("btnPhotoreal");
  const msg = document.getElementById("prMsg");
  const out = document.getElementById("prOut");
  const pick = document.getElementById("prSubject")?.value || "";
  if (!pick) { msg.textContent = "pick something to point the camera at"; return; }
  btn.disabled = true;
  // SAY WHAT IT COSTS, because it costs minutes and a button that looks stuck is
  // indistinguishable from one that is
  msg.textContent = prReused
    ? "path-tracing… about half a minute."
    : "exporting the garden (about a minute and a half the first time), then "
      + "path-tracing it. This draws the real geometry, so it is slow on purpose.";
  out.innerHTML = "";
  const body = pick.startsWith("vp:") ? { viewpoint: pick.slice(3) }
                                      : { subject: pick.slice(3) };
  try {
    const r = await fetch("/api/photoreal", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, samples: 24, width: 960, height: 600,
                             reuse: prReused }),
    });
    const j = await r.json();
    if (!j.ok) { msg.textContent = j.detail || j.error || "it did not render"; return; }
    prReused = true;               // the scene is on disk now; re-framing is cheap
    msg.textContent = `${j.render_s}s at ${j.samples} samples · ${j.camera_from}`;
    const img = document.createElement("img");
    img.src = `${j.url}?t=${Date.now()}`;      // the file is overwritten in place
    img.className = "pr-img";
    img.alt = "a path-traced view of the garden";
    img.onclick = () => window.open(j.url, "_blank");
    out.appendChild(img);
    if (j.WARNING) {
      const w = document.createElement("div");
      w.className = "hint bad";
      w.textContent = "The shadows point an arbitrary direction — north has not "
                    + "been set on this capture, so the sun's height is real and "
                    + "its bearing is not.";
      out.appendChild(w);
    }
    log(`path-traced ${j.camera_from} in ${j.render_s}s`, "ok");
  } catch (e) {
    msg.textContent = String(e?.message ?? e).slice(0, 160);
  } finally {
    btn.disabled = false;
  }
});
let prReused = false;

/** "2 minutes ago" — a photograph's age is the thing you want to know about it. */
function describeAge(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  if (s < 172800) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
}

/**
 * Open the row just created for renaming, with its text selected.
 *
 * Default names need an obvious rename action, or every area stays `area 6`.
 * Select the placeholder in the new row so typing replaces it; Escape keeps
 * the default.
 */
function renameInPlace(listId, name) {
  requestAnimationFrame(() => {
    const field = [...document.querySelectorAll(`#${listId} input.nm`)]
      .find(el => el.value === name);
    if (!field) return;
    field.focus();
    field.select();           // type and the default is replaced
  });
}

/** The saved views, in the Views surface beside the shots. */
function renderViewpointList() {
  const box = document.getElementById("vpList");
  if (!box) return;
  const list = siteCache?.viewpoints ?? [];
  box.innerHTML = "";
  if (!list.length) {
    const e = document.createElement("div");
    e.className = "hint";
    e.textContent = "no saved views yet — point the camera somewhere you like, then “Save this view as…”";
    box.appendChild(e);
    return;
  }
  for (const v of list) {
    const row = document.createElement("div");
    row.className = "drow";
    const nm = document.createElement("button");
    nm.className = "linkish nm";          // .nm: a row's name, which is never hover-hidden
    nm.textContent = v.name;
    nm.title = `standing at ${v.eye.slice(0, 2).join(", ")} m, looking at `
             + `${v.look_at.slice(0, 2).join(", ")} m — click to put the camera back · [ ] step through saved views`;
    nm.onclick = () => goToViewpoint(v);
    const del = document.createElement("button");
    del.className = "eye"; del.textContent = "✕"; del.title = "forget this view";
    del.onclick = async () => {
      await updateSite(site => {
        site.viewpoints = (site.viewpoints ?? []).filter(x => x.name !== v.name);
      });
      await loadSite(false);
      renderViewpointList();
    };
    row.append(nm, del);
    box.appendChild(row);
  }
}

/** What you can do to the current selection, as the inspector's footer. */
function selectionActions(kind) {
  const click = id => () => document.getElementById(id)?.click();
  const acts = [
    { title: "Zoom to it", hint: "fill the view with it (F)", run: click("btnFrameSel") },
    { title: "Duplicate", hint: "another one, offset", run: click("btnSelDuplicate") },
    // the inspector is this command's clickable home: copying is the one
    // way anything crosses a design boundary, so it must be findable without
    // knowing the hotkey
    { id: "edit.copy", title: "Copy", hint: "⌘C — paste into any design",
      run: () => copySelection() },
  ];
  if (kind === "plant")
    acts.push({ title: "Change species", hint: "make it whatever is picked in the dock",
                run: click("btnSubstitute") });
  acts.push({ title: "Hide", hint: "⇧S solos instead", run: () => {
    for (const id of selection) setObjectView(id, { hidden: true });
    applyObjectVisibility(designGroup, hiddenObjectIds());
    renderObjectList();
  } });
  // ALIGN and GROUP only mean anything for more than one thing, which is why
  // they are conditional rather than disabled: a row of buttons where half are
  // greyed out is a row that has to be read before it can be used.
  if (selection.size > 1) {
    acts.push({ title: "Group", hint: "⌘G — hides, locks and moves as one",
                run: click("btnSelGroup") });
    acts.push({ title: "Align…", hint: "line them up or space them evenly. Axes are "
                + "COMPASS, so they mean the same thing whichever way the camera points",
                run: () => {
                  const sel = document.getElementById("alignHow");
                  if (!sel) return;
                  // the panel's <select> is the state; opening it where it lives
                  // keeps one implementation of the nine alignments
                  openPanelAt("design");
                  sel.focus();
                  log("choose an alignment — the axes are compass, not screen");
                } });
  }
  acts.push({ title: "Delete", danger: true, hint: "⌘Z undoes it", run: click("btnSelDelete") });
  return acts;
}

function renderProperties() {
  // The shell mounts LAST, and loadDesign() runs during boot — so this can be
  // reached before the card exists. A ReferenceError here would blank the whole
  // viewer at startup, which is the failure mode objects.js already guards
  // against when a generated builder will not parse.
  if (typeof inspector === "undefined" || !inspector) return;
  const box = inspector.body;
  box.innerHTML = "";
  const ids = [...selection];
  if (ids.length !== 1) { inspector.hide(); return; }
  const found = rawById(currentDesign, ids[0]);
  if (!found) { inspector.hide(); return; }
  const { kind, raw } = found;

  // AN EXTENSION MAY OWN THIS KIND. Check before the built-in table, whose
  // path, edge, bed, patio, steps and object rows do not include plants.
  // The registry lets a module provide the missing inspector.
  const ins = extensions.inspectorFor(kind);
  const anchor = selectionAnchor();
  const label = raw.common ? `${raw.common}` : `${kind} ${raw.id}`;
  if (ins?.render) {
    inspector.show(label, anchor);
    inspector.setActions(selectionActions(kind));
    box.innerHTML = "";
    try {
      if (ins.render(box, { kind, raw }, ins._ctx) !== false) return;
    } catch (e) {
      // a third-party panel that throws must not take the inspector down
      log(`${ins._from}: inspector failed — ${e.message}`, "warn");
      inspector.hide();
      return;
    }
  }
  if (!MOVE_AS[kind]) { inspector.hide(); return; }
  inspector.show(label, anchor);
  inspector.setActions(selectionActions(kind));
  box.innerHTML = "";

  const head = document.createElement("div");
  head.className = "hint";
  head.textContent = raw.id;
  box.appendChild(head);

  for (const f of editableFields(kind)) {
    const row = document.createElement("div");
    row.className = "prow";
    const label = document.createElement("label");
    // A SIZE IN THE PROJECT'S UNIT: in imperial a length box shows and takes feet and inches, as a
    // plant tag gives them (units.js parseLen); coordinates stay metres, the site's own frame
    const typedLen = f.type === "number" && /_m$/.test(f.name) && f.name !== "x_m" && f.name !== "y_m"
      && displayUnits() === "imperial";
    const smallLen = f.name === "riser_m" || f.name === "going_m";
    label.textContent = f.name === "x_m" ? "x (m)" : f.name === "y_m" ? "y (m)"
      : f.name.replace(/_m$/, ` (${typedLen ? lengthUnit() : "m"})`).replace(/_deg$/, " (°)").replace(/_/g, " ");
    row.appendChild(label);

    let input;
    if (f.type === "select" && !f.free) {
      input = document.createElement("select");
      for (const o of ["", ...f.options]) {
        const opt = document.createElement("option");
        opt.value = o; opt.textContent = o || "(none)";
        input.appendChild(opt);
      }
      input.value = raw[f.name] ?? "";
    } else if (f.type === "select") {
      // Free text WITH suggestions: the library must not cap the design, and
      // a closed <select> would impose that limit in the interface.
      input = document.createElement("input");
      input.type = "text";
      input.setAttribute("list", `opts_${f.name}`);
      input.value = raw[f.name] ?? "";
      let dl = document.getElementById(`opts_${f.name}`);
      if (!dl) {
        dl = document.createElement("datalist");
        dl.id = `opts_${f.name}`;
        for (const o of f.options) {
          const opt = document.createElement("option");
          opt.value = o;
          dl.appendChild(opt);
        }
        box.appendChild(dl);
      }
    } else {
      input = document.createElement("input");
      input.type = f.type === "number" && !typedLen ? "number" : "text";
      if (f.type === "number" && !typedLen) input.step = "0.01";
      if (typedLen) input.placeholder = smallLen ? "e.g. 7 in" : "e.g. 2 ft 7 in";
      input.value = f.name === "x_m" ? (raw.position?.[0] ?? "")
                  : f.name === "y_m" ? (raw.position?.[1] ?? "")
                  : typedLen ? lenField(raw[f.name]) : (raw[f.name] ?? "");
    }
    input.title = (fieldHelp[f.name] ? fieldHelp[f.name] + "\n\n" : "")
                + "Every edit here is checked against the real ground, and undoable.";
    label.title = input.title;
    if (fieldHelp[f.name]) {
      // on the label as a tooltip AND, for the one that actually confuses people,
      // as visible text: a hint nobody hovers over is a hint nobody reads
      label.style.cursor = "help";
    }
    input.onchange = async () => {
      try {
        // typed feet and inches become metres HERE, the one seam: everything after is metres
        const typed = typedLen && input.value.trim() ? parseLen(input.value, { small: smallLen }) : null;
        if (typedLen && input.value.trim() && typed === null)
          throw new Error(`"${input.value}" is not a length — try 2 ft 7 in, 31 in, 2.5 ft or 0.8 m`);
        const value = typedLen ? (typed === null ? "" : String(typed)) : input.value;
        const ops = propertyOps(kind, raw, f.name, value);
        if (!ops.length) return;
        await postOps(ops, `${raw.id} ${f.name} → ${typedLen ? (fmtLen(typed, 2) || "(cleared)") : (input.value || "(cleared)")}`);
      } catch (e) {
        log(String(e?.message ?? e), "warn");
        input.value = typedLen ? lenField(raw[f.name]) : (raw[f.name] ?? "");
      }
    };
    row.appendChild(input);
    box.appendChild(row);
    // level_m's effect is not obvious from its name. Explain it visibly so the
    // user can tell a flat top from an edge that follows the slope.
    if (f.name === "level_m" && !MOVE_AS[kind]?.point) {
      const note = document.createElement("div");
      note.className = "hint";
      note.style.margin = "-2px 0 5px 98px";
      note.textContent = raw[f.name] == null
        ? "following the ground at a constant height — set a level for a flat top"
        : "flat top at this level: on a slope one end stands taller. Clear it to follow the ground.";
      box.appendChild(note);
    }
  }
}

function renderSelection() {
  const chips = document.getElementById("selChips");
  const bar = document.getElementById("selBar");
  const acts = document.getElementById("selActions");
  chips.innerHTML = "";
  const has = selection.size > 0;
  bar.hidden = !has;
  acts.hidden = !has;
  for (const id of selection) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.append(document.createTextNode(id));
    const x = document.createElement("button");
    x.textContent = "×"; x.title = `deselect ${id}`;
    x.onclick = () => { selection.delete(id); applySelectionHighlight(); renderSelection(); };
    chip.appendChild(x);
    chips.appendChild(chip);
  }
  // Show measured selection sizes without a round trip. rawById is the one
  // id-to-object lookup and shares DESIGN_KINDS rather than duplicating it.
  const info = document.getElementById("selMeasure");
  if (has) {
    const objs = designObjects().filter(o => selection.has(o.id));
    if (objs.length === 1) {
      const raw = rawById(currentDesign, objs[0].id)?.raw;
      info.textContent = raw ? measure(raw, objs[0].kind).text : "";
    } else {
      let len = 0, area = 0;
      for (const o of objs) {
        const raw = rawById(currentDesign, o.id)?.raw;
        if (!raw) continue;
        const m = measure(raw, o.kind);
        len += m.len ?? 0; area += m.area ?? 0;
      }
      info.textContent = [len ? `${fmtLen(len)} total` : "", area ? `${fmtArea(area)} total` : ""]
        .filter(Boolean).join(" · ");
    }
  } else info.textContent = "";

  // Only a plant has a species to swap, so the button is live only when the
  // selection holds one — offering it for a bed is an action that could do
  // nothing but log a refusal.
  document.getElementById("btnSubstitute").disabled =
    ![...selection].some(id => rawById(currentDesign, id)?.kind === "plant");

  renderObjectList();
}

/**
 * Light the selected rows in the Objects list, and bring one into view.
 *
 * Selecting in either the scene or the list highlights the corresponding row
 * and object. Bring an off-screen row into view so the user need not search
 * through hundreds of entries for the selected object.
 *
 * Classes are toggled on the rows that exist rather than rebuilding the list:
 * a rebuild on every click loses the scroll position, and the tree is also the
 * thing you are scrolling THROUGH while picking.
 */
function syncObjectRows() {
  const rows = document.querySelectorAll("#objList [data-object-id]");
  let first = null;
  for (const row of rows) {
    const on = selection.has(row.dataset.objectId);
    row.classList.toggle("sel", on);
    if (on && !first) first = row;
  }
  // only when it is out of sight: scrolling a row that is already visible yanks
  // the list under the cursor mid-click
  if (first) {
    const box = document.getElementById("objList");
    const r = first.getBoundingClientRect(), b = box.getBoundingClientRect();
    if (r.top < b.top || r.bottom > b.bottom) first.scrollIntoView({ block: "nearest" });
  }
}

function setSelection(ids) {
  // a locked group never enters the selection, which is what makes lock mean
  // anything: btnSelDelete and the agent both act on the selection
  selection.clear();
  for (const id of selectableIds(ids, designGroups())) selection.add(id);
  applySelectionHighlight();
  // Everything that depends on WHAT IS SELECTED belongs in this one function,
  // so the Objects list, deselect and the agent's --selection all update the
  // property panel and handles. Update each view independently: an exception
  // in renderProperties must not prevent renderHandles from showing controls.
  for (const render of [renderSelection, renderProperties, renderHandles, renderGizmo, syncObjectRows]) {
    try { render(); } catch (e) { console.error("selection render failed:", e); }
  }
}

function pickDesignObject(ev) {
  if (!designGroup?.visible || !designsGroup.visible) return null;
  pointerRay(ev);
  const hit = raycaster.intersectObject(designGroup, true)[0];
  if (!hit) return null;
  let o = hit.object;
  while (o && o.userData.id === undefined) o = o.parent;
  // a locked group is furniture — you can see it and it still occludes, you
  // just cannot grab it by accident; a hidden one is not there to be clicked
  return pickableId(o?.userData.id ?? null, designGroups(), hiddenGroups(),
                    hiddenObjectIds());
}

// Align/distribute goes through moveOps like a drag does, so a plant aligned
// onto the house or off the scan is REJECTED with the reason instead of written
//. Lining things up is not a licence to leave the yard.
document.getElementById("alignHow").onchange = async (ev) => {
  const how = ev.target.value;
  ev.target.value = "";                        // it is an action, not a setting
  if (!how || !selection.size) return;
  const items = [];
  for (const id of selection) {
    const found = rawById(currentDesign, id);
    if (found && (found.kind === "plant" || MOVE_AS[found.kind])) items.push({ id, ...found });
  }
  if (items.length < 2) { log("select at least two things to line up", "warn"); return; }
  const deltas = how.startsWith("spread_")
    ? spreadDeltas(items, how.slice(-1))
    : alignDeltas(items, how);
  if (!deltas.length) {
    log(how.startsWith("spread_") && items.length < 3
        ? "spacing evenly needs three or more — two are already evenly spaced"
        : "already lined up", "ok");
    return;
  }
  const ops = [];
  for (const d of deltas) {
    try { ops.push(...moveOps(d.kind, d.raw, d.dx, d.dy)); }
    catch (e) { log(`${d.id}: ${e?.message ?? e}`, "warn"); }
  }
  if (!ops.length) { log("nothing in the selection can move", "warn"); return; }
  await snapshotWorking();
  if (await postOps(ops, `${how} ${deltas.length}`))
    log(`moved ${deltas.length} of ${items.length}`, "ok");
};

document.getElementById("btnSelClear").onclick = () => setSelection([]);
document.getElementById("btnSelGroup").onclick = () => groupSelection();

// Deleting is deterministic — it can only remove violations, never create one —
// so it happens instantly here instead of costing a model call.
document.getElementById("btnSelDuplicate").onclick = async () => {
  if (!selection.size) return;
  // An op, like everything else the hand does — so a copy dropped on the
  // house, off the scan or into another plant's planting hole is
  // REJECTED with the reason rather than written to the file.
  const ops = [];
  const made = [];
  const plantedAt = [];              // a plant copy gets its id from the server
  for (const id of selection) {
    const found = rawById(currentDesign, id);
    if (!found || (found.kind !== "plant" && !MOVE_AS[found.kind])) continue;
    try {
      const o = duplicateOps(found.kind, found.raw);
      ops.push(...o);
      const input = o[o.length - 1].input;
      if (input.id) made.push(input.id);
      else for (const pl of input.plants ?? []) plantedAt.push(pl.position.join(","));
    } catch (e) {
      log(`${id}: ${e?.message ?? e}`, "warn");
    }
  }
  if (!ops.length) { log("nothing in the selection can be duplicated", "warn"); return; }
  await snapshotWorking();
  const n = made.length + plantedAt.length;
  if (await postOps(ops, `duplicate ${n}`)) {
    // the plants' ids exist only after the write, so they are read back off the
    // reloaded design by where they landed
    const fresh = (currentDesign?.plants ?? [])
      .filter(pl => plantedAt.includes((pl.position ?? []).join(",")))
      .map(pl => pl.id);
    setSelection([...made, ...fresh]);        // the copies are what you want selected
    log(`duplicated ${n}: ${[...made, ...fresh].join(", ")}`, "ok");
  }
};

document.getElementById("btnSelDelete").onclick = async () => {
  if (!selection.size) return;
  const ids = [...selection];
  await snapshotWorking();          // durable archive; Back is the fast path
  // An op, like placing and dragging. Deleting looks safe and is not: pull out a
  // retaining wall and the terrace it held is standing on nothing, which is the
  // class float_check measures. execute() also owns the complete kind list,
  // so deletion cannot omit steps or another kind through a stale local list.
  if (await postOps([{ tool: "remove_objects", input: { ids } }], "delete")) {
    setSelection([]);
    log(`deleted ${ids.length} object(s): ${ids.join(", ")}`, "ok");
  }
};

// ------------------------------------------------------- placing by hand
// The owner puts a plant down, or drags one that is already there — and it goes
// through the SAME validators a model-emitted op does.
//
// That constraint is the design, and it is why nothing here writes design.json.
// agent.execute() + validate() already own every rule a site has (spacing at
// mature spread, cut/fill, retaining limits, on-scanned-ground, the area
// restriction). A hand edit that bypasses them admits floating or off-scan
// geometry the owner expects to be trustworthy. The viewer emits an OP down
// the one pipeline, making each edit undoable and replayable in the timeline.
//
// The block below is pure — no DOM, no THREE, no closure over module state —
// because tests/js/ui_place.test.mjs extracts it between the two markers and
// runs it. Dragging cannot be tested headlessly; which op a pick emits can, and
// that is the half that decides whether the constraint above holds.
// ── HAND-EDIT-START ──
/**
 * A metre, rounded the way every stored coordinate in this project is written.
 *
 * A raycast hit carries full float precision and what lands on disk does not —
 * agent.STORED_POSITION_TOL_M (0.015) exists because of exactly that. The `+ 0`
 * is not decoration: -0.001 rounds to -0, which survives JSON and turns up as a
 * diff on a design nobody edited.
 */
const m2 = v => +v.toFixed(2) + 0;

const shift = (pts, dx, dy) => pts.map(([x, y]) => [m2(x + dx), m2(y + dy)]);

/**
 * The keys `raw` actually has, and only those.
 *
 * An absent field must stay absent rather than become a default: a bed handed
 * level_m: 0 is a terrace at sea level, not a bed lying on the ground.
 */
const carry = (raw, keys) => Object.fromEntries(
  keys.filter(k => raw?.[k] !== undefined && raw?.[k] !== null).map(k => [k, raw[k]]));

/**
 * Every design key and what one of its objects is called — ONE table.
 *
 * Share the table between designObjects and renderSelection so every kind,
 * including steps, is selectable, measurable and movable.
 */
// Include objects so lanterns, basins, moon gates and boulders are selectable,
// measurable, movable and editable just like the other design kinds.
// DESIGN_KINDS lives in design_doc.js because whole-document replacement must
// CLEAR that same list. Sharing it prevents a kind such as steps being omitted.

/** The stored object behind an id, and what kind it is, or null. */
function rawById(design, id) {
  for (const [key, kind] of DESIGN_KINDS) {
    const raw = (design?.[key] ?? []).find(o => o.id === id);
    if (raw) return { kind, raw };
  }
  return null;
}

// kind -> the op that re-places it. `pts` is the geometry a move shifts; `keep`
// is every field the op must carry or the move silently redesigns the object;
// `rename` is the one asymmetry in the vocabulary — set_edge is SUBMITTED as
// edge_material and STORED as material, so passing the stored name straight
// back raises "set_edge missing 'edge_material'".
const MOVE_AS = {
  path:  { tool: "set_path",   pts: "spline",  keep: ["width_m", "material", "level_m"] },
  edge:  { tool: "set_edge",   pts: "spline",  keep: ["height_m", "retains", "level_m",
                                                      "thickness_m", "batter_deg", "footing_depth_m"],
           rename: { material: "edge_material" } },
  bed:   { tool: "upsert_bed", pts: "polygon", keep: ["mulch", "level_m"] },
  patio: { tool: "set_patio",  pts: "polygon", keep: ["material", "purpose", "level_m"] },
  steps: { tool: "set_steps",  pts: "spline",  keep: ["width_m", "riser_m", "going_m", "material"] },
  // An object is a POINT, not a run — `pts` is "position" and moveOps/reshapeOps
  // treat it specially, the way a plant already is. `kind` is carried like any
  // other field because place_object replaces wholesale and would otherwise turn
  // every lantern into an unnamed placeholder on its first move.
  object: { tool: "place_object", pts: "position", point: true,
            keep: ["kind", "height_m", "width_m", "rotation_deg", "material", "note",
                   "level_m", "tilt_deg"] },
};


/**
 * What a click can put down, in the order the owner should want it.
 *
 * The species ALREADY IN THIS DESIGN come first with this design's mature
 * sizes. This supports repetition: 8–12 species in odd-numbered drifts rather
 * than a different species for nearly every plant. Their sizes are facts about this site, not
 * numbers typed into the viewer.
 *
 * The library shapes follow, so something new is still reachable. A model name
 * is a SHAPE, not a species, so those entries place with `asset` set — the one
 * field assetName() honours ahead of every species regex — at the size the
 * library really draws them, read off its manifest. Below minModelHeightM the
 * router refuses the model, and an owner who picked a shape would get a
 * procedural blob instead of the thing they pointed at.
 *
 * A plant may legally omit its mature size (the design schema requires only
 * id/species/position); place_plants may not. Such an entry is still offered,
 * marked unplaceable, rather than being placed at a size nobody measured.
 */
/**
 * The three facts a person actually chooses a plant on, as English.
 *
 * Native / water / evergreen are what the owner's own shortlist is organised
 * around, and a picker that makes you open a JSON file to find out whether a
 * plant is native is a picker you do not use. Stated ONLY when known: a design
 * row with no shortlist entry must not sprout "deciduous" out of an absent
 * field, which is the difference between a fact and a default.
 *
 * "very_low" is a JSON key, not a word — no raw value reaches a row a person
 * reads.
 */
const WATER_WORDS = { very_low: "very low", low: "low", moderate: "moderate", high: "high" };

function plantFacts(p) {
  const out = [];
  if (p?.ca_native === true) out.push("CA native");
  if (p?.water) out.push(`${WATER_WORDS[p.water] ?? String(p.water).replace(/_/g, " ")} water`);
  if (p?.evergreen === true) out.push("evergreen");
  else if (p?.evergreen === false) out.push("deciduous");
  return out;
}

/**
 * Every plant the owner could place, on one list.
 *
 * Include the design's plants, library shapes and full species shortlist from
 * data/plant_palette.json. Everything available to the design agent through
 * list_assets must also be reachable by the owner.
 *
 * The shortlist FILLS gaps and never overwrites. A design's own numbers are
 * facts about this garden; the file's are facts about the species, and neither
 * is a default for the other. If the file calls Heteromeles 4.5 m and
 * a design's is 3.5 m, overwriting it would move the row from
 * `mounding shrub` to `canopy tree` — the picker would be reorganising the
 * owner's garden to match a reference book.
 */
function paletteEntries(design, manifest = {}, minModelHeightM = 0, catalog = [],
                        routers = {}, policy = {}) {
  const out = [];
  const bySpecies = new Map();
  const byCatalog = new Map(
    (catalog ?? []).map(c => [String(c.species ?? "").trim().toLowerCase(), c]));
  for (const p of design?.plants ?? []) {
    const key = String(p.species ?? "").trim().toLowerCase();
    if (!key) continue;
    const seen = bySpecies.get(key);
    if (seen) { seen.count++; continue; }
    // Carry `flower`: buildPlant() grows a bloom only when the plant declares
    // one. A dropped field is indistinguishable from flowerColour() returning
    // null for no blossom. The palette supplies colours such as Hot Lips
    // #e0554f and Germander sage #3f63b5; the cards must preserve them.
    const e = { source: "design", species: p.species, common: p.common ?? p.species, count: 1,
                ...carry(p, ["mature_spread_m", "mature_height_m", "form", "foliage",
                             "flower", "asset"]) };
    // the facts, and ONLY the facts: sizes and common name stay this site's
    const c = byCatalog.get(key);
    if (c) Object.assign(e, { ca_native: c.ca_native, water: c.water,
                             evergreen: c.evergreen, cat_safe: c.cat_safe,
                             ...carry(c, ["cat_safety", "identity_status", "size_evidence", "mature_height_range_m", "mature_spread_range_m", "flowering_height_range_m", "site_zone", "establishment_irrigation", "aliases"]) });
    bySpecies.set(key, e);
    out.push(e);
  }
  // ...then the rest of their shortlist, deduped against what is already planted
  for (const [key, c] of byCatalog) {
    if (bySpecies.has(key)) continue;
    out.push({ source: "shortlist", species: c.species, common: c.common ?? c.species, count: 0,
               mature_height_m: c.mature_height_m, mature_spread_m: c.mature_spread_m,
               form: c.form, foliage: c.foliage, flower: c.flower,
               ca_native: c.ca_native, water: c.water, evergreen: c.evergreen,
               sun: c.sun, bloom: c.bloom, note: c.note, cat_safe: c.cat_safe,
               ...carry(c, ["cat_safety", "identity_status", "size_evidence", "mature_height_range_m", "mature_spread_range_m", "flowering_height_range_m", "site_zone", "establishment_irrigation", "aliases"]) });
  }
  for (const [name, meta] of Object.entries(manifest ?? {})) {
    const label = name.replace(/_/g, " ");
    out.push({
      source: "library", species: label, common: label, count: 0, asset: name,
      mature_height_m: Number.isFinite(meta?.height_m)
        ? Math.max(meta.height_m, minModelHeightM) : undefined,
      mature_spread_m: Number.isFinite(meta?.spread_m) ? meta.spread_m : undefined,
      // The habit gen_trees.py declared when it BUILT the model. It is the only
      // honest answer for a library row: the species layer sees a nickname
      // ("oak", "stone pine") that no regex in plants.js names, and every model
      // is offered at exactly 4 m, where the size fallback answers "mound" for
      // all of them. Absent stays absent — paletteGroups files an unrecorded
      // habit under its own header instead of guessing one.
      ...(meta?.form ? { form: meta.form } : {}),
    });
  }
    // The library's OBJECTS share the plant shelf so the owner can place a lantern
    // or moon gate by hand. `kind` stays free text as the schema requires; these
    // entries show the kinds the library can DRAW rather than placeholder boxes.
  // injected, not reached for: main.js builds a WebGLRenderer at module scope so
  // the tests slice these pure functions out and evaluate them, where a module
  // import is not in scope. Same reason paletteGroups takes `routers`.
  for (const o of routers.objectCatalog?.() ?? []) {
    out.push({ source: "object", species: o.kind, common: o.label, kind: o.kind,
               count: (design?.objects ?? [])
                        .filter(x => !x.model && routers.resolveKind?.(x.kind) === o.kind).length,
               height_m: o.height_m, width_m: o.width_m, note: o.note,
               mature_height_m: o.height_m,
               mature_spread_m: o.width_m > 0 ? o.width_m : o.height_m });
  }
  // THE OBJECT LIBRARY'S MODELS, on the same shelf: found on Poly Haven, made by
  // the agent, or scanned. `species` is the FILE, so a fetched lantern and the built-in
  // lantern are two rows, not one; `kind` is what the design will say.
  const said = { polyhaven: "free CC0 model", made: "made for this project", scan: "your own scan" };
  for (const c of routers.objectLibrary?.() ?? []) {
    const [w, d, h] = Array.isArray(c.size_m) ? c.size_m : [0, 0, 0.8];
    out.push({ source: "object", species: c.model, common: c.name, kind: c.kind, model: c.model,
               preview: c.preview ?? null,
               count: (design?.objects ?? []).filter(x => x.model === c.model).length,
               height_m: h, width_m: Math.max(w, d), note: said[c.source?.from ?? "scan"] ?? "",
               mature_height_m: h, mature_spread_m: Math.max(w, d) || h });
  }
  for (const e of out) {
    // EXCLUDED only where THIS site says cats have the run of it (project.json policy):
    // elsewhere a known toxicity is a fact on the card, not a refusal
    e.excluded = !!policy?.cats_have_access && e.cat_safe === false;
    e.placeable = !e.excluded && Number.isFinite(e.mature_spread_m) && Number.isFinite(e.mature_height_m);
    // Mature size is HEIGHT × SPREAD. Spread decides whether a plant fits,
    // informs spacing validation and shows whether it will swallow the path.
    e.label = (e.source === "object" || e.common === e.species
                 ? e.common : `${e.common} · ${e.species}`)
      + (e.source === "library" ? " · generic shape" : "")
      + (e.excluded ? " · excluded: toxic to cats" : e.placeable ? ` · ${sizePair(e.mature_height_m, e.mature_spread_m)}` : " · no mature size")
      + plantFacts(e).map(f => ` · ${f}`).join("")
      + (e.count ? ` · ${e.count} planted` : "");
  }
  return out;
}

/**
 * The op for "put THIS at THIS spot" — all a click on the ground ever means.
 *
 * Only schema-legal plant keys survive. A palette entry also carries display
 * fields (label, count, source) and schema/design.schema.json is
 * additionalProperties: false, so spreading the entry into the op would fail
 * the whole design's schema check server-side: every hand placement rejected,
 * with a message about a key the owner never saw.
 */
function objectOp(entry, x, y) {
  const kind = entry?.kind ?? entry?.species;
  if (!kind) throw new Error("pick what to place first");
  if (!Number.isFinite(x) || !Number.isFinite(y))
    throw new Error(`that pick has no position on the ground (${x}, ${y})`);
  // place_object is an UPSERT keyed on id, so a fresh one per placement or the
  // second lantern silently replaces the first. Same counter the duplicate path
  // uses; a collision is a server rejection, not a silent write.
  return { tool: "place_object", input: {
    id: `${kind}_${++copyCounter}`,
    kind,
    position: [m2(x), m2(y)],
    ...(entry.height_m > 0 ? { height_m: entry.height_m } : {}),
    ...(entry.width_m > 0 ? { width_m: entry.width_m } : {}),
    // a library model draws as ITSELF, through the same place_object the agent uses
    ...(entry.model ? { model: entry.model } : {}),
  } };
}

/** The op for putting the current pick on the ground, whatever kind of thing it is. */
function placeOp(entry, x, y) {
  return entry?.source === "object" ? objectOp(entry, x, y) : plantOp(entry, x, y);
}

function plantOp(entry, x, y) {
  if (!entry?.species) throw new Error("pick what to place first");
  if (entry.excluded) throw new Error(`${entry.species} is excluded: known toxic to cats`);
  if (!Number.isFinite(x) || !Number.isFinite(y))
    throw new Error(`that pick has no position on the ground (${x}, ${y})`);
  if (!Number.isFinite(entry.mature_spread_m) || !Number.isFinite(entry.mature_height_m))
    throw new Error(`"${entry.species}" has no mature size recorded and place_plants needs one — `
                    + "spacing is checked at mature spread");
  return { tool: "place_plants", input: { plants: [{
    species: entry.species,
    common: entry.common ?? entry.species,
    position: [m2(x), m2(y)],
    mature_spread_m: entry.mature_spread_m,
    mature_height_m: entry.mature_height_m,
    ...carry(entry, ["form", "foliage", "flower", "asset", "container"]),
  }] } };
}

/**
 * The op list for "this object, moved by (dx, dy) metres".
 *
 * A move is not a new op — it is the object's own upsert with shifted geometry,
 * which is what runs it back through the cut/fill, retaining and
 * on-scanned-ground checks it passed when the model wrote it.
 *
 * A plant's upsert is set_plants, which keeps its id and group membership.
 * remove + place_plants mints a fresh id, dropping the plant from its group.
 *
 * Anything the op vocabulary cannot carry is lost in the move — a bed's depth_m
 * is the live example, since upsert_bed writes id/polygon/mulch/level_m and
 * nothing else. That is a real cost, and the alternative is the parallel
 * write-it-back-whole path this whole section exists to avoid.
 */
/**
 * Every property of a designed object that the owner may change.
 *
 * All properties, including paths and walls, must be editable.
 *
 * Read them from MOVE_AS rather than listing them again. Its `keep` fields
 * must survive every move, so the same table defines editable properties.
 * `rename` is a property too: an edge's material is submitted as edge_material
 * and stored as material, and the user must be able to change it.
 */
/**
 * What each property DOES, in the owner's terms.
 *
 * `level_m` gives an edge a FLAT TOP at that elevation. On a slope one end
 * stands taller and the other is buried: 0.14 m versus 0.25 m exposed on a
 * 0.30 m wall. Clearing the field follows the ground at constant height.
 * Explain this beside the control; the field name alone does not show how to
 * fit an edge to a slope, and rotation is not the remedy.
 */
const fieldHelp = {
  x_m: "east-west position in metres, on the same grid the model designs on. "
     + "Typing it places the thing exactly; dragging places it approximately.",
  y_m: "north-south position in metres. Both are stored to the centimetre.",
  height_m: "how much of it shows above ground. Lower it to let planting read over the top.",
  // ONE entry: a second `level_m:` key silently overwrites the first and loses
  // the wall-specific explanation.
  level_m: "SET = a flat top at this elevation, so on a slope one end stands tall and the "
         + "other buries — that is what makes a wall look 'too high on one side'. "
         + "CLEAR IT and the wall follows the ground at a constant height instead. "
         + "On an OBJECT it is the base elevation: set it to stand on a plinth, a wall "
         + "top or a deck; clear it to stand on the ground.",
  retains: "which side it holds back. uphill = it retains the bank behind it; none = "
         + "it is edging, not a wall.",
  thickness_m: "how thick it is built. Leave empty for the material's own default — "
         + "12 mm for steel, 350 mm for stacked stone.",
  batter_deg: "how far it leans INTO the ground it holds. Dry stone wants 8-12 deg; "
            + "steel stands plumb at 0.",
  footing_depth_m: "how deep it is set below ground. Empty uses the material's default.",
  material: "free text. What is listed renders as itself; anything else draws as the "
          + "nearest surface and goes on your want list.",
  width_m: "how wide, in metres.",
  purpose: "what this usable area is FOR, in your own words — it is not a fixed list.",
  mulch: "what the bed is topped with. Free text.",
  riser_m: "the rise of one step. Lower is easier to walk.",
  going_m: "the tread depth of one step. risers x going is the LENGTH the flight eats.",
  kind: "what this object is. Free text — anything unmodelled draws as a marked "
      + "placeholder and goes on your want list.",
  rotation_deg: "which way it faces, in degrees.",
  tilt_deg: "how far it LEANS, in degrees. 0 stands it plumb. A set boulder leans; a gate or a screen does not.",
  note: "a note to yourself. Carried through edits, ignored by the validators.",
};

const FIELD_TYPES = {
  kind:       { type: "select", free: true, options: () => OBJECT_KINDS },
  material:   { type: "select", free: true, options: () => PATH_SURFACES },
  purpose:    { type: "select", free: true,
                options: () => ["sitting", "dining", "fire_pit", "lawn", "kitchen_garden",
                                "play", "utility", "landing"] },
  mulch:      { type: "text" },
  retains:    { type: "select", options: () => ["uphill", "downhill", "none"] },
};
// What renders as itself. NOT a fence: material is free text because the library
// must not cap the design. A closed <select> would impose that limit in the UI.
// What objects.js draws as itself. NOT a fence — kind is free text and an
// unmodelled one becomes an honest placeholder plus a want.
const OBJECT_KINDS = ["lantern", "basin", "boulder", "bench", "pot", "firepit",
                      "screen", "moon gate", "pergola"];
const PATH_SURFACES = ["flagstone", "paver", "gravel", "decomposed_granite", "concrete",
                       "stepping_stones", "deck", "lawn", "brick", "stone_sett",
                       "corten_steel", "aluminium", "timber", "stone", "dry_stone", "boulder"];

function editableFields(kind) {
  const spec = MOVE_AS[kind];
  if (!spec) return [];
  // A POINT kind gets its coordinates as fields. Dragging places a thing
  // approximately; every 3D app also lets you type where it goes, and this one
  // stores to the centimetre. Position and rotation need fields beyond `keep`;
  // geometry lives in `pts`. A LINE kind gets no x/y — one pair cannot describe
  // a spline, which is edited through its control-point handles.
  const names = [...(spec.point ? ["x_m", "y_m"] : []),
                 ...spec.keep, ...Object.keys(spec.rename ?? {})];
  return names.map((name) => {
    const t = FIELD_TYPES[name];
    if (!t) return { name, type: "number" };
    return { name, type: t.type, free: !!t.free,
             options: t.options ? t.options() : [] };
  });
}

/**
 * The ops for "this object, with ONE property changed".
 *
 * Geometry untouched, every other field carried across — the same discipline as
 * moveOps, for the same reason: the op vocabulary replaces an object wholesale,
 * so anything the op does not carry is deleted. Every hand edit goes through
 * the same execute() + validate() as a model op, keeping invalid geometry out
 * regardless of who authors it.
 */
function propertyOps(kind, raw, field, value) {
  if (!raw?.id) throw new Error("nothing selected");
  const spec = MOVE_AS[kind];
  if (!spec) throw new Error(`a ${kind} has no editable properties`);
  const f = editableFields(kind).find(x => x.name === field);
  if (!f) throw new Error(`a ${kind} has no property "${field}"`);

  // x_m / y_m are not stored fields — they are one half of `position`, so they
  // are read and written through it rather than being carried as their own key,
  // which the schema would reject.
  if (field === "x_m" || field === "y_m") {
    const at = field === "x_m" ? 0 : 1;
    const pos = [...(raw[spec.pts] ?? [0, 0])];
    const v = Number(value);
    if (!Number.isFinite(v)) throw new Error(`${field} must be a number`);
    if (m2(pos[at]) === m2(v)) return [];
    pos[at] = m2(v);
    pos[1 - at] = m2(pos[1 - at]);
    return [{ tool: spec.tool, input: { id: raw.id, [spec.pts]: pos,
                                        ...carry(raw, spec.keep) } }];
  }

  // "" clears the field rather than writing an empty one. level_m is the live
  // case: a path that declares one renders FLAT, so clearing it must put the
  // walk back on the ground, not pin it to 0 m.
  const blank = value === "" || value === null || value === undefined;
  let next = blank ? undefined : value;
  if (!blank && f.type === "number") {
    next = Number(value);
    if (!Number.isFinite(next)) throw new Error(`${field} must be a number`);
  }
  if ((raw[field] ?? null) === (next ?? null)) return [];   // nothing changed, nothing posted

  const input = { id: raw.id, [spec.pts]: raw[spec.pts] ?? (spec.point ? [0, 0] : []),
                  ...carry(raw, spec.keep) };
  for (const [from, to] of Object.entries(spec.rename ?? {})) {
    if (raw[from] !== undefined) input[to] = raw[from];
  }
  const key = (spec.rename ?? {})[field] ?? field;
  if (next === undefined) delete input[key];
  else input[key] = next;
  return [{ tool: spec.tool, input }];
}

/** The point list a reshape moves, for this kind. [] when there is none. */
/**
 * Every point of every OTHER object, for snapping to.
 *
 * Excludes the thing being dragged: a point that snapped to its own neighbour
 * would collapse a corner the moment you touched it.
 */
function snapTargets(exceptId) {
  const out = [];
  for (const [key, kind] of DESIGN_KINDS) {
    for (const o of currentDesign?.[key] ?? []) {
      if (o.id === exceptId) continue;
      const spec = MOVE_AS[kind];
      if (!spec) continue;
      const pts = spec.point ? [o[spec.pts]] : (o[spec.pts] ?? []);
      for (const p of pts) if (Array.isArray(p) && p.length >= 2) out.push(p);
    }
  }
  return out;
}

/** Snap a dragged point, if the owner has asked for snapping. */
function snapped(xy, exceptId) {
  if (!document.getElementById("snapOn")?.checked) return xy;
  const step = snapStep();
  // the pull scales with the grid: 8 cm on a 10 cm grid would snap everything always
  return toNearest(xy, snapTargets(exceptId), step, Math.min(0.08, step * 0.4));
}

/** The user's grid step: 0.1, 0.25, 0.5 or 1 m — 0.5 when there is no choice. */
function snapStep() {
  const v = Number(document.getElementById("snapStep")?.value);
  return v > 0 ? v : 0.5;
}

/**
 * Snap a dragged ANGLE, on the same switch.
 *
 * The absolute facing is snapped, not the delta: 15 deg steps are only useful if
 * they land on 15, 30, 45 — snapping the delta would step in fifteens away from
 * whatever crooked angle the thing already had.
 */
function snapAngle(deg) {
  if (!document.getElementById("snapOn")?.checked) return deg;
  return toAngle(deg, 15, 5);
}

function geometryOf(kind, raw) {
  const spec = MOVE_AS[kind];
  if (!spec || spec.point) return [];      // a point has no line to reshape
  const pts = raw?.[spec.pts];
  return Array.isArray(pts) ? pts : [];
}

/**
 * The ops for "this object, with ONE control point moved".
 *
 * The user can reshape a path, wall or edge by moving its control points,
 * independently of moving the whole object or editing scalar fields.
 * This gives direct control over the line that defines a path or curved edge.
 *
 * Same discipline as moveOps and propertyOps: the op vocabulary REPLACES an
 * object wholesale, so every field it does not carry is deleted — and it is an
 * OP, so a vertex dragged onto the house, off the scan, or into a grade the
 * ground cannot carry is rejected with the reason and undoable for free.
 */
function reshapeOps(kind, raw, index, xy) {
  if (!raw?.id) throw new Error("nothing selected");
  const spec = MOVE_AS[kind];
  if (!spec) throw new Error(`a ${kind} has no shape to edit`);
  const pts = geometryOf(kind, raw);
  if (!Number.isInteger(index) || index < 0 || index >= pts.length)
    throw new Error(`${raw.id} has no point ${index}`);
  const [x, y] = xy ?? [];
  if (!Number.isFinite(x) || !Number.isFinite(y))
    throw new Error("that drag has no position on the ground");

  const next = [m2(x), m2(y)];                 // the stored centimetre, as everywhere
  const was = pts[index];
  if (was && m2(was[0]) === next[0] && m2(was[1]) === next[1]) return [];

  const moved = pts.map((p, i) => (i === index ? next : p));
  const input = { id: raw.id, [spec.pts]: moved, ...carry(raw, spec.keep) };
  for (const [from, to] of Object.entries(spec.rename ?? {})) {
    if (raw[from] !== undefined) input[to] = raw[from];
  }
  return [{ tool: spec.tool, input }];
}

/**
 * The ops for "another one of these, over there".
 *
 * Setting stones or lanterns by hand needs a copy action with a NEW ID.
 * Every op replaces by id, so reusing the original's id moves it instead of
 * creating a duplicate.
 */
let copyCounter = 0;

function duplicateOps(kind, raw, dx = 0.6, dy = 0.6) {
  if (!raw?.id) throw new Error("nothing selected");
  // Plants need their own copy path: MOVE_AS has no plant row because plants
  // move through set_plants. A copy is a PLACE; place_plants mints a fresh id.
  // A move keeps the original id, so it cannot serve as a copy.
  if (kind === "plant") {
    const [x, y] = raw.position ?? [];
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`${raw.id} has no position`);
    return [plantOp(raw, x + dx, y + dy)];
  }
  const spec = MOVE_AS[kind];
  if (!spec) throw new Error(`a ${kind} cannot be duplicated`);
  // Derived from the original and then made unique: copying a copy must not
  // land on the copy. The counter is enough because ids are checked by the
  // server on apply, and a collision there is a rejection, not a silent write.
  const base = String(raw.id).replace(/_copy\d*$/, "");
  const id = `${base}_copy${++copyCounter}`;
  const moved = moveOps(kind, raw, dx, dy);
  if (!moved.length) throw new Error("that offset is under a stored centimetre");
  const op = moved[moved.length - 1];
  return [{ tool: op.tool, input: { ...op.input, id } }];
}

/**
 * Where the "add a corner here" handles go: one between every pair of points, and
 * for a POLYGON one on the closing edge back to the first, because that is a real
 * edge of a bed and the commonest place to want a new corner.
 *
 * Pure and separate from renderHandles so a behavioural check can verify the
 * closing edge; a source-shape assertion cannot establish that it is covered.
 */
function midpointsFor(kind, pts) {
  const spec = MOVE_AS[kind];
  if (!spec || spec.point || !Array.isArray(pts) || pts.length < 2) return [];
  const closed = spec.pts === "polygon";
  const out = [];
  for (let i = 0; i < (closed ? pts.length : pts.length - 1); i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    out.push({ after: i, at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });
  }
  return out;
}

// The fewest points each kind can still BE. Below these the object stops being
// the thing it is, and the op would be rejected server-side anyway — better to
// say so where the click happened than to post a change that cannot land.
const MIN_POINTS = { polygon: 3, spline: 2 };

function _pointsFor(kind, raw, what) {
  const spec = MOVE_AS[kind];
  if (!spec) throw new Error(`a ${kind} has no shape to edit`);
  if (spec.point) throw new Error(`a ${kind} is a single point — there is nothing to ${what}`);
  return [spec, geometryOf(kind, raw)];
}

function _rebuild(kind, raw, pts) {
  const spec = MOVE_AS[kind];
  const input = { id: raw.id, [spec.pts]: pts, ...carry(raw, spec.keep) };
  for (const [from, to] of Object.entries(spec.rename ?? {})) {
    if (raw[from] !== undefined) input[to] = raw[from];
  }
  return [{ tool: spec.tool, input }];
}

/**
 * Add a control point AFTER `index`.
 *
 * Moving existing points only redistributes a line's curve; adding points
 * supplies more bends. A three-point spline cannot express a detailed path
 * regardless of how its existing points are moved.
 *
 * For a polygon, `index` may be the LAST corner: the closing edge back to the
 * first is a real edge of a bed and the commonest place to want a new one.
 */
function insertPointOps(kind, raw, index, xy) {
  if (!raw?.id) throw new Error("nothing selected");
  const [spec, pts] = _pointsFor(kind, raw, "insert into");
  if (!Number.isInteger(index) || index < 0 || index >= pts.length)
    throw new Error(`${raw.id} has no point ${index} to insert after`);
  const [x, y] = xy ?? [];
  if (!Number.isFinite(x) || !Number.isFinite(y))
    throw new Error("that point has no position on the ground");
  const next = pts.slice();
  next.splice(index + 1, 0, [m2(x), m2(y)]);
  return _rebuild(kind, raw, next);
}

/** Remove a control point, unless it is the one that makes the shape a shape. */
function deletePointOps(kind, raw, index) {
  if (!raw?.id) throw new Error("nothing selected");
  const [spec, pts] = _pointsFor(kind, raw, "delete from");
  if (!Number.isInteger(index) || index < 0 || index >= pts.length)
    throw new Error(`${raw.id} has no point ${index}`);
  const floor = MIN_POINTS[spec.pts] ?? 2;
  if (pts.length <= floor)
    throw new Error(`a ${kind} needs at least ${floor} points — this one has ${pts.length}`);
  return _rebuild(kind, raw, pts.filter((_, i) => i !== index));
}

/**
 * The ops for "this thing, turned".
 *
 * Two shapes, and `rotatable()` reads which out of MOVE_AS rather than a second
 * hand-typed list:
 *
 *   an OBJECT carries rotation_deg, so turning it is one number and objects.js
 *   already draws it — a lantern faces the path, a bench faces the view.
 *
 *   a PATH, EDGE, FLIGHT, BED or PATIO is a run of coordinates, and the only
 *   honest meaning of turning one is to swing the whole run about its own
 *   centre. That is a real design act (a terrace turned to face down the slope
 *   rather than across it) and it is expressible in the op the kind already has,
 *   so it is built rather than refused.
 *
 *   a PLANT is a bare position with no facing, so it throws. renderGizmo draws
 *   it no ring for the same reason: a control that does nothing is worse than an
 *   absent one, because the user may believe it worked.
 *
 * Same discipline as moveOps and reshapeOps — the vocabulary REPLACES an object
 * wholesale, so every field the op does not carry is deleted — and it is an OP,
 * so a bed swung onto the house or into a grade the ground cannot carry is
 * rejected with the reason and undoable for free.
 */
function rotateOps(kind, raw, deg, center) {
  if (!raw?.id) throw new Error("nothing selected");
  const spec = MOVE_AS[kind];
  const how = rotatable(spec);
  if (!how) throw new Error(`a ${kind} has no rotation to change`);
  if (!Number.isFinite(deg)) throw new Error("that drag has no angle");

  if (how === "field") {
    const was = normalizeDeg(Number(raw.rotation_deg) || 0);
    // a tenth of a degree is the stored precision, the way a centimetre is for
    // a coordinate: below it there is nothing to post
    const next = +normalizeDeg(was + deg).toFixed(1) + 0;
    if (Math.abs(normalizeDeg(next - was)) < 0.05) return [];
    const [px, py] = raw[spec.pts] ?? [0, 0];
    return [{ tool: spec.tool,
              input: { id: raw.id, [spec.pts]: [m2(px), m2(py)],
                       ...carry(raw, spec.keep), rotation_deg: next } }];
  }

  const pts = geometryOf(kind, raw);
  if (pts.length < 2) throw new Error(`${raw.id} has no shape to turn`);
  const c = center ?? centroid(pts);
  const spun = rotateXY(pts, c, deg).map(([x, y]) => [m2(x), m2(y)]);
  if (spun.every((p, i) => p[0] === m2(pts[i][0]) && p[1] === m2(pts[i][1]))) return [];
  return _rebuild(kind, raw, spun);
}

function moveOps(kind, raw, dx, dy) {
  if (!raw?.id) throw new Error("nothing to move");
  const ddx = m2(dx), ddy = m2(dy);
  if (!ddx && !ddy) return [];           // under a stored centimetre is not a move
  if (kind === "plant") {
    const [x, y] = raw.position ?? [];
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`${raw.id} has no position to move`);
    return [{ tool: "set_plants", input: { plants: [{ ...raw, position: [m2(x + ddx), m2(y + ddy)] }] } }];
  }
  const spec = MOVE_AS[kind];
  if (!spec) throw new Error(`there is no op for moving a ${kind}`);
  if (spec.point) {
    const [px, py] = raw[spec.pts] ?? [];
    if (!Number.isFinite(px) || !Number.isFinite(py))
      throw new Error(`${raw.id} has no position to move`);
    return [{ tool: spec.tool,
              input: { id: raw.id, [spec.pts]: [m2(px + ddx), m2(py + ddy)],
                       ...carry(raw, spec.keep) } }];
  }
  const pts = raw[spec.pts] ?? [];
  if (!pts.length) throw new Error(`${raw.id} has no ${spec.pts} to move`);
  const input = { id: raw.id, [spec.pts]: shift(pts, ddx, ddy), ...carry(raw, spec.keep) };
  for (const [from, to] of Object.entries(spec.rename ?? {})) {
    if (raw[from] !== undefined) input[to] = raw[from];
  }
  return [{ tool: spec.tool, input }];
}

// Everything a substitution can carry across. Position is not in it — it is
// identical by construction — and neither are the palette's display fields, so
// this doubles as the list that decides "is this actually a different plant".
const SUBSTITUTE_KEYS = ["species", "common", "mature_spread_m", "mature_height_m",
                         "form", "foliage", "asset", "container"];

/**
 * The op list for "this plant, but a different species".
 *
 * Swap a planted species without regenerating the design. Like placing and
 * moving, this is an OP judged by execute() + validate(). A substitution
 * CHANGES THE SIZE: replacing 1.3 m deergrass with a 9 m oak raises spacing,
 * cut/fill and possibly house-footprint questions already owned by validate().
 *
 * set_plants keeps the SAME id and position, preserving group membership.
 * remove + place_plants would mint a fresh id and drop that membership.
 * The record is replaced whole so the old species' flower and asset do not
 * survive onto the new one.
 *
 * The NEW species' mature size travels, never the old plant's: spacing is
 * checked at mature spread, and carrying 1.3 m over to an oak would put a
 * canopy tree through the validator as a grass clump.
 */
function substituteOps(raw, entry) {
  if (!raw?.id) throw new Error("nothing to substitute");
  const [x, y] = raw.position ?? [];
  if (!Number.isFinite(x) || !Number.isFinite(y))
    throw new Error(`${raw.id} is not a plant — only a plant has a species to swap`);
  const op = plantOp(entry, x, y);      // throws for nothing picked / no mature size
  const next = op.input.plants[0];
  // picking what it already is changes nothing, so nothing is posted: no fresh
  // id, no timeline entry, no validator round trip. Same discipline as a
  // sub-centimetre drag emitting no move.
  if (SUBSTITUTE_KEYS.every(k => (raw[k] ?? null) === (next[k] ?? null))) return [];
  return [{ tool: "set_plants", input: { plants: [{ ...next, id: raw.id }] } }];
}

// What a drawn region can be MADE into. Nothing else is carried: execute() owns
// material and mulch defaults, which must not be duplicated here.
const AREA_AS = { patio: "set_patio", bed: "upsert_bed" };

/**
 * The op that turns a region the OWNER DREW into a design object.
 *
 * Places → Draw area lassoes scanned ground and simplifies the outline.
 * Reuse that stroke for landscape features defined by an outline; a single
 * ground click cannot describe their shape.
 *
 * The id is derived from the area's NAME, and both ops replace by id, so
 * pressing the button twice re-places the object instead of stacking a second
 * one on the same ground.
 */
function areaOp(kind, name, polygon) {
  const tool = AREA_AS[kind];
  if (!tool) throw new Error(`an area cannot be made into a ${kind}`);
  if (!(polygon?.length >= 3)) throw new Error(`"${name}" has too few vertices to be a ${kind}`);
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  // no offset — this is the stored-centimetre rounding, applied to a polygon
  // that came off the ground rather than out of a file
  return { tool, input: { id: `${kind}_${slug}`, polygon: shift(polygon, 0, 0) } };
}
// ── ALIGN-START ──
//
// Align and distribute.
//
// Space stepping stones evenly, line pots up along a terrace edge or give set
// stones a shared face. These controls avoid the small inconsistencies of
// lining up a row by hand.
//
// Pure functions, so they can be tested without a browser. They return DELTAS
// and nothing else; the caller turns each delta into a move op, so an aligned
// object that lands on the house or off the scan is rejected with the reason
// exactly like a dragged one. Alignment is not a licence to leave the
// yard.
//
// Axes are COMPASS, not screen. This project sets north, reports bearings and
// carves zones by compass; "align left" would mean something different every
// time the camera moved, which is the class of bug the ENU/world rule exists to
// prevent.

/** The ENU bounding box of any design element, point or run. */
function bboxOf(kind, raw) {
  const pts = kind === "plant" || MOVE_AS[kind]?.point
    ? [raw.position ?? raw[MOVE_AS[kind]?.pts ?? "position"]]
    : (raw[MOVE_AS[kind]?.pts] ?? []);
  const good = (pts || []).filter(p => Array.isArray(p)
    && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!good.length) return null;
  const xs = good.map(p => p[0]), ys = good.map(p => p[1]);
  const minx = Math.min(...xs), maxx = Math.max(...xs);
  const miny = Math.min(...ys), maxy = Math.max(...ys);
  return { minx, maxx, miny, maxy, cx: (minx + maxx) / 2, cy: (miny + maxy) / 2 };
}

/**
 * How far each item must move to share an edge or a centreline.
 *
 * `how` is west | east | north | south | centre_ew | centre_ns. The EDGE cases
 * line up the bounding boxes' faces, which is what "line these pots up along the
 * terrace edge" means; the centre cases line up their middles, which is what a
 * row of unequal stones wants — matching their faces would make the row look
 * crooked because the stones are different sizes.
 */
function alignDeltas(items, how) {
  const rows = items.map(it => ({ ...it, box: bboxOf(it.kind, it.raw) }))
                    .filter(r => r.box);
  if (rows.length < 2) return [];
  const pick = {
    west:  { read: b => b.minx, axis: "x" },
    east:  { read: b => b.maxx, axis: "x" },
    south: { read: b => b.miny, axis: "y" },
    north: { read: b => b.maxy, axis: "y" },
    centre_ew: { read: b => b.cx, axis: "x" },
    centre_ns: { read: b => b.cy, axis: "y" },
  }[how];
  if (!pick) return [];
  const vals = rows.map(r => pick.read(r.box));
  // the TARGET is the extreme in the named direction, not the mean: "align
  // north" means bring them to the northmost one, which is what you point at
  const target = how === "west" ? Math.min(...vals)
               : how === "east" ? Math.max(...vals)
               : how === "south" ? Math.min(...vals)
               : how === "north" ? Math.max(...vals)
               : vals.reduce((a, b) => a + b, 0) / vals.length;
  return rows.map((r, i) => ({
    id: r.id, kind: r.kind, raw: r.raw,
    dx: pick.axis === "x" ? target - vals[i] : 0,
    dy: pick.axis === "y" ? target - vals[i] : 0,
  })).filter(d => Math.abs(d.dx) > 1e-4 || Math.abs(d.dy) > 1e-4);
}

/**
 * How far each item must move for EQUAL GAPS along one axis.
 *
 * The two extremes stay where they are — they are the ends of the run the owner
 * has already placed — and everything between them is spread evenly by CENTRE.
 * Spacing by gap-between-boxes instead would make three stones of different
 * sizes look unevenly placed, because the eye spaces objects by their middles.
 */
function spreadDeltas(items, axis) {
  const key = axis === "x" ? "cx" : "cy";
  const rows = items.map(it => ({ ...it, box: bboxOf(it.kind, it.raw) }))
                    .filter(r => r.box)
                    .sort((a, b) => a.box[key] - b.box[key]);
  if (rows.length < 3) return [];            // two things are already evenly spaced
  const lo = rows[0].box[key], hi = rows[rows.length - 1].box[key];
  const step = (hi - lo) / (rows.length - 1);
  return rows.map((r, i) => {
    const want = lo + step * i;
    const d = want - r.box[key];
    return { id: r.id, kind: r.kind, raw: r.raw,
             dx: axis === "x" ? d : 0, dy: axis === "y" ? d : 0 };
  }).filter(d => Math.abs(d.dx) > 1e-4 || Math.abs(d.dy) > 1e-4);
}
// ── ALIGN-END ──

// ── HAND-EDIT-END ──

// ---------------------------------------------------------- browsing plants
// A palette ordered "everything in this design, then everything in the library"
// is a good ROW and a poor BROWSER: dozens of entries with no way to see which are
// groundcovers and which will be over your head in ten years. So it groups by
// growth FORM, which is also how routing works (assets.js PLANT_FORMS), and
// every row states its mature size.
//
// Pure, and extracted between the markers by tests/js/ui_palette.test.mjs — no
// DOM, no THREE, no module state. The two classifiers are handed IN rather than
// imported here for the same reason: growthForm (plants.js) and normalizeForm
// (assets.js) each have exactly one home, and the picker must not grow a third
// opinion about what shape a plant is.
// ── PALETTE-START ──

/**
 * What one card in the asset window says about a plant.
 *
 * Show size, water needs and cat safety together so the user can compare two
 * plants at a glance; a single dropdown line cannot carry that information.
 */
function assetFacts(e) {
  const out = [];
  // An object's second number is its WIDTH, not a spread it will grow into, and
  // for a bench the first is seat height. Saying "mature size" about a stone
  // lantern would be the picker claiming something untrue about the thing.
  if (e?.source === "object") {
    out.push(e.width_m > 0 ? sizePair(e.height_m, e.width_m) : fmtLen(e.height_m, 2));
    if (e.note) out.push(e.note);
    return out;
  }
  if (e?.mature_height_m > 0 && e?.mature_spread_m > 0) out.push(sizePair(e.mature_height_m, e.mature_spread_m));
  else out.push("no mature size");
  out.push(...plantFacts(e));
  // Unverified evidence is distinct from a non-toxic listing; cats have access.
  if (e?.cat_safe === true) out.push(`ASPCA non-toxic · ${e.cat_safety?.evidence_scope ?? "taxon"} evidence`);
  else if (e?.cat_safe === false) out.push("cat toxicity flagged");
  else out.push("cat safety unverified");
  if (e?.identity_status === "needs_identification") out.push("confirm exact plant identity");
  if (e?.mature_height_range_m && e?.mature_spread_range_m)
    out.push(`mature range ${sizeSpan(...e.mature_height_range_m)} × ${sizeSpan(...e.mature_spread_range_m)}`);
  if (e?.flowering_height_range_m) out.push(`flowering height ${sizeSpan(...e.flowering_height_range_m)}`);
  if (e?.size_evidence?.status && e.size_evidence.status !== "source_checked") out.push("size estimate · verify locally");
  if (e?.site_zone === "cooler_part_shade_irrigated") out.push("cooler / irrigated area");
  if (e?.establishment_irrigation) out.push("establishment irrigation required");
  return out;
}

const WATER_ORDER = ["very_low", "low", "moderate", "high"];

/**
 * The asset window's filters — the user's questions about a plant.
 *
 * `catSafe` matches TRUE only. "Not assessed" is not "safe", and a picker that
 * quietly treats it as safe would be the worst thing in this repo: a confident
 * wrong answer about an animal, in the interface the user clicks. Same rule as
 * list_assets cat_safe_only, deliberately.
 */
function assetFilter(rows, f = {}) {
  const q = String(f.q ?? "").trim().toLowerCase();
  return (rows ?? []).filter((e) => {
    if (q && !`${e.species ?? ""} ${e.common ?? ""} ${(e.aliases ?? []).join(" ")}`.toLowerCase().includes(q)) return false;
    // Every filter below this line is a question about a PLANT. A boulder is not
    // a California native and has no water need, so asking one of them is asking
    // to see plants — the objects drop out. Letting them through instead would be
    // the picker answering "is this cat-safe?" with a moon gate, and answering it
    // "yes" by omission is the one mistake this filter's own comment forbids.
    if (e.source === "object")
      return !(f.native || f.catSafe || f.form || f.water || f.maxWater || f.mine);
    if (f.mine && !f.mineSet?.has(e.species)) return false;
    if (f.native && e.ca_native !== true) return false;
    if (f.catSafe && e.cat_safe !== true) return false;
    if (f.form && e.form !== f.form) return false;
    if (f.water && e.water !== f.water) return false;
    if (f.maxWater) {
      const i = WATER_ORDER.indexOf(e.water), j = WATER_ORDER.indexOf(f.maxWater);
      if (i === -1 || j === -1 || i > j) return false;
    }
    return true;
  });
}

// form -> the header the owner reads, in browse order: ground up. The keys are
// assets.PLANT_FORMS and the test fails if the two lists ever disagree, so a
// form added for another climate cannot quietly land in a bucket nobody sees.
// The null key is not a form — it is the shelf for a library MODEL whose habit
// the library never recorded, which is honest where "mound" would be a guess.
const FORM_LABELS = [
  ["mat", "spreading groundcover"],
  ["grass", "upright grass"],
  ["rosette", "rosette"],
  ["mound", "mounding shrub"],
  ["cane", "cane / bamboo"],
  ["vine", "climber"],
  // Every form needs a name here: a form the renderer draws but the picker
  // cannot name is a plant the owner cannot find.
  ["rush", "upright rush"],
  ["strap", "strap-leaved clump"],
  ["perennial", "herbaceous perennial"],
  ["meadow", "meadow annual"],
  ["column", "narrow column"],
  ["tree", "canopy tree"],
  ["palm", "palm"],
  // A manifest without `form` leaves each model's habit unknown. Rebuild with
  // `blender -b -P tools/gen_trees.py -- --all` to record it; the rows then use
  // their proper headers without a code change. ui_palette.test.mjs checks
  // that path with a manifest that declares each form.
  [null, "generic shapes · habit not recorded"],
];

/**
 * Which shelf a palette row belongs on.
 *
 * A row from THIS DESIGN is a species, so the answer is plants.js's own —
 * growthForm() reads species first, then the declared habit, then size, and it
 * is the function that decides what actually gets drawn. Asking it here is what
 * makes the header a promise rather than a label.
 *
 * A row from the LIBRARY is a model, and a model's habit is the one gen_trees.py
 * declared when it built it. Running growthForm() over a model nickname gives a
 * confidently wrong answer instead of no answer: measured, "oak", "pine",
 * "cypress" and "manzanita" all come back `mound`, because no regex in plants.js
 * names them and every model is offered at exactly 4 m, where the size fallback
 * says mound. So an unrecorded habit stays null and gets its own header.
 */
function paletteForm(e, { growthForm, normalizeForm }) {
  return e.source === "library" ? normalizeForm(e.form) : growthForm(e);
}

/** The palette as headed groups, in FORM_LABELS order, smallest row first. */
function paletteGroups(entries, routers) {
  const rows = new Map(FORM_LABELS.map(([f]) => [f, []]));
  // Objects are not a growth form and must not be filed as one. FORM_LABELS is
  // checked against assets.PLANT_FORMS by a test, so smuggling an "object" key
  // into it would break the thing that keeps the plant shelves honest.
  const objects = [];
  for (const e of entries ?? []) {
    if (e.source === "object") { objects.push(e); continue; }
    const f = paletteForm(e, routers);
    rows.get(rows.has(f) ? f : null).push(e);
  }
  const out = [];
  for (const [form, label] of FORM_LABELS) {
    const list = rows.get(form);
    if (!list.length) continue;
    // by mature height inside the group: "browse by form and size" is one
    // gesture, and a row with no recorded size sorts to the top where its
    // "no mature size" is read before it is reached for
    list.sort((a, b) => (a.mature_height_m ?? 0) - (b.mature_height_m ?? 0)
                     || String(a.label).localeCompare(String(b.label)));
    out.push({ form, label, rows: list });
  }
  // Last in a planting-led garden, but on the SAME list: placing by hand must
  // include objects as well as plants.
  if (objects.length) {
    objects.sort((a, b) => (a.height_m ?? 0) - (b.height_m ?? 0)
                        || String(a.common).localeCompare(String(b.common)));
    out.push({ form: "object", label: "garden objects", rows: objects });
  }
  return out;
}
// ── PALETTE-END ──

// ── WANTS-START ──
//
// What the design asked for that nothing could build.
//
// objects.js keeps `kind` free text so a design can request a moon gate or tea
// house. An unmodelled kind draws as a marked placeholder and is recorded as a
// WANT. Show that list to the owner so an amber box cannot silently substitute
// for the requested feature.
//
// Pure, and sliced out by tests/js/ui_wants.test.mjs. Inject `routers` so the
// test uses objects.js's own classifier rather than duplicating the kind matcher.
function wantRows(design, routers) {
  const missing = routers?.wants?.(design) ?? [];
  const byId = new Map();
  for (const o of design?.objects ?? []) byId.set(o.id, o);
  // Half away from zero, matching agent._round_half_up rather than JS Math.round,
  // which rounds -4.55 to -4.5 and would print a different metre than the python
  // side does for the same object.
  const r1 = v => String(Math.sign(v) * Math.round(Math.abs(v) * 10) / 10);
  return missing.map(w => {
    const points = w.ids.map(id => byId.get(id)?.position)
                        .filter(p => Array.isArray(p) && p.length >= 2);
    const more = w.count > 1 ? ` and ${w.count - 1} more` : "";
    let where;
    if (!points.length) {
      // objectMesh draws it at [0,0] by its own fallback. Saying "at 0, 0" would
      // claim to know something nobody wrote down.
      where = `no position given${more}`;
    } else {
      const [x, y] = points[0];
      const place = routers?.placeOf?.(x, y) ?? null;
      where = `${place ? `in ${place} · ` : ""}at ${r1(x)}, ${r1(y)}${more}`;
    }
    return {
      kind: w.kind, count: w.count, ids: w.ids, points,
      label: `${w.kind} · ${w.count} asked for · not modelled yet`,
      where,
    };
  });
}
// ── WANTS-END ──

/**
 * The one place a whole design document reaches disk.
 *
 * Not for EDITS — those are ops, so they are judged by the same execute() +
 * validate() a model op is. This is for the four things that
 * REPLACE the document: saving groups, restoring a timeline entry, switching to
 * a saved variant, and clearing to a blank design.
 *
 * Deliberately thin. Validation messages must go through postOps rather than
 * creating a second /api/ops client. A shared client keeps the endpoint contract
 * consistent across document writes and hand edits.
 *
 * The value here is the single seam, not the logic in it: one place a design
 * document reaches disk, which is where any future check belongs.
 */
async function writeDesignDocument(patch, what, opts) {
  // Destructured in the BODY, not the parameter list. Several suites read this
  // function out of the source by scanning braces from its name, so a destructured
  // parameter hands them the parameter list instead of the body — and a comment
  // may not carry an unpaired brace here for the same reason.
  const { replace = false } = opts ?? {};
  // Never while previewing. preview_design points the viewer at an agent's scratch
  // file so it can see its own proposal, and loadDesign sets currentDesign from
  // whatever it loaded — so a save here would persist the SCRATCH over the
  // owner's working design.
  //
  // Refuse rather than redirect: writing to the preview file would let a stray
  // click edit the agent's scratch instead of the design the control names.
  if (previewSource) {
    log(`${what}: not while previewing ${previewSource} — this is not your working `
      + `design. Turn the preview off first.`, "warn");
    return null;
  }
  // Re-read FIRST. `patch` is the keys this caller owns, merged onto whatever is
  // on disk right now — never a whole cached document. In this project the
  // design file is written constantly from outside the browser (the agent,
  // site_api apply-ops, the owner's own scripts), so writing back a snapshot
  // read at the last poll is a lost update waiting for the next tool run.
  // A cached pre-edit snapshot can erase fields added by an external writer,
  // such as a steps list, even when this caller only changes groups. updateSite()
  // uses the same fresh-read discipline for site.json.
  let onDisk;
  try {
    onDisk = await fetchJson("/data/design.json");     // fetchJson cache-busts
  } catch (e) {
    if (!/: 404$/.test(e.message)) {
      log(`${what}: design.json unreadable — not overwriting it: ${e.message}`, "err");
      return null;
    }
    onDisk = null;                                     // genuinely no file yet
  }
  // `replace` says `patch` IS the document. A shallow spread cannot express
  // clearing omitted keys: a saved design without `objects` must remove them,
  // not inherit those on screen and write a hybrid. See design_doc.js.
  const next = mergeDesignDocument(onDisk, patch, { replace });
  const ok = await writeJson("data/design.json", next);
  if (!ok) { log(`${what}: could not write the design`, "err"); return null; }
  return next;
}

const toldErrors = new Map();          // design -> the errors already on screen for it (newSince)
/**
 * The ONE client for the op endpoint. Every hand-authored edit goes through it.
 *
 * The contract: POST {ops:[{tool, input}, …]} to /api/ops, which applies the
 * list with agent.execute() — the same function, the same validate(), the same
 * baseline-error contract as the model's own ops — writes design.json only for
 * the ops that survived, and answers {applied:[{tool,id,result}],
 * rejected:[{tool,id,why}]}, the shape site_api's check-ops already reports a
 * dry run in.
 *
 * The handler belongs in viewer/vite.config.js beside /api/design. If it is
 * unavailable, report the failure; never fall back to writing design.json,
 * which would let hand edits bypass the validators.
 *
 * The file is the source of truth, never the scene: whatever happened, the
 * design is re-read afterwards, so a rejected drag snaps back to where the
 * object really is instead of leaving the preview telling a comfortable lie.
 */
async function postOps(ops, what) {
  if (!ops?.length) return false;
  try {
    const opsStart = performance.now();
    const r = await fetch("/api/ops", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ops }) });
    editOpsMs = +(performance.now() - opsStart).toFixed(0);
    if (r.status === 404) {
      log("this dev server has no op endpoint, so a hand edit has nothing to run it through — "
        + "and it must not be written any other way. Restart the viewer.", "err");
      return false;
    }
    const out = await r.json();
    const applied = out.applied ?? [];
    const rejected = out.rejected ?? [];
    // THE WRITE IS ALL-OR-NOTHING, so `applied` is not success.
    //
    // site_api.apply-ops writes only `if applied and not rejected` and reports
    // that fact in `wrote`. One rejection prevents every op from reaching disk,
    // even when several executed successfully. Aligning, spacing, duplication
    // and multi-object drags can emit several ops, so checking `applied` alone
    // would claim success for an edit that disappears on reload. Report refusals
    // visibly through the one write path.
    const wrote = out.wrote ?? (applied.length > 0 && !rejected.length);
    for (const a of applied)
      log(wrote ? (a.result ?? `${a.tool} applied`)
                : `would have ${a.result ?? a.tool} — but nothing was written`,
          wrote ? "ok" : "warn");
    // the server's reason already begins "rejected:" — said once, not "rejected — rejected:"
    for (const rej of rejected) log(`rejected — ${String(rej.why).replace(/^rejected:\s*/, "")}`, "warn");
    if (rejected.length && applied.length)
      log(`${what}: NOTHING was written — this edit is all-or-nothing and `
        + `${rejected.length} of ${applied.length + rejected.length} op(s) were refused.`, "err");
    if (!applied.length && !rejected.length)
      log(`${what}: ${out.error ?? "nothing applied"}`, "err");
    // Show the server's whole-design measurements so an error on disk is
    // also visible on screen.
    for (const e of newSince(toldErrors, currentVariant, out.errors ?? [])) log(`design error — ${e}`, "err");
    return wrote;
  } catch (e) {
    log(`${what}: ${e.message}`, "err");
    return false;
  } finally {
    // every exit, including the ones that changed nothing: the file is the
    // source of truth and the scene is a picture of it
    await loadDesign(true);
  }
}

// The palette. Rebuilt whenever the design changes, so a species the model just
// planted is immediately pickable and a switched variant does not leave the
// previous yard's list standing.
let palette = [];
let libraryMeta = {};                       // assets/plants/manifest.json, by model name
const paletteKey = e => `${e.source}|${e.species}`;

/**
 * A picture of whatever this row is, drawn by the same builder the garden uses.
 *
 * ONE dispatcher shared by the tile and card so their source-to-builder
 * routing stays consistent.
 */
// A PLANT's picture may take a moment: `later(url)` gets it when it is drawn
const entryThumb = (e, later) => (e?.preview ? `/${e.preview}`   // a library model's own picture
                         : e?.source === "object" ? objectThumb(e)
                         : later ? plantThumbLater(e, later) : plantThumb(e));
// the plant code's version, which the pictures are kept under between visits
fetch("/api/plant-build").then(r => r.json()).then(j => setPlantBuild(j.build)).catch(() => {});

// The owner's shortlist, read from disk at boot. Name its path in ONE place
// so callers cannot drift.
let plantCatalog = [];
// The object library's models — found, made or scanned — from /api/objects/library.
let objectLibrary = [];
async function loadObjectLibrary() {
  try { objectLibrary = await fetchJson("/api/objects/library"); } catch { objectLibrary = []; }
  renderPalette();
  if (assetWindowOpen()) renderAssetWindow();
}

async function loadPlantCatalog() {
  try {
    const r = await fetch("/data/plant_palette.json");
    plantCatalog = (await r.json())?.plants ?? [];
  } catch (e) {
    // A missing shortlist must cost its extra rows and nothing else — the
    // picker still has to offer this design's plants and the library.
    console.warn("plant shortlist unavailable, picker falls back to design + library:", e);
    plantCatalog = [];
  }
  renderPalette();
}

/**
 * The tile that shows what a click will put down, and opens the picker.
 *
 * The tile opens the asset window directly so the user chooses from pictures.
 * The hidden select holds the choice; it is not a second browsing surface.
 */
function renderPickTile() {
  const tile = document.getElementById("pickTile");
  if (!tile) return;
  const e = pickedEntry();
  const thumb = tile.querySelector(".thumb");
  const what = tile.querySelector(".what");
  const show = u => { thumb.style.backgroundImage = u ? `url(${u})` : "none"; };
  show(e && e.placeable ? entryThumb(e, u => { if (pickedEntry() === e) show(u); }) : null);
  what.textContent = e ? (e.common ?? e.species) : "nothing picked";
  tile.title = e ? `${e.label} — click to choose something else` : "choose what to place";
}

document.getElementById("pickTile").onclick = () => showAssets(true);

function renderPalette() {
  const sel = document.getElementById("placeWhat");
  const keep = sel.value;
  palette = paletteEntries(currentDesign, libraryMeta, MIN_ASSET_HEIGHT_M, plantCatalog,
                           { objectCatalog, resolveKind, objectLibrary: () => objectLibrary }, projectPolicy);
  sel.innerHTML = "";
  for (const g of paletteGroups(palette, { growthForm, normalizeForm })) {
    const og = document.createElement("optgroup");
    og.label = `${g.label} (${g.rows.length})`;
    for (const e of g.rows) {
      const o = document.createElement("option");
      o.value = paletteKey(e);
      o.textContent = e.label;
      // A <select> has exactly one place for what does not fit on the row, and
      // the row is all the owner ever sees of the shortlist file. Sun, bloom and
      // the horticultural note are the fields that decide whether a plant will
      // actually be happy where the user is about to put it.
      o.title = [
        e.placeable
          ? `${e.mature_height_m} m tall and ${e.mature_spread_m} m wide at maturity`
          : "no mature size recorded, so it cannot be placed — spacing is checked at mature spread",
        e.sun ? `likes ${String(e.sun).replace(/_/g, " / ")}` : "",
        e.bloom ? `flowers ${String(e.bloom).replace(/_/g, " to ")}` : "",
        e.note || "",
      ].filter(Boolean).join(" · ");
      o.disabled = !e.placeable;          // offered, so it is not a mystery; not placeable
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
  if (palette.some(e => paletteKey(e) === keep)) sel.value = keep;
  renderPickTile();
}

/**
 * What the owner has picked in the palette — the ONE read of that control.
 *
 * Placing and substituting share this read so paletteKey lookup and selection
 * handling cannot drift between them.
 */
/** Set what will be planted. The write half of pickedEntry(). */
function pickEntry(key) {
  const sel = document.getElementById("placeWhat");
  sel.value = key;
  sel.dispatchEvent(new Event("change"));
  renderPickTile();          // wherever the pick was changed from, the tile follows
}

function pickedEntry() {
  return palette.find(e => paletteKey(e) === document.getElementById("placeWhat").value) ?? null;
}

// WHAT YOU ARE ABOUT TO PUT DOWN, ON THE CURSOR.
//
// A ghost of the selected asset follows the cursor before placement, so the
// user can judge the size and position of a 1.5 m shrub before clicking.
//
// Built ONCE per picked asset and then moved: a 2 M-triangle shrub cannot be
// rebuilt on every pointermove. Ghosted like a compare overlay, and it never
// enters `designGroup` — nothing may pick it, measure it, or export it.
let placeGhost = null, placeGhostKey = null;
function clearPlaceGhost() {
  if (!placeGhost) return;
  // Remove it FROM WHEREVER IT HANGS. buildPlaceGhost attaches to designsGroup,
  // and remove() only detaches a DIRECT child. Disposal alone does not hide it:
  // three re-uploads disposed geometry if it remains attached and is drawn.
  placeGhost.removeFromParent();
  disposeObj(placeGhost, "mesh");
  placeGhost = null; placeGhostKey = null;
}
/** What the ghost is a picture of: the picked entry, at this detail and this growth. */
function wantedGhostKey() {
  const entry = pickedEntry();
  return entry ? paletteKey(entry) + "|" + renderQuality + "|" + growthScale() : null;
}
async function buildPlaceGhost() {
  const entry = pickedEntry();
  const key = wantedGhostKey();
  if (!entry) { clearPlaceGhost(); return; }
  if (key === placeGhostKey) return;
  clearPlaceGhost();
  let op;
  try { op = placeOp(entry, 0, 0); } catch { return; }   // unplaceable: no ghost, the click says why
  const one = op.tool === "place_plants" ? { plants: op.input.plants } : { objects: [op.input] };
  // the builders' textures in BOTH modes — Fast at 256 px, or it draws them dark
  await preparePlantTextures(renderQuality);
  await ensurePlantModels(one, renderQuality);
  await ensureObjectModels(objectModelsNeededBy(one));
  const g = await buildDesignGroup(colourFromPalette(one), heightAt, growthScale(), { quality: renderQuality });
  g.name = "placeGhost";
  g.traverse(o => {
    if (!o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const ghosted = mats.map(m => { const c = m.clone(); c.transparent = true; c.opacity = (m.opacity ?? 1) * 0.5; c.depthWrite = false; return c; });
    o.material = Array.isArray(o.material) ? ghosted : ghosted[0];
    o.castShadow = o.receiveShadow = false;
  });
  g.visible = false;                 // until the cursor is over real ground
  // left place mode, or picked something else, while this was being built: it is not wanted.
  // The clear already ran; adding the completed build now would leave a stale ghost.
  if (mode !== "place" || key !== wantedGhostKey()) {
    disposeObj(g, "mesh");
    return;
  }
  placeGhost = g; placeGhostKey = key;
  // the design's own parent, so the ghost sits in the frame its coordinates were
  // built in — and NOT inside designGroup, which is what gets picked and exported
  designsGroup.add(g);
}
function movePlaceGhost(ev) {
  if (!placeGhost) return;
  const p = pickSurface(ev, { quiet: true });
  placeGhost.visible = !!p;
  if (!p) return;
  // built at ENU (0, 0); carry it to the cursor in the SAME frame, which is what
  // worldToEnu/enuToWorld exist for — a raycast answers in world
  const [ex, ey] = worldToEnu(p);
  const to = enuToWorld(ex, ey, 0), from = enuToWorld(0, 0, 0);
  const gy = heightAt(to.x, to.z), gy0 = heightAt(from.x, from.z);
  placeGhost.position.set(to.x - from.x,
                          (Number.isFinite(gy) ? gy : 0) - (Number.isFinite(gy0) ? gy0 : 0),
                          to.z - from.z);
}

/** A click in place mode: pick the real ground, emit the op, post it. */
async function placeHere(ev) {
  const entry = pickedEntry();
  if (!entry) { log("pick what to place first", "warn"); return; }
  const p = pickSurface(ev);
  if (!p) return;                          // pickSurface has already said why
  // A raycast returns WORLD. Storing it as ENU rotates the pick incorrectly
  // once Set north changes the yaw; at yaw 0 the frames coincide.
  const [x, y] = snapped(worldToEnu(p), null);
  let op;
  try { op = placeOp(entry, x, y); }
  catch (e) { log(e.message, "warn"); return; }
  await postOps([op], `place ${entry.common}`);
}

/**
 * A finished drag: every selected object, moved by the same (dx, dy).
 *
 * `nodes` are the scene objects the drag was previewing on. They are put back
 * unconditionally — either the ops apply and loadDesign rebuilds from the file,
 * or nothing applied and the preview would otherwise sit where it was dropped.
 */
async function moveSelection(dx, dy, nodes = []) {
  const ops = [], moved = [];
  for (const id of selection) {
    const hit = rawById(currentDesign, id);
    if (!hit) continue;
    try {
      const built = moveOps(hit.kind, hit.raw, dx, dy);
      if (built.length) { ops.push(...built); moved.push(id); }
    } catch (e) { log(`${id}: ${e.message}`, "warn"); }
  }
  for (const { o, base } of nodes) o.position.copy(base);
  if (!ops.length) return false;
  return postOps(ops, `move ${moved.join(", ")}`);
}

/**
 * Every selected plant becomes the species picked in the palette, where it
 * stands. Alongside moving and placing, this changes what a plant IS without
 * regenerating the surrounding design.
 *
 * Non-plants in the selection are skipped rather than refused, so selecting a
 * drift of shrubs and the bed they sit in still swaps the drift.
 */
async function substituteSelection() {
  const entry = pickedEntry();
  if (!entry) { log("pick the species to swap to in the palette first", "warn"); return; }
  // Substitute swaps one SPECIES for another where it stands. With an object
  // picked it would write `species: "moon_gate"` into a plant, which the schema
  // would take and the garden would then try to grow.
  if (entry.source === "object") {
    log(`substitute swaps one plant species for another — "${entry.common}" is an object, `
        + "so place it instead", "warn");
    return;
  }
  const ops = [], done = [];
  for (const id of selection) {
    const hit = rawById(currentDesign, id);
    if (hit?.kind !== "plant") continue;
    try {
      const built = substituteOps(hit.raw, entry);
      if (built.length) { ops.push(...built); done.push(id); }
    } catch (e) { log(`${id}: ${e.message}`, "warn"); }
  }
  if (!ops.length) {
    log(`nothing to change — select a plant that is not already ${entry.common}`, "warn");
    return;
  }
  await snapshotWorking();          // durable archive; the old species is gone otherwise
  if (await postOps(ops, `substitute ${entry.common}`)) {
    // the ids survive a swap (set_plants), so the selection still names them
    log(`${done.length} plant(s) are now ${entry.common}`, "ok");
  }
}
document.getElementById("btnSubstitute").onclick = () => substituteSelection();

document.getElementById("btnPlace").onclick = () => {
  if (mode === "place") { setMode("orbit"); return; }
  // pickSurface falls back to the flat y=0 plane with no capture loaded, and a
  // plant placed on invented ground is exactly what the validator rejects
  if (!stage) { log("load a capture first — a plant has to land on real ground", "warn"); return; }
  // ADD OPENS THE CATALOGUE; PICKING ARMS THE MODE.
  //
  // Choosing comes first: opening Add must not place whatever the hidden
  // placeWhat select happens to hold. The asset window's card click calls
  // pickEntry() and then setMode("place") for the chosen asset.
  showAssets(true);
};
// changing what you are about to place while standing in place mode should say so
document.getElementById("placeWhat").onchange = () => { if (mode === "place") setMode("place"); };
renderer.domElement.addEventListener("pointerleave", () => { if (placeGhost) placeGhost.visible = false; });

// The user judges a design by eye, so overlays must be dismissible. Like the
// snap switch, this is a viewing aid the user controls rather than a rule.
document.getElementById("gizmoOn").onchange = () => renderGizmo();

// ------------------------------------------------------------------ areas
// A drawn region, saved by name. Landmarks are points and that is the wrong
// shape for "this retaining wall" or "design something here" — so this is a
// lasso: hold and drag across the terrain and every sample lands on real
// scanned ground. See areas.js for why the outline is simplified on release.
const lasso = new Lasso();
let areaGroup = null, liveAreaGroup = null;

function drawAreas() {
  if (areaGroup) { enuGroup.remove(areaGroup); disposeObj(areaGroup, "mesh"); }
  areaGroup = new THREE.Group();
  areaGroup.name = "areas";
  for (const a of siteCache?.areas ?? []) {
    const g = areaMesh(a.polygon, heightAt, enuToWorld);
    g.userData.areaName = a.name;
    areaGroup.add(g);
    const lbl = textLabel(a.name, "area");
    const c = a.polygon.reduce((acc, p) => [acc[0] + p[0] / a.polygon.length,
                                            acc[1] + p[1] / a.polygon.length], [0, 0]);
    const w = enuToWorld(c[0], c[1], 0);
    lbl.position.set(w.x, heightAt(w.x, w.z) + 0.6, w.z);
    areaGroup.add(lbl);
  }
  enuGroup.add(areaGroup);
  applyLayers();
}

// A lasso emits samples faster than ShapeGeometry can be built. Coalesce
// overlay rebuilds to one per animation frame so feedback stays continuous
// and the drag remains responsive.
let livePending = false;
function drawLiveLasso() {
  if (livePending) return;
  livePending = true;
  requestAnimationFrame(() => {
    livePending = false;
    if (liveAreaGroup) { enuGroup.remove(liveAreaGroup); disposeObj(liveAreaGroup, "mesh"); }
    liveAreaGroup = null;
    if ((mode !== "area" && mode !== "pick") || lasso.length < 2) return;
    liveAreaGroup = areaMesh(lasso.pts, heightAt, enuToWorld, { live: true });
    liveAreaGroup.name = "livearea";
    enuGroup.add(liveAreaGroup);
  });
}

async function saveArea(name, polygon) {
  const ok = await updateSite(site => {
    site.areas = (site.areas ?? []).filter(a => a.name !== name);
    site.areas.push({ name, polygon: polygon.map(([x, y]) => [+x.toFixed(2), +y.toFixed(2)]) });
  });
  if (!ok) { log("could not save the area", "err"); return; }
  await loadSite(false);
  drawAreas(); renderAreaList(); renderViewpointList(); renderShotList();
  log(`"${name}" saved, ${fmtArea(polygonArea(polygon))} — click its name to rename it`, "ok");
  renameInPlace("areaList", name);
}

function renderAreaList() {
  const box = document.getElementById("areaList");
  if (!box) return;
  box.innerHTML = "";
  const areas = siteCache?.areas ?? [];
  if (!areas.length) {
    const e = document.createElement("div");
    e.className = "hint"; e.textContent = "none yet — name one and drag across the ground";
    box.appendChild(e); return;
  }
  for (const a of areas) {
    const row = document.createElement("div");
    row.className = "r";
    const n = document.createElement("input");
    n.type = "text";
    n.className = "nm";
    n.value = a.name;
    n.title = `${fmtArea(polygonArea(a.polygon), 0)} — edit to rename`;
    // onchange, not oninput: a redraw mid-keystroke would eat what you typed,
    // which is the same reason the landmark field uses it
    n.onchange = () => renameArea(a.name, n.value);
    const size = document.createElement("span");
    size.className = "meta";
    size.textContent = fmtArea(polygonArea(a.polygon), 0);
    const go = document.createElement("button");
    go.className = "eye";
    go.textContent = "show";
    go.title = `look at "${a.name}"`;
    go.onclick = () => frameArea(a);
    // the drawn outline is already real scanned ground, so it is one op away
    // from being a usable area or a bed — through the same validators, which
    // still get to reject it for standing on the house or off the scan
    const make = ["patio", "bed"].map(kind => {
      const b = document.createElement("button");
      b.textContent = kind;
      b.title = `make "${a.name}" a ${kind} in the design — checked against the real ground, exactly like anything the model draws`;
      b.onclick = () => {
        try { postOps([areaOp(kind, a.name, a.polygon)], `${kind} from "${a.name}"`); }
        catch (e) { log(e.message, "warn"); }
      };
      return b;
    });
    const del = document.createElement("button");
    del.textContent = "✕"; del.title = `delete "${a.name}"`;
    del.onclick = async () => {
      await updateSite(site => { site.areas = (site.areas ?? []).filter(x => x.name !== a.name); });
      await loadSite(false); drawAreas(); renderAreaList();
      log(`area "${a.name}" deleted`, "ok");
    };
    row.append(n, size, go, ...make, del);
    box.appendChild(row);
  }
}

function frameArea(a) {
  const xs = a.polygon.map(p => p[0]), ys = a.polygon.map(p => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 4);
  const c = enuToWorld(cx, cy, 0);
  const g = heightAt(c.x, c.z);
  controls.target.set(c.x, Number.isFinite(g) ? g : 0, c.z);
  camera.position.set(c.x + span * 0.9, (Number.isFinite(g) ? g : 0) + span * 0.8, c.z + span * 0.9);
  controls.update();
}

document.getElementById("btnLassoSelect").onclick = () => {
  // NO classList HERE. setMode is the one owner of which mode button looks
  // pressed (ui_settings.test.mjs holds that line), and `area` only touches the
  // class itself because it sets `mode` directly instead of going through it.
  if (mode === "pick") {
    setMode("orbit"); controls.enabled = true;
    lasso.reset(); drawLiveLasso(); log("section select off");
    return;
  }
  if (!stage) { log("load a capture first — the loop is drawn on real ground", "warn"); return; }
  setMode("pick");
};

document.getElementById("btnDrawArea").onclick = () => {
  const btn = document.getElementById("btnDrawArea");
  if (mode === "area") { mode = "orbit"; btn.classList.remove("active"); controls.enabled = true;
    lasso.reset(); drawLiveLasso(); syncRail(); log("area drawing off"); return; }
  const nameEl = document.getElementById("areaName");
  const name = nameEl.value.trim();
  // NO PRECONDITION. Draw before naming so the user can see the region's shape.
  // It receives a default such as `area 6` on release and can be renamed in
  // the list.
  if (!stage) { log("load a capture first — an area has to land on real ground", "warn"); return; }
  mode = "area"; btn.classList.add("active"); syncRail();
  log(`drawing "${name}" — hold and drag across the ground, release to close`);
};

// ------------------------------------------------------------------ back / forward
// A session timeline of {design, landmarks} snapshots. Because every edit is
// reversible from here, destructive actions don't need confirm dialogs —
// undoing is faster than reading a modal. data/history/ remains the durable
// archive underneath this.
let timeline = [], tlIndex = -1, tlSuppress = false, tlReady = false;

function tlLabel() {
  const b = document.getElementById("btnUndo"), f = document.getElementById("btnRedo");
  b.disabled = tlIndex <= 0;
  f.disabled = tlIndex < 0 || tlIndex >= timeline.length - 1;
  const pos = timeline.length ? `${tlIndex + 1}/${timeline.length}` : "";
  document.getElementById("tlPos").textContent = pos;
}

function tlPush(design) {
  // Nothing is recorded until boot has loaded BOTH the design and site.json —
  // otherwise the first entry captures an empty landmark list and stepping all
  // the way back would wipe every landmark.
  if (tlSuppress || !tlReady) return;
  const entry = { design, landmarks: siteCache?.landmarks ?? [] };
  const text = JSON.stringify(entry);
  if (tlIndex >= 0 && JSON.stringify(timeline[tlIndex]) === text) return;
  timeline = timeline.slice(0, tlIndex + 1);
  timeline.push(JSON.parse(text));
  if (timeline.length > 60) timeline.shift();
  tlIndex = timeline.length - 1;
  tlLabel();
}

async function tlGo(step) {
  const i = tlIndex + step;
  if (i < 0 || i >= timeline.length) return;
  const entry = timeline[i];
  tlSuppress = true;
  try {
    await writeDesignDocument(entry.design, "restore", { replace: true });
    const cur = JSON.stringify(siteCache?.landmarks ?? []);
    if (JSON.stringify(entry.landmarks) !== cur) {
      await updateSite(s => { s.landmarks = JSON.parse(JSON.stringify(entry.landmarks)); });
    }
    tlIndex = i;
    setSelection([]);
    await loadDesign(true);
  } finally {
    tlSuppress = false;
  }
  tlLabel();
  log(step < 0 ? `back (${tlIndex + 1}/${timeline.length})` : `forward (${tlIndex + 1}/${timeline.length})`);
}

document.getElementById("btnUndo").onclick = () => tlGo(-1);
document.getElementById("btnRedo").onclick = () => tlGo(1);
addEventListener("keydown", ev => {
  if (!(ev.metaKey || ev.ctrlKey) || ev.key.toLowerCase() !== "z") return;
  if (/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "")) return;
  ev.preventDefault();
  tlGo(ev.shiftKey ? 1 : -1);
});

// ------------------------------------------------------------------ layers
// Hide what you're not working on. Purely visual — nothing is deleted, and the
// naming/design renders honour it too, so you can also use it to control what
// the agent is shown.
// Mature size is horticulturally correct and visually useless: three mature
// olives fill a small yard and hide the design under them. Showing an earlier
// growth stage keeps the layout legible; mature stays one click away.
const growthScale = () => parseFloat(document.getElementById("growthStage").value) || 1;
const qualitySelect = document.getElementById('renderQuality');
const qualityNote = document.getElementById('renderQualityNote');
qualitySelect.value = renderQuality;
qualityNote.textContent = renderQuality === 'fast' ? 'Simplified plants · faster loading' : 'Full botanical detail';
qualitySelect.onchange = async () => {
  renderQuality = qualitySelect.value;
  saveRenderQuality(qualityStorage, renderQuality);
  const url = new URL(window.location.href);
  if (url.searchParams.has('quality')) {
    url.searchParams.set('quality', renderQuality);
    window.history.replaceState(window.history.state, '', url);
  }
  applyRenderQuality(renderer, renderQuality, window.devicePixelRatio, shadowsOn);
  qualityNote.textContent = renderQuality === 'fast' ? 'Simplified plants · faster loading' : 'Loading full detail…';
  await loadDesign(true);
  for (const name of [...overlays.keys()]) await setOverlay(name, true);
  qualityNote.textContent = renderQuality === 'fast' ? 'Simplified plants · faster loading' : 'Full botanical detail';
};
// the shadow control — its own question, beside the sun it belongs to
{
  const box = document.getElementById("chkShadows");
  if (box) {
    box.checked = shadowsOn;
    box.onchange = () => {
      shadowsOn = box.checked;
      saveShadows(qualityStorage, shadowsOn);
      // setShadows, not applyRenderQuality: the flag alone does nothing after the
      // first frame, because three compiles USE_SHADOWMAP into every program
      setShadows(renderer, scene, shadowsOn);
    };
  }
}
// THE SITE OPENS AT FULL SIZE because a plan is spaced for grown plants.
// The other stages stay available, and the last choice is remembered as view
// state in localStorage.
const GROWTH_KEY = "yardtwin.growthStage";
try {
  const saved = localStorage.getItem(GROWTH_KEY);
  const sel = document.getElementById("growthStage");
  if (saved && [...sel.options].some(o => o.value === saved)) sel.value = saved;
} catch {}
document.getElementById("growthStage").onchange = () => {
  try { localStorage.setItem(GROWTH_KEY, document.getElementById("growthStage").value); } catch {}
  // the cards draw the plant at its own size, so a change of stage invalidates
  // every cached thumbnail — otherwise the window shows last stage's garden
  forgetThumbs();
  if (assetWindowOpen()) renderAssetWindow();
  loadDesign(true);
};

function applyLayers() {
  const on = id => document.getElementById(id).checked;
  designsGroup.visible = on("layDesign");
  // a group hides as ONE thing — the node is the group, so this is a flag on a
  // handful of nodes rather than a loop over every object
  applyGroupVisibility(designGroup, hiddenGroups());
  applyObjectVisibility(designGroup, hiddenObjectIds());
  if (footprintGroup) {
    footprintGroup.visible = on("laySite") || on("layHouse");
    for (const c of footprintGroup.children) {
      // the house outline has its own toggle; pins/labels follow "markers"
      c.visible = c.name === "houseOutline" ? on("layHouse") : on("laySite");
    }
  }
  // Plant names are a working aid, not part of the garden: with a couple of hundred plants the
  // labels are most of what you see from any distance, and every judgement about
  // colour, massing or height is made THROUGH them. VIEW state, so localStorage
  // and never a design field.
  const showNames = on("layPlantLabels");
  designGroup?.traverse(o => { if (o.userData?.plantLabel) o.visible = showNames; });
  for (const o of overlays.values())
    o.group.traverse(n => { if (n.userData?.plantLabel) n.visible = showNames; });
  proposalGroup.visible = on("laySite");
  if (areaGroup) areaGroup.visible = on("laySite");
  markers.visible = on("laySite");
  if (stage) stage.visible = on("layScan");
  // the two-suns note is about the PLATE, so hiding it resolves the contradiction
  if (typeof syncTwoSuns === "function") syncTwoSuns();
}
for (const id of ["layDesign", "laySite", "layHouse", "layScan", "layPlantLabels"]) {
  const el = document.getElementById(id);
  if (!el) continue;
  // remember it: a preference you have to re-set on every reload is not a setting
  try {
    const v = localStorage.getItem("yardtwin.layer." + id);
    if (v !== null) el.checked = v === "1";
  } catch {}
  el.onchange = () => {
    try { localStorage.setItem("yardtwin.layer." + id, el.checked ? "1" : "0"); } catch {}
    applyLayers();
  };
}

// ------------------------------------------------------------------ design variants
// design.json is always the working file the agent edits; variants are named
// copies in data/designs/, so trying an alternative never destroys the last one.
const BLANK_DESIGN = { version: 1, units: "meters", style: "", notes: "", beds: [], paths: [], patios: [], plants: [] };
// WHICH SAVED DESIGN YOU ARE EDITING survives reloads, so ⌘S keeps saving to
// that design. This is view state in localStorage, checked against the saved
// list on every refresh so a missing file is never recreated accidentally.
let currentVariant = (() => { try { return localStorage.getItem(VARIANT_KEY) || ""; } catch { return ""; } })();
function setCurrentVariant(name, opts) {
  currentVariant = name || "";
  try { currentVariant ? localStorage.setItem(VARIANT_KEY, currentVariant) : localStorage.removeItem(VARIANT_KEY); } catch {}
  switchViewScope(currentVariant, opts);      // hidden and folded belong to the design
}

async function writeJson(file, json) {
  const r = await fetch("/api/save", { method: "POST", body: JSON.stringify({ file, json }) });
  return r.ok;
}

// Anything that overwrites design.json archives it first so switching variants
// cannot destroy unsaved work. Agent snapshots alone do not cover hand switches.
//
// Returns the archive STAMP so a caller replacing the working design can offer
// to restore it. `true` means nothing needed archiving and there is no undo;
// `false` means archiving failed, and the caller must not proceed.
async function snapshotWorking() {
  let design;
  try { design = await fetchJson("/data/design.json"); } catch { return true; }
  const n = (design.beds?.length ?? 0) + (design.paths?.length ?? 0)
    + (design.edges?.length ?? 0) + (design.plants?.length ?? 0);
  if (!n) return true;                       // nothing worth keeping
  const d = new Date();
  const p = x => String(x).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    + `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return await writeJson(`data/history/design-${stamp}.json`, design) ? stamp : false;
}

// UNDO A DESIGN SWITCH.
//
// Clicking a Saved name replaces the working design wholesale. Name the
// recovery action in the status line immediately so the owner can restore the
// archived version without searching files. This is one step deep: the History
// list holds the full record, avoiding a second competing undo stack.
let undoSwitch = null;              // {stamp, label} — the design this replaced

function offerUndoSwitch(stamp, label) {
  undoSwitch = typeof stamp === "string" ? { stamp, label } : null;
}

// WHERE THE WORKING DESIGN CAME FROM.
//
// Record the source explicitly so the list can show a version chain without
// inferring ancestry from filenames.
//
// It is deliberately NOT derived from `currentVariant` at save time. Restoring a
// version from the archive clears `currentVariant` (the working design is no
// longer any saved one), and the design still came from somewhere — so the
// origin is recorded where it actually happens, by each thing that replaces the
// working design.
let workingFrom = null;

// ── the clipboard ──────────────────────────────────────────────────
//
// Grouping and planting cross a design boundary only when the user explicitly
// copies and pastes. Switching designs never copies groups implicitly.
//
// Hold RECORDS, not ids. `next_id` recycles freed ids, so an id alone can bind
// to an unrelated plant in another design. Copy the plant or object itself;
// paste mints new ids through the ordinary ops path.
//
// localStorage, because the whole point is that it outlives the design you were
// in, and a reload in between is normal.
const CLIP_KEY = "yardtwin.clipboard";

function readClipboard() {
  try { return JSON.parse(localStorage.getItem(CLIP_KEY) || "null"); }
  catch { return null; }
}

function copySelection() {
  if (!selection.size) { log("select something to copy first", "warn"); return; }
  const items = [];
  for (const id of selection) {
    const found = rawById(currentDesign, id);
    if (!found) continue;
    if (found.kind !== "plant" && !MOVE_AS[found.kind]) continue;   // movable kinds
    items.push({ kind: found.kind, raw: found.raw });
  }
  if (!items.length) { log("nothing in the selection can be copied", "warn"); return; }
  // the centroid, so a paste can be placed RELATIVE to where the cursor is
  // rather than dropped back at the coordinates of another design's yard
  const pts = items.map(i => i.raw.position
    ?? (i.raw.polygon ?? i.raw.spline ?? [])[0]).filter(Array.isArray);
  const origin = pts.length
    ? [pts.reduce((a, p) => a + p[0], 0) / pts.length,
       pts.reduce((a, p) => a + p[1], 0) / pts.length]
    : [0, 0];
  try {
    localStorage.setItem(CLIP_KEY, JSON.stringify({ items, origin, from: currentVariant || "the working design" }));
  } catch { log("could not write the clipboard", "err"); return; }
  log(`copied ${items.length} — ⌘V pastes ${currentVariant ? "into any design" : "anywhere"}`, "ok");
}

async function pasteClipboard() {
  const clip = readClipboard();
  if (!clip?.items?.length) { log("the clipboard is empty — select something and press ⌘C", "warn"); return; }
  // OFFSET, not absolute. Pasting another design's coordinates lands things
  // wherever they happened to stand there, which for a different yard is
  // meaningless and for the same yard is on top of the original.
  const dx = 0.8, dy = 0.8;
  const ops = [];
  for (const { kind, raw } of clip.items) {
    try { ops.push(...duplicateOps(kind, raw, dx, dy)); }
    catch (e) { log(`${raw?.id ?? "an item"}: ${e?.message ?? e}`, "warn"); }
  }
  if (!ops.length) { log("nothing on the clipboard could be pasted here", "warn"); return; }
  await snapshotWorking();
  if (await postOps(ops, `paste ${ops.length}`))
    log(`pasted ${ops.length} from ${clip.from}`, "ok");
}

async function loadVariant(name) {
  const v = await fetchJson(docUrlFor(name)).catch(() => null);
  if (!v) { log(`could not read design "${name}"`, "err"); return; }
  const was = currentVariant ? `"${currentVariant}"` : "the working design";
  const stamp = await snapshotWorking();
  // A GROUP BELONGS TO ITS DESIGN. Preserve its groups in the whole document,
  // but never carry them implicitly into another design. Explicit ⌘C/⌘V is
  // the way to transfer them across that boundary.
  const doc = v;
  if (!await writeDesignDocument(doc, "switch design", { replace: true })) return;
  offerUndoSwitch(stamp, was);
  invalidateVariant(name);
  setCurrentVariant(name);
  workingFrom = name;
  setSelection([]);
  loadDesign(true);
  refreshDesignList();
  log(`switched to "${name}" — edits now apply to it`, "ok");
}

/**
 * Which saved variant is data/design.json, by CONTENT.
 *
 * Compare the working file to saved content so the UI identifies what is
 * actually on screen, including after reload. Returns {name, dirty}; dirty
 * means the working content matches no saved file and has unsaved edits.
 */
const variantHashes = new Map();          // name -> serialised contents

async function identifyLoadedDesign(names) {
  const live = await fetchJson("/data/design.json").catch(() => null);
  if (!live) return { name: "", dirty: false };
  const key = JSON.stringify(live);
  // A NAME WHOSE FILE IS GONE IS NOT BEING EDITED — or ⌘S would recreate it.
  if (currentVariant && !names.includes(currentVariant)) setCurrentVariant("");
  // Cache the variants: this runs on every design change, and re-fetching a
  // dozen files each time would turn the 1.2 s poll into a request storm.
  // "update"/"delete"/"save as" all call invalidateVariant().
  const contentOf = async n => {
    if (!variantHashes.has(n)) {
      const v = await fetchJson(docUrlFor(n)).catch(() => null);
      variantHashes.set(n, v ? JSON.stringify(v) : null);
    }
    return variantHashes.get(n);
  };
  // THE ONE YOU ARE EDITING WINS A TIE. Saved designs can have identical
  // content; taking the first in list order could redirect ⌘S to a scratch copy.
  if (currentVariant && await contentOf(currentVariant) === key) return { name: currentVariant, dirty: false };
  for (const n of names) {
    if (await contentOf(n) === key) return { name: n, dirty: false };
  }
  return { name: currentVariant, dirty: !!currentVariant };
}

// Invalidate BOTH caches so comparisons measure the artefact on disk, not an
// overwritten version. Stale numbers mislead the user choosing between designs.
const invalidateVariant = name => {
  if (name) { variantHashes.delete(name); comparedDocs.delete(name); }
  else { variantHashes.clear(); comparedDocs.clear(); }
};

// Default to most-recent-first so the user can find the design they just worked
// on. Names need not carry dates, so alphabetical order cannot do that.
// Filtering complements sorting when the saved list grows.
let designMeta = {};                    // name -> {mtime_ms, size}, from /api/designs

/**
 * The rows to draw, filtered and ordered. Pure, so it can be tested without a DOM.
 *
 * The design being EDITED is pinned to the top whatever the sort says, and is
 * never filtered away: losing sight of what you are editing because you typed in
 * a search box is a worse problem than the one the search box solves.
 */
export function orderDesigns(names, meta, opts) {
  // Destructured in the BODY, not the parameter list: several suites read a
  // function out of this source by scanning braces from its name, so a `{...}`
  // in the signature hands them the parameter list instead. Same reason
  // writeDesignDocument takes a plain `opts`.
  const { sort = "recent", filter = "", current = "" } = opts ?? {};
  const q = filter.trim().toLowerCase();
  const kept = names.filter(n => n === current || !q || n.toLowerCase().includes(q));
  const at = n => meta?.[n]?.mtime_ms ?? 0;
  const by = {
    recent: (a, b) => at(b) - at(a) || a.localeCompare(b),
    oldest: (a, b) => at(a) - at(b) || a.localeCompare(b),
    name:   (a, b) => a.localeCompare(b),
  }[sort] ?? ((a, b) => a.localeCompare(b));
  kept.sort(by);
  // an undated design (meta missing) must not silently jump to the top of
  // "most recent" — localeCompare above already breaks that tie by name
  const i = kept.indexOf(current);
  if (i > 0) kept.unshift(kept.splice(i, 1)[0]);
  return kept;
}

// The list rebuild awaits both the variant listing and content match. Concurrent
// calls could each clear and append, listing every design twice. Fold an
// arriving call into the running one to prevent that race.
let listRebuild = null, listAgain = false;

async function refreshDesignList(selected) {
  if (selected !== undefined) setCurrentVariant(selected);
  // Set the label HERE rather than only at boot so it follows variant loads.
  showWhichDesign();
  if (listRebuild) { listAgain = true; return listRebuild; }
  listRebuild = (async () => {
    try {
      do { listAgain = false; await rebuildDesignList(); } while (listAgain);
    } finally { listRebuild = null; }
  })();
  return listRebuild;
}

/**
 * Show or hide a saved design ALONGSIDE the working one.
 *
 * Two designs occupying the same ground would be unreadable drawn identically,
 * so an overlay is ghosted — the onion-skin convention: the design you are
 * editing stays fully opaque and reads as primary, the comparisons sit behind
 * it. Materials are cloned before being made transparent; several of them are
 * shared across instances and mutating one in place would fade the working
 * design too.
 */
async function setOverlay(name, on) {
  const had = overlays.get(name);
  if (had) { designsGroup.remove(had.group); disposeObj(had.group, "mesh"); overlays.delete(name); }
  if (!on) return true;
  const d = await fetchJson(docUrlFor(name)).catch(() => null);
  if (!d) { log(`could not read "${name}"`, "err"); return false; }
  // the builders' textures in BOTH modes — Fast at 256 px, or it draws them dark
  await preparePlantTextures(renderQuality);
  await ensurePlantModels(d, renderQuality);
  await ensureObjectModels(objectModelsNeededBy(d));   // see loadDesign: not a detail level
  const g = await buildDesignGroup(colourFromPalette(d), heightAt, growthScale(), { quality: renderQuality });
  g.name = `overlay:${name}`;
  g.userData.overlay = name;
  g.traverse(o => {
    if (!o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const ghosted = mats.map(m => {
      const c = m.clone();
      c.transparent = true;
      c.opacity = (m.opacity ?? 1) * 0.42;
      c.depthWrite = false;      // or the ghost punches a hole in what it covers
      return c;
    });
    o.material = Array.isArray(o.material) ? ghosted : ghosted[0];
    // an overlay is for looking at, not for clicking: keep it out of selection
    o.userData.pickable = false;
  });
  designsGroup.add(g);
  overlays.set(name, { group: g, design: d });
  return true;
}

// SAVED or HISTORY is view state, not a design fact. Keep the list choice in
// localStorage, as with per-object visibility.
const DESIGN_SOURCE_KEY = "yt.designsource.v1";
let designListSource = localStorage.getItem(DESIGN_SOURCE_KEY) === "history"
  ? "history" : "saved";

function setDesignSource(which) {
  designListSource = which === "history" ? "history" : "saved";
  localStorage.setItem(DESIGN_SOURCE_KEY, designListSource);
  document.getElementById("btnSrcSaved")?.classList.toggle("active", designListSource === "saved");
  document.getElementById("btnSrcHistory")?.classList.toggle("active", designListSource === "history");
  // the filter and sort belong to the SAVED list; the archive is chronological
  // by construction and filtering it by name would filter a column of identical names
  const find = document.getElementById("designFind");
  if (find) find.hidden = designListSource === "history";
  refreshDesignList();
}

/**
 * THE ARCHIVE, WITH A DOOR ON IT.
 *
 * snapshotWorking() archives every design switch. The endpoint collapses
 * consecutive identical snapshots so each row is a changed version rather
 * than another copy of the same file.
 *
 * Restore archives the working design FIRST through snapshotWorking, making
 * the restore itself undoable and preserving the current work.
 */
async function rebuildHistoryList() {
  const box = document.getElementById("designList");
  box.innerHTML = "";
  let rows = [], archived = 0;
  try {
    const got = await (await fetch("/api/history?n=400")).json();
    rows = got.history ?? []; archived = got.archived ?? 0;
  } catch { /* an unreachable archive is an empty one, not a crash */ }

  const cur = document.getElementById("designCur");
  if (cur) cur.textContent = rows.length
    ? `${rows.length} versions kept for you` + (archived > rows.length
        ? ` (${archived} archived, identical ones collapsed)` : "")
    : "nothing archived yet";
  const countEl = document.getElementById("designCount");
  if (countEl) countEl.textContent = rows.length ? `${rows.length}` : "";

  if (!rows.length) {
    const e = document.createElement("div");
    e.className = "hint";
    e.textContent = "nothing archived yet — a version is kept every time you "
      + "switch design or start a new one";
    box.appendChild(e);
    renderCompare();
    return;
  }

  for (const r of rows) {
    const key = historyKey(r.name);
    const row = document.createElement("div");
    row.className = "drow";

    const shown = overlays.has(key);
    const eye = document.createElement("button");
    eye.className = "eye" + (shown ? " on" : "");
    eye.textContent = shown ? "◉" : "○";
    eye.title = shown ? "stop showing this version"
      : "show this version alongside the one you are editing";
    eye.onclick = async ev => {
      ev.stopPropagation();
      eye.disabled = true;
      await setOverlay(key, !overlays.has(key));
      refreshDesignList();
    };

    const n = document.createElement("span");
    n.className = "dn";
    n.textContent = readStamp(r.stamp);
    n.title = `${r.name} — click Restore to bring this version back`;

    const meta = document.createElement("span");
    meta.className = "meta";
    const bits = Object.entries(r.counts ?? {})
      .map(([k, v]) => `${v} ${kindPlural(k.replace(/s$/, ""), v)}`);
    meta.textContent = r.total == null ? "unreadable"
      : `${r.total} object${r.total === 1 ? "" : "s"}`;
    meta.title = bits.join(" · ") || "nothing in this version";
    if (r.repeats) meta.textContent += ` · kept ${r.repeats + 1}×`;

    const back = document.createElement("button");
    back.textContent = "restore";
    back.title = "make this version the working design — the current one is "
      + "archived first, so this is undoable";
    back.onclick = async () => {
      const d = await fetchJson(docUrlFor(key)).catch(() => null);
      if (!d) { log("could not read that version", "err"); return; }
      const was = currentVariant ? `"${currentVariant}"` : "the working design";
      const stamp = await snapshotWorking();
      await writeDesignDocument(d, "restore a version", { replace: true });
      offerUndoSwitch(stamp, was);
      setCurrentVariant("");
      // it is no longer any SAVED design, but it did come from somewhere
      workingFrom = `the version from ${readStamp(r.stamp)}`;
      setSelection([]);
      await loadDesign(true);
      refreshDesignList();
      log(`restored the version from ${readStamp(r.stamp)}`, "ok");
    };

    row.append(eye, n, meta, back);
    box.appendChild(row);
  }
  renderCompare();
}

async function rebuildDesignList() {
  if (designListSource === "history") return rebuildHistoryList();
  const box = document.getElementById("designList");
  box.innerHTML = "";
  let designs = [];
  try {
    const got = await (await fetch("/api/designs")).json();
    designs = got.designs ?? [];
    designMeta = got.meta ?? {};
  } catch {}
  const ident = await identifyLoadedDesign(designs);
  if (ident.name) setCurrentVariant(ident.name);
  // editing a variant that is also ghosted would draw it twice, once faded
  if (currentVariant && overlays.has(currentVariant)) await setOverlay(currentVariant, false);
  const cur = document.getElementById("designCur");
  const alongside = overlays.size ? ` + ${overlays.size} shown alongside` : "";
  cur.textContent = (currentVariant
    ? `editing "${currentVariant}"${ident.dirty ? " — modified, not saved" : ""}`
    : "unsaved working design") + alongside;
  cur.classList.toggle("dirty", !!ident.dirty);
  // the way back from the click that replaced everything
  if (undoSwitch) {
    const back = document.createElement("button");
    back.className = "linkish";
    back.textContent = "undo";
    back.title = `put ${undoSwitch.label} back — it was archived as `
      + `design-${undoSwitch.stamp}, so this is itself undoable`;
    back.onclick = async () => {
      const u = undoSwitch;
      const d = await fetchJson(`/data/history/design-${u.stamp}.json`).catch(() => null);
      if (!d) { log("that archive is no longer readable — try the History list", "err"); return; }
      // snapshot FIRST, so undoing an undo is possible: the design being put
      // back is still a design someone may have meant to keep
      const stamp = await snapshotWorking();
      if (!await writeDesignDocument(d, "undo the switch", { replace: true })) return;
      // identifyLoadedDesign answers by content on refresh. Clear the previous
      // variant first so the status cannot name a design that was replaced.
      offerUndoSwitch(stamp, "the design you switched to");
      setCurrentVariant("");
      workingFrom = `the version from before the switch`;
      setSelection([]);
      await loadDesign(true);
      refreshDesignList();
      log(`put ${u.label} back`, "ok");
    };
    cur.appendChild(back);
  }
  // a name in the always-visible header too: the Design section collapses, and
  // "which design am I looking at" should not depend on a panel being open
  const badge = document.getElementById("nowShowing");
  if (badge) {
    badge.textContent = currentVariant || "unsaved";
    badge.classList.toggle("dirty", !!ident.dirty);
  }
  if (!designs.length) {
    const e = document.createElement("div");
    e.className = "hint"; e.textContent = "no saved designs yet — Save as… keeps one by name";
    box.appendChild(e);
    return;
  }
  const sortSel = document.getElementById("designSort");
  const filtEl = document.getElementById("designFilter");
  const shownNames = orderDesigns(designs, designMeta, {
    sort: sortSel?.value || "recent",
    filter: filtEl?.value || "",
    current: currentVariant,
  });
  const countEl = document.getElementById("designCount");
  if (countEl) countEl.textContent = shownNames.length === designs.length
    ? `${designs.length}` : `${shownNames.length} of ${designs.length}`;
  for (const name of shownNames) {
    const row = document.createElement("div");
    row.className = "drow" + (name === currentVariant ? " cur" : "");
    if (name === currentVariant) queueMicrotask(() => row.scrollIntoView({ block: "nearest" }));
    // the eye comes FIRST, because "show me this one" is the cheap, reversible
    // question and "load it for editing" is the destructive one
    const eye = document.createElement("button");
    const isActive = name === currentVariant;
    const shown = overlays.has(name);
    eye.className = "eye" + (shown ? " on" : "") + (isActive ? " active" : "");
    eye.textContent = isActive ? "◉" : (shown ? "◉" : "○");
    eye.title = isActive
      ? `"${name}" is the design you are editing — it is always shown`
      : (shown ? `stop showing "${name}"` : `show "${name}" alongside the one you are editing`);
    eye.disabled = isActive;
    eye.onclick = async ev => {
      ev.stopPropagation();
      eye.disabled = true;
      await setOverlay(name, !overlays.has(name));
      refreshDesignList();
    };

    const n = document.createElement("span");
    n.className = "dn"; n.textContent = name; n.title = `load "${name}" for editing`;
    n.onclick = () => loadVariant(name);
    const upd = document.createElement("button");
    upd.textContent = "update"; upd.title = `overwrite "${name}" with the working design`;
    upd.onclick = () => updateVariant(name);
    const del = document.createElement("button");
    del.textContent = "✕"; del.title = `delete the saved design "${name}"`;
    del.onclick = async () => {
      const r = await fetch("/api/delete", { method: "POST",
        body: JSON.stringify({ file: `data/designs/${name}.json` }) });
      if (!r.ok) { log(`could not delete "${name}"`, "err"); return; }
      invalidateVariant(name);
      if (currentVariant === name) setCurrentVariant("");
      // its view state goes with it, or a later design given the same name inherits
      // what the user had hidden in a garden that no longer exists
      viewStore = dropViewScope(viewStore, viewScopeOf(name));
      saveViewStore();
      refreshDesignList();
      log(`deleted saved design "${name}" (the working design is untouched)`, "ok");
    };
    // Show WHAT IT IS as well as its name so versions are distinguishable.
    // /api/designs caches counts by mtime, avoiding dozens of reads per poll.
    // Append nodes in order: insertBefore requires its reference node to be a
    // child already, or it throws NotFoundError and leaves the list empty.
    const m = designMeta?.[name];
    let meta = null;
    if (m && Number.isFinite(m.plants)) {
      meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent = `${m.plants} plants · ${m.species} species`;
      meta.title = `${m.beds} beds · ${m.paths} paths · ${m.patios} patios · ${m.objects} objects`;
    }
    // Show recorded ancestry on its own line. Omit it when unknown; deriving a
    // parent from a filename would present a guess as fact.
    let from = null;
    if (m?.from) {
      from = document.createElement("span");
      from.className = "from";
      from.textContent = `from ${m.from}`;
      from.title = `"${name}" was saved while editing ${m.from}`;
    }
    // WHICH BEDS ARE CROWDED WHEN GROWN. Plant and species counts alone do
    // not describe mature crowding. Omit this line when no bed exceeds the
    // threshold so uncrowded designs remain easy to distinguish.
    let crowded = null;
    const cl = crowdedLine(m?.crowded);
    if (cl) {
      crowded = document.createElement("span");
      crowded.className = "crowded";
      crowded.textContent = cl.text;
      crowded.title = cl.title;
    }
    row.append(eye, n, ...(meta ? [meta] : []), ...(from ? [from] : []),
               ...(crowded ? [crowded] : []), upd, del);
    box.appendChild(row);
  }
  renderCompare();
}

// Design documents already fetched, so opening the comparison does not re-read
// what setOverlay just read. Cleared whenever a variant is written.
const comparedDocs = new Map();

/**
 * The NUMBERS half of comparing designs.
 *
 * The eye ghosts a saved design behind the working one. Measure that same
 * selection so the visual and numerical comparisons need no separate mode.
 *
 * Every figure is a MEASUREMENT, never a score. Physical facts are enforced;
 * taste is reported, so this table must not rank designs.
 */
let compareRun = 0;
async function renderCompare() {
  const box = document.getElementById("designCompare");
  if (!box) return;
  // A LATER CALL WINS. Two fetches and re-entrant list rebuilds can let an
  // earlier call with an empty overlay set finish last. Prevent it from
  // overwriting the newer comparison table.
  const run = ++compareRun;
  const names = [...overlays.keys()];
  box.innerHTML = "";
  if (!names.length) {
    const e = document.createElement("div");
    e.className = "hint";
    e.textContent = "turn on the eye beside a design to show it alongside this one "
                  + "and compare the numbers";
    box.appendChild(e);
    return;
  }
  const working = await fetchJson("/data/design.json").catch(() => null);
  // Use docUrlFor, like setOverlay, so ghosted HISTORY snapshots and their
  // comparison columns always read the same file.
  const docs = await Promise.all(names.map(async n => {
    if (!comparedDocs.has(n))
      comparedDocs.set(n, await fetchJson(docUrlFor(n)).catch(() => null));
    return { name: compareLabel(n), doc: comparedDocs.get(n) };
  }));
  if (run !== compareRun) return;            // superseded while we were fetching
  const table = compareTable([{ name: currentVariant || "this design", doc: working }, ...docs]);
  if (!table.cols.length) return;
  box.innerHTML = "";                        // ...and we own the box again

  const head = document.createElement("div");
  head.className = "p-label";
  head.textContent = "compared";
  box.appendChild(head);

  const t = document.createElement("table");
  t.className = "cmp";
  const hr = document.createElement("tr");
  hr.appendChild(document.createElement("th"));
  for (const c of table.cols) {
    const th = document.createElement("th");
    th.textContent = c.name; th.title = c.name;
    hr.appendChild(th);
  }
  t.appendChild(hr);
  for (const r of table.rows) {
    const tr = document.createElement("tr");
    const lab = document.createElement("th");
    lab.className = "cmp-lab"; lab.textContent = r.label;
    if (r.note) lab.title = r.note;
    tr.appendChild(lab);
    for (const v of r.values) {
      const td = document.createElement("td");
      // a measurement that does not exist says so rather than printing a zero
      // a size in the project's unit; a count or a ratio as it is
      const shown = x => r.unit === "area" ? fmtArea(x) : r.unit === "length" ? fmtLen(x) : `${x}${r.suffix ?? ""}`;
      td.textContent = v.value === null || v.value === undefined ? "—" : shown(v.value);
      const d = !r.unit ? diffText(v.diff, r.suffix ?? "")
              : v.diff ? `${v.diff > 0 ? "+" : "−"}${shown(Math.abs(v.diff))}` : "";
      if (d) {
        const s = document.createElement("span");
        s.className = "cmp-diff"; s.textContent = ` ${d}`;
        td.appendChild(s);
        // the cell clips at 296 px and the difference is the half that goes; the
        // title carries it whole rather than ending in an ellipsis
        td.title = `${td.textContent.trim()} against ${table.cols[0].name}`;
      }
      tr.appendChild(td);
    }
    t.appendChild(tr);
  }
  box.appendChild(t);

  // Explain the coverage number: 1.66 alone does not convey the range. Over
  // 2x is crowded at full maturity, the size used to compare designs.
  const cov = table.rows.find(r => r.key === "coverage");
  const notes = (cov?.values ?? [])
    .map((v, i) => ({ name: table.cols[i]?.name, note: coverageNote(v.value) }))
    .filter(x => x.note);
  if (notes.length) {
    const ul = document.createElement("div");
    ul.className = "cmp-reading";
    for (const n of notes) {
      const li = document.createElement("div");
      li.innerHTML = `<b>${n.name}</b> ${n.note}`;
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }
}

/** Overwrite a saved design with the working one — the row's "update", and ⌘S. */
async function updateVariant(name) {
  const d = await fetchJson("/data/design.json").catch(() => null);
  if (!d) return false;
  if (!await writeJson(`data/designs/${name}.json`, d)) { log(`could not save "${name}"`, "err"); return false; }
  invalidateVariant(name);
  setCurrentVariant(name); refreshDesignList();
  log(`"${name}" updated from the working design`, "ok");
  return true;
}

// ⌘S SAVES WHAT YOU ARE EDITING instead of invoking the browser's page save.
// With no saved design to overwrite, ask for a name as Save as… does.
function saveDesign() {
  if (currentVariant) return updateVariant(currentVariant);
  document.getElementById("btnDesignSaveAs").click();
}

document.getElementById("btnDesignSaveAs").onclick = async () => {
  const name = (prompt("Save this design as:", currentVariant || "variant_1") ?? "")
    .trim().replace(/[^\w-]+/g, "_").toLowerCase();
  if (!name) return;
  const design = await fetchJson("/data/design.json").catch(() => BLANK_DESIGN);
  // WHERE IT CAME FROM, written at the one place a design is named. The
  // inherited value is DROPPED rather than trusted: switching to a saved design
  // copies its whole document into the working file, `from` and all, so keeping
  // it would make this design claim its grandparent.
  const doc = { ...design };
  delete doc.from;
  if (workingFrom && workingFrom !== name) doc.from = workingFrom;
  if (!await writeJson(`data/designs/${name}.json`, doc)) { log("save failed", "err"); return; }
  // Save as… names the garden ALREADY ON SCREEN and carries its view state too
  setCurrentVariant(name, { carry: true });
  workingFrom = name;             // what the user edits next descends from THIS one
  invalidateVariant(name);
  await refreshDesignList(name);
  log(`design saved as "${name}"` + (doc.from ? `, from ${doc.from}` : "")
      + " — the working design is unchanged", "ok");
};

// THE SNAP STEP IS REMEMBERED as an editing preference, not part of the design.
{
  const el = document.getElementById("snapStep");
  try { const v = localStorage.getItem("yardtwin.snapStep"); if (el && v) el.value = v; } catch {}
  if (el) el.onchange = () => { try { localStorage.setItem("yardtwin.snapStep", el.value); } catch {} };
}

// Sorting and filtering the saved designs. VIEW state, so localStorage and never
// a design field — the same rule per-object visibility follows.
for (const [id, key] of [["designSort", "yardtwin.designSort"],
                         ["designFilter", "yardtwin.designFilter"]]) {
  const el = document.getElementById(id);
  if (!el) continue;
  try { const v = localStorage.getItem(key); if (v !== null) el.value = v; } catch {}
  const onChange = () => {
    try { localStorage.setItem(key, el.value); } catch {}
    refreshDesignList();
  };
  el.oninput = onChange;
  el.onchange = onChange;
}

document.getElementById("btnDesignNew").onclick = async () => {
  // an empty design descends from nothing, and saying it came from the garden
  // it replaced would be the false claim REPLACED_KEYS exists to stop
  if (!confirm("Start an empty design? The current one is archived to data/history/ (save it as a variant first if you want it back by name).")) return;
  if (!await snapshotWorking()) { log("could not archive the current design — not clearing it", "err"); return; }
  if (!await writeDesignDocument(BLANK_DESIGN, "new design", { replace: true })) return;
  setCurrentVariant("");
  workingFrom = null;
  refreshDesignList();
  loadDesign(true);
  log("started an empty design", "ok");
};



// DESIGNING HAPPENS IN THE ACTIVE MODEL SESSION, with the full conversation.
// A viewer brief handed to a fresh process loses context and can turn a
// preference about usability into a false constraint on changing hardscape.
//
// /api/design and tools/agent.py remain available for a web UI, but this viewer
// does not invite the user to design through a separate brief-only session.
document.getElementById("btnAlign").onclick = () => setMode(mode === "align" ? "orbit" : "align");
document.getElementById("btnLoadSite").onclick = loadSite;
document.getElementById("btnDesign").onclick = () => loadDesign(true);
document.getElementById("btnSave").onclick = saveCalib;
document.getElementById("btnShot").onclick = () => {
  const a = document.createElement("a");
  a.download = `pedon-${Date.now()}.png`;
  a.href = renderer.domElement.toDataURL("image/png");
  a.click();
  log("screenshot downloaded");
};
document.getElementById("btnBookmark").onclick = () => {
  calib.bookmarks.default = { pos: camera.position.toArray(), target: controls.target.toArray() };
  saveCalib();          // persist now — "saved" should mean saved to disk
};
document.getElementById("btnGoBookmark").onclick = () => {
  if (!goToBookmark()) log("no saved view yet — press Save view first", "warn");
};

setInterval(() => { if (document.getElementById("chkPoll").checked) loadDesign(); }, 1200);

// ------------------------------------------------------------------ boot + loop
// Restore the whole session: the capture that was calibrated, the site
// overlay, and the saved camera view — reopening the viewer should put you
// back where you left off, not at a file picker.
// WHERE THE CAMERA WAS, kept as it moves and put back on reload. Only after
// boot has restored it, or boot's own framing would overwrite the one to restore.
const LAST_CAMERA_KEY = siteKey("yardtwin.lastCamera", SITE);   // where the camera stood — on THIS site
adoptLegacy(localStorage, "yardtwin.lastCamera", SITE);
let cameraRemembering = false, cameraWriteTimer = null;
function rememberCamera() {
  if (!cameraRemembering) return;
  try {
    localStorage.setItem(LAST_CAMERA_KEY, JSON.stringify({
      pos: camera.position.toArray(), target: controls.target.toArray(),
      capture: calib.captureUrl ?? null }));
  } catch {}
}
controls.addEventListener("change", () => {
  if (!cameraRemembering || cameraWriteTimer) return;
  cameraWriteTimer = setTimeout(() => { cameraWriteTimer = null; rememberCamera(); }, 250);
});
addEventListener("pagehide", rememberCamera);
function restoreLastCamera() {
  let raw = null;
  try { raw = localStorage.getItem(LAST_CAMERA_KEY); } catch {}
  const v = readLastCamera(raw, calib.captureUrl ?? null);
  if (!v) return false;
  camera.position.fromArray(v.pos);
  controls.target.fromArray(v.target);
  controls.update();
  return true;
}

function goToBookmark() {
  const b = calib.bookmarks?.default;
  if (!b) return false;
  camera.position.fromArray(b.pos);
  controls.target.fromArray(b.target);
  controls.update();
  return true;
}

/** The captures list again, after one was added (the placeholder option stays). */
async function refreshCaptures(selected) {
  const sel = document.getElementById("captureSel");
  while (sel.options.length > 1) sel.remove(1);
  return populateCaptures(selected);
}

async function populateCaptures(selected) {
  const sel = document.getElementById("captureSel");
  try {
    const { captures } = await (await fetch("/api/captures")).json();
    knownCaptures = captures;
    for (const f of captures) {
      const o = document.createElement("option");
      o.value = "/data/captures/" + f;
      o.textContent = f;
      sel.appendChild(o);
    }
    if (selected && captures.some(f => "/data/captures/" + f === selected)) sel.value = selected;
    return captures;
  } catch { return []; }
}

const reviewGroupFor = createReviewCache(group => disposeObj(group, "mesh"));

async function boot() {
  await tryLoadCalib();
  // which site this is, in the top bar from the first second — after the first
  // await, so the module (and topBar) has finished evaluating
  renderProject();
  loadOwned();                                   // the user's plants, for the Add library
  // FIRST, so the site loads around the saved camera without jumping at the
  // end; nothing later in boot moves it (loadSite(false), loadStage).
  const cameraBack = restoreLastCamera();
  cameraRemembering = true;
  await loadScanGrid();
  // stand up the render channel so a headless model can ask this tab for a view
  initViewport({ renderer, scene, camera, heightAt, enuToWorld,
                 // the render broker draws in WORLD space but is asked for
                 // subjects in ENU, so it needs both frames explicitly rather
                 // than guessing at scene children
                 enuGroup, levelGroup, worldToEnu, enuToWorldPoint, rebuildTerrain,
                 scanGrid: () => scanGrid,
                 // the two subtrees a photoreal export needs, named rather than
                 // guessed at: `export_scene` must hand over the SAME geometry
                 // the camera sees, and a traverse looking for "the design" by
                 // shape is how a second idea of what the design is gets born
                 designGroup: () => designGroup,
                 stage: () => stage,
                 setPreviewSource: p => { previewSource = p || null;
                                          lastDesignText = "";   // force a rebuild
                                          showWhichDesign();
                                          return loadDesign(true); },
                 getPreviewSource: () => previewSource,
                 marchRayToGround,
                 getSite: () => siteCache, getDesign: () => currentDesign,
                 getReviewDesign: () => fetchJson(designSource()),
                 // the phone's scene is drawn in the palette's colours too
                 colour: d => colourFromPalette(d),
                 withReview: (design, run) => withReviewScene({
                   design: colourFromPalette(design), heightAt,
                   parent: enuGroup, displayed: designsGroup,
                   build: (d, h) => reviewGroupFor(d, h, calib, scanGrid),
                   dispose: () => {}, // retained until the proposal or ground changes
                 }, run) });
  // Before the first design builds: buildPlant() is synchronous and asks the
  // library for a model, so a late-arriving library would silently leave the
  // opening render procedural. But only the models this design actually NAMES —
  // a whole library of models need not all load for a design using two of them.
  // The rest load when the asset window asks to draw them.
  try {
    const opening = await (await fetch("/data/design.json", { cache: "no-store" })).json();
    // the builders' textures in BOTH modes — Fast at 256 px, or it draws them dark
    await preparePlantTextures(renderQuality);
    await ensurePlantModels(opening, renderQuality);
    await ensureObjectModels(objectModelsNeededBy(opening));  // not a detail level
  } catch (e) {
    console.warn("[assets] could not read the opening design; no models preloaded:", e.message);
  }
  // The species shortlist adds picker rows and planting colours. Start the
  // loader without awaiting it so a slow read cannot delay the first render.
  loadPlantCatalog();
  loadObjectLibrary();                 // not awaited either: it only adds rows to the picker
  // the manifest is what the library was BUILT from — each model's own measured
  // height and spread — so a shape picked by hand is offered at the size it will
  // really be drawn at. The URL comes from assets.js rather than being re-typed.
  try { libraryMeta = await fetchJson(MANIFEST_URL); }
  catch { /* no library: the palette is then this design's own species */ }
  loadDesign();
  loadSite(false);                     // no camera hijack; the bookmark wins
  const params = new URLSearchParams(location.search);
  const wanted = params.get("splat") ?? calib.captureUrl ?? null;
  const captures = await populateCaptures(wanted);
  if (wanted) {
    log(`reopening ${wanted.split("/").pop()}…`);
    await loadStage(wanted);
  } else if (captures.length === 1) {
    log(`one capture on disk — opening ${captures[0]}…`);
    await loadStage("/data/captures/" + captures[0]);
  }
  // apply the REMEMBERED list before the first render, or the buttons say
  // "Saved" while the archive is showing
  setDesignSource(designListSource);
  await refreshDesignList();
  applyLayers();
  if (cameraBack) log("back where you were");
  else if (goToBookmark()) log("restored your saved view");
  await restoreProposals();      // an unfinished review picks up where it left off
  tlReady = true;
  if (currentDesign) tlPush(currentDesign);   // seed the timeline with the loaded state
}
boot();

// ------------------------------------------------------------ walk through
// A garden is judged at 1.65 m standing on its own paths, not from a drone.
// This renders that view from several places along the design's circulation —
// which is where the failures actually show: a bed edge that is a straight
// line, a walk that aims at nothing, a shrub planted where your face goes.
let walkFrames = [];

function walkOverlayEl() { return document.getElementById("walkOverlay"); }

function closeWalk() {
  const o = walkOverlayEl();
  o.removeAttribute("open");
  o.setAttribute("aria-hidden", "true");
  document.getElementById("walkGrid").innerHTML = "";
  walkFrames = [];
}

document.getElementById("btnWalk").onclick = async () => {
  const design = await fetchJson("/data/design.json").catch(() => null);
  if (!design) { log("could not read the design", "err"); return; }
  const stations = planStations(design, 8);
  if (!stations.length) {
    log("nothing to walk yet — a design needs a path or a bed first", "warn");
    return;
  }
  // hide the app's own chrome so it is not baked into the frames
  const hid = [];
  for (const id of ["shellStore", "settings", "status", "labels"]) {
    const e = document.getElementById(id);
    if (e && e.style.display !== "none") { hid.push([e, e.style.display]); e.style.display = "none"; }
  }
  try {
    log(`walking ${stations.length} viewpoints…`);
    // Keep the grid, axes, north arrow and pins out of review images so they
    // cannot be mistaken for design objects. withCleanScene owns that cleanup.
    walkFrames = await withCleanScene(scene, () => renderWalkthrough(
      { renderer, scene, camera, heightAt, enuToWorld }, stations));
  } finally {
    for (const [e, d] of hid) e.style.display = d;
  }
  if (!walkFrames.length) {
    log("every viewpoint landed off the scanned ground — nothing to show", "warn");
    return;
  }
  const grid = document.getElementById("walkGrid");
  grid.innerHTML = walkFrames.map(f => `<figure>
      <img src="${f.dataUrl}" alt="${f.name}">
      <figcaption>${f.name} — standing at ${f.eye[0].toFixed(1)}, ${f.eye[1].toFixed(1)} m · ground ${f.ground_m} m</figcaption>
    </figure>`).join("");
  document.getElementById("walkWhere").textContent =
    `${walkFrames.length} viewpoints · eye height 1.65 m${currentVariant ? ` · "${currentVariant}"` : ""}`;
  const o = walkOverlayEl();
  o.setAttribute("open", "");
  o.setAttribute("aria-hidden", "false");
  log(`walked ${walkFrames.length} viewpoints`, "ok");
};

document.getElementById("btnWalkClose").onclick = closeWalk;

document.getElementById("btnWalkAsk").onclick = async () => {
  if (!walkFrames.length) return;
  const btn = document.getElementById("btnWalkAsk");
  btn.disabled = true; btn.textContent = "asking…";
  try {
    const r = await fetch("/api/walkthrough", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ frames: walkFrames,
        backend: document.getElementById("nameBackend").value,
        notes: currentVariant ? `Saved design "${currentVariant}".` : "" }),
    }).then(x => x.json());
    const box = document.createElement("div");
    box.id = "walkCritique";
    box.textContent = r.ok ? r.critique : `could not get a critique: ${r.error ?? "unknown error"}`;
    const grid = document.getElementById("walkGrid");
    grid.querySelector("#walkCritique")?.remove();
    grid.prepend(box);
    box.scrollIntoView({ block: "nearest" });
  } catch (e) {
    log("walkthrough critique failed: " + (e.message ?? e), "err");
  } finally {
    btn.disabled = false; btn.textContent = "Ask what's wrong";
  }
};

// debug handle for poking at scene state from the console
window.__yt = { scene, camera, controls, proposalGroup, markers, THREE, renderer,
  // GETTERS. `const fly` is declared later, so direct access here hits its
  // temporal dead zone and stops startup. A getter runs only on access after
  // module initialization.
  get fly() { return fly; }, walkthrough: async (n = 6) => {
  const design = await fetchJson("/data/design.json");
  const stations = planStations(design, n);
  return withCleanScene(scene, () => renderWalkthrough(
    { renderer, scene, camera, heightAt, enuToWorld, enuToWorldPoint }, stations));
} };

document.getElementById("captureSel").addEventListener("change", async ev => {
  const v = ev.target.value;
  if (v) { log(`loading ${v.split("/").pop()}…`); await loadStage(v); }
});

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
// ── ASSETS-START ──
//
// The asset window shows pictures and filters for native status, water needs
// and cat safety. A four-line dropdown of text rows cannot show a plant
// or support comparison.
//
// Cards render the MODEL using the same buildPlant() as the site. A stock photo
// could show the user something the design will not contain.
function assetWindowOpen() {
  return !document.getElementById("assetWindow").hidden;
}

/**
 * Ask for the photograph AND the size, because the size is what makes it worth
 * having — and the measurement must come from THE OWNER.
 *
 * Nothing here infers scale from the image. That would be a derived number
 * standing in for a measured one, which is the class of error `site_api` exists
 * to prevent, and it is the wrong number anyway: a plant's MATURE size is a fact
 * about the species, and what the user can measure is what it is NOW. Two fields, and
 * this one never writes the other.
 */
let ownerPhotoFor = null;
function openOwnerPhoto(entry) {
  ownerPhotoFor = entry;
  const f = document.getElementById("ownerPhoto");
  document.getElementById("opFor").textContent = entry.common ?? entry.species;
  document.getElementById("opMsg").textContent = "";
  f.hidden = false;
  f.scrollIntoView({ block: "nearest", behavior: "smooth" });
  document.getElementById("opFile").focus();
}

document.getElementById("opClose")?.addEventListener("click", () => {
  document.getElementById("ownerPhoto").hidden = true;
});

document.getElementById("ownerPhoto")?.addEventListener("submit", async ev => {
  ev.preventDefault();
  const msg = document.getElementById("opMsg");
  const file = document.getElementById("opFile").files?.[0];
  // as the tag or the tape gives it — 2 ft 7 in, 31 in, 0.8 m; a bare number is the project's unit
  const height = parseLen(document.getElementById("opHeight").value) ?? NaN;
  const spread = parseLen(document.getElementById("opSpread").value) ?? NaN;
  if (!file) { msg.textContent = "pick the photograph first"; return; }
  // State the tool's refusal HERE so the user sees it before uploading
  if (!Number.isFinite(height) && !Number.isFinite(spread)) {
    msg.textContent = "give me at least one measurement — a photo without a size "
                    + "is what the library already has";
    return;
  }
  msg.textContent = "saving…";
  try {
    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result); r.onerror = () => rej(r.error);
      r.readAsDataURL(file);
    });
    const r = await fetch("/api/owner-photo", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dataUrl, species: ownerPhotoFor?.species,
        common: ownerPhotoFor?.common,
        height_m: Number.isFinite(height) ? height : undefined,
        spread_m: Number.isFinite(spread) ? spread : undefined,
        where: document.getElementById("opWhere").value || undefined,
        replace: true,
      }),
    });
    const j = await r.json();
    if (j.error) { msg.textContent = j.detail || j.error; return; }
    msg.textContent = "";
    document.getElementById("ownerPhoto").hidden = true;
    document.getElementById("ownerPhoto").reset();
    await loadRefPhotos();
    renderAssetWindow();
    log(`your photo of ${ownerPhotoFor?.common ?? ownerPhotoFor?.species} is on record — `
      + "it now outranks the reference photo for this species", "ok");
  } catch (e) {
    msg.textContent = String(e?.message ?? e).slice(0, 140);
  }
});

// The reference-photo index lets a card say whether the owner photographed this
// plant. Loaded with the window rather than at boot: it is metadata
// that only this surface reads.
let refPhotoIndex = {};
async function loadRefPhotos() {
  try { refPhotoIndex = await (await fetch("/data/refphotos/index.json")).json(); }
  catch { refPhotoIndex = {}; }
}

async function showAssets(on) {
  if (on) await prepareSimplifier();          // the cards are drawn in Fast
  document.getElementById("assetWindow").hidden = !on;
  document.getElementById("btnAssets").classList.toggle("active", on);
  document.getElementById("ownerPhoto").hidden = true;
  syncRail();
  if (!on) return;
  renderAssetWindow();                       // draw immediately with what is loaded
  await Promise.all([loadRefPhotos(), loadOwned()]);   // their list may have grown in a design session
  renderAssetWindow();                       // ...then again, now the photos and their list are known
  // Cards use fast geometry; inspecting one plant opens its detailed model.
}

function assetFilters() {
  return {
    q: document.getElementById("assetSearch").value,
    form: document.getElementById("assetForm").value || null,
    maxWater: document.getElementById("assetWater").value || null,
    native: document.getElementById("assetNative").checked,
    catSafe: document.getElementById("assetCat").checked,
    mine: document.getElementById("assetMine").checked,
    mineSet: ownedSet(ownedDoc),
  };
}

// THE USER'S PLANTS: read with the site and merged onto the file on disk —
// the same lost-update rule as project.json, because a design session may add to it too.
let ownedDoc = { catalogue: [] };
async function loadOwned() {
  try { ownedDoc = await fetchJson("/" + OWNED_FILE); }
  catch { ownedDoc = { catalogue: [] }; }
  return ownedDoc;
}
async function setOwned(species, on, name = species) {
  let onDisk = {};
  try { onDisk = await fetchJson("/" + OWNED_FILE); }
  catch (e) { if (!/: 404$/.test(e.message)) { log(`your plant list is unreadable — not overwriting it`, "err"); return; } }
  const next = withOwned(onDisk, species, on);
  const r = await fetch("/api/save", { method: "POST", body: JSON.stringify({ file: OWNED_FILE, json: next }) });
  if (!r.ok) { log("could not save your plant list", "err"); return; }
  ownedDoc = next;
  log(on ? `${name} is on your list of plants you have` : `${name} is off your list`, "ok");
  renderAssetWindow();
}

function renderAssetWindow() {
  const grid = document.getElementById("assetGrid");
  const rows = paletteEntries(currentDesign, libraryMeta, MIN_ASSET_HEIGHT_M, plantCatalog,
                              { objectCatalog, resolveKind, objectLibrary: () => objectLibrary }, projectPolicy);
  const shown = assetFilter(rows, assetFilters());
  document.getElementById("assetCount").textContent =
    `${shown.length} of ${rows.length}`;
  grid.innerHTML = "";
  if (!shown.length) {
    const e = document.createElement("div");
    e.className = "group";
    e.textContent = "nothing matches those filters — the shortlist is 57 species, so try loosening one";
    grid.appendChild(e);
    return;
  }
  const picked = pickedEntry() ? paletteKey(pickedEntry()) : null;
  for (const g of paletteGroups(shown, { growthForm, normalizeForm })) {
    const head = document.createElement("div");
    head.className = "group";
    head.textContent = `${g.label} (${g.rows.length})`;
    grid.appendChild(head);
    for (const e of g.rows) grid.appendChild(assetCard(e, picked));
  }
}

function assetCard(e, picked) {
  const key = paletteKey(e);
  const card = document.createElement("div");
  card.className = "card" + (e.placeable ? "" : " unplaceable");
  card.setAttribute("aria-pressed", String(key === picked));
  card.title = e.note || e.label;

  // placeable: the picture now, or a blank that fills in when it is drawn
  if (e.placeable) {
    const img = document.createElement("img");
    img.alt = e.common ?? e.species;
    const url = entryThumb(e, u => {
      if (u) { img.src = u; img.classList.remove("pending"); }
      else { img.replaceWith(Object.assign(document.createElement("div"), { className: "noimg", textContent: "no preview" })); }
    });
    // pending: a transparent pixel, not no src — Chrome draws a broken-picture icon for that
    if (url) img.src = url;
    else { img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"; img.classList.add("pending"); }
    card.appendChild(img);
  } else {
    // an honest blank, saying why, rather than a mystery grey square
    const ph = document.createElement("div");
    ph.className = "noimg";
    ph.textContent = e.excluded ? "Excluded: toxic to cats" : "no mature size recorded";
    card.appendChild(ph);
  }
  const name = document.createElement("b");
  name.textContent = e.common ?? e.species;
  card.appendChild(name);
  // the botanical name, under a plant's common one — never a library model's file path
  if (!e.model && (e.common ?? e.species) !== e.species) {
    const sci = document.createElement("div");
    sci.className = "sci";
    sci.textContent = e.species;
    card.appendChild(sci);
  }
  const facts = document.createElement("div");
  facts.className = "facts";
  facts.textContent = assetFacts(e).join(" · ");
  card.appendChild(facts);
  // ☆ MINE: the user's plants, kept with the site — a toggle, never a pick
  if (e.source !== "object") {
    const have = ownedSet(ownedDoc).has(e.species);
    const mine = document.createElement("button");
    mine.type = "button";
    mine.className = "mine" + (have ? " on" : "");
    mine.textContent = have ? "★ mine" : "☆ mine";
    mine.title = have ? "you have this plant — click to take it off your list"
                      : "mark it as a plant you have — the list is kept with this site";
    mine.onclick = ev => { ev.stopPropagation(); setOwned(e.species, !have, e.common ?? e.species); };
    card.appendChild(mine);
  }
  // YOUR PHOTOGRAPH OF THIS PLANT, if there is one — and a way to add it if not.
  // ASSET_FIDELITY requires modelling from photographs rather than memory.
  // A photo of the owner's actual plant provides a direct species reference.
  if (e.source !== "object") {
    const own = photoFor(refPhotoIndex, e.species);
    const line = document.createElement("div");
    line.className = "owner-photo";
    if (isOwner(own)) {
      const p = provenanceOf(own);
      line.classList.add("has");
      line.textContent = `◆ ${p.label}`;
      line.title = p.detail || "your own photograph of this plant";
    } else {
      const b = document.createElement("button");
      b.type = "button"; b.className = "op-add";
      b.textContent = "Add your photo…";
      b.title = "a photo of YOUR plant, with the size you measured — better data "
              + "than any reference photograph, because it cannot be the wrong species";
      b.onclick = ev => { ev.stopPropagation(); openOwnerPhoto(e); };
      line.appendChild(b);
    }
    card.appendChild(line);
  }
  if (e.placeable && e.source !== 'object' && plantCatalog.some(p => p.species === e.species)) {
    const inspect = document.createElement('a');
    inspect.textContent = 'Inspect full detail';
    inspect.href = '/compare.html?plant=' + encodeURIComponent(e.species);
    inspect.target = '_blank'; inspect.rel = 'noopener';
    inspect.onclick = event => event.stopPropagation();
    card.appendChild(inspect);
  }

  if (e.placeable) {
    card.onclick = () => {
      // The <select> stays the ONE thing that holds what gets planted; this
      // window drives it rather than growing a second opinion about selection,
      // and pickedEntry() stays the only place that reads it back.
      pickEntry(key);
      // Choose the asset and arm placement immediately. Close the window so
      // the user can put the chosen thing on the ground.
      showAssets(false);
      setMode("place");
      log(`placing ${e.common ?? e.species} — click the ground`);
    };
  }
  return card;
}

// the habit list comes from FORM_LABELS, the same table that heads the groups —
// a second hand-typed list here would drift the first time a form is added
for (const [form, label] of FORM_LABELS) {
  if (!form) continue;
  const o = document.createElement("option");
  o.value = form;
  o.textContent = label;
  document.getElementById("assetForm").appendChild(o);
}

document.getElementById("btnAssets").onclick = () => showAssets(!assetWindowOpen());
document.getElementById("btnAssetsClose").onclick = () => showAssets(false);
for (const id of ["assetSearch", "assetForm", "assetWater", "assetNative", "assetCat", "assetMine"]) {
  const el = document.getElementById(id);
  el.addEventListener(id === "assetSearch" ? "input" : "change", renderAssetWindow);
}
// ── ASSETS-END ──

// ── MEASURE-START ──
//
// Measure on real ground: on a steep slope, the distance walked differs
// from the plan distance used for paving. measure.js computes and names both;
// this code picks and draws them.
const meas = { pts: [], group: null };
let measDownAt = null;

function clearMeasure() {
  meas.pts = [];
  if (meas.group) { enuGroup.remove(meas.group); disposeObj(meas.group, "mesh"); meas.group = null; }
  // The readout belongs to the HUD; #measureOut is absent. setMode calls this
  // before recording the new mode, so writing to that missing element would
  // throw and prevent every exit from Measure, including Esc.
  const out = document.getElementById("measureOut");
  if (out) { out.hidden = true; out.textContent = ""; }
  measureHud?.hide();
}

let measureHud = null;
let hudShortcuts = null;
let sidePanel = null;

function drawMeasure() {
  if (meas.group) { enuGroup.remove(meas.group); disposeObj(meas.group, "mesh"); meas.group = null; }
  // Put the answer where the user is looking, beside the ground points.
  // A number inside a collapsed panel is not visible feedback for the lines
  // being drawn in the scene.
  showMeasureHud();
  if (meas.pts.length < 1) return;
  const g = new THREE.Group();
  g.name = "measure";
  // the run itself, lifted a little so it reads against the ground it describes
  if (meas.pts.length >= 2) {
    const path = [];
    for (let i = 0; i < meas.pts.length - 1; i++) {
      const [ax, ay] = meas.pts[i], [bx, by] = meas.pts[i + 1];
      const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / 0.4));
      for (let k = 0; k <= n; k++) {
        const t = k / n, x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
        path.push(enuToWorld(x, y, (groundAtEnu(x, y) || 0) + 0.06));
      }
    }
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(path),
                         new THREE.LineBasicMaterial({ color: 0x7fc69a })));
  }
  for (const [x, y] of meas.pts) {
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8),
                               new THREE.MeshBasicMaterial({ color: 0x7fc69a }));
    const w = enuToWorld(x, y, (groundAtEnu(x, y) || 0) + 0.06);
    dot.position.copy(w);
    g.add(dot);
  }
  enuGroup.add(g);
  meas.group = g;
}

/**
 * The measurement, as a HUD beside the last point clicked.
 *
 * Labelled rows rather than one run-on sentence, because the two lengths are the
 * whole point of this tool on a slope: metres ACROSS is what paving and
 * turf are sold by, metres ALONG THE GROUND is what you walk and what edging and
 * hose are bought by. A sentence makes you parse which number is which.
 */
function showMeasureHud() {
  if (!measureHud) return;
  const r = measureRun(meas.pts, groundAtEnu);
  if (!meas.pts.length) {
    measureHud.show(["Click a point on the ground to start",
                     "Esc stops measuring"]);
    return;
  }
  const rows = [];
  if (r.points < 2) rows.push("Click another point");
  else {
    rows.push(["across", fmtLen(r.plan_m)]);
    if (Math.abs(r.slope_m - r.plan_m) >= 0.05)
      rows.push(["along the ground", fmtLen(r.slope_m)]);
    if (r.fall_m >= 0.05) rows.push(["fall", `${fmtLen(r.fall_m)} · ${Math.round(r.grade_pct)}%`]);
    if (r.area_m2 != null) rows.push(["area in plan", fmtArea(r.area_m2)]);
    if (r.unmeasured_m >= 0.5) rows.push(["off the scan", fmtLen(r.unmeasured_m)]);
  }
  rows.push(`${r.points} point${r.points === 1 ? "" : "s"} · ⌫ undoes one · Esc stops`);
  // anchored to the LAST point, which is where the cursor just was
  const last = meas.pts[meas.pts.length - 1];
  const w = enuToWorld(last[0], last[1], (groundAtEnu(last[0], last[1]) || 0) + 0.06);
  const v = new THREE.Vector3(w.x, w.y, w.z).project(camera);
  const box = renderer.domElement.getBoundingClientRect();
  measureHud.show(rows, v.z > 1 ? null
    : { x: box.left + (v.x * 0.5 + 0.5) * box.width,
        y: box.top + (-v.y * 0.5 + 0.5) * box.height });
}

/** Ground height in the ENU frame — heightAt is a WORLD function. */
function groundAtEnu(x, y) {
  const w = enuToWorld(x, y, 0);
  const h = heightAt(w.x, w.z);
  return Number.isFinite(h) ? h : NaN;
}

document.getElementById("btnMeasure").onclick = () => {
  const btn = document.getElementById("btnMeasure");
  if (mode === "measure") {
    setMode("orbit");                      // setMode clears the overlay and the lamp
    log("measuring off");
    return;
  }
  if (!stage) { log("load a capture first — measuring needs real ground", "warn"); return; }
  setMode("measure");
  clearMeasure();
  drawMeasure();
  log("click points on the ground; ⌫ takes the last one back, Esc stops");
};
// ── MEASURE-END ──

// ── RAIL-START ──
//
// The dock is built from the extension registry, so contributed tools appear
// beside built-ins without another line of markup. Each action has one handler.
//
// syncRail lights the dock and is called by setFly and every mode handler.
// It is defined before the dock mounts because the shell mounts last, so it
// must guard against that unmounted state.
let dockRef = null;
const bindDock = d => { dockRef = d; };

/** Light the tool that is live, so the mode is never invisible. */
function syncRail() { dockRef?.sync(); }

// BACK TO THE DEFAULT STATE: select and look (mode "orbit", not walking).
// The dock's Select tool and Esc share this ONE exit. Each tool leaves through
// its own cleanup so a half-drawn loop, measurement line or placement ghost
// cannot survive into the next mode.
function leaveTool() {
  const moving = mode === "landmark" ? relocating : null;
  if (fly.on) setFly(false);
  if (assetWindowOpen()) showAssets(false);          // Add lights while its library is open
  // a tool with a button says so itself ("measuring off"); the rest are told here — once
  if (mode === "measure") document.getElementById("btnMeasure")?.click();
  else if (mode === "pick") document.getElementById("btnLassoSelect")?.click();
  else if (mode === "area") document.getElementById("btnDrawArea")?.click();
  else if (mode !== "orbit") {                        // place, landmark, north, span, align
    setMode("orbit");
    log(moving ? `"${moving}" stays where it was` : "back to selecting", "ok");
  }
  syncRail();
}

// ── RAIL-END ──

// ── FLY-START ──
//
// A free camera, because OrbitControls always looks AT a point and the one thing
// you do on site — stop where you are and turn your head — is the one thing it
// cannot express. The maths is in flycam.js and tested; this is the wiring: the
// pointer lock, the held keys, and the per-frame integration.
const fly = { on: false, view: { yaw: 0, pitch: 0 }, keys: new Set(), last: 0 };
const flyGroundBox = () => document.getElementById("flyGround");

function setFly(on) {
  if (on === fly.on) return;
  fly.on = on;
  const btn = document.getElementById("btnFly");
  btn.classList.toggle("active", on);
  btn.textContent = on ? "Stop walking (Esc)" : "Walk the garden";
  syncRail();
  controls.enabled = !on;
  fly.keys.clear();
  if (on) {
    // start from wherever the orbit camera was pointing, so the view does not jump
    fly.view = flycam.viewFrom(camera.position, controls.target);
    fly.last = 0;
    // May be refused, and in some embeddings it rejects ASYNCHRONOUSLY —
    // "WrongDocumentError: The root document of this element is not valid for
    // pointer lock" — which a try/catch does not see. Walking works either way;
    // without the lock you turn by dragging.
    try {
      const p = renderer.domElement.requestPointerLock?.();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch { /* enhancement only */ }
    log("walking — W A S D to move, mouse (or drag) to look, Space/C up and down, "
        + "Shift to hurry, Esc to stop");
  } else {
    if (document.pointerLockElement === renderer.domElement) document.exitPointerLock?.();
    // hand the target back in FRONT of the camera: a stale one makes the view
    // swing across the garden the instant you drag
    const t = flycam.orbitTarget(camera.position, fly.view, 8);
    controls.target.set(t.x, t.y, t.z);
    controls.update();
  }
}

document.getElementById("btnFly").onclick = () => setFly(!fly.on);
// Walking does NOT depend on the pointer lock.
//
// Browsers can refuse lock without user activation, under embedding restrictions
// or when requests arrive too quickly. A pointerlockchange without a locked
// canvas must not call setFly(false), or a refused enhancement disables walking.
//
// Pointer lock is an ENHANCEMENT for mouse-look. W A S D must work without it,
// and leaving is Escape or the button.
document.addEventListener("pointerlockchange", () => {
  if (fly.on && document.pointerLockElement === renderer.domElement) {
    log("mouse look on — Esc to stop walking");
  }
});
addEventListener("mousemove", (e) => {
  if (!fly.on) return;
  // locked: raw deltas. Unlocked: only while dragging, so moving the pointer
  // across the page does not swing the view.
  const locked = document.pointerLockElement === renderer.domElement;
  if (!locked && !(e.buttons & 1)) return;
  fly.view = flycam.look(fly.view, e.movementX, e.movementY);
});
addEventListener("keydown", (e) => {
  if (!fly.on) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "")) return;
  fly.keys.add(e.key.toLowerCase());
  if (" wasdc".includes(e.key.toLowerCase()) && e.key !== "") e.preventDefault();
});
addEventListener("keyup", (e) => fly.keys.delete(e.key.toLowerCase()));
addEventListener("blur", () => fly.keys.clear());   // alt-tab must not leave you walking

/** One frame of free-camera movement. Exported shape kept trivial for the loop. */
function stepFly(nowMs) {
  if (!fly.on) return;
  // seconds, clamped: a background tab returns with a multi-second dt and would
  // fling the camera across the county on the first frame back
  const dt = fly.last ? Math.min(0.1, (nowMs - fly.last) / 1000) : 0;
  fly.last = nowMs;
  const walking = !!flyGroundBox()?.checked;
  const p = flycam.step(camera.position, fly.keys, fly.view, dt,
                        { mode: walking ? "walk" : "fly" });
  camera.position.set(p.x, p.y, p.z);
  if (walking) {
    // eye level over the REAL ground, so what you see is what a person sees
    const g = heightAt(camera.position.x, camera.position.z);
    if (Number.isFinite(g)) camera.position.y = g + 1.65;
  }
  const t = flycam.orbitTarget(camera.position, fly.view, 10);
  camera.lookAt(t.x, t.y, t.z);
}
// ── FLY-END ──

let navLast = 0;
renderer.setAnimationLoop((now) => {
  const t = now ?? 0;
  stepNav(navLast ? Math.min(0.1, (t - navLast) / 1000) : 0);
  navLast = t;
  stepFly(t);
  if (!fly.on) controls.update();
  // the gizmo is sized in PIXELS, and an orbit control changes the camera
  // distance continuously — sizing it only when the selection changes would
  // leave it the wrong size for the rest of the session
  sizeGizmo();
  renderer.render(scene, camera);
  syncLabels();
});

// ── A READ-ONLY WINDOW ON THE RENDERER ────────────────────────────────────
//
// Report whether the sun changes the picture, shadows are enabled and the
// shadow map contains geometry. Read the renderer's actual state: drawImage
// cannot reliably measure a WebGL canvas without preserveDrawingBuffer, and
// requestAnimationFrame is throttled in a background tab.
//
// Keep observation read-only so measuring does not create another design write
// path. There is exactly one path for edits.
window.__pedon = {
  renderer: () => ({
    shadowMapEnabled: !!renderer.shadowMap?.enabled,
    shadowMapType: renderer.shadowMap?.type,
    pixelRatio: renderer.getPixelRatio(),
    contextLost: !!renderer.getContext?.()?.isContextLost?.(),
    // What the LAST FRAME drew. A hide is effective only if draw counts fall;
    // panel state and a node's .visible flag alone cannot show that.
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
  }),
  /** How much of the scene is actually in the shadow map. */
  shadows: () => {
    let meshes = 0, cast = 0, receive = 0;
    scene.traverse(o => { if (o.isMesh) { meshes++; if (o.castShadow) cast++; if (o.receiveShadow) receive++; } });
    const sun = scene.getObjectByName("sun");
    return { meshes, cast, receive, sunCastShadow: !!sun?.castShadow,
             shadowMapEnabled: !!renderer.shadowMap?.enabled };
  },
  /** Why is a file-backed object not the size it was told to be? */
  probeModel: (model, height_m) => {
    const g = buildAssetObject({ model, height_m });
    if (!g) return { loaded: false };
    const box = new THREE.Box3().setFromObject(g);
    return { loaded: true,
             size: box.getSize(new THREE.Vector3()).toArray().map(v => +v.toFixed(3)),
             min: box.min.toArray().map(v => +v.toFixed(3)) };
  },
  /**
   * WHAT THE GROUPING LOOKS LIKE IN THE SCENE, versus what the panel believes.
   *
   * Inspect the scene as well as panel state to distinguish a node that is not
   * hidden from one that is hidden but has no members. UI state alone cannot
   * establish whether the plants disappear.
   */
  groupNodes: () => ({
    designGroupChildren: designGroup?.children.length ?? null,
    hiddenByPanel: [...hiddenGroups()],
    nodes: (designGroup?.children ?? [])
      .filter(c => c.userData?.groupId !== undefined)
      .map(c => ({ groupId: c.userData.groupId, visible: c.visible,
                   members: c.children.length })),
    strays: (designGroup?.children ?? [])
      .filter(c => c.userData?.id !== undefined
                   && groupIndex(designGroups()).has(c.userData.id))
      .map(c => c.userData.id),
  }),
  /** One object in the design, as it was actually BUILT. */
  object: (id) => {
    let hit = null;
    designGroup?.traverse(o => { if (!hit && o.userData?.id === id) hit = o; });
    if (!hit) return null;
    let meshes = 0, tris = 0, glowing = 0;
    const parts = new Map();                     // what the triangles are, by part name
    hit.traverse(o => {
      if (!o.isMesh || !o.visible) return;          // a level not being drawn is not the plant
      meshes++;
      {
        const g = o.geometry, t = (g.index?.count ?? g.attributes.position.count) / 3 * (o.isInstancedMesh ? o.count : 1);
        const row = parts.get(o.name || "(unnamed)") ?? { meshes: 0, instances: 0, triangles: 0 };
        row.meshes++; row.instances += o.isInstancedMesh ? o.count : 1; row.triangles += Math.round(t);
        parts.set(o.name || "(unnamed)", row);
      }
      // selection or hover glow: shared materials can prevent copies lighting independently
      if ((Array.isArray(o.material) ? o.material : [o.material]).some(m => m?.userData?.__prevEmissive !== undefined)) glowing++;
      const g = o.geometry;
      tris += (g.index?.count ?? g.attributes.position.count) / 3 * (o.isInstancedMesh ? o.count : 1);
    });
    const box = new THREE.Box3().setFromObject(hit);
    return { id, meshes, glowing, triangles: Math.round(tris),
             parts: [...parts].sort((a, b) => b[1].triangles - a[1].triangles).slice(0, 8)
               .map(([name, r]) => ({ name, ...r })),
             size: box.getSize(new THREE.Vector3()).toArray().map(v => +v.toFixed(2)) };
  },
  /** What each thing the camera frames actually measures. */
  bounds: () => {
    const b = o => { if (!o) return null;
      const x = new THREE.Box3().setFromObject(o);
      return x.isEmpty() ? null : { min: x.min.toArray().map(v => +v.toFixed(1)),
                                    max: x.max.toArray().map(v => +v.toFixed(1)),
                                    size: x.getSize(new THREE.Vector3()).toArray().map(v => +v.toFixed(1)) }; };
    // THE TARGET IS NOT DECORATION. An orbit keeps its target fixed; a pan
    // carries it with the camera. Position alone cannot distinguish the two,
    // so report both when checking a camera gesture.
    const p3 = v => [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)];
    return { design: b(designGroup), scan: b(stage), scene: b(scene),
             camera: [+camera.position.x.toFixed(1), +camera.position.y.toFixed(1),
                      +camera.position.z.toFixed(1)],
             eye: p3(camera.position), target: p3(controls.target),
             leftButton: controls.mouseButtons.LEFT };
  },
  /** The shadow camera itself: is the garden even inside the box it sees? */
  shadowCamera: () => {
    const sun = scene.getObjectByName("sun");
    const cam = sun?.shadow?.camera;
    if (!cam) return null;
    const box = new THREE.Box3().setFromObject(designGroup ?? enuGroup);
    return {
      ortho: [cam.left, cam.right, cam.top, cam.bottom],
      near: cam.near, far: cam.far,
      mapSize: [sun.shadow.mapSize.x, sun.shadow.mapSize.y],
      mapAllocated: !!sun.shadow.map,
      bias: sun.shadow.bias, normalBias: sun.shadow.normalBias,
      target: [sun.target.position.x, sun.target.position.y, sun.target.position.z],
      designBoxWorld: [box.min.toArray().map(v => +v.toFixed(1)),
                       box.max.toArray().map(v => +v.toFixed(1))],
    };
  },
  /** What the sun is doing right now, from the light rather than from a label. */
  sun: () => {
    const sun = scene.getObjectByName("sun");
    return { ...(sunState ?? {}), when: sunWhen,
             position: sun ? [+sun.position.x.toFixed(2), +sun.position.y.toFixed(2),
                              +sun.position.z.toFixed(2)] : null,
             intensity: sun?.intensity };
  },
  /** What the place-mode preview is doing: built, where, and whether it is drawn. */
  placeGhost: () => {
    if (!placeGhost) return null;
    // what it is drawn FROM: a model file's name, or null for plant code
    let model = null, triangles = 0;
    placeGhost.traverse(o => {
      model ??= o.userData?.assetName ?? null;
      if (o.isMesh && o.visible) triangles += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3 * (o.isInstancedMesh ? o.count : 1);
    });
    return { visible: placeGhost.visible, meshes: placeGhost.children.length, model, triangles: Math.round(triangles),
             position: placeGhost.position.toArray().map(v => +v.toFixed(2)) };
  },
  /** The last hand edits and reloads, stage by stage, in ms from the start of the reload. */
  editTimings: () => editTimings.slice(),
  // per-species cost of the LAST build, dearest first — the half editTimings cannot see
  // `build`: 0 is the oldest kept (the page's first build), omitted = the latest
  plantTimings: build => (build === undefined ? [...plantBuildStats].map(([plant, r]) => ({ plant, ...r }))
      : plantBuildHistory[build]?.rows ?? [])
    .map(r => ({ plant: r.plant, n: r.n, ms: Math.round(r.ms), ms_each: Math.round(r.ms / r.n), tris: r.tris }))
    .sort((a, b) => b.ms - a.ms),
  /** What the design's meshes hold, counted once however many plants share it: the
   *  arrays a copy of a plant shares cost nothing twice, and this is what says whether they do. */
  designMemory: () => {
    const geos = new Set(), arrays = new Set(), mats = new Set(), texs = new Set();
    let geoBytes = 0, instBytes = 0;
    designGroup?.traverse(o => {
      if (o.isSprite) return;
      if (o.geometry && !geos.has(o.geometry)) {
        geos.add(o.geometry);
        for (const a of Object.values(o.geometry.attributes)) geoBytes += a.array.byteLength;
        if (o.geometry.index) geoBytes += o.geometry.index.array.byteLength;
      }
      for (const a of o.isInstancedMesh ? [o.instanceMatrix, o.instanceColor] : [])
        if (a && !arrays.has(a.array)) { arrays.add(a.array); instBytes += a.array.byteLength; }
      for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
        mats.add(m);
        for (const k in m) if (m[k]?.isTexture) texs.add(m[k].source ?? m[k]);
      }
    });
    return { geometries: geos.size, geometryMB: +(geoBytes / 1e6).toFixed(1),
             instanceArrays: arrays.size, instanceMB: +(instBytes / 1e6).toFixed(1),
             materials: mats.size, pictures: texs.size };
  },
  /** The coarser levels of small parts: `on` true/false turns them on or off (to compare);
   *  returns, for the plants that have them, how many layers each level is showing now. */
  levels: (on, tune) => {
    if (on !== undefined) levelsOn = !!on;
    if (tune) tuneLevels(tune);
    const shown = [0, 0, 0];
    for (const p of levelPlants) for (const l of plantLevels(p)) shown[l.level]++;
    return { on: levelsOn, plants: levelPlants.length, layersAtLevel: shown };
  },
  /** What the kept Fast plants did this session: read back, stored, refused and why. */
  plantStore: () => storeStats(),
  /** Forget the kept Fast plants, in memory and in this browser — the next load generates them. */
  forgetPlantStore: () => forgetModels(),
  /** Rebuild the design exactly as an edit does, without writing anything. */
  reloadDesign: () => loadDesign(true),
  /** Where the gizmo's centre handle is on screen, in CSS pixels, or null when
   *  nothing is selected. Checks must DRAG it as a hand does: directly calling
   *  a move function would skip the gesture that must preserve grouping. */
  gizmo: () => {
    if (!gizmoGroup) return null;
    const r = renderer.domElement.getBoundingClientRect();
    const screen = w => { const p = w.clone().project(camera);
      return { x: Math.round(r.left + (p.x + 1) / 2 * r.width), y: Math.round(r.top + (1 - p.y) / 2 * r.height) }; };
    const hub = gizmoGroup.getWorldPosition(new THREE.Vector3());
    // a point ON each arrow's shaft (0.19-0.91 of the radius), from the gizmo's own frame,
    // so a check can grab the arrow itself, not the hub, when typing a distance
    const f = gizmoState ? gizmoFrame(gizmoState.center[0], gizmoState.center[1], gizmoState.h) : null;
    const along = v => hub.clone().addScaledVector(new THREE.Vector3(...v), (gizmoState?.radius ?? 1) * 0.7);
    return { ...screen(hub), ...(f ? { east: screen(along(f.east)), north: screen(along(f.north)) } : {}) };
  },
  /** One frame's real cost, timed around an explicit render. */
  // `gpu`: wait for each frame to be DRAWN (a one-pixel read), not only handed to the GPU — the
  // plain number is the CPU's share, and a frame the GPU takes 30 ms over reads 5 ms here
  frameMs: (n = 20, gpu = false) => {
    const gl = renderer.getContext(), px = new Uint8Array(4);
    if (gpu) { renderer.render(scene, camera); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      renderer.render(scene, camera);
      if (gpu) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    }
    return +((performance.now() - t0) / n).toFixed(2);
  },
  /** WHERE A DRAWN FRAME GOES: the whole frame, then without the shadow pass, without
   *  the plants, and at half the pixels (fill-bound if it falls with them) — each waited for. */
  frameBreakdown: (n = 10, byKind = false) => {
    const ms = () => window.__pedon.frameMs(n, true);
    const out = { all: ms() };
    const auto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    out.noShadowPass = ms();
    renderer.shadowMap.autoUpdate = auto;
    const plants = [];
    designGroup?.traverse(o => { if (o.userData?.plantLabel && o.parent) plants.push(o.parent); });
    const shown = plants.map(p => p.visible);
    plants.forEach(p => { p.visible = false; });
    out.noPlants = ms();
    plants.forEach((p, i) => { p.visible = shown[i]; });
    const ratio = renderer.getPixelRatio();
    renderer.setPixelRatio(ratio / 2);
    out.halfPixels = ms();
    renderer.setPixelRatio(ratio);
    // `byKind`: what each kind of plant costs the frame — the frame without it, subtracted
    if (byKind) {
      const kinds = new Map();
      designGroup?.traverse(o => { if (o.userData?.plantLabel && o.parent) {
        const k = o.userData.label ?? "?"; (kinds.get(k) ?? kinds.set(k, []).get(k)).push(o.parent); } });
      out.kinds = [...kinds].map(([k, ps]) => {
        const was = ps.map(p => p.visible);
        ps.forEach(p => { p.visible = false; });
        const without = ms();
        ps.forEach((p, i) => { p.visible = was[i]; });
        return [k, ps.length, +(out.all - without).toFixed(1)];
      }).sort((a, b) => b[2] - a[2]);
    }
    return out;
  },
};

// ── PEDON SHELL ───────────────────────────────────────────────────────────
//
// Canvas-first: the site fills the window and the shell FLOATS over it, with a
// thin top bar, bottom dock and ⌘K for the full command list.
//
// Mount LAST so every command can delegate to a handler defined earlier.
// Walking, measuring and saving each have one implementation shared by every
// surface that offers them.
const commands = createCommands();
const click = id => () => document.getElementById(id)?.click();

for (const c of [
  { id: "view.walk",    title: "Walk the garden",  group: "View", keys: "w",
    hint: "W A S D, mouse to look", run: () => setFly(!fly.on) },
  { id: "view.frameAll", title: "See the whole site", group: "View", keys: "f",
    run: click("btnFrameAll") },
  { id: "view.top",     title: "Top view",         group: "View", run: click("btnTopView") },
  { id: "view.iso",     title: "Isometric view",   group: "View", run: () => setView("iso") },
  { id: "view.front",   title: "Front view",       group: "View", run: () => setView("front") },
  { id: "view.side",    title: "Side view",        group: "View", run: () => setView("side") },
  { id: "view.shots",   title: "Photograph the garden", group: "View",
    hint: "eight photos at head height along the design's own paths — they appear in Views",
    run: click("btnWalk") },
  { id: "tool.select",  title: "Select",           group: "Tools",
    hint: "the default: click things to select them, drag to look around — and the way back from any tool (Esc)",
    run: () => leaveTool() },
  { id: "tool.measure", title: "Measure",          group: "Tools",
    hint: "across and along the ground", run: click("btnMeasure") },
  { id: "tool.pick",    title: "Select a section", group: "Tools",
    hint: "drag a loop round part of the site; shift adds. Then \u21e7S to focus on it",
    run: click("btnLassoSelect") },
  { id: "tool.area",    title: "Draw an area",     group: "Tools",
    hint: "name a region, then drag across the ground", run: click("btnDrawArea") },
  { id: "tool.assets",  title: "Add a plant or object", group: "Tools",
    hint: "browse the library and pick what a click puts down",
    run: click("btnAssets") },
  { id: "edit.undo",    title: "Undo",   group: "Edit", keys: "mod z", run: click("btnUndo") },
  { id: "edit.redo",    title: "Redo",   group: "Edit", keys: "mod shift z", run: click("btnRedo") },
  { id: "edit.delete",  title: "Delete selection", group: "Edit",
    when: () => selection.size > 0, run: click("btnSelDelete") },
  { id: "edit.copy",    title: "Copy selection", group: "Edit", keys: "mod c",
    hint: "carries across designs — paste it into another one",
    when: () => selection.size > 0, run: () => copySelection() },
  { id: "edit.paste",   title: "Paste", group: "Edit", keys: "mod v",
    hint: "what you last copied, into the design you are in now",
    when: () => !!readClipboard()?.items?.length, run: () => pasteClipboard() },
  { id: "edit.duplicate", title: "Duplicate selection", group: "Edit",
    when: () => selection.size > 0, run: click("btnSelDuplicate") },
  { id: "edit.group",   title: "Group selection", group: "Edit", keys: "mod g",
    when: () => selection.size > 1,
    hint: "a group folds, hides and locks as one", run: () => groupSelection() },
  { id: "edit.alternative", title: "Make selection a proposal…", group: "Edit",
    when: () => selection.size > 1,
    hint: "two ideas for one corner; only the one you pick is drawn or measured",
    run: () => proposeSelection() },
  { id: "edit.solo",    title: "Solo — show only this", group: "Edit", keys: "shift s",
    hint: "hide everything else; press again to come back",
    when: () => selection.size > 0 || !!soloMemory, run: () => toggleSolo() },
  { id: "edit.showAll", title: "Show everything", group: "Edit",
    hint: "clear every hidden object",
    run: () => { soloMemory = null; objectView = {}; persistObjectView();
                 applyObjectVisibility(designGroup, hiddenObjectIds());
                 renderObjectList(); log("everything is visible again", "ok"); } },
  { id: "edit.clear",   title: "Clear selection", group: "Edit",
    when: () => selection.size > 0, run: () => setSelection([]) },
  // Give each existing control a command name and a visible way to reach it.
  // OWNER-PLACED VIEWPOINTS let the user and model view places the owner
  // considers important. Save them as ground truth in site.json using look's
  // convention, so a headless session passes the stored values to that tool.
  { id: "view.saveViewpoint", title: "Save this view as…", group: "View",
    hint: "name it, and any later session can look from here",
    run: () => saveViewpointHere() },
  { id: "view.shot", title: "Save a screenshot", group: "View",
    hint: "the current frame, as a file", run: click("btnShot") },
  { id: "site.detect", title: "Find walls and structures", group: "App",
    hint: "find walls and steps in the scan — one-time setup", run: click("btnDetect") },
  { id: "design.save",   title: "Save", group: "Design", keys: "mod s",
    hint: "over the saved design you are editing, or as a new one if it has no name",
    run: () => saveDesign() },
  { id: "design.saveAs", title: "Save this design as…", group: "Design", keys: "mod shift s",
    run: click("btnDesignSaveAs") },
  { id: "design.new",   title: "New design",       group: "Design", run: click("btnDesignNew") },
  { id: "design.ask",   title: "Ask what's wrong", group: "Design",
    hint: "ask the model what is wrong with these photographs", run: click("btnWalkAsk") },
  { id: "app.settings", title: "Project settings", group: "App",
    hint: "capture, north, scale — one-time", run: click("btnSettings") },
  { id: "design.plan", title: "Planting drawings to print", group: "Design",
    hint: "planting plan, plant schedule and setting-out sheet for the beds you have selected",
    run: () => openPlantingPlan() },
  { id: "view.ar", title: "See it on site — on your phone", group: "View",
    hint: "true size, through the phone's camera, lined up on your own landmarks",
    run: () => arSheet?.show() },
  { id: "app.objects",  title: "Objects in this design", group: "App", keys: "o",
    hint: "everything placed, with an eye to hide each one",
    run: () => openPanelAt("objects") },
  { id: "app.places",   title: "Places — landmarks and areas", group: "App",
    run: () => openPanelAt("places") },
  { id: "app.views",    title: "Views — saved cameras and shots", group: "App",
    hint: "browse what you saved and what you rendered",
    run: () => openPanelAt("views") },
  { id: "app.versions", title: "Designs and versions", group: "App",
    hint: "switch, save as, compare", run: () => openPanelAt("design") },
  { id: "app.view",     title: "Display settings", group: "App", keys: "v",
    hint: "sun, plant maturity, detail, what is drawn", run: () => openPanelAt("view") },
  { id: "app.keys",     title: "Keyboard and mouse", group: "App", keys: "?",
    hint: "every shortcut, and what the mouse does", run: () => showShortcuts() },
  { id: "app.log",      title: "Show recent messages", group: "App",
    hint: "everything the viewer has said this session",
    run: () => {
      const rows = toasts.history();
      if (!rows.length) { log("nothing logged yet"); return; }
      // the full history goes to the devtools console, which is where a long
      // scrollback belongs; the last few come back as a toast so the command
      // visibly did something
      console.log(formatHistory(rows, 500));
      const last = rows.slice(-3).map(r => r.msg).join(" · ");
      log(`${rows.length} messages this session — full list in the browser console. Last: ${last}`);
    } },
]) commands.add(c);

// EXTENSIONS CONTRIBUTE HERE TOO, and land in the same list — an extension's
// feature has to be as reachable as a built-in one or this is a plugin menu
// rather than a plugin system.
for (const c of extensions.get("commands")) {
  const ctx = c._ctx;
  commands.add({ ...c, run: () => c.run?.(ctx) });
}

// Every surface needs a reachable home in the shell. Lists ADOPT existing
// elements rather than redraw them, preserving renderObjectList's fold, hide,
// lock, rename and hover-highlight behaviours. Return nodes to #shellStore
// on close; the store owns their state even though it is not rendered.
// SURFACES lives in shell/surfaces.js so its vocabulary has one owner.

function openPanelAt(which) {
  if (!SURFACES[which]) { log(`no "${which}" surface`, "warn"); return; }
  sidePanel.toggle(which);
}

/**
 * What the mouse and keyboard do. Named as a surface rather than a tooltip
 * because the user needs a discoverable list of available tools and gestures,
 * not only tooltips for controls they already know to hover over.
 */
function showShortcuts() {
  const rows = [
    ["drag", "orbit — on empty ground"],
    ["⌘-drag", "orbit from ANYWHERE, over anything"],
    ["right-drag", "look around"],
    ["W A S D", "move the camera, any time"],
    ["Space / C", "up and down"],
    ["wheel while looking", "fly speed"],
    ["right-click", "menu for whatever is under the cursor"],
    ["click", "select · shift-click adds · shift picks a range in the list"],
    ["F", "see the whole site"],
    ["[  ]", "previous / next saved view"],
    ["O", "objects in this design"],
    ["V", "display settings — sun, maturity, layers"],
    ["⇧S", "solo — show only what is selected"],
    ["⌘G", "group the selection"],
    ["Esc", "leave the current tool"],
    ["⌫", "undo a measured point"],
  ];
  const body = rows.map(([k, v]) => `${k.padEnd(22)} ${v}`).join("\n");
  console.log("PEDON — keyboard and mouse\n" + body);
  hudShortcuts.show([...rows, "press ? again or Esc to dismiss"]);
}

// SOLO — show only what is selected, hide the rest.
//
// It is the fastest way to work on one bed in a design of hundreds of objects, and it is
// VIEW state — the pre-solo hidden set is remembered so leaving restores exactly
// what was hidden before, rather than revealing everything. Visibility must
// never become a design field.
function toggleSolo() {
  if (soloMemory) {
    objectView = soloMemory;
    soloMemory = null;
    persistObjectView();
    applyObjectVisibility(designGroup, hiddenObjectIds());
    renderObjectList();
    log("solo off — what was hidden before is hidden again", "ok");
    return;
  }
  if (!selection.size) { log("select something to solo first", "warn"); return; }
  soloMemory = JSON.parse(JSON.stringify(objectView));
  const keep = new Set(selection);
  // everything in the same GROUP as a selected object stays too: soloing one
  // stone out of a triad and losing the other two is never what you meant
  for (const g of designGroups())
    if (g.members?.some(id => keep.has(id))) for (const id of g.members) keep.add(id);
  const next = {};
  for (const o of designObjects())
    if (!keep.has(o.id)) next[o.id] = { hidden: true, what: whatIs(rawById(currentDesign, o.id)) };
  objectView = next;
  persistObjectView();
  applyObjectVisibility(designGroup, hiddenObjectIds());
  renderObjectList();
  log(`solo: ${keep.size} object(s) shown — press ⇧S again to come back`, "ok");
}

// The classic panel has no heading, sections, toggle, app.panel entry,
// command, menu item or stylesheet. #shellStore is never rendered but retains
// the elements that hold state; index.html explains why they must stay.
//
// Remove its stored preference rather than ignore it so a stale setting
// cannot reopen an obsolete column alongside the shell.
try {
  localStorage.removeItem("pedon.panel.v2");
  localStorage.removeItem("pedon.panel");
} catch { /* private mode */ }

// TOOLTIPS THAT APPEAR. A `title` is a request for one, not a tooltip: the
// browser waits over a second, draws OS chrome, and gives up if the pointer
// moved on the way in, leaving icon-only buttons with no visible help.
// See shell/tooltip.js.
mountTooltips();

const cmdPalette = mountPalette(commands);
const inspector = mountInspector({
  onDismiss: () => setSelection([]),
  // MEASURED, not assumed: the rail is always there and the panel may or may not
  // be open, so its width is read when the card is placed rather than hardcoded.
  occludedLeft: () =>
    document.getElementById("pSideWrap")?.getBoundingClientRect().width ?? 0,
});
// `var`-like hoisting is not available for const, and drawMeasure can run before
// the shell mounts, so showMeasureHud guards on this being set rather than
// assuming it. Same reasoning as the inspector guard in renderProperties.
measureHud = mountHud("pMeasureHud");
hudShortcuts = mountHud("pShortcuts", { className: "hud-sheet" });
arSheet = mountArSheet({ notify: (m, c) => log(m, c), source: () => designSource(),
                        // the name in the top bar, so the phone says which design it is
                        name: () => shownDesignName() });
sidePanel = mountSidePanel({ surfaces: SURFACES,
                            onAction: id => commands.run(id) });
// restored AFTER the lists have something to draw: reopening Objects onto an
// empty tree would look like the panel is broken rather than the design empty
sidePanel.restore();
toasts = mountToasts();
for (const [m, c] of preToast) toasts.push(m, c);
preToast.length = 0;
const topBar = mountTopBar({
  onSite: () => showSettings(true),
  onPalette: () => cmdPalette.toggle(),
  onDesignMenu: () => openPanelAt("design"),
  // THE PROJECT MENU exposes calibration and project settings. These are
  // once-per-property tasks, so they belong in a menu rather than beside the
  // daily rail surfaces.
  // ctxMenu is declared later in the navigation block. This closure runs on a
  // click after module evaluation, when that reference is initialized.
  onOverflow: ev => {
    // Read real calibration state: siteCache.registration is not a site.json
    // key and would label every property uncalibrated.
    const uncal = calibrationWarning(currentSetup());
    ctxMenu.open([
      { id: "app.settings", title: "Project settings…",
        hint: uncal ? uncal.short : "set up" },
      { id: "view.ar", title: "See it on site…", hint: "on your phone, true size" },
      { id: "design.plan", title: "Planting drawings to print…", hint: "plan · schedule · setting out" },
      { id: "site.detect", title: "Find walls and structures…",
        hint: "once per property" },
      { id: "edit.paste", title: "Paste", hint: "⌘V — what you copied, into this design" },
      { id: "view.shot", title: "Save a screenshot",
        hint: "the frame you are looking at" },
      { id: "app.keys", title: "Keyboard and mouse", hint: "?" },
      "-",
      { id: "app.log", title: "Recent messages" },
    ], { x: ev.clientX - 180, y: 46 });
  },
  onCamera: ev => {
    const r = ev.currentTarget.getBoundingClientRect();
    // Whole-site framing comes FIRST as the frequent camera action. Keep it
    // in this menu so two similar camera buttons cannot suggest different jobs.
    ctxMenu.open([
      { id: "view.frameAll", title: "See the whole site", hint: "F" }, "-",
      { id: "view.top", title: "Top" }, { id: "view.front", title: "Front" },
      { id: "view.side", title: "Side" }, { id: "view.iso", title: "Isometric" },
    ], { x: r.left - 60, y: r.bottom + 6 });
  },
  onUndo: () => document.getElementById("btnUndo")?.click(),
  onRedo: () => document.getElementById("btnRedo")?.click(),
});
const dock = mountDock(DOCK_TOOLS, {
  onPick: t => commands.run(t.id),
  onMenu: (t, at) => ctxMenu.open(t.id === "view.pick" ? viewPickItems() : t.menu, at),
  // the default state has a lamp too: Select is lit whenever no tool is
  activeId: () => (fly.on ? "view.walk" : mode === "measure" ? "tool.measure"
                   : mode === "area" ? "tool.area" : mode === "place" ? "tool.assets"
                   : mode === "pick" ? "tool.pick"
                   // Add's library is a window, not a mode — but you pressed Add, so Add is lit
                   : assetWindowOpen() ? "tool.assets" : mode === "orbit" ? "tool.select" : null),
});

bindDock(dock);

// ── NAVIGATION WITHOUT A MODE ─────────────────────────────────────────────
//
// The user can move the camera freely while viewing, without entering a mode:
//
//
//   DRAG on empty ground  orbit
//   CMD-DRAG              orbit from ANYWHERE, over anything
//   RIGHT-DRAG            look around
//   WASD while right-held fly, at the speed the wheel sets
//   RIGHT-CLICK (no drag) the context menu
//
// The explicit Walk mode stays, because sustained walking at eye height over the
// real scan is a different job from nudging the camera, and "stay on the ground"
// belongs to it.
// Captured when the menu OPENS and read when an item is clicked, so both must be
// declared before the handler that closes over them.
let lastRightEvent = null;
let lastRightGroup = null;

const ctxMenu = mountContextMenu({ onPick: it => {
  // Every branch delegates to the existing action so context menu, panel and
  // palette share one implementation.
  if (it.id === "place.here") {
    if (!lastRightEvent) return;
    placeHere(lastRightEvent);                  // the exact path a ground click takes
  } else if (it.id === "sel.frame") {
    frameSelection();
  } else if (it.id === "sel.hide") {
    // per-object visibility is VIEW state in localStorage, never a design field
    //, which is why this writes objectView rather than emitting an op
    for (const id of selection) setObjectView(id, { hidden: true });
    applyObjectVisibility(designGroup, hiddenObjectIds());
    renderObjectList();
    log(`${selection.size} object(s) hidden — the eye in the Objects list brings them back`);
  } else if (it.id.startsWith("group.")) {
    // the group is captured when the menu OPENS, not looked up when an item is
    // clicked: by then the selection may be several things and "the group of the
    // first one" is a different group from the one whose name is on the menu
    const g = lastRightGroup;
    if (!g) { log("that is not in a group", "warn"); return; }
    if (it.id === "group.select") { setSelection(g.members); }
    else if (it.id === "group.hide") {
      // applyLayers, NOT applyObjectVisibility: group hiding acts on its node;
      // per-object visibility is a separate pass. Share the group eye's call
      // so every entry point applies the same state.
      setGroupView(g.id, { hidden: true });
      applyLayers();
      renderObjectList();
      log(`“${g.name || g.id}” hidden — the eye on its row brings it back`, "ok");
    } else if (it.id === "group.solo") { setSelection(g.members); toggleSolo(); }
    else if (it.id === "group.ungroup") { ungroup(g.id); }
  } else if (it.id === "sel.substitute") {
    document.getElementById("btnSubstitute")?.click();
  } else if (it.id.startsWith("view.goto:")) {
    // the same call the Views list and [ ] make, so a view is reached one way
    const v = (siteCache?.viewpoints ?? []).find(x => x.name === it.id.slice("view.goto:".length));
    if (v) goToViewpoint(v);
  } else if (commands.get(it.id)) {
    commands.run(it.id);
  }
} });

const look = { down: null, held: false, notches: 0 };

renderer.domElement.addEventListener("contextmenu", ev => ev.preventDefault());
renderer.domElement.addEventListener("pointerdown", ev => {
  if (ev.button !== 2) return;
  look.down = { x: ev.clientX, y: ev.clientY };
  look.held = true;
  fly.view = flycam.viewFrom(camera.position, controls.target);
  controls.enabled = false;
  try { renderer.domElement.setPointerCapture(ev.pointerId); } catch { /* fine */ }
});
addEventListener("pointermove", ev => {
  if (!look.held) return;
  fly.view = flycam.look(fly.view, ev.movementX, ev.movementY);
  const t = flycam.orbitTarget(camera.position, fly.view, 10);
  camera.lookAt(t.x, t.y, t.z);
});
addEventListener("pointerup", ev => {
  if (ev.button !== 2 || !look.held) return;
  look.held = false;
  controls.enabled = !fly.on;
  const intent = rightUpIntent(look.down, { x: ev.clientX, y: ev.clientY });
  // hand the orbit target back in FRONT of the camera, or the view swings across
  // the garden the instant you drag again — the same fix setFly already makes
  const t = flycam.orbitTarget(camera.position, fly.view, 8);
  controls.target.set(t.x, t.y, t.z);
  controls.update();
  look.down = null;
  if (intent !== "menu") return;
  const id = pickDesignObject(ev);
  const found = id !== null ? rawById(currentDesign, id) : null;
  lastRightEvent = ev;
  if (found && !selection.has(id)) setSelection([id]);
  lastRightGroup = found ? designGroups().find(g => g.members?.includes(id)) ?? null : null;
  ctxMenu.open(contextItemsFor(found ? { kind: found.kind, id } : null,
                               { hasSelection: selection.size > 0,
                                 multi: selection.size > 1, group: lastRightGroup }),
               { x: ev.clientX, y: ev.clientY });
});

// the wheel sets fly speed while looking; otherwise it is the orbit zoom
renderer.domElement.addEventListener("wheel", ev => {
  if (!look.held) return;
  ev.preventDefault();
  look.notches += ev.deltaY < 0 ? 1 : -1;
  log(`fly speed ${speedFor(look.notches).toFixed(1)} m/s`);
}, { passive: false });

// WASD any time the pointer is not in a field. While right-held this flies;
// otherwise it pans the orbit camera, which is what "move the camera while just
// viewing" means for someone who has not entered a mode.
const navKeys = new Set();
addEventListener("keydown", ev => {
  if (fly.on) return;                                   // Walk mode owns them
  if (!movesCamera(ev, document.activeElement?.tagName)) return;
  navKeys.add(ev.key.toLowerCase());
  ev.preventDefault();
});
addEventListener("keyup", ev => navKeys.delete(ev.key.toLowerCase()));
addEventListener("blur", () => navKeys.clear());

function stepNav(dt) {
  if (fly.on || !navKeys.size) return;
  if (!look.held) fly.view = flycam.viewFrom(camera.position, controls.target);
  const before = camera.position.clone();
  const p = flycam.step(camera.position, navKeys, fly.view, dt,
                        { mode: "fly", speed: speedFor(look.notches) });
  camera.position.set(p.x, p.y, p.z);
  // the orbit target travels with the camera, so releasing the keys does not
  // snap the view back to whatever it was pointed at before
  controls.target.add(camera.position.clone().sub(before));
  controls.update();
}

// The card follows the object. renderProperties is what positions it, so this is
// simply "re-run that when the view changes" — cheap, and it cannot drift from
// the placement logic by being a second copy of it.
controls.addEventListener("change", () => { if (inspector.isOpen()) renderProperties(); });
addEventListener("resize", () => { if (inspector.isOpen()) renderProperties(); });

addEventListener("keydown", ev => {
  if (opensPalette(ev, document.activeElement?.tagName)) { ev.preventDefault(); cmdPalette.toggle(); }
  // ⌘S even from inside a field: the browser would otherwise offer to save the web page
  if ((ev.key === "c" || ev.key === "C") && (ev.metaKey || ev.ctrlKey) && !ev.altKey
      && !window.getSelection()?.toString()) {
    // only when no TEXT is selected: ⌘C must still copy words from the panel
    ev.preventDefault(); copySelection(); return;
  }
  if ((ev.key === "v" || ev.key === "V") && (ev.metaKey || ev.ctrlKey) && !ev.altKey) {
    ev.preventDefault(); pasteClipboard(); return;
  }
  if ((ev.key === "s" || ev.key === "S") && (ev.metaKey || ev.ctrlKey) && !ev.altKey) {
    ev.preventDefault();
    commands.run(ev.shiftKey ? "design.saveAs" : "design.save");
  }
});

addEventListener("keydown", ev => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "")) return;
  if (ev.key === "?") { ev.preventDefault(); hudShortcuts.isOpen() ? hudShortcuts.hide() : showShortcuts(); }
  else if (ev.key === "Escape" && hudShortcuts?.isOpen()) hudShortcuts.hide();
  else if (ev.key === "Escape" && sidePanel?.isOpen()) sidePanel.hide();
  else if (ev.key === "o" && !ev.metaKey && !ev.ctrlKey) { ev.preventDefault(); commands.run("app.objects"); }
  else if (ev.key === "v" && !ev.metaKey && !ev.ctrlKey) { ev.preventDefault(); commands.run("app.view"); }
  else if (ev.key === "S" && ev.shiftKey && !ev.metaKey && !ev.ctrlKey) { ev.preventDefault(); toggleSolo(); }
  else if ((ev.key === "[" || ev.key === "]") && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
    const v = stepViewpoint(siteCache?.viewpoints, lastViewpoint, ev.key === "[" ? -1 : 1);
    if (v) { ev.preventDefault(); goToViewpoint(v); }
    else log("no saved views yet — Views → Save this view", "warn");
  }
  else if ((ev.key === "g" || ev.key === "G") && (ev.metaKey || ev.ctrlKey)) {
    ev.preventDefault();
    if (selection.size > 1) groupSelection(); else log("select more than one thing to group", "warn");
  }
});

// A TOOL NEEDS AN END. Esc exits, and a mis-clicked measurement point can be
// removed without restarting the tool.
addEventListener("keydown", ev => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "")) return;
  // Place and area use the same exit, so Esc reliably clears their previews
  // without requiring the user to find the tool's button again.
  // ESC LEAVES ANY TOOL, through the one exit — the same one the dock's Select takes
  if (ev.key === "Escape" && !fly.on && mode !== "orbit") {
    ev.preventDefault();
    leaveTool();
    return;
  }
  if (mode !== "measure") return;
  if (ev.key === "Backspace" || ev.key === "Delete") {
    ev.preventDefault();
    meas.pts.pop();
    drawMeasure();
  }
});

/** The design's name as the top bar shows it — and as the phone page repeats it. */
function shownDesignName() {
  return previewSource ? String(previewSource).split("/").pop().replace(/\.json$/, "")
                       : (currentVariant || "working design");
}

/** Keep the shell honest about what is on screen. Cheap, and it cannot drift. */
function syncShell() {
  topBar.setDesign({
    name: shownDesignName(),
    previewing: !!previewSource,
  });
  topBar.setMeta(`${(currentDesign?.plants ?? []).length} plants`);
  topBar.setHistory(document.getElementById("tlPos")?.textContent ?? "");
  syncCalibrationBadge();
  dock.sync();
}
const _showWhich = showWhichDesign;
showWhichDesign = function (...a) { const r = _showWhich.apply(this, a); syncShell(); return r; };
syncShell();
