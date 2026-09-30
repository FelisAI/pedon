# Designing the garden — you, in the conversation

**This is the default. You design.** Not by writing a brief for a subprocess: by
emitting ops yourself, looking at what they made, and adjusting — in conversation,
while the owner is talking to you. Every tool measures, shows, calculates what you ask,
or refuses the physically impossible; none of them decides anything about the garden
(`docs/tools.md` — "Who decides what").

Use tool calls to look and design while keeping the conversation with the owner
open. Preserve their intent when interpreting a brief: a less usable strip by a
retaining wall does not imply that the hardscape is untouchable. An invented
constraint can leave planting confined to paving and block a workable design.

---

## The process, in order

World-class landscape design comes from a process, not a list of warnings. What makes a
website good is not a list of warnings: it is a sequence — the idea and the hierarchy first,
a small design system (a type scale, a few colour tokens, one spacing
unit), then components, then polish judged on the rendered page. The same sequence supports
garden design:

| design concern | process requirement |
| --- | --- |
| a coherent composition | revise the owner's design, or build round one stated idea, such as a dry-meadow walk, and review repeatedly from their cameras |
| broad uniform masses, scattered plants, mechanical layouts or road-like paths | establish an idea and judge it visually; numbers alone cannot establish design quality |
| colour that matches the owner's intent | agree colour, then look at it; render colourfulness can rise from 23.4 to 24.1 while the scheme loses the desired colour, and bloom readings do not establish preference, so there is no colour score |
| winter interest | inspect every season explicitly; a naturalistic design can have nothing in flower in winter |

So, in this order — each step points at the section that holds its detail:

1. **Read.** The ground (`site_plan`, `zones`, the loop below), the owner's current design and
   words, who uses the garden — children, pets (whether cats have the run of it is the site's
   policy, `project.json`; a plant's `cat_safe` says what is known). Start from their version when they name one.
2. **The idea, before any geometry.** One sentence a visitor would recognise from the door; the
   experience walked through ("Ask for the experience before the geometry"); a named PRECEDENT
   and what is taken from it (below); a COLOUR CONCEPT — the body's hue families, the accent,
   the neutral that separates them — and what each SEASON does. **Say these to the owner before
   detailing** when they are in the conversation: an idea is cheap to change and a planted bed is
   not. The colour scheme belongs to the owner; support rich, painterly colour when requested.
3. **Structure first.** Spaces, the one main place, the route and what it passes, grade,
   levels, paving that is quiet ("One main place", "Grade decides use", "Shape"). In a
   planting-only revision the structure is the owner's and stays.
4. **A small design system.** A garden reads as designed for the reason a page does: few
   tokens, repeated. A palette BY ROLE — a few structure plants repeated at intervals, a
   seasonal theme woven through, a ground layer of several knitted species covering most of the
   rest, and a few specimens (Rainer & West's layers; "Plant a community"); how much of each is a
   judgement you can say a reason for, never a quota ("Put no numbers where a shape belongs").
   One hard material and one soft. Two or three colour
   families plus a neutral, and one complementary accent. A plant list that is not a palette is
   a nursery order.
5. **Compose at full size.** Draw the masses; `compose` fills them; spacing is yours ("Spacing
   is yours", "Design at FULL maturity").
6. **Look, and critique like a designer** — from the owner's cameras, after every round ("Look at
   what you built"). Answer each, from the pictures: *Is the idea legible from the door? Is there
   one dominant thing, a few subordinate, many quiet? Does something repeat along the walk as a
   rhythm? Do forms contrast — spike against mound against grass against mat — and textures,
   fine against coarse? Does a crisp edge (paving, a clipped form, a stone) sit against the loose
   planting, so wildness reads as meant (Nassauer's "cues to care")? Is something hidden until
   you round it? Is every patch of ground covered or designed open? Does any view read as a sea
   or a scatter?* Then read `character` — including `the_year` — as evidence, not a score.
7. **The year.** `composition` → `character` → `the_year`: per season, the share of the
   planting in flower and its colours, and the evergreen share. Each season should have
   something you can name; winter is held by evergreen structure, seedheads, bark and stone.
8. **Refine one composition** until the critique holds; hand the owner only what is theirs to decide.

**Precedents** — knowledge to reason with, not a style to copy. For a dry, sloped,
Mediterranean-climate garden: Beth Chatto's Gravel Garden (emergents rising through low mats on
open gravel, no irrigation); Piet Oudolf's planting at Hummelo and the Lurie Garden (structure
plants repeated through a matrix; seedheads and grasses carry winter); Ron Lutsko's and Bernard
Trainor's California gardens (restraint, a few big gestures, native meadow against stone, the
view out); Monet at Giverny (colour laid in masses, complementary contrasts — orange against
violet-blue); Gertrude Jekyll's borders (colour graded along a walk, cool at the ends and warm at
the heart, grey foliage and white between colours that would quarrel); Japanese gardens (hide
and reveal, borrowed view, stone in odd, unequal groups). Name the one you use and what you take.

## Start from the owner's current version

When the owner names a starting design, read that saved file AND the live working
file. Preserve their contents before editing; a saved plant list is a design, not
proof of stock on hand. For a scoped revision, record the allowed changes and
the exact outside records to preserve, including the tree and stones. Never
recover a tree's position from an old note when the owner has edited it since.

**Name the variation before its first edit.** Use the existing Save as workflow
to make an exact copy, then verify that the viewer is editing that copy. A proposal
left under the source's name invites an ordinary Save to overwrite the source.
All subsequent geometry changes still go through checked `/api/ops`.

Keep a short checkpoint in the task's review folder: source snapshot and hash,
active variant, completed/saved variants, current camera arguments, last inspected
view IDs, unresolved visual issue and next operation. Update it after saving a
variant. After a crash or interruption, compare the current saved source and live
document with the checkpoint before replaying anything. Preserve new owner edits
and unsaved work; resolve a genuine conflict in intent instead of silently choosing
an older snapshot.

## The loop

```bash
# 1. ASK THE GROUND. Never estimate what you can measure.
python3 tools/site_plan.py --out review/TASK/site.png   # the site in plan: grade, contours, grid
python3 tools/site_api.py zones
python3 tools/site_api.py usable-area --zone south_yard
python3 tools/site_api.py slope-many '[[12,-6],[14,-6],[16,-6]]'
python3 tools/site_api.py best-bench 12 -12 17 6 --across 4 --along 6

# 2. DRY RUN. Writes nothing, runs the real validators.
python3 tools/site_api.py check-ops '[{"tool":"set_patio","input":{...}}]'

# 3. APPLY. All-or-nothing. --design keeps it on your variant, not the owner's working file.
python3 tools/site_api.py apply-ops '[...]' --design data/designs/VARIANT.json

# 4. LOOK — at what you changed, through the logged tool, and OPEN the image it saves.
python3 tools/view_mcp.py preview_design '{"path":"data/designs/VARIANT.json"}'
python3 tools/view_mcp.py look '{"eye":[13,-14,1.65],"look_at":[13.5,-10,0.5]}' --output-dir review/TASK --name from-the-bench
#    (a height in eye/look_at is ABOVE the ground there; --name keeps the image in the review folder)

# 5. CHECK you looked at every change, since your last apply-ops (the agent's gate).
python3 tools/look_check.py check --before START.json --after data/designs/VARIANT.json --since MARK
#    (MARK from `python3 tools/look_check.py mark` when you started; exit 1 names what you missed)
```

`check-ops` and `apply-ops` run `agent.execute()` + `validate()` — the identical
path a hand drag in the viewer takes, with the identical hard rejections. You
are not working around the safety rails; you are inside them.

**Iterate small.** One op, look, adjust beats a twelve-op batch you have to
untangle. Designing in conversation lets the owner clarify the viewpoint while
you move one plant and re-render inside a minute.

Change only the affected plants. Preserve all other IDs and records; removing and
re-placing a whole bed for a small adjustment adds work and makes the comparison
harder to audit. After a dry run, inspect the returned conflicts before applying
the batch. A report printed immediately before an unconditional apply is not a
decision. Reuse verified camera arguments and measured ground for unchanged
geometry; refresh the measurements when the footprint, route or level changes.
MCP argument examples live in [docs/site.md](docs/site.md#verified-mcp-call-shapes).

## Look at what you built, from where the owner stands

Visual defects require looking: an ugly long path or a mechanical arrangement can
measure correctly. **Measuring correctly is not the bar.**

The design agent cannot finish until every place it changed sits in the middle of a
view it took after its last edit. Hold yourself to the same rule with
`tools/look_check.py` (step 5 above) — it is the agent's gate, from the same functions.
A correlation coefficient cannot establish that a bed visibly improves. Inspect
the changed bed before reporting visual progress.

A bed has a front and a back **only because a person has a position.** Before
planting anything, decide where it is seen from:

- from a seat, at **1.15 m** — a lantern 1.5 m in front of the sitter's face can
  obstruct the seated view without obstructing the view from above the same spot
- through a threshold — a moon gate's whole job is to frame something, and whether
  it does cannot be seen from beside it
- from the house, uphill — a raking view where the TOP SURFACE of the planting is
  the entire picture and nothing at the base of a plant will ever be seen

**A saved camera can outlive the walk it was saved from.** `list_viewpoints` says, for each of
the owner's views and against the design you name, where it STANDS (on a walk, raised at a window
or deck, or inside a bed where nobody stands) and which beds FILL the middle of its frame. Judge a
bed from a view whose `frames` names it; where none does, stand on the bed's own walk at eye height
and aim at it — `look` with `eye` on the walk. A sheet of the owner's cameras that frames the bed
next door is a picture of the wrong garden. The look gate's suggested cameras stand on the
design's walks and patios for the same reason.

**A render must lead to a visual judgement.** Rendering alone does not establish
quality. For each small-bed study, use the same house view and a ground-level
approach view that actually includes the changed planting. Preserve
owner cameras; a temporary review camera is not a new owner viewpoint.

After each image, name a concrete observation and the revision it calls for, or
why the composition holds. Look for equal-sized clumps, straight strips, isolated
islands, accidental bare channels and taller plants hiding the intended flowers.
Distinguish a deliberate quiet space from an unfinished connection. Re-render
after the final geometry edit and associate the image with that saved document's
hash; a picture of an earlier draft is not final verification. A failed render
or a numeric ground-contact result is not visual evidence.

**Naming a flaw is not the end of it — fix it, and look again.** A terrace that reads as a large
blank paved disc needs resizing before you finish. A flaw you can name and can fix is yours to
fix; hand the owner only what is genuinely theirs to decide — a use they have not stated, a
plant they may already own, a budget, a boundary you cannot see.

**One main place, and few others.** A garden reads as designed when it has a hierarchy: one
place you go to and stay, perhaps one or two smaller stopping points, joined by one path in one
family of materials. Every extra paved island dilutes it: a door shelf, a lookout, a south
court and path pieces can read as fragments instead of a garden with a heart.

**In a naturalistic garden the paving is quiet.** Use one hard material for the places you stop
and a softer one for the way through — gravel, decomposed granite, stepping stones set in the
planting — and keep a walk no wider than it needs to be (about a metre). A 1.15 m flagstone
walk joining two flagstone pads can make the stone outweigh the planting from the house.

**Size paving to what happens on it.** A bench for two wants a few square metres; a table for
four with its chairs pulled out wants about three metres by three. Paving much bigger than its
use reads as an empty disc, and every square metre of it is a square metre of garden that is not.

**The view out of the door is the design's first impression.** Everything in that frame is part
of the design — raw ground left beside the walk in the first view reads as unfinished, however
good the rest is.

These are design judgements, not additional hard validators. Keep the owner's
verdict separate from your recommendation: a designer's preference does not mean
the owner approves it. Do not label a proposal an award winner, or its process an
established quality improvement, without evidence.

## Ask for the experience before the geometry

Before a single op, answer in a sentence each: what you see stepping out of the
door; where you are going and what you pass; where you stop and what you are
looking AT; what is hidden until you round something; what the garden is doing in
February. Then draw geometry that SERVES those answers. Describe a patio's purpose
through its experience: a tea court with one bench, a lantern and a long view back
uphill gives more direction than `"sitting"`.

A path bends because it is going round something worth going round. A bed is that
shape because of what it is hiding or framing. A path drawn to connect two points
by the shortest legal route reads as a road.

## Put no numbers where a shape belongs

Even reference figures such as `17.0% hard / 1.16 m² per plant` can encourage optimising
the measurable half and neglecting the half with no metric: a design with 24.6% hardscape
and 1.12 m² per plant can still have a road-like path. `composition` and `scene` are for pulling
mid-design, never specs to design against. This applies to you talking to yourself
as much as to a brief.

## The op vocabulary

| op | what it is |
| --- | --- |
| `set_path {id, spline, width_m, material, level_m}` | a walkway; 4-8 points let it bend. Widths 0.5-3.0 m, main walks ~1.0-1.2 |
| `set_patio {id, polygon, material, purpose, level_m}` | a USABLE AREA — a level pad a person occupies. Write `purpose` as intent |
| `upsert_bed {id, polygon, mulch, level_m}` | a bed; 8-14 vertices |
| `set_edge {id, spline, height_m, edge_material, retains, level_m}` | edging or a retaining line; `retains` names the side it holds |
| `set_steps {id, spline, width_m, riser_m, going_m}` | the only thing that gets a route down ground too steep to walk |
| `place_plants {plants:[{species, common, position, mature_height_m, mature_spread_m, form?, foliage?, asset?}]}` | planting — ADDS, always with a new id. `asset` draws it with a plant MODEL |
| `set_plants {plants:[{id, species, common, position, ...}]}` | CHANGES a plant already there — moved or re-specified — and keeps its id |
| `place_object {id, kind, position, height_m, ...}` | **`kind` and `material` are FREE TEXT**; `model` names a file from the object library — `find_asset` / `fetch_asset` / `make_asset` get you one |
| `remove_objects {ids}` | deletes |

**An object the library cannot draw is a model to GET, not a placeholder**:
`python3 tools/view_mcp.py find_asset '{"query":"stone lantern"}'`, then `fetch_asset` the
Poly Haven id that fits or `make_asset` a Blender script at real size — each returns a
picture; look at it before placing with `{kind, model}`. The placeholder box is only for
when both fail. `docs/objects-and-surfaces.md` has the details.

**A plant the viewer draws wrong is a model to get, too**. When a look shows a
species as something it is not — sulfur buckwheat as orange balls, an olive as a dark
conifer — `find_asset {"query": ..., "plant": true}`, then `fetch_asset {id, species}` or
`make_asset {name, script, size_m, species}` built at its mature size from what the plant
really looks like. Look at the picture; then give those plants `"asset": <the returned
name>` (`set_plants` keeps their ids). `docs/plants.md`.

**Compose planting and structure together within the requested scope.** Paths,
edges and objects can establish a garden's character. In a planting-only revision,
plant masses, height, colour and open ground carry the composition. Adding an
ornament is not a substitute for arranging those well.

**Revising a plant is `set_plants`, never remove + place.** `place_plants` ALWAYS
mints a fresh id and discards any id you give it, so re-placing a plant to move it
leaves you with two — and removing it first drops it out of the owner's groups.
`set_plants` replaces the named plant's whole record and keeps its id, so give
every field you want it to keep.

## Shape

This is a garden, not a car park. Bed outlines are curves — 8-14 vertices with
UNEVEN spacing so the edge swells and narrows, and neighbouring beds share a
flowing line rather than sitting as separate boxes. Walks bend. Nothing is an
axis-aligned rectangle unless it is genuinely built. **A four-vertex bed is the
single most common way a design ends up looking machine-made; treat four vertices
as a bug in your own output.**

## Grade decides use, and flat ground is scarce

| grade | what it is for |
| --- | --- |
| under ~9° | the flattest ground there is. **RESERVE IT** for a usable area. Filling your flattest ground with planting is the most common way a sloped garden ends up with nowhere to be |
| 9-18° | circulation and terraced planting. A 0.4-0.9 m wall across the contour manufactures a level pad out of ground that was useless |
| over 18° | leave it as slope and PLANT it — massed shrubs hold soil and need no access |

But gentle ground is where terracing is **cheapest**, not where building is
**allowed**: on a steep site only a few square metres may be naturally gentle, and a
design confined to them could have no terrace at all. `set_patio` exists to reserve flat
ground by MAKING it; `best-bench` and `check-pad` price the earthwork.

**Levels and contours.** A path is draped over the ground unless you pass
`level_m`. If you are cutting a bench, pass it on the path, on every bed on that
bench, AND on the retaining edge — a terrace whose walk is level but whose beds
follow the old slope is not a terrace. And a level bench only stays level along
the CONTOUR; the fall is rarely axis-aligned, so a bench drawn along constant x
can still drop along its own length and get rejected for cut/fill. Each zone reports
its contour bearing.

## Plant a community, not a collection

Planting reads as random when each shrub stands alone on mulch with a small ring of flowers
at its foot, clusters of two or three alternate species along the path, and bare ground fills
the rest. That is garnish, not planting. Individual placements do not make a community.
World-class naturalistic planting (Oudolf; Chatto's dry garden; Rainer & West,
*Planting in a Post-Wild World*) is built the other way round, in layers:

1. **The ground layer first — a matrix.** Low, spreading or clumping plants that COVER the soil
   at maturity, knitting into one another across most of the bed: thyme, creeping rosemary,
   buckwheat, low sedges and fescues, spreading sages. It covers most of the ground — as
   SEVERAL low species knitted together, not one species laid as a carpet (see "A sea is one
   plant, big and low" below). Bare mulch between plants is unfinished, unless you have drawn a gravel clearing
   on purpose and can say why it is there.
2. **Structure: a few large, simple groups.** The shrubs and the one or two trees, in odd-
   numbered groups sized to the space — a grove, a mass that screens, a pair framing the
   path — never spread evenly one by one.
3. **The seasonal theme, woven through.** The flowering and upright plants in drifts that run
   INTO the matrix and bleed at their edges — scattered emergents rising out of it, not neat
   islands sitting on top.

**Check the ground layer from the owner's cameras, not from a number.** At full maturity a bed
should show plants, not gravel, wherever you have not drawn open ground on purpose. The right
species in the right proportions can still leave sage mounds and thyme dots on gravel: the
matrix can be too sparse to close. If a view shows gravel between plants in a bed, add ground
layer there until it does not.

**A path edge is not a border strip.** One species run along the whole edge of a walk reads as
municipal edging. Let the drifts meet the path in irregular lengths: a mat spilling for three
metres, a grass leaning over for two, then a sage mass that comes right to the edge. The edge
should change as you walk it.

**Open ground is a surface you choose, not ground you left.** A dry garden of drifts on open
ground is a real idea — but the open ground has to be DESIGNED: draw it as a bed of gravel with
no plants in it, or as a meadow, and say what it is for. A garden of drifts on an open slope
with 38% of the zone left as raw site ground reads as unfinished from the door and on site.

**Every edge ends somewhere designed.** Where paving meets the site, planting wraps it. A
terrace whose downhill rim sits on raw ground, with nothing between it and the fence, reads as
unfinished from the far side. Take the planting to the boundary, or say why that ground is
left open.

Repeat species from bed to bed so the whole garden reads as one place — but in groups, not in
fields: repetition is the same few plants turning up again, not one plant covering everything. A second spelling of the same plant is not a second
species. Before you finish, look at the planting in `plan` (MCP) or `tools/site_plan.py`, and
from the owner's cameras: if you see dots and rings on bare ground, you have placed plants,
not planted a garden. `compose_planting` / `tools/compose.py` spreads the count you choose
through the shape you draw, and saves you writing coordinates one by one.

**A sea is one plant, big and low.** Large, low masses of one species can lack character.
Example readings from `composition`'s `character` show the difference between a mixed
planting reference and designs dominated by uniform masses:

| | mixed planting reference | broad low masses | larger uniform masses |
| --- | --- | --- | --- |
| species | 21 | 9-14 | 7-9 |
| biggest touching mass of ONE species | 7 | 10-15 | 28-35 |
| plants 0.9 m or taller | 36% | 13-20% | 6-29% |
| low mats | 10% | 32-50% | 13-28% |

In a garden seen from its own paths at a few metres, character can come from MANY species in
small groups and from HEIGHT: a third of the plants upright — spikes (salvias), grasses
standing and leaning, a tree — rising out of a low mixed layer, and no one plant covering a
stretch of ground by itself. Before you finish, read `character` in `composition` and look
from the owner's cameras: a mass of one plant bigger than the eye takes in at a glance, or a
garden that is mostly knee-high, is the sea. These readings support visual judgement; they are
not a rule to design to.

## Repetition, and colour

**Draw the masses before choosing individual coordinates.** Describe the main
planting gesture from the chosen view, its smaller echoes, the low connection
between them and the open space that gives them room. Sketch their footprints in
metres, then place the plants within those shapes. A cluster can widen, narrow and
turn; repeated plants need not become a line, and neighbouring groups need not
be identical islands. This is a compositional method, not a quota of groups.

For variations of a liked design, first hold its palette and quantities constant
and change the arrangement. That makes the design difference visible and avoids
turning an arrangement request into a new plant list. It is a starting experiment,
not a permanent restriction: explain when a new plant, removal or layout change
serves a specific visual need. Develop and critique one clear composition before
multiplying it into alternatives with different names.

A naturalism brief can ask for coherent planting with natural clustering, mostly
from plants already owned, with new choices drought-tolerant and non-toxic.
When exact varieties are not supplied, reuse the existing design's
plant types for visual studies without calling them verified inventory or asking
for the names repeatedly. Unknown stock counts remain unknown; a species recorded
as owned does not establish the number of pots available. Existing unverified
safety does not become verified through reuse. New purchases still need the
evidence described in [docs/plants.md](docs/plants.md).

**What the owner has is a file: `data/owned_plants.json`** (the site's own). `catalogue` holds the
catalogue names, and the owner adds to it with ☆ mine in the Add library, so read it when a design
starts — it can grow between sessions. A plant on it is one they have, not a count of how many.

Plant in drifts and masses, and repeat a few signature species across several beds
so the eye connects them. A species used ONCE is a specimen, and a garden holds a
few of those, not a bed full. **If your plant list has almost as many species as
plants, you have written a nursery order.** How many species that means is yours
to decide — it is a reason, never a quota.

**Draw the masses; `tools/compose.py` does the arithmetic inside them.** Give each drift a
species, a count and an ellipse — centre, length, width, turn — and it spreads that many
plants evenly THROUGH the shape, keeps them off paths, patios and stones, and plants drifts you
drew overlapping through each other. It never chooses for you: the count is yours (it reports
how far apart they stand on centre, as a share of their mature spread, and how many would sit
one spread apart), no plant leaves the outline you drew, and nothing re-places a drift
afterwards. Where drifts meet — or run through each other — is where you drew them: nothing
carves a seam between two shapes drawn overlapping, so draw them APART where you want a
seam, and overlapping only where you mean one plant to grow through another. The report's bed
readings (`own_kind_nearest`, `crowns_at_one_height`) show it before you apply: an own-kind
reading of 0.30 can coexist with 37 crowns growing into each other. Inspect both readings. Beds
can be drawn rough over a walk or terrace and are trimmed to its edge. It reports each bed's
mature coverage — the validator's reading — BEFORE you apply, and `--plan` draws the result
on the site plan. Shapes and counts are design decisions, never chosen by formula.
As tools — for the spawned agent and any MCP session — the same two are `plan`
(the design in plan, at mature spread, with a grid) and
`compose_planting` (the arithmetic, returned as ops you send yourself).

**Spacing is yours.** Nothing sets how close plants stand but you. The validator refuses only
what cannot be planted: two plants in one planting hole (stems under 10 cm apart) and a plant in
a tree's trunk (within 0.25 m of its stem). A spacing formula would flag deliberate placements,
including plants the owner moved by hand, so none may override the owner's design
judgement. What a planting designer knows, to reason with rather than obey:

- **On centre, as a share of mature spread** (`compose` reports `on_centre_of_spread`): at about
  1.0 the crowns just touch at full size; 0.7-0.9 knits a drift into one mass; well under that,
  plants of one height grow into each other and some will have to come out — unless it is a
  carpet meant to read as one sheet. Decide for FULL size (below).
- **A drift reads as a drift** when its members sit nearer each other than their neighbours; the
  seam to a different plant OF THE SAME HEIGHT is what keeps it legible.
- **Layers knit.** A low plant can run up to and under a see-through grass or spike (muhly, deer
  grass, gaura, salvia spikes); it stops at the edge of a dense mound, whose shade it cannot live in.
  A tree's crown is overhead: plant under it to the trunk's foot, in dry shade if it is evergreen.

Then read what you made — `composition` → `character`, measured, never judged:
`crowns_overlapping` names different plants half inside each other at one height (example
readings: 0-2 pairs in visually preferred designs, 31 in a crowded design), and `own_kind_nearest`
is the share of plants whose nearest neighbour is their own kind (0.64-0.79 in the reference designs;
the same designs with species dealt at random: 0.06-0.26 — a scatter). Above ~0.3 it is NOT a
score: grouping measures can run against the owner's preferences, and an intermingled matrix
planting reads low on purpose.
A bed that still shows mulch at maturity is usually under-counted, not blocked: read its
`mature_coverage` and add ground layer until it closes. Use `own_kind_nearest` and the view
to identify a scatter.

A sampler that chooses the nearest free point can preserve distances while destroying the
intended shape. When a group conflicts with its surroundings, revise the group deliberately and
look again. Do not silently scatter its members into whatever gaps remain.

**Blocks read as bulky; break them like for like**. Slabs of five to seven of one flower can
dominate a composition (example own-kind-nearest: 0.82, above the 0.64-0.79 of the reference
designs). Keep what already works — the grasses, say — while breaking up the flower blocks. Breaking a
slab keeps the positions and swaps members for plants of the SAME size and habit and colour
family: spikes (Mystic Spires, Caradonna, penstemon) interlace at a slab's 0.3 m spacing and low
mats knit, but a woody mound put in a perennial's spot smothers it — a Coahuila sage substitution
can leave 26 crowns overlapping. Keep the colour structure, such as pinks by a manzanita.
Repetition across the whole garden is a separate concern: 13-17 of each of the same few species
can feel repetitive even without large blocks. Count the list as well as the blocks.

**Colour is designed, and it is the owner's.** Lay it in masses, not dots — a drift of one
colour reads across the garden where a dozen colours in ones read as confetti. A complementary
accent makes the body sing: orange poppies in a violet-blue field, as Monet did. Cool and pale colours recede,
so they lengthen a view when set far; warm and bright ones come forward. Silver foliage and white
flowers sit between colours that would clash. Agree the scheme with the owner at step 2, check
`the_year`'s colours per season, and judge it from their cameras — no number establishes their
colour preference (the process table above).

**The renderer's colours.** Colour comes from growth FORM, so every species sharing a form is drawn from one
narrow ramp — `mound`, often half of a palette, is a ramp 5.7% of the colour cube
wide, so a silver lavender and a glossy dark toyon come out the same green.
Declare `foliage` on anything not simply green. At garden distance colour is most
of what separates two shrubs of the same silhouette.

## Then check the four things a validator cannot

Inspect all of these by eye:

- a wall with `level_m: null` retains NOTHING — it is decoration
- a barrier standing in an area the owner DREW
- a retaining line whose declared top is BELOW the ground for part of its run
- long and continuous where short and broken is wanted: set stone is an asymmetric
  group of odd number, not a 6 m line

## Before you extend a bed onto new ground

Make both checks before extending the bed.

**Profile across it and look for a STEP.** "Not inside the house footprint" is the
only ground check the validator makes, and it answers a different question. A
site can have retaining walls that nothing in the system knows about — they are in
the scan as geometry and nothing extracts them. A bed extended onto new ground can
pass the footprint check yet sit over a wall whose face drops **nearly 2 m in a
single step**, with the pad above it well above the bank. `site_api profile` across
the direction you want to grow; a metre of fall in a fifth of a metre is a wall.
`profile` reads a 1 m grid, which shows a 1.9 m wall and cannot show a 0.2 m timber —
for anything that small, `view_mcp.py scan_profile` raycasts the mesh itself every
5 cm and lists the steps (`docs/site.md`).
To find the foot of a bank, profile down its fall and take the point where the
grade eases under about 35° as its base.

**Ask whose left.** An instruction about the left or right of a bed is about the
owner's body, not the compass. Establish where they stand — `site_api near`, the
patio positions, which side the path arrives from — before acting on it.

## Design at FULL maturity

Spacing and density are decided for the plants at FULL size, never for the look at a
few years. Planting that looks finished at ~5 years can reach mature canopy coverage
of 2.15× or 2.50× the ground area and look crowded. `look` and `walk_through` render
mature, full-detail planting independently of Fast preview.
Check the viewer's actual growth/detail controls rather than assuming its state.
Young planting can look sparse even when mature spacing is appropriate.

`composition` reports `mature_coverage_by_bed`, and check-ops warns when a bed reaches
1.6× at full maturity. Its coverage bands describe potential density, not a target
or a score for design quality. Summed mature canopy area does not describe the
distribution of gaps: a bed can contain both crowded clumps and bare channels.
Inspect where the ground remains open and explain intentional space. Leave room
for young plants to grow rather than adding plants only to satisfy a number.

## Set stone is composed, not scattered

An algorithm that walks a line dropping clusters produces a random-looking scatter.
Stone goes in **odd-numbered groups of unequal size** — one dominant, one
subordinate, one low — set close enough to read as a single outcrop, and placed
INSIDE the planting rather than along its edge,
with plants allowed to touch them. A stone the planting avoids reads as decoration
sitting on gravel.

On a slope stone earns its place twice: a crescent through the DOWNHILL half of a
tree's root zone holds the soil pocket where soil actually leaves. Stabilise that
half of the root zone rather than enclosing the whole tree.

## Delegation

You design in the conversation by default. `tools/agent.py --explore` is an
option for an explicitly delegated whole-yard exploration; follow the active
session's delegation rules and [docs/design-agent.md](docs/design-agent.md).
Do not restart a different provider to repeat work this session can inspect.
