// WHAT a hidden id was hiding — so view state cannot re-bind to a recycled id.
//
// "Hide this" is stored in the browser, keyed by object id (how the user is looking
// is not a fact about the garden). But `next_id` hands out the LOWEST FREE id, so a
// remove followed by a place — every replant — gives a dead id straight to an
// unrelated new plant. Groups re-bind exactly that way: a hidden group can go from
// 53 Pink muhly to 53 Seaside daisy and quietly hide a different part of the
// garden. This map has the same shape, and Solo writes an entry for EVERY object
// in the design.
//
// So an entry remembers what it hid, and is only honoured while the id still means
// that. Python prunes a group in the file; nothing can prune a browser from there.

/** A short signature of the thing behind an id: null when there is nothing there. */
export function whatIs(found) {
  if (!found?.raw) return null;
  const { kind, raw } = found;
  if (kind === "plant") return `plant:${String(raw.species ?? raw.common ?? "").trim().toLowerCase()}`;
  if (kind === "object") return `object:${String(raw.kind ?? "").trim().toLowerCase()}`;
  return String(kind);
}

/**
 * Which hidden entries apply to THIS design: { hidden: Set<id>, stale: [id] }.
 *   absent here        -> not hidden, entry KEPT (it belongs to another design)
 *   no `what` recorded -> honoured (written before this existed; cannot be judged)
 *   same thing         -> honoured
 *   a DIFFERENT thing  -> not hidden, and reported stale so the caller drops it
 */
export function honoured(view, lookup) {
  const hidden = new Set(), stale = [];
  for (const [id, entry] of Object.entries(view ?? {})) {
    if (!entry?.hidden) continue;
    const now = whatIs(lookup(id));
    if (now === null) continue;
    if (entry.what === undefined || entry.what === now) hidden.add(id);
    else stale.push(id);
  }
  return { hidden, stale };
}

// ── ONE VIEW PER DESIGN ────────────────────────────────────────────────
//
// Each design has its own hide / show and group fold. A view shared across designs
// (two GLOBAL maps, `yt.objectview` and `yt.groupview`) makes another design look
// wrong with parts of it hidden. How the user is looking is not a fact about the
// garden — but it IS a fact about WHICH garden. `upper_bed` and `side_path`
// hidden in one design are, in `variant_a`, the big bed and the main walk,
// and a saved-as design inherits its parent's group ids, so a hidden group follows it
// too. The signatures above cannot see this: a bed called the same thing in
// another design is, by signature, the same thing.
//
// So the store is keyed by design. Everything here is pure; main.js owns the storage.

export const VIEW_STORE_KEY = "yt.view.v2";

/** The scope a design's view state lives under. An unnamed working design — a new
 *  one, or one restored from History — gets a scope of its own rather than a
 *  neighbour's. */
export const viewScopeOf = variant => (variant ? `design:${variant}` : "unsaved");

/** That scope's maps, as fresh objects: { objects: {id: {...}}, groups: {gid: {...}} }. */
export function readViewScope(store, scope) {
  const s = store?.[scope];
  return { objects: JSON.parse(JSON.stringify(s?.objects ?? {})),
           groups: JSON.parse(JSON.stringify(s?.groups ?? {})) };
}

/** `store` with `scope` replaced. An empty scope is REMOVED, so the many saved designs
 *  nobody has hidden anything in cost nothing. Does not mutate. */
export function writeViewScope(store, scope, state) {
  const next = { ...(store ?? {}) };
  const objects = state?.objects ?? {}, groups = state?.groups ?? {};
  if (!Object.keys(objects).length && !Object.keys(groups).length) delete next[scope];
  else next[scope] = { objects, groups };
  return next;
}

/** `store` without `scope` — for a design that has been deleted. */
export function dropViewScope(store, scope) {
  const next = { ...(store ?? {}) };
  delete next[scope];
  return next;
}
