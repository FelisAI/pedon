// THE LIBRARY'S SPECIES BUILDERS (viewer/src/species.js): a species builder is the user's, in
// <library>/species/, loaded by the app in the order the library gives. Each case runs in its own
// node process with its own PEDON_LIBRARY, because the list is loaded once, when species.js loads.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = path.join(ROOT, "viewer", "src");

function library(files) {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), "pedon-library-"));
  fs.mkdirSync(path.join(lib, "species"));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(lib, "species", name), text);
  return lib;
}
// what the app sees with this library: run `body` in a fresh node, return its JSON and its warnings
function withLibrary(lib, body) {
  const script = `
    globalThis.document = { createElement: () => ({ getContext: () => null }) };
    const THREE = await import(${JSON.stringify(path.join(ROOT, "viewer/node_modules/three/build/three.module.js"))});
    const { SPECIES } = await import(${JSON.stringify(path.join(SRC, "species.js"))});
    const plants = await import(${JSON.stringify(path.join(SRC, "plants.js"))});
    console.log(JSON.stringify(await (async () => { ${body} })()));`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script],
    { env: { ...process.env, PEDON_LIBRARY: lib }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(out.trim().split("\n").pop());
}

// a builder the way a library writes one: three by name, the app's parts as @pedon/…
const builder = (flag, species, extra = "") => `
  import * as THREE from "three";
  import { translucent } from "@pedon/translucency.js";
  export function build(plant, r) {
    if (plant.species !== ${JSON.stringify(species)}) return null;
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.BoxGeometry(plant.mature_spread_m, plant.mature_height_m, plant.mature_spread_m),
                         new THREE.MeshStandardMaterial({ color: 0x336633 })));
    g.children[0].position.y = plant.mature_height_m / 2;
    g.userData.${flag} = typeof translucent === "function";
    return g;
  }
  ${extra}`;
const plant = species => ({ id: "p1", species, form: "shrub", mature_height_m: 0.6, mature_spread_m: 0.8, position: [0, 0] });

test("a library's builders load in its order, then the rest by name; a helper or a broken file is skipped", () => {
  const lib = library({
    "order.json": JSON.stringify(["second_in_name", "a_first"]),
    "a_first.js": builder("aModel", "Testus alpha"),
    "second_in_name.js": builder("bModel", "Testus beta"),
    "c_unlisted.js": builder("cModel", "Testus gamma"),
    "helper.js": "export const shared = 1;\n",
    "broken.js": "export function build( {\n",
  });
  try {
    const got = withLibrary(lib, "return SPECIES.map(s => s.name);");
    assert.deepEqual(got, ["second_in_name", "a_first", "c_unlisted"]);
  } finally { fs.rmSync(lib, { recursive: true, force: true }); }
});

test("a library builder draws its species, with the app's three.js, in both modes", () => {
  const lib = library({ "testus.js": builder("testusModel", "Testus alpha") });
  try {
    const got = withLibrary(lib, `
      const p = ${JSON.stringify(plant("Testus alpha"))};
      const full = plants.buildPlant(p, { quality: "detailed" }), fast = plants.buildPlant(p, { quality: "fast" });
      const flag = g => { let f = null; g.traverse(o => { if (o.userData?.testusModel !== undefined) f = o.userData.testusModel; }); return f; };
      return { full: flag(full), fast: flag(fast), group: full instanceof THREE.Group,
               drawnByCode: plants.drawnByCode(p), other: plants.drawnByCode({ ...p, species: "Nothing here" }) };`);
    // the flag is true only if the builder's @pedon/ import reached the app's translucency.js
    assert.deepEqual(got, { full: true, fast: true, group: true, drawnByCode: true, other: false });
  } finally { fs.rmSync(lib, { recursive: true, force: true }); }
});

test("a library builder is told when one plant is seen close (specimen) and when not", () => {
  const lib = library({ "testus.js": builder("testusModel", "Testus alpha").replace(
    "export function build(plant, r) {", "export function build(plant, r, tint, individual, opts) {").replace(
    "return g;\n  }", "g.userData.specimen = opts?.specimen === true; return g;\n  }") });
  try {
    const got = withLibrary(lib, `
      const p = ${JSON.stringify(plant("Testus alpha"))};
      const seen = g => { let s = null; g.traverse(o => { if (o.userData?.specimen !== undefined) s = o.userData.specimen; }); return s; };
      return { close: seen(plants.buildPlant(p, { quality: "detailed", specimen: true })),
               garden: seen(plants.buildPlant(p, { quality: "detailed" })) };`);
    assert.deepEqual(got, { close: true, garden: false });
  } finally { fs.rmSync(lib, { recursive: true, force: true }); }
});

test("with no library there are no species builders, and every plant is still drawn", () => {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), "pedon-library-"));
  try {
    const got = withLibrary(lib, `
      const g = plants.buildPlant(${JSON.stringify(plant("Testus alpha"))}, { quality: "detailed" });
      let meshes = 0; g.traverse(o => { if (o.isMesh) meshes++; });
      return { species: SPECIES.length, meshes: meshes > 0 };`);
    assert.deepEqual(got, { species: 0, meshes: true });
  } finally { fs.rmSync(lib, { recursive: true, force: true }); }
});

// the pages where one plant is judged close up ask its builder for the specimen mesh —
// the library's builders get the flag (plants.js speciesModel); the pages must set it
test('compare.html and preview.html ask for the specimen mesh', () => {
  // A PURE FLAG IS HALF A GUARD. Everything above passes with the two pages
  // never setting it, and the close-up review page would quietly show the garden
  // leaf — the one place the fine tessellation is actually worth paying for.
  for (const page of ['compare.html', 'preview.html']) {
    const src = fs.readFileSync(path.join(ROOT, "viewer", page), 'utf8');
    assert.match(src, /buildPlant\([^)]*specimen:\s*true/,
      `${page} builds plants at garden detail — it is where a leaf is judged close up`);
  }
});
