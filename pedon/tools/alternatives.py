"""TWO PROPOSALS FOR ONE CORNER, IN ONE DESIGN.

The requirement: the model can change one area of the site as a new group and
hide the group it replaces, so two designs for the same place can be compared
easily, using the group concept the design already has.

**Why this is not just hiding.** Hiding is a drawing trick — `yt.groupview` in
the browser's localStorage — and it does not remove geometry. Merge two versions
of the same garden into one document and it still validates and its areas stay
correct, because ground is a union — but **the plant count doubles and the ground
per plant halves**. Counts are where it breaks, and density is one of the
measures a design is judged by.

So the document has to SAY the two are mutually exclusive, and every consumer has
to measure one at a time. That declaration is design INTENT — "this design
carries two proposals for the east corner" — not a viewing preference: which one
the user is currently LOOKING at stays in localStorage; which one the design
CLAIMS lives in the file.

**The shape**, with no duplicated vocabulary:

    "groups": [{"id": "east_gravel",  "name": "gravel court", "members": [...],
                "alt_of": "east_corner"},
               {"id": "east_planted", "name": "planted",      "members": [...],
                "alt_of": "east_corner"}],
    "alternatives": {"east_corner": "east_gravel"}

A group says which SET it belongs to; the map says which member of each set is
chosen. Membership has one home (the groups) and the choice has one home (the
map) — a set that listed its own options would be a second copy of the
membership, and a second copy drifts until an object can no longer be deleted.

**THE WRITE PATH NEVER RESOLVES.** `active_design` drops geometry, so a caller
that resolves and then writes back deletes the alternative the user did not choose.
Measuring and judging resolve; `execute()` and `apply-ops` see the whole
document. `tests/test_alternatives.py` asserts that asymmetry directly, because
it is the one mistake here that loses work.
"""

DESIGN_KEYS = ("beds", "paths", "patios", "plants", "edges", "steps", "objects")


def alternative_sets(design):
    """Every set of mutually exclusive groups: {set_id: [group_id, ...]}.

    In declaration order, which is what makes the default choice below
    deterministic rather than dependent on dict ordering somewhere upstream.
    """
    sets = {}
    for g in (design or {}).get("groups") or []:
        key = g.get("alt_of")
        if not key or not g.get("id"):
            continue
        sets.setdefault(str(key), []).append(str(g["id"]))
    return sets


def chosen(design, set_id):
    """Which group of a set is the current proposal.

    An UNDECLARED choice falls back to the first group declared for that set,
    never to "show them all": a document that names alternatives and forgets to
    choose must still measure as ONE garden, or the fault it exists to prevent
    arrives through the default.
    """
    sets = alternative_sets(design)
    options = sets.get(str(set_id)) or []
    if not options:
        return None
    want = ((design or {}).get("alternatives") or {}).get(str(set_id))
    return str(want) if want in options else options[0]


def inactive_ids(design):
    """Object ids belonging to an alternative that is NOT the current proposal."""
    design = design or {}
    by_id = {str(g.get("id")): g for g in (design.get("groups") or []) if g.get("id")}
    drop = set()
    for set_id, options in alternative_sets(design).items():
        keep = chosen(design, set_id)
        for gid in options:
            if gid == keep:
                continue
            drop.update(str(m) for m in (by_id[gid].get("members") or []))
    # A MEMBER OF BOTH IS KEPT. Sharing an object between two proposals is how a
    # person expresses "the bench stays either way", and dropping it because one
    # of its groups lost would delete the part they agree on.
    keep_ids = set()
    for set_id in alternative_sets(design):
        gid = chosen(design, set_id)
        if gid and gid in by_id:
            keep_ids.update(str(m) for m in (by_id[gid].get("members") or []))
    return drop - keep_ids


def active_design(design):
    """The design as ONE garden: the chosen proposal, the other one removed.

    Returns the document unchanged (not a copy) when it declares no
    alternatives, so the overwhelmingly common case costs nothing.
    """
    if not design or not alternative_sets(design):
        return design
    drop = inactive_ids(design)
    if not drop:
        return design
    out = dict(design)
    for key in DESIGN_KEYS:
        rows = design.get(key)
        if isinstance(rows, list):
            out[key] = [o for o in rows if str((o or {}).get("id")) not in drop]
    # the groups that lost go too, or the tree shows a proposal with no geometry
    out["groups"] = [g for g in (design.get("groups") or [])
                     if not g.get("alt_of") or str(g.get("id")) == chosen(design, g["alt_of"])]
    return out


def describe(design):
    """What a person would be told: each set, its options, and which one is live."""
    out = []
    by_id = {str(g.get("id")): g for g in (design or {}).get("groups") or [] if g.get("id")}
    for set_id, options in alternative_sets(design).items():
        live = chosen(design, set_id)
        out.append({
            "set": set_id,
            "chosen": live,
            "options": [{"id": gid,
                         "name": by_id[gid].get("name") or gid,
                         "objects": len(by_id[gid].get("members") or []),
                         "active": gid == live}
                        for gid in options],
        })
    return out
