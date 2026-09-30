// Register the resolve hooks for the library's plant code (species_hooks.mjs), once per process.
// viewer/src/species.js imports this before it loads the library in Node; a test FILE in the
// library imports app modules statically, which Node resolves before any of its code runs, so
// the library's tests are run with it up front: node --import <app>/viewer/species_register.mjs.
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { libraryRealRoot } from "./project_paths.js";

if (!globalThis.__pedonSpeciesHooks) {
  register("./species_hooks.mjs", import.meta.url,
           { data: { library: pathToFileURL(libraryRealRoot() + "/").href } });
  globalThis.__pedonSpeciesHooks = true;
}
