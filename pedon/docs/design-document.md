# The design document — one write path, and what it carries

`data/design.json` is the live working file. Everything written to it, by hand
or by a model, goes through `execute()` + `validate()`.

## Placing and changing things by hand

You can put a plant down, drag one that is already there, and **substitute**
the species of a selected plant where it stands. All three emit an OP and post it to
`POST /api/ops`, which runs it through the same `agent.execute()` + `validate()` a
model op goes through — never a second write path. So a hand edit on the house, off
the scan, or in another plant's planting hole is REJECTED with the reason,
and every hand edit is undoable through the existing timeline for free.

Plants may carry `size_override: true` alongside `mature_height_m` and
`mature_spread_m`: the designer chose those planning dimensions deliberately.
The inspector's **Apply size** sets it; **Reset to catalogue size** restores the
catalogue dimensions and removes it. Catalogue drift warnings and `resync_palette`
skip deliberate choices. Schema limits, physical validation, mature coverage and
rendering still use the stored dimensions. Moving a plant preserves the flag;
changing species takes the new species' size. Models revising an existing plant
must preserve deliberate sizes unless the owner asks to change them.

That constraint is the whole design: a hand edit that bypasses the validators
allows floating and off-scan geometry, which a user trusts more because they
placed it themselves.

`data/design.json` reaches disk from exactly ONE place in the viewer
(`writeDesignDocument`), and it merges a patch onto a FRESH READ rather than writing a
cached document — a stale whole-file write can silently delete changes made by a
Python tool between polls, such as two flights of steps.
**A merge cannot express "and nothing else", so a whole-document write must pass
`replace`.** Three callers hand over a complete document rather than a few keys —
switching to a saved design, undo/redo, and New design — and a shallow spread leaves
behind any key the new document does not carry, and many saved documents carry no
`objects` or `steps` key at all. Merging one of those documents keeps the
previous design's objects or steps AND writes the hybrid to disk; merging an empty
New design clears no hardscape. `viewer/src/design_doc.js` owns both the merge and
`DESIGN_KINDS`, because the replacement has to iterate the same vocabulary to know
what to clear. A second copy of that list can omit a kind and leave steps
undeletable. `notes` and `style` are REPLACED too: `style` has no readers, so
nothing depends on inheriting it.
Inheriting `notes` labels the garden you switch to with a description of the one
you leave. `version` and `units`
stay inherited — they are facts about the FILE FORMAT rather than about this
garden, so a document arriving without them is missing them rather than
declaring they do not apply.
**COMPARING DESIGNS IS TWO HALVES — `viewer/src/shell/compare.js`.** The
eye on a Designs row ghosts a saved design behind the working one (the visual
half); the same selection drives a table of MEASUREMENTS beside it (the numbers
half): plants, species, mature coverage, ground per plant, planted and paved
area, path length. Coverage is at MATURE size, never the drawn ~5-year scale — it
goes as the SQUARE of growth, so a bed that closes at 1.2x full size renders at
0.59x and reads as thin — and one that looks full at ~5 years is crowded
once grown. It REPORTS and never grades; the test fails if score/better/worse/
rank appear in the module. Row counts come from `/api/designs` cached on
mtime (re-reading every saved design on each poll is a storm); the geometry is computed in the browser
for the two or three being compared, with areas.js's own shoelace.
**TWO PROPOSALS FOR ONE CORNER — `alt_of`.** The user needs to compare alternative
groups for one area of the site, including proposals made by the design agent.
**Hiding cannot do this**: group and object visibility are localStorage and remove
no geometry, so the union still counts: two versions of one bed, both present,
double the plant count and halve the ground per plant. Two consecutive versions are
mostly byte-identical, so ghosting a whole saved design to compare a revision buries
the change in the part that does not move.

A group declares `alt_of: "<set>"`; `alternatives: {"<set>": "<group id>"}` says
which proposal is live. Membership has one home (the groups), the choice has one
home (the map). **This lives in the DOCUMENT while hiding stays in localStorage**,
because which proposal the user is LOOKING at is a view preference and which one the
design CLAIMS is what validate, composition, float_check and the design agent
must all agree on.
**The resolver never touches the write path.** `active_design` DROPS geometry, so
resolving before a write deletes the proposal the user does not choose:
`site_api._design()` returns the document whole (apply-ops and check-ops read
it), `_measured()` resolves (composition, scene, near, area, validate), and in
the browser `currentDesign` stays whole while only the BUILD sees one proposal.
`tools/alternatives.py` and `viewer/src/design_doc.js` are the two homes and are
cross-checked against each other; `tests/test_dry.py` fails on a second copy. An
undeclared choice falls back to the first option — never to showing both. The
objects tree lists every proposal with the losing rows struck through and a
`· N not built` tally, because a count that includes the proposals not built
overstates what stands on the site.

Right-click a multi-selection → **Make this a proposal…**; switch above the
object list.
**A DESIGN SAYS WHERE IT CAME FROM — `from`.** A filename can suggest a chain,
such as `bank_study_v1` → `v2` → `v3`, but it does not declare a parent. Save-as
writes `from`; the Designs list shows it under the counts.

Two rules, and both exist because the wrong answer here is a CONFIDENT one.
`from` is in `REPLACED_KEYS` and Save-as deletes the inherited value before
writing its own — switching copies a whole document into the working file, so
otherwise a design saved from nothing would claim the parent of the design the
user just left. And **nothing is inferred from a name**: designs without a recorded
parent show none, because claiming `bank_study_v2` descends from `bank_study_v1` is
still a guess presented as a fact. The origin is set where the working design is REPLACED
(switch, restore, New), not derived at save time —
restoring from the archive clears `currentVariant` and the design still came from
somewhere.
**OPEN THE ARCHIVE — Designs → History.** `snapshotWorking()` writes a snapshot
of the working design to `data/history/` on every design switch and New design.
An archive grows to hundreds of snapshots, so the viewer exposes `/api/history`
and the user can restore a design without finding its file by hand.

`GET /api/history` lists what is really on disk, newest first, and **collapses
consecutive identical snapshots** — many snapshots repeat the one before, so the raw
list is largely a record of the file being COPIED rather than of the design CHANGING.
The kept row is the oldest of each run, with `repeats` saying how many it stands for. Sorting
happens BEFORE the collapse, or "consecutive duplicates" means whatever was
adjacent alphabetically. A snapshot without a timestamp in its name reports
`stamp: null` and sorts OLDEST: its mtime can come from a checkout, so using it would
invent a date.
**Restoring archives the working design FIRST**, so going back is itself
undoable — a round trip must restore the exact bytes (restore an older version,
then restore back: same md5). `viewer/src/shell/designref.js` owns
`docUrlFor`: a saved design and an archived snapshot live in different
directories, three places resolve one (the ghost, the numbers table, restore),
and separate path logic can let a ghosted snapshot draw on the site while its
comparison column is silently missing. **The kind is carried by the key, never
sniffed from the name**, because `design-20250101-093000`
is a legal thing for the user to type into Save as….
