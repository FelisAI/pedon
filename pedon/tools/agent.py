"""PEDON design agent — subscription CLIs edit data/design.json. No API keys.

Backends (each must already be logged in):
  claude (default)  `claude -p -` on a Claude subscription, prompt via stdin,
                    structured output enforced with --json-schema.
  codex             `codex exec` on a ChatGPT subscription (a one-shot call
                    with --output-last-message).

Protocol: the model returns ONE JSON object {ops:[{tool,input}...], summary,
confidence, cautions} — ops are applied locally through deterministic
validators (schema, house-footprint collision, bounds, one plant per hole). Invalid ops
trigger one retry with the error messages attached. The model never touches
the file; this script does.

Usage:
  python tools/agent.py "curve the path toward the patio and add three shrubs"
  python tools/agent.py --backend codex "swap the front bed to drought-tolerant natives"
  python tools/agent.py --test 10          # reliability check (pass >= 8/10)
"""
from __future__ import annotations
import geom
import project   # where the active project's files are — the ONE owner
import argparse
import copy
import datetime as dt
import inspect
import json
import math
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# The ACTIVE PROJECT's working design and site (tools/project.py). Module globals because
# tests repoint them; a long-lived process (the MCP server) calls follow_project() so a
# project switched in the viewer is followed rather than written across.
DESIGN_PATH = project.data("design.json")
SITE_PATH = project.data("site.json")
_FOLLOWING = project.folder()


def follow_project():
    """Re-point this module at the active project if it changed since the last call, and drop
    what was cached from the old one. Returns the project folder."""
    global DESIGN_PATH, SITE_PATH, _FOLLOWING, _TERRAIN, _SCAN
    now = project.folder()
    if now != _FOLLOWING:
        DESIGN_PATH, SITE_PATH, _FOLLOWING = project.data("design.json"), project.data("site.json"), now
        _TERRAIN = _SCAN = None
    return now
SCHEMA_PATH = os.path.join(ROOT, "schema", "design.schema.json")

PATH_MATERIALS = ["flagstone", "paver", "gravel", "decomposed_granite", "concrete", "stepping_stones"]
# A patio may also be decked or grassed; a path may not.
PATIO_MATERIALS = PATH_MATERIALS + ["deck", "lawn"]

# These are what the renderer DRAWS AS ITSELF, not what a design may ask for.
# Material is free text because the library must not limit the design: a Japanese
# nobedan, a Chinese pebble-mosaic court and a plain brick path must be expressible.
# An unmodelled material still renders as the nearest surface and says so, rather
# than rejecting the design or silently substituting a material.

# ── the limits this site is judged against ────────────────────────────────
# These are REGULATORY and SOIL numbers, not physics. 1.2 m is roughly the 4-foot
# trigger for an engineered retaining wall and a permit in California; a site in
# another jurisdiction has a different number, and
# the whole point of PEDON is that it works on any site. site.json already
# knows the address, so the limits live beside it in site.constraints and this
# table is only the fallback for a site.json without that block.
#
# ONE table, and ONE function that reads it. site_api re-exports constraints()
# rather than keeping its own copy, so the tool that sizes a pad and the validator
# that judges it use the same limits. Separate ground lookups can differ by up to
# 0.99 m on the same site; shared measurements prevent that disagreement too.
#
# geodata.py does not seed this block. Sites without it use the numbers below.
DEFAULT_CONSTRAINTS = {
    "retain_limit_m": 1.2,        # tallest wall an edge may hold, and the cut/fill cap
    "footing_threshold_m": 0.6,   # above this a face wants an engineered footing
    "edge_min_height_m": 0.05,    # below this an edge is not a thing you can build
    "path_level_limit_m": 1.0,    # a walk is narrower than a bench, so it gets less
    "walk_grade": 0.08,           # 8% — the limit for a ramp with no steps
    "max_grade": 0.20,            # above 20% a route needs steps, not a ramp
    "step_riser_max_m": 0.18,     # tallest comfortable outdoor riser
    "step_going_min_m": 0.28,     # shallowest comfortable tread
    "terrace_setback_ratio": 1.0,  # how far behind a wall the next bench must start,
                                   # as a multiple of that wall's exposed height
    "wall_stack_setback_ratio": 2.0,  # and how far behind it the next WALL must start.
                                      # Twice, not once: a bench is a surface load,
                                      # a second wall is a whole structure, and below
                                      # this the two stop acting independently.
}

# ── what a wall is built out of ───────────────────────────────────────────
# An edge must state thickness, batter and footing as well as
# id/spline/height_m/material/retains/level_m: the validator cannot check a
# property the format cannot express, including the setback of two 1.5 m walls
# standing 1.6 m apart.
#
# These are the SAME numbers as viewer/src/design.js WALL_SURFACES, which is
# where edgeMesh() gets the solid it draws. tests/test_core_edges.py parses the
# JS table and fails when either side moves independently. A wall judged 0.10 m
# thick and drawn 0.23 m thick is what that test exists to prevent.
#
# footing_depth_m has no counterpart in the renderer (nothing below grade is
# drawn). It is minimum embedment for the material class, not a function of
# height: masonry is rigid and cracks on differential movement so it goes below
# the seasonal moisture zone; a dry-laid gravity wall resists by weight and only
# needs its base course buried; plate edging has no mass at all and works as a
# cantilever, so it needs real embedment for its height.
EDGE_SECTION = {
    "stone":        {"thickness_m": 0.35,  "batter_deg": 8, "footing_depth_m": 0.20},
    "brick":        {"thickness_m": 0.23,  "batter_deg": 2, "footing_depth_m": 0.30},
    "timber":       {"thickness_m": 0.20,  "batter_deg": 0, "footing_depth_m": 0.20},
    "concrete":     {"thickness_m": 0.20,  "batter_deg": 3, "footing_depth_m": 0.30},
    "corten_steel": {"thickness_m": 0.012, "batter_deg": 0, "footing_depth_m": 0.30},
    "aluminium":    {"thickness_m": 0.006, "batter_deg": 0, "footing_depth_m": 0.15},
    # Rock, for the slope. dry_stone is a coursed wall that batters hard because
    # nothing binds it; boulder is not a wall at all but set stone armouring a
    # slope toe, and it needs no footing because each stone IS its own footing.
    "dry_stone":    {"thickness_m": 0.45,  "batter_deg": 12, "footing_depth_m": 0.25},
    "boulder":      {"thickness_m": 0.55,  "batter_deg": 0, "footing_depth_m": 0.15},
}

# What each edge material is FOR. Names alone tell a designer that steel exists,
# not when steel is the right answer. Uses surface through list_assets next to
# the names so the model can choose a suitable material.
EDGE_SUITS = {
    "stone":        "a built garden wall; reads formal, and the most expensive per metre",
    "brick":        "formal edges near the house, where it can pick up the building",
    "timber":       "cheap, fast, straight runs; a 10-15 year material, not permanent",
    "concrete":     "structural retaining where height or surcharge rules out stacked stone",
    "corten_steel": "a crisp 100-200 mm line holding a bed against a slope, almost invisible "
                    "in plan; the least material for the most retention, and the usual right "
                    "answer for terracing planting on a grade",
    "aluminium":    "a mowing strip or a bed line that is meant to disappear; not retention",
    "dry_stone":    "terracing 0.4-0.9 m on a slope without a footing or a permit; reads as "
                    "landscape rather than construction, and plants can be set into the face",
    "boulder":      "set stone armouring a slope toe or the outside of a curve. Not a wall: "
                    "it holds soil by weight and roughness, needs no footing, and is the "
                    "naturalistic answer where a wall would read as engineering",
}
FALLBACK_SECTION = EDGE_SECTION["corten_steel"]   # what design.js falls back to


def edge_section(edge):
    """This edge's cross-section: what it states, else its material's default.

    Never raises on an unknown material. validate() calls this before the schema
    check has necessarily run — jsonschema may not even be installed — and a
    KeyError on a typo would take the whole validator down instead of reporting
    the typo.
    """
    base = EDGE_SECTION.get(edge.get("material"), FALLBACK_SECTION)
    out = {}
    for k, v in base.items():
        stated = edge.get(k)
        out[k] = float(stated) if isinstance(stated, (int, float)) and not isinstance(stated, bool) else v
    return out


# "same level" tolerance. The holds-nothing check and setback rule measure the
# same idea and must use the same value.
SAME_LEVEL_M = 0.15

# Above this, a thing is something you have to walk AROUND. Below it — a mowing
# strip, a bed shoulder, a kerb — you step over it without noticing. The point of
# the threshold is that a warning which fires on every bed and path is a warning
# nobody reads.
BLOCKING_HEIGHT_M = 0.25

# Design files store coordinates to 2 decimal places, so a pair set exactly at a
# distance can land up to 14 mm inside it on disk: two coordinates rounded by up
# to 5 mm each. This tolerance prevents rejection of a plant placed on the limit
# because of rounding.
STORED_POSITION_TOL_M = 0.015

# WHERE ONE PLANT MAY NOT STAND: the only spacing the validator enforces.
#
# How close plants stand is taste — a drift knits or keeps a seam, a carpet runs
# under a grass or stops short of it — and taste is the designer's. A spacing
# formula based on spread or species creates noise that can hide an unplantable
# pair, such as a thyme 4 cm from a Cleveland sage's stem. Enforce only physical
# mistakes.
#
# So two things are refused, because they cannot be planted:
#   * two plants in one planting hole — stems nearer than the narrowest pot a
#     plant is sold in (a 4-inch pot, 10 cm across);
#   * a plant in a tree's trunk — nearer a tree's stem than its trunk and root
#     flare, 0.25 m, where a hole would cut the tree's structural roots.
# Everything else about spacing is MEASURED for the designer
# (site_api.planting_character; compose's report) and decided by it.
PLANTING_HOLE_M = 0.10
TRUNK_M = 0.25
# A plant this tall is a tree: its crown is overhead, not ground cover, and it
# has a trunk. bed_mature_coverage and the trunk rule read it.
TREE_HEIGHT_M = 2.5


def one_hole(a, b):
    """How near plants a and b may stand, in metres, and why: the trunk of a tree if
    either is one, else one planting hole. The validator refuses nearer; compose.py
    offers no ground nearer. Physical, not taste — see PLANTING_HOLE_M."""
    trees = [p for p in (a, b) if (p.get("mature_height_m") or 0) >= TREE_HEIGHT_M]
    if trees:
        return TRUNK_M, trees[0]
    return PLANTING_HOLE_M, None

# The design's collections, in one place. (collection key, label for a message,
# geometry key). _op_points here and cmd_near / cmd_area in site_api share it so
# every element type is visible to the queries the model uses to avoid planting
# on its own path.
DESIGN_GEOM = (("paths", "path", "spline"),
               ("edges", "edge", "spline"),
               ("steps", "steps", "spline"),
               ("beds", "bed", "polygon"),
               ("patios", "patio", "polygon"))
DESIGN_KEYS = ("beds", "paths", "patios", "plants", "edges", "steps", "objects")

# Two proposals for one corner, resolved to the one that counts. ONE home, and
# tests/test_dry.py fails if a second copy of the resolution appears — the rule
# that geom.py and broker.py exist under.
import alternatives as _alternatives


def constraints(site=None):
    """This site's limits: DEFAULT_CONSTRAINTS with site.constraints on top.

    Silently ignores keys it does not know and values that are not numbers —
    a broken site.json must not take the validator down. constraint_complaints()
    reports those instead, and validate() surfaces them as warnings, because a
    typo here would otherwise enforce the default forever without a word.
    """
    c = dict(DEFAULT_CONSTRAINTS)
    for k, v in ((site or {}).get("constraints") or {}).items():
        if k in c and isinstance(v, (int, float)) and not isinstance(v, bool):
            c[k] = float(v)
    return c


def constraint_complaints(site):
    """Entries under site.constraints that do nothing."""
    out = []
    known = ", ".join(sorted(DEFAULT_CONSTRAINTS))
    for k, v in ((site or {}).get("constraints") or {}).items():
        if k not in DEFAULT_CONSTRAINTS:
            out.append(f"site.constraints: unknown key '{k}' — nothing reads it and the "
                       f"default is still in force. Known keys: {known}")
        elif not isinstance(v, (int, float)) or isinstance(v, bool):
            out.append(f"site.constraints.{k} = {v!r} is not a number; falling back to "
                       f"{DEFAULT_CONSTRAINTS[k]}")
    return out


def fmt_m(v):
    """A limit as prose: 1.2 -> "1.2", 1.0 -> "1", 0.05 -> "0.05"."""
    return f"{v:g}"


def with_limits(text, c):
    """Substitute this site's limits into a prompt, at <angle_bracket> tokens.

    str.format is unusable on these briefs — they are full of JSON examples and
    their braces — and a prompt that quotes a limit the validator does not
    enforce is worse than one that quotes none: the model designs to 1.2 m, is
    rejected by a 1.0 m site, and spends its one retry rediscovering a number
    the prompt had already stated.
    """
    sub = {k: fmt_m(v) for k, v in c.items()}
    sub["walk_grade_pct"] = fmt_m(round(c["walk_grade"] * 100, 1))
    sub["max_grade_pct"] = fmt_m(round(c["max_grade"] * 100, 1))
    for k, v in sub.items():
        text = text.replace(f"<{k}>", v)
    return text

# Structured-output schema for the ONE response object (claude --json-schema /
# codex --output-schema). Kept to the simple subset both CLIs accept.
XY = {"type": "array", "items": {"type": "number"},
      "description": "[x_east_m, y_north_m] — exactly 2 numbers"}


def plant_field(field, lead):
    """An OPTIONAL plant field, documented in the DESIGN schema's own words.

    There are two schemas and one renderer. schema/design.schema.json is the
    gate agent.validate() runs and its plant object is `additionalProperties:
    false`; OPS_SCHEMA is what --json-schema hands the model. A field the model
    is never offered is a field it never writes. viewer/src/plants.js reads `form`
    and `foliage`: growthForm falls to the declared habit, and foliageRamp displaces
    the form's colour ramp. A SECOND copy of the vocabulary here would drift from
    the one the validator enforces and the JS tests hold. So the
    description is read from the design schema rather than transcribed: nine
    growth forms, nine foliage words, one home. Measured: 0.13 ms for both
    reads, against a 27 ms `import agent`.
    """
    fallback = "OPTIONAL. Free text, normalised by the renderer."
    value_type = "string"
    try:
        with open(SCHEMA_PATH) as f:
            props = json.load(f)["properties"]["plants"]["items"]["properties"]
        doc = props[field].get("description") or fallback
        value_type = props[field]["type"]
    except Exception:
        doc = fallback
    return {"type": value_type, "description": f"{lead} {doc}"}
OPS_SCHEMA = {
    "type": "object",
    "properties": {
        "ops": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "tool": {"type": "string",
                             "enum": ["set_path", "place_plants", "upsert_bed", "set_edge",
                                      "set_patio", "set_steps", "remove_objects",
                                      "place_object", "resync_palette", "set_plants"]},
                    "input": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string"},
                            "spline": {"type": "array", "items": XY,
                                       "description": "set_path: 3-8 points, smoothed to a curve on render. Two points give a dead-straight walk; use 4+ and offset them so the route bends around planting rather than running like a ruled line. set_steps: 2 points down the fall line, covering the stretch that is too steep."},
                            "width_m": {"type": "number", "description": "set_path: 0.5-3.0. set_steps: how wide the flight is, default 1.0"},
                            "material": {"type": "string",
                                         "description":
                                             "FREE TEXT. " + ", ".join(PATH_MATERIALS) +
                                             " are modelled and render as themselves; anything "
                                             "else — brick, stone_sett, pebble_mosaic, a timber "
                                             "boardwalk — is legal, draws as the nearest surface "
                                             "and is recorded as a WANT for the owner. Ask for "
                                             "what the design needs, not for what happens to "
                                             "be modelled."},
                            "polygon": {"type": "array", "items": XY,
                                        "description": "upsert_bed: 8-14 vertices, closed implicitly, corners rounded on render. FOUR VERTICES MAKES A RECTANGLE and reads as a planter box, not a garden bed. Vary the edge: push it out around a tree, pull it in where a path passes, keep spacing uneven."},
                            "mulch": {"type": "string"},
                            "model": {"type": "string",
                                      "description":
                                          "place_object ONLY. A path under assets/objects/ to a "
                                          ".glb in the object library: the owner's own scan, a CC0 "
                                          "model you fetched (fetch_asset), or one you made "
                                          "(make_asset) — list_assets shows them as object_models. "
                                          "It beats the builder for that kind, the way a plant's "
                                          "`asset` beats the species table. A path that is not "
                                          "already on disk is rejected: find or make it FIRST, "
                                          "because a design naming a file nobody has draws nothing."},
                            "purpose": {"type": "string",
                                        "description": "set_patio: what this usable area is FOR. "
                                                       "FREE TEXT — sitting, dining, fire_pit, lawn, "
                                                       "kitchen_garden, play, utility and landing are "
                                                       "the common ones, but a tea court or a "
                                                       "meditation platform is a purpose too, and "
                                                       "naming it honestly is worth more than picking "
                                                       "the nearest word off a list."},
                            "height_m": {"type": "number",
                                         "description": "set_edge: exposed height "
                                                        "<edge_min_height_m>-<retain_limit_m> m"},
                            "level_m": {"type": "number",
                                        "description": "finished/retained elevation in metres on the "
                                                       "ground-height grid. set_path: the walk renders "
                                                       "FLAT at this level instead of following the "
                                                       "ground. upsert_bed: the bed sits FLAT on that "
                                                       "bench. set_edge: the top of the wall."},
                            "riser_m": {"type": "number",
                                        "description": "set_steps: the rise of ONE step, at most "
                                                       "<step_riser_max_m> m. Omit and you get that "
                                                       "maximum, which is the flight that fits in "
                                                       "the least run"},
                            "going_m": {"type": "number",
                                        "description": "set_steps: the tread depth of one step, at "
                                                       "least <step_going_min_m> m. risers x going "
                                                       "is the run the flight EATS, and a flight "
                                                       "shorter than that is rejected"},
                            "edge_material": {"type": "string",
                                              "description":
                                                  "FREE TEXT. list_assets kind=materials gives every "
                                                  "modelled edge with its section and what it SUITS; "
                                                  "anything else (gabion, rammed earth) draws as the "
                                                  "nearest and lands on the want list."},
                            "thickness_m": {"type": "number",
                                            "description": "set_edge: how thick the wall is "
                                                           "built. Omit for the material's own "
                                                           "figure. Two stacked walls are set "
                                                           "back from each other FACE to face, "
                                                           "so this is not decoration"},
                            "batter_deg": {"type": "number",
                                           "description": "set_edge: how far the face leans "
                                                          "back into what it retains. Omit for "
                                                          "the material's own figure"},
                            "footing_depth_m": {"type": "number",
                                                "description": "set_edge: footing depth below "
                                                               "grade. Omit for the material's "
                                                               "own figure — stating one "
                                                               "SHALLOWER than that on a wall "
                                                               "over <footing_threshold_m> m is "
                                                               "rejected"},
                            "retains": {"type": "string", "enum": ["uphill", "downhill", "none"]},
                            "plants": {"type": "array", "items": {
                                "type": "object",
                                "properties": {
                                    "id": {"type": "string", "description":
                                           "set_plants: the plant to change, kept as its id. "
                                           "place_plants ignores it and mints a new one."},
                                    "species": {"type": "string", "description": "botanical name"},
                                    "common": {"type": "string"},
                                    "position": XY,
                                    "mature_spread_m": {"type": "number"},
                                    "mature_height_m": {"type": "number"},
                                    "size_override": plant_field("size_override", "OPTIONAL — preserve a deliberate planning size."),
                                    "flower": plant_field("flower", "OPTIONAL — copy the catalog flower colour when flowering appearance is required."),
                                    # OPTIONAL, and deliberately absent from
                                    # `required`: a plant that omits them renders
                                    # from its species and habit alone.
                                    "form": plant_field(
                                        "form", "OPTIONAL — declare it for a species the "
                                        "renderer's tables may not name, so it lands on the "
                                        "right SHAPE instead of a generic blob."),
                                    "foliage": plant_field(
                                        "foliage", "OPTIONAL — declare it on any plant that is "
                                        "not simply green, or it takes the one colour every "
                                        "plant of its growth form shares."),
                                    "asset": {"type": "string", "description":
                                              "OPTIONAL — a plant MODEL to draw this plant with, "
                                              "by name: one from list_assets, or the `asset` "
                                              "fetch_asset / make_asset return when given a "
                                              "species. Use it when the species' own shape "
                                              "looks wrong; it is drawn at this plant's mature "
                                              "height and spread."},
                                },
                                "required": ["species", "common", "position",
                                             "mature_spread_m", "mature_height_m"],
                            }},
                            "ids": {"type": "array", "items": {"type": "string"},
                                    "description": "remove_objects: ids to delete"},
                            "species": {"type": "array", "items": {"type": "string"},
                                        "description": "resync_palette: the species to bring "
                                                       "back in step with the catalogue; omit "
                                                       "for every species that has drifted"},
                        },
                    },
                },
                "required": ["tool", "input"],
            },
        },
        "summary": {"type": "string", "description": "2-3 sentences on what changed"},
        "confidence": {"type": "string", "enum": ["high", "medium", "low"]},
        "cautions": {"type": "string",
                     "description": "what the owner should verify on the ground"},
        "seen": {"type": "string",
                 "description":
                     "What you SAW when you stood in this design — in plain words, "
                     "about the garden rather than about the geometry. Where the walk "
                     "reads as a road, where a bed is an outline rather than a "
                     "planting, what is bare in February, what you meant to hide and "
                     "did not. The owner reads this. Leave it empty if you did not "
                     "render anything, rather than writing what you assume it looks "
                     "like."},
        "done": {"type": "boolean",
                 "description":
                     "True only when you have rendered this design, stood in it, and "
                     "would change nothing. It ends the revision loop, so it is an "
                     "answer, not a way to finish early — say in `seen` what settled "
                     "it. Omit it while you still have changes to make."},
    },
    "required": ["ops", "summary", "confidence", "cautions"],
}


def ops_schema_json(c):
    """OPS_SCHEMA as the JSON the CLI is handed, with this site's limits in it.

    The tool descriptions ARE a prompt — --json-schema is the only place the
    model is told what an edge's height may be — so they get the same
    substitution as the brief. Tokens sit inside JSON string values, so the
    result is still valid JSON.
    """
    schema = copy.deepcopy(OPS_SCHEMA)
    # Offer place_object's fields from the actual design schema, never a second
    # vocabulary, so the model can specify kind, position and rotation.
    with open(SCHEMA_PATH) as f:
        object_fields = json.load(f)["properties"]["objects"]["items"]["properties"]
    inputs = schema["properties"]["ops"]["items"]["properties"]["input"]["properties"]
    for key, value in object_fields.items():
        inputs.setdefault(key, value)
    return with_limits(json.dumps(schema), c)


SYSTEM = """You are the PEDON design agent. You output edits to a residential landscape
design as a single JSON object (ops + summary + confidence + cautions). Coordinates are
meters in a local site frame: x = east, y = north, origin near the house.

You are the designer. Every decision about the garden — where things go, what shape,
how many, which plants — is yours. The tools only measure the ground, show you views,
and refuse what is physically impossible or against building code; none of them will
arrange, move or remove anything for you, and nothing changes your design after you.

Rules:
- Tools: set_path {id, spline, width_m, material} creates/replaces a walkway (the spline is
  smoothed into a curve on render; 4-8 points let it bend). place_plants
  {plants:[{species, common, position, mature_height_m, mature_spread_m, form?, foliage?, flower?}]}
  adds plants (ids are assigned for you). upsert_bed {id, polygon, mulch, level_m} creates/replaces
  a bed (the outline is corner-rounded on render; give it 8-14 vertices).
  set_patio {id, polygon, material, level_m, purpose} creates/replaces a USABLE AREA — a
  level paved, gravelled, decked or lawned pad a person actually occupies. This is the
  tool for a sitting terrace, a dining pad, a fire-pit circle, a lawn shelf or a landing.
  set_edge {id, spline, height_m, edge_material, retains, level_m} creates/replaces EDGING — a low
  vertical strip standing along a line (corten steel, timber, stone...). This is the tool
  for holding a grade change, terracing a slope, or containing a bed; set retains to the
  side it holds back. set_steps {id, spline, width_m, riser_m, going_m} creates/replaces a
  FLIGHT OF STEPS — the only thing that gets a route down ground too steep to walk as a
  ramp. remove_objects {ids} deletes.
  place_object {id, kind, position, height_m, width_m?, rotation_deg?, tilt_deg?,
  material?, note?, level_m?} puts a THING in the garden — a lantern, a water basin, a
  bench, a set boulder, a pot, a fire pit, a screen, a moon gate, a pergola, a koi pond.
  `kind` and `material` are FREE TEXT: ask for what the garden actually wants, in words.
  If the library cannot draw it, it renders as a marked placeholder on the owner's want
  list — the right outcome only when you have no asset tools; with them, GET THE MODEL
  (find_asset, then fetch_asset or make_asset) and place it with its `model`. This op replaces
  by id, so re-issuing it with the same id MOVES or re-specifies that object.
    THE HARDSCAPE AND THE OBJECTS ARE THE STYLE. Express Mediterranean, Chinese or
    Japanese style through objects and hardscape as well as plant choice. Gravel and
    shrubs alone do not convey the character of a lantern, a basin or a raked court.
  NOTE ON REVISING PLANTS: place_plants ALWAYS mints a fresh id — it is an ADD, never
  an update, and an id you put in a plant entry is ignored — so re-placing a plant to
  move it silently leaves you with two. To move or re-specify a plant use set_plants
  {plants: [{id, species, common, position, ...}]}: it replaces that plant's whole
  record and KEEPS ITS ID. Do not remove_objects + place_plants: the new id drops the
  plant out of the owner's groups.
- Path widths 0.5-3.0 m (main walks ~1.0-1.2 m).
- SHAPE: this is a garden, not a car park. Bed outlines are curves — give each bed
  8-14 vertices with UNEVEN spacing so its edge swells and narrows, and let neighbouring
  beds share a flowing line rather than sitting as separate boxes. Walks bend. Nothing
  should be an axis-aligned rectangle unless it is genuinely a built structure (a deck,
  a patio slab). A four-vertex bed is the single most common way a design ends up
  looking machine-made; treat four vertices as a bug in your own output.
- USABLE SPACE IS THE POINT, and flat ground is the scarce resource on a slope. Read the
  per-zone slope figures in the site facts and treat grade as the thing that decides use:
    under ~9 deg   the flattest ground there is. RESERVE IT for a usable area (set_patio):
                   sitting, dining, a fire pit, a lawn shelf, vegetables. Do NOT fill your
                   flattest ground with planting — that is the single most common way a
                   sloped garden ends up with nowhere to be.
    9-18 deg       circulation and terraced planting. Traversing paths, beds held by low
                   edging, and this is where a small retaining wall buys the most: a
                   0.4-0.9 m wall across the contour manufactures a level pad out of
                   ground that was useless.
    over 18 deg    leave it as slope and PLANT it. Massed shrubs and groundcover hold soil,
                   need no access, and are what a steep face is genuinely good for.
  Every design on a slope should include at least one set_patio unless the owner says
  otherwise, and it should sit on the gentlest ground available or on a bench you build.
- REPETITION is what separates a garden from a plant collection, and it is the most
  common way a generated planting looks wrong. Plant in drifts and masses — several of
  the same species together, rather than one of everything — and repeat a few signature
  species across several beds so the eye connects them. A species used ONCE is a
  specimen, and a garden holds a few of those, not a bed full. If your plant list has
  almost as many species as plants, you have written a nursery order, not a design.
  How many species that means is YOURS to decide from the site and the palette.
  WHERE each plant stands is a design decision, and it is yours: draw the masses in your
  head first — the main gesture, its echoes, the low connection between them, the open
  ground — then place each plant inside those shapes, tight within a drift and wider at the
  seam to its neighbour. Nothing re-places them after you.
- COLOUR AND HABIT: a plant's colour comes from its growth FORM, so every species sharing
  a form is drawn from one narrow ramp — half the plants in a garden can be `mound`, and
  that ramp is 5.7% of the colour cube wide, so a silver lavender and a glossy dark toyon
  come out the same green. Each plant in place_plants may therefore carry two OPTIONAL
  fields, and the schema gives the vocabulary for both: `foliage` for anything not simply
  green (declare it on the silver, glaucous, dark-glossy, purple, bronze or variegated
  plants in your list — at garden distance colour is most of what separates two shrubs of
  the same silhouette), and `form` for a species the renderer's tables may not name.
  Omit them and the plant renders exactly as it does today.
- NEVER place anything inside the house footprint given in the site facts.
- LANDMARKS in the site facts are ground truth the owner clicked in their own yard scan.
  When the user references a real structure (stairs, planter, patio, gate...), anchor to
  its landmark coordinates. If no landmark exists for a referenced structure, do NOT
  invent a position: place relative to the footprint and state in cautions that the
  owner should mark that landmark in the viewer and re-run.
- LEVELS: by default a path is drawn draped over the existing ground, so it undulates with
  the slope. If you are cutting/filling a bench or terracing — anything the owner would
  describe as "level" — you MUST pass level_m (the finished elevation, read off the ground
  height grid) on set_path, on every upsert_bed that sits on that same bench, and on the
  retaining set_edge. A terrace whose walk is level but whose beds still follow the old
  slope is not a terrace. Without it the
  design renders as a path running up and down the raw slope, contradicting your own
  description. Only omit level_m when the path genuinely follows the ground.
- CONTOURS: a level bench only stays level if it runs along the CONTOUR — perpendicular
  to the fall. The fall here is not axis-aligned, so a bench drawn along constant x or
  constant y still drops along its own length and will be rejected for cut/fill even when
  it is narrow. Each zone gives its contour bearing; orient benches, level walks and
  retaining runs along it, and let their ENDS step down to the next bench.
- GRADE: a walk steeper than the site's max_grade is REJECTED, not warned. Put a set_steps
  flight across the steep stretch, or route along the contour instead. Between walk_grade
  and max_grade it applies with a warning: walkable, but not a comfortable ramp.
- TERRAIN facts give the yard's slope and its downhill compass bearing. Use them:
  retaining edges/walls belong on the downhill side, paths should traverse or switchback
  rather than run straight down steep fall lines, and drainage runs downhill.
- Use botanical species names and realistic mature sizes; respect the site's USDA zone if
  known. Space plants at roughly their mature spread.
- Keep existing objects unless the request implies changing them.
- Respond with ONLY the JSON object. No markdown, no code fences, no commentary."""


# ------------------------------------------------------------------ validation
def point_in_poly(pt, poly):
    """Ray-crossing test, kept as a name because callers pass (pt, poly).
    The implementation lives in geom.py so geometric checks share one definition
    and cannot drift between tools."""
    return geom.point_in_polygon(pt[0], pt[1], poly)

def poly_area(poly):
    """Shoelace — see geom.polygon_area. One implementation, imported."""
    return geom.polygon_area(poly)


_TERRAIN = None


def _terrain():
    """Ground-height grid exported by the viewer, or None."""
    global _TERRAIN
    if _TERRAIN is None:
        path = project.data("terrain.json")
        try:
            with open(path) as f:
                _TERRAIN = json.load(f)
        except (OSError, json.JSONDecodeError):
            _TERRAIN = False
    return _TERRAIN or None



def _unscanned(pts):
    """How many of these points sit on ground nobody measured."""
    return sum(1 for x, y in pts if ground_at(x, y) is None), len(pts)


def _op_points(design):
    """Every placed point in a design, tagged by what it belongs to."""
    out = []
    for pl in design.get("plants", []):
        out.append(("plant", pl.get("id"), tuple(pl["position"][:2])))
    for key, label, geom in DESIGN_GEOM:
        for o in design.get(key, []):
            for pt in o.get(geom) or []:
                out.append((label, o.get("id"), tuple(pt)))
    return out


def _near_corridor(q, spline, half):
    """Is this point within `half` metres of the path's centreline?

    Distance to the SEGMENTS, not to the spline's vertices: sampling only the
    stored points misses relief between them, and the same trap applies to a
    route — a bed can sit clear of every control point and still lie
    across the middle of a long straight run.
    """
    x, y = q[0], q[1]
    for i in range(len(spline) - 1):
        ax, ay = spline[i][0], spline[i][1]
        bx, by = spline[i + 1][0], spline[i + 1][1]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / L2))
        if math.hypot(x - (ax + t * dx), y - (ay + t * dy)) <= half:
            return True
    return False


def _path_stations(spline, half, step=0.35):
    """Points along a path's centreline with the unit normal across it.

    Shared by the corridor sampler and the pinch test so the two cannot disagree
    about where the path is — the same reason geom.point_in_polygon has one home.
    """
    out = []
    walk = _walk_line(spline, step)
    for i, (x, y) in enumerate(walk):
        j = min(i, len(walk) - 2)
        if j < 0:
            break
        tx = walk[j + 1][0] - walk[j][0]
        ty = walk[j + 1][1] - walk[j][1]
        L = math.hypot(tx, ty)
        if L == 0:
            continue
        out.append((x, y, -ty / L, tx / L))
    return out


def _path_corridor(spline, half, step=0.35):
    """The walking SURFACE of a path — both edges and the centreline, sampled.

    A path is not its centreline. Half a metre of bed over one side of a 1.05 m
    walk leaves a walkable strip narrower than a person, and a centreline test
    sees nothing at all when the overlap stops short of the centreline.
    """
    out = []
    walk = _walk_line(spline, step)
    for i, (x, y) in enumerate(walk):
        j = min(i, len(walk) - 2)
        if j < 0:
            break
        tx = walk[j + 1][0] - walk[j][0]
        ty = walk[j + 1][1] - walk[j][1]
        L = math.hypot(tx, ty)
        if L == 0:
            continue
        nx, ny = -ty / L, tx / L
        for s in (-half, -half * 0.5, 0.0, half * 0.5, half):
            out.append((x + nx * s, y + ny * s))
    return out


def _walk_line(pts, step=0.5):
    """Points every `step` metres along a polyline, endpoints included.

    Checking only the vertices of a run is not enough on real terrain: a wall
    declared 0.7 m tall can stand 2.59 m above a dip BETWEEN two spline points
    while every vertex-only check passes it.
    """
    out = []
    for i in range(len(pts) - 1):
        ax, ay = pts[i]
        bx, by = pts[i + 1]
        seg = ((bx - ax) ** 2 + (by - ay) ** 2) ** 0.5
        n = max(1, int(seg / step))
        for k in range(n):
            t = k / n
            out.append((ax + (bx - ax) * t, ay + (by - ay) * t))
    if pts:
        out.append(tuple(pts[-1]))
    return out


def _walk_polygon(poly, step=0.5):
    """Perimeter samples plus a coarse interior grid, so a dip inside a bed counts."""
    pts = _walk_line(list(poly) + [poly[0]], step)
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    x, gx = min(xs), max(xs)
    y, gy = min(ys), max(ys)
    n = 0
    cx = x
    while cx <= gx and n < 4000:
        cy = y
        while cy <= gy and n < 4000:
            if point_in_poly((cx, cy), poly):
                pts.append((cx, cy))
                n += 1
            cy += 1.0
        cx += 1.0
    return pts


# ── ground truth ──────────────────────────────────────────────────────────
# Two height fields exist and they are NOT interchangeable. data/terrain.json is
# a 2 m BFS-FILLED grid: it invents ground past the scan edge (on a real capture,
# probes on a 1 m lattice can land where it claims ground and the raycast saw none
# nearly a third of the time) and smooths real relief away. data/terrain_scan.json is a 1 m raycast of
# the actual mesh — measurement, with holes.
#
# This validator and `site_api check-pad` use the same measured field so the
# model sizes a pad against the ground the validator judges. A wall 1.35 m off
# the mesh can appear only 1.10 m high on the filled grid, hiding a violation of
# the default 1.2 m retaining limit.
_SCAN = None


def _scan_grid():
    """The 1 m raycast of the scan mesh, or None if it was never exported."""
    global _SCAN
    if _SCAN is None:
        path = project.data("terrain_scan.json")
        try:
            with open(path) as f:
                _SCAN = json.load(f)
        except (OSError, json.JSONDecodeError):
            _SCAN = False
    return _SCAN or None


def _scan_cell(t, r, c):
    if 0 <= r < len(t["rows"]) and 0 <= c < len(t["rows"][r]):
        return t["rows"][r][c]
    return None


def _round_half_up(v):
    """Match JS Math.round, which is what the viewer's scanHeight() uses.

    Python's round() is banker's rounding (half-to-EVEN): round(2.5) == 2 while
    Math.round(2.5) == 3. At an exact half-cell query the two nearest-neighbour
    fallbacks therefore pick DIFFERENT cells, so the validator and the viewer
    disagree about the ground at the one place the answer is already least
    certain — the edge of scan coverage, where the fallback is all there is.
    """
    return math.floor(v + 0.5)


def scan_at(x, y):
    """
    True scanned elevation, bilinearly interpolated, or None where the scanner
    never saw ground.

    Nearest-neighbour on a 1 m grid answers a query with whatever sample is
    closest, which on a sloping site can cost a p90 of 0.20 m — enough to move a pad
    across the line between "buildable" and "needs an engineered footing".
    Bilinear costs four lookups.

    It deliberately falls back to nearest when ANY of the four corners is
    unscanned: interpolating across the edge of coverage would invent ground,
    which makes the filled height field untrustworthy.
    """
    t = _scan_grid()
    if not t:
        return None
    fc = (x - t["x0"]) / t["cell_m"]
    fr = (t["y1"] - y) / t["cell_m"]                # rows are north-first
    c0, r0 = math.floor(fc), math.floor(fr)
    tx, ty = fc - c0, fr - r0
    q = [_scan_cell(t, r0, c0), _scan_cell(t, r0, c0 + 1),
         _scan_cell(t, r0 + 1, c0), _scan_cell(t, r0 + 1, c0 + 1)]
    if all(v is not None for v in q):
        top = q[0] * (1 - tx) + q[1] * tx
        bot = q[2] * (1 - tx) + q[3] * tx
        return top * (1 - ty) + bot * ty
    # half-UP, not python's half-to-even — the browser does Math.round here
    return _scan_cell(t, _round_half_up(fr), _round_half_up(fc))


def filled_at(x, y):
    """The 2 m BFS-filled grid the viewer exports. FALLBACK ONLY — it answers in
    places the scanner never saw, which is useful for keeping a design checkable
    at the edge of the capture and dangerous everywhere else."""
    t = _terrain()
    if not t:
        return None
    c = _round_half_up((x - t["x0"]) / t["cell_m"])
    r = _round_half_up((t["y1"] - y) / t["cell_m"])
    if 0 <= r < len(t["rows"]) and 0 <= c < len(t["rows"][r]):
        v = t["rows"][r][c].strip()
        if v != "..":
            return float(v)
    return None


def ground_at(x, y):
    """Scanned ground first; the filled field only where the raycast has no coverage."""
    h = scan_at(x, y)
    return h if h is not None else filled_at(x, y)


def path_grades(spline, step=0.5):
    """Grade of every `step`-metre stretch of a route, on MEASURED ground.

    Returns ([(grade_pct, run_m, (mid_x, mid_y)), ...], metres_not_measured).

    ONE implementation. check-route reports these numbers to the model and
    validate() rejects a path on them, so the tool and the validator cannot
    disagree because of separate implementations.

    scan_at, not ground_at: a stretch the raycast never saw is counted as
    unmeasured rather than graded. A BFS-filled fallback can hold 3.20 m flat
    for five metres and then step to 5.00 m at the last vertex, yielding a 357%
    sampled grade. Such artificial relief must not reject a design for a slope
    nobody measured.

    It walks the line rather than reading the vertices, for the usual reason: a
    wall declared 0.7 m can stand 2.59 m above a dip BETWEEN two spline points.
    """
    stretches = path_steps(spline, step)
    samples = [(g, r, m) for g, r, m, _ in stretches if g is not None]
    unmeasured = sum(r for g, r, _, _ in stretches if g is None)
    return samples, unmeasured


def path_steps(spline, step=0.5):
    """Every `step`-metre stretch of a route IN ORDER, measured or not.

    Returns [(grade_pct | None, run_m, mid_xy, distance_along_m), ...].

    path_grades() is this, filtered to the measured ones — one walk, not two.
    check-route needs the ORDER and needs the gaps in place, because "needs
    steps" over a 30 m route says nothing about WHERE, and a stretch nobody
    measured has to stay in the sequence as a hole rather than vanish and leave
    the stretches either side looking adjacent. Splitting this out rather than
    walking the line a second time keeps the geometry in one implementation,
    like `_walk_line`, `geom.point_in_polygon` and `broker`, so duplicate lookups
    cannot disagree or repeat the same indexing error.
    """
    hs = [(x, y, scan_at(x, y)) for x, y in _walk_line(spline, step)]
    out, at = [], 0.0
    for a, b in zip(hs, hs[1:]):
        run = math.hypot(b[0] - a[0], b[1] - a[1])
        if run < 1e-6:
            continue
        grade = None if (a[2] is None or b[2] is None) else 100 * (b[2] - a[2]) / run
        out.append((grade, run, ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), at))
        at += run
    return out


def steps_for_fall(fall_m, riser_m, going_m):
    """The flight a fall needs: how many risers, how tall each, and the run they eat.

    check-route calls it with the site's LIMITS, to tell the model what a route
    would cost before it designs one. validate() calls it with the riser and going
    a submitted flight DECLARES, to judge whether that flight fits its own run.
    Same arithmetic — "needs steps" backed by two different riser counts is the
    two-rulers bug again.
    """
    risers = max(1, math.ceil(abs(fall_m) / riser_m))
    return {"risers": risers,
            "riser_m": round(abs(fall_m) / risers, 3),
            "min_run_m": round(risers * going_m, 2)}


def _point_to_polyline_m(pt, poly):
    """Shortest distance from a point to a polyline, measured to its SEGMENTS.

    The nearest part of a run is usually mid-segment, so vertex-only distance
    can overestimate the clearance.
    """
    px, py = pt
    if len(poly) < 2:
        return math.hypot(px - poly[0][0], py - poly[0][1]) if poly else float("inf")
    best = float("inf")
    for (ax, ay), (bx, by) in zip(poly, poly[1:]):
        dx, dy = bx - ax, by - ay
        d2 = dx * dx + dy * dy
        t = 0.0 if d2 < 1e-12 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / d2))
        best = min(best, math.hypot(px - (ax + dx * t), py - (ay + dy * t)))
    return best


def _min_gap(a_pts, b_pts):
    """Closest approach in plan between two runs, measured to b's SEGMENTS.

    Both setback rules need this. A point-to-point minimum over sampled points
    is up to half a sample step optimistic, so both use one function through
    _point_to_polyline_m like everything else.
    """
    if not a_pts or not b_pts:
        return float("inf")
    return min(_point_to_polyline_m(p, b_pts) for p in a_pts)


def _footing_check(e, sec, exposed, c, errors, warnings):
    """What a wall this tall stands on. Appends to the caller's message lists.

    Walls need the same footing check as patios, beds and path benches, using
    the footing the edge declares. Below footing_threshold_m an edging is
    driven rather than footed, and warning on every garden kerb is noise that
    hides a real message.
    """
    if exposed <= c["footing_threshold_m"]:
        return
    mat = e.get("material")
    need = EDGE_SECTION.get(mat, FALLBACK_SECTION)["footing_depth_m"]
    got = sec["footing_depth_m"]
    if got < need - 1e-9:
        errors.append(
            f"edge {e['id']}: states a footing {got:.2f} m deep, shallower than the {need:.2f} m "
            f"a {mat} wall standing {exposed:.2f} m out of the ground needs. Deepen it, lower the "
            f"wall under {fmt_m(c['footing_threshold_m'])} m, or build it from something that "
            f"carries its own weight")
    else:
        warnings.append(
            f"edge {e['id']}: stands {exposed:.2f} m out of the ground, over the "
            f"{fmt_m(c['footing_threshold_m'])} m that needs an engineered footing — "
            f"{got:.2f} m deep in {mat}, and probably a permit")


def _under_steps(pt, steps):
    """Is this point inside a steps flight's corridor?

    The escape hatch has to actually open. A grade REJECTION with no way to
    answer it is a validator rejecting routes the model has no vocabulary to
    fix, so a stretch a set_steps flight covers is not judged as a ramp.
    """
    for st in steps:
        half = float(st.get("width_m") or 1.0) / 2
        if _point_to_polyline_m(pt, st["spline"]) <= half:
            return True
    return False


# HOW CROWDED A BED IS WHEN EVERYTHING IN IT IS FULL GROWN.
#
# Design and review at full maturity. A bed spaced to look full at ~5 years can
# reach 2.15x or 2.50x coverage at full size. `look` renders mature planting;
# report crowding when a plant is placed too. Measure mature canopy (pi r^2 at
# mature spread) over the bed's own ground, paving excluded, because a walk
# inside a bed outline is not soil.
#
# The bands are what the plants physically do at that density, and
# viewer/src/shell/compare.js coverageNote reads the same edges
# (tests/js/compare_designs.test.mjs holds the two in step).
MATURE_COVERAGE_BANDS = [(1.0, "thin at maturity"), (1.3, "closes, just"), (1.6, "knits"),
                         (2.0, "tight at full size"), (None, "crowded at full maturity")]
MATURE_COVERAGE_WARN = 1.6
_BED_GROUND_CACHE = {}


def bed_mature_coverage(design, cell=0.25):
    """{bed_id: {"coverage": x, "ground_m2": a, "plants": n, "reading": band}} at FULL maturity."""
    paths = [(p.get("spline") or [], (p.get("width_m") or 0) / 2) for p in design.get("paths", [])]
    def on_paving(x, y):
        for spline, half in paths:
            for (ax, ay), (bx, by) in zip([q[:2] for q in spline], [q[:2] for q in spline[1:]]):
                dx, dy = bx - ax, by - ay
                L = dx * dx + dy * dy
                t = 0 if L == 0 else max(0, min(1, ((x - ax) * dx + (y - ay) * dy) / L))
                if math.hypot(x - ax - t * dx, y - ay - t * dy) <= half:
                    return True
        return False
    out = {}
    for bed in design.get("beds", []):
        poly = [q[:2] for q in bed.get("polygon") or []]
        if len(poly) < 3:
            continue
        key = (json.dumps(poly), json.dumps(paths), cell)
        if key not in _BED_GROUND_CACHE:
            xs, ys = [q[0] for q in poly], [q[1] for q in poly]
            n = 0
            x = min(xs) + cell / 2
            while x < max(xs):
                y = min(ys) + cell / 2
                while y < max(ys):
                    if geom.point_in_polygon(x, y, poly) and not on_paving(x, y):
                        n += 1
                    y += cell
                x += cell
            _BED_GROUND_CACHE[key] = n * cell * cell
        ground = _BED_GROUND_CACHE[key]
        inside = [pl for pl in design.get("plants", [])
                  if geom.point_in_polygon(pl["position"][0], pl["position"][1], poly)]
        # A TREE'S CANOPY IS OVERHEAD, NOT GROUND COVER. Counting a 2.8 m crown
        # as cover can label bare mulch as closed planting.
        under = [pl for pl in inside if (pl.get("mature_height_m") or 0) < TREE_HEIGHT_M]
        canopy = sum(math.pi * ((pl.get("mature_spread_m") or 0) / 2) ** 2 for pl in under)
        cov = round(canopy / ground, 2) if ground > 0 else None
        reading = None
        if cov is not None:
            reading = next(text for edge, text in MATURE_COVERAGE_BANDS if edge is None or cov < edge)
        out[bed["id"]] = {"coverage": cov, "ground_m2": round(ground, 1), "plants": len(inside),
                          "trees_overhead": len(inside) - len(under), "reading": reading}
    return out


def house_outline(site):
    """(polygon, what to call it) for the no-building-inside rule. The address lookup's
    footprint when there is one; else the survey's MEASURED house — the box round the
    enclosed unscanned region — because a new site has no footprint until its address is
    looked up (and public records may have none). The rule must remain active without
    an address footprint. The box can be coarser than the walls in a notch, and says so."""
    s = site or {}
    fp = s.get("footprint") or []
    if fp:
        return fp, "the house footprint"
    b = (s.get("house_measured") or {}).get("bounds_m") or {}
    if b.get("x") and b.get("y"):
        (x0, x1), (y0, y1) = b["x"], b["y"]
        return ([[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
                "the house as the survey measured it (a box round the unscanned building; "
                "look up the address for its outline)")
    return [], ""


_SCHEMA_VALIDATORS = {}


def _schema_validator(c):
    """The design schema with THIS SITE's limits filled in, checked once per limits."""
    import jsonschema
    key = (os.path.getmtime(SCHEMA_PATH), c["edge_min_height_m"], c["retain_limit_m"],
           c["step_riser_max_m"], c["step_going_min_m"])
    if key not in _SCHEMA_VALIDATORS:
        with open(SCHEMA_PATH) as f:
            schema = json.load(f)
        # The edge-height bounds in schema/ are THIS SITE's retaining limits, so
        # they are filled in here rather than shipped as a number. Left hardcoded,
        # a yard permitted to build a 1.5 m wall gets rejected by a file that has
        # never heard of the address — and the code check below would disagree
        # with the schema check above it in the same function.
        h = schema["properties"]["edges"]["items"]["properties"]["height_m"]
        h["minimum"], h["maximum"] = c["edge_min_height_m"], c["retain_limit_m"]
        sp = schema["properties"]["steps"]["items"]["properties"]
        sp["riser_m"]["maximum"] = c["step_riser_max_m"]
        sp["going_m"]["minimum"] = c["step_going_min_m"]
        cls = jsonschema.validators.validator_for(schema)
        cls.check_schema(schema)
        _SCHEMA_VALIDATORS[key] = cls(schema)
    return _SCHEMA_VALIDATORS[key]


def validate(design, site, area=None):
    # ONE GARDEN AT A TIME. A design may carry two proposals for one
    # corner; judging the union would reject a pair of shrubs at mature spread
    # that are alternatives to each other and never both planted. The judge is
    # the right seam for this because every caller of validate() — cmd_validate,
    # check-ops, apply-ops' own final check — wants the verdict on the garden
    # that would actually be built.
    #
    # NOTE THIS RESOLVES A COPY AND RETURNS ONLY MESSAGES. execute() and the
    # write path see the WHOLE document, or choosing one proposal would delete
    # the other from disk.
    design = _alternatives.active_design(design)
    errors, warnings = [], []
    from plant_catalog import plant_issues
    plant_errors, plant_warnings = plant_issues(design)
    errors.extend(plant_errors)
    warnings.extend(plant_warnings)
    c = constraints(site)
    warnings += constraint_complaints(site)
    # An area restriction stated only in the prompt is a suggestion. Enforce it
    # here so placement cannot escape the owner's chosen area.
    if area:
        poly = area["polygon"]
        for kind, oid, (px, py) in _op_points(design):
            if not point_in_poly((px, py), poly):
                errors.append(
                    f"{kind} {oid}: point [{px}, {py}] is outside the area "
                    f"\"{area['name']}\" you were told to work inside")
                break
    try:
        import jsonschema
        # exactly jsonschema.validate(design, schema), with the checked validator
        # kept: a two-op hand move runs validate() six times, and re-checking the
    # schema itself each time costs a third of the op's 0.6 s
        error = jsonschema.exceptions.best_match(_schema_validator(c).iter_errors(design))
        if error is not None:
            raise error
    except ImportError:
        warnings.append("jsonschema not installed; schema check skipped")
    except Exception as e:
        errors.append(f"schema: {getattr(e, 'message', str(e))[:200]}")

    fp, fp_name = house_outline(site)
    def check_pts(kind, oid, pts, connected=False, half_width=0.0):
        samples = list(pts)
        if connected and len(pts) > 1:
            seq = pts + [pts[0]] if kind == "bed" else pts
            for a, b in zip(seq, seq[1:]):
                # sample by DISTANCE, not a fixed count: 3 samples on a 30 m
                # segment steps ~7 m at a time and walks straight through a house
                seg = ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2) ** 0.5
                steps = max(3, int(seg / 0.5))
                ux, uy = ((b[1] - a[1]) / seg, -(b[0] - a[0]) / seg) if seg > 1e-9 else (0.0, 0.0)
                for i in range(1, steps):
                    t = i / steps
                    cx, cy = a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
                    samples.append([cx, cy])
                    # a path is a corridor, not a line: check both edges too, or
                    # a 3 m walk can lie half inside the house and pass clean
                    if half_width > 0:
                        samples.append([cx + ux * half_width, cy + uy * half_width])
                        samples.append([cx - ux * half_width, cy - uy * half_width])
        for p in pts:
            if abs(p[0]) > 80 or abs(p[1]) > 80:
                errors.append(f"{kind} {oid}: point {p} is >80 m from origin — wrong units?")
        for p in samples:
            if fp and point_in_poly(p, fp):
                errors.append(f"{kind} {oid}: point [{p[0]:.1f}, {p[1]:.1f}] is inside {fp_name}")
                break

    # An unmodelled material is LEGAL and must not be silently substituted: a brick
    # path that draws as decomposed granite and says nothing is exactly the
    # invisible downgrade objects.js exists to prevent, one element type over.
    for key, label, known in (("paths", "path", PATH_MATERIALS),
                              ("patios", "patio", PATIO_MATERIALS),
                              ("edges", "edge", sorted(EDGE_SECTION)),
                              ("steps", "steps", sorted(EDGE_SECTION))):
        for o in design.get(key, []) or []:
            if not isinstance(o, dict):
                continue
            mat = o.get("material")
            if mat and mat not in known:
                warnings.append(
                    f"{label} {o.get('id', '?')}: \"{mat}\" is not modelled — it renders as the "
                    f"nearest surface and goes on the owner's want list. Modelled here: "
                    f"{', '.join(known)}")

    # ── a barrier standing on ground the owner DREW ─────────────────────────
    #
    # Areas are owner ground truth, so a barrier in one contradicts something they
    # STATED. It warns rather than rejects, because a wall may legitimately edge
    # an area and a screen may be exactly what a courtyard wants — only they can
    # say. Same shape as "this wall holds nothing": information where the
    # decision is made, not a veto.
    #
    # Only things you cannot walk through: BLOCKING_HEIGHT_M keeps a mowing strip,
    # a bed and a path out of it, because a warning that fires on everything is
    # one nobody reads.
    for ar in (site or {}).get("areas", []):
        poly = ar.get("polygon") or []
        if len(poly) < 3:
            continue
        for e in design.get("edges", []) or []:
            if float(e.get("height_m") or 0) < BLOCKING_HEIGHT_M:
                continue
            inside = [p for p in _walk_line(e.get("spline") or [], 0.3)
                      if point_in_poly(p, poly)]
            if inside:
                warnings.append(
                    f"edge {e['id']}: {fmt_m(float(e.get('height_m') or 0))} m of "
                    f"{e.get('material', 'edging')} stands inside \"{ar['name']}\", an area "
                    f"the owner drew. If that is a barrier across ground they marked, move it "
                    f"to the edge of the area or drop its height; if it is meant to hold that "
                    f"ground, say so with level_m")
        for o in design.get("objects", []) or []:
            pos = o.get("position") or []
            if len(pos) < 2 or float(o.get("height_m") or 0) < BLOCKING_HEIGHT_M:
                continue
            if point_in_poly((pos[0], pos[1]), poly):
                warnings.append(
                    f"object {o['id']}: a {fmt_m(float(o.get('height_m') or 0))} m "
                    f"{o.get('kind', 'object')} stands inside \"{ar['name']}\", an area the "
                    f"owner drew — check it is not standing in the way of the thing that "
                    f"area is for")

    # A BED OR A BARRIER STANDING IN A PATH is the same class as one standing in
    # an owner-drawn area, and it earns the same warning.
    #
    # Identify the object that actually pinches the walk: the user can see the
    # effect without knowing which outline causes it. Planting over one side of
    # a 1.05 m walk can leave only 0.55 m of surface, even when nearby objects
    # clear the corridor by 0.35 m or 0.45 m.
    #
    # Compared against the path's real half-width, not a nominal gap, and it
    # WARNS rather than rejects: a bed may legitimately run right up to a path,
    # and stepping stones are meant to sit in planting.
    for pa in design.get("paths", []) or []:
        spline = pa.get("spline") or []
        half = float(pa.get("width_m", 0) or 0) / 2
        if len(spline) < 2 or half <= 0:
            continue
        corridor = _path_corridor(spline, half)
        if not corridor:
            continue
        # THE NARROWEST POINT, not the average. A path is blocked where it
            # pinches, and a share-of-total-surface number hides exactly that: a bed
            # can take only 3.2% of a walk's area while leaving 0.55 m to stand on
            # where the overlap is deep and short. What a body meets is the minimum.
        #
        # 0.5 m is not a taste threshold — it is the project's OWN floor, the
        # width below which set_path already errors. A walk planted down to less
        # than the narrowest path anybody is allowed to draw is not a walk.
        narrow, culprit = half * 2, None
        beds = [(b.get("id"), b.get("polygon") or []) for b in design.get("beds", []) or []]
        beds = [(bid, poly) for bid, poly in beds if len(poly) >= 3]
        if beds:
            for x, y, nx, ny in _path_stations(spline, half):
                free, run, worst_here = 0.0, 0.0, None
                N = 12
                for k in range(N + 1):
                    s_off = -half + (2 * half) * k / N
                    q = (x + nx * s_off, y + ny * s_off)
                    blocked = next((bid for bid, poly in beds if point_in_poly(q, poly)), None)
                    if blocked:
                        run = 0.0
                        worst_here = blocked
                    else:
                        run += (2 * half) / N
                        free = max(free, run)
                if free < narrow:
                    narrow, culprit = free, worst_here
            if culprit and narrow < 0.5:
                warnings.append(
                    f"path {pa['id']}: planting narrows it to {fmt_m(narrow)} m of walkable "
                    f"surface at its tightest point, against a declared {fmt_m(half * 2)} m — "
                    f"bed {culprit} is over it there. 0.5 m is the narrowest path this "
                    f"project will accept drawn deliberately; grown into, it is the same walk")

        for e in design.get("edges", []) or []:
            if float(e.get("height_m") or 0) < BLOCKING_HEIGHT_M:
                continue
            for q in _walk_line(e.get("spline") or [], 0.3):
                if _near_corridor(q, spline, half):
                    warnings.append(
                        f"path {pa['id']}: {fmt_m(float(e.get('height_m') or 0))} m of "
                        f"{e.get('material', 'edging')} ({e['id']}) stands in the walkway. "
                        f"A barrier across a route is the same problem as one across an "
                        f"area the owner drew")
                    break
        for o in design.get("objects", []) or []:
            pos = o.get("position") or []
            if len(pos) < 2 or float(o.get("height_m") or 0) < BLOCKING_HEIGHT_M:
                continue
            # An object is a footprint, not a point, so half its width can reach
            # in — but TOUCHING the edge is not blocking. A set stone edging a
            # path and a lantern beside one are both correct, and a warning that
            # fires on them is one nobody reads (the same reason the area rule
            # has BLOCKING_HEIGHT_M). So it must actually take walking surface:
            # 0.15 m of real overlap, not contact.
            reach = float(o.get("width_m", 0) or 0) / 2
            if _near_corridor((pos[0], pos[1]), spline, half + reach - 0.15):
                warnings.append(
                    f"path {pa['id']}: a {fmt_m(float(o.get('height_m') or 0))} m "
                    f"{o.get('kind', 'object')} ({o['id']}) reaches into the walkway. "
                    f"If it is a threshold you walk THROUGH, put it on the path; if it "
                    f"is beside the path, give it clearance")

    for b in design.get("beds", []):
        check_pts("bed", b["id"], b["polygon"], connected=True)
    for p in design.get("paths", []):
        check_pts("path", p["id"], p["spline"], connected=True,
                  half_width=float(p.get("width_m", 0) or 0) / 2)
        if not (0.5 <= p["width_m"] <= 3.0):
            errors.append(f"path {p['id']}: width {p['width_m']} m outside 0.5-3.0")
    # check-route and validate() use the same sampler and limits so a route the
    # tools call unwalkable cannot apply clean. A -22.9% stretch with 0.5 m over
    # the default 20% limit needs steps in both checks.
        #
        # level_m is exempt: that path IS the bench, flat by construction, and the
        # cut/fill branch below is what judges it. Grading the raw slope under a
        # terrace walk would reject every terrace on a sloping site.
        if p.get("level_m") is None:
            samples, unmeasured = path_grades(p["spline"])
            free = [g for g in samples if not _under_steps(g[2], design.get("steps", []))]
            if free:
                worst = max(free, key=lambda g: abs(g[0]))[0]
                over = sum(r for g, r, _ in free if abs(g) > c["max_grade"] * 100)
                if abs(worst) > c["max_grade"] * 100:
                    errors.append(
                        f"path {p['id']}: {abs(worst):.1f}% at its steepest, over the "
                        f"{fmt_m(c['max_grade'] * 100)}% a walk can be — {over:.1f} m of it is "
                        f"over the limit. Follow the contour instead, or put a set_steps flight "
                        f"across the steep stretch (risers up to "
                        f"{fmt_m(c['step_riser_max_m'])} m, going at least "
                        f"{fmt_m(c['step_going_min_m'])} m)")
                elif abs(worst) > c["walk_grade"] * 100:
                    warnings.append(
                        f"path {p['id']}: {abs(worst):.1f}% at its steepest — steeper than the "
                        f"{fmt_m(c['walk_grade'] * 100)}% that walks as a comfortable ramp, "
                        f"under the {fmt_m(c['max_grade'] * 100)}% that needs steps")
            if unmeasured > 1.0:
                warnings.append(
                    f"path {p['id']}: {unmeasured:.1f} m of this run is on ground the raycast "
                    f"never saw, so its grade is unknown — it was not graded, in either "
                    f"direction")
    # Steps are the answer to a route too steep to ramp, so what they are judged
    # on is whether their run can actually absorb the fall underneath them. Riser
    # and going are code numbers about an address like every other limit here, so
    # the bounds in schema/ are only the shipped defaults and these are the check
    # that counts.
    for st in design.get("steps", []):
        check_pts("steps", st["id"], st["spline"], connected=True,
                  half_width=float(st.get("width_m", 0) or 0) / 2)
        riser = float(st["riser_m"])
        going = float(st["going_m"])
        if not 0 < riser <= c["step_riser_max_m"]:
            errors.append(
                f"steps {st['id']}: riser {fmt_m(riser)} m is over the "
                f"{fmt_m(c['step_riser_max_m'])} m a comfortable outdoor step rises")
        if going < c["step_going_min_m"]:
            errors.append(
                f"steps {st['id']}: going {fmt_m(going)} m is under the "
                f"{fmt_m(c['step_going_min_m'])} m of tread a foot needs")
        spts = _walk_line(st["spline"])
        top, bottom = scan_at(*spts[0]), scan_at(*spts[-1])
        if top is None or bottom is None:
            warnings.append(
                f"steps {st['id']}: an end of this flight is on UNSCANNED ground, so whether "
                f"its run can absorb the fall could not be checked")
            continue
        if riser <= 0:
            continue
        fall = abs(bottom - top)
        plan = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(spts, spts[1:]))
        need = steps_for_fall(fall, riser, going)
        if need["min_run_m"] > plan + 0.01:
            errors.append(
                f"steps {st['id']}: {fall:.2f} m of fall over {plan:.2f} m of run needs "
                f"{need['risers']} risers at {fmt_m(going)} m of going, which is "
                f"{need['min_run_m']:.2f} m — lengthen the flight, or use a taller riser "
                f"(up to {fmt_m(c['step_riser_max_m'])} m)")
    # A level bench is only buildable if the cut/fill it implies is sane.
    # Without this an arbitrary level renders as a path buried at one end and
    # flying at the other — which looks like a broken design, not a deep cut.
    for pth in design.get("paths", []):
        lvl = pth.get("level_m")
        if lvl is None:
            continue
        miss, tot = _unscanned(_walk_line(pth["spline"]))
        if miss:
            errors.append(
                f"path {pth['id']}: {miss} of {tot} sample points are on UNSCANNED ground, so "
                f"level {lvl} m cannot be checked. Move it onto ground the scan covers, or "
                f"re-scan that part of the site — an unbuildable level is not made safe by "
                f"nobody having measured it")
            continue
        diffs = [lvl - g for g in (ground_at(x, y) for x, y in pth["spline"]) if g is not None]
        if not diffs:
            continue
        worst = max(abs(d) for d in diffs)
        if worst > c["path_level_limit_m"]:
            errors.append(
                f"path {pth['id']}: level {lvl} m needs {worst:.2f} m of cut/fill against the "
                f"measured ground — pick a level nearer the ground, split it into stepped "
                f"benches, or drop level_m and let the path follow the slope")
        elif worst > c["footing_threshold_m"]:
            warnings.append(
                f"path {pth['id']}: level {lvl} m implies up to {worst:.2f} m of cut/fill; "
                f"retaining that needs an engineered footing")
    # A usable area is the one element a person stands on, so it gets the same
    # geometric checks as everything else plus a hard cut/fill bound: a pad you
    # cannot actually build is worse than no pad.
    for pt in design.get("patios", []):
        check_pts("patio", pt["id"], pt["polygon"], connected=True)
        lvl = pt.get("level_m")
        if lvl is None:
            continue
        pts = _walk_polygon(pt["polygon"])
        miss, tot = _unscanned(pts)
        if miss > tot * 0.15:
            errors.append(
                f"patio {pt['id']}: {miss} of {tot} sample points are on UNSCANNED ground, so "
                f"level {lvl} m cannot be checked. A usable area has to sit on measured ground")
            continue
        diffs = [lvl - g for g in (ground_at(x, y) for x, y in pts) if g is not None]
        if not diffs:
            continue
        fill = max(diffs + [0.0])
        cut = max([-d for d in diffs] + [0.0])
        for label, v in (("fill", fill), ("cut", cut)):
            if v > c["retain_limit_m"]:
                errors.append(
                    f"patio {pt['id']}: level {lvl} m needs {v:.2f} m of {label} against the "
                    f"measured ground, more than the {fmt_m(c['retain_limit_m'])} m an edge can "
                    f"retain — make the pad narrower across the fall line, or step it into two "
                    f"levels")
            elif v > c["footing_threshold_m"]:
                warnings.append(
                    f"patio {pt['id']}: level {lvl} m implies {v:.2f} m of {label}; that face "
                    f"needs an engineered footing and probably a permit")

    # A bed on a bench needs its own limit, not a path's. A bed is inherently
    # wider than a walk, so on a 14 deg slope a 4 m wide bed spans a
    # full metre of fall no matter where you set the level — a shared 1.0 m
    # cap therefore rejects every buildable bed and silently sends it back to
    # draping, which is the incoherence level_m exists to fix.
    #
    # What actually bounds a bench is the structure on each side: the FILL at
    # the downhill edge is the wall you must build, and the CUT at the uphill
    # edge is the face you must hold. So bound those two separately, against the
    # same retain_limit_m an edge is allowed. Total span is not the constraint;
    # neither face exceeding a buildable wall is.
    for bd in design.get("beds", []):
        lvl = bd.get("level_m")
        if lvl is None:
            continue
        pts = _walk_polygon(bd["polygon"])
        miss, tot = _unscanned(pts)
        if miss > tot * 0.3:
            errors.append(
                f"bed {bd['id']}: {miss} of {tot} sample points are on UNSCANNED ground, so "
                f"level {lvl} m cannot be checked")
            continue
        diffs = [lvl - g for g in (ground_at(x, y) for x, y in pts) if g is not None]
        if not diffs:
            continue
        fill = max(diffs + [0.0])          # level above ground -> retaining wall
        cut = max([-d for d in diffs] + [0.0])   # ground above level -> cut face
        for label, v in (("fill", fill), ("cut", cut)):
            if v > c["retain_limit_m"]:
                errors.append(
                    f"bed {bd['id']}: level {lvl} m needs {v:.2f} m of {label} against the "
                    f"measured ground, more than the {fmt_m(c['retain_limit_m'])} m an edge can "
                    f"retain — narrow the bed across the fall line, split it into stepped "
                    f"benches, or drop level_m and let it follow the slope")
            elif v > c["footing_threshold_m"]:
                warnings.append(
                    f"bed {bd['id']}: level {lvl} m implies {v:.2f} m of {label}; "
                    f"that face needs an engineered footing")
    # (edge, sampled run, cross-section, top elevation, exposed height) for the
    # two setback rules. A wall with no level_m is in here too: ordinary edging
    # follows the ground, so its top is height_m above it, and two edgings can
    # still be stacked.
    walls = []
    for e in design.get("edges", []):
        check_pts("edge", e["id"], e["spline"], connected=True)
        if not (c["edge_min_height_m"] <= e["height_m"] <= c["retain_limit_m"]):
            errors.append(f"edge {e['id']}: height {e['height_m']} m outside "
                          f"{fmt_m(c['edge_min_height_m'])}-{fmt_m(c['retain_limit_m'])}")
        sec = edge_section(e)
        epts = _walk_line(e["spline"])
        # height_m is what the model DECLARED; when level_m is set the built
        # height is level minus ground, which can be far larger between vertices.
        lvl = e.get("level_m")
        gs = [g for g in (ground_at(x, y) for x, y in epts) if g is not None]
        if lvl is None:
            if gs:
                walls.append((e, epts, sec, max(gs) + float(e["height_m"]), float(e["height_m"])))
                _footing_check(e, sec, float(e["height_m"]), c, errors, warnings)
            continue
        miss, tot = _unscanned(epts)
        if miss:
            errors.append(
                f"edge {e['id']}: {miss} of {tot} sample points are on UNSCANNED ground, so the "
                f"height it would actually stand cannot be checked — and a retaining wall is the "
                f"one thing that must not be guessed")
            continue
        if not gs:
            continue
        exposed = max(lvl - g for g in gs)
        buried = max(g - lvl for g in gs)
        walls.append((e, epts, sec, lvl, exposed))
        _footing_check(e, sec, exposed, c, errors, warnings)
        if exposed > c["retain_limit_m"]:
            errors.append(
                f"edge {e['id']}: declared {e['height_m']} m but at level {lvl} m it stands "
                f"{exposed:.2f} m above ground somewhere along its run — over the "
                f"{fmt_m(c['retain_limit_m'])} m limit. "
                f"Shorten the run, follow the contour, or split it into stepped sections")
        elif exposed > e["height_m"] + 0.25:
            warnings.append(
                f"edge {e['id']}: declared {e['height_m']} m but actually stands {exposed:.2f} m "
                f"at its tallest — the ground falls away under it")
        if buried > 0.5:
            warnings.append(
                f"edge {e['id']}: {buried:.2f} m of this run is BELOW existing ground and will "
                f"be invisible — the wall is on the wrong side of its bench, or the level is too low")
    # A retaining wall exists to hold a surface. If an op that created the wall
    # succeeded but the op that created its bench was REJECTED, the design keeps
        # a wall retaining nothing. A declared 0.45 m wall can stand 1.95 m out
        # of the ground without its intended pad.
    held = {round(o["level_m"], 2)
            for k in ("patios", "beds", "paths")
            for o in design.get(k, []) if o.get("level_m") is not None}
    #
    # A wall holds its surface at one of TWO heights. A FILL wall's bench is at its
    # top. A CUT wall stands at the uphill edge of a terrace sunk into the slope: its
    # top is the natural ground it holds back and the terrace is at its FOOT, level
        # minus height. Checking only the top mislabels a cut wall as holding nothing,
        # creating warnings a designer learns to skip, including real orphan walls.
    for e in design.get("edges", []):
        lvl = e.get("level_m")
        if lvl is None:
            continue
        foot = lvl - float(e.get("height_m") or 0)
        if not any(abs(lvl - h) <= SAME_LEVEL_M or abs(foot - h) <= SAME_LEVEL_M for h in held):
            warnings.append(
                f"edge {e['id']}: retains to level {lvl} m but no bed, patio or path sits at "
                f"that level, nor at its foot ({foot:.2f} m, where a cut wall's terrace would be) "
                f"— this wall holds nothing. Either add the surface it retains or drop its "
                f"level_m so it becomes ordinary edging")

    # A bench that starts right at the top of the wall below it SURCHARGES that
    # wall — the upper terrace's load acts on a wall that was sized to hold only
    # the ground. How far back it has to begin is a soil-and-code number (about
    # one wall height in the rules the limits above come from), so it belongs in
    # site.constraints with them rather than in a rule of thumb here.
    for e, epts, sec, top, exposed in walls:
        if exposed <= c["edge_min_height_m"] or e.get("level_m") is None:
            continue
        need = exposed * c["terrace_setback_ratio"]
        for kind in ("patios", "beds"):
            for o in design.get(kind, []):
                lvl = o.get("level_m")
                if lvl is None or lvl <= e["level_m"] + SAME_LEVEL_M:
                    continue
                poly = o["polygon"]
                # sample the whole outline, not its corners: a bed's nearest
                # point to a wall is usually mid-edge, so vertex-only distance
                # can overestimate the clearance
                gap = _min_gap(_walk_line(list(poly) + [poly[0]]), epts)
                if gap < need:
                    warnings.append(
                        f"{kind[:-1]} {o['id']}: sits {gap:.2f} m behind edge {e['id']}, which "
                        f"stands {exposed:.2f} m out of the ground, and {lvl - e['level_m']:.2f} m "
                        f"above it — inside the {need:.2f} m setback that wall needs "
                        f"({fmt_m(c['terrace_setback_ratio'])}x its height). Move the bench back "
                        f"or make the wall a full terrace step")

    # And the same idea one storey up: a WALL that starts inside the setback of
    # the wall below it is not a second wall, it is the top of the first one.
    # What has to be held is the whole face from the lower wall's toe to the
    # upper wall's top, so that is what gets compared against retain_limit_m —
    # the single-wall rule above, applied to what actually stands there.
    #
    # This is the rule the cross-section exists for. Setback is measured face to
    # face, so thickness_m spends it, and a battered wall's top leans toward the
    # terrace above, so batter_deg spends it too.
    for i, lower in enumerate(walls):
        for upper in walls[i + 1:]:
            lo, hi = (lower, upper) if lower[3] <= upper[3] else (upper, lower)
            (lo_e, lo_pts, lo_sec, lo_top, lo_exp) = lo
            (hi_e, hi_pts, hi_sec, hi_top, _) = hi
            if hi_top <= lo_top + SAME_LEVEL_M:      # side by side, not stacked
                continue
            if lo_exp <= c["edge_min_height_m"]:     # holds nothing to surcharge
                continue
            face = (_min_gap(lo_pts, hi_pts)
                    - lo_sec["thickness_m"] / 2 - hi_sec["thickness_m"] / 2
                    - lo_exp * math.tan(math.radians(lo_sec["batter_deg"])))
            need = lo_exp * c["wall_stack_setback_ratio"]
            if face >= need:
                continue
            combined = lo_exp + (hi_top - lo_top)
            msg = (f"edge {hi_e['id']}: tops out {hi_top - lo_top:.2f} m above edge "
                   f"{lo_e['id']} and stands only {face:.2f} m behind its face — inside the "
                   f"{need:.2f} m setback ({fmt_m(c['wall_stack_setback_ratio'])}x the "
                   f"{lo_exp:.2f} m {lo_e['id']} already retains, measured face to face) — so "
                   f"the two act as ONE wall {combined:.2f} m tall")
            if combined > c["retain_limit_m"]:
                errors.append(
                    msg + f", over the {fmt_m(c['retain_limit_m'])} m one wall may hold. Set the "
                          f"upper wall further back, or drop the terrace between them and build "
                          f"a single step")
            else:
                warnings.append(
                    msg + f". That is still inside the {fmt_m(c['retain_limit_m'])} m limit, but "
                          f"the lower wall carries the upper one's load and was sized to hold "
                          f"only ground")

    plants = design.get("plants", [])
    for pl in plants:
        check_pts("plant", pl["id"], [pl["position"]])

    # A PLANT STANDING ON THE PAVING. "Inside the bed outline" and "on soil" are
    # different questions: offsetting a bed outline by a walk's half-width to
    # close a bare strip can make the polygon SWALLOW the walk. Filling that
    # polygon without checking the paving can place plant centres on the path.
    #
    # A WARNING, not a rejection, and deliberately: a thyme between stepping
    # stones is a real planting, and `paths` covers stone runs as well as walks.
    # Its CANOPY may overhang all it likes, so this tests the centre alone.
    for pa in design.get("paths", []) or []:
        spline = pa.get("spline") or []
        half = float(pa.get("width_m", 0) or 0) / 2
        if len(spline) < 2 or half <= 0:
            continue
        on_it = [pl["id"] for pl in plants
                 if _near_corridor(pl["position"], spline, half)]
        if on_it:
            warnings.append(
                f"{len(on_it)} plant(s) stand ON path {pa['id']} rather than beside "
                f"it ({', '.join(on_it[:6])}{', …' if len(on_it) > 6 else ''}) — a bed "
                f"outline that was offset from a path CONTAINS it, so being inside "
                f"the bed is not the same as being on soil")
    # ONE PLANT PER HOLE — the only spacing that is refused; see PLANTING_HOLE_M.
    # The number in the message is how far INSIDE the limit it is, so the baseline
    # compare (_is_new_or_worse) reads a plant moved out of the hole as better.
    name = lambda p: p.get("common") or p.get("species") or p["id"]
    for i, a in enumerate(plants):
        for b in plants[i + 1:]:
            dist = math.dist(a["position"][:2], b["position"][:2])
            limit, tree = one_hole(a, b)
            if dist >= limit - STORED_POSITION_TOL_M:
                continue
            inside = limit - dist
            if tree is not None:
                other = b if tree is a else a
                errors.append(f"plants {a['id']} and {b['id']}: {other['id']} ({name(other)}) stands "
                              f"{inside:.2f} m inside the trunk and root flare of {tree['id']} "
                              f"({name(tree)}) — nothing can be planted within {TRUNK_M} m of a "
                              f"tree's stem. Move it; how close it stands otherwise is yours to decide")
            else:
                errors.append(f"plants {a['id']} and {b['id']}: {name(a)} and {name(b)} are in one "
                              f"planting hole, {inside:.2f} m nearer than two of the narrowest pots "
                              f"({PLANTING_HOLE_M} m) can stand. Move one; how close plants stand "
                              f"otherwise is yours to decide")

    # CROWDED AT FULL MATURITY — reported, not refused: density is taste,
    # and a deliberately dense bed is legal. It is said at the point of decision,
    # because a design spaced for the ~5-year look reads as finished on screen.
    for bid, m in bed_mature_coverage(design).items():
        if m["coverage"] is not None and m["coverage"] >= MATURE_COVERAGE_WARN:
            warnings.append(f"bed {bid}: at full maturity its {m['plants']} plants cover "
                            f"{m['coverage']}x its {m['ground_m2']} m2 of ground — {m['reading']}; "
                            f"plants are spaced for full size when this is about 1.0-1.3x")

    # A PLANTED SIZE THAT NO LONGER MATCHES THE PALETTE.
    #
    # place_plants COPIES mature_height_m / mature_spread_m out of the palette into
    # the design, so correcting the catalogue does nothing to what is already in
    # the ground. A correction from 1.4 x 1.5 m to 1.8 x 1.8 m leaves planted
    # copies at the smaller size, so their beds underestimate mature coverage
    # until those copies are resynced.
    #
    # REPORTED, not refused, and per species rather than per plant: a cultivar or a
    # measured specimen is a legitimate reason to differ, and 12 identical lines
    # would bury the one fact worth reading.
    try:
        # plant_catalog.catalog() is the ONE palette reader (mtime-cached); a
        # second json.load here would be the duplicate test_dry.py exists to catch
        from plant_catalog import catalog as _palette
        palette = {r["species"]: r for r in _palette().get("plants", [])}
    except Exception:
        palette = {}
    if palette:
        stale = {}
        for p in design.get("plants", []):
            if p.get("size_override") is True:
                continue  # a chosen planning size is not an outdated catalogue copy
            entry = palette.get(p.get("species"))
            if not entry:
                continue
            got = (p.get("mature_height_m"), p.get("mature_spread_m"))
            want = (entry.get("mature_height_m"), entry.get("mature_spread_m"))
            if None in got or None in want:
                continue
            if abs(got[0] - want[0]) > 0.005 or abs(got[1] - want[1]) > 0.005:
                stale.setdefault((p.get("species"), got, want), []).append(p["id"])
        for (species, got, want), ids in sorted(stale.items(), key=lambda kv: -len(kv[1])):
            warnings.append(
                f"{len(ids)} planted {species} still carry {got[0]}x{got[1]} m at maturity, "
                f"but the palette now says {want[0]}x{want[1]} m "
                f"({ids[0]}{' and ' + str(len(ids) - 1) + ' more' if len(ids) > 1 else ''}) — "
                f"spacing and bed coverage are being measured against the old figure")

    # A PLANT THAT BELONGS TO NO BED IS USUALLY A LEFTOVER FROM A BED THAT MOVED.
    #
    # Shrinking a planted bed leaves plants outside the corrected outline. An edit
    # that replaces only plants INSIDE that outline cannot remove those orphans,
    # which can remain on a wall or raised pad outside the intended ground.
    #
    # A WARNING, not a rejection: a specimen set outside a bed is legitimate, and
    # this project enforces physical facts and reports taste. But an orphan is
    # also a plant nothing will mulch or irrigate, so it is worth saying out loud.
    # A BED LAID ACROSS A RETAINING WALL. House-footprint checks do not detect a
    # bed extending over a wall's crest and face. analyze_site.find_walls detects
    # the site's walls into site.walls_detected, and this reports a bed or patio
    # whose outline crosses one.
    #
    # A WARNING: a bed legitimately ABUTS a wall — that is what a retained bed is —
    # and the detector reads a 1 m scan that is fragmentary near structures, so a
    # hard rejection on it would block correct designs on imperfect data.
    for wall in (site or {}).get("walls_detected", []):
        bx, by = wall["bounds_m"]["x"], wall["bounds_m"]["y"]
        for key, label in (("beds", "bed"), ("patios", "patio")):
            for o in design.get(key, []):
                pts = o.get("polygon") or []
                half = wall.get("cell_m", 1.0) / 2.0
                cells = wall.get("cell_xy") or []
                hits = [p for p in pts
                        if any(abs(p[0] - wx) <= half and abs(p[1] - wy) <= half
                               for wx, wy in cells)] if cells else [
                        p for p in pts if bx[0] <= p[0] <= bx[1] and by[0] <= p[1] <= by[1]]
                if hits:
                    warnings.append(
                        f"{label} {o.get('id')}: {len(hits)} of its outline points sit on a "
                        f"detected retaining wall ({wall['rise_m']} m rise at x{bx} y{by}) — "
                        f"check it is beside the wall and not on it: the detector reads 1 m cells, "
                        f"so profile across the edge near ({hits[0][0]}, {hits[0][1]}) with "
                        f"view_mcp.py scan_profile, which reads the mesh every 5 cm and names the step")

    beds = [b.get("polygon") for b in design.get("beds", []) if b.get("polygon")]
    if beds:
        loose = [p for p in design.get("plants", [])
                 if isinstance(p.get("position"), list) and len(p["position"]) >= 2
                 and not any(geom.point_in_polygon(p["position"][0], p["position"][1], poly)
                             for poly in beds)]
        if loose:
            ids = ", ".join(p["id"] for p in loose[:6]) + ("…" if len(loose) > 6 else "")
            warnings.append(f"{len(loose)} plant(s) sit in no bed ({ids}) — nothing will "
                            f"mulch or irrigate them, and after a bed is reshaped they are "
                            f"usually leftovers stranded outside the new outline")
    return errors, warnings


# ------------------------------------------------------------------ op execution
def _check_plant_model(pl):
    """A plant's `asset` must name a model the plant library HAS. The viewer
    finds nothing for an unknown name and silently draws the generic shape instead —
    the same refusal place_object gives a `model` that is not on disk."""
    name = pl.get("asset")
    if not name:
        return
    import asset_store
    if name not in asset_store.plant_library():
        raise ValueError(f"no plant model '{name}' in assets/plants/manifest.json — "
                         "list_assets names them; find_asset {plant: true}, fetch_asset or "
                         "make_asset with a species gets a new one")


def next_id(design, prefix):
    used = {o["id"] for k in DESIGN_KEYS for o in design.get(k, [])}
    i = 1
    while f"{prefix}{i}" in used:
        i += 1
    return f"{prefix}{i}"


# Visual review needs a returned image. Ground-contact measurements and failed
# render attempts remain useful evidence, but neither shows the model a garden.
SEEING_TOOLS = ("walk_through", "look")

LOOK_FEEDBACK = (
    "You have not looked at what you built.\n\n"
    "Everything you placed measures correctly and the garden has never been seen — "
    "not by you. That is what separates a design from geometry that passes: a garden "
    "nobody looked at reads as if it was never looked at — a long path that looks ugly, "
    "a planting that feels like a machine fitting things in — and every one of those "
    "measures well.\n\n"
    "So do the part that was missing:\n"
    "  1. apply-ops your ops to the scratch path supplied above\n"
    "  2. preview_design that scratch path\n"
    "  3. walk_through — stand in it at eye level, on your own paths\n"
    "  4. LOOK at those views and say what is wrong with the GARDEN: where the "
    "walk reads as a road, where a bed is a shape rather than a planting, what you "
    "see when you step out of the house, what you are looking at when you sit down, "
    "what is hidden and what is revealed as you come round a corner.\n"
    "  5. revise it and return the whole op list again.\n\n"
    "You are not being asked for another compliant design. You are being asked to "
    "design it — decide what this garden is like to be in, then make the geometry "
    "serve that. Change what you saw."
)


def looked_at_own_work(log_path, since_bytes):
    """Did THIS run render its own design? True / False / None if unknowable.

    Reads only what was appended after `since_bytes`, because the call log is
    append-only and shared: a walkthrough from an earlier run must not excuse this
    one, which is the same error as reading a design file and believing its
    contents came from the op you just applied.

    None when the log is missing or unreadable. That is missing evidence, not
    visual approval; run() asks again before saving any new geometry.
    """
    try:
        if not os.path.exists(log_path):
            return None
        with open(log_path, "r", errors="replace") as f:
            f.seek(min(since_bytes, os.path.getsize(log_path)))
            tail = f.read()
    except OSError:
        return None
    for line in tail.splitlines():
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if (str(rec.get("cmd") or rec.get("tool") or "") in SEEING_TOOLS
                and rec.get("rendered") is True):
            return True
    return False


# ── LOOKING AT WHAT CHANGED ───────────────────────────────────────────────
#
# A visual review must look at the changed places. The gate above accepts ANY
# rendered view in the round, so a run can rebuild one area, photograph an untouched
# corner, and pass without reviewing its work.
#
# So the round's CHANGES are found by diffing the design before and after its ops, and each
# place something changed must sit inside some frame taken AFTER the round's last edit to
# its scratch file. Geometry only, deliberately: whether the look was any good is taste; that
# it pointed at the work is method.

LOOK_CELL_M = 4.0        # changes are grouped into cells this size; each cell must be seen
LOOK_MAX_M = 25.0        # further than this and a 2 m shrub is a few pixels
LOOK_EDGE = 0.8          # only the middle 80% of the frame counts: the edge is not looking


def _points_in(item):
    """Every ground point that says where a design item is: position, outline, route."""
    out = []
    def add(v):
        if (isinstance(v, (list, tuple)) and len(v) >= 2
                and all(isinstance(c, (int, float)) for c in v[:2])):
            out.append((float(v[0]), float(v[1])))
    for k in ("position", "at", "center", "from", "to"):
        add(item.get(k))
    # `spline` is what paths, edges and steps are drawn with in every saved design;
    # reading `points` instead would miss a moved path because it has no such field
    for k in ("polygon", "spline"):
        for v in item.get(k) or []:
            add(v)
    return out


def changed_places(before, after):
    """Where the round changed the design: added, moved, reshaped or removed items, as
    ground points. Removed ones count — a bed taken out changes what is there to see."""
    places = []
    for key in DESIGN_KEYS:
        old = {i.get("id"): i for i in (before or {}).get(key) or [] if isinstance(i, dict)}
        new = {i.get("id"): i for i in (after or {}).get(key) or [] if isinstance(i, dict)}
        for iid in set(old) | set(new):
            a, b = old.get(iid), new.get(iid)
            if a == b:
                continue
            for it in (a, b):
                if it:
                    places.extend(_points_in(it))
    return places


def views_after_last_edit(log_path, since_bytes):
    """The frames rendered in this round AFTER its last apply-ops, as [{eye, look, fov}].
    A look taken before the last edit is a look at something that is no longer there."""
    try:
        with open(log_path, "r", errors="replace") as f:
            f.seek(min(since_bytes, os.path.getsize(log_path)))
            tail = f.read()
    except OSError:
        return []
    views = []
    for line in tail.splitlines():
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        cmd = str(rec.get("cmd") or rec.get("tool") or "")
        if cmd == "apply-ops":
            views = []
        elif cmd in SEEING_TOOLS and rec.get("rendered") is True:
            views.extend(v for v in rec.get("views") or [] if v.get("eye") and v.get("look"))
    return views


def round_events(log_path, since_bytes):
    """The round in order, from the call log: ("edit", points) for each apply-ops — the
    ground points its ops touched, or None when that cannot be known (a removal names ids,
    not places) — and ("view", frame) for each rendered frame."""
    try:
        with open(log_path, "r", errors="replace") as f:
            f.seek(min(since_bytes, os.path.getsize(log_path)))
            tail = f.read()
    except OSError:
        return []
    events = []
    for line in tail.splitlines():
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        cmd = str(rec.get("cmd") or rec.get("tool") or "")
        if cmd == "apply-ops" and isinstance(rec.get("touched"), list):
            # measured by apply-ops itself from the design before and after — exact
            events.append(("edit", [tuple(p[:2]) for p in rec["touched"]]))
        elif cmd == "apply-ops":
            args = rec.get("args") or {}
            try:
                if args.get("ops"):
                    ops = json.loads(args["ops"])
                else:
                    src = args.get("ops_file") or ""
                    with open(project.resolve(src)) as f:
                        ops = json.load(f)
                ops = ops.get("ops", []) if isinstance(ops, dict) else ops
            except (OSError, ValueError, TypeError):
                ops = None
            pts = [] if ops is not None else None
            for op in ops or []:
                inp = op.get("input") or {}
                if op.get("tool") == "remove_objects":
                    pts = None                      # ids, not places: it may have touched anything
                    break
                for item in [inp] + [q for q in inp.get("plants") or [] if isinstance(q, dict)]:
                    pts.extend(_points_in(item))
            events.append(("edit", pts))
        elif cmd in SEEING_TOOLS and rec.get("rendered") is True:
            events.extend(("view", v) for v in rec.get("views") or [] if v.get("eye") and v.get("look"))
    return events


def unseen_since_touched(places, events):
    """The cells of changed ground with no frame taken AFTER the last edit that touched them.

    A place needs a look after ITS last change, so a small final tweak does not invalidate
    views of unrelated places. An edit whose places cannot be known still counts as
    touching everything. A place no logged edit touched (changed only in the final answer)
    needs a frame after the last edit of all — the strict reading wherever the log
    cannot say more."""
    cells = {}
    for p in places:
        cells.setdefault((math.floor(p[0] / LOOK_CELL_M), math.floor(p[1] / LOOK_CELL_M)), []).append(p)
    edits = [i for i, (kind, _) in enumerate(events) if kind == "edit"]
    last_edit = edits[-1] if edits else -1
    near = LOOK_CELL_M
    missed = []
    for pts in cells.values():
        touched = [i for i in edits
                   if events[i][1] is None
                   or any(math.hypot(a[0] - b[0], a[1] - b[1]) <= near for a in pts for b in events[i][1])]
        since = touched[-1] if touched else last_edit
        views = [v for i, (kind, v) in enumerate(events) if kind == "view" and i > since]
        if not any(sees(v, p) for v in views for p in pts):
            cx = sum(p[0] for p in pts) / len(pts)
            cy = sum(p[1] for p in pts) / len(pts)
            missed.append((round(cx, 1), round(cy, 1), len(pts)))
    return sorted(missed, key=lambda m: -m[2])


def sees(view, point, max_m=LOOK_MAX_M):
    """Is `point` in the middle of this frame, near enough to judge? Plan view only: a frame
    is a wedge on the ground from the eye along the aim, `fov` wide (horizontal, 16:10)."""
    ex, ey = view["eye"][:2]
    lx, ly = view["look"][:2]
    dx, dy = point[0] - ex, point[1] - ey
    dist = math.hypot(dx, dy)
    if dist > max_m:
        return False
    if dist < 0.5:
        return True                       # standing on it counts as having seen it
    ax, ay = lx - ex, ly - ey
    if math.hypot(ax, ay) < 1e-6:
        return False
    vfov = math.radians(view.get("fov") or 55)
    half = math.atan(math.tan(vfov / 2) * 1.6) * LOOK_EDGE
    ang = abs(math.atan2(ax * dy - ay * dx, ax * dx + ay * dy))
    return ang <= half


def _seg_dist(px, py, a, b):
    ax, ay, bx, by = a[0], a[1], b[0], b[1]
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L)) if L else 0.0
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _on_path(x, y, design, slack=0.05):
    for p in (design or {}).get("paths") or []:
        pts = [q[:2] for q in p.get("spline") or []]
        if len(pts) > 1 and min(_seg_dist(x, y, a, b) for a, b in zip(pts, pts[1:])) \
                <= (p.get("width_m") or 1.0) / 2 + slack:
            return p.get("id")
    return None


def camera_report(view, design):
    """Where a camera STANDS and what it FRAMES, against this design.

    A saved camera can outlive the walk it was saved from — left standing inside a bed, framing the
    bed behind the one it is used to judge. The owner's cameras are never moved; a session is told
    instead. Plan view, by `sees` — the gate's own rule."""
    ex, ey = view["eye"][:2]
    stands = None
    path = _on_path(ex, ey, design)
    if path:
        stands = f"on path {path}"
    for pa in (design or {}).get("patios") or []:
        if not stands and geom.point_in_polygon(ex, ey, pa.get("polygon") or []):
            stands = f"on patio {pa.get('id')}"
    raised = len(view["eye"]) > 2 and view["eye"][2] > 2.2      # above head height: a deck, a window
    for b in (design or {}).get("beds") or []:
        if not stands and geom.point_in_polygon(ex, ey, b.get("polygon") or []):
            stands = (f"raised {view['eye'][2]:.1f} m over bed {b.get('id')} — a deck or a window" if raised
                      else f"inside bed {b.get('id')} — no one stands there")
    if not stands and raised:
        stands = f"raised {view['eye'][2]:.1f} m — a deck or a window"
    lx, ly = view["look"][:2]
    aimed = next((b.get("id") for b in (design or {}).get("beds") or []
                  if geom.point_in_polygon(lx, ly, b.get("polygon") or [])), None)
    # WHAT FILLS THE MIDDLE OF THE FRAME: rays across it (the width `sees` counts), each taking the
    # FIRST bed it meets inside the band of ground the middle third of the picture rows falls on.
    # From the lens outward would credit the bed under a raised camera's feet (the sun room's
    # window box, at the frame's bottom edge); a share of each BED in the wedge would rank a far
    # bed over the one in front of the lens. Heights in eye/look are above the ground there.
    ax, ay = lx - ex, ly - ey
    D = math.hypot(ax, ay)
    beds = [(b.get("id"), [q[:2] for q in b.get("polygon") or []]) for b in (design or {}).get("beds") or []]
    hits, n = {}, 21
    if D > 1e-6:
        vf = math.radians(view.get("fov") or 55)
        he = view["eye"][2] if len(view["eye"]) > 2 else 1.65
        hl = view["look"][2] if len(view["look"]) > 2 else 0.5
        ge, gl = ground_at(ex, ey), ground_at(lx, ly)
        drop = (ge - gl if ge is not None and gl is not None else 0.0) + he   # eye over the aim's ground
        pitch = math.atan2(drop - hl, D)
        lo, hi = pitch + vf / 6, pitch - vf / 6
        near = drop / math.tan(lo) if lo > 1e-3 and drop > 0 else 0.0
        far = min(drop / math.tan(hi), LOOK_MAX_M) if hi > 1e-3 and drop > 0 else LOOK_MAX_M
        half = math.atan(math.tan(vf / 2) * 1.6) * LOOK_EDGE
        base = math.atan2(ay, ax)
        for k in range(n):
            t = base - half + 2 * half * k / (n - 1)
            for s in range(max(1, int(near / 0.25)), int(far / 0.25) + 1):
                x, y = ex + math.cos(t) * s * 0.25, ey + math.sin(t) * s * 0.25
                bid = next((i for i, poly in beds if len(poly) > 2 and geom.point_in_polygon(x, y, poly)), None)
                if bid:
                    hits[bid] = hits.get(bid, 0) + 1
                    break
    return {"stands": stands or "on open ground",
            "aimed_at": aimed or "no bed",
            "frames": [f"{i} ({round(c * 100 / n)}% of the frame's middle)"
                       for i, c in sorted(hits.items(), key=lambda kv: -kv[1]) if c / n >= 0.15]}


def _steps(a, b, step):
    n = int((b - a) / step) + 1
    return [a + step * (i + 0.5) for i in range(max(n, 1)) if a + step * (i + 0.5) <= b]


def _paving_points(design, step=0.25):
    """Where a person stands: along every walk's centreline, and inside every patio."""
    out = []
    for p in (design or {}).get("paths") or []:
        pts = [q[:2] for q in p.get("spline") or []]
        for a, b in zip(pts, pts[1:]):
            n = max(1, int(math.hypot(b[0] - a[0], b[1] - a[1]) / step))
            out += [(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n) for i in range(n + 1)]
    for pa in (design or {}).get("patios") or []:
        poly = [q[:2] for q in pa.get("polygon") or []]
        if len(poly) > 2:
            xs, ys = [q[0] for q in poly], [q[1] for q in poly]
            out += [(x, y) for x in _steps(min(xs), max(xs), step * 2) for y in _steps(min(ys), max(ys), step * 2)
                    if geom.point_in_polygon(x, y, poly)]
    return out


def unseen_changes(places, views):
    """The cells of changed ground that no frame looked at, as their centres, worst first."""
    cells = {}
    for p in places:
        cells.setdefault((math.floor(p[0] / LOOK_CELL_M), math.floor(p[1] / LOOK_CELL_M)), []).append(p)
    missed = []
    for pts in cells.values():
        if not any(sees(v, p) for v in views for p in pts):
            cx = sum(p[0] for p in pts) / len(pts)
            cy = sum(p[1] for p in pts) / len(pts)
            missed.append((round(cx, 1), round(cy, 1), len(pts)))
    return sorted(missed, key=lambda m: -m[2])


def look_here(cx, cy, back_m=5.0, footprint=None, design=None):
    """A camera that would see a missed place: standing back from it, eye height, aimed at it.

    Stands where a PERSON stands: given the design, on its nearest walk or patio at least 2 m
    back (within 8 m) — the place judged from where it is seen, not from whatever lies 5 m along
    a compass bearing, which can be the middle of another bed. Otherwise on scanned ground
    and outside the house: a fixed 5 m step south-west can put the camera inside the house, so the
    eight bearings are tried from south-west round. When none is standable the south-west one is
    still returned, so a caller always gets a camera."""
    if footprint is None:
        try:
            with open(SITE_PATH) as f:
                footprint = json.load(f).get("footprint") or []
        except (OSError, ValueError):
            footprint = []
    fp = [q[:2] for q in footprint]
    paving = [(math.hypot(x - cx, y - cy), x, y) for x, y in _paving_points(design)
              if 2.0 <= math.hypot(x - cx, y - cy) <= 8.0
              and not (len(fp) > 2 and geom.point_in_polygon(x, y, fp))]
    if paving:
        _, ex, ey = min(paving)
        return {"eye": [round(ex, 2), round(ey, 2), 1.65], "look_at": [cx, cy, 0.5]}
    d = back_m / math.sqrt(2)
    for dx, dy in ((-d, -d), (-back_m, 0), (-d, d), (0, back_m), (d, d), (back_m, 0), (d, -d), (0, -back_m)):
        ex, ey = cx + dx, cy + dy
        if scan_at(ex, ey) is not None and not (len(fp) > 2 and geom.point_in_polygon(ex, ey, fp)):
            return {"eye": [round(ex, 1), round(ey, 1), 1.65], "look_at": [cx, cy, 0.5]}
    return {"eye": [round(cx - d, 1), round(cy - d, 1), 1.65], "look_at": [cx, cy, 0.5]}


def unseen_feedback(missed, design=None):
    # the camera stands on the design's walks and patios, where the place is seen from
    lines = [f"  - around ({x}, {y}): {n} changed point(s) — try look {json.dumps(look_here(x, y, design=design))}"
             for x, y, n in missed[:8]]
    more = f"\n  ...and {len(missed) - 8} more places" if len(missed) > 8 else ""
    return ("You looked, but not at what you changed.\n\n"
            "After your last apply-ops, no view you took points at these places where this "
            "round added, moved or removed something:\n" + "\n".join(lines) + more + "\n\n"
            "Look AT each one — close enough to judge, in the middle of the frame — say what "
            "is wrong with the garden there, fix it, and return the whole op list again.")


def final_report(design, site=None):
    """One line describing the design that was actually SAVED.

    The design agent verifies its own work by applying its ops to a scratch file
    and calling `composition` on it — and then run() applies the ops for real.
    A check before the final write cannot establish what reaches disk. Measure
    the saved design here so the report describes the committed artefact.

    NEVER RAISES. This runs after the ops are committed, and a report that can
    fail turns a good run into a stack trace and a non-zero exit. Formatting an
    unavailable measurement must not report failure after a successful write.
    """
    try:
        d = design if isinstance(design, dict) else {}
        plants = [p for p in (d.get("plants") or []) if isinstance(p, dict)]
        n = len(plants)
        species = len({p.get("species") for p in plants})

        def _area(objs):
            total = 0.0
            for o in objs or []:
                poly = (o or {}).get("polygon") or []
                if len(poly) > 2:
                    try:
                        total += poly_area(poly)
                    except Exception:
                        pass
            return total

        bed = _area(d.get("beds"))
        patio = _area(d.get("patios"))
        path = 0.0
        for p in d.get("paths") or []:
            spline = (p or {}).get("spline") or []
            width = float((p or {}).get("width_m") or 1.2)
            for a, b in zip(spline, spline[1:]):
                try:
                    path += math.hypot(b[0] - a[0], b[1] - a[1]) * width
                except Exception:
                    pass
        density = f"{bed / n:.2f} m\u00b2 each" if n else "no plants placed"
        return (f"{n} plants in {species} species, {bed:.0f} m\u00b2 of bed "
                f"({density}), {patio + path:.0f} m\u00b2 hardscape "
                f"({path:.0f} path + {patio:.0f} patio)")
    except Exception as e:                      # never take a committed run down
        return f"0 plants — final report unavailable ({e})"


def _error_key(msg):
    """A stable identity for an error: WHICH object, and WHICH rule.

    Error messages carry measurements, so an error that persists but IMPROVES
    reads as a different string. Comparing whole strings can therefore reject an
    improvement: adding steps across a too-steep walk can reduce the length over
    the limit from 1.7 m to 0.5 m without introducing a new error. Existing errors
    must not prevent an op from making the design better.

    The key keeps the subject ("path gate_walk") so a SECOND
    offending object is still new, and strips the numbers from the rule so the
    same complaint about the same object stays the same complaint.
    """
    subject, _, rest = msg.partition(":")
    return subject.strip(), re.sub(r"-?\d+(?:\.\d+)?", "#", rest)


def _magnitudes(msg):
    return [float(v) for v in re.findall(r"-?\d+(?:\.\d+)?", msg)]


def _is_new_or_worse(msg, baseline_by_key):
    """New object, new rule, or the same complaint with a bigger number.

    The second half matters: keying alone would let an op make an EXISTING
    violation worse for free, because the key does not change. Every number in
    these messages is a severity (percent over, metres over the limit, height
    above the cap), so "no number grew" is a sound test for "did not get worse",
    and it fails CLOSED — an unparseable pair counts as worse.
    """
    key = _error_key(msg)
    if key not in baseline_by_key:
        return True
    before, after = _magnitudes(baseline_by_key[key]), _magnitudes(msg)
    if len(before) != len(after):
        return True
    return any(a > b + 1e-9 for b, a in zip(before, after))


def execute(design, site, name, inp, baseline_errors=frozenset(), area=None):
    d = copy.deepcopy(design)
    if name == "set_path":
        for k in ("id", "spline", "width_m", "material"):
            if k not in inp:
                raise ValueError(f"set_path missing '{k}'")
        d["paths"] = [p for p in d.get("paths", []) if p["id"] != inp["id"]]
        d["paths"].append({"id": inp["id"], "spline": inp["spline"],
                           "width_m": inp["width_m"], "material": inp["material"],
                           **({"level_m": inp["level_m"]} if inp.get("level_m") is not None else {})})
        msg = f"path {inp['id']} set ({len(inp['spline'])} pts, {inp['width_m']} m {inp['material']})"
    elif name == "place_plants":
        if not inp.get("plants"):
            raise ValueError("place_plants missing 'plants'")
        added = []
        for pl in inp["plants"]:
            pid = next_id(d, "p")
            # id last: a model-supplied id would otherwise override the unique
            # one and collide with an existing plant
            _check_plant_model(pl)
            d.setdefault("plants", []).append({**pl, "id": pid})
            added.append(f"{pid}={pl['species']}")
        msg = "planted " + ", ".join(added)
    elif name == "set_plants":
        # CHANGE A PLANT THAT IS ALREADY THERE, KEEPING ITS ID.
        #
        # remove_objects + place_plants mints a fresh id, and removing a plant
        # prunes its group membership. Keep the id so a drag, species swap or
        # model revision preserves the owner's groups.
        #
        # Replace-by-id, like every other set_* op: the entry IS the record, so a
        # swap sheds the old species' flower and asset instead of keeping them.
        # It only CHANGES: an id that is not a plant here is refused, because
        # adding is place_plants' job and a typo'd id would otherwise plant one.
        if not inp.get("plants"):
            raise ValueError("set_plants names no plant — give {plants: [{id, species, "
                             "position, ...}]}, one entry per plant to change")
        have = {p["id"]: i for i, p in enumerate(d.get("plants", []))}
        seen, changed = set(), []
        for pl in inp["plants"]:
            pid = pl.get("id")
            if not pid:
                raise ValueError("set_plants: every entry needs the id of the plant it "
                                 "changes — to add a plant use place_plants")
            if pid in seen:
                raise ValueError(f"set_plants: {pid} is given twice in one op")
            seen.add(pid)
            if pid not in have:
                raise ValueError(f"set_plants: there is no plant {pid} in this design — "
                                 "to add one use place_plants")
            if not pl.get("species"):
                raise ValueError(f"set_plants: {pid} has no species")
            pos = pl.get("position")
            if not (isinstance(pos, (list, tuple)) and len(pos) == 2):
                raise ValueError(f"set_plants: {pid} has no position [x, y]")
            _check_plant_model(pl)
            d["plants"][have[pid]] = {**pl, "id": pid}
            changed.append(f"{pid}={pl['species']}")
        msg = "changed " + ", ".join(changed)
    elif name == "set_edge":
        for k in ("id", "spline", "height_m", "edge_material"):
            if k not in inp:
                raise ValueError(f"set_edge missing '{k}'")
        d["edges"] = [e for e in d.get("edges", []) if e["id"] != inp["id"]]
        d["edges"].append({"id": inp["id"], "spline": inp["spline"],
                           "height_m": inp["height_m"], "material": inp["edge_material"],
                           **({"retains": inp["retains"]} if inp.get("retains") else {}),
                           **({"level_m": inp["level_m"]} if inp.get("level_m") is not None else {}),
                           # omitted means "whatever this material is", not zero —
                           # edge_section() resolves it, here and in the renderer
                           **{k: inp[k] for k in ("thickness_m", "batter_deg", "footing_depth_m")
                              if inp.get(k) is not None}})
        msg = (f"edge {inp['id']} set ({len(inp['spline'])} pts, "
               f"{inp['height_m']} m {inp['edge_material']})")
    elif name == "set_patio":
        for k in ("id", "polygon"):
            if k not in inp:
                raise ValueError(f"set_patio missing '{k}'")
        d.setdefault("patios", [])
        d["patios"] = [p for p in d["patios"] if p["id"] != inp["id"]]
        d["patios"].append({"id": inp["id"], "polygon": inp["polygon"],
                            "material": inp.get("material", "decomposed_granite"),
                            **({"purpose": inp["purpose"]} if inp.get("purpose") else {}),
                            **({"level_m": inp["level_m"]} if inp.get("level_m") is not None else {})})
        # NOT `area` — that is this function's area-RESTRICTION parameter, and
        # shadowing it with a float makes validate(d, site, area) do area["polygon"]
        # on a number, causing every set_patio op to raise and be dropped.
        area_m2 = poly_area(inp["polygon"])
        msg = (f"usable area {inp['id']} set ({area_m2:.0f} m2"
               + (f", {inp['purpose']}" if inp.get("purpose") else "")
               + (f", level {inp['level_m']} m" if inp.get("level_m") is not None else "") + ")")

    elif name == "upsert_bed":
        for k in ("id", "polygon"):
            if k not in inp:
                raise ValueError(f"upsert_bed missing '{k}'")
        d["beds"] = [b for b in d.get("beds", []) if b["id"] != inp["id"]]
        d["beds"].append({"id": inp["id"], "polygon": inp["polygon"],
                          "mulch": inp.get("mulch", "shredded_hardwood"),
                          **({"level_m": inp["level_m"]} if inp.get("level_m") is not None else {})})
        msg = f"bed {inp['id']} set ({len(inp['polygon'])} vertices)"
    elif name == "set_steps":
        for k in ("id", "spline"):
            if k not in inp:
                raise ValueError(f"set_steps missing '{k}'")
        c = constraints(site)
        # An omitted riser/going gets the STEEPEST legal flight, because that is
        # the one that fits in the least run — and a model that has just been told
        # "needs steps" is trying to fit them into a stretch that is already short.
        riser = float(inp.get("riser_m") or c["step_riser_max_m"])
        going = float(inp.get("going_m") or c["step_going_min_m"])
        d["steps"] = [t for t in d.get("steps", []) if t["id"] != inp["id"]]
        d["steps"].append({"id": inp["id"], "spline": inp["spline"],
                           "width_m": float(inp.get("width_m") or 1.0),
                           "riser_m": riser, "going_m": going,
                           **({"material": inp["material"]} if inp.get("material") else {})})
        msg = (f"steps {inp['id']} set ({len(inp['spline'])} pts, "
               f"{fmt_m(riser)} m risers, {fmt_m(going)} m going)")
    elif name == "resync_palette":
        # BRING PLANTED SIZES BACK IN STEP WITH THE CATALOGUE.
        #
        # place_plants COPIES mature_height_m / mature_spread_m out of the palette
        # into the design, so fixing the catalogue leaves every plant already in
        # the file on the old figure. A correction from 1.4 x 1.5 m to 1.8 x
        # 1.8 m leaves planted copies small and their beds' mature coverage
        # underestimated until those copies are resynced.
        #
        # IT MUST KEEP THE IDS, which is the whole reason this is an op rather
        # than remove + place_plants: place_plants always mints a fresh id, so
        # the obvious workaround would silently empty the owner's groups, break
        # the alternatives table and invalidate anything holding an id.
        from plant_catalog import catalog as _palette
        entries = {r["species"]: r for r in _palette().get("plants", [])}
        want = inp.get("species")
        if want is not None and not want:
            raise ValueError("resync_palette: 'species' is empty — name the species to "
                             "resync, or omit it to resync every one that has drifted")
        unknown = [s for s in (want or []) if s not in entries]
        if unknown:
            raise ValueError(f"resync_palette: no palette entry for {unknown}")
        changed, by_species = [], {}
        for pl in d.get("plants", []):
            if pl.get("size_override") is True:
                continue  # only the designer's Reset to catalogue size clears a choice
            entry = entries.get(pl.get("species"))
            if not entry or (want is not None and pl["species"] not in want):
                continue
            eh, es = entry.get("mature_height_m"), entry.get("mature_spread_m")
            if eh is None or es is None:
                continue
            was = (pl.get("mature_height_m"), pl.get("mature_spread_m"))
            if None in was or (abs(was[0] - eh) <= 0.005 and abs(was[1] - es) <= 0.005):
                continue
            pl["mature_height_m"], pl["mature_spread_m"] = eh, es
            changed.append(pl["id"])
            by_species.setdefault(pl["species"], [was, (eh, es), 0])[2] += 1
        if not changed:
            msg = "every catalogue-linked planted size already matches the palette; custom sizes kept"
        else:
            detail = "; ".join(f"{n} {sp} {w[0]}x{w[1]} -> {g[0]}x{g[1]} m"
                               for sp, (w, g, n) in sorted(by_species.items()))
            msg = f"resynced {len(changed)} plant(s) to the palette: {detail}"

    elif name == "place_object":
        # The library must never veto the design. `kind` is free text: a kind that
        # can be built gets real geometry, one that cannot gets an honest
        # placeholder at the asked-for size and lands on the want list. Trimming a
        # design to what happens to be modelled can reduce Mediterranean, Japanese
        # or Chinese style to gravel and planting. A lantern, a basin and a raked
        # court ARE the style and must be expressible.
        for k in ("id", "kind", "position"):
            if k not in inp:
                raise ValueError(f"place_object missing '{k}'")
        d.setdefault("objects", [])
        d["objects"] = [o for o in d["objects"] if o["id"] != inp["id"]]
        keep = {k: inp[k] for k in ("height_m", "width_m", "rotation_deg", "material",
                                    "note", "level_m", "tilt_deg")
                if inp.get(k) is not None}
        # A FILE BEATS A BUILDER — the owner's scanned stone rather than a preset that
        # resembles one. Checked here rather than trusted: this string
        # reaches a loader in the browser, and it arrives in a document a model
        # writes. Three refusals, in order of how badly they end:
        #   * outside assets/objects/, or carrying `..` — a path from a document
        #     to a fetch is a shape worth refusing even when nothing is trying
        #   * not a .glb/.gltf — the viewer's loader is a glTF loader
        #   * not on disk — a design naming a file nobody has draws nothing, and
        #     it would fail silently at render time rather than loudly here
        if inp.get("model") is not None:
            model = str(inp["model"]).strip()
            if not model.startswith("assets/objects/") or ".." in model:
                raise ValueError("place_object model must be a path under assets/objects/")
            if not model.lower().endswith((".glb", ".gltf")):
                raise ValueError("place_object model must be a .glb or .gltf file")
            if not os.path.isfile(project.resolve(model)):   # the user's library
                raise ValueError(f"place_object model {model!r} is not on disk — "
                                 "scan it and put it there first")
            keep["model"] = model
        d["objects"].append({"id": inp["id"], "kind": inp["kind"],
                             "position": inp["position"], **keep})
        msg = f"{inp['kind']} {inp['id']} placed at {inp['position']}"

    elif name == "remove_objects":
        if not inp.get("ids"):
            raise ValueError("remove_objects missing 'ids'")
        removed = []
        for k in DESIGN_KEYS:
            keep = [o for o in d.get(k, []) if o["id"] not in inp["ids"]]
            removed += [o["id"] for o in d.get(k, []) if o["id"] in inp["ids"]]
            d[k] = keep
        # A GROUP MAY NOT HOLD A MEMBER THAT NO LONGER EXISTS.
        #
        # `next_id` reuses the lowest free id, so a remove followed by a place —
        # which is every replant — hands a dead id straight to an unrelated new
        # plant, and any group still holding it silently RE-BINDS to that plant.
        # A HIDDEN group would then hide an unrelated part of the garden.
        #
        # Dropping the dead ids here is what makes the reuse safe: the group
        # cannot re-bind to an id it no longer holds. A group emptied to fewer
        # than two members goes, rather than lingering as a row holding one thing.
        gone = set(removed)
        if gone and d.get("groups"):
            kept_groups, dropped, orphaned = [], 0, 0
            for g in d["groups"]:
                members = [m for m in g.get("members", []) if m not in gone]
                orphaned += len(g.get("members", [])) - len(members)
                if len(members) < 2:
                    dropped += 1
                    continue
                kept_groups.append({**g, "members": members})
            d["groups"] = kept_groups
            if orphaned:
                removed = removed + []
                msg_extra = (f"; {orphaned} group member(s) dropped"
                             + (f", {dropped} group(s) emptied" if dropped else ""))
            else:
                msg_extra = ""
            # THE OTHER ID-HOLDER. `alternatives` maps a set to the GROUP
            # chosen for it. Group ids are timestamps and are never reused, so this
            # cannot re-bind like member ids — but emptying the CHOSEN group
            # leaves its id dangling in the map. `chosen()` then falls back to the
            # first surviving option, silently changing the owner's choice and
            # every measurement. Remove the dangling choice too.
            alive = {g["id"] for g in kept_groups}
            for set_id, gid in list((d.get("alternatives") or {}).items()):
                if gid in alive:
                    continue
                del d["alternatives"][set_id]
                now = _alternatives.chosen(d, set_id)
                msg_extra += (f"; the chosen proposal for \"{set_id}\" ({gid}) is gone — "
                              + (f"\"{now}\" counts now" if now else "that set has no proposals left"))
            if d.get("alternatives") == {}:
                del d["alternatives"]
        else:
            msg_extra = ""
        msg = f"removed {removed or 'nothing'}{msg_extra}"
    else:
        raise ValueError(f"unknown tool {name}")

    errors, warnings = validate(d, site, area)
    baseline_by_key = {_error_key(b): b for b in baseline_errors}
    new_errors = [e for e in errors if _is_new_or_worse(e, baseline_by_key)]
    if new_errors:
        raise ValueError("rejected: " + "; ".join(new_errors))
    inherited = [e for e in errors if e in baseline_errors]
    if inherited:
        warnings = warnings + [f"pre-existing issue (not caused by this edit): {e}" for e in inherited]

    # WARNINGS ARE FILTERED THE WAY ERRORS ALREADY ARE.
    #
    # `new_errors` above compares against a baseline, so an op is not blamed for
    # a fault it did not cause. Warnings need the same treatment: the viewer logs
    # the result verbatim, and a successful edit followed by a wall of unrelated
    # complaints is indistinguishable from failure to the user.
    #
    # `design` is untouched here (d is a deepcopy), so the before-state is free to
    # compute. What this op actually caused is reported; the rest is one line.
    try:
        _, before_warnings = validate(design, site, area)
    except Exception:
        before_warnings = []
    carried = set(before_warnings)
    caused = [w for w in warnings if w not in carried]
    kept = len(warnings) - len(caused)
    if kept:
        caused = caused + [f"({kept} pre-existing warning(s) elsewhere in the design, "
                           f"unchanged by this edit)"]
    note = (" | warnings: " + "; ".join(caused)) if caused else ""
    return d, msg + note


# ------------------------------------------------------- the site-query budget
# `--explore` lets the spawned model query the real ground with site_api.py.
# Querying one point at a time wastes calls: `ground-many`/`slope-many` answer a
# whole list in ONE call. Measuring remains necessary, including iterative
# validation while sizing a patio.
#
# The SHAPE matters more than the number. Cutting a model off mid-design hands
# back a half-applied op list: an op the model never gets to submit is a piece of
# the garden silently lost, exactly like a rejected one. So this budget DEGRADES:
# it warns as the limit approaches and, when it runs out, INSTRUCTS the model to
# finish from what it
# already measured. It never raises, and the hook below never denies a call.
#
# With a budget of 180, a 119-call design needs no warning, while a 350-call
# search is told to converge at 126 and finish at 180. Query needs vary by site,
# so this is a parameter (`--call-budget N`, 0 = unbounded), not a fixed limit.
DEFAULT_CALL_BUDGET = 180

# A WHOLE GARDEN FROM NOTHING CAN TAKE LONGER THAN HALF AN HOUR. A round with 83 tool
# calls — 9 applies, 11 looks, 2 walk-throughs, the rest measuring — can need more than
# 1,800 s to finish revising.
# A warm look renders in 2 s; the time is the model reasoning over what it measured and
# saw, which is the work. The limit is per call and can be raised with --timeout-s.
DEFAULT_EXPLORE_TIMEOUT_S = 3600
DEFAULT_BUDGET_WARN_AT = (0.7, 0.9)


class CallBudget:
    """How many site queries a run has left, and what to say about it.

    Plain data plus three messages, so it can be driven directly by a test —
    the enforcement path spawns `claude -p`, which no test may do.
    """

    def __init__(self, limit: int = DEFAULT_CALL_BUDGET,
                 warn_at=DEFAULT_BUDGET_WARN_AT, spent: int = 0,
                 announced=(), by_cmd=None):
        self.limit = int(limit)
        self.warn_at = tuple(sorted(float(f) for f in warn_at))
        self.spent = int(spent)
        self.announced = sorted(float(f) for f in announced)
        self.by_cmd = dict(by_cmd or {})

        # 0 (or negative) is the documented escape hatch: `--call-budget 0` allows
        # unbounded queries.
    @property
    def unlimited(self) -> bool:
        return self.limit <= 0

    @property
    def remaining(self) -> int:
        return 0 if self.unlimited else max(0, self.limit - self.spent)

    @property
    def exhausted(self) -> bool:
        return (not self.unlimited) and self.spent >= self.limit

    def _threshold(self, frac: float) -> int:
        return math.ceil(frac * self.limit)

    def spend(self, n: int = 1, cmds=None) -> str | None:
        """Charge n queries (or one per name in `cmds`). Returns what the model
        should be told, or None. NEVER raises and never refuses: spending past
        the limit is allowed and simply repeats the finish-now instruction, so a
        model that ignores it still gets to submit a whole op list."""
        if cmds is not None:
            n = len(cmds)
            for c in cmds:
                self.by_cmd[c] = self.by_cmd.get(c, 0) + 1
        self.spent += max(0, int(n))
        if self.unlimited:
            return None
        if self.exhausted:
            return self._exhausted_message()
        # A single Bash line can chain several queries, so one spend can jump the
        # whole ladder; take the highest threshold it crossed, not the first.
        crossed = [f for f in self.warn_at
                   if self.spent >= self._threshold(f) and f not in self.announced]
        if not crossed:
            return None
        self.announced = sorted(set(self.announced) | set(crossed))
        return self._warning(max(crossed))

    def _warning(self, frac: float) -> str:
        head = (f"[site query budget] {self.spent} of {self.limit} site queries used, "
                f"{self.remaining} left.")
        if frac >= max(self.warn_at):
            return (head + " CONVERGE NOW: stop searching for new positions and spend what "
                    "is left on `check-ops` for your FINAL op list — that is the one query "
                    "that stops you losing ops. When the budget runs out you will be told "
                    "to finish with what you have, not cut off.")
        return (head + " ASK IN LISTS from here on: `ground-many` and `slope-many` answer a "
                "whole list of points in ONE call, saving a separate query for each point. "
                "Batch the points you need for each decision. Keep designing — just "
                "stop asking one point at a time.")

    def _exhausted_message(self) -> str:
        return (f"[site query budget EXHAUSTED] All {self.limit} site queries for this "
                f"design are spent ({self.spent} used). Nothing has been cancelled and this "
                "is not an error: FINISH THE DESIGN NOW from what you have already measured. "
                "Stop querying, output the single JSON object, and put every level, grade or "
                "route you did not get to verify into `cautions` rather than leaving it "
                "unsaid. An honest cheap design is worth more than a half-measured one that "
                "never arrives.")

    def to_dict(self) -> dict:
        return {"limit": self.limit, "warn_at": list(self.warn_at), "spent": self.spent,
                "announced": list(self.announced), "by_cmd": self.by_cmd}

    @classmethod
    def from_dict(cls, d: dict) -> "CallBudget":
        return cls(limit=d.get("limit", DEFAULT_CALL_BUDGET),
                   warn_at=d.get("warn_at") or DEFAULT_BUDGET_WARN_AT,
                   spent=d.get("spent", 0), announced=d.get("announced") or (),
                   by_cmd=d.get("by_cmd"))


# The ledger. The hook is a FRESH PROCESS for every tool call the spawned model
# makes, so the count has nowhere to live but a file. It sits in a temp dir, not
# in data/, because two agents designing at once must not share a budget.
def budget_load(path: str, limit: int = DEFAULT_CALL_BUDGET,
                warn_at=DEFAULT_BUDGET_WARN_AT) -> CallBudget:
    try:
        with open(path) as f:
            return CallBudget.from_dict(json.load(f))
    except (OSError, ValueError):
        return CallBudget(limit, warn_at)


def budget_store(path: str, budget: CallBudget) -> None:
    with open(path, "w") as f:
        json.dump(budget.to_dict(), f)


def budget_reset(path: str, limit: int = DEFAULT_CALL_BUDGET,
                 warn_at=DEFAULT_BUDGET_WARN_AT) -> CallBudget:
    b = CallBudget(limit, warn_at)
    budget_store(path, b)
    return b


def budget_spend(path: str, n: int = 1, cmds=None) -> str | None:
    # Shell and MCP can answer concurrently. Lock the shared read/update/write
    # so their actual calls cannot overwrite each other's charges.
    import fcntl
    with open(path + ".lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        b = budget_load(path)
        msg = b.spend(n, cmds)
        budget_store(path, b)
        return msg


def budget_from_env(cmd: str) -> str | None:
    """Charge a real tool invocation, independently of a CLI's hook support.

    Only Codex sets this variable. Claude retains its existing shell hook, so a
    call is never charged twice. The same ledger and warning ladder serve both.
    """
    ledger = os.environ.get("YARDTWIN_BUDGET_LEDGER")
    if not ledger:
        return None
    try:
        return budget_spend(ledger, cmds=[cmd])
    except (OSError, ValueError):
        return None


def site_queries_in(command) -> list:
    """The site_api subcommands one Bash command line will run.

    Textual, so a shell `for` loop around the tool reads as one query and is
    UNDER-counted. Deliberately that way round: over-counting would spend a
    model's budget on calls it never made, and the loop is the shape the brief
    already tells it not to write. An invocation whose subcommand is not a bare
    word (`$CMD`, a shell expansion) is charged as "?" rather than let ride
    free — nothing about this may be unbounded.
    """
    if not isinstance(command, str) or "site_api.py" not in command:
        return []
    out = []
    for m in re.finditer(r"site_api\.py\s*(\S*)", command):
        sub = m.group(1)
        out.append(sub if re.fullmatch(r"[a-z][a-z0-9-]*", sub or "") else "?")
    return out


def budget_settings(ledger_path: str) -> dict:
    """Settings for the spawned CLI: a PreToolUse hook on Bash that charges the
    budget and hands back a message.

    agent.py is its own hook, keeping budget handling in one file. The hook is
    ADDITIVE ONLY — it emits context, never a permission decision. If a future
    CLI ignores `additionalContext` the worst case is an unbudgeted run, which
    lets an economy measure fail without losing design work.
    """
    cmd = " ".join(shlex.quote(x) for x in
                   [sys.executable, os.path.join(ROOT, "tools", "agent.py"),
                    "--budget-hook", "--ledger", ledger_path])
    return {"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [
        {"type": "command", "command": cmd, "timeout": 10}]}]}}


def takes_call_budget(fn) -> bool:
    """Does this backend accept the site-query budget?

    run() drives whichever backend it was given through one generic
    `call(prompt, model)`, and several tests stub that backend to exercise the
    loop without the subscription CLI. Forwarding a keyword their stubs do not
    declare would make run() drivable only by a stub written alongside this
    line, so ask instead of assuming. It cannot silently un-wire the budget:
    tests/test_agent_budget.py asserts this answers True for the real
    call_claude_explore, so a rename fails loudly rather than going quiet.
    """
    try:
        ps = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False
    return ("call_budget" in ps
            or any(x.kind is inspect.Parameter.VAR_KEYWORD for x in ps.values()))


def budget_hook_main(argv, stdin_text: str):
    """PreToolUse hook body. Returns (exit_code, stdout).

    Exit code is ALWAYS 0: a non-zero PreToolUse hook blocks the tool call, which
    is the truncation this whole feature exists to avoid. Every failure mode —
    junk on stdin, an unwritable ledger, a tool call that is not a site query —
    is silence, because this runs on every Bash call the design agent makes and a
    traceback here would break a run that has nothing to do with the budget.
    """
    ledger = None
    if "--ledger" in argv:
        i = argv.index("--ledger")
        if i + 1 < len(argv):
            ledger = argv[i + 1]
    try:
        ev = json.loads(stdin_text or "{}")
    except (TypeError, ValueError):
        return 0, ""
    if not isinstance(ev, dict) or not ledger:
        return 0, ""
    inp = ev.get("tool_input")
    cmds = site_queries_in(inp.get("command") if isinstance(inp, dict) else None)
    if not cmds:
        return 0, ""
    try:
        msg = budget_spend(ledger, cmds=cmds)
    except OSError:
        return 0, ""
    if not msg:
        return 0, ""
    return 0, json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                                 "additionalContext": msg}})


# ------------------------------------------------------------------ backends
EXPLORE_BRIEF = """
SEE WHAT YOU ARE PROPOSING, OR DO NOT CLAIM TO HAVE LOOKED.
Your ops are applied only AFTER this run ends. Until then the viewer is showing the
owner's existing design, so a bare `look` renders somebody else's work. Preview
your own proposal before reviewing it so your reasoning concerns the design you
are submitting.

The loop, whenever composition matters (a path's line, whether a route reads as
continuous, whether a terrace sits in the view):
  1. python3 tools/site_api.py apply-ops '<your ops>' --design data/designs/_scratch.json
  2. preview_design path=data/designs/_scratch.json
  3. look — now it is YOUR design
  4. adjust and repeat; preview_design with no path when you are done
Nothing you do to the scratch file touches the owner's working design.

REVIEW THE REAL PLANTING. `look` and `walk_through` always use full botanical
detail at mature size, even if the owner's viewer is in Fast preview. Whole-site
Cycles rendering of a large planting can exceed the local memory budget; use
detailed views for such a design. On a smaller preview, for the planting
or material decision you are about to settle, call `look` with
render="photoreal" from a useful eye-level camera on your current preview. It
returns a Cycles path-traced IMAGE inline; allow a few minutes. Read that image,
state what it reveals, revise if needed, and look again. Geometry is freshly
exported for each photoreal look, so it is your current proposal. If the render
fails or reaches its resource limit, report that limitation and use the detailed
views; do not repeatedly retry the same failed render. Never describe a
Fast preview or a failed render as photoreal. Shadow bearings remain unverified
until the owner sets north; the result says so.

LOOK AT WHAT YOU CHANGED, AFTER YOU CHANGED IT. After your last apply-ops, every place
where you added, moved or removed something must sit in the middle of some frame you then
take (look or walk_through), within 25 m. A round that photographs a corner it never touched
is sent back with the places it missed. Aim `look` at the work: eye a few metres off at
1.65 m, look_at the thing.

GET THE THING, NOT A PLACEHOLDER. When the garden wants an object the library cannot draw
(list_assets: object_kinds and object_models), do not settle for a marked box:
  1. find_asset "<what it is>" — this library, the built-in kinds, free CC0 models, with
     pictures and real sizes
  2. a model fits: fetch_asset its id, LOOK at the picture it returns, and place_object
     with {kind, model: <its model path>, height_m}
  3. nothing IS the thing (it says so): make_asset — write a Blender script that builds it
     at real size in metres, look at the picture, fix the script if it is wrong
A placeholder is the fallback only when both fail; say which failed, and why, in your summary.

DECIDE WHAT THE GARDEN IS LIKE TO BE IN, THEN MAKE THE GEOMETRY SERVE THAT.
Correct measurements alone do not make a garden feel designed. The owner wants
a considered experience, with natural path lines and purposeful planting, so
review the proposal visually as well as checking that its shapes comply.

So before you emit a single op, decide, in a sentence each: what you see when you
step out of the door. Where you are going, and what you pass on the way. Where
you stop, and what you are looking AT when you sit down. What is hidden until you
come round something, and what is revealed when you do. What the garden is doing
in February, when nothing is flowering.

THEN draw geometry that serves those answers, and let the answers decide the
shapes — a path bends because it is going round something worth going round, a
bed is that shape because of what it is hiding or framing. A path drawn to
connect two points by the shortest legal route can read as a road.

WALK IT BEFORE YOU FINISH. `walk_through` puts you at 1.65 m on your own paths
and usable areas — the same viewpoints the owner judges from — and it is the one
check nothing else can do. A path can meet every measured limit and still have
an unattractive line; the owner wants natural, beautiful curves. Apply your ops to
the scratch file, preview it, walk it, and ask yourself whether you would call
that line beautiful. If it looks like a road, it is one.

STEP BACK AS WELL AS IN. `look` shows you one place; the `composition` tool shows
you the whole balance, which is the other half of what a designer sees standing in
a garden. Run it on the scratch file once the bones are in and again before you
finish, and ask yourself whether that is the garden the brief asked for. It reports
and does not judge — a courtyard and a meadow are both correct — so this is your
call to make, not a rule you are passing.

You are designing a real garden on a real, measured 3D scan.

You have SITE QUERY TOOLS. Use them. Run them with Bash from the repo root:

  the `ground_many` tool '[[x,y],[x,y],...]'
      ground elevation at EVERY one of those points, plus the range and how much
      of it the scanner actually saw. ASK IN LISTS — this is one call where a
      loop over `ground` is one process per point.
  the `slope_many` tool '[[x,y],...]' [--radius R]
      slope at every point, banded, with the FLATTEST of them named. Flat ground
      is the scarce resource, so this is usually the question.
  the `ground` tool X Y
      the same for a single point, when you genuinely have only one
  the `slope` tool X Y [--radius R]
      local slope in degrees, downhill bearing, contour bearing, and what that
      grade is good for
  the `profile` tool X1 Y1 X2 Y2 [--step S]
      ground along a line with the grade of each step and the steepest of them
  the `list_assets` tool [--kind plants|objects|materials] [--form F] [--native-only]
      what can actually be BUILT, and — with kind=plants — the plant catalogue in
      the user's library, each with its mature height and spread, water use,
      sun, whether it is evergreen and a California native, and its foliage and flower
      colour. Read it before choosing a palette and COPY the sizes out of it: a mature
      height in a given climate is a fact about a plant, not something to estimate per design,
      and every row is verified to render. You are not confined to the list — anything
      else falls back to its growth form — but these are the species the owner has
      already agreed to live with. Edge materials come with what each one SUITS, which
      is how you choose steel over dry stone over set boulders on a grade.
      MATERIAL IS FREE TEXT on paths, patios, edges and steps, and so is a patio's
      purpose. The lists this returns are what renders AS ITSELF, not a menu. Ask
      for brick, a stone-sett nobedan, a pebble-mosaic court, a timber boardwalk,
      gabion — anything unmodelled still draws and goes on the owner's want list.
      The hardscape IS the style: Mediterranean, Japanese and Chinese influences
      need appropriate materials and objects as well as planting.
  the `composition` tool [--zone Z]
      what your design is MADE OF: hardscape vs planted vs open as shares of the
      zone's real ground, paving split into path/patio/steps, how much of that
      paving landed on steep ground, and bed area per plant. Every OTHER tool
      here answers about one thing at a time, so nothing stops you adding one
      sensible path after another until the yard is paving and no single op
      looks wrong. Preserve the intended balance of paving and planting,
      including on slopes. Call it against your scratch file partway through and
      again before you finish. It does not grade you; the balance is the owner's
      taste. Read it and decide.
  the `check_route` tool '[[x,y],...]' [--steps STEPS] [--level L]
      the route as CIRCULATION: which contiguous stretches are WALKED and which
      are STEPPED, where a landing belongs, and what the validator itself
      concludes. ALWAYS PASS `steps` — the flights already in your design — and
      `level` if the path declares one. A stretch a set_steps flight covers is
      stepped, not a failed ramp, and a path that declares level_m IS the bench.
      Without them the query grades bare points and can disagree with the judge
      about a route whose steps or level bench already address the slope. A steep
      stretch with nothing across it is a REQUEST for set_steps and says how many
      risers and how much LENGTH they eat. A 30 m walk with one 4 m flight in it
      is a design, not a failure.
  the `check_pad` tool '[[x,y],...]' [--level L]
      what a level pad there would COST — max cut, max fill, whether it balances,
      whether it is buildable. OMIT --level to be told the best-balanced level.
  the `check_route` tool '[[x,y],...]' [--width W]
      grades along a proposed path, and whether a person can walk it
  the `best_bench` tool X0 Y0 X1 Y1 [--across A] [--along B]
      SEARCHES a region for the cheapest level pad and returns the best few
  the `near` tool X Y [--radius R]
      what is already at a spot: plants, paths, beds, walls, landmarks
  python3 tools/site_api.py check-ops '[{"tool":...,"input":{...}}, ...]'
      DRY-RUN your whole op list before you answer. Writes nothing. Tells you
      exactly which ops would be rejected and why, so you can fix them now
      instead of losing them.
  the `zones` tool
      the measured yard zones with their grade breakdowns
  python3 tools/site_api.py constraints
      the limits THIS site is judged against — how tall a wall may be, how much
      cut or fill a pad may need, what grade still walks as a ramp. They are
      site data, not universal: read them, do not assume the usual numbers

<call_budget_note>
HOW TO WORK — this matters more than any rule below:

1. LOOK FIRST, AND ASK IN LISTS. Before you place anything, query the ground
   where you intend to put it. Do not estimate an elevation from the ASCII grid;
   ask for it — and ask for all of the points you care about at once.
   `ground-many` and `slope-many` take a whole list and answer it in one call.
   Single `ground`/`slope` calls use one process each, spending a turn per point
   instead of per question.
2. TEST BEFORE YOU COMMIT. Every level pad, bench and terrace must be run
   through check-pad, and every path through check-route, BEFORE it goes in your
   answer. A level that needs more than
   <retain_limit_m> m of cut or fill will be rejected — fix it now, while it is
   cheap, not after you have lost the op. Anything over
   <footing_threshold_m> m needs an engineered footing. `python3 tools/site_api.py
   constraints` prints every limit this site is judged against; they are site
   data, not universal, so read them rather than assuming the usual numbers.
   A walk over <max_grade_pct>% is REJECTED, not warned — check-route tells you the
   steepest stretch, how many metres of it are over, and the riser count and minimum
   run a flight of steps would need. Answer it with set_steps across that stretch, or
   route along the contour. Between <walk_grade_pct>% and <max_grade_pct>% it applies
   with a warning: walkable, but not a comfortable ramp.
   Then run your FINAL op list through check-ops. It applies them to a copy and
   tells you what would be rejected. An op you submit that fails is simply
   dropped, so anything check-ops flags is a piece of your design you will
   silently lose. Keep fixing until it says ok.
3. LET THE SEARCH DO THE SEARCHING. To site a terrace, call best-bench on the
   region rather than guessing coordinates. It tries every position and
   orientation and returns the ones where cut balances fill, which is also the
   ones where no soil has to leave the site.
4. CHECK WHAT IS THERE. Before planting somewhere or routing through it, call
   near — it is how you avoid planting a shrub on your own path.
5. WATCH SCAN COVERAGE. Answers carry scan_coverage. Below about 0.8 the ground
   is interpolated, not measured; do not build there.

6. LOOK AT IT. If the `yardeye` look tool is available, use it on anything you place
   that you are not certain of — especially a bed, patio or terrace near the house or a
   deck. Measurements cannot tell ground from the top of a structure: a bed placed on a
   deck measures perfectly and floats in the air. `look(subject:"bed_1", from:"grazing")`
   puts the camera at the object's own height, which is the view where that is obvious,
   and the reply tells you how much air is under it. If the tool reports no viewer is
   connected, carry on from measurements — it is an extra sense, not a requirement.

When you have verified your design, output your answer as ONE JSON object
matching the schema you were given. Nothing else — no prose around it.

ASK WITH THE TOOLS, NOT THE COMMAND LINE.
Everything about this site is an MCP tool now — the ground, the slope, the sun, what
the owner drew, what the library can build, what is visible from where, and what
your own proposal looks like from any camera you choose. Their descriptions say WHEN
to reach for each one; read them. Prefer those tools to single-point shell calls
so you can ask in batches without recalling command-line syntax.

You may still use Bash for anything without a tool. But if a tool exists, it is the
shorter path and it is the one that keeps working.
"""


BUDGET_NOTE = """YOUR SITE QUERIES ARE BUDGETED: <call_budget> of them for this whole design.
Nothing gets cut off — you are warned as you approach the limit, and when it runs
out you are told to finish with what you have rather than being stopped
mid-design. Asking one point at a time spends the budget quickly: `ground-many`
and `slope-many` answer a whole list in one call instead of a separate `ground`
or `slope` call for each point. Ask in lists to leave time for design decisions.

"""


# THE METHOD HAS ONE HOME: DESIGNING.md, which the session designing in conversation
# reads too. Both backends are pointed at it so they receive the same design method.
# Lessons go THERE, not into this brief.
# A full path: the run's shell starts inside the app folder, so a path from the repository root
# ("pedon/DESIGNING.md") names a file that is not there
METHOD_POINTER = (f"BEFORE YOU DESIGN, read {os.path.join(ROOT, 'DESIGNING.md')} in full (Read "
                  "tool). It is the design method — how a real garden designer "
                  "works on this site — and everything learned about what makes a design good "
                  "or mechanical is there. This brief covers only the mechanics of this run.\n")


def explore_brief(call_budget: int = DEFAULT_CALL_BUDGET) -> str:
    """EXPLORE_BRIEF with this run's budget stated in it, or no claim at all.

    The hook enforces the number; this is what lets the model PLAN around it
    rather than be surprised at 70%. With --call-budget 0 the note is dropped
    entirely — telling a model about a limit that is not enforced is the same
    class of lie as quoting a constraint the validator does not apply.
    """
    n = int(call_budget or 0)
    text = "" if n <= 0 else BUDGET_NOTE.replace("<call_budget>", str(n))
    return METHOD_POINTER + EXPLORE_BRIEF.replace("<call_budget_note>\n", text)


def call_claude_explore(prompt: str, model: str, timeout_s: int = DEFAULT_EXPLORE_TIMEOUT_S,
                        schema_json: str | None = None,
                        call_budget: int = DEFAULT_CALL_BUDGET) -> str:
    """
    Tool-calling mode: the same CLI, but the model may query the site first.

    `claude -p` is Claude Code, so the spawned model already has Bash. That is
    the whole trick — it can run tools/site_api.py and get real answers about
    the ground, with no API key and no server. The one-shot mode below has to
    pre-compute every fact the model might want and inject it, which is always
    one question behind; this lets it ask.

    Longer timeout than one-shot because tool round-trips cost wall-clock, and
    --effort medium rather than low because the point of this mode is that the
    model reasons about what it measured.
    """
    args = ["claude", "-p", "-", "--model", model, "--effort", "medium",
            "--json-schema", schema_json or ops_schema_json(constraints(None))]
    # Eyes, when a viewer is open. --strict-mcp-config matters: without it the
    # subprocess also inherits user-scope MCP servers and spends its context on
    # tool listings that have nothing to do with gardens.
    mcp = os.path.join(ROOT, ".mcp.json")
    if os.path.exists(mcp):
        args += ["--mcp-config", mcp, "--strict-mcp-config",
                 "--allowedTools", "Bash", "Read", *MCP_TOOLS]
    # The budget, live. Stating it in the brief is not enough on its own: a model
    # 300 queries deep is not re-reading the brief. A PreToolUse hook is the only
    # place agent.py can still speak to a run in flight.
    ledger = None
    if call_budget and int(call_budget) > 0:
        try:
            d = tempfile.mkdtemp(prefix="pedon-budget-")
            ledger = os.path.join(d, "budget.json")
            budget_reset(ledger, int(call_budget))
            settings_path = os.path.join(d, "settings.json")
            with open(settings_path, "w") as f:
                json.dump(budget_settings(ledger), f)
            args += ["--settings", settings_path]
        except Exception as e:
            # An economy measure must never cost a design: fall back to the
            # unbounded run rather than failing the call.
            ledger = None
            print(f"  [budget] not installed ({e}); this run is unbounded", file=sys.stderr)
    res = subprocess.run(args, input=prompt, capture_output=True, text=True,
                         timeout=timeout_s, cwd=ROOT)
    if ledger:
        # What it went on, because "29 unbounded validate calls" is the kind of
        # fact that only exists if something writes it down after the run.
        b = budget_load(ledger)
        top = ", ".join(f"{n} {k}" for k, n in
                        sorted(b.by_cmd.items(), key=lambda kv: -kv[1])[:6])
        print(f"  [budget] {b.spent} of {b.limit} site queries used"
              + (f" ({top})" if top else ""), file=sys.stderr)
    if res.returncode != 0:
        raise _cli_failure("claude", res)
    return res.stdout.strip()


def call_claude(prompt: str, model: str, timeout_s: int = 600,
                schema_json: str | None = None) -> str:
    """claude -p on a Claude subscription; prompt rides stdin (never argv);
    --json-schema makes the CLI enforce the response shape.
    --effort low: with renders attached, higher effort costs many minutes without
    improving the design."""
    res = subprocess.run(
        ["claude", "-p", "-", "--model", model, "--effort", "low",
         "--json-schema", schema_json or ops_schema_json(constraints(None))],
        input=prompt, capture_output=True, text=True, timeout=timeout_s)
    if res.returncode != 0:
        raise _cli_failure("claude", res)
    return res.stdout.strip()


def codex_mcp_args(mcp_path: str) -> list[str]:
    """`.mcp.json` translated into codex `-c` overrides.

    Derived from the SAME file `claude -p --mcp-config` is handed, rather than a
    second copy of the server definition. An MCP config that drifts between
    backends would mean the two models are looking through different eyes while
    the logs say `look` for both.

    codex takes config overrides as `-c key=value` with JSON values (its own help
    gives `-c 'sandbox_permissions=["disk-full-read-access"]'`), and its
    config.toml already carries servers in `[mcp_servers.NAME]` form, so the
    mapping is mechanical.
    """
    try:
        with open(mcp_path) as f:
            servers = (json.load(f) or {}).get("mcpServers") or {}
    except (OSError, ValueError):
        return []
    from photoreal import REVIEW_TIMEOUT_S
    out: list[str] = []
    for name, spec in servers.items():
        if not isinstance(spec, dict):
            continue
        if spec.get("command"):
            out += ["-c", f"mcp_servers.{name}.command={json.dumps(spec['command'])}"]
        out += ["-c", f"mcp_servers.{name}.cwd={json.dumps(os.path.dirname(os.path.abspath(mcp_path)))}",
                "-c", f"mcp_servers.{name}.required=true",
                "-c", f"mcp_servers.{name}.tool_timeout_sec={REVIEW_TIMEOUT_S + 30 if name == 'yardeye' else 120}"]
        if spec.get("args"):
            out += ["-c", f"mcp_servers.{name}.args={json.dumps(spec['args'])}"]
        for k, v in (spec.get("env") or {}).items():
            v = os.environ.get(k, v)
            out += ["-c", f"mcp_servers.{name}.env.{k}={json.dumps(v)}"]
        if name == "yardeye":
            names = [t.removeprefix("mcp__yardeye__") for t in MCP_TOOLS]
            out += ["-c", f"mcp_servers.{name}.enabled_tools={json.dumps(names)}"]
            out += ["-c", f'mcp_servers.{name}.env_vars=["YARDTWIN_CALL_LOG", "YARDTWIN_BUDGET_LEDGER", "YARDTWIN_VIEWER"]']
            # These are the project's measurement/render tools, already
            # authorized by a design request. Keep shell sandboxing intact.
            for tool in names:
                out += ["-c", f'mcp_servers.{name}.tools.{tool}.approval_mode="approve"']
    return out


def codex_output_schema(schema):
    """Adapt the shared vocabulary to strict JSON Schema without changing it.

    OpenAI requires closed objects and every property in required. Optional
    fields therefore accept null; strip those transport nulls before execution.
    """
    out = copy.deepcopy(schema)
    def visit(node):
        if not isinstance(node, dict):
            return
        if node.get("type") == "object":
            props = node.get("properties", {})
            required = set(node.get("required", []))
            for key, value in list(props.items()):
                visit(value)
                if key not in required:
                    props[key] = {"anyOf": [value, {"type": "null"}]}
            node["required"] = list(props)
            node["additionalProperties"] = False
        if "items" in node:
            visit(node["items"])
        for key in ("anyOf", "oneOf", "allOf"):
            for item in node.get(key, []):
                visit(item)
    visit(out)
    return out


def without_null_fields(value):
    """Restore omission/default semantics after strict structured output."""
    if isinstance(value, dict):
        return {k: without_null_fields(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [without_null_fields(v) for v in value]
    return value


def _call_codex(prompt, model, timeout_s, schema_json, *, explore=False,
                call_budget=None):
    """Subscription CLI with project tools and a workspace sandbox.

    Ignore unrelated user MCP servers/plugins; authentication is still inherited.
    Keep optional JSONL evidence when YARDTWIN_CODEX_TRACE names a file.
    """
    with tempfile.TemporaryDirectory(prefix="pedon-codex-") as tmp:
        out_path = os.path.join(tmp, "answer.json")
        cmd = ["codex", "exec", "--skip-git-repo-check", "--ephemeral",
               "--ignore-user-config", "--sandbox", "workspace-write" if explore else "read-only",
               "-c", 'approval_policy="never"', "--json",
               "--output-last-message", out_path]
        env = os.environ.copy()
        if explore:
            ledger = os.path.join(tmp, "budget.json")
            budget_reset(ledger, DEFAULT_CALL_BUDGET if call_budget is None else int(call_budget))
            env["YARDTWIN_BUDGET_LEDGER"] = ledger
            mcp_args = codex_mcp_args(os.path.join(ROOT, ".mcp.json"))
            if not mcp_args:
                raise RuntimeError("Codex explore requires pedon/.mcp.json (the yardeye tools)")
            cmd += mcp_args
            cmd += ["-c", "mcp_servers.yardeye.env.YARDTWIN_BUDGET_LEDGER=" + json.dumps(ledger)]
            if env.get("YARDTWIN_CALL_LOG"):
                cmd += ["-c", "mcp_servers.yardeye.env.YARDTWIN_CALL_LOG=" + json.dumps(env["YARDTWIN_CALL_LOG"])]
        if schema_json:
            schema_path = os.path.join(tmp, "schema.json")
            with open(schema_path, "w") as f:
                json.dump(codex_output_schema(json.loads(schema_json)), f)
            cmd += ["--output-schema", schema_path]
        if model:
            cmd += ["-m", model]
        cmd.append("-")
        if explore:
            prompt = (f"Your shell starts in {ROOT}. The repository entry point is "
                      f"{os.path.join(os.path.dirname(ROOT), 'AGENTS.md')} "
                      "(one directory above your working directory; you may already "
                      "have it loaded). Read it, then the file it indexes for design "
                      f"work — {os.path.join(ROOT, 'docs', 'design-agent.md')} and "
                      f"{os.path.join(ROOT, 'DESIGNING.md')}. "
                      "This invocation is landscape design work; return ops for the runner.\n\n"
                      + prompt)
        res = subprocess.run(cmd, input=prompt, capture_output=True, text=True,
                             timeout=timeout_s, cwd=ROOT, env=env)
        trace = env.get("YARDTWIN_CODEX_TRACE")
        if trace:
            with open(trace, "a") as f:
                f.write(res.stdout)
            with open(trace + ".stderr", "a") as f:
                f.write(res.stderr)
            if explore:
                with open(trace + ".budget.json", "w") as f:
                    json.dump(budget_load(ledger).to_dict(), f, indent=2)
        if res.returncode != 0:
            # The useful error is normally at the END, after MCP startup notices.
            raise _cli_failure("codex", res)
        with open(out_path) as f:
            answer = f.read().strip()
        if not answer:
            raise RuntimeError("Codex returned no final design. See the CLI trace; no ops were applied.")
        return json.dumps(without_null_fields(json.loads(answer))) if schema_json else answer


def call_codex_explore(prompt: str, model: str | None, timeout_s: int = DEFAULT_EXPLORE_TIMEOUT_S,
                       schema_json: str | None = None,
                       call_budget: int | None = None) -> str:
    """Measure, preview and see through the same yardeye server as Claude."""
    return _call_codex(prompt, model, timeout_s, schema_json, explore=True,
                       call_budget=call_budget)


def call_codex(prompt: str, model: str | None, timeout_s: int = 600,
               schema_json: str | None = None) -> str:
    """Structured one-shot with read-only shell access."""
    return _call_codex(prompt, model, timeout_s, schema_json)


def strip_fences(s: str) -> str:
    s = s.strip()
    if s.startswith("```"):
        s = s.split("\n", 1)[1] if "\n" in s else s
        if s.rstrip().endswith("```"):
            s = s.rstrip()[:-3]
    start, end = s.find("{"), s.rfind("}")
    return s[start:end + 1] if start >= 0 and end > start else s


def zone_facts(site, c):
    """The per-zone paragraph of the site facts, with THIS site's limits in it.

    Split out of run() so it can be tested: the limit a zone quotes and the
    limit validate() enforces are two different code paths, and when they
    disagree the model designs to the wrong number and loses every pad to a
    rejection it was told would not happen.
    """
        # State which part of the scan each zone covers. Landmark NAMES cannot
        # establish a zone's position: a fence name does not locate a whole area.
    if not site.get("zones"):
        return ""
    z_lines = []
    for z in site["zones"]:
        b = z["bounds_m"]
        g = z["ground_m"]
        gb = z.get("grade_breakdown_m2")
        gp = z.get("gentlest_pocket")
        grade = ""
        if gb:
            grade = (f"\n      GRADE: {gb['flat_under_9deg']} m2 under 9 deg (usable as-is), "
                     f"{gb['moderate_9_18']} m2 at 9-18 deg (terrace or traverse), "
                     f"{gb['steep_over_18']} m2 over 18 deg (plant it, do not build on it).")
            if z.get("max_level_pad_width_m"):
                # analyze_site.py measured these widths (2*limit/tan(slope)) against the
                # limits the site had at the survey, and records them; the limits can have
                # changed since. Width is linear in the limit, so rescale from the limits it
                # was measured with to the ones this sentence quotes — a zone surveyed
                # before they were recorded was surveyed at the defaults.
                used = {**DEFAULT_CONSTRAINTS, **(z.get("pad_width_limits_m") or {})}
                k_r = c["retain_limit_m"] / used["retain_limit_m"]
                k_f = c["footing_threshold_m"] / used["footing_threshold_m"]
                grade += (f" A LEVEL pad here can be at most "
                          f"{round(z['max_level_pad_width_m'] * k_r, 1)} m ACROSS the fall line "
                          f"before it needs more than {fmt_m(c['retain_limit_m'])} m of cut or "
                          f"fill, and about {round(z['easy_level_pad_width_m'] * k_f, 1)} m if "
                          f"you want to stay under {fmt_m(c['footing_threshold_m'])} m "
                          f"and avoid an engineered footing — so make pads and benches LONG "
                          f"along the contour and NARROW across it.")
            if gp:
                grade += (f" The gentlest continuous pocket is {gp['area_m2']} m2 at "
                          f"x {gp['x'][0]}..{gp['x'][1]}, y {gp['y'][0]}..{gp['y'][1]} — "
                          f"this is the scarcest thing in the zone; put a USABLE AREA "
                          f"here, not planting.")
                # Exact ground heights, because reading a level off the ASCII
                # grid can produce pads that need 2 m of cut. As with landmark
                # heights, do the lookup FOR the model.
                pk = []
                for px in range(gp["x"][0], gp["x"][1] + 1):
                    for py in range(gp["y"][0], gp["y"][1] + 1, 2):
                        gh = ground_at(px, py)
                        if gh is not None:
                            pk.append(f"({px},{py})={gh:.2f}")
                if pk:
                    grade += (" Exact ground height inside that pocket: "
                              + ", ".join(pk[:14])
                              + ". Set a pad's level_m from THESE numbers, near their"
                                " middle, not from the ASCII grid below.")
            else:
                grade += " There is no gentle pocket: any usable area must be BUILT on a bench."
        z_lines.append(
            f"  {z['zone']}: {z['area_m2']} m2 of scanned ground, "
            f"x {b['x'][0]}..{b['x'][1]} m, y {b['y'][0]}..{b['y'][1]} m, "
            f"ground {g['min']} to {g['max']} m (median {g['median']}), "
            f"slope {z['slope_deg']} deg falling toward bearing "
            f"{z['downhill_bearing_deg']} deg"
            + (" (UNVERIFIED — north is not set on this capture, so this is "
               "relative to the scan's own heading)"
               if z.get("bearings_unverified") else "")
            + (f", so its CONTOUR runs along bearing {z['contour_bearing_deg']} deg"
               if z.get("contour_bearing_deg") is not None else "")
            + f". {z.get('note','')}" + grade)
    return (
        "\nYARD ZONES (measured by raycasting the scan mesh — authoritative). "
        "When the owner names a yard, use THESE bounds; do not infer the zone "
        "from a landmark's name:\n" + "\n".join(z_lines))


# ------------------------------------------------------------------ agent run
# Every tool view_mcp.py registers, so the allowlist cannot drift behind the
# server. Site queries on MCP let the model ask the ground a question without
# remembering a filename, but only if the allowlist exposes them.
# tests/test_mcp_reachable.py asks the server and fails if the two disagree.
# DERIVED, not hand-listed: a query the design agent is never OFFERED is a query
# it cannot use. See EXTENSIONS.md for the shared registry contract.
#
# The fallback is kept for exactly one case: a `view_mcp` that
# cannot be imported must not take the design runner down with it, the same
# reason view_mcp guards its own `site_api` import. `tests/test_registry.py`
# fails if the fallback and the derived list ever differ, so it cannot rot into a
# second opinion.
_MCP_FALLBACK = (
    "look", "check_ground_contact", "list_viewpoints",
    "ground", "slope", "profile", "check_pad", "check_route",
    "best_bench", "near", "zones", "areas", "area", "preview_design",
    "sun", "list_assets", "sightline", "composition", "scene", "walk_through",
    "usable_area", "scan_profile", "find_asset", "fetch_asset", "make_asset",
    "plan", "compose_planting")
try:
    import registry as _registry
    MCP_TOOLS = _registry.mcp_tool_names()
except Exception:                              # noqa: BLE001 - report, never crash
    MCP_TOOLS = ["mcp__yardeye__" + t for t in _MCP_FALLBACK]


def design_fingerprint(design):
    """A stable identity for the DESIGNED content of a document.

    It answers exactly one question — did this round change the design? — so it
    covers DESIGN_KEYS and nothing else. A document also carries `version`, the
    units and whatever bookkeeping a writer adds, and a round that touched only
    those has changed nothing a person could stand in.

    Identity, not rank. There is deliberately no comparator here: the moment a
    run can order its own rounds it has a metric that can displace the owner's
    judgement of the garden.
    """
    return json.dumps({k: design.get(k) or [] for k in DESIGN_KEYS}, sort_keys=True)


def scratch_for(design_path):
    """A scratch document per destination, so variants do not overwrite each other."""
    p = os.path.abspath(design_path)
    name = "_" + os.path.splitext(os.path.basename(p))[0] + "_scratch.json"
    if p.startswith(project.folder() + os.sep):         # the site's own folder (data/ when none is open)
        return project.data("designs", name)
    return os.path.join(os.path.dirname(p), name)


# The revision round repeats design and visual review. A gate rejects a pass
# that produces geometry without rendering it; the loop keeps what is built,
# stands in it, says what is wrong with the GARDEN, and changes it until a round
# changes nothing or the budget runs out.
#
# Nothing here judges the result. The stopping rule is arithmetic on the design's
# identity and the model's own word that it is finished; what "wrong" means is
# left entirely to what the model SAW, in words. Even a number offered only as
# a reference can become an optimisation target that displaces visual judgement.
REVISE_FEEDBACK = """You have built this. Now stand in it and change what you see.

Round <round> of <rounds>. The design printed above as CURRENT is
YOUR design as it now stands — every op you returned last round has been applied
and validated. It is also written out ready to render at <scratch>, so you do not
have to rebuild it before you can look at it.

Review and revise before finishing. Correct measurements alone cannot tell you
whether a path looks natural or planting feels considered; the owner needs you
to judge the garden from the views they experience.

So:
  1. preview_design path=<scratch>
  2. walk_through — 1.65 m, on your own paths, at mature size. Then look at what
     the walk does not cover: the view from the door, what you face when you sit
     down, a bed from its own height.
  3. Say what you SAW, in `seen`, in plain words and about the GARDEN rather than
     the geometry — where the walk reads as a road, where a bed is an outline
     rather than a planting, what is bare in February, what you meant to screen
     and did not, where the eye travels and where it has nothing to rest on.
  4. Then return the ops that make those sentences untrue. Reuse the ids already
     in the design so an op edits the thing rather than adding a second one
     beside it.

You are not being asked to add more. Taking something out, moving one line, or
letting a bed swallow the corner it was skirting are all revisions, and the
garden is usually one element away from reading as designed rather than assembled.

If you have looked and would change nothing, return `done: true` with an empty
ops list and put in `seen` what you saw that settled it. That ends the loop, it
costs nothing, and it is a real answer.
"""


def revise_feedback(round_no, rounds, scratch):
    """REVISE_FEEDBACK with this round's numbers and its scratch file in it."""
    return (REVISE_FEEDBACK
            .replace("<round>", str(round_no))
            .replace("<rounds>", str(rounds))
            .replace("<scratch>", scratch))


DEFAULT_ROUNDS = 1



class AgentStopped(RuntimeError):
    """The run stopped without a design to save. Carries a sentence saying why, and where
    the model's own work in progress is — never a traceback that hides both."""


class AgentTimedOut(AgentStopped):
    """The model ran out of time."""


class BackendFailed(RuntimeError):
    """The CLI behind the model exited with an error. Carries what it SAID."""


def _cli_failure(name, res):
    """What a failed CLI said, from BOTH streams. `claude -p` reports an API error on stdout
    and can leave stderr empty, so reading stderr alone can hide the reason for a
    failure, such as a network outage."""
    said = " | ".join(t.strip()[-600:] for t in (res.stderr or "", res.stdout or "") if t and t.strip())
    return BackendFailed(f"{name} exit {res.returncode}: {said or 'it said nothing'}")


def _where_the_work_is(design_path):
    wip = scratch_for(design_path)
    return (f"Its work in progress is in {os.path.relpath(wip, ROOT)} — open it from the Saved "
            f"list or with preview_design." if os.path.exists(wip)
            else "It had not saved any work in progress.")



def ground_heights_text(tp):
    """The terrain.json grid as the brief shows it. NORTH ROW FIRST — as the viewer writes it
    (exportTerrain) and filled_at reads it. Reversing that description flips the site
    north to south for the model reading the grid."""
    return (
        f"\n\nGROUND HEIGHTS (metres above the reference plane, {tp['cell_m']} m grid; "
        f"rows run north->south — the first row is y = {tp['y1']}, the last y = {tp['y0']}; "
        f"columns west->east, x from {tp['x0']} to {tp['x1']}; '..' = not scanned):\n"
        + "\n".join(" ".join(v) for v in tp["rows"])
        + f"\nElevation range {tp['min_m']} to {tp['max_m']} m. "
          "Read heights from the LANDMARK list above where you can — the numbers "
          "there are exact. Use this grid for the shape of the ground between them. "
          "Use it: level benches suit patios and beds, steep runs need terracing, "
          "and a path should traverse or switchback rather than climb the fall line.")


def backend_warning(backend: str, explore: bool) -> str | None:
    """Both explore backends have tools and a live, advisory call budget."""
    return None


def run(prompt, backend="claude", model=None, design_path=DESIGN_PATH, quiet=False,
        explore=False, area=None,
        images=None, selection=None, call_budget=DEFAULT_CALL_BUDGET,
        rounds=DEFAULT_ROUNDS, timeout_s=None):
    with open(design_path) as f:
        design = json.load(f)
    site = None
    if os.path.exists(SITE_PATH):
        with open(SITE_PATH) as f:
            site = json.load(f)
    c = constraints(site)

    site_summary = "site.json not available (no footprint/zone constraints)."
    if site:
        # site.json may hold only landmarks (the viewer writes one before
        # geodata.py has ever run), so every field here must be optional
        site_summary = (f"USDA zone: {site.get('usda_zone')}. House footprint (ENU m): "
                        f"{json.dumps(site.get('footprint') or [])}")
        if site.get("landmarks"):
            # ground height per landmark: locating a coordinate by index
        # arithmetic in the ASCII grid below can misread it by ~3 m and cause
        # every level to be rejected, so state it
            lm_lines = []
            for lm in site["landmarks"]:
                g = ground_at(lm["x"], lm["y"])
                lm_lines.append(
                    f"  {lm['name']}: x={lm['x']}, y={lm['y']}"
                    + (f", ground {g:.2f} m" if g is not None else ", ground not scanned"))
            site_summary += ("\nLandmarks (ENU m, clicked by the owner in the yard scan — "
                             "ground truth):\n" + "\n".join(lm_lines))
        fr = site.get("frame") or {}
        if fr.get("warning"):
            site_summary += f"\n\nFRAME WARNING: {fr['warning']}"
        site_summary += zone_facts(site, c)
        if site.get("house_measured"):
            hm = site["house_measured"]["bounds_m"]
            site_summary += (f"\nHouse occupies x {hm['x'][0]}..{hm['x'][1]} m, "
                             f"y {hm['y'][0]}..{hm['y'][1]} m — place nothing inside it.")
        if site.get("scan_coverage"):
            sc = site["scan_coverage"]
            site_summary += (f"\nScanned ground: {sc['scanned_ground_m2']} m2 total, one "
                             "connected region. The height grid below is FILLED and extends "
                             "past the real scan edge — stay inside the zone bounds above.")
        if site.get("terrain"):
            t = site["terrain"]
            site_summary += f"\nTerrain (measured from the scan): slope {t.get('slope_deg')} deg"
            if t.get("downhill_azimuth_deg") is not None:
                site_summary += (f", downhill toward compass bearing "
                                 f"{t['downhill_azimuth_deg']} deg (0=north, 90=east)")
            else:
                site_summary += (" (downhill direction NOT measured — do not assume which way "
                                 "the fall runs; ask the owner to confirm it)")
            site_summary += "."

    # Terrain profile: without it the agent knows the yard slopes but not WHERE
    # it is steep, so it cannot tell a natural bench from a fall line.
    terrain_path = project.data("terrain.json")
    if os.path.exists(terrain_path):
        try:
            with open(terrain_path) as f:
                tp = json.load(f)
            site_summary += ground_heights_text(tp)
        except (OSError, KeyError, json.JSONDecodeError):
            pass

    # Views of the actual yard, with the current design already drawn in them —
    # so each round sees the previous round's work standing in the space.
    if images:
        site_summary += (
            "\n\nVIEWS OF THE YARD: read these images before designing — "
            + " , ".join(images) +
            "\nThey are renders of the owner's 3D scan from three angles, with any existing "
            "design already placed. Judge the space from them: what is already there, where "
            "the ground is level, what a new element would sit next to or block. "
            "If what you see contradicts the numbers, say so in cautions rather than "
            "silently designing around it.")

    area_obj = None
    if area:
        ar = next((a for a in (site or {}).get("areas", [])
                   if a["name"].lower() == area.lower()), None)
        if not ar:
            have = [a["name"] for a in (site or {}).get("areas", [])]
            raise SystemExit(f"no area named '{area}'. Drawn areas: {have or 'none'}")
        xs = [p[0] for p in ar["polygon"]]
        ys = [p[1] for p in ar["polygon"]]
        site_summary += (
            f"\n\nWORK ONLY INSIDE THE AREA \"{ar['name']}\", which the owner drew on the "
            f"ground. Its outline in ENU metres is {json.dumps(ar['polygon'])} — bounds "
            f"x {min(xs):.1f}..{max(xs):.1f}, y {min(ys):.1f}..{max(ys):.1f}. Every point of "
            f"everything you place must fall inside it. Run "
            f"`python3 tools/site_api.py area {ar['name']}` for its grade, ground range and "
            f"what is already there.")
        area_obj = ar
    if selection:
        site_summary += (
            "\n\nSELECTED BY THE OWNER: " + ", ".join(selection) +
            "\nThe request below is about THESE objects. Modify or replace them (reuse their "
            "ids) rather than adding new ones, unless the request clearly asks for something "
            "additional. Leave everything else alone.")
    baseline_errors = frozenset(validate(design, site, area_obj)[0])
    if baseline_errors and not quiet:
        print(f"  [baseline] {len(baseline_errors)} pre-existing validation issue(s) tolerated this run")

    if backend == "claude":
        # the tool schema states the edge-height range, so it is per-site too
        base = call_claude_explore if explore else call_claude
        schema_json = ops_schema_json(c)
        extra = ({"call_budget": call_budget}
                 if explore and takes_call_budget(base) else {})
        if explore and timeout_s:
            extra["timeout_s"] = int(timeout_s)
        def call(p, m):
            return base(p, m, schema_json=schema_json, **extra)
    else:
        warn = backend_warning(backend, explore)
        if warn and not quiet:
            print(f"  [backend] {warn}")
        codex_schema = ops_schema_json(c)
        codex_base = call_codex_explore if explore else call_codex
        extra = ({"call_budget": call_budget}
                 if explore and takes_call_budget(codex_base) else {})
        if explore and timeout_s:
            extra["timeout_s"] = int(timeout_s)
        def call(p, m):
            return codex_base(p, m, schema_json=codex_schema, **extra)
    model = model or ("claude-opus-5" if backend == "claude" else None)

    feedback = ""            # about THIS attempt: bad JSON, rejected ops, no look
    round_feedback = ""      # about THIS ROUND: revise what you built
    mutations, summary, confidence, cautions = 0, "", "", ""
    log_path = os.environ.get("YARDTWIN_CALL_LOG", project.data("site_api_calls.log"))
    scratch = scratch_for(design_path)
    scratch_name = os.path.relpath(scratch, ROOT)
    if scratch_name.startswith(".."):
        scratch_name = scratch
    rounds = max(1, int(rounds or 1))
    seen_by_round = []
    stop_reason = None
    round_no = 0

    # TWO LOOPS, NESTED, and they count different things.
    #
    # The inner one counts FAILURES — malformed JSON, rejected ops — and its
    # budget of three is a recovery allowance for a pass that did not come back
    # usable. The outer one counts SUCCESSES being taken further: a round that
    # produced a design, was stood in, and is now being revised.
    #
    # Sharing one counter would make a parse error silently cost a look, and would
    # leave a third round with nothing to recover a rejected op with. They are
    # separate because they are not the same quantity;
    # tests/test_design_loop.py::test_a_parse_error_does_not_cost_a_design_round
    # needs four model calls, which no single range(3) can produce.
    for round_no in range(1, rounds + 1):
        round_start = design_fingerprint(design)
        # Where the call log stands NOW, so "did this round look" means THIS
        # ROUND. The log is append-only: a mark taken once at the start of the run
        # would let round one's walkthrough excuse every round after it, which is
        # the same scope rule that looked_at_own_work enforces one level up.
        log_mark = os.path.getsize(log_path) if os.path.exists(log_path) else 0
        applied = 0
        obj = None
        for attempt in range(3):
            log_mark = os.path.getsize(log_path) if os.path.exists(log_path) else 0
            # The prompt must quote the limits validate() is about to enforce, not the
            # ones this file happened to ship with.
            head = with_limits(
                f"{SYSTEM}\n\n{explore_brief(call_budget)}" if explore else SYSTEM, c)
            # Name the file this run designs so the model cannot mistake the owner's
            # working file for its own variant and claim to replace the working design.
            target = os.path.relpath(os.path.abspath(design_path), ROOT)
            working = os.path.abspath(design_path) == os.path.abspath(DESIGN_PATH)
            full = (f"{head}\n\nSITE:\n{site_summary}\n\n"
                    f"THIS RUN DESIGNS {target}"
                    + ("" if working else " — a separate variant. The owner's working design "
                       "(data/design.json) is not part of this run and is never changed by it; "
                       "do not describe this design as replacing it")
                    + f". CURRENT {target}:\n"
                    f"{json.dumps(design, indent=1)}\n\nREQUEST: "
                    f"{prompt}{round_feedback}{feedback}")
            full = full.replace("data/designs/_scratch.json", scratch_name)
            try:
                raw = call(full, model)
            except BackendFailed as e:
                raise AgentStopped(
                    f"The design agent's backend stopped before it returned a design ({e}); nothing "
                    f"was written to {os.path.relpath(design_path, ROOT)}. "
                    f"{_where_the_work_is(design_path)}") from None
            except subprocess.TimeoutExpired as e:
                where = _where_the_work_is(design_path)
                raise AgentTimedOut(
                    f"The design agent ran out of time after {int(e.timeout)} s, before it returned "
                    f"its design; nothing was written to {os.path.relpath(design_path, ROOT)}. "
                    f"{where} Run again with a longer --timeout-s, or a smaller request.") from None
            try:
                obj = json.loads(strip_fences(raw))
            except json.JSONDecodeError as e:
                feedback = f"\n\nYOUR PREVIOUS RESPONSE WAS NOT VALID JSON ({e}). Respond with ONLY the JSON object."
                if not quiet:
                    print(f"  [retry] invalid JSON from {backend}")
                continue
            errors = []
            design_before_ops = json.loads(json.dumps(design))
            d = design
            n = 0
            for op in obj.get("ops", []):
                try:
                    d, msg = execute(d, site, op.get("tool", "?"), op.get("input", {}),
                                     baseline_errors, area_obj)
                    n += 1
                    if not quiet:
                        print(f"  [op] {op['tool']}: {msg}")
                except Exception as e:
                    errors.append(f"{op.get('tool')}: {e}")
                    if not quiet:
                        print(f"  [op] {op.get('tool')} REJECTED: {e}")
            if errors and attempt == 0:
                feedback = ("\n\nSOME OF YOUR OPS WERE REJECTED by the validators:\n- "
                            + "\n- ".join(errors)
                            + "\nResend the FULL corrected JSON object (all ops, fixed).")
                continue
            design, applied = d, n
            # CODE MEASURES; THE MODEL DECIDES. This loop must not change the design
            # after the model's ops: it neither deletes walls nor rearranges plants.
            # validate() REPORTS a wall holding nothing; the model decides what to
            # change and where each plant stands.

            # ── the design has to have been SEEN ────────────────────────────────
            #
            # Correct measurements do not establish visual quality. Require a review
            # between proposing and finishing so the model sees its own garden.
            #
            # A prompt to look and walk is not evidence that either happened. The
            # gate checks the log so the review requirement is enforced.
            #
            # This is a requirement on METHOD, like measuring before building.
            # Nothing here has an opinion about what the garden should be.
            #
            # PER ROUND, not per run. A revision that changed the geometry and
            # never rendered the change is the same defect wearing a later
            # number, and a run-level flag would excuse it because round one had
            # already looked.
            # AND AT WHAT CHANGED: accepting a view anywhere would let a run
            # photograph an untouched corner and pass.
            looked = looked_at_own_work(log_path, log_mark) if (explore and applied) else None
            missed = []
            if looked is True:
                missed = unseen_since_touched(changed_places(design_before_ops, design),
                                              round_events(log_path, log_mark))
            if explore and applied and (looked is not True or missed):
                if attempt == 2:
                    raise AgentStopped(
                        f"No visual review of what changed, three times: the design came back with changed "
                        f"places no view had looked at after their last change "
                        f"({len(missed) if missed else 'no render at all'}); "
                        f"nothing was written to {os.path.relpath(design_path, ROOT)}. "
                        f"{_where_the_work_is(design_path)}")
                feedback = "\n\n" + (unseen_feedback(missed, design) if missed else LOOK_FEEDBACK)
                design = json.loads(json.dumps(design_before_ops))   # discard, re-decide
                applied = 0
                if not quiet:
                    print(f"  [look] {len(missed)} changed place(s) never looked at — sending it back"
                          if missed else
                          "  [look] this round never rendered its own design — "
                          "sending it back to walk what it built and revise")
                continue

            mutations += applied
            summary = obj.get("summary", "")
            confidence = obj.get("confidence", "")
            cautions = obj.get("cautions", "")
            break
        else:
            # Three attempts and nothing usable came back. Another round would be
            # another three, against a backend that is not answering.
            obj = None

        if obj is None:
            break

        # ── the round is over; decide whether there is another one ──────────
        seen = (obj.get("seen") or "").strip()
        if seen:
            seen_by_round.append((round_no, seen))
            if not quiet:
                print(f"  [seen] round {round_no}: {seen}")
        if not quiet and rounds > 1:
            print(f"  [round] {round_no} of {rounds}: {applied} op(s) applied")

        if obj.get("done"):
            stop_reason = "the model stood in it and would change nothing"
        elif design_fingerprint(design) == round_start:
            stop_reason = "the round changed nothing"
        elif round_no == rounds:
            stop_reason = "the round budget is spent"
        if stop_reason:
            if not quiet and rounds > 1:
                print(f"  [round] stopped after {round_no} of {rounds}: {stop_reason}")
            break

        # Hand the NEXT round something it can render without rebuilding it. A
        # revising round is a fresh `claude -p` with no memory of the last one, so
        # if standing in its own design costs it twenty ops of reconstruction it
        # may skip standing in it. Keep its own design ready to review.
        try:
            os.makedirs(os.path.dirname(scratch), exist_ok=True)
            with open(scratch, "w") as f:
                json.dump(design, f, indent=1)
        except OSError as e:
            if not quiet:
                print(f"  [round] could not write {scratch_name}: {e}")
        round_feedback = "\n\n" + revise_feedback(round_no + 1, rounds, scratch_name)
        feedback = ""

    # Measure what reached disk so the report describes the saved artefact.
    if not quiet:
        print(f"  [final] {final_report(design, site)}")

    # The words are the deliverable — the loop measures nothing, so what the model
    # SAW is the only account of why the garden ended up like this, and run()'s
    # summary is the one string the viewer's Design button ever shows the owner.
    if seen_by_round:
        summary = (summary + "\n\nWhat I saw:\n"
                   + "\n".join(f"  round {i}: {t}" for i, t in seen_by_round)).strip()

    return design, mutations, summary, confidence, cautions


SCHEMA_VERSION = 1


def archive_working_design(path):
    """Keep what a write is about to replace, where Designs -> History can find it.

    ONE rule for every writer (site_api apply-ops and this runner's save): only the
    WORKING design is archived, and only when it holds something. data/history is the
    working design's timeline; a variant must not appear there as a past version of the
    owner's working garden. A failure to archive never blocks the write."""
    try:
        if os.path.abspath(path) != os.path.abspath(DESIGN_PATH) or not os.path.exists(path):
            return None
        with open(path) as f:
            before = json.load(f)
        if not any(before.get(k) for k in ("beds", "paths", "edges", "plants")):
            return None                  # nothing worth keeping
        hist = project.data("history")
        os.makedirs(hist, exist_ok=True)
        out = os.path.join(hist, f"design-{dt.datetime.now().strftime('%Y%m%d-%H%M%S')}.json")
        with open(out, "w") as f:
            json.dump(before, f, indent=1)
        return out
    except Exception as e:                # an archive is a safety net, never a gate
        print(f"(could not archive the working design: {e})", file=sys.stderr)
        return None


def save(design, design_path=DESIGN_PATH):
    # `version` is required by the schema. Write it so every op does not repeat
    # a missing-property warning: constant noise teaches users to ignore warnings.
    design.setdefault("version", SCHEMA_VERSION)
    design.setdefault("units", "meters")
    archive_working_design(design_path)
    with open(design_path, "w") as f:
        json.dump(design, f, indent=2)


def main():
    # PreToolUse hook mode. Claude Code runs this as a fresh process for every
    # Bash call the spawned design model makes, so it is handled before argparse:
    # it has its own tiny argument list and must stay cheap and silent.
    if "--budget-hook" in sys.argv[1:]:
        rc, out = budget_hook_main(sys.argv[1:], sys.stdin.read())
        if out:
            print(out)
        sys.exit(rc)

    ap = argparse.ArgumentParser()
    ap.add_argument("prompt", nargs="?", default=None)
    ap.add_argument("--backend", default="claude", choices=["claude", "codex"])
    ap.add_argument("--model", default=None,
                    help="claude: model id (default claude-opus-5); codex: -m value (default: codex default)")
    ap.add_argument("--design", default=DESIGN_PATH, metavar="PATH",
                    help="design file to read and write (default data/design.json); lets "
                         "several variants be generated in parallel")
    ap.add_argument("--selection", default=None, metavar="ID,ID",
                    help="ids the user selected in the viewer; the request applies to them")
    ap.add_argument("--json", action="store_true",
                    help="emit one JSON result object (used by the viewer's Design button)")
    ap.add_argument("--image", action="append", default=None, metavar="PATH",
                    help="render of the yard for the agent to look at (repeatable)")
    ap.add_argument("--area", default=None, metavar="NAME",
                    help="restrict the design to a region the owner drew in the viewer; "
                         "enforced by the validator, not merely suggested")
    ap.add_argument("--explore", action="store_true",
                    help="tool-calling mode: let the model query the site with "
                         "tools/site_api.py before it commits geometry (slower, "
                         "far fewer rejected ops)")
    ap.add_argument("--call-budget", type=int, default=DEFAULT_CALL_BUDGET, metavar="N",
                    help=f"how many tools/site_api.py queries --explore may make before it "
                         f"is told to finish with what it has (default {DEFAULT_CALL_BUDGET}, "
                         f"0 = unbounded). It DEGRADES: warnings first, then a finish-now "
                         f"instruction, never a hard stop mid-design")
    ap.add_argument("--timeout-s", type=int, default=None, metavar="S",
                    help=f"seconds one --explore call may take (default {DEFAULT_EXPLORE_TIMEOUT_S}); "
                         "a whole garden from nothing measured over 1,800")
    ap.add_argument("--rounds", type=int, default=DEFAULT_ROUNDS, metavar="N",
                    help=f"design, look, design, look: how many times the model is "
                         f"sent back to stand in what it built and revise it "
                         f"(default {DEFAULT_ROUNDS} = one pass, today's behaviour). "
                         f"It stops early the moment a round changes nothing or the "
                         f"model says it would change nothing. Each round is another "
                         f"whole `claude -p` design run — 20-30 minutes and ~120 site "
                         f"queries — so 3 is an evening, not a coffee break")
    ap.add_argument("--test", type=int, default=0, metavar="N",
                    help="run the canned test prompt N times; report success rate")
    args = ap.parse_args()
    args.design = project.resolve(args.design)       # "data/designs/x.json" is the active project's

    if args.test:
        canned = ("Curve the main path toward the back patio area and add three Buxus "
                  "microphylla shrubs spaced evenly along its east side.")
        with open(DESIGN_PATH) as f:
            baseline = f.read()
        site_t = json.load(open(SITE_PATH)) if os.path.exists(SITE_PATH) else None
        base = frozenset(validate(json.loads(baseline), site_t)[0])
        ok = 0
        for i in range(args.test):
            with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tf:
                tf.write(baseline)
                tmp = tf.name
            try:
                design, mutations, _s, _c, _w = run(canned, args.backend, args.model, tmp, quiet=True)
                errors, _ = validate(design, site_t)
                good = mutations >= 2 and not [e for e in errors if e not in base]
                ok += good
                print(f"run {i+1}/{args.test}: {'PASS' if good else 'FAIL'} ({mutations} mutations)")
            except Exception as e:
                print(f"run {i+1}/{args.test}: ERROR {e}")
            finally:
                os.unlink(tmp)
        print(f"\nresult: {ok}/{args.test} valid  ->  {'PASS (>=80%)' if ok >= 0.8 * args.test else 'FAIL (<80%)'}")
        return

    if not args.prompt:
        ap.error("provide a prompt or --test N")
    try:
        design, mutations, summary, confidence, cautions = run(
            args.prompt, args.backend, args.model, design_path=args.design,
            images=args.image, quiet=args.json,
            selection=[x for x in (args.selection or "").split(",") if x],
            explore=args.explore, area=args.area, call_budget=args.call_budget,
            rounds=args.rounds, timeout_s=args.timeout_s)
    except AgentStopped as e:
        # A sentence, never a traceback: report why the run stopped and where its
        # work in progress is, rather than hiding both behind subprocess internals.
        print(str(e), file=sys.stderr)
        if args.json:
            print(json.dumps({"mutations": 0, "error": str(e)}))
        raise SystemExit(3)
    if mutations:
        save(design, args.design)
    if args.json:
        # last line is the machine-readable result the /api/design endpoint parses
        print(json.dumps({"mutations": mutations, "summary": summary,
                          "confidence": confidence, "cautions": cautions}))
        return
    if mutations:
        # name the file actually written — with --design generating variants in
        # parallel, "design.json updated" is misleading about which one changed
        print(f"\n[saved] {os.path.relpath(args.design, ROOT)} updated "
              f"({mutations} ops applied; history kept)")
    else:
        print("\n[no-op] no valid changes were produced")
    if summary:
        print(f"\n{summary}")
    if confidence:
        print(f"confidence: {confidence}")
    if cautions:
        print(f"verify on the ground: {cautions}")


if __name__ == "__main__":
    main()
