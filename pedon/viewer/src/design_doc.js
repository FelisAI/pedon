// What a write to data/design.json is allowed to change.
//
// There are two kinds of caller and they want opposite things, which is the
// whole reason this file exists.
//
// A PATCH caller owns a few keys and nothing else. The Group button owns
// `groups`; it must not touch `steps`, because a python tool may have added a
// flight between the last poll and the click. Writing back a cached whole
// document deletes whatever another writer added in between — a flight of
// steps disappears on one click of Group. For that caller, merging onto a
// fresh read is the fix.
//
// A REPLACE caller — switch design, restore, new design — is handing over a
// WHOLE DOCUMENT, and a shallow spread cannot express "and nothing else". A
// saved variant with no `objects` key does not clear the objects on disk, it
// INHERITS them: switching to a design that has no lantern would leave the
// lantern standing and write the hybrid back to design.json, so the
// contamination reaches the disk and not merely the screen. Many saved designs
// carry no `objects`, `steps` or `patios` key — so the leak is the common case
// rather than the corner one, and the panel would report the result as
// `editing "variant_a" — modified, not saved` the instant you switched.

/**
 * The design's own collections: the stored key, and what one of them is called.
 *
 * ONE list. A delete handler with its own hand-typed key list saying
 * beds/paths/patios/plants/edges silently does nothing to a flight of STEPS —
 * a new element kind is only ever forgotten by a copy, and this is the list
 * everything else derives from. `tools/agent.py DESIGN_KEYS` is the
 * python half of the same vocabulary.
 */
export const DESIGN_KINDS = [["paths", "path"], ["edges", "edge"], ["beds", "bed"],
                             ["patios", "patio"], ["plants", "plant"], ["steps", "steps"],
                             ["objects", "object"]];

/**
 * The keys a whole-document write is responsible for clearing.
 *
 * Derived from DESIGN_KINDS so a new element kind cannot be missed here. `groups`
 * rides along without being a kind of its own: it is structure OVER those ids, and
 * groups left behind from another design refer to ids that no longer exist, which
 * is worse than having no groups at all.
 *
 * `notes` and `style` are in here too. `style` is not load-bearing:
 * `design.style` is read by NOTHING — not colourFromPalette, not design.js,
 * not agent.py — so clearing it costs nothing.
 *
 * `notes` is genuinely used and inheriting it is
 * straightforwardly wrong: notes DESCRIBE a design, so carrying them across a
 * switch labels the garden you moved to with a description of the one you left.
 * That is the inherited-object fault told in prose instead of in geometry — the
 * previous design's moon gate left standing, except it is the previous design's
 * sentence left standing, and a stale sentence is harder to notice than a stale
 * lantern.
 *
 * `from` — WHERE THIS DESIGN CAME FROM — is the sharpest case of the same
 * rule. It is a fact about ONE document's origin, so inheriting it is not merely
 * stale, it is a false claim of descent: switch to a design saved from nothing
 * and it would announce the parent of the design you just left. The lineage
 * would be wrong in exactly the direction that makes it look right.
 *
 * `version` and `units` stay inherited on purpose: they are facts about the FILE
 * FORMAT rather than about this garden, and a document that arrives without them
 * is missing them rather than declaring they do not apply.
 */
export const REPLACED_KEYS = [...DESIGN_KINDS.map(([key]) => key), "groups",
                              "notes", "style", "from"];

/**
 * The document to write, given what is on disk RIGHT NOW and what the caller owns.
 *
 * `onDisk` is a fresh read, never a cached snapshot — the re-read is the caller's
 * job and `tests/js/ui_lost_update.test.mjs` asserts it still happens. Pass
 * `replace` when `patch` IS the document rather than a few keys of it.
 */
export function mergeDesignDocument(onDisk, patch, { replace = false } = {}) {
  const next = onDisk ? { ...onDisk, ...patch } : { ...patch };
  if (replace) for (const key of REPLACED_KEYS) if (!(key in patch)) delete next[key];
  return next;
}

// ── TWO PROPOSALS FOR ONE CORNER ──────────────────────────────────
//
// An LLM can redesign one area of the site as a new group and hide the other
// group, so that the user can compare the two designs easily.
//
// Hiding is not enough, and that is the whole reason this exists. Hiding is a
// drawing trick in localStorage; it does not remove geometry, so every count
// still sees both proposals — the plant count doubles and the ground per plant
// halves. The document has to SAY they are mutually exclusive.
//
// That declaration is design INTENT, not a view preference, which is what
// separates it from hide/show: which proposal the user is LOOKING at stays in
// localStorage; which one the design CLAIMS lives in the file.
//
// `tools/alternatives.py` is the python half of this vocabulary and the two are
// cross-checked, the way objects_index.py is checked against node running
// objects.js — a resolver that disagrees across the language boundary would show
// the user one garden and measure another.

/** Every set of mutually exclusive groups, in declaration order. */
export function alternativeSets(design) {
  const sets = new Map();
  for (const g of design?.groups ?? []) {
    if (!g?.alt_of || !g?.id) continue;
    const key = String(g.alt_of);
    if (!sets.has(key)) sets.set(key, []);
    sets.get(key).push(String(g.id));
  }
  return sets;
}

/**
 * Which proposal of a set is live.
 *
 * An undeclared choice falls back to the FIRST group of the set, never to
 * showing both: a document that names alternatives and forgets to choose must
 * still be one garden, or the fault this exists to prevent arrives by default.
 */
export function chosenAlternative(design, setId) {
  const options = alternativeSets(design).get(String(setId)) ?? [];
  if (!options.length) return null;
  const want = design?.alternatives?.[String(setId)];
  return options.includes(String(want)) ? String(want) : options[0];
}

/** Object ids belonging to a proposal that is not the live one. */
export function inactiveIds(design) {
  const byId = new Map((design?.groups ?? []).filter(g => g?.id).map(g => [String(g.id), g]));
  const drop = new Set(), keep = new Set();
  for (const [setId, options] of alternativeSets(design)) {
    const live = chosenAlternative(design, setId);
    for (const gid of options) {
      const into = gid === live ? keep : drop;
      for (const m of byId.get(gid)?.members ?? []) into.add(String(m));
    }
  }
  // AN OBJECT IN BOTH PROPOSALS STAYS. Sharing one is how "the bench is there
  // either way" is expressed, and dropping it because one of its groups lost
  // would delete the part the two proposals agree on.
  for (const id of keep) drop.delete(id);
  return drop;
}

/**
 * The design as ONE garden — for DRAWING and MEASURING only.
 *
 * Never on the way to disk: this removes geometry, so writing the result back
 * deletes the proposal the user did not choose. `writeDesignDocument` takes the whole
 * document; `tests/js/alternatives.test.mjs` asserts that asymmetry.
 */
export function activeDesign(design) {
  if (!design || !alternativeSets(design).size) return design;
  const drop = inactiveIds(design);
  if (!drop.size) return design;
  const out = { ...design };
  for (const [key] of DESIGN_KINDS) {
    if (Array.isArray(design[key]))
      out[key] = design[key].filter(o => !drop.has(String(o?.id)));
  }
  out.groups = (design.groups ?? []).filter(
    g => !g?.alt_of || String(g.id) === chosenAlternative(design, g.alt_of));
  return out;
}
