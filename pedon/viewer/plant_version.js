// The version of what generates a plant, for the Fast plants the browser keeps.
// A module of its own so a test can run it on a copy of the tree (tests/js/plant_store.test.mjs).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { libraryRoot, speciesFiles } from "./project_paths.js";

/**
 * THE VERSION OF WHAT GENERATES A PLANT: plants.js and every module it imports, the library's
 * species builders and every app module THEY import (`@pedon/…`), the three.js and
 * meshoptimizer it runs on, and the texture files it reads. A generated Fast
 * model kept in the browser is good for exactly this version. Narrower than /api/plant-build's
 * `build` on purpose — that hashes every viewer file, so a change to a menu would throw away
 * every kept plant and cost the next load its whole generation again.
 */
export function plantCodeVersion(repoRoot, library = libraryRoot()) {
  const h = crypto.createHash("sha1"), src = path.join(repoRoot, "viewer", "src");
  const species = speciesFiles(library);
  const seen = new Set(), todo = [path.join(src, "plants.js"), ...species];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f) || !fs.existsSync(f)) continue;
    seen.add(f);
    const text = fs.readFileSync(f, "utf8");
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+|@pedon\/[^"']+)["']/g))
      todo.push(m[1].startsWith("@pedon/") ? path.join(src, m[1].slice(7)) : path.resolve(path.dirname(f), m[1]));
  }
  const label = f => f.startsWith(src + path.sep) ? path.relative(src, f) : `library:${path.relative(library, f)}`;
  for (const f of [...seen].sort()) h.update(label(f)).update(fs.readFileSync(f));
  for (const pkg of ["three", "meshoptimizer"]) {
    try { h.update(pkg + JSON.parse(fs.readFileSync(path.join(repoRoot, "viewer", "node_modules", pkg, "package.json"), "utf8")).version); }
    catch { h.update(pkg + "?"); }
  }
  // the builders' textures (/assets/plants/botanical/*.png, in the library): a changed picture is a
  // changed plant
  const tex = path.join(library, "assets", "plants", "botanical");
  const list = d => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
  const walkTex = d => list(d).sort((x, y) => x.name < y.name ? -1 : 1).forEach(e => {
    const f = path.join(d, e.name);
    if (!e.isDirectory() && /\.(png|jpe?g|webp)$/i.test(e.name)) {
      const st = fs.statSync(f); h.update(`${path.relative(tex, f)}:${st.size}:${st.mtimeMs}`);
    }
  });
  walkTex(tex);
  return h.digest("hex").slice(0, 16);
}
