// THE SPECIES BUILDERS ARE THE LIBRARY'S.
//
// A builder that draws one species — its leaf, its flower, its habit, modelled from photographs —
// is made along the way, like a model file, and belongs to whoever made it: it lives in the
// user's LIBRARY (<library>/species/, schema/project_layout.json), never in the app. The app keeps
// the generic generator (plants.js) and the kit builders are made of (imported below), which a
// species module imports as `@pedon/<file>`, and three.js by its own name.
//
// THE CONTRACT — what a module in <library>/species/ exports:
//   build(plant, r, foliageTint, individual) → a THREE.Group, or null for a plant it does not draw.
//     It tests the species before it draws from `r`: drawnByCode asks with an `r` that throws.
//   prepare() → Promise<boolean>, optional: its textures, at the size textureDetail() says.
//   reduce = "stand-ins", optional: Fast draws each part as a stand-in where the builder put it,
//     for a builder of few, cheap parts; without it Fast reduces the built plant (reduceBuilt).
// Asked in the order <library>/species/order.json gives, most specific first; a module with no
// `build` is a helper of others. With no library there are none, and the generic generator draws
// every plant.
//
// Loaded before plants.js can build anything (a top-level await): a plant built before its
// builder arrived would be drawn generic and, in Fast, kept that way in the browser.
// THE KIT: the app's parts a species builder is made of — the app's half of the contract, and the
// ONE list of it. Imported here so each is part of the app whether or not a library uses it.
import "./woody_geometry.js";
import "./translucency.js";
import "./grain.js";
import "./surface_hairs.js";
import "./plant_texture_loader.js";
import "./shoots.js";

const inNode = typeof window === "undefined" && typeof process !== "undefined" && !!process.versions?.node;
const load = spec => import(/* @vite-ignore */ spec);
const nameOf = url => decodeURIComponent(url).split("/").pop().replace(/\.js$/, "");

async function moduleUrls() {
  if (!inNode) {                                   // the dev server lists them (vite.config.js)
    // as FULL URLs: Vite adds `?import` to a dynamic import of a path, so a builder another one
    // imports by its plain path would be TWO modules — a leaf texture registered in one copy,
    // and a species drawn from the other with none
    try {
      const r = await fetch("/api/species", { cache: "no-store" });
      return r.ok ? (await r.json()).map(u => new URL(u, location.href).href) : [];
    } catch { return []; }
  }
  const REGISTER = "../species_register.mjs", PATHS = "../project_paths.js";
  await load(new URL(REGISTER, import.meta.url).href);
  const [{ speciesFiles }, { pathToFileURL }] = await Promise.all(
    [load(new URL(PATHS, import.meta.url).href), load("node:url")]);
  return speciesFiles().map(f => pathToFileURL(f).href);
}

async function loadSpecies() {
  const urls = await moduleUrls();
  // one broken module in someone's library costs that species, not the garden
  const mods = await Promise.all(urls.map(u => load(u).catch(e => {
    console.warn(`[species] ${nameOf(u)} did not load: ${e.message}`);
    return null;
  })));
  return mods.flatMap((m, i) => typeof m?.build === "function"
    ? [Object.freeze({ name: nameOf(urls[i]), build: m.build, prepare: m.prepare, reduce: m.reduce })]
    : []);
}

/** The library's species builders, in the order they are asked: [{ name, build, prepare, reduce }]. */
export const SPECIES = Object.freeze(await loadSpecies());
