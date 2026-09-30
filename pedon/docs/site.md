# The site — asking the real ground

Everything here is measured from the capture, not estimated. `tools/site_api.py`
answers in one JSON object per call; the design agent gets the same answers as
MCP tools and should never be taught the command line (see `docs/tools.md`).

## Onboarding a NEW property

```bash
cd viewer && npm run dev            # open the page, load the capture, keep the tab visible
python3 tools/geodata.py --address "…"    # -> data/site.json (zone, footprint, address)
#   then in the viewer: Fit ground, Set north, Click span to lock scale
python3 tools/analyze_site.py             # -> terrain_scan.json + site.zones
```

`analyze_site.py` is the whole site analysis in one command: it asks the open viewer to
raycast the scan on a 1 m grid (the browser is the only place the mesh exists), finds the
building as the enclosed hole the scanner could not see into, carves the ground into yards
around it, and derives per zone the slope, downhill and contour bearing, grade breakdown,
gentlest pocket and maximum level-pad width. Nothing in it is specific to one property; a
lot with no detectable building becomes a single zone.

It names zones by compass (`east_yard`), because "back yard" depends on where the front
door is and geometry cannot know that — but **re-running preserves names you already
gave**, so renaming a zone by hand once is permanent and will not break designs scoped to
it.
## The site is ASKABLE — use the query tools, don't estimate
**Two audiences, and they want different shapes.** A session editing this code runs
the CLI below. The DESIGN AGENT should not: everything here is also an MCP tool
(`ground`, `slope`, `profile`, `check_pad`, `check_route`, `best_bench`, `near`,
`zones`, `areas`, `area`, `scene`, plus `sun`, `list_assets`, `sightline`, `look`,
`preview_design`, `check_ground_contact`, `scan_profile`), it receives them automatically on
connect with descriptions saying WHEN to reach for each, and a tool is the shorter
path that keeps working. An agent taught the command line spends most of its calls on
single-point shell queries and almost none on the batch tools —
`tools/agent.py MCP_TOOLS` is the list it is actually offered.

## Verified MCP call shapes

These examples avoid the common argument mistakes. The tool's current schema remains
authoritative; substitute the relevant
measured points and current proposal file rather than copying a past design's
coordinates as site intent.

| Tool | Input example | Check |
| --- | --- | --- |
| `profile` | `{"x1":12.3,"y1":-9.8,"x2":15.7,"y2":-9.8}` | Separate coordinate fields, not `a` and `b` arrays |
| `scene` | `{"box":"[12,-12.3,15.7,-5]"}` | The box is a JSON array encoded as a string, including brackets |
| `preview_design` | `{"path":"data/designs/YOUR_VARIANT.json"}` | Use `path`, not `file`; confirm the returned design path |
| `look` | `{"viewpoint":"from the back door"}` | First confirm this owner camera exists with `list_viewpoints`; inspect the returned image and design path |

Call `preview_design` with no path to return to the live working design. A preview
selects what the render tools see; it does not save or apply a proposal. Check that
the image is of the saved version you intend to judge. Successful calls are logged in
`data/site_api_calls.log`.

## Command-line queries

`tools/site_api.py` answers questions about the real ground. Every command prints
one JSON object. **Prefer these over reading `data/terrain.json` yourself**: that
file is a BFS-filled 2 m grid that invents flat ground past the scan edge and
smooths real relief. `site_api` reads `data/terrain_scan.json`, a 1 m raycast of
the actual mesh, interpolates bilinearly, and reports `scan_coverage` so you can
tell measurement from interpolation.

```bash
python3 tools/site_api.py ground 15 -6              # elevation, and whether it was really scanned
python3 tools/site_api.py constraints                # the limits this site is judged against: agent.DEFAULT_CONSTRAINTS, with site.json's own `constraints` over them
python3 tools/site_api.py slope 15 -6               # grade, downhill + contour bearing, what it suits
python3 tools/site_api.py profile 13 -14 13 10      # ground along a line, steepest step
python3 tools/site_api.py check-pad '[[14,-9],[18,-9],[18,-4],[14,-4]]'   # cut/fill; omit --level for the best one
python3 tools/site_api.py check-route '[[11,-12],[13,-4]]' --steps '[...]' --level -2
#   CIRCULATION: walked stretches vs stepped ones, landings, and the VALIDATOR's own
#   verdict on the same route. Pass --steps/--level or it grades a bare list of points
#   and contradicts the judge.
python3 tools/site_api.py best-bench 12 -12 17 6 --across 4 --along 6     # SEARCHES for the cheapest level pad
python3 tools/site_api.py near 15 -6 --radius 3     # what is already there
python3 tools/site_api.py ground-many '[[15,-6],[16,-6]]'  # MANY points in one call
python3 tools/site_api.py slope-many  '[[15,-6],[16,-6]]'  # ditto — one call, not one per point
python3 tools/site_api.py check-ops '[{"tool":...}]' # DRY-RUN an op list; writes nothing
python3 tools/site_api.py apply-ops '[{"tool":...}]' # RUN it for real; all-or-nothing write.
echo '{"areas":[...]}' | python3 tools/site_api.py save-owner  # the ONLY way to write site.json
#   from the viewer: merges into the OWNER half and REFUSES a derived or fetched key, naming the
#   real writer. POST /api/site goes through it. geodata.SECTIONS is the ownership map.
#   The viewer's hand-placement posts here via POST /api/ops, so a hand edit is judged by the
#   same execute()+validate() a model op is — never a second write path.
python3 tools/site_api.py zones                     # measured yards + grade breakdown
python3 tools/site_api.py usable-area --zone east_yard   # WHERE the ground is gentle enough to use
#   Derived from slope, not drawn by the owner: less slope largely means usable area.
#   It is deliberately NOT an entry in site.areas[]: those are regions the owner DREW,
#   and the rule that they are never model-generated guards against inventing INTENT
#   through a name (a south fence labelled "back_fence" by a vision pass sends designs
#   into the wrong yard). A measurement names no intention and is re-derivable, so it
#   cannot drift into fiction.
#   TWO TRAPS, both measured. `data/terrain.json` INVENTS flat ground past the scan
#   edge, so a naive slope<9 mask can be mostly phantom — nearly 3x as many filled gentle
#   cells as real ones on a measured site; those are excluded and counted. And
#   requiring the four GRADIENT neighbours to be scanned as well erodes a region by
#   one cell on every side, which deletes a bench one to two cells wide and reports 2 m2 where there are 16 — so a kept cell whose gradient leans on filled
#   ground is COUNTED, not dropped. Flat is necessary, not sufficient:
#   it says where the ground would let you stand, never that you would want to.
python3 tools/site_api.py composition --design data/designs/x.json   # hardscape vs planted vs open
#   ...and `character`: species, forms, upright share, the biggest one-species mass, own_kind_nearest
#   (a scatter reads under ~0.3), crowns_overlapping (plants growing into each other at one height)
#   and the_year (per season: share in flower, its colours; evergreen share). Measured, never graded.
python3 tools/site_api.py crowding [--names a,b]   # which SAVED designs have beds crowded at full maturity
#   the viewer's Saved list reads this through /api/designs; one metric, agent.bed_mature_coverage
python3 tools/site_api.py scene --box '[12.5,-11.5,18,-2.5]'  # does a region compose as a PICTURE?
#   composition says how much ground is planted; `scene` says whether the planting DOES
#   anything — how many of four body-scale height bands are occupied, what it does in each
#   season, how saturated the flower colours are. --area scopes it to a region the owner
#   drew. A corner meant to compose as a picture can measure 2 of 4 bands, no
#   autumn, every colour a grey, while composition calls the same corner well balanced.
#   It REPORTS AND DOES NOT GRADE: taste is reported, and the designer decides.
#   data/plant_palette.json  — the library's plant catalogue, with
#   water and native flags; the design agent pulls it via list_assets kind=plants
python3 tools/site_api.py areas                     # regions the owner DREW, by name
python3 tools/site_api.py area sunny_bank           # one region: grade, ground, what's in it
```
## Anything SMALL AND BUILT: ask the mesh, not the grid

```bash
python3 tools/view_mcp.py scan_profile '{"from":[-4.6,-12.5],"to":[3.7,-14.05]}'   # viewer must be open
```

Every command above reads `terrain_scan.json`, a **1 m** raycast. A railroad tie, a
kerb, the lip of a step or a 0.3 m wall is not in it: on a slope stepped with ties,
`profile` returns a smooth ramp (17% on a measured one) where the mesh has five ties,
1.8 m apart, with faces of 0.12-0.23 m. `scan_profile` raycasts the mesh itself in
the open viewer every 5 cm and lists each STEP with the level above and below it.
Reach for it whenever the question is about clearance under, over or between built
things — and before extending a bed across ground that may hide a wall
(`DESIGNING.md`, "look for a STEP"). Undersides are never measured: a scan sees
faces, so how deep a timber is bedded is an assumption and should be said as one.

## Marking a region and asking about it

Landmarks are points, which is the wrong shape for "this retaining wall" or
"design something here". In the viewer, **Places → Draw area**: type a name, then
hold and drag across the yard — it lassos the real scanned ground, simplifies the
outline on release, and saves it to `site.areas[]`. A later session finds it by
name with `site_api areas` / `site_api area NAME`, and

```bash
python3 tools/agent.py --explore --area sunny_bank "…"
```

restricts a design to that region. The restriction is **enforced by the
validator**, not merely stated in the prompt — an op with any point outside the
area is rejected. Areas are owner ground truth, exactly like landmarks: never
model-generated, never inferred from a name.
