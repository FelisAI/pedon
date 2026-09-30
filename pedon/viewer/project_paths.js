// WHERE PEDON'S FILES ARE — the dev server's half of tools/project.py, read from the same file
// (schema/project_layout.json), which says the rule. `data/…` is a VIRTUAL folder: the library's
// names (the plant catalogue, reference photos, caches) are in the user's LIBRARY, everything else
// — the site, its designs, their history, the capture — in the ACTIVE project; `assets/…` is the
// library's too. Resolved on EVERY request: the server outlives a project switch.
// tests/js/project_paths.test.mjs holds the two halves to the same answers. Creating, listing
// and switching projects is tools/project.py's alone.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAYOUT = JSON.parse(fs.readFileSync(path.join(ROOT, "schema", "project_layout.json"), "utf8"));
const LIBRARY_NAMES = new Set(LAYOUT.library);          // data/<name> that is the library's
const LIBRARY_ROOTS = new Set(LAYOUT.library_roots);    // <root>/… that is the library's (assets/)
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

const homePath = (env, fallback) =>
  path.resolve(((process.env[env] ?? "").trim() || fallback).replace(/^~(?=$|\/)/, os.homedir()));

/** Where sites live: $PEDON_PROJECTS, else ~/PEDON — outside the app. */
export function projectsRoot() { return homePath(LAYOUT.projects_env, LAYOUT.projects_dir); }

/** The user's library of assets, shared by every project: $PEDON_LIBRARY, else ~/PEDON/library. */
export function libraryRoot() { return homePath(LAYOUT.library_env, LAYOUT.library_dir); }

/** The library as the module loaders name its files — through any symlink on the way (a synced
 *  folder, macOS's /var -> /private/var): Node and Vite identify a module by its real path, and a
 *  prefix test against the path as written matches none of the library's files. */
export function libraryRealRoot() {
  try { return fs.realpathSync(libraryRoot()); } catch { return libraryRoot(); }
}

/** Whether phones on this network may fetch the AR file: a MACHINE's setting, off until the user
 *  opens the door (the "See it on site" sheet), remembered as a file beside the sites. */
export function phoneDoorFile() { return path.join(projectsRoot(), LAYOUT.phone_door_file); }
export function phoneDoorOpen() { return fs.existsSync(phoneDoorFile()); }

export function activeProject() {
  const env = (process.env[LAYOUT.env] ?? "").trim();
  if (env) return env;
  try { return fs.readFileSync(path.join(projectsRoot(), LAYOUT.active_file), "utf8").trim() || null; }
  catch { return null; }
}

export function projectFolder(name = activeProject()) {
  if (!name) return path.join(ROOT, "data");
  if (path.isAbsolute(name)) return name;
  if (!SLUG.test(name)) throw new Error(`not a project name: ${name}`);
  return path.join(projectsRoot(), name);
}

/** Where the library's plant code is: <library>/species. */
export function speciesDir(library = libraryRoot()) { return path.join(library, LAYOUT.species_dir); }

/** The library's plant code, in the order it is asked: the modules <library>/species/
 *  order.json names, most specific first, then any other module there by name. A module that is
 *  a helper of others (no `build`) is listed too; viewer/src/species.js skips it. */
export function speciesFiles(library = libraryRoot()) {
  let dir, names;
  try {
    // by its REAL path: the page names a module by its URL, and one species reached through a
    // symlink and through its real path would be two copies of it
    dir = fs.realpathSync(speciesDir(library));
    names = fs.readdirSync(dir).filter(n => n.endsWith(".js")).map(n => n.slice(0, -3)).sort();
  } catch { return []; }
  let order = [];
  try { order = JSON.parse(fs.readFileSync(path.join(dir, "order.json"), "utf8")); } catch {}
  const listed = order.filter(n => names.includes(n));
  return [...listed, ...names.filter(n => !listed.includes(n))].map(n => path.join(dir, `${n}.js`));
}

/** The real path of data/<parts>: a library name in the library, anything else in the project. */
export function dataPath(...parts) {
  if (!parts.length) return projectFolder();
  if (LIBRARY_NAMES.has(parts[0])) return path.join(libraryRoot(), ...parts);
  return path.join(projectFolder(), ...parts);
}

const partsOf = rel => path.normalize(String(rel).replace(/^\/+/, "")).split(path.sep);

/** A path as written ("data/designs/x.json", "assets/objects/x.glb", "review/…") → a real path.
 *  assets/ is the library's; review/ the project's — what was drawn and looked at for ITS designs. */
export function resolvePath(rel) {
  const parts = partsOf(rel);
  if (parts[0] === "data") return dataPath(...parts.slice(1));
  if (LIBRARY_ROOTS.has(parts[0])) return path.join(libraryRoot(), ...parts);
  if (parts[0] === "review" && activeProject()) return path.join(projectFolder(), ...parts);
  return path.join(ROOT, ...parts);
}

/** The folder a resolved path must stay inside: the library's name or root, or the project —
 *  decided from the path AS WRITTEN, so one that climbs out with ".." lands outside its base
 *  (decided after normalising, the base would follow the path wherever it climbs to). */
export function dataBase(rel) {
  const parts = String(rel).replace(/^\/+/, "").split("/");
  if (parts[0] === "data") return LIBRARY_NAMES.has(parts[1]) ? libraryRoot() : projectFolder();
  if (LIBRARY_ROOTS.has(parts[0])) return path.join(libraryRoot(), parts[0]);
  return path.join(ROOT, parts[0]);
}
