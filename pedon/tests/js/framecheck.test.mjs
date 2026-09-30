// node --test tests/js/framecheck.test.mjs
//
// A black frame must never reach disk, and a repeated frame must be reported.
//
// A WebGL context that dies mid-walkthrough writes byte-identical 3,362-byte
// files whose brightest pixel is 0, and a panel that trusts them shows them as
// photographs of the garden. A second, different fault is two stations drawing
// byte-identical pictures, so one viewpoint is spent twice on the same picture.
//
// A render on a context that is ALREADY lost is refused elsewhere. This is the
// half that check cannot see: a context that dies DURING a render leaves the API
// silent and the buffer black, so the only honest test is to look at the pixels.
import { resolvePath } from "../../viewer/project_paths.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { maxLuma, blankFrameReason, duplicateStations, readMaxLuma }
  from "../../viewer/src/framecheck.js";
import { uniqueNames, planStations } from "../../viewer/src/walkthrough.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = f => fs.readFileSync(resolvePath(f), "utf8");   // data/… is the active site's

const rgba = (...px) => new Uint8Array(px.flatMap(([r, g, b]) => [r, g, b, 255]));

test("an all-black buffer measures zero and one lit pixel does not", () => {
  assert.equal(maxLuma(rgba([0, 0, 0], [0, 0, 0], [0, 0, 0])), 0);
  // ONE unit of ONE channel in half a million pixels is enough to say something
  // was drawn — the threshold is exactly zero on purpose
  assert.equal(maxLuma(rgba([0, 0, 0], [0, 1, 0], [0, 0, 0])), 1);
  assert.equal(maxLuma(new Uint8Array(0)), 0);
});

test("maxLuma takes the brightest CHANNEL, not a green-weighted luma", () => {
  // a frame of saturated blue sky is a picture; a luma weighting would score it
  // at 0.07 of its blue and start calling real frames nearly blank
  assert.equal(maxLuma(rgba([0, 0, 200])), 200);
  assert.equal(maxLuma(rgba([200, 0, 0])), 200);
});

test("only an exactly-black frame is refused", () => {
  assert.match(blankFrameReason(0), /completely black/);
  assert.equal(blankFrameReason(1), null, "a nearly-black frame is a dark picture, not a dead one");
  assert.equal(blankFrameReason(255), null);
});

test("a frame nobody measured makes no claim either way", () => {
  // absence of evidence is not evidence of a fault: an older client that does
  // not report brightness must not have its frames thrown away
  assert.equal(blankFrameReason(null), null);
  assert.equal(blankFrameReason(undefined), null);
});

test("readMaxLuma never throws, whatever it is handed", () => {
  // "a badge must never break the panel" — a check that can take down every
  // render is worse than the fault it looks for
  assert.doesNotThrow(() => readMaxLuma(undefined));
  assert.doesNotThrow(() => readMaxLuma({}));
  assert.doesNotThrow(() => readMaxLuma({ getContext: () => { throw new Error("x"); } }));
  assert.equal(readMaxLuma({ getContext: () => ({ isContextLost: () => true }) }), 0);
});

test("two stations that drew the same picture are reported, not dropped", () => {
  // two byte-identical frames from two stations. Reporting keeps the output honest:
  // the station list is what needs fixing, and silently deleting one frame
  // would hide exactly that.
  const frames = [{ dataUrl: "A", name: "by the door" },
                  { dataUrl: "B", name: "the tea court" },
                  { dataUrl: "A", name: "back at the door" }];
  assert.deepEqual(duplicateStations(frames),
    [{ index: 2, sameAs: 0, name: "back at the door" }]);
  assert.equal(duplicateStations(frames).length, 1);
  assert.equal(frames.length, 3, "duplicateStations removed a frame");
  assert.deepEqual(duplicateStations([]), []);
  assert.deepEqual(duplicateStations(undefined), []);
});

test("six identical black frames read exactly as the ones on disk", () => {
  // the fixture is the real failure: one file, six names, brightest pixel 0
  const black = { dataUrl: "BLACK", maxLuma: 0 };
  const set = Array.from({ length: 6 }, (_, i) => ({ ...black, name: `station ${i}` }));
  assert.equal(set.filter(f => blankFrameReason(f.maxLuma)).length, 6);
  assert.equal(duplicateStations(set).length, 5, "five of the six are repeats of the first");
});

test("BOTH write paths check it — the browser and the one place it reaches disk", () => {
  const vp = read("viewer/src/viewport.js");
  assert.match(vp, /blankFrameReason/, "renderFrom does not check what it drew");
  assert.match(vp, /duplicateStations/, "the walkthrough does not report repeated stations");
  const wt = read("viewer/src/walkthrough.js");
  assert.match(wt, /readMaxLuma/, "walkthrough frames carry no brightness measurement");
  // the SERVER is the single write path, so it refuses too — a check that only
  // one client performs is a check any other client skips
  const cfg = read("viewer/vite.config.js");
  assert.match(cfg, /brightest_pixel === 0/,
    "the dev server writes whatever it is handed, black frames included");
});

test("the panel lists the photographs that EXIST, not eight hard-coded names", () => {
  // broker ids are v_<uuid>, so a Vite restart cannot overwrite a session's
  // evidence; nothing writes v_0001..v_0008-style names, and a panel pinned to
  // them lists a dead set.
  const main = read("viewer/src/main.js")
    .split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const body = main.slice(main.indexOf("async function renderShotList"),
                          main.indexOf("function describeAge"));
  assert.ok(body.length > 100, "renderShotList was not found");
  assert.match(body, /\/api\/views/, "the shot list does not ask what is on disk");
  assert.ok(!/padStart\(4/.test(body), "the shot list still builds v_0001-style names");
  assert.match(body, /design_mtime/, "nothing says the photographs are older than the design");
  assert.match(read("viewer/vite.config.js"), /url === "\/api\/views"/,
    "the endpoint the panel reads does not exist");
});

test("no two stations share a name — a name is a station's address", () => {
  // A design with two benches gets two photographs captioned "sitting on the
  // bench, looking at the lantern", from different places looking at different
  // lanterns. The critique writes about a station
  // BY NAME, so two of them reading the same is two pieces of feedback nobody
  // can act on.
  const stations = [
    { name: "sitting on the bench, looking at the lantern", id: "bench_tea" },
    { name: "along the contour walk" },
    { name: "sitting on the bench, looking at the lantern", id: "bench_low" },
  ];
  const out = uniqueNames(stations);
  assert.equal(new Set(out.map(s => s.name)).size, 3, "two stations still share a name");
  assert.match(out[0].name, /bench_tea/, "disambiguated by something other than the id");
  assert.match(out[2].name, /bench_low/);
  assert.equal(out[1].name, "along the contour walk", "a unique name was rewritten");
});

test("a repeated name with no id still comes out distinct", () => {
  const out = uniqueNames([{ name: "on the path" }, { name: "on the path" }]);
  assert.equal(new Set(out.map(s => s.name)).size, 2);
});

test("uniqueNames does not mutate the stations it was given", () => {
  // the fixture must be one where doing it wrong is VISIBLE: both entries share
  // a name, so an in-place rewrite would show up in the input
  const input = [{ name: "same", id: "a" }, { name: "same", id: "b" }];
  const before = input.map(s => s.name);
  const out = uniqueNames(input);
  assert.notDeepEqual(out.map(s => s.name), before, "the fixture proves nothing — pick another");
  assert.deepEqual(input.map(s => s.name), before, "uniqueNames rewrote its argument");
});

test("planStations ITSELF returns unique names — not just the helper it calls", () => {
  // Testing `uniqueNames` alone leaves every assertion green with the call to it
  // removed from planStations, while the real path goes back to two stations
  // called the same thing. A pure function is only half a guard; the other half
  // is that something calls it.
  const design = {
    paths: [{ id: "walk", spline: [[0, 0], [4, 0], [8, 0], [12, 0]], width_m: 1 }],
    patios: [], beds: [],
    objects: [
      { id: "bench_tea", kind: "bench", position: [2, 2], rotation_deg: 0 },
      { id: "bench_low", kind: "bench", position: [9, 2], rotation_deg: 0 },
      { id: "lantern_a", kind: "stone lantern", position: [3, 4] },
      { id: "lantern_b", kind: "stone lantern", position: [10, 4] },
    ],
  };
  const out = planStations(design, 8);
  const benches = out.filter(s => /sitting on the bench/.test(s.name));
  assert.equal(benches.length, 2, "the fixture must produce two same-kind seats to prove anything");
  assert.equal(new Set(out.map(s => s.name)).size, out.length,
    `two stations share a name: ${out.map(s => s.name).join(" | ")}`);
});

// ONE hold on the owner's view: an off-screen render moves the camera and resizes the drawing,
// and everything it moved comes back — the walkthrough and the look renders share it.
test("holdView puts back the camera and the drawing size an off-screen render changed", async () => {
  const THREE = await import("../../viewer/node_modules/three/build/three.module.js");
  const { holdView } = await import("../../viewer/src/framecheck.js");
  const camera = new THREE.PerspectiveCamera(50, 1.5, 0.1, 100);
  camera.position.set(1, 2, 3); camera.up.set(0, 1, 0); camera.lookAt(0, 0, 0);
  let size = { x: 1200, y: 800 }, pr = 2;
  const renderer = { getSize: v => v.set(size.x, size.y), getPixelRatio: () => pr,
                     setSize: (x, y) => { size = { x, y }; }, setPixelRatio: p => { pr = p; } };
  const before = { pos: camera.position.toArray(), quat: camera.quaternion.toArray(), fov: camera.fov, aspect: camera.aspect };
  const restore = holdView(renderer, camera);
  renderer.setPixelRatio(1); renderer.setSize(900, 576);
  camera.position.set(9, 9, 9); camera.lookAt(5, 0, 0); camera.up.set(1, 0, 0); camera.fov = 20; camera.aspect = 0.5;
  restore();
  assert.deepEqual({ pos: camera.position.toArray(), quat: camera.quaternion.toArray(), fov: camera.fov, aspect: camera.aspect }, before);
  assert.deepEqual(camera.up.toArray(), [0, 1, 0]);
  assert.deepEqual([size, pr], [{ x: 1200, y: 800 }, 2]);
});
