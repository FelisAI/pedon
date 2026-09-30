// node --test tests/js/project_paths.test.mjs
//
// The dev server (viewer/project_paths.js) and the python tools (tools/project.py) must put every
// file in the SAME place — a second resolver that drifts would serve the viewer one project's
// design while the tools write another's, or one library's model while a tool writes to another.
// Both read schema/project_layout.json; this holds their answers equal, in both layouts.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const names = [["data", "design.json"], ["data", "designs", "a.json"], ["data", "plant_palette.json"],
               ["data", "refphotos", "x.jpg"], ["data", "captures", "s.ply"], ["review", "t", "v.png"],
               ["assets", "plants", "m.glb"], ["tools", "x.py"]];

function python(env) {
  const code = `import sys, json; sys.path.insert(0, "tools"); import project
print(json.dumps([project.resolve("/".join(p)) for p in json.loads(sys.argv[1])]))`;
  return JSON.parse(execFileSync("python3", ["-c", code, JSON.stringify(names)], { cwd: ROOT, env }).toString());
}

async function node(env) {
  const saved = { PEDON_PROJECT: process.env.PEDON_PROJECT, PEDON_PROJECTS: process.env.PEDON_PROJECTS,
                  PEDON_LIBRARY: process.env.PEDON_LIBRARY };
  for (const k of Object.keys(saved)) { if (env[k]) process.env[k] = env[k]; else delete process.env[k]; }
  try {
    const m = await import(`../../viewer/project_paths.js?x=${Math.random()}`);
    return names.map(p => m.resolvePath(p.join("/")));
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test("python and the dev server agree with a project active", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pedon-proj-"));
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), "pedon-lib-"));
  const env = { ...process.env, PEDON_PROJECT: dir, PEDON_LIBRARY: lib };
  const py = python(env), js = await node(env);
  assert.deepEqual(js, py);
  assert.equal(js[0], path.join(dir, "design.json"), "the working design is not the project's");
  // THE USER'S LIBRARY, not the app: the catalogue, the photos and every model file
  assert.equal(js[2], path.join(lib, "plant_palette.json"), "the catalogue is not the library's");
  assert.equal(js[3], path.join(lib, "refphotos", "x.jpg"), "the photos are not the library's");
  assert.equal(js[6], path.join(lib, "assets", "plants", "m.glb"), "a model file is not the library's");
  assert.equal(js[7], path.join(ROOT, "tools", "x.py"), "the app's own files left the app");
  assert.equal(js[5], path.join(dir, "review", "t", "v.png"));
});

test("the file route stays inside the library and the project", async () => {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), "pedon-lib-"));
  const saved = process.env.PEDON_LIBRARY;
  process.env.PEDON_LIBRARY = lib;
  try {
    const m = await import(`../../viewer/project_paths.js?y=${Math.random()}`);
    const inside = rel => m.resolvePath(rel).startsWith(m.dataBase(rel) + path.sep);
    assert.ok(inside("data/plant_palette.json"), "the catalogue is refused by its own base");
    assert.ok(inside("assets/objects/x.glb"));
    assert.ok(!inside("assets/../tools/project.py"), "a path climbed out of the library into the app");
  } finally { if (saved === undefined) delete process.env.PEDON_LIBRARY; else process.env.PEDON_LIBRARY = saved; }
});

test("…and in the single-site layout, where nothing moved", async () => {
  // an EMPTY projects folder, so no site is active whatever this machine has open
  const env = { ...process.env, PEDON_PROJECTS: fs.mkdtempSync(path.join(os.tmpdir(), "pedon-none-")) };
  delete env.PEDON_PROJECT;
  const py = python(env), js = await node(env);
  assert.deepEqual(js, py);
  assert.equal(js[0], path.join(ROOT, "data", "design.json"));
});
