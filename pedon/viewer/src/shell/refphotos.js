// Which photograph of a plant to believe.
//
// `data/refphotos/index.json` holds photographs fetched from Wikimedia, one per
// palette species, and photographs the owner took of plants they have, with
// the sizes they measured.
//
// An owner photograph is strictly better data. A fetched one can be of a
// DIFFERENT SPECIES — a genus-only entry often is, e.g. an
// *Arctostaphylos uva-ursi*, a prostrate mat, standing in for the 2.5 m
// sculptural shrub the palette means (hence `plant_photos.py --audit`). An
// owner photograph cannot be wrong about which plant it is, because the owner
// is standing in front of it.
//
// So an owner row OUTRANKS a fetched one for the same taxon, always. That is the
// whole rule, and it is here rather than inline because BOTH halves read this
// index — compare.html in the browser and plant_photos.py in python. Resolved by
// `byKey[row.species] = row` over Object.values(), it would mean whichever row
// happened to come last: with one row per species that is arbitrary and
// harmless; with two it is a coin toss over which photograph a plant gets
// modelled from.
//
// Pure.

/** An entry the owner photographed themselves. */
export const isOwner = row => row?.source === "owner";

/**
 * The rows for one species, best first.
 *
 * Owner photographs first, then anything scoped to the NAMED species, then a
 * genus proxy — the same ladder `rank_key` uses in python, for the same reason:
 * a title naming only the genus contradicts nothing, but it does not confirm the
 * species either.
 */
export function rowsFor(index, species) {
  const want = String(species ?? "").trim().toLowerCase();
  if (!want) return [];
  const rows = Object.entries(index ?? {})
    .map(([key, row]) => ({ key, ...row }))
    .filter(r => String(r.species ?? "").trim().toLowerCase() === want);
  return rows.sort((a, b) => rank(a) - rank(b));
}

function rank(row) {
  if (isOwner(row)) return 0;
  if (row?.reference_scope === "named_species") return 1;
  if (row?.usable_for_modeling === false) return 4;
  return 2;
}

/** The one photograph to show or model from, or null. */
export function photoFor(index, species) {
  return rowsFor(index, species)[0] ?? null;
}

/**
 * What a row's provenance SAYS, in words a person reads.
 *
 * The distinction matters on screen: "yours, measured" is a promise that the
 * size beside it was measured off the real plant, and a Wikimedia row promises
 * only that somebody photographed the species.
 */
export function provenanceOf(row) {
  if (!row) return null;
  if (isOwner(row)) {
    const size = [row.measured_height_m && `${row.measured_height_m} m tall`,
                  row.measured_spread_m && `${row.measured_spread_m} m across`]
      .filter(Boolean).join(", ");
    return { kind: "owner", label: "your photo",
             detail: [row.where, size && `measured ${size}`, row.photographed_on]
               .filter(Boolean).join(" · ") };
  }
  return { kind: "fetched", label: row.reference_scope === "named_species"
             ? "reference photo" : "reference photo (genus)",
           detail: [row.artist, row.licence].filter(Boolean).join(" · ") };
}

