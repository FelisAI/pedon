// What a test reads that the APP does not ship: the user's LIBRARY — the plant catalogue, the plant
// and object models, the leaves' textures, the species builders (schema/project_layout.json). Read
// through the resolver the viewer serves them from, never by joining the checkout.
//
// Two kinds of test read it. One is ABOUT the user's library — a species' builder, a model's
// bounds, what the catalogue holds: it is marked `needsLibrary` and skips without one, as a test
// about a real site skips without a site (./site.mjs). The other only needs a catalogue to work
// on — a card, a filter, a search: without a library it reads the FIXTURE one the Python tests
// read (tests/fixtures/library), so it runs on a fresh checkout too.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePath } from "../../../viewer/project_paths.js";

/** The real path of a file as the app names it: "data/plant_palette.json", "/assets/plants/x.glb". */
export const libraryPath = rel => resolvePath(rel);

export const HAS_LIBRARY = fs.existsSync(resolvePath("data/plant_palette.json"));
export const needsLibrary = HAS_LIBRARY ? {} : { skip: "about the user's library: none at $PEDON_LIBRARY or ~/PEDON/library" };

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "library");
const FIXTURE_FILES = { "data/plant_palette.json": "plant_palette.json",
                        "assets/plants/manifest.json": "assets/plants/manifest.json" };

/** A JSON file the app names: the user's library's, or without one the fixture library's. */
export function libraryJson(rel) {
  const file = HAS_LIBRARY ? resolvePath(rel) : path.join(FIXTURE, FIXTURE_FILES[rel] ?? rel);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** The plant catalogue's plants. */
export const catalogue = () => libraryJson("data/plant_palette.json").plants;
/** The plant models the library holds: { name: { file, height_m, spread_m, … } }. */
export const plantManifest = () => libraryJson("assets/plants/manifest.json");
