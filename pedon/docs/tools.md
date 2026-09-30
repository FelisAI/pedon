# The tools, and how a capability gets added

## Who decides what — the one table

**The LLM designs. Code measures, shows, calculates what it is asked, and refuses only the
physically impossible.** (See AGENTS.md.) Every tool here is
one of these jobs, and a new one must say which:

| job | tools | what it may do to a design |
| --- | --- | --- |
| MEASURE | `site_api` ground / slope / profile / check-route / check-pad / best-bench / usable-area / zones / near, `scan_profile`, `sun` | nothing — answers questions about the ground |
| SEE | `look`, `walk_through`, `preview_design`, `site_plan.py`, photoreal | nothing — renders what is there |
| CALCULATE ON REQUEST | `compose.py` (spread the plants the LLM counted through the shape it drew; trim a drawn bed to the paving), `planting_plan.py` (drawings of a finished design) | produces ops or drawings from the LLM's decisions; chooses nothing |
| REFUSE | `validate()` inside `execute()` — the physical and code rejections | rejects an op; never edits one |
| REPORT | `composition`, `scene`, `crowding`, every validator warning | nothing — information the LLM may act on |
| DECIDE | the LLM, through ops (`place_plants`, `upsert_bed`, `set_path`, …) | everything a garden is |

What is NOT allowed: code that places, moves, removes or reshapes design content by its own
rules. How close plants stand is the designer's decision; the validator refuses only
two plants in one planting hole or a plant in a tree's trunk (`agent.one_hole`), and
`composition` measures the rest. `replant.py`
holds only point/segment geometry.

Decide WHO a tool is for before deciding its shape: a bare CLI is the weakest
useful form, and the person designing will not type one.

**`claude -p` HAS TOOLS, so a prompt built from documentation is NOT INERT.**
Anything spawning it for a STRING must pass `--allowedTools ""` and a deny list —
`gen_object.NO_TOOLS` — the same way `--strict-mcp-config` is not optional here.
Prose written to instruct a human, such as opening a reference photograph or running
selftest before and after, becomes a WORK ORDER when its reader has tools. Briefing
the object generator with ASSET_FIDELITY.md requires tool restrictions to prevent
the subprocess from writing a builder directly into objects.js.
**THE PYTHON HALF OF THE EXTENSION CONTRACT — `tools/registry.py`.**
`python3 tools/registry.py` prints every op, rule and query and who owns it.
Ops, rules and queries register here; `agent.MCP_TOOLS` is DERIVED from the query
registry rather than hand-listed, so a query the server serves cannot go
un-offered to the design agent. It is a REGISTRY, not a rewrite: `execute()`
stays the one place an op is applied. Two rules it enforces by raising — **an
extension may only WARN** (every hard rejection in this project is measured
ground or building code), and **two extensions cannot own one verb**.
`register_op/rule/query(..., extension="name")` is how a contributor adds
one, and it lands in the same tables as a built-in.
**LEARNING FROM A REFERENCE DESIGN — `tools/refdesign.py`.**

```bash
python3 tools/refdesign.py add --image ~/piet.jpg --note "how much is left open"
python3 tools/refdesign.py read piet_20260912     # one reading pass
python3 tools/refdesign.py principles             # the corpus, brief-ready
```

The owner can give the model a landscape photograph to learn design principles
for their site. The reference's GEOMETRY does not transfer to the owner's ground:
the reference depicts a different slope and different light.
**A reading may never carry a coordinate, an outline or a
placement**, and `geometry_in()` refuses one that does; what a reference
contributes is height bands, proportions, drift size, edge character and
SENTENCES A DESIGNER COULD ACT ON. A principle is a REASON, never a target.
**The note is the valuable half** and `add` refuses without it: an image alone
does not identify which design decisions in the frame the owner is responding
to. Owner input, like landmarks and areas: nothing here fetches or
searches for an image. The reading shells out to the logged-in `claude` CLI with
tools restricted to `Read` and a deny list, because a prompt handing over a file
path is not inert.
## Other tools

```bash
python3 tools/project.py list | which | new "NAME" [--open] | open SLUG   # SITES: every
#   site is a project, ~/PEDON/<slug>/ (PEDON_PROJECTS moves the folder), outside the code. `data/…` anywhere means the
#   ACTIVE site's file — project.data()/project.resolve() are the one owner (the viewer's server:
#   viewer/project_paths.js, the same layout file schema/project_layout.json). PEDON_PROJECT
#   overrides the active site; the tests pin the reference site (PEDON_TEST_SITE /
#   ~/PEDON/.test_site) — reading a COPY of it — and skip `needs_site` tests without one.
python3 tools/planting_plan.py --design data/designs/X.json --beds a,b   # the TRADE'S drawings:
#   planting plan, plant schedule, setting-out by two tapes from their landmarks, printable at
#   1:50. The viewer makes them from ··· → Planting drawings to print…; docs/planting-out.md.
python3 tools/ar_export.py                          # the design at 1:1 for the native PEDON iPhone app:
#   hardscape + every plant as a PICTURE of itself + the site's landmarks as posts, no scan; 10-40 s.
#   The viewer makes it when ··· → See it on site… opens, and the phone fetches it from the
#   read-only server on :5179 (viewer/ar_server.js). docs/planting-out.md.
swiftc -O -parse-as-library tools/ar_render.swift -o /tmp/ar_render   # see that file AS THE
#   PHONE WILL: RealityKit, offscreen, from any eye. qlmanage -t is not a substitute.
python3 tools/asset_store.py find "stone lantern" | fetch <polyhaven id> | make --name … --script f.py --size w,d,h
#   OBJECT MODELS AS FILES: find in the library / built-ins / Poly Haven (CC0), fetch one
#   in, or make one from a Blender script run in a no-network sandbox. The design agent has the
#   same verbs as MCP tools (find_asset, fetch_asset, make_asset). docs/objects-and-surfaces.md
python3 tools/site_plan.py [--design X.json] --out plan.png [--bounds x0 y0 x1 y1] [--scale 50]
#   THE SITE IN PLAN WITH COORDINATES: grade bands, 0.5 m contours, unscanned ground in
#   grey, the house, the owner's areas and landmarks, and a design over it at MATURE spread with the
#   planting plan's own codes. What a designer draws on; a camera view cannot be read for x, y.
python3 tools/compose.py COMPOSITION.json --ops ops.json [--plan plan.png]
#   DRAWN MASSES BECOME PLANTS: species + count + an ellipse per drift; the plants are
#   spread evenly through YOUR shape, clear of paths, patios and objects; drifts drawn to
#   overlap are planted through each other (only one planting hole is refused); rough beds are
#   trimmed to the paving. It chooses nothing — the count is yours, and the report measures the
#   spacing on centre (as a share of mature spread), how many would sit one spread apart, what
#   else stands in the shape, and each bed's mature coverage (the validator's reading). It writes ops
#   only — check-ops / apply-ops are still the write path.
python3 tools/site_api.py crowding [--names a,b]   # which SAVED designs are crowded when grown
python3 tools/view_mcp.py scan_profile '{"from":[x,y],"to":[x,y]}'   # the MESH along a line, every 5 cm
# BLENDER: the tools find it one way (tools/project.py) — $PEDON_BLENDER, else `blender` on the
# PATH, else the macOS app, which is NOT on the PATH. By hand:
B=$(python3 -c 'import sys; sys.path.insert(0, "tools"); import project; print(project.BLENDER)')
"$B" -b -P tools/gen_trees.py -- --all             # rebuild the 24-model plant library
"$B" -b -P tools/gen_trees.py -- --species sage_open --height 1.0   # ONE, at its own size
"$B" -b -P tools/blender_export.py -- --in X.fbx --out assets/plants/x.glb   # a BOUGHT model
#   --height matters: gen_trees pre-compensates leaf size by it, so a 0.4 m subshrub
#   built at the 4.0 m default gets leaves a tenth of the size it should have.
#   YARDTWIN_PLANT_OUT=/tmp/stage builds somewhere else first, which is the right
#   habit — writing into assets/plants churns Vite under a design agent's `look`.
open http://localhost:5178/routing-test.html        # assertions on species→model routing
open http://localhost:5178/preview.html             # the plant library, side by side on a 1 m grid
open http://localhost:5178/surfaces.html           # PAVING, WALLS AND STEPS at eye level
#   The third review sheet. 11 ground surfaces, 8 wall materials and a flight of
#   steps, each drawn walking (3 m), standing (1.2 m) and in plan, with a 1 m post
#   for scale — paving has no size of its own, so a 1.4 m repeat and a 0.4 m one
#   look identical in a frame with nothing in it. NOTE: edgeMesh and stepsMesh are
#   only themselves ON A SLOPE (stepsMesh derives its riser count from the fall, so
#   flat ground builds exactly one step), and the field is `spline`, not `path`.
open http://localhost:5178/objects.html            # EVERY OBJECT beside a 1.7 m figure
#   Front, close (1.2 m) and plan, with ONE camera across every card — the asset
#   window fits the camera per object, which hides scale errors across the
#   objects. It draws through objectMesh, so it shows what the garden really
#   renders, and flags a base away from ground in red. Check for incomplete
#   geometry, such as a screen covering 24% of its own width or a lantern with
#   no firebox.
open http://localhost:5178/compare.html            # REFERENCE PHOTO beside the asset we draw
#   Every catalog entry, filterable, same size and ground. Reviewing them one
#   photograph at a time does not scale and by-the-shelf is too coarse to catch
#   per-species faults. Check species details, including flowers on all five
#   GLB-backed plants.
python3 tools/geodata.py --address "…"              # rebuild site.json from public data
python3 tools/site_api.py validate                  # validator on the committed design
#
#   EXIT CODES, because $? is the only part a shell script or a model checking success sees:
#     0  answered
#     1  this QUERY is broken (bad args, unreadable design)
#     2  this PROPERTY is not set up far enough to ask — never raycast (`no_scan`) or no
#        site.json at all (`no_site`). Both carry a `fix` array naming the command that
#        resolves it. A refusal that exits 0 is indistinguishable from an answer
#        to everything downstream.
#   The WRITE paths (save-owner, apply-ops) are deliberately NOT gated — the viewer writes
#   landmarks and areas before analyze_site has ever run, and that is the normal order.
python3 tools/capability_check.py                   # is anything undiscoverable to a new session?
python3 tools/render_profile.py data/photoreal/scene.glb --out /tmp/scene-cost.json
# Render memory investigation: header-only geometry counts, or a bounded
# --probe-import native|realized --memory-out PATH comparison. See docs/rendering.md.
python3 tools/selftest.py                           # THE test suite — run it before and after any change
python3 tools/sun.py season | day | position        # sun path; REFUSES bearings until north is set
python3 tools/frame_check.py                        # do the ENU and world frames still agree?
python3 tools/float_check.py                        # is any design object hanging in the air?
```

## EVERY FEATURE IS AN EXTENSION — `pedon/EXTENSIONS.md`

Every feature must be an extension to keep the system modular and allow external
contributors to add features.

Read `EXTENSIONS.md` before adding a feature. It unifies five registries: object
builders (`objects.js BUILDERS`), MCP tools (`view_mcp.py TOOLS`), ops (applied in
`execute()`), site queries, and ONE property editor for every kind. Without a `plant`
handler in `renderProperties()`, **every plant in a design is an object without an
inspector**. A registry makes missing modules visible; a switch statement can hide
missing cases.

`viewer/src/extensions.js` is the host. **Two things are deliberately NOT
pluggable, and both follow from rules already in this file:** an extension gets
`ctx.ops.apply(...)` and never the filesystem, because there is one write path;
and `@rule` takes `severity="warn"` only, because every hard rejection is
measured ground, building code or physically unplantable and the library must never cap the design.
Those two sentences are the whole third-party permission model.
**The capability object IS the sandbox boundary.** Extensions load as trusted
modules and are written against a `ctx` built from their declared
permissions. Every capability is therefore a message-shaped call on an
object the host owns, so running them in a Worker later changes the host and not
one extension. The review rule that keeps this true: **an extension imports nothing
from the app and receives everything.**

## `resync_palette` — bring planted sizes back in step with the catalogue

`place_plants` COPIES `mature_height_m` / `mature_spread_m` out of the palette into
the design, so correcting the catalogue does nothing to what is already planted.
For example, correcting Coast Rosemary's unsourced 1.4 x 1.5 planning estimate to
a sourced 1.8 x 1.8 leaves every planted copy at the smaller size unless it is
resynced, so its bed is measured as though the plant stays small.

```bash
python3 tools/site_api.py check-ops '[{"tool":"resync_palette","input":{}}]'
python3 tools/site_api.py apply-ops '[{"tool":"resync_palette","input":{}}]'
```

Omit `species` for every species that has drifted, or name a list. **It keeps the
ids**, which is the whole reason it is an op rather than remove + `place_plants`:
`place_plants` always mints a fresh id, so the obvious workaround would silently
empty the design's groups and invalidate anything else holding an id.

`validate()` reports the drift on its own, per species and never as an error — a
cultivar or a measured specimen is a legitimate reason to differ.
