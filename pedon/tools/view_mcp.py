"""MCP server: the model's eyes on the yard, and its hands on the site queries.

Why MCP rather than another CLI subcommand
------------------------------------------
An MCP tool result can carry image bytes INLINE, which a `claude -p` subprocess
can see. Passing a file path costs a second round-trip and carries a stale-frame
hazard; the walkthrough code deletes old frames for that reason.

The second reason is tool shape. A single-point CLI such as
`python3 tools/site_api.py ground 15 -6` requires remembering a filename and
encourages repeated calls: in logged workloads, single-point ground/slope/near
queries outnumber batch calls many times over. Prose instructions alone do not encourage batching as effectively as the tool
interface. The site queries are tools here too, and ground and slope take a
LIST, because a tool that accepts one point can get called forty times.
For the design agent mid-design the right shape is
an MCP tool, not a filename.

Every site tool CALLS site_api's cmd_ function and prints what the CLI prints,
byte for byte. It does not re-derive anything: separate ground lookups can
disagree by 0.99 m, so one question must have one calculation.

Rendering itself happens in the BROWSER — WebGL is the only thing that can draw
the scan, and the browser already holds the loaded scene, the live design, the
calibration and the growth scale. That half is a thin client of the dev server's
render broker; see viewer/src/viewport.js for the executor. The site queries
touch neither, so they answer with no viewer open.

Registered in .mcp.json. agent.py passes it to the spawned model with
--strict-mcp-config so the subprocess does NOT inherit unrelated user-scope MCP
servers and burn its context on their tool listings.

    python3 tools/view_mcp.py          # speaks JSON-RPC on stdin/stdout
"""
from __future__ import annotations
import argparse
import base64
import functools
import json
import math
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

VIEWER = os.environ.get("YARDTWIN_VIEWER", "http://localhost:5178")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The site queries are IMPORTED, not shelled out to: a subprocess per question
# would be the filename affordance again, one process deeper. Guarded because an
# import that raises here would take `look` and `check_ground_contact` down with
# it — an MCP server that dies at startup leaves the model with no tools at all,
# which is a worse failure than a missing site query.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import project                     # the active project's files — the ONE owner
try:
    import site_api
    _SITE_IMPORT_ERROR = None
except Exception as e:                          # noqa: BLE001 - report, never crash
    site_api = None
    _SITE_IMPORT_ERROR = f"{type(e).__name__}: {e}"

# Where a call is recorded. The log shows whether the model actually queries the
# ground — `claude -p` prints only its final answer. Every traffic figure,
# including the call mix above, comes from this log. A tool that queries the site
# without logging hides traffic and prevents measuring the effect of tool shape.
# Overridable so a test never writes into the dataset it is measuring.
CALL_LOG = os.environ.get("YARDTWIN_CALL_LOG")    # None: the ACTIVE project's log (project.data)

TOOLS = [
    {
        "name": "look",
        "description": (
            "Render the yard and SEE it. Use this to check work that measures fine but "
            "may look wrong — an object floating above the ground, a bed standing on a "
            "deck instead of on soil, a path that aims at nothing, planting that blocks "
            "its own route. Returns the picture plus where the camera was and how much "
            "air is under the subject. Always full botanical detail at mature size, "
            "regardless of the viewer's Fast preview setting. Use render='photoreal' "
            "for a Cycles path-traced image of the current proposal (a few minutes). "
            "Inspect this before settling a planting/material decision; then revise and look again."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "render": {"type": "string", "enum": ["detailed", "photoreal"],
                           "description": "detailed (default) for quick iteration; photoreal path-traces "
                           "the same geometry and camera, freshly exported from the current preview."},
                "eye": {"type": "array", "items": {"type": "number"},
                        "description":
                        "DRIVE THE CAMERA YOURSELF: [x, y] or [x, y, height] in ENU metres. "
                        "With `look_at`, this replaces subject+from entirely and you frame "
                        "the shot — stand at the entrance and sight up the slope, run your "
                        "eye along a wall to see whether it reads straight, drop to 0.3 m "
                        "to find what a bed hides. `height` is ABOVE THE GROUND at that "
                        "point (default 1.65, a standing person), so you never need to know "
                        "the datum. A subject plus a compass preset is a viewer; this is "
                        "what a designer does."},
                "look_at": {"type": "array", "items": {"type": "number"},
                            "description": "[x, y] or [x, y, height] in ENU metres — what "
                                           "the camera aims at. Required with `eye`."},
                "viewpoint": {"type": "string", "description":
                              "LOOK FROM A VIEW THE OWNER SAVED, by name — 'the kitchen "
                              "window', 'from the deck'. These are places the owner decided "
                              "matter, so judging a change from one is judging it where "
                              "they will see it. `list_viewpoints` names them. Supplies "
                              "both eye and look_at, so pass it alone."},
                "subject": {"type": "string", "description":
                            "what to look at: a design object id (bed_1, dining_terrace, p46), "
                            "a landmark name, an area name, or \"x,y\" in ENU metres"},
                "from": {"type": "string",
                         "enum": ["grazing", "eye", "above", "n", "ne", "e", "se", "s", "sw", "w", "nw"],
                         "description":
                         "grazing (default) puts the camera at the SUBJECT'S OWN height looking "
                         "level at it — the view that makes floating or standing-on-a-structure "
                         "obvious. eye = a person at 1.65 m. above = plan view."},
                "distance_m": {"type": "number"},
                "fov_deg": {"type": "number"},
                "show": {"type": "array", "items": {"type": "string"},
                         "description":
                         "OVERLAYS TO PAINT ONTO THE PICTURE — ask for what you need to "
                         "judge this view, do not guess from the colours. "
                         "\"slope\": the ground's own STEEPEST FALL, shaded green under "
                         "8%, amber to 20%, red beyond. Read it as where water runs, not "
                         "as where you may not walk: a route that TRAVERSES a red face "
                         "experiences far less. A bank can average 25% and read mostly red "
                         "while the paths across it measure 3-14%, because they follow "
                         "the contour. Red means "
                         "do not run a walk DOWN it; it does not mean stay off. Use "
                         "check_route for what a specific line actually costs. "
                         "\"scan_edge\": a red line where the measured ground STOPS. "
                         "Past it there is no data, everything is rejected, and it is "
                         "invisible in a plain render because ground simply stops being "
                         "ground. Ask for this before designing near an edge to keep "
                         "the design inside the measured ground."},
            },
            "anyOf": [{"required": ["subject"]}, {"required": ["viewpoint"]},
                      {"required": ["eye", "look_at"]}],
        },
    },
    {
        "name": "check_ground_contact",
        "description": (
            "Ask, in metres, whether every object in the design is actually sitting on "
            "the ground — all of them at once. Use this after placing or moving anything, "
            "and before you call a design finished. It is the numeric counterpart to "
            "`look`: `look` shows you one subject and can miss what is off-screen, while "
            "this checks all of them and cannot be fooled by a flattering camera angle. "
            "Positive gap means the object hangs clear of the ground over its whole "
            "footprint, which is always a bug. A terrace deliberately retained above its "
            "downhill slope does NOT register here, so anything it reports is real."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "tolerance_m": {"type": "number",
                                "description": "gap tolerated before an object counts as floating (default 0.4)"},
            },
        },
    },
    {
        "name": "scan_profile",
        "description": (
            "The scan's own surface along a line, every few CENTIMETRES, raycast onto the "
            "mesh in the open viewer. Use this whenever the question is about something "
            "small and built — a railroad tie, a kerb, a low wall, the lip of a step, how "
            "deep a trench can go under something — because `profile` and `ground` read a "
            "1 m grid and a 0.2 m timber simply is not in it: they return a smooth ramp "
            "where the ground is really a staircase. The reply lists every STEP it found "
            "(where the surface drops or rises sharply), with the level above and below "
            "each, then the whole line decimated. Needs the viewer open with its scan."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "from": {"type": "array", "items": {"type": "number"}, "minItems": 2, "maxItems": 2,
                         "description": "ENU [x, y] metres — start of the line"},
                "to": {"type": "array", "items": {"type": "number"}, "minItems": 2, "maxItems": 2,
                       "description": "ENU [x, y] metres — end of the line"},
                "step_m": {"type": "number", "description": "spacing of the samples (default 0.05)"},
                "riser_m": {"type": "number",
                            "description": "smallest change in level that counts as a step (default 0.08)"},
            },
            "required": ["from", "to"],
        },
    },
    {
        "name": "preview_design",
        "description": (
            "Point the viewer at a design file so `look` shows YOUR proposal instead of "
            "the owner's working design. THIS IS NOT OPTIONAL IF YOU INTEND TO LOOK: the "
            "ops you emit are applied only after your run ends, so without a preview every "
            "`look` renders the design that was already there and you will reason about "
            "somebody else's work as if it were yours. The loop is: write your ops to a "
            "scratch file "
            "with `python3 tools/site_api.py apply-ops '<ops>' --design data/designs/_scratch.json`, "
            "preview_design that path, look, adjust, repeat. Call it with no path to put "
            "the viewer back on the owner's design when you finish."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description":
                         "a data/*.json design file, e.g. data/designs/_scratch.json. "
                         "Omit to return to the owner's working design."},
            },
        },
    },
    {
        "name": "sun",
        "description": (
            "Where the sun is, and therefore where the shade is. Ask this BEFORE you "
            "site anywhere someone sits — a terrace, a bench, a dining table. The first "
            "question a client asks about a seat is when it catches the sun, and it is "
            "not recoverable from the geometry. `when` takes a date and hour "
            "(\"2026-06-21 18:00\") or a word: \"summer_evening\", \"winter_noon\", "
            "\"equinox\". It REFUSES any bearing-dependent answer while north is unset "
            "on the capture, and says so, because an aspect computed from an arbitrary "
            "heading is a confident wrong answer — the most expensive kind here. "
            "Altitude and day length need only latitude and are always available."),
        "inputSchema": {"type": "object", "properties": {
            "when": {"type": "string"},
            "zone": {"type": "string", "description": "a measured yard, for its aspect"}}},
    },
    {
        "name": "list_assets",
        "description": (
            "What the library can actually BUILD: plant models, object kinds, path and "
            "edge materials, with real sizes. Ask this before you choose a palette. You "
            "may still ask for anything you like — an unmodelled plant falls back to its "
            "growth form and an unmodelled object draws as a marked placeholder and is "
            "recorded as a WANT for the owner — but designing without knowing what "
            "exists means substituting blind rather than deciding. Not knowing the "
            "library is a handicap nobody chose; asking for something it lacks is a "
            "legitimate design decision."),
        "inputSchema": {"type": "object", "properties": {
            "kind": {"type": "string", "description": "plants | objects | materials; omit for all"},
            "form": {"type": "string", "description":
                     "with kind=plants, keep only this growth form (mound, grass, mat, "
                     "meadow, strap, rush, perennial, rosette, tree, ...)"},
            "native_only": {"type": "boolean", "description":
                            "with kind=plants, only California natives"},
            "cat_safe_only": {"type": "boolean", "description":
                              "with kind=plants, only species the catalogue records as safe "
                              "for cats, with evidence. Species not assessed are EXCLUDED by "
                              "this filter — 'not assessed' is not 'safe', and the catalogue "
                              "is not a veterinary source. A site whose policy says cats have "
                              "access refuses known-toxic species whatever this filter says"},
            "max_height_m": {"type": "number", "description":
                             "with kind=plants, nothing taller than this at maturity"}}},
    },
    # EYES AND A CALCULATOR FOR PLANTING. Single-file strings of alternating species along
    # path edges with empty bed interiors are obvious in plan and hidden at eye level.
    # Designers compose planting in plan. `plan` SEES; `compose_planting`
    # CALCULATES what it is asked and decides nothing (docs/tools.md: who decides what).
    {
        "name": "plan",
        "description": (
            "SEE A DESIGN IN PLAN, the way a designer draws it: north up, a metre grid you can "
            "read x, y off, the ground's grade and 0.5 m contours, the house, the owner's areas, "
            "and every plant as a circle at its MATURE spread, labelled with its species code. "
            "Use it whenever you place or revise planting: masses, drifts, repetition, rows, bare "
            "ground and crowding are obvious from above and invisible at eye level. Pass your "
            "scratch design's path."),
        "inputSchema": {"type": "object", "properties": {
            "design": {"type": "string", "description": "design file, e.g. data/designs/_x_scratch.json (default: the working design)"},
            "bounds": {"type": "array", "items": {"type": "number"}, "minItems": 4, "maxItems": 4,
                       "description": "[x0, y0, x1, y1] metres to draw (default: the whole design)"},
            "scale": {"type": "integer", "description": "pixels per metre (default fits ~900 px)"}}},
    },
    {
        "name": "compose_planting",
        "description": (
            "ARITHMETIC ON REQUEST — you decide, it calculates. Use it when you have drawn your "
            "drifts and want the plants inside them spaced for you. For each drift you give a species, "
            "a COUNT and the SHAPE you drew (an ellipse [cx, cy, rx, ry, degrees] or a polygon); it "
            "spreads exactly that many plants evenly through that shape, keeps them off paths, "
            "patios and objects, plants drifts drawn to overlap through each other (how close plants "
            "stand is YOURS; only two in one planting hole is refused), and returns place_plants ops, "
            "a report (spacing on centre as a share of mature spread, how many would sit one spread "
            "apart, what else stands in each drift, each bed's mature coverage) "
            "and a PLAN picture. It also trims a bed you drew rough over a path or terrace to the "
            "paving edge. It writes NOTHING: look at the plan, change your drifts, then send the "
            "ops yourself with apply-ops. It never picks counts, shapes or species."),
        "inputSchema": {"type": "object", "required": ["design"], "properties": {
            "design": {"type": "string", "description": "the design the drifts go into (your scratch file)"},
            "masses": {"type": "array", "items": {"type": "object", "required": ["species", "count"], "properties": {
                "species": {"type": "string"}, "count": {"type": "integer", "minimum": 1},
                "bed": {"type": "string"},
                "ellipse": {"type": "array", "items": {"type": "number"}, "minItems": 4, "maxItems": 5},
                "shape": {"type": "array", "items": {"type": "array", "items": {"type": "number"}}}}}},
            "place": {"type": "array", "items": {"type": "object", "required": ["species", "at"], "properties": {
                "species": {"type": "string"}, "at": {"type": "array", "items": {"type": "number"}}}},
                "description": "single plants you place exactly, e.g. a specimen"},
            "beds": {"type": "array", "items": {"type": "object", "required": ["id", "outline"], "properties": {
                "id": {"type": "string"}, "outline": {"type": "array", "items": {"type": "array", "items": {"type": "number"}}},
                "mulch": {"type": "string"}}},
                "description": "beds drawn rough; each is trimmed to the paths, patios and house"},
            "replace_in": {"description": "bed ids whose existing plants the ops remove first, or \"all\""},
            "keep": {"type": "array", "items": {"type": "string"}}}},
    },
    # FIND IT OR MAKE IT. The design agent must be able to find or create a missing
    # 3D asset. Object assets are FILES in
    # assets/objects/ with a card beside them (tools/asset_store.py); these three reach them,
    # and every one that produces a model hands back its picture to look at.
    {
        "name": "find_asset",
        "description": (
            "Look for a 3D model of an OBJECT the design needs (a lantern, a bench, a boulder, "
            "a trellis, a pot): in this project's object library, among the built-in kinds, "
            "and in Poly Haven's free CC0 models (real sizes, a picture of each). Use it when "
            "list_assets lacks what you want — then fetch_asset the one that fits, or "
            "make_asset if nothing does. Sizes are metres (w, d, h). With plant: true it "
            "looks for a PLANT model instead — the plant library and Poly Haven's plants — "
            "for a species the viewer draws wrong or as a generic shape."),
        "inputSchema": {"type": "object", "required": ["query"], "properties": {
            "query": {"type": "string", "description": "what it is, e.g. 'stone lantern', 'garden bench', 'low flowering shrub'"},
            "plant": {"type": "boolean", "description": "search plant models, not objects"}}},
    },
    {
        "name": "fetch_asset",
        "description": (
            "Call it after find_asset shows a Poly Haven model (its `id`) that fits: it "
            "brings that model into the object library — "
            "converted, standing on the ground, licence on its card. Returns the card and a "
            "PICTURE — look at it. Then place it with place_object {kind: card.kind, "
            "model: card.model, height_m: the size you want}. Give `species` and it becomes "
            "a PLANT model instead: place_plants (or set_plants) that species with "
            "asset: the returned `asset`, and the viewer draws this model at the plant's "
            "mature height and spread."),
        "inputSchema": {"type": "object", "required": ["id"], "properties": {
            "id": {"type": "string"},
            "name": {"type": "string", "description": "what to call it in the library"},
            "kind": {"type": "string", "description": "the object kind a design will say, e.g. 'lantern'"},
            "species": {"type": "string", "description": "a PLANT model, for this botanical name"}}},
    },
    {
        "name": "make_asset",
        "description": (
            "Use it when find_asset says nothing IS the thing you need: MAKE the model by "
            "writing a Blender Python script. It runs "
            "headless with `bpy`, `bmesh`, `mathutils`, `math` already imported, in METRES, "
            "Z up, in a sandbox with no network that may not write files. Build meshes with "
            "materials (Principled BSDF base colours); the result is set on the ground, "
            "exported, checked against `size_m`, and returned with a PICTURE — look at it, "
            "and fix the script if it is wrong. Keep it under 300,000 triangles. Give "
            "`species` to make a PLANT model — build it at the species' mature size from what "
            "the plant really looks like (habit, leaf, flower colour), then place_plants with "
            "asset: the returned `asset`."),
        "inputSchema": {"type": "object", "required": ["name", "script"], "properties": {
            "name": {"type": "string"},
            "script": {"type": "string", "description": "Blender Python; the meshes it leaves in the scene are the model"},
            "size_m": {"type": "array", "items": {"type": "number"}, "minItems": 3, "maxItems": 3,
                       "description": "[width, depth, height] it should come out at, metres"},
            "kind": {"type": "string"},
            "species": {"type": "string", "description": "a PLANT model, for this botanical name"}}},
    },
    {
        "name": "walk_through",
        "description": (
            "STAND IN YOUR DESIGN and look, at 1.65 m, from stations along its own paths "
            "and usable areas — the same eight viewpoints the owner judges from. Call it "
            "on your scratch file (apply-ops then preview_design) BEFORE you finish. This "
            "checks visual qualities that measurements cannot establish: the LINE of "
            "a path can look wrong even when its measurements pass. `look` shows "
            "you one thing; this shows you the walk."),
        "inputSchema": {"type": "object", "properties": {
            "stations": {"type": "integer", "description": "how many viewpoints, 1-10 (default 6)"}}},
    },
    {
        "name": "sightline",
        "description": (
            "What you can SEE from a point — whether the ground itself blocks the view "
            "between two places, and by how much. Use this when you are composing rather "
            "than measuring: whether a seat looks out or into a bank, whether a terrace "
            "is visible from the door, whether a route arrives at something worth "
            "arriving at. A garden reads as composed rather than assembled because of "
            "what is framed from where, and that is invisible in a plan and in every "
            "number the other tools return."),
        "inputSchema": {"type": "object", "properties": {
            "from": {"type": "array", "items": {"type": "number"},
                     "description": "[x, y] ENU metres; eye height 1.65 assumed"},
            "to": {"type": "array", "items": {"type": "number"}},
            "eye_m": {"type": "number"}, "target_m": {"type": "number"}},
            "required": ["from", "to"]},
    },
    {
        "name": "list_viewpoints",
        "description": (
            "What you can point `look` at: design object ids, landmark names, area names. "
            "Call this before your first `look` rather than guessing an id — a subject that "
            "does not exist costs a round trip and tells you nothing about the yard. Each of the "
            "owner's saved views says, against the design, where it STANDS (on a walk, raised at a "
            "window or deck, or inside a bed where nobody stands) and which beds FILL the middle of "
            "its frame: a saved camera can outlive the walk it was saved from, so judge a bed from "
            "a view whose `frames` names it, or aim `look` at it from its walk."),
        "inputSchema": {"type": "object", "properties": {
            "design": {"type": "string", "description": "the design to judge the views against (default: the working design)"}}},
    },
]

# ── the site queries ──────────────────────────────────────────────────────
# One entry per QUESTION, not per point. `cli` is the site_api subcommand this
# is (also what goes in the call log, so MCP and CLI traffic stay comparable),
# `fn` the function it calls, and the schema is the only place a default is
# written — the handler fills missing arguments from it, so the number the model
# is shown and the number the query runs with cannot be two different numbers.
# tests/test_mcp_site.py reads those defaults back out of site_api's own parser.
# json_args are the parameters site_api takes as JSON TEXT and parses itself; a
# model should hand over a real array, so it is re-serialised rather than
# reimplementing the parse and its error messages.
SITE_TOOLS = [
    {
        "name": "ground", "cli": "ground-many", "fn": "cmd_ground_many",
        "json_args": ("points",),
        "description": (
            "Measured ground elevation, in metres, at a LIST of points — the 1 m raycast of "
            "the real scan, not an estimate off a picture. Ask before you place anything and "
            "whenever you are about to assume a height: wrong elevations can leave objects "
            "floating or buried. Pass every point you are curious about "
            "in ONE call — forty points cost the same round trip as one — and read the "
            "per-row `scanned` flag: past the scan edge the height is interpolated and the "
            "summary warns you."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "points": {"type": "array", "description":
                           "[[x, y], ...] in ENU metres. Give the whole set, not one at a time",
                           "items": {"type": "array", "items": {"type": "number"},
                                     "minItems": 2, "maxItems": 2}},
            },
            "required": ["points"],
        },
    },
    {
        "name": "slope", "cli": "slope-many", "fn": "cmd_slope_many",
        "json_args": ("points",),
        "description": (
            "Grade, downhill bearing and contour bearing at a LIST of points, with the "
            "flattest and steepest of them named and each one banded flat / moderate / steep. "
            "Ask this before siting anything: flat ground is the scarce resource here — 7 m2 "
            "under 9 degrees out of 232 in the back yard — and a bench drawn across the fall "
            "line still drops a metre along its own length. Give it the whole candidate set in "
            "one call. If you are choosing WHERE something goes, use best_bench instead: it "
            "searches placements you have not thought to list."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "points": {"type": "array", "description":
                           "[[x, y], ...] in ENU metres — every candidate at once",
                           "items": {"type": "array", "items": {"type": "number"},
                                     "minItems": 2, "maxItems": 2}},
                "radius": {"type": "number", "default": 2.0, "description":
                           "metres each side used for the central difference"},
            },
            "required": ["points"],
        },
    },
    {
        "name": "profile", "cli": "profile", "fn": "cmd_profile",
        "description": (
            "The ground along a straight line, step by step, with the grade of each step and "
            "the steepest of them. Use it when what matters is what happens BETWEEN two "
            "points: a wall declared 0.7 m can stand 2.59 m above ground where the ground dips "
            "between sampled ends. Also the quickest way to see whether a "
            "run of fence, wall or path crosses a break in slope."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "x1": {"type": "number"}, "y1": {"type": "number"},
                "x2": {"type": "number"}, "y2": {"type": "number"},
                "step": {"type": "number", "default": 2.0,
                         "description": "metres between samples"},
            },
            "required": ["x1", "y1", "x2", "y2"],
        },
    },
    {
        "name": "check_pad", "cli": "check-pad", "fn": "cmd_check_pad",
        "json_args": ("polygon",),
        "description": (
            "What a level pad on this outline would actually cost in cut and fill — WITHOUT "
            "committing it. Call it before you propose a patio, terrace or bench, and again "
            "after you move one: the verdict is buildable / needs an engineered footing / over "
            "what an edge can retain, judged against this site's own limits, and it says how "
            "much of the outline sits on ground the scanner really saw. Check levels here "
            "before submitting ops so the validator need not reject guessed levels."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "polygon": {"type": "array", "description": "[[x, y], ...] outline in ENU metres",
                            "items": {"type": "array", "items": {"type": "number"},
                                      "minItems": 2, "maxItems": 2}},
                "level": {"type": "number", "description":
                          "the finished level to test; omit for the best-balanced one"},
            },
            "required": ["polygon"],
        },
    },
    {
        "name": "check_route", "cli": "check-route", "fn": "cmd_check_route",
        "json_args": ("spline", "steps"),
        "description": (
            "A route as CIRCULATION, not as one verdict: which contiguous stretches are "
            "WALKED and which are STEPPED, where a landing belongs, and what the validator "
            "itself concludes about the same route. Call it before you write a path op. "
            "PASS `steps` — the flights already in your design — and `level` if the path "
            "declares one: a stretch a set_steps flight covers is STEPPED, not a failed "
            "ramp, and a path that declares level_m IS the bench, so the slope underneath "
            "is not what anybody walks on. Without them this grades a bare list of points "
            "and can reject a route the validator accepts with steps or a level. A steep "
            "stretch with nothing across it is a REQUEST for set_steps, and the stretch "
            "says how many risers and how much LENGTH they eat — the number that decides "
            "whether the route still fits. A 30 m walk with one 4 m flight in it is a "
            "design, not a failure."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "spline": {"type": "array", "description": "[[x, y], ...] centreline in ENU metres",
                           "items": {"type": "array", "items": {"type": "number"},
                                     "minItems": 2, "maxItems": 2}},
                "steps": {"type": "array", "description":
                          "the steps[] already in your design, so a stretch a flight covers "
                          "is judged as stepped rather than as an over-steep ramp",
                          "items": {"type": "object"}},
                "level": {"type": "number", "description":
                          "the level_m this path declares, if any — it is then a bench and "
                          "the slope under it is not graded"},
            },
            "required": ["spline"],
        },
    },
    {
        "name": "best_bench", "cli": "best-bench", "fn": "cmd_best_bench",
        "description": (
            "SEARCH a region for the level pad that costs the least earthwork, trying every "
            "position and orientation on a 1 m lattice and returning the balanced ones. Use "
            "this whenever you know the size of something but not yet its place — instead of "
            "asking slope at a handful of spots and picking one by eye. It excludes candidates "
            "on ground the scanner did not see, and a balanced pad means no soil has to leave "
            "the site."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "x0": {"type": "number"}, "y0": {"type": "number"},
                "x1": {"type": "number"}, "y1": {"type": "number"},
                "across": {"type": "number", "default": 4.0,
                           "description": "pad width across the fall, metres"},
                "along": {"type": "number", "default": 6.0,
                          "description": "pad length along the contour, metres"},
                "top": {"type": "integer", "default": 5,
                        "description": "how many candidates to return"},
            },
            "required": ["x0", "y0", "x1", "y1"],
        },
    },
    {
        "name": "near", "cli": "near", "fn": "cmd_near",
        "description": (
            "What is ALREADY at a spot — plants, paths, patios, edges and the owner's "
            "landmarks — within a radius, nearest first. Ask before placing anything, so you "
            "do not plant on your own path, crowd a mature spread, or bury something the owner "
            "clicked because it is really there. Cheap enough to ask at every position you are "
            "considering."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "x": {"type": "number"}, "y": {"type": "number"},
                "radius": {"type": "number", "default": 3.0},
                "design": {"type": "string", "description":
                           "path to a design variant; omit for the live data/design.json"},
            },
            "required": ["x", "y"],
        },
    },
    {
        "name": "usable_area", "cli": "usable-area", "fn": "cmd_usable_area",
        "description": (
            "WHERE THE GROUND IS GENTLE ENOUGH TO USE, as measured polygons — and, just as "
            "useful, which of the apparently flat ground is genuinely scanned rather than "
            "invented. Reach for it early, when deciding where a person should stand, sit or "
            "eat. Two things it is NOT. It is not a boundary: gentle ground is where terracing "
            "is CHEAPEST, not where building is allowed, and on a steep site only a few "
            "square metres may be naturally gentle, so a design confined to them could not "
            "have a terrace at all — set_patio exists to reserve flat ground by MAKING it, and best_bench prices "
            "that. And it is not taste: it says where the ground would let you stand, never "
            "that you would want to. Use it with best_pad/check_pad, which cost the earthwork."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "zone": {"type": "string",
                         "description": "which measured zone (see `zones`); the largest when omitted"},
                "max_slope": {"type": "number", "default": 9.0,
                              "description": "degrees counted as gentle"},
            },
        },
    },
    {
        "name": "zones", "cli": "zones", "fn": "cmd_zones",
        "description": (
            "The measured yards — their bounds, and how many m2 of each is usable as it "
            "stands, needs terracing, or should stay planting. Read this before deciding WHICH "
            "yard a brief is about: a landmark name alone does not establish which zone it "
            "is in. A zone is measured; use its bounds to locate the design."),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "scene", "cli": "scene", "fn": "cmd_scene",
        "description": (
            "Does a region compose as a PICTURE, or only as a plant list? `composition` tells "
            "you how much of the ground is planted; this tells you whether the planting does "
            "anything. It reports how many of the four body-scale height bands have something "
            "in them — a picture needs something to look over, something to look into and "
            "something to look up at, and a region sitting in one band is a texture rather "
            "than a scene — plus what the region does in each SEASON and how saturated its "
            "flower colours are. A corner with 27 plants in 6 species can still have only "
            "two forms, 2 of the 4 layers occupied, 18 of 27 flowering in spring with nothing "
            "in autumn, and every flower colour grey, even when the surrounding design "
            "occupies 4 layers and 6 seasons. Scope it with `area` to a region the owner "
            "drew, or `box`. "
            "Call it BEFORE you finish a bed and again once its planting is in, and ask it "
            "about any region the owner has singled out — it is how you find out that a "
            "corner the owner asked to be beautiful is one flat layer, which the plant list alone "
            "will never tell you. Use it alongside `composition`: that one says how much "
            "ground is planted, this one says whether the planting does anything. "
            "It MEASURES AND DOES NOT GRADE, like composition: a season with nothing in it is "
            "a fact, not a fault, and what the picture should be is the owner's."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "design": {"type": "string",
                           "description": "design file to measure; omit for the one you are editing"},
                "area": {"type": "string",
                         "description": "name of a region the owner drew, from `areas`"},
                "box": {"type": "string",
                        "description": "[x0,y0,x1,y1] to scope to a rectangle instead"},
            },
        },
    },
    {
        "name": "composition", "cli": "composition", "fn": "cmd_composition",
        "description": (
            "What your design is MADE OF right now: hardscape vs planted vs open as shares of "
            "the zone's real ground, the paving split into path/patio/steps, how much of that "
            "paving landed on steep ground, and bed area per plant. Every other tool here "
            "answers about ONE thing — this pad, that route — so a design can add one "
            "reasonable path at a time and end up a yard of paving with no single op ever "
            "looking wrong. Path area can nearly double while plant count falls by a third "
            "in MORE bed area. Call it partway through "
            "and again before you finish, the way a designer steps back and looks at the whole "
            "garden. It reports and does not grade — the right balance is the owner's taste, "
            "not a rule — so read the numbers and decide. Density near 1 m2/plant is a knitted "
            "drift; several times that is a specimen planting and reads as sparse. "
            "mature_coverage_by_bed is each bed at FULL maturity — design for full size: "
            "about 1.0-1.3x closes, 1.6x and over the plants grow into each other. A bed "
            "spaced for the ~5-year look can become crowded at maturity."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "design": {"type": "string",
                           "description": "design file to measure; omit for the one you are editing"},
                "zone": {"type": "string",
                         "description": "zone name; omit to get the zone your design is in"},
            },
        },
    },
    {
        "name": "areas", "cli": "areas", "fn": "cmd_areas",
        "description": (
            "The regions the owner DREW in the viewer, by name, with size and bounds. Call "
            "this first when the brief names a place — 'the railroad tie bit', 'the wood' "
            "— because these are owner ground truth, never inferred from a name, and a design "
            "can be scoped to one. Use `area` for the detail on a single region."),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "area", "cli": "area", "fn": "cmd_area",
        "description": (
            "Everything measurable about ONE region the owner drew: its ground range, grade "
            "breakdown, what it suits, and what is already inside it. Call it whenever the "
            "work is scoped to a named area — the validator REJECTS any op with a point "
            "outside it, so the bounds here are the ones your design has to live inside. It "
            "cannot tell you what a thing IS; use `look` for that."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "as listed by `areas`"},
                "design": {"type": "string", "description":
                           "path to a design variant; omit for the live data/design.json"},
            },
            "required": ["name"],
        },
    },
]

# What the model is shown. Derived from the specs above so the published schema
# and the schema the handler fills defaults from are the same object.
TOOLS += [{k: s[k] for k in ("name", "description", "inputSchema")} for s in SITE_TOOLS]


def _post(path, payload, timeout=45):
    req = urllib.request.Request(
        VIEWER + path, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Origin": VIEWER})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def _get(path, timeout=10):
    req = urllib.request.Request(VIEWER + path, headers={"Origin": VIEWER})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def _text(msg):
    return {"content": [{"type": "text", "text": msg}]}


def saved_viewpoints():
    """The cameras the OWNER placed, from the owner half of site.json.

    Stored in `look`'s own convention — x, y, and a height ABOVE THE GROUND — so
    a saved viewpoint IS a stored look() call and expanding one is a lookup, not
    a conversion. That is the whole reason the frame was chosen that way.
    """
    try:
        with open(project.data("site.json")) as f:
            return json.load(f).get("viewpoints") or []
    except Exception:
        return []


def do_look(args):
    eye, look_at = args.get("eye"), args.get("look_at")
    want = (args.get("viewpoint") or "").strip()
    if want:
        # NAMED, and matched case-insensitively: the user can type "kitchen window"
        # into a prompt box while a model asks for "Kitchen window".
        vps = saved_viewpoints()
        hit = next((v for v in vps if str(v.get("name", "")).lower() == want.lower()), None)
        if not hit:
            names = ", ".join(repr(v.get("name")) for v in vps) or "none saved yet"
            return _err(f"no saved viewpoint called {want!r}. Saved views: {names}. "
                        f"The owner places these in the viewer (Places -> Saved views); "
                        f"nothing can invent one.")
        eye, look_at = hit.get("eye"), hit.get("look_at")
    if args.get("render", "detailed") not in ("detailed", "photoreal"):
        return _err("render must be detailed or photoreal")
    if args.get("render") == "photoreal":
        r = do_photoreal({**args, "eye": eye, "look_at": look_at})
        if not r.get("isError") and eye and look_at:
            r["_views"] = [{"eye": list(eye[:2]), "look": list(look_at[:2]), "fov": args.get("fov_deg") or 55}]
        return r
    try:
        out = _post("/api/view/request", {
            "subject": args.get("subject"),
            "from": args.get("from", "grazing"),
            "distance_m": args.get("distance_m"),
            "fov_deg": args.get("fov_deg"),
            "show": args.get("show"),
            "eye": eye,
            "look_at": look_at,
        }, timeout=195)
    except urllib.error.URLError as e:
        return _err(f"The viewer is not reachable at {VIEWER} ({e.reason}). "
                     f"Start it with `cd viewer && npm run dev` and open the page.")
    if not out.get("ok"):
        detail = out.get("detail", "")
        return _err(f"Could not render: {out.get('error')}. {detail}".strip())

    m = out.get("meta", {})
    if m.get("render_quality") != "detailed" or m.get("growth") != "mature":
        return _err("The viewer did not confirm a full-detail mature review. Reload the viewer and retry.")
    with open(out["path"], "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    m = out.get("meta", {})
    lines = [f"view {out['id']} — {m.get('subject', args.get('subject'))}"]
    lines.append(f"render: {m.get('render_quality', 'unreported')}; plants: {m.get('growth', 'unreported')}; "
                 f"design: {m.get('design_source', 'unreported')}")
    # a free camera has no preset and no subject; saying "None" for both reads as
    # a failure when it is the caller having driven the camera itself
    if m.get("camera_from"):
        lines.append(f"camera: {m['camera_from']} at {m.get('camera_height_m')} m, "
                     f"eye ENU {m.get('camera_eye_enu')}")
    else:
        lines.append(f"camera: yours, eye ENU {m.get('camera_eye_enu')} at "
                     f"{m.get('camera_height_m')} m absolute"
                     + (f" ({m['ground_under_eye_m']} m ground under it)"
                        if m.get("ground_under_eye_m") is not None else ""))
    if m.get("ground_under_subject_m") is not None:
        lines.append(f"ground under the subject: {m['ground_under_subject_m']} m")
    elif m.get("ground_under_target_m") is not None:
        lines.append(f"ground under what you aimed at: {m['ground_under_target_m']} m")
    if "gap_under_object_m" in m:
        gap = m["gap_under_object_m"]
        lines.append(f"object base sits {m.get('object_bottom_m')} m, i.e. {gap} m above that ground"
                     + ("  <-- IT IS FLOATING; it is standing on a structure or on nothing"
                        if gap > 0.4 else ""))
    if m.get("overlays_shown"):
        lines.append(f"overlays painted on: {', '.join(m['overlays_shown'])}")
    elif m.get("overlays_available"):
        # say it every time it is NOT used: a capability the model has to remember
        # can go unused without a reminder
        lines.append(f"no overlays — you can ask for any of "
                     f"{', '.join(m['overlays_available'])} with show=[...]")
    lines.append(f"saved: {os.path.relpath(out['path'], ROOT)}")
    return {"structuredContent": m,
            "_views": [{"eye": m.get("camera_eye_enu"), "look": m.get("camera_look_enu"),
                        "fov": m.get("fov_deg", 55)}],
            "content": [{"type": "image", "data": b64, "mimeType": "image/jpeg"},
                        {"type": "text", "text": "\n".join(lines)}]}


def do_photoreal(view):
    """The same look tool, returning actual PNG bytes to either subscription CLI."""
    import photoreal
    if view.get("show"):
        return _err("Photoreal views do not draw diagnostic overlays; use render='detailed' with show.")
    if not os.path.isfile(photoreal.BLENDER):
        return _err(f"Blender is not installed at {photoreal.BLENDER}. Set PEDON_BLENDER to its executable.")
    with tempfile.TemporaryDirectory(prefix="yardeye-photoreal-") as folder:
        # Unique output and fresh geometry: a failed render cannot return yesterday's image.
        path = os.path.join(folder, "view_BEARING-UNVERIFIED.png")
        try:
            proc = photoreal.run_bounded(
                [sys.executable, os.path.join(ROOT, "tools", "photoreal.py"),
                 "--view-json", json.dumps(view), "--samples", "24",
                 "--width", "900", "--height", "576", "--out", path],
                cwd=ROOT, timeout=photoreal.REVIEW_TIMEOUT_S, memory_limit=None)
        except (RuntimeError, OSError) as error:
            return _err(str(error))
        try:
            result = json.loads(proc.stdout)
        except ValueError:
            return _err(f"Photoreal render failed: {proc.stderr[-600:]} {proc.stdout[-600:]}")
        if proc.returncode or not result.get("ok") or not os.path.isfile(path):
            return _err(result)
        from PIL import Image
        with Image.open(path) as rendered:
            if rendered.format != "PNG" or max(hi for lo, hi in rendered.convert("RGB").getextrema()) == 0:
                return _err("Photoreal output is invalid or completely black; no review image was returned.")
        with open(path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode()
    result.pop("image", None)  # the temporary source is gone; the image travels inline
    return {"content": [{"type": "image", "mimeType": "image/png", "data": b64},
                        {"type": "text", "text": json.dumps(result, indent=1)}]}


def do_list(_args):
    # AN EMPTY PROPERTY IS NOT AN EMPTY LIST. Both reads below swallow their
    # exceptions, so check for missing files first. An empty result with exit 0
    # implies there is nothing to look at, even when the property is not set up.
    # A refusal that exits 0 is indistinguishable from an answer downstream.
    #
    # A site.json that exists and holds no viewpoints yet IS an empty list, and
    # stays one — a fresh property legitimately has no saved views.
    have = [n for n in ("site.json", "design.json")
            if os.path.exists(project.data(n))]
    if not have:
        return _err({"error": "no_site",
                     "detail": "there is no data/site.json and no data/design.json — "
                               "nothing has been surveyed or designed on this property yet",
                     "fix": ['python3 tools/geodata.py --address "…"',
                             "cd viewer && npm run dev, then Fit ground / Set north",
                             "python3 tools/analyze_site.py"]})
    subjects = {"saved_views": [], "design_objects": [], "landmarks": [], "areas": []}
    # FIRST, because they are the only entries here the owner chose deliberately.
    # Everything else in this list is something the design or the site happens to
    # contain; a saved view is a statement about where the garden is judged from.
    try:
        with open(project.resolve((_args or {}).get("design") or "data/design.json")) as f:
            d = json.load(f)
    except Exception:
        d = {}
    # WHERE EACH STANDS AND WHAT IT FRAMES, against the design being judged: a saved camera can
    # outlive its walk — left inside a bed, framing the bed behind the one it is used to judge.
    # The owner's cameras are never moved; the reader is told.
    import agent as _a
    for v in saved_viewpoints():
        seen = {}
        if d and v.get("eye") and v.get("look_at"):
            try:
                seen = _a.camera_report({"eye": v["eye"], "look": v["look_at"], "fov": v.get("fov") or 55}, d)
            except Exception:                              # noqa: BLE001 - a report, never a crash
                seen = {}
        subjects["saved_views"].append(
            {"name": v.get("name"), "eye": v.get("eye"), "look_at": v.get("look_at"),
             **({"note": v["note"]} if v.get("note") else {}), **seen})
    try:
        for k in ("beds", "paths", "patios", "edges", "steps"):
            subjects["design_objects"] += [o["id"] for o in d.get(k, [])]
        subjects["design_objects"] += [p["id"] for p in d.get("plants", [])][:12]
    except Exception:
        pass
    try:
        with open(project.data("site.json")) as f:
            s = json.load(f)
        subjects["landmarks"] = [l["name"] for l in s.get("landmarks", [])]
        subjects["areas"] = [a["name"] for a in s.get("areas", [])]
    except Exception:
        pass
    return _text(json.dumps(subjects, indent=1))


def do_ground_contact(args):
    """Every object at once, rather than one flattering camera angle."""
    try:
        out = _post("/api/view/request",
                    {"op": "float_check",
                     "tolerance_m": args.get("tolerance_m", 0.4),
                     "limit": 40})
    except urllib.error.URLError as e:
        return _err(f"The viewer is not reachable at {VIEWER} ({e.reason}). "
                     f"Start it with `cd viewer && npm run dev` and open the page.")
    if not out.get("ok"):
        return _err(f"Could not check: {out.get('error')} {out.get('detail', '')}".strip())
    d = out["data"]
    lines = [f"{d['checked']} objects checked at {d['tolerance_m']} m tolerance",
             d["verdict"], ""]
    # lead with the failures; the model should not have to scan a table for them
    bad = [r for r in d["worst"] if r["gap_m"] > d["tolerance_m"]]
    if bad:
        lines.append("FLOATING — these hang clear of the ground over their whole footprint:")
        for r in bad:
            lines.append(f"  {r['id']} at ENU {r['enu'][0]},{r['enu'][1]}: base {r['bottom_m']} m, "
                         f"ground {r['ground_min_m']}..{r['ground_max_m']} m, gap {r['gap_m']} m")
        lines.append("")
        lines.append("Fix by lowering each object to its ground, or by adding the retaining "
                     "structure that would actually hold it up.")
    else:
        lines.append("Nothing floats. Largest gap: "
                     + (f"{d['worst'][0]['id']} at {d['worst'][0]['gap_m']} m"
                        if d.get("worst") else "n/a"))
    return _text("\n".join(lines))


def find_steps(points, riser_m=0.08, window_m=0.25):
    """Where a fine profile changes level SHARPLY: [{at_m, x, y, from_m, to_m, change_m}].

    A step is a change of at least `riser_m` inside `window_m` of travel that the
    ground on either side does not share — so a steady 20% bank (0.05 m per 0.25 m)
    is not one, and a 0.2 m timber is. Adjacent hits merge into one step, reported
    at its steepest sample, with the level taken just clear of it on both sides.
    """
    pts = [p for p in points if p.get("z") is not None]
    if len(pts) < 3:
        return []
    hits = []
    j = 0
    for i, p in enumerate(pts):
        while j < len(pts) - 1 and pts[j]["d"] - p["d"] < window_m:
            j += 1
        dz = pts[j]["z"] - p["z"]
        if abs(dz) >= riser_m and pts[j]["d"] - p["d"] <= window_m * 1.5:
            hits.append((i, j, dz))
    steps, k = [], 0
    while k < len(hits):
        run = [hits[k]]
        while k + 1 < len(hits) and hits[k + 1][0] <= run[-1][1] and (hits[k + 1][2] > 0) == (run[0][2] > 0):
            k += 1
            run.append(hits[k])
        k += 1
        i0, j1 = run[0][0], run[-1][1]
        # the step IS where one sample differs most from the next, not the window's middle
        k2 = max(range(i0, j1), key=lambda n: abs(pts[n + 1]["z"] - pts[n]["z"]))
        at = pts[k2 + 1]
        steps.append({"at_m": round(at["d"], 2), "x": at["x"], "y": at["y"],
                      "from_m": round(pts[i0]["z"], 2), "to_m": round(pts[j1]["z"], 2),
                      "change_m": round(pts[j1]["z"] - pts[i0]["z"], 2)})
    return steps


def do_scan_profile(args):
    """The mesh itself along a line — the 1 m grid cannot see a timber edging."""
    a, b = args.get("from"), args.get("to")
    if not (isinstance(a, list) and isinstance(b, list) and len(a) >= 2 and len(b) >= 2):
        return _err("scan_profile needs from:[x,y] and to:[x,y] in ENU metres")
    step = min(1.0, max(0.02, float(args.get("step_m") or 0.05)))
    length = math.hypot(b[0] - a[0], b[1] - a[1])
    if length / step > 4000:
        return _err(f"{length:.1f} m at {step} m is {length / step:.0f} samples — raise step_m or shorten the line")
    try:
        out = _post("/api/view/request", {"op": "scan_profile", "from": a[:2], "to": b[:2], "step_m": step})
    except urllib.error.URLError as e:
        return _err(f"The viewer is not reachable at {VIEWER} ({e.reason}). "
                     f"Start it with `cd viewer && npm run dev` and open the page.")
    if not out.get("ok"):
        return _err(f"Could not profile: {out.get('error')} {out.get('detail', '')}".strip())
    pts = out["data"]["points"]
    hit = [p for p in pts if p.get("z") is not None]
    steps = find_steps(pts, float(args.get("riser_m") or 0.08))
    every = max(1, round(0.5 / step))
    return _text(json.dumps({
        "from": a[:2], "to": b[:2], "length_m": round(length, 2), "step_m": step,
        "samples": len(pts), "on_scan": len(hit),
        "start_m": hit[0]["z"] if hit else None, "end_m": hit[-1]["z"] if hit else None,
        "steps": steps,
        "line_every_half_metre": [[p["d"], p["z"]] for p in pts[::every]],
        "note": "z is the scan surface (lowest hit under anything overhanging), metres in the "
                "site's own datum, the same one `ground` answers in. `top` in the raw reply is "
                "the HIGHEST hit, so z != top means something overhangs that spot.",
    }, indent=1))


def _log_call(cli, args, **evidence):
    """Record the call the way site_api.main() records a CLI one, plus via=mcp.

    Same file on purpose: the traffic question is "how is the model asking", and
    an answer split across two logs cannot be compared. Logging must never break
    a query, so every failure here is swallowed — the CLI's copy does the same.
    """
    try:
        with open(CALL_LOG or project.data("site_api_calls.log"), "a") as lf:
            lf.write(json.dumps({"cmd": cli, "via": "mcp", "args": args,
                                 **evidence}) + "\n")
    except Exception:
        pass


def _err(payload):
    """An error the model can read, in the same words the CLI prints for it."""
    text = payload if isinstance(payload, str) else json.dumps(payload)
    return {"content": [{"type": "text", "text": text}], "isError": True}


def do_site(spec, args):
    """Run one site_api query and hand back exactly what the CLI would print.

    The arguments are marshalled into the argparse.Namespace site_api's cmd_
    functions already take, so this layer adds no arithmetic of its own — the
    only thing it can get wrong is the marshalling, and tests/test_mcp_site.py
    compares every tool against the CLI's own stdout for that reason.
    """
    if site_api is None:
        return _err({"error": f"site queries are unavailable: {_SITE_IMPORT_ERROR}",
                     "fallback": "python3 tools/site_api.py — same answers, one process per call"})
    schema = spec["inputSchema"]
    props = schema.get("properties", {})
    missing = [k for k in schema.get("required", ()) if args.get(k) is None]
    if missing:
        # LOGGED. A refusal must leave evidence that the model asked and was
        # refused; returning without logging hides the call.
        _log_call(spec["cli"], args, ok=False, refused=f"missing {','.join(missing)}")
        return _err({"error": f"{spec['name']} needs {', '.join(missing)}",
                     "expects": {k: props.get(k, {}).get("description", props.get(k, {}).get("type"))
                                 for k in schema.get("required", ())}})
    ns = {}
    for k, p in props.items():
        v = args.get(k, p.get("default"))       # the schema is the only copy of a default
        if k in spec.get("json_args", ()) and v is not None and not isinstance(v, str):
            v = json.dumps(v)                   # site_api parses these itself, and rejects them
        ns[k] = v
    # AFTER the call, carrying what happened. The request alone cannot answer
    # "was the agent refused, and did it understand why", which is half of what
    # this log is for. `looked_at_own_work` reads `cmd` and `rendered`, so extra
    # fields are safe.
    try:
        out = getattr(site_api, spec["fn"])(argparse.Namespace(**ns))
    except Exception as e:                      # site_api.main() prints exactly this and exits 1
        _log_call(spec["cli"], args, ok=False, refused=f"{type(e).__name__}")
        return _err({"error": f"{type(e).__name__}: {e}"})
    text = json.dumps(out, indent=1)            # what `site_api.py <cmd>` prints, byte for byte
    if isinstance(out, dict) and out.get("error"):
        _log_call(spec["cli"], args, ok=False, refused=str(out["error"])[:120])
        return {"content": [{"type": "text", "text": text}], "isError": True}
    if isinstance(out, dict) and (out.get("no_scan") or out.get("no_site")):
        _log_call(spec["cli"], args, ok=False,
                  refused="no_scan" if out.get("no_scan") else "no_site")
        return _text(text)
    _log_call(spec["cli"], args, ok=True)
    return _text(text)


def do_preview(args):
    try:
        out = _post("/api/view/request",
                    {"op": "preview", "path": args.get("path")})
    except urllib.error.URLError as e:
        return _err(f"The viewer is not reachable at {VIEWER} ({e.reason}).")
    if not out.get("ok"):
        return _err(f"Could not switch: {out.get('error')} {out.get('detail','')}".strip())
    d = out.get("data", {})
    return _text(f"now rendering: {d.get('previewing')}\n{d.get('note','')}")


WHEN_WORDS = {
    "summer_evening": ("06-21", 18), "summer_noon": ("06-21", 12),
    "winter_noon": ("12-21", 12),    "winter_morning": ("12-21", 9),
    "equinox": ("03-20", 12),        "equinox_evening": ("03-20", 17),
}


def do_sun(args):
    """Through tools/sun.py — one sun model, not a second one written here."""
    import datetime as _dt
    when = str(args.get("when") or "equinox").strip()
    if when in WHEN_WORDS:
        md, hr = WHEN_WORDS[when]
        when = f"{_dt.date.today().year}-{md} {hr:02d}:00"
    date, _, clock = when.partition(" ")
    # LOCAL time, not UTC. Asking for "summer_evening" and being handed 18:00 UTC
    # returns a true solar time of 9.8 h — morning sun — and a designer told to face
    # east for the evening light gets the wrong bearing. Offset from the site's own
    # longitude (lon/15, rounded): approximate by up to an hour against civil time,
    # and far closer than pretending the yard is in Greenwich.
    off = 0
    try:
        with open(project.data("site.json")) as f:
            lon = (json.load(f).get("origin") or {}).get("lon")
        if lon is not None:
            off = round(lon / 15)
    except Exception:
        pass
    cmd = (["zone", args["zone"]] if args.get("zone")
           else ["position", "--date", date]
                + (["--time", clock] if clock else [])
                + ["--utc-offset", str(off)])
    r = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "sun.py"), *cmd],
                       capture_output=True, text=True, timeout=60)
    out = r.stdout.strip() or r.stderr.strip()
    try:
        d = json.loads(out)
    except ValueError:
        return _text(f"sun.py said: {out[:400]}")
    if d.get("refused"):
        return _text("REFUSED — " + d.get("reason", "") + "\nfix: " +
                     "; ".join(d.get("fix", [])) +
                     "\nAltitude and day length are still available (they need only "
                     "latitude); it is the BEARING that is unknowable until north is set.")
    return _text(json.dumps(d, indent=1))


def do_list_assets(args):
    """What the library can build. Asking for something it lacks stays legitimate."""
    want = (args.get("kind") or "").strip().lower()
    out = {}
    if want in ("", "plants"):
        try:
            with open(project.resolve("assets/plants/manifest.json")) as f:
                man = json.load(f)
            # the manifest is name -> spec, not a list of records
            rows = man if isinstance(man, dict) else {r.get("id") or r.get("name"): r for r in man}
            out["plant_models"] = sorted(
                f"{k} ({v.get('height_m')} m)" if isinstance(v, dict) and v.get("height_m") else k
                for k, v in rows.items())
            out["plants_note"] = ("a species that matches none of these routes to its "
                                  "growth FORM, which is a real shape, not a failure")
        except Exception as e:
            out["plant_models"] = f"unreadable: {e}"
        # The OWNER'S OWN shortlist for this climate, with mature sizes and
        # colours already resolved. Copy these from the assets into plant ops to
        # reduce time and LLM cost. Do not recall them from memory: a mature
        # height in a given climate is a fact about a plant, not something to
        # estimate per design. Every row is verified to
        # render (tests/js/palette_renders.test.mjs).
        try:
            from plant_catalog import catalog      # the one reader of the user's catalogue
            pal = catalog()
            rows = pal["plants"]
            want_form = (args.get("form") or "").strip().lower()
            if want_form:
                rows = [r for r in rows if r["form"] == want_form]
            if args.get("native_only"):
                rows = [r for r in rows if r["ca_native"]]
            if args.get("cat_safe_only"):
                # TRUE only. `None` means NOT ASSESSED and must never pass a
                # cat-safety filter — where cats have the run of a garden, a
                # design tool guessing at toxicity is the worst answer available.
                rows = [r for r in rows if r.get("cat_safe") is True]
            mx = args.get("max_height_m")
            if mx is not None:
                rows = [r for r in rows if r["mature_height_m"] <= float(mx)]
            out["palette_for"] = pal.get("for", "")
            if not pal["plants"]:
                out["palette_note"] = ("the library has no plant catalogue yet — choose species yourself, "
                                       "giving each plant its mature height and spread in metres")
            out["palette"] = [
                f"{r['species']} ({r['common']}) | {r['form']} "
                f"{r['mature_height_m']}x{r['mature_spread_m']} m | {r['water']} water | "
                f"{r['sun']} | {'CA native' if r['ca_native'] else 'non-native'} | "
                f"{'evergreen' if r['evergreen'] else 'deciduous'} | foliage {r['foliage']} "
                f"flower {r['flower']} | "
                f"{'ASPCA non-toxic (' + r.get('cat_safety', {}).get('evidence_scope', 'taxon') + ' evidence)' if r.get('cat_safe') is True else 'EXCLUDED: CAT TOXICITY FLAGGED' if r.get('cat_safe') is False else 'cat safety unverified'}"
                f" | identity: {r.get('identity_status', 'unverified')}"
                f" | size: {r.get('size_evidence', {}).get('status', 'unverified')}"
                f" | establishment irrigation required"
                f" | {r['note']}" for r in rows]
            out["palette_note"] = (
                "Catalog includes the owner's candidates and retained legacy entries; inclusion is not approval for planting. "
                "Never introduce a known cat-toxic plant. Unknown safety and generic identities need confirmation before final selection. "
                "Species evidence does not certify every cultivar or other members of its genus. "
                "Copy species, common, form, foliage, flower and mature dimensions into a plant op. "
                "Dimensions marked as estimates require local confirmation; use mature spread, not pot/plug size. "
                "All plants need establishment irrigation. Conditional sedges, reed grass, strawberry and coral bells need cooler/irrigated areas. "
                "Filter with form/native_only/cat_safe_only/max_height_m; generated geometry is an approximation.")
            out['palette_evidence'] = {r['species']: {
                'cat_safety': r.get('cat_safety'), 'size_evidence': r.get('size_evidence'),
                'mature_height_range_m': r.get('mature_height_range_m'),
                'mature_spread_range_m': r.get('mature_spread_range_m'),
                'flowering_height_range_m': r.get('flowering_height_range_m'),
                'site_zone': r.get('site_zone'), 'model_quality': r.get('model_quality')
            } for r in rows}
        except Exception as e:
            out["palette"] = f"unreadable: {e}"
    if want in ("", "objects"):
        try:
            src = open(os.path.join(ROOT, "viewer", "src", "objects.js")).read()
            import re as _re
            m = _re.search(r"const BUILDERS = \{(.*?)\n\};", src, _re.S)
            out["object_kinds"] = sorted(_re.findall(r"^\s{2}(\w+):", m.group(1), _re.M)) if m else []
            out["objects_note"] = ("kind is FREE TEXT. Anything not listed draws as a "
                                   "marked placeholder at the size you give and is "
                                   "recorded as a WANT for the owner — ask for what the "
                                   "design needs, not for what happens to be modelled. "
                                   "Better than a placeholder: find_asset, then fetch_asset "
                                   "or make_asset, and place it with its `model`")
            import asset_store
            out["object_models"] = [{"name": c.get("name"), "kind": c.get("kind"), "model": c["model"],
                                     "size_m": c.get("size_m"), "from": (c.get("source") or {}).get("from", "scan")}
                                    for c in asset_store.library()]
        except Exception as e:
            out["object_kinds"] = f"unreadable: {e}"
    if want in ("", "materials"):
        try:
            sys.path.insert(0, os.path.join(ROOT, "tools"))
            import agent as _a
            out["path_materials"] = list(_a.PATH_MATERIALS)
            # Names alone say steel exists and nothing about WHEN steel is right.
            # Each material comes with its section and what it is for.
            out["edge_materials"] = {
                m: {"thickness_m": sec["thickness_m"], "batter_deg": sec["batter_deg"],
                    "footing_depth_m": sec["footing_depth_m"],
                    "suits": _a.EDGE_SUITS.get(m, "")}
                for m, sec in sorted(_a.EDGE_SECTION.items())}
            out["materials_are_free_text"] = (
                "These are what the library DRAWS AS ITSELF — not a menu you must choose "
                "from. material is FREE TEXT on paths, patios, edges and steps: ask for "
                "brick, a stone-sett nobedan, a pebble-mosaic court, a timber boardwalk, "
                "gabion, rammed earth. Anything unmodelled still renders (as the nearest "
                "surface, paving for paving and mulch for mulch), is flagged in the "
                "validator's warnings, and goes on the OWNER'S want list so they can decide "
                "whether to have it built. Naming what the design actually needs is worth "
                "more than picking the closest word off this list — the hardscape IS the "
                "style, and a closed enum can reduce Mediterranean / Japanese / Chinese "
                "fusion to gravel and planting.")
            out["edges_note"] = ("an edge is a LINE with a height, so the same op makes a "
                                 "mowing strip and a retaining wall; the material decides "
                                 "which. On a grade, retaining a bed with corten_steel or "
                                 "dry_stone is usually cheaper and less visually heavy than "
                                 "flattening more ground, and `boulder` is set stone rather "
                                 "than a wall.")
        except Exception as e:
            out["materials"] = f"unreadable: {e}"
    return _text(json.dumps(out, indent=1))


def do_walkthrough(args):
    """Stand in the design and look, at every station along its own routes.

    The critique belongs inside the design loop so the agent sees what it builds
    before finishing. Visual review catches defects that measurements alone miss:
    beds standing on a deck, planting above the ground after a north calibration,
    and a path whose line looks wrong despite passing the numeric checks.
    """
    n = int(args.get("stations") or 6)
    try:
        out = _post("/api/view/request", {"op": "walkthrough", "n": n}, timeout=195)
    except urllib.error.URLError as e:
        return _err(f"The viewer is not reachable at {VIEWER} ({e.reason}). "
                     f"Start it with `cd viewer && npm run dev` and open the page.")
    if not out.get("ok"):
        return _err(f"Could not walk it: {out.get('error')} {out.get('detail','')}".strip())
    d = out.get("data") or {}
    if d.get("render_quality") != "detailed" or d.get("growth") != "mature":
        return _err("The viewer did not confirm a full-detail mature walkthrough. Reload the viewer and retry.")
    frames = d.get("frames") or []
    if not frames:
        return _text(d.get("note", "nothing to walk yet"))
    content = []
    for f in frames:
        url = f.get("dataUrl") or ""
        b64 = url.split(",", 1)[1] if "," in url else ""
        if not b64:
            continue
        content.append({"type": "image", "data": b64, "mimeType": "image/jpeg"})
        content.append({"type": "text", "text":
                        f"{f.get('name')} — standing at ENU {f.get('eye')}, "
                        f"ground {f.get('ground_m')} m"})
    content.append({"type": "text", "text":
        d.get("note", "") + "\n\nJudge the LINE of the path here, not its numbers: "
        "a route can read as drawn with a ruler even when its measurements pass. "
        "If a walk looks like a road, it is one."})
    return {"content": content,
            "_views": [{"eye": f.get("eye"), "look": f.get("look"), "fov": 62}
                       for f in frames if f.get("dataUrl")]}


def do_sightline(args):
    """Does the ground block the view? Straight line of sight against the raycast."""
    sys.path.insert(0, os.path.join(ROOT, "tools"))
    import agent as _a
    (ax, ay), (bx, by) = args["from"][:2], args["to"][:2]
    eye = float(args.get("eye_m", 1.65)); tgt = float(args.get("target_m", 1.2))
    ga, gb = _a.scan_at(ax, ay), _a.scan_at(bx, by)
    if ga is None or gb is None:
        return _text(json.dumps({"clear": None, "reason":
            "one end is not on scanned ground, so nothing here is measured"}, indent=1))
    a_h, b_h = ga + eye, gb + tgt
    dist = ((bx-ax)**2 + (by-ay)**2) ** 0.5
    steps = max(2, int(dist / 0.5))
    worst, worst_at = -1e9, None
    for i in range(1, steps):
        t = i / steps
        x, y = ax + (bx-ax)*t, ay + (by-ay)*t
        g = _a.scan_at(x, y)
        if g is None: continue
        sight = a_h + (b_h - a_h) * t
        if g - sight > worst:
            worst, worst_at = g - sight, (round(x, 2), round(y, 2))
    clear = worst < 0
    return _text(json.dumps({
        "clear": clear,
        "blocked_by_m": None if clear else round(worst, 2),
        "highest_obstruction_at": worst_at,
        "distance_m": round(dist, 1),
        "note": ("the view is open along this line" if clear else
                 f"the ground rises {worst:.2f} m through the line of sight at {worst_at} — "
                 f"a seat here does not see that. Lower the target, move the seat, or cut."),
        "ground_only": "terrain only; planting and structures are not occluders here",
    }, indent=1))


def _asset_reply(card, preview_path, extra=None):
    """A card as text and its picture as an image, so the asker can look before using it."""
    content = [{"type": "text", "text": json.dumps({**card, **(extra or {})}, indent=1)}]
    path = project.resolve(preview_path or "")
    if preview_path and os.path.isfile(path):
        with open(path, "rb") as f:
            content.append({"type": "image", "mimeType": "image/png", "data": base64.b64encode(f.read()).decode()})
    return {"content": content}


def do_find_asset(args):
    import asset_store
    try:
        found = asset_store.find(args.get("query", ""), plant=bool(args.get("plant")))
    except asset_store.AssetError as e:
        return _err({"error": str(e)})
    content = [{"type": "text", "text": json.dumps(found, indent=1)}]
    # the first few online candidates as PICTURES: a name is not enough to choose a lantern by
    for c in [c for c in found.get("polyhaven", []) if not c["too_heavy"]][:4]:
        try:
            png = asset_store._get(c["thumbnail"], timeout=15)
            content.append({"type": "text", "text": f"{c['id']} — {c['size_m']} m"})
            content.append({"type": "image", "mimeType": "image/png", "data": base64.b64encode(png).decode()})
        except Exception:                      # a missing thumbnail is not a failed search
            pass
    return {"content": content}


def do_fetch_asset(args):
    import asset_store
    try:
        card = asset_store.fetch(args["id"], args.get("name"), args.get("kind"),
                                 species=args.get("species"))
    except asset_store.AssetError as e:
        return _err({"error": str(e)})
    return _asset_reply(card, card.get("preview"), _plant_use(card))


def _plant_use(card):
    """How a PLANT model is used — said in the reply, because it is not place_object."""
    if not card.get("asset"):
        return None
    return {"use": f'place_plants (or set_plants) {card.get("species")} with "asset": '
                   f'"{card["asset"]}" — the viewer draws this model at each plant\'s mature '
                   "height and spread, in place of the species' built-in shape"}


def do_make_asset(args):
    import asset_store
    try:
        card = asset_store.make(args["name"], args["script"], args.get("size_m"), args.get("kind"),
                                species=args.get("species"))
    except asset_store.AssetError as e:
        r = _asset_reply({"error": str(e)}, e.preview)
        r["isError"] = True
        return r
    return _asset_reply(card, card.get("preview"), _plant_use(card))


def _design_arg(args):
    path = args.get("design") or "data/design.json"
    full = project.resolve(path)          # "data/…" is the active project's
    if not os.path.isfile(full):
        raise FileNotFoundError(f"no design file {path}")
    with open(full) as f:
        return path, json.load(f)


def _png_block(path):
    with open(path, "rb") as f:
        return {"type": "image", "mimeType": "image/png", "data": base64.b64encode(f.read()).decode()}


def do_plan(args):
    import site_plan
    try:
        path, design = _design_arg(args)
    except (FileNotFoundError, ValueError) as e:
        return _err({"error": str(e)})
    with tempfile.TemporaryDirectory(prefix="pedon-plan-") as d:
        out = os.path.join(d, "plan.png")
        info = site_plan.render(out, design, bounds=args.get("bounds"), scale=args.get("scale"),
                                title=os.path.basename(path))
        summary = {k: info[k] for k in ("bounds", "scale_px_per_m", "plants", "codes")}
        return {"content": [{"type": "text", "text": json.dumps(summary)}, _png_block(out)]}


def do_compose_planting(args):
    import compose
    import site_plan
    try:
        path, design = _design_arg(args)
    except (FileNotFoundError, ValueError) as e:
        return _err({"error": str(e)})
    comp = {k: args[k] for k in ("masses", "place", "beds", "replace_in", "keep") if args.get(k) is not None}
    site_path = project.data("site.json")
    site = json.load(open(site_path)) if os.path.exists(site_path) else None
    try:
        ops, new, report = compose.compose(design, comp, site=site)
    except (KeyError, ValueError) as e:
        return _err({"error": e.args[0] if e.args else str(e)})
    preview = json.loads(json.dumps(design))
    for op in ops:
        if op["tool"] == "upsert_bed":
            preview["beds"] = [b for b in preview.get("beds", []) if b["id"] != op["input"]["id"]] + [op["input"]]
    preview["plants"] = [p for p in preview.get("plants", []) if p["id"] not in report["removed"]] + \
        [dict(p, id=f"new{i}") for i, p in enumerate(new)]
    text = {"ops": ops, "report": report,
            "next": f"look at the plan; change the drifts or send these ops with apply-ops --design {path}"}
    with tempfile.TemporaryDirectory(prefix="pedon-compose-") as d:
        out = os.path.join(d, "plan.png")
        site_plan.render(out, preview, title="proposed — not applied")
        return {"content": [{"type": "text", "text": json.dumps(text)}, _png_block(out)]}


HANDLERS = {"look": do_look, "sun": do_sun, "list_assets": do_list_assets,
            "plan": do_plan, "compose_planting": do_compose_planting,
            "find_asset": do_find_asset, "fetch_asset": do_fetch_asset, "make_asset": do_make_asset,
            "walk_through": do_walkthrough,
            "sightline": do_sightline, "preview_design": do_preview, "list_viewpoints": do_list,
            "check_ground_contact": do_ground_contact, "scan_profile": do_scan_profile}
HANDLERS.update({s["name"]: functools.partial(do_site, s) for s in SITE_TOOLS})


def call_tool(name, args):
    """The shared MCP/CLI dispatch, including truthful render evidence."""
    import agent
    agent.follow_project()        # this server outlives a project switch in the viewer
    fn = HANDLERS.get(name)
    try:
        result = fn(args) if fn else _err({"error": f"no tool {name}"})
    except Exception as e:
        result = _err({"error": f"{type(e).__name__}: {e}"})
    rendered = (not result.get("isError") and any(
        c.get("type") == "image" and c.get("data") for c in result.get("content", [])))
    # A drawing tool returning text alone is a refusal, even if its
    # handler omits isError. Log AFTER it answers, never on the attempt.
    if name in ("look", "walk_through") and not rendered:
        result["isError"] = True
    # WHAT EACH FRAME WAS AIMED AT, so the gate can ask whether the design was
    # looked at where it CHANGED. Private to the log: the model is not sent it twice.
    views = result.pop("_views", None)
    if name not in {t["name"] for t in SITE_TOOLS}:
        _log_call(name, args, rendered=bool(rendered), ok=not result.get("isError", False),
                  **({"views": views} if rendered and views else {}))
    import agent
    note = agent.budget_from_env(name)
    if note:
        result.setdefault("content", []).append({"type": "text", "text": note})
    return result


def cli(argv):
    """Use the same eyes from a running session without registered MCP tools.

    Images are saved under unique names; the session must open them with its
    image-viewing tool. No base64 wall of text and no stale frame filenames.
    """
    ap = argparse.ArgumentParser(description=cli.__doc__)
    ap.add_argument("tool", choices=sorted(HANDLERS))
    ap.add_argument("arguments", nargs="?", default="{}", help="JSON tool arguments")
    ap.add_argument("--output-dir", default=None)
    ap.add_argument("--name", default=None,
                    help="save the image as NAME.jpg/.png in --output-dir (NAME-2... for more), so a "
                         "review folder reads as what each view is instead of random names")
    args = ap.parse_args(argv)
    try:
        params = json.loads(args.arguments)
        if not isinstance(params, dict):
            raise ValueError("arguments must be a JSON object")
    except ValueError as e:
        ap.error(str(e))
    result = call_tool(args.tool, params)
    folder = project.resolve(args.output_dir) if args.output_dir else None   # review/… is the site's
    n = 0
    for block in result.get("content", []):
        if block.get("type") != "image":
            continue
        if folder is None:
            folder = tempfile.mkdtemp(prefix="yardeye-")
        os.makedirs(folder, exist_ok=True)
        suffix = ".png" if block.get("mimeType") == "image/png" else ".jpg"
        data = base64.b64decode(block.pop("data"), validate=True)
        n += 1
        if args.name:
            target = os.path.join(folder, f"{args.name}{'' if n == 1 else f'-{n}'}{suffix}")
            with open(target, "wb") as f:
                f.write(data)
            block["path"] = os.path.abspath(target)
            continue
        with tempfile.NamedTemporaryFile(dir=folder, suffix=suffix, delete=False) as f:
            f.write(data)
            block["path"] = os.path.abspath(f.name)
    print(json.dumps(result, indent=2))
    return 1 if result.get("isError") else 0


def send(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        mid, method = req.get("id"), req.get("method")
        if method == "initialize":
            send({"jsonrpc": "2.0", "id": mid, "result": {
                "protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                "serverInfo": {"name": "yardeye", "version": "0.1"}}})
        elif method == "notifications/initialized":
            pass
        elif method == "tools/list":
            send({"jsonrpc": "2.0", "id": mid, "result": {"tools": TOOLS}})
        elif method == "tools/call":
            name = req.get("params", {}).get("name")
            args = req.get("params", {}).get("arguments", {}) or {}
            send({"jsonrpc": "2.0", "id": mid, "result": call_tool(name, args)})
        elif mid is not None:
            send({"jsonrpc": "2.0", "id": mid,
                  "error": {"code": -32601, "message": f"no method {method}"}})


if __name__ == "__main__":
    if len(sys.argv) > 1:
        sys.exit(cli(sys.argv[1:]))
    main()
