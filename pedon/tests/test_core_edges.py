"""An edge is a WALL, and a wall has a cross-section.

An edge with only id/spline/height_m/material/retains/level_m cannot say how
thick the wall is, how far its face leans back, or how deep its footing goes —
those are not merely unchecked, they are unsayable. No validator can be
written for a property the format cannot express, and a design stacking two
1.5 m walls 1.6 m apart would pass every check.

Two things are pinned here.

1. The section is REPRESENTABLE and it has ONE table of defaults.
   viewer/src/design.js has thickness_m and batter_deg per material —
   edgeMesh() builds the solid out of them — so a second table in Python is the
   two-copies bug: copies drift (two separate ground lookups can disagree by
   0.99 m on this site; a hand-rolled height-field indexer can index rows the
   wrong way round). agent.EDGE_SECTION therefore quotes the renderer's
   numbers, and test_section_defaults_match_the_renderer parses
   viewer/src/design.js and fails when either side moves. A wall validated
   0.10 m thick and drawn 0.23 m thick is the failure that test exists to
   prevent.

2. Two walls closer than the setback act as ONE wall.
   Measured over the 28 committed designs: 11 pairs of edges in 4 designs sit
   closer in plan than twice the lower wall's exposed height (backyard_native,
   backyard_v2, backyard_v3, usable), and all four fail validate() for other
   reasons as well — 4, 3, 6 and 2 errors each. The rule reaches 5 of those
   pairs in 3 designs; backyard_v3's terrace walls stand on ground the raycast
   never saw, so the validator rejects them before this rule sees them. Of the
   12 designs that validate clean, not one contains such a pair, so the rule
   rejects no passing work.
   test_the_rule_rejects_no_design_that_passes_today keeps that true.

Fixtures are two lines across the real fall in the back yard, 100% raycast-
scanned, with the levels DERIVED from the measured ground rather than typed —
so a re-scan moves the numbers instead of quietly making these tests test
nothing. test_fixture_is_real_ground asserts all of it.
"""
from __future__ import annotations
import copy
import glob
import json
import math
import os
import re
import sys

import pytest

# conftest.py does this too. Repeated deliberately: several people are adding
# files under tests/ at once, and a test that only runs when someone else's
# conftest survives is not a test.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import project  # noqa: E402  where the active site's files are
sys.path.insert(0, os.path.join(ROOT, "tools"))
import agent                                                    # noqa: E402
import site_api                                                 # noqa: E402

VIEWER_JS = os.path.join(ROOT, "viewer", "src", "design.js")

# Two north-south lines across the fall east of the house. The ground drops to
# the east, so the wall at the LARGER x is the downhill one and the wall uphill
# of it is the one stacked on its bench.
DOWNHILL_X = 12.5
NEAR_X = 11.0        # 1.5 m uphill — inside 2x a 1.0 m wall
MID_X = 10.5         # 2.0 m uphill — outside 2x a 0.95 m wall, until thickness counts
FAR_X = 9.5          # 3.0 m uphill — outside it either way
TIGHT_X = 11.7       # 0.8 m uphill — inside 2x a 0.5 m wall
RUN = (-10.0, -6.0)


@pytest.fixture(scope="module")
def site():
    with open(agent.SITE_PATH) as f:
        return json.load(f)


def wall(x, exposed_m, **extra):
    """A wall on the real ground at x, standing EXACTLY exposed_m at its tallest.

    level_m is min(ground) + exposed_m, because validate() measures exposure as
    max(level - ground) along the run. Deriving it means the fixture states a
    height rather than a coincidence of the terrain.
    """
    line = [[x, RUN[0]], [x, RUN[1]]]
    gs = [g for g in (agent.ground_at(px, py) for px, py in agent._walk_line(line))
          if g is not None]
    return {"id": f"wall_{str(x).replace('.', 'p')}", "spline": line,
            "height_m": round(exposed_m, 2), "material": "corten_steel",
            "retains": "uphill", "level_m": round(min(gs) + exposed_m, 3), **extra}


def design(*edges, **kw):
    d = {"version": 1, "units": "meters", "beds": [], "paths": [], "plants": [],
         "edges": list(edges)}
    d.update(kw)
    return d


def stack_messages(msgs):
    """The messages this rule emits, and only those.

    The bench-surcharge rule already says "setback", so matching that word would
    make a green test out of somebody else's message.
    """
    return [m for m in msgs if "ONE wall" in m]


def with_constraints(site, **over):
    s = copy.deepcopy(site)
    s["constraints"] = dict(s.get("constraints") or {}, **over)
    return s


def viewer_wall_surfaces():
    """thickness_m and batter_deg per material, parsed out of the renderer.

    Parsed, not imported: it is JS. If the parse finds nothing this returns
    nothing and the test that calls it FAILS on the count — a guard that
    silently skips the table it cannot find passes while the bug it targets
    is live.
    """
    with open(VIEWER_JS) as f:
        src = f.read()
    block = re.search(r"export const WALL_SURFACES = \{(.*?)\n\};", src, re.S)
    if not block:
        return {}
    out = {}
    for m in re.finditer(r"(\w+):\s*\{(.*?)\}", block.group(1), re.S):
        t = re.search(r"thickness_m:\s*([\d.]+)", m.group(2))
        b = re.search(r"batter_deg:\s*([\d.]+)", m.group(2))
        if t and b:
            out[m.group(1)] = {"thickness_m": float(t.group(1)),
                               "batter_deg": float(b.group(1))}
    return out


def schema_materials():
    """The materials the schema NAMES as modelled.

    Edge material is free text, not an `enum`: the library must not cap the
    design, and an enum makes gabion, rammed earth and dry-laid brick
    unwritable — so the schema names the modelled ones in its `description`
    instead of fencing the field. The invariant this file pins: every material
    we CLAIM to model must have a real cross-section behind it.
    """
    with open(agent.SCHEMA_PATH) as f:
        field = json.load(f)["properties"]["edges"]["items"]["properties"]["material"]
    assert "enum" not in field, (
        "edge material was fenced back into an enum — the library must not cap "
        "the design; a gabion is a real retaining system")
    named = {m for m in agent.EDGE_SECTION if m in field.get("description", "")}
    assert named, f"the schema no longer names ANY modelled material: {field}"
    return named


# ── the fixture is real ground ────────────────────────────────────────────
@pytest.mark.needs_site
def test_fixture_is_real_ground():
    """Every claim these tests rest on, measured rather than assumed."""
    for x in (DOWNHILL_X, NEAR_X, MID_X, FAR_X, TIGHT_X):
        pts = agent._walk_line([[x, RUN[0]], [x, RUN[1]]])
        seen = [p for p in pts if agent.scan_at(*p) is not None]
        assert len(seen) == len(pts), f"the wall line at x={x} is not fully scanned"
    base = min(agent.ground_at(*p) for p in agent._walk_line([[DOWNHILL_X, RUN[0]], [DOWNHILL_X, RUN[1]]]))
    rises = {}
    for x in (NEAR_X, MID_X, FAR_X, TIGHT_X):
        g = min(agent.ground_at(*p) for p in agent._walk_line([[x, RUN[0]], [x, RUN[1]]]))
        rises[x] = g - base
        assert g > base, f"x={x} is not uphill of x={DOWNHILL_X} any more"
    print(f"  ground rises {rises[NEAR_X]:.2f} m over the 1.5 m from x={DOWNHILL_X} to x={NEAR_X}")
    # the error branch needs the stack to come to more than retain_limit_m: two
    # 1.0 m walls plus this rise. If the rise collapses, the branch stops firing
    # and the test below would pass for the wrong reason.
    assert 1.0 + rises[NEAR_X] > agent.DEFAULT_CONSTRAINTS["retain_limit_m"], (
        f"two 1.0 m walls over a {rises[NEAR_X]:.2f} m rise no longer exceed the retain limit")
    assert 0.5 + rises[TIGHT_X] < agent.DEFAULT_CONSTRAINTS["retain_limit_m"], (
        "the low-stack fixture is no longer under the retain limit, so it can no longer "
        "test the warning branch")
    assert rises[TIGHT_X] > agent.SAME_LEVEL_M, "the tight pair's tops are within tolerance"


# ── 1. the section is representable, once ─────────────────────────────────
@pytest.mark.needs_site
def test_the_schema_can_state_a_cross_section():
    """The whole point: unsayable is unvalidatable. additionalProperties is false,
    so an edge stating its section is REJECTED until the schema knows the words."""
    jsonschema = pytest.importorskip("jsonschema")
    with open(agent.SCHEMA_PATH) as f:
        schema = json.load(f)
    d = design(wall(DOWNHILL_X, 0.8, thickness_m=0.35, batter_deg=8, footing_depth_m=0.2))
    jsonschema.validate(d, schema)


def test_every_material_has_a_section():
    assert set(agent.EDGE_SECTION) == schema_materials(), (
        "a material the schema advertises as modelled has no stated cross-section, "
        "so an edge built from it has no thickness to validate or draw")
    for m, s in agent.EDGE_SECTION.items():
        assert set(s) == {"thickness_m", "batter_deg", "footing_depth_m"}, m
        assert 0.003 <= s["thickness_m"] <= 1.0, m
        assert 0 <= s["batter_deg"] <= 25, m
        assert 0.05 <= s["footing_depth_m"] <= 2.0, m


def test_section_defaults_are_per_material():
    stone = agent.edge_section({"material": "stone", "height_m": 0.5})
    steel = agent.edge_section({"material": "corten_steel", "height_m": 0.5})
    assert stone["thickness_m"] > steel["thickness_m"] * 10, (
        "stacked stone and rolled plate came out the same thickness")
    assert stone == dict(agent.EDGE_SECTION["stone"])
    assert steel == dict(agent.EDGE_SECTION["corten_steel"])


def test_a_stated_section_overrides_the_default():
    got = agent.edge_section({"material": "corten_steel", "height_m": 0.5,
                              "thickness_m": 0.42, "batter_deg": 11, "footing_depth_m": 0.9})
    assert got == {"thickness_m": 0.42, "batter_deg": 11.0, "footing_depth_m": 0.9}


def test_an_unknown_material_still_answers():
    """validate() calls this before the schema check has necessarily run, and a
    KeyError here would take the whole validator down on a typo."""
    got = agent.edge_section({"material": "unobtainium", "height_m": 0.5})
    assert got["thickness_m"] > 0


def test_section_defaults_match_the_renderer():
    """ONE table. viewer/src/design.js edgeMesh() builds the solid from its own
    thickness_m/batter_deg; if Python's copy drifts, a wall is judged at one
    section and drawn at another and nothing says so."""
    js = viewer_wall_surfaces()
    assert set(js) == schema_materials(), (
        f"parsed {sorted(js)} out of {VIEWER_JS} — expected the schema's materials. "
        f"If WALL_SURFACES moved, fix this parse; do not delete the check.")
    bad = []
    for m, s in js.items():
        for k in ("thickness_m", "batter_deg"):
            if abs(agent.EDGE_SECTION[m][k] - s[k]) > 1e-9:
                bad.append(f"{m}.{k}: agent.py says {agent.EDGE_SECTION[m][k]}, "
                           f"design.js draws {s[k]}")
    assert not bad, "; ".join(bad)


@pytest.mark.needs_site
def test_set_edge_can_write_a_cross_section(site):
    """A field the agent cannot emit is a field only a hand-edit can reach."""
    jsonschema = pytest.importorskip("jsonschema")
    d = design()
    inp = {"id": "wall_sec", "spline": [[DOWNHILL_X, RUN[0]], [DOWNHILL_X, RUN[1]]],
           "height_m": 0.5, "edge_material": "stone", "thickness_m": 0.4,
           "batter_deg": 6, "footing_depth_m": 0.25}
    out, msg = agent.execute(d, site, "set_edge", inp, frozenset())
    e = out["edges"][0]
    assert (e["thickness_m"], e["batter_deg"], e["footing_depth_m"]) == (0.4, 6, 0.25)
    with open(agent.SCHEMA_PATH) as f:
        jsonschema.validate(out, json.load(f))
    props = agent.OPS_SCHEMA["properties"]["ops"]["items"]["properties"]["input"]["properties"]
    for k in ("thickness_m", "batter_deg", "footing_depth_m"):
        assert k in props, f"the model is never told it can set {k}"


# ── 2. two walls closer than the setback are one wall ─────────────────────
@pytest.mark.needs_site
def test_stacked_walls_inside_the_setback_are_rejected(site):
    d = design(wall(DOWNHILL_X, 1.0), wall(NEAR_X, 1.0))
    errors, warnings = agent.validate(d, site)
    hits = stack_messages(errors)
    assert hits, (f"two 1.0 m walls 1.5 m apart passed. errors={errors} "
                  f"warnings={warnings}")
    assert "wall_12p5" in hits[0] and "wall_11p0" in hits[0]


@pytest.mark.needs_site
def test_a_wall_set_back_far_enough_is_accepted(site):
    """The rule has to be about the SETBACK, not about there being two walls."""
    d = design(wall(DOWNHILL_X, 1.0), wall(FAR_X, 1.0))
    errors, warnings = agent.validate(d, site)
    assert not stack_messages(errors + warnings), (
        f"the same two walls 3.0 m apart were still called a stack: "
        f"{stack_messages(errors + warnings)}")


@pytest.mark.needs_site
def test_a_low_stack_is_a_warning_not_an_error(site):
    """Stacking is only fatal when the combined face passes what one wall may
    retain. Two 0.5 m walls over a 0.22 m rise are buildable and merely
    surcharged, and rejecting them would ban the terracing this site needs."""
    d = design(wall(DOWNHILL_X, 0.5), wall(TIGHT_X, 0.5))
    errors, warnings = agent.validate(d, site)
    assert not stack_messages(errors), f"a 0.72 m stack was rejected: {stack_messages(errors)}"
    assert stack_messages(warnings), f"nothing warned at all. warnings={warnings}"


@pytest.mark.needs_site
def test_the_setback_ratio_is_site_data(site):
    """Same geometry, different address. How far behind a wall the next one must
    start is a soil-and-code number like every other limit here, so it lives in
    site.constraints — not in a literal in tools/."""
    d = design(wall(DOWNHILL_X, 1.0), wall(NEAR_X, 1.0))
    strict, _ = agent.validate(d, with_constraints(site, wall_stack_setback_ratio=2.0))
    lax_e, lax_w = agent.validate(d, with_constraints(site, wall_stack_setback_ratio=0.5))
    assert stack_messages(strict), "the shipped ratio no longer flags the fixture"
    assert not stack_messages(lax_e + lax_w), (
        "wall_stack_setback_ratio = 0.5 changed nothing — the 2.0 is still a literal")
    assert "wall_stack_setback_ratio" in agent.DEFAULT_CONSTRAINTS
    assert "wall_stack_setback_ratio" in site_api.limits()


@pytest.mark.needs_site
def test_thickness_reaches_the_setback(site):
    """Setback is measured face to face, so a 0.35 m wall eats 0.35 m of it. If
    thickness_m does not reach the arithmetic it is decoration."""
    thin = design(wall(DOWNHILL_X, 0.95), wall(MID_X, 0.95))
    thick = design(wall(DOWNHILL_X, 0.95, thickness_m=0.35),
                   wall(MID_X, 0.95, thickness_m=0.35))
    te, tw = agent.validate(thin, site)
    ke, kw = agent.validate(thick, site)
    assert not stack_messages(te + tw), "the 2.0 m pair was already inside its setback"
    assert stack_messages(ke + kw), "0.35 m of wall on each side did not close the gap"


@pytest.mark.needs_site
def test_batter_reaches_the_setback(site):
    """A battered wall leans its top INTO what it retains, which is where the
    upper wall stands — so batter spends setback too."""
    plumb = design(wall(DOWNHILL_X, 0.95), wall(MID_X, 0.95))
    leaning = design(wall(DOWNHILL_X, 0.95, batter_deg=30), wall(MID_X, 0.95))
    pe, pw = agent.validate(plumb, site)
    le, lw = agent.validate(leaning, site)
    assert not stack_messages(pe + pw)
    assert stack_messages(le + lw), "a 30 deg batter over 0.95 m moved the face 0.55 m and nothing noticed"


# ── 3. footings ───────────────────────────────────────────────────────────
@pytest.mark.needs_site
def test_a_wall_over_the_footing_threshold_says_how_deep_its_footing_must_be(site):
    """The validator says this for a patio, a bed and a path face, so the one
    element that IS a wall must say it too."""
    d = design(wall(DOWNHILL_X, 1.0))
    errors, warnings = agent.validate(d, site)
    foot = [m for m in warnings if "footing" in m and "wall_12p5" in m]
    assert foot, f"a 1.0 m retaining wall was never told it needs a footing. warnings={warnings}"
    assert f"{agent.EDGE_SECTION['corten_steel']['footing_depth_m']:.2f}" in foot[0], foot[0]


@pytest.mark.needs_site
def test_a_stated_footing_shallower_than_the_material_needs_is_rejected(site):
    """Matched on the words of THIS message, not on "footing": a schema that does
    not know the field rejects it with an "additional properties" message that
    contains the word, which would pass this test while nothing checks a footing."""
    d = design(wall(DOWNHILL_X, 1.0, footing_depth_m=0.05))
    errors, _ = agent.validate(d, site)
    assert [m for m in errors if "footing" in m and "shallower" in m], (
        f"a 5 cm footing under a 1.0 m wall passed: {errors}")


@pytest.mark.needs_site
def test_a_low_edge_needs_no_footing(site):
    """Edging under the threshold is driven, not footed. Warning on every garden
    kerb would be noise, and noise is how a real message gets missed."""
    d = design(wall(DOWNHILL_X, 0.3, footing_depth_m=0.05))
    errors, warnings = agent.validate(d, site)
    assert not [m for m in errors + warnings if "footing" in m and "wall_12p5" in m]


@pytest.mark.needs_site
def test_site_api_publishes_the_section_table():
    """A default nobody can look up is a number the model will guess instead.
    `site_api constraints` answers "what am I judged against"; the section
    belongs in the same answer, because check-ops rejects on it."""
    got = site_api.cmd_constraints(None)
    assert got["edge_section"] == agent.EDGE_SECTION
    assert "thickness" in json.dumps(got["note"]) or "section" in json.dumps(got["note"])


# ── 4. the corpus this was measured against ───────────────────────────────
@pytest.mark.needs_site
def test_the_rule_rejects_no_design_that_passes_today(site):
    """The measurement, executable. 5 pairs in 3 designs are rejected and all 3
    also fail for other reasons; the 12 clean designs contain none. A
    future tightening that starts rejecting committed work fails here rather
    than in a session that cannot tell why its design stopped validating."""
    files = sorted(glob.glob(project.data("designs", "*.json")))
    assert len(files) > 20, f"only {len(files)} designs — the corpus moved"
    flagged, clean_and_flagged = [], []
    for f in files:
        with open(f) as fh:
            d = json.load(fh)
        errors, warnings = agent.validate(d, site)
        mine = stack_messages(errors)
        if mine:
            flagged.append(os.path.basename(f))
            if not [e for e in errors if e not in mine]:
                clean_and_flagged.append(os.path.basename(f))
    print(f"  {len(flagged)} of {len(files)} designs have a stacked-wall error: {flagged}")
    assert not clean_and_flagged, (
        f"these designs validated clean until this rule and now do not: {clean_and_flagged}")
    # ... and the other half, or this passes just as well with the rule deleted.
    assert flagged, ("the stacked-wall rule no longer fires anywhere in the corpus. If those "
                     "designs were fixed, say so and drop this line; otherwise the rule is dead")
