// node --test tests/js/ui_bearing.test.mjs
//
// The compass convention — "a world bearing is atan2(east, -z), 0-360 clockwise
// from north" — has ONE home, viewer/src/lighting.js's worldBearingOf, and this
// file is about main.js's two consumers of it.
//
// Why that matters more than tidiness: a height-field lookup transcribed three
// times can index the rows the wrong way round three times — a mirrored yard —
// and frame bugs all have one shape: world and ENU are IDENTICAL at yaw 0, so a
// sign error in a bearing is perfectly invisible until someone presses "Set
// north", and then it is wrong by twice the yaw (2 x 23.3 deg on this property,
// the difference between a south-facing slope and a south-east one). A
// convention written out three times is three chances to write it differently.
//
// main.js has exactly two sites:
//
//   1. SET NORTH — two clicks give a world direction that the owner says is
//      north, and the viewer needs the yaw increment that turns that direction
//      onto -z. That number is added to calib.yaw, saved to calibration.json,
//      and reversed by tools/sun.py (`true = stored - degrees(yaw)`), so it is
//      not a display value.
//   2. terrainFacts() — the viewer's only writer of a stored compass bearing
//      into site.json. Its behaviour across the python/node boundary is already
//      pinned by tests/test_dry2.py; what is checked here is the half that file
//      cannot check by running it — that the expression is imported rather than
//      transcribed — plus its refusal branch, which nothing else covers.
//
// The sweep is geometric, not a transcription: the yaw increment is applied with
// three's own rotateY (geoGroup.rotation.set(0, calib.yaw, 0) is literally what
// applyCalib does) and the clicked direction has to LAND on -z. Re-typing
// Math.atan2(x, -z) here as the oracle would only test this file's memory of the
// convention, which is the exact failure this convention is prone to.
//
// Counts before deltas, everywhere: a test that asserts only the gaps between
// stair levels passes vacuously on a single tread.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// three has no node_modules above tests/, so reach the viewer's copy directly —
// the same instance lighting.js imports (lighting.test.mjs verified that).
const THREE = await import(
  path.join(ROOT, "viewer", "node_modules", "three", "build", "three.module.js"));
const { worldBearingOf } = await import(path.join(ROOT, "viewer", "src", "lighting.js"));

const MAIN_PATH = path.join(ROOT, "viewer", "src", "main.js");
const main = readFileSync(MAIN_PATH, "utf8");
const Y = new THREE.Vector3(0, 1, 0);
const REAL_YAW = 0.4069;            // 23.3 deg, the yaw measured on this property

// ── extraction ────────────────────────────────────────────────────────────
// main.js cannot be imported (it builds a WebGLRenderer at module scope), so the
// pure parts are sliced out and evaluated — the same trick ui_place.test.mjs and
// tests/test_dry2.py use. Both markers are asserted found and in order: slicing
// from an indexOf that returned -1 is slice(-1), the file's LAST CHARACTER, so a
// regex over it can never match and the guard sits green with the duplicate it
// forbids still in the file.
const START = "// ── BEARING-START ──";
const END = "// ── BEARING-END ──";

function bearingBlock() {
  const a = main.indexOf(START);
  const b = main.indexOf(END);
  assert.notEqual(a, -1, `${START} missing from main.js — nothing was extracted`);
  assert.notEqual(b, -1, `${END} missing from main.js — nothing was extracted`);
  assert.ok(b > a, "the bearing markers are in the wrong order");
  const block = main.slice(a + START.length, b);
  assert.ok(block.length > 120, `the extracted block is only ${block.length} chars`);
  return block;
}

/** End index (exclusive) of the {...} block opening at or after `from`. */
function blockEnd(s, from) {
  const open = s.indexOf("{", from);
  assert.notEqual(open, -1, "no block found");
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") { depth--; if (!depth) return i + 1; }
  }
  assert.fail("unbalanced braces while slicing main.js");
}

function fnSource(decl) {
  const a = main.indexOf(decl);
  assert.notEqual(a, -1, `${decl} is gone from main.js — this test is slicing nothing`);
  return main.slice(a, blockEnd(main, a));
}

const { northYawIncrement } = new Function(
  "THREE", "worldBearingOf",
  `${bearingBlock()}\nreturn { northYawIncrement };`)(THREE, worldBearingOf);
assert.equal(typeof northYawIncrement, "function",
  "northYawIncrement did not come out of the BEARING block as a function");

const TERRAIN_FACTS_SRC = fnSource("function terrainFacts");
// levelGroup's quaternion is stubbed to identity: the level rotation is a
// separate transform and not part of the north convention under test.
const runTerrainFacts = new Function(
  "THREE", "worldBearingOf",
  `const levelGroup = { quaternion: new THREE.Quaternion() };
   let calib = {};
   ${TERRAIN_FACTS_SRC}
   return c => { calib = c; return terrainFacts(); };`)(THREE, worldBearingOf);

// ── the sweep ─────────────────────────────────────────────────────────────
// Every whole-degree bearing at three pick distances. 0.5 m clears main.js's own
// "points too close together" guard at 0.2 m.
const LENGTHS = [0.5, 3.7, 21.0];
const CASES = [];
for (const len of LENGTHS) {
  for (let deg = 0; deg < 360; deg++) {
    const r = THREE.MathUtils.degToRad(deg);
    // world: x = east, -z = north. A direction at compass bearing `deg`.
    CASES.push({ deg, len, d: { x: len * Math.sin(r), z: -len * Math.cos(r) } });
  }
}

test("every case in the sweep is a distinct direction", () => {
  assert.equal(CASES.length, 360 * LENGTHS.length);
  assert.equal(new Set(CASES.map(c => `${c.deg}/${c.len}`)).size, CASES.length);
});

test("the clicked direction lands on north after the yaw increment", () => {
  // applyCalib() does geoGroup.rotation.set(0, calib.yaw, 0), so the increment
  // has to be the rotation about +Y that puts the picked direction on -z. This is
  // the whole meaning of "Set north".
  let checked = 0;
  for (const c of CASES) {
    const g = northYawIncrement(c.d);
    assert.ok(Number.isFinite(g), `bearing ${c.deg}: increment is ${g}`);
    const v = new THREE.Vector3(c.d.x, 0, c.d.z).applyAxisAngle(Y, g);
    assert.ok(Math.abs(v.x) < 1e-9 * c.len,
      `bearing ${c.deg} at ${c.len} m: after the yaw increment east is ${v.x}, not 0`);
    assert.ok(v.z < 0,
      `bearing ${c.deg} at ${c.len} m: the picked direction ended up pointing SOUTH ` +
      `(z=${v.z}) — the sign of the yaw increment is inverted`);
    assert.ok(Math.abs(v.z + c.len) < 1e-9 * c.len,
      `bearing ${c.deg} at ${c.len} m: length changed, ${-v.z} vs ${c.len}`);
    checked++;
  }
  assert.equal(checked, CASES.length);
});

test("the yaw increment is signed, in (-pi, pi]", () => {
  // calib.yaw += g, and the same g is printed as "scene rotated N deg". Returning
  // a 0-360 bearing straight from worldBearingOf would still land the direction on
  // north — the test above would pass — while turning a 23 deg nudge west into
  // "rotated 337 deg" and drifting the stored yaw by a full turn every click.
  const gs = CASES.map(c => northYawIncrement(c.d));
  assert.equal(gs.length, CASES.length);
  for (let i = 0; i < gs.length; i++) {
    assert.ok(gs[i] > -Math.PI - 1e-12 && gs[i] <= Math.PI + 1e-12,
      `bearing ${CASES[i].deg}: increment ${gs[i]} rad is outside (-pi, pi]`);
  }
  // the concrete case: one degree WEST of north is a small negative nudge
  const west = CASES.filter(c => c.deg === 359);
  assert.equal(west.length, LENGTHS.length);
  for (const c of west) {
    const g = northYawIncrement(c.d);
    assert.ok(g < 0, `a pick 1 deg west of north gave +${g} rad, not a small negative one`);
    assert.ok(Math.abs(THREE.MathUtils.radToDeg(g) + 1) < 1e-9,
      `expected about -1 deg, got ${THREE.MathUtils.radToDeg(g)}`);
  }
});

test("the increment is the same convention tools/sun.py reverses", () => {
  // sun.true_bearing is `true = stored - degrees(yaw)`, derived in prose from
  // this very code path (tests/test_sun.py::test_true_bearing_applies_the_yaw_in_
  // the_viewer_s_direction). So the direction the owner CALLED north must come
  // back out of that formula as bearing 0.
  let checked = 0;
  for (const c of CASES) {
    const stored = worldBearingOf(c.d);
    const trueDeg = ((stored - THREE.MathUtils.radToDeg(northYawIncrement(c.d))) % 360 + 360) % 360;
    const off = Math.min(trueDeg, 360 - trueDeg);
    assert.ok(off < 1e-9,
      `bearing ${c.deg}: after Set north the picked direction reads ${trueDeg} deg true, not 0`);
    checked++;
  }
  assert.equal(checked, CASES.length);
});

// ── the two call sites import the convention ──────────────────────────────
test("main.js imports worldBearingOf from its home", () => {
  const m = main.match(/import\s*\{([^}]*)\}\s*from\s*"\.\/lighting\.js"/);
  assert.ok(m, 'main.js has no `import { ... } from "./lighting.js"`');
  const names = m[1].split(",").map(s => s.trim());
  assert.ok(names.includes("worldBearingOf"),
    `main.js imports {${names.join(", ")}} from lighting.js — worldBearingOf is not among them`);
});

test("neither bearing site transcribes the expression", () => {
  // lighting.js's own docstring names these two call sites as the reason
  // worldBearingOf is exported. Scoped to the two functions rather than to the
  // whole file: fit.js's atan2(szx - sxz, ...) and detect.js's atan2(2*vxz, ...)
  // are real and are something else entirely.
  const sites = {
    northYawIncrement: bearingBlock(),
    terrainFacts: TERRAIN_FACTS_SRC,
  };
  assert.equal(Object.keys(sites).length, 2);
  for (const [name, src] of Object.entries(sites)) {
    assert.ok(src.includes("worldBearingOf("),
      `${name} does not call worldBearingOf — the convention has a second copy`);
    assert.ok(!src.includes("Math.atan2"),
      `${name} still writes Math.atan2 itself: ${src}`);
  }
});

// ── terrainFacts still behaves ────────────────────────────────────────────
// The cross-boundary agreement (viewer vs tools/sun.py, at the real yaw) is
// tests/test_dry2.py's. What is here is the branch that file never exercises.
test("terrainFacts refuses a bearing until north is set", () => {
  const n = new THREE.Vector3(0.2, 0.96, -0.19).normalize();
  const groundNormal = { x: n.x, y: n.y, z: n.z };
  const unset = runTerrainFacts({ groundNormal, slopeDeg: 13.0, northSet: false, yaw: REAL_YAW });
  assert.ok(unset, "terrainFacts returned nothing for a measurable slope");
  assert.equal(unset.slope_deg, 13.0);
  assert.equal(unset.downhill_azimuth_deg, undefined,
    "a compass bearing was written while the scan's heading is unknown");

  const set = runTerrainFacts({ groundNormal, slopeDeg: 13.0, northSet: true, yaw: REAL_YAW });
  assert.ok(Number.isInteger(set.downhill_azimuth_deg),
    `site.json takes whole degrees; got ${set.downhill_azimuth_deg}`);
  assert.ok(set.downhill_azimuth_deg >= 0 && set.downhill_azimuth_deg <= 360,
    `bearing ${set.downhill_azimuth_deg} is outside 0-360`);

  assert.equal(runTerrainFacts({ groundNormal, slopeDeg: 0.4, northSet: true, yaw: 0 }), null,
    "a slope under 1 deg is not a measurable fact and must not be reported");
});

test("terrainFacts turns the stored normal by the yaw, not past it", () => {
  // Not a second copy of test_dry2.py's sweep — that one compares the viewer to
  // tools/sun.py. This asserts the thing that makes sharing the convention safe:
  // at the real yaw the answer MOVES, and it moves by exactly the yaw. A bearing
  // that does not move with the yaw is a frame bug, and it is invisible at yaw 0.
  const rows = [];
  for (let deg = 0; deg < 360; deg += 17) {
    const t = THREE.MathUtils.degToRad(13.0), b = THREE.MathUtils.degToRad(deg);
    const n = new THREE.Vector3(Math.sin(t) * Math.sin(b), Math.cos(t), -Math.sin(t) * Math.cos(b));
    const groundNormal = { x: n.x, y: n.y, z: n.z };
    rows.push({
      stored: worldBearingOf(n),
      at0: runTerrainFacts({ groundNormal, slopeDeg: 13.0, northSet: true, yaw: 0 }),
      atYaw: runTerrainFacts({ groundNormal, slopeDeg: 13.0, northSet: true, yaw: REAL_YAW }),
    });
  }
  assert.equal(rows.length, 22);
  assert.ok(rows.every(r => r.at0 && r.atYaw), "terrainFacts refused inside the sweep");
  const moved = rows.filter(r => r.at0.downhill_azimuth_deg !== r.atYaw.downhill_azimuth_deg);
  assert.equal(moved.length, rows.length,
    `${rows.length - moved.length} of ${rows.length} bearings ignored a 23.3 deg yaw`);
  for (const r of rows) {
    assert.ok(Math.abs(r.at0.downhill_azimuth_deg - r.stored) <= 0.51,
      `at yaw 0 the stored bearing ${r.stored} came back as ${r.at0.downhill_azimuth_deg}`);
    const want = ((r.stored - THREE.MathUtils.radToDeg(REAL_YAW)) % 360 + 360) % 360;
    // signed difference in (-180, 180], so 359.8 vs 0.1 is 0.3 and not 359.7
    const off = ((r.atYaw.downhill_azimuth_deg - want) % 360 + 540) % 360 - 180;
    assert.ok(Math.abs(off) <= 0.51,
      `at 23.3 deg yaw the stored ${r.stored} should read ${want}, got ${r.atYaw.downhill_azimuth_deg}`);
  }
});
