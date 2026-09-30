// HOW NODE FINDS WHAT THE LIBRARY'S PLANT CODE IMPORTS — the dev server's twin is the
// `pedon-species` plugin in vite.config.js. A species module lives in the user's library, outside
// the app, and imports two kinds of thing: the app's helpers as `@pedon/<file>` (viewer/src), and
// packages by bare name ("three"). Both resolve exactly as the app's own code would, so there is
// one three.js and one texture loader, shared — a second copy draws nothing it is handed.
// Registered by species_register.mjs; resolve hooks run off the main thread, so the library comes
// in as data.
const SRC = new URL("./src/", import.meta.url);
let library = null;

export async function initialize(data) { library = data?.library ?? null; }

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@pedon/")) return next(new URL(specifier.slice(7), SRC).href, context);
  const parent = context.parentURL ?? "";
  if (library && parent.startsWith(library) && !/^(\.|\/|[a-z][a-z0-9+.-]*:)/i.test(specifier))
    return next(specifier, { ...context, parentURL: new URL("plants.js", SRC).href });
  return next(specifier, context);
}
