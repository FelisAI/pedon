// Markers (landmarks) as things the OWNER can correct.
//
// They are owner ground truth: a model may never invent or derive one, and
// `save-owner` refuses any other writer. None of that says the owner cannot fix
// their own measurement: markers must move. Moving one has to move the WHOLE pin —
// ring, stem, knob and label, not only the mesh under the cursor — it has to show
// that a pin can be grabbed, it has to save without an error, and the moved marker
// has to keep its row in the Places list.
//
// The pure halves live here so they can be tested without a scene.

/** How far above its ground point each part of a pin stands, metres. One owner:
 *  design.js builds the pin from these and the drag moves it with them. */
export const PIN_LIFT = { ring: 0.02, stem: 0.8, knob: 1.6, label: 2.0 };

/**
 * `list` with `lm` saved into it. A marker that already exists KEEPS ITS PLACE in
 * the list — moving one is a correction, not a new marker, and a row that jumps to
 * the bottom of Places reads as one deleted and another added. Does not mutate.
 */
export function upsertLandmark(list, lm) {
  const at = (list ?? []).findIndex(l => l.name === lm.name);
  if (at < 0) return [...(list ?? []), lm];
  return (list ?? []).map((l, i) => (i === at ? lm : l));
}

/** Every scene object that is part of the pin called `name`: [[object, lift], ...]. */
export function pinParts(children, name) {
  // `undefined === undefined`: without this, asking for no pin returns every object
  // that is NOT a pin — the house outline would follow the cursor
  if (name === undefined || name === null) return [];
  return (children ?? [])
    .filter(o => o?.userData && (o.userData.landmark === name || o.userData.landmarkLabel === name))
    .map(o => [o, o.userData.pinLift ?? 0]);
}
