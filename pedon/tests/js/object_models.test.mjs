// node --test tests/js/object_models.test.mjs
//
// An object whose geometry is a FILE.
//
// The owner can photograph or scan things they own — plants, stones and so on —
// and add them to the assets at their real size.
//
// A whole-site capture is 229,829 vertices over 476 m² of surveyed ground — a
// mean vertex spacing of 4.6 cm, so a 0.4 m stone AS IT APPEARS IN THAT SCAN gets
// about 190 vertices: a silhouette and no surface. But resolution there is a
// function of how close the camera gets and how many frames, not of how big the
// subject is, and the site capture already proves the FORMAT works because the
// viewer loads it.
//
// So the requirement is structural: a plant can be a file (`plant.asset` beats
// the species table), and an OBJECT must be able to be one too — `objectMesh` as
// `BUILDERS[name](h, w, seed)` or a placeholder, full stop, leaves a scanned
// stone nowhere to go.
import { resolvePath } from "../../viewer/project_paths.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { safeObjectModel, objectModelsNeededBy } from "../../viewer/src/assets.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = f => fs.readFileSync(resolvePath(f), "utf8");   // data/… is the active site's

test("a model path is restricted to assets/objects/, and nothing else", () => {
  // This string arrives in a design document, which a MODEL writes, and it
  // reaches a loader. A free-text path from a document to a fetch is a shape
  // worth refusing even when nothing is trying.
  assert.equal(safeObjectModel("assets/objects/stone_1.glb"), "assets/objects/stone_1.glb");
  assert.equal(safeObjectModel("assets/objects/scans/stone_1.gltf"),
               "assets/objects/scans/stone_1.gltf");
  for (const bad of [
    "assets/objects/../../etc/passwd.glb",
    "/etc/passwd.glb",
    "../assets/objects/x.glb",
    "assets/plants/manzanita.glb",          // the right kind of file, wrong home
    "assets/objects/x.txt",
    "assets/objects/x",
    "assets/objects//x.glb",
    "", null, undefined, 42,
  ]) assert.equal(safeObjectModel(bad), null, `accepted ${JSON.stringify(bad)}`);
});

test("only the objects that NAME one are awaited", () => {
  const design = { objects: [
    { id: "a", kind: "boulder", model: "assets/objects/stone_1.glb" },
    { id: "b", kind: "bench" },
    { id: "c", kind: "boulder", model: "assets/objects/stone_1.glb" },   // the same file
    { id: "d", kind: "pot", model: "/etc/passwd.glb" },                  // refused
  ] };
  assert.deepEqual(objectModelsNeededBy(design), ["assets/objects/stone_1.glb"]);
  assert.deepEqual(objectModelsNeededBy({ objects: [] }), []);
  assert.deepEqual(objectModelsNeededBy({}), []);
  assert.deepEqual(objectModelsNeededBy(null), []);
});

test("a file BEATS the builder, and the builder is the fallback", () => {
  // the same precedence `plant.asset` has over the species table — and the
  // fallback matters: `objectMesh` is synchronous, so a model that has not
  // arrived yet draws a preset for one frame rather than nothing at all
  const src = read("viewer/src/objects.js")
    .split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  assert.match(src, /buildAssetObject\(obj\)/, "objectMesh cannot use a file at all");
  assert.match(src, /fromFile\s*\?\?\s*\(name \? BUILDERS/,
    "the builder is not the fallback — a late model would draw nothing");
});

test("object models are AWAITED before the first build, like plant models", () => {
  // buildPlant is synchronous, so a late model is a silently procedural plant.
  // objectMesh is synchronous too and has the same hole unless it is awaited.
  const main = read("viewer/src/main.js")
    .split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const awaits = [...main.matchAll(/await ensurePlantModels\(/g)].length;
  const objs = [...main.matchAll(/await ensureObjectModels\(objectModelsNeededBy\(/g)].length;
  assert.ok(awaits > 0, "nothing awaits the plant models — the scan is broken");
  assert.equal(objs, awaits,
    `${awaits} places await plant models and ${objs} await object models; a design `
    + "loaded through the one that does not would draw presets where the scans are");
});

test("a scanned solid is NOT double-sided, unlike a leaf card", () => {
  // a leaf is a single quad seen from both sides; a scanned stone has a real
  // inside, and drawing its back faces reads as a hole punched through the front
  // COMMENTS STRIPPED FIRST. The comment inside the function says "NOT
  // DoubleSide, unlike a leaf card" — and an absence assertion that reads
  // comments is defeated by the sentence explaining it (the same trap as
  // `// applyLayers, NOT applyObjectVisibility`).
  const src = read("viewer/src/assets.js")
    .split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const at = src.indexOf("export async function ensureObjectModels");
  assert.ok(at > 0, "ensureObjectModels is gone");
  const body = src.slice(at, src.indexOf("\nexport ", at + 10));
  assert.ok(!/DoubleSide/.test(body), "object models are forced double-sided");
  assert.match(body, /castShadow/, "a scanned object casts no shadow");
});

test("the declared height wins over the model's own", () => {
  // "an object is the size it SAYS it is", and a scan's units are
  // whatever the scanner felt like
  const src = read("viewer/src/assets.js");
  const at = src.indexOf("export function buildAssetObject");
  const body = src.slice(at, src.indexOf("\nexport ", at + 10) + 1 || undefined);
  assert.match(body, /obj\?\.height_m/, "the design's height is ignored");
  assert.match(body, /entry\.height_m/, "nothing measures the model");
  assert.match(body, /base_m/, "the model is not sat on its own base");
});
