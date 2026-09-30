// node --test tests/js/projects_ui.test.mjs
//
// The project window must show how to start a new site project, not answer "a second
// property is a second checkout". These hold the doors in place; the real proof is the
// headless check of the running viewer, since a UI defect is invisible in source.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = fs.readFileSync(path.join(ROOT, "viewer", "index.html"), "utf8");
const main = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");
const vite = fs.readFileSync(path.join(ROOT, "viewer", "vite.config.js"), "utf8");
const topbar = fs.readFileSync(path.join(ROOT, "viewer", "src", "shell", "topbar.js"), "utf8");
const body = (src, start) => { const i = src.indexOf(start); assert.ok(i >= 0, `${start} is gone`); return src.slice(i, src.indexOf("\n}", i)); };

test("the project window has a way to start and to open a site", () => {
  for (const id of ["projSwitch", "btnProjNew", "projNewForm", "projNewName", "btnProjCreate"])
    assert.ok(html.includes(`id="${id}"`), `#${id} is missing`);
  assert.doesNotMatch(main, /second property is a second checkout/, "the old answer is back");
});

test("starting or opening a site goes through /api/projects and reloads the page", () => {
  const req = body(main, "async function projectRequest");
  assert.match(req, /fetch\("\/api\/projects"/);
  const create = body(main, "async function createProject");
  assert.match(create, /action: "new"/);
  assert.match(create, /location\.reload\(\)/, "a new site half-loaded over the old one");
  assert.match(main, /action: "open", slug: ev\.target\.value/);
});

test("the dev server does not own what a project is — tools/project.py does", () => {
  const route = vite.slice(vite.indexOf('url === "/api/projects"'), vite.indexOf('url === "/api/project")'));
  assert.match(route, /"tools", "project\.py"/, "a second implementation of projects in JS");
  assert.doesNotMatch(route, /mkdirSync|writeFileSync/, "the server writes project files itself");
});

test("a picked capture is kept in the site's captures, then opened from there", () => {
  const i = main.indexOf('getElementById("splatFile").addEventListener');
  const handler = main.slice(i, main.indexOf("\n});", i));
  assert.ok(handler.indexOf('fetch(`/api/captures?name=') < handler.indexOf("loadStage(kept)"),
    "the file is loaded before it is kept, or never kept");
  const route = vite.slice(vite.indexOf('req.method === "POST" && url === "/api/captures"'));
  assert.match(route.slice(0, 1600), /dataPath\("captures"\)/, "uploads land somewhere other than the site");
  assert.match(route.slice(0, 1600), /\(ply\|spz\|splat\|ksplat\|sog\|glb\)\$/i, "any file name is accepted");
});

test("the top bar says which site", () => {
  assert.match(topbar, /setSite\(name\)/);
  assert.match(topbar, /class="tb-site"[^>]*hidden/, "a site name shows before there is one");
  assert.match(main, /topBar\?\.setSite\(/);
});
