// THE PLANTS THE OWNER HAS. The Add selector stores and tracks the plants the owner owns.
// A list per SITE — data/owned_plants.json, beside the
// site's designs — never the browser (it would not reach a design session) and never the shared
// catalogue (a species is not owned; a site's owner owns it). Pure: main.js owns the file.
export const OWNED_FILE = "data/owned_plants.json";

/** The species on the list, as a Set. */
export function ownedSet(doc) {
  return new Set(Array.isArray(doc?.catalogue) ? doc.catalogue : []);
}

/** The list with `species` on or off — a new document; everything else in it is kept. */
export function withOwned(doc, species, on) {
  const list = ownedSet(doc);
  if (on) list.add(species); else list.delete(species);
  return { ...(doc ?? {}), catalogue: [...list].sort() };
}
