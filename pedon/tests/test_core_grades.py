"""A route the site tools call unwalkable must not pass the validator.

The contradiction this file pins, reproduced on the reference site without a
gradient rule:

    $ python3 tools/site_api.py check-route '[[10,-2],[16,-6]]' --width 1.2
    {"steepest_pct": -22.9, "walkable_as_a_ramp": false,
     "verdict": "needs steps — 0.5 m of this runs over 20%", ...}
    >>> agent.validate({... that same spline as a path ...}, site)
    ([], [])

check-route measures the ground, says a person cannot walk it, and tells the model
how many risers it would take. validate() — the thing that actually decides
whether an op survives — needs a gradient term too, or the identical spline
applies clean. Two rulers: the same shape of bug as two height lookups.

Two things ship together, and the ORDER matters. A grade REJECTION with no
steps element is a validator that rejects routes the model has no vocabulary to
fix, so `steps` (riser/going, its own op) exists here too, and the test that
matters most is test_steps_over_the_steep_stretch_unblock_the_path: the escape
hatch has to actually open.

Measured over data/design.json plus the 28 designs in data/designs/: 44 paths, of
which 15 have a 0.5 m stretch over the 20% limit — 14 once the 8 level_m benches
are exempted as validate() exempts them. (Re-derive with agent.path_grades over
the corpus rather than trusting this line — a number in a comment that no test
checks is a number that rots.) That is a real change in what the corpus is told,
and it agrees with an independent judge — the walkthrough critique flags "a 9%
average grade with no steps" on the same site by eye.

Grades are measured on RAYCAST ground only. The steepest "grade" in the whole
corpus is 357% on masterplan/path_west_north_link, and every point of it is in
the BFS-filled fallback, which holds 3.20 m flat for five metres and then steps to
5.00 m at the last vertex. Rejecting a design for a slope nobody measured is the
filled-field bug wearing a new hat; test_unscanned_ground_is_not_graded pins it.
"""
from __future__ import annotations
import argparse
import copy
import json
import math
import os
import sys

import pytest

# conftest.py does this too. Repeated deliberately: several people are adding
# files under tests/ at once, and a test that only runs when someone else's
# conftest survives is not a test.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))
import agent                                                    # noqa: E402
import site_api                                                 # noqa: E402

# about a REAL site — skipped without the reference site (tests/conftest.py)
pytestmark = pytest.mark.needs_site


# ── fixtures on real ground ───────────────────────────────────────────────
# Every one is 100% covered by the 1 m RAYCAST and clear of the house footprint;
# test_fixtures_are_real_ground asserts both, because a fixture that drifted onto
# invented ground would make most of this file vacuous.
#
# STEEP   the spline in the docstring above: -22.9% at its worst, one 0.5 m stretch
#         over the 20% limit, so ONE short flight of steps fixes it.
# DIP     both ends at -1.95 m — 0.0% end to end — with a 0.15 m lip in the middle
#         that only a dense sampler sees.
# GENTLE  -6.0%, under the 8% ramp limit: the control.
# WARN    10.0%, between the two limits.
# FILLED  nine points, NONE of them scanned: pure BFS fill, where ground_at
#         reports a 357% cliff that does not exist.
STEEP = [[10, -2], [16, -6]]
DIP = [[8.0, -1.0], [8.0, 3.0]]     # level ends (-0.12 / -0.11 m), 0.63 m of sag between
# NOT on half-cell coordinates. A fixture on EXACT half-cell queries (y -14.5 ->
# -10.5) looks level only under python's half-to-even round(). With scan_at's
# half-up tie rule (JS's, so the validator and the viewer agree at coverage edges)
# those two ends sit 0.08 m apart and a vertex-only check would catch them —
# which is the one thing this fixture must never be.
GENTLE = [[-18, -8], [-15, -8]]
WARN = [[10, -2], [10, 2]]
FILLED = [[-15, 5], [-13, 8.5]]

# Covers STEEP's single over-limit stretch (its midpoint is 12.79, -3.86 — 0.007 m
# off this line). 0.97 m of run for 0.188 m of fall.
STEPS_RUN = [[12.4, -3.6], [13.2, -4.15]]


@pytest.fixture(scope="module")
def site():
    with open(agent.SITE_PATH) as f:
        return json.load(f)


def with_constraints(site, **over):
    s = copy.deepcopy(site)
    s["constraints"] = dict(s.get("constraints") or {}, **over)
    return s


def design(**kw):
    d = {"version": 1, "units": "meters", "beds": [], "paths": [], "plants": []}
    d.update(kw)
    return d


def walk(spline, **kw):
    p = {"id": "walk_test", "spline": spline, "width_m": 1.2, "material": "gravel"}
    p.update(kw)
    return design(paths=[p])


def flight(spline=None, **kw):
    s = {"id": "steps_test", "spline": spline or STEPS_RUN, "width_m": 1.0,
         "riser_m": 0.15, "going_m": 0.3}
    s.update(kw)
    return s


def route(spline):
    return site_api.cmd_check_route(argparse.Namespace(spline=json.dumps(spline), width=1.2))


def test_fixtures_are_real_ground(site):
    for name, spline in (("STEEP", STEEP), ("DIP", DIP), ("GENTLE", GENTLE),
                         ("WARN", WARN), ("STEPS_RUN", STEPS_RUN)):
        pts = agent._walk_line(spline)
        assert site_api.coverage(pts) == 1.0, (
            f"{name} is not entirely on RAYCAST ground — the filled field would be answering "
            f"for it and this file would be testing interpolation")
        inside = [p for p in pts if agent.point_in_poly(p, site["footprint"])]
        assert not inside, f"{name} crosses the house footprint at {inside}"
    assert site_api.coverage(agent._walk_line(FILLED)) == 0.0, (
        "FILLED is meant to be entirely OFF the raycast; if the scan grew to cover it, "
        "test_unscanned_ground_is_not_graded proves nothing")
    assert abs(agent.scan_at(*DIP[0]) - agent.scan_at(*DIP[1])) < 0.01, (
        "DIP's endpoints are no longer level, so a vertex-only check would catch it too")


# ── the contradiction ─────────────────────────────────────────────────────
def test_check_route_and_validate_agree_on_a_steep_walk(site):
    """THE test. Same spline, same ground; when the tool says unwalkable the
    validator must not say nothing."""
    r = route(STEEP)
    assert r["walkable_as_a_ramp"] is False and "needs steps" in r["verdict"], (
        f"the fixture is no longer the steep route this file is about: {r}")

    errors, _ = agent.validate(walk(STEEP), site)
    assert any("walk_test" in e for e in errors), (
        f"check-route says {r['verdict']!r} and validate() accepted the identical spline: "
        f"{errors}")


def test_the_rejection_quotes_the_number_check_route_quoted(site):
    """One ruler. If the validator computes its own steepness the model is told
    two different figures for the same ground, the way two height lookups
    drift 0.99 m apart."""
    r = route(STEEP)
    errors, _ = agent.validate(walk(STEEP), site)
    steep = [e for e in errors if "walk_test" in e]
    assert steep, errors
    assert f"{abs(r['steepest_pct']):.1f}%" in steep[0], (
        f"validate() reported {steep[0]!r}, check-route reported {r['steepest_pct']}%")


def test_a_gentle_walk_is_neither_warned_nor_rejected(site):
    """The control: without it "reject everything" passes every test above."""
    errors, warnings = agent.validate(walk(GENTLE), site)
    assert not errors, errors
    assert not [w for w in warnings if "walk_test" in w], warnings


def test_grade_between_the_two_limits_is_a_warning_not_an_error(site):
    """8-20% is walkable and unpleasant. Rejecting it would take away the
    traversing path, which is the one thing that works on this slope."""
    r = route(WARN)
    assert 8 < abs(r["steepest_pct"]) < 20, f"WARN is no longer in the middle band: {r}"
    errors, warnings = agent.validate(walk(WARN), site)
    assert not errors, errors
    assert any("walk_test" in w for w in warnings), warnings


def test_grade_is_sampled_along_the_run_not_at_the_vertices(site):
    """DIP's two vertices are the same height. Every vertex-only check passes it,
    and a vertex-only check lets a wall declared 0.7 m render 2.59 m."""
    ends = [agent.scan_at(*p) for p in DIP]
    assert abs(100 * (ends[1] - ends[0]) / 4.0) < 1.0, "DIP is not flat vertex-to-vertex"
    errors, _ = agent.validate(walk(DIP), site)
    assert any("walk_test" in e for e in errors), (
        f"a 30% lip between the vertices was missed: {errors}")


def test_grade_limits_are_site_data(site):
    """Same design, same ground; only site.constraints moves."""
    errors, _ = agent.validate(walk(STEEP), site)
    assert any("walk_test" in e for e in errors), errors

    errors, warnings = agent.validate(walk(STEEP), with_constraints(site, max_grade=0.25))
    assert not errors, f"a 22.9% walk should pass a site that allows 25%: {errors}"
    assert any("walk_test" in w for w in warnings), warnings

    errors, warnings = agent.validate(
        walk(STEEP), with_constraints(site, walk_grade=0.25, max_grade=0.30))
    assert not errors and not [w for w in warnings if "walk_test" in w], (errors, warnings)


def test_unscanned_ground_is_not_graded(site):
    """ground_at reports 357% here and every metre of it is invented."""
    pts = agent._walk_line(FILLED)
    worst = max((100 * (agent.filled_at(*b) - agent.filled_at(*a))
                 / math.hypot(b[0] - a[0], b[1] - a[1])
                 for a, b in zip(pts, pts[1:])), key=abs)
    assert abs(worst) > 100, f"the filled grid no longer invents a cliff here ({worst:.0f}%)"
    errors, warnings = agent.validate(walk(FILLED), site)
    assert not errors, f"rejected for a slope nobody measured: {errors}"


def test_a_level_path_is_not_graded_against_the_slope_it_cuts(site):
    """A path with level_m is a cut bench: its surface is flat by construction and
    the cut/fill branch above already judges it. Grading the ground under it would
    reject every terrace walk on the site."""
    lvl = round((agent.scan_at(*STEEP[0]) + agent.scan_at(*STEEP[1])) / 2, 3)
    errors, warnings = agent.validate(walk(STEEP, level_m=lvl), site)
    assert not errors, errors
    assert not [w for w in warnings if "walk_test" in w], warnings


# ── the vocabulary that makes the rejection fixable ───────────────────────
def test_steps_over_the_steep_stretch_unblock_the_path(site):
    """Why `steps` ships with the grade rejection. Through execute(), not
    validate() directly: an op nothing executes can fail 100% of the time on a
    shadowed variable while every validate() test passes."""
    d = design()
    with pytest.raises(ValueError, match="rejected"):
        agent.execute(d, site, "set_path",
                      {"id": "walk_test", "spline": STEEP, "width_m": 1.2, "material": "gravel"})

    d, _ = agent.execute(d, site, "set_steps",
                         {"id": "steps_test", "spline": STEPS_RUN, "width_m": 1.0,
                          "riser_m": 0.15, "going_m": 0.3})
    assert d["steps"][0]["id"] == "steps_test"

    d, msg = agent.execute(d, site, "set_path",
                           {"id": "walk_test", "spline": STEEP, "width_m": 1.2,
                            "material": "gravel"})
    assert any(p["id"] == "walk_test" for p in d["paths"]), msg
    errors, _ = agent.validate(d, site)
    assert not errors, f"steps over the only over-limit stretch did not clear it: {errors}"


def test_set_steps_defaults_riser_and_going_from_the_site(site):
    """check-route hands the model a riser and a minimum run; a model that just
    says "steps here" must still get a flight the validator accepts, and the
    steepest legal riser is the one that fits in the least run."""
    c = agent.constraints(site)
    d, _ = agent.execute(design(), site, "set_steps",
                         {"id": "steps_test", "spline": STEPS_RUN})
    st = d["steps"][0]
    assert st["riser_m"] == c["step_riser_max_m"]
    assert st["going_m"] == c["step_going_min_m"]
    assert not agent.validate(d, site)[0]


def test_step_riser_and_going_are_site_data(site):
    """Riser and going are code numbers about an address, like every other limit
    here — not constants in tools/."""
    d = design(steps=[flight(riser_m=0.17, going_m=0.3)])
    assert not agent.validate(d, site)[0]

    errors, _ = agent.validate(d, with_constraints(site, step_riser_max_m=0.15))
    assert any("steps_test" in e and "0.17" in e for e in errors), errors

    errors, _ = agent.validate(d, with_constraints(site, step_going_min_m=0.35))
    assert any("steps_test" in e and "0.3" in e for e in errors), errors


def test_steps_too_short_for_their_fall_are_rejected(site):
    """0.188 m of fall in 0.97 m of run. At 0.06 m a riser that is four steps,
    which need 1.12 m of going — more run than the flight has."""
    fall = abs(agent.scan_at(*STEPS_RUN[1]) - agent.scan_at(*STEPS_RUN[0]))
    plan = math.hypot(STEPS_RUN[1][0] - STEPS_RUN[0][0], STEPS_RUN[1][1] - STEPS_RUN[0][1])
    assert math.ceil(fall / 0.06) * 0.28 > plan > math.ceil(fall / 0.10) * 0.28, (
        "the ground under STEPS_RUN moved; this test no longer straddles the fit")

    errors, _ = agent.validate(design(steps=[flight(riser_m=0.06, going_m=0.28)]), site)
    assert any("steps_test" in e for e in errors), errors

    assert not agent.validate(design(steps=[flight(riser_m=0.10, going_m=0.28)]), site)[0]


def test_steps_inside_the_house_footprint_are_rejected(site):
    """Steps get the same geometric checks as everything else; a new element that
    skips them is a new way to build inside the house."""
    fp = site["footprint"]
    cx = sum(p[0] for p in fp) / len(fp)
    cy = sum(p[1] for p in fp) / len(fp)
    errors, _ = agent.validate(design(steps=[flight(spline=[[cx, cy], [cx + 1, cy + 1]])]), site)
    assert any("steps_test" in e and "footprint" in e for e in errors), errors


def test_remove_objects_removes_steps(site):
    d = design(steps=[flight()])
    d, msg = agent.execute(d, site, "remove_objects", {"ids": ["steps_test"]})
    assert d["steps"] == [] and "steps_test" in msg


# ── the model can find and use it ─────────────────────────────────────────
def test_steps_are_in_the_schema(site):
    """jsonschema is what rejects an unknown key: the top level is
    additionalProperties:false, so a steps element the schema has never heard of
    fails validation no matter what the code does."""
    jsonschema = pytest.importorskip("jsonschema")
    with open(agent.SCHEMA_PATH) as f:
        schema = json.load(f)
    jsonschema.validate(design(steps=[flight()]), schema)
    assert "steps" in schema["properties"]
    props = schema["properties"]["steps"]["items"]["properties"]
    assert "riser_m" in props and "going_m" in props


def test_the_model_is_told_about_grades_and_steps(site):
    """A limit the validator enforces and the prompt never mentions costs the
    model its one retry rediscovering it — and a rejection it has no op to fix is
    worse than no rejection."""
    c = agent.constraints(with_constraints(site, walk_grade=0.05, max_grade=0.30))
    schema = agent.ops_schema_json(c)
    assert "set_steps" in json.loads(schema)["properties"]["ops"]["items"]["properties"]["tool"]["enum"]
    assert "riser_m" in schema and "going_m" in schema

    brief = agent.with_limits(agent.EXPLORE_BRIEF, c)
    assert "set_steps" in brief
    assert f"{agent.fmt_m(30.0)}%" in brief, "the brief does not quote THIS site's max grade"
    assert "<max_grade_pct>" not in brief and "<walk_grade_pct>" not in brief

    assert "set_steps" in agent.SYSTEM


def test_check_ops_reports_the_grade_rejection(site, tmp_path):
    """The surface the model actually dry-runs against."""
    dpath = tmp_path / "design.json"
    dpath.write_text(json.dumps(design()))
    a = argparse.Namespace(
        ops=json.dumps([{"tool": "set_path",
                         "input": {"id": "walk_test", "spline": STEEP,
                                   "width_m": 1.2, "material": "gravel"}}]),
        ops_file=None, design=str(dpath))
    r = site_api.cmd_check_ops(a)
    assert r["would_reject"] == 1 and r["ok"] is False, r
    assert "walk_test" in json.dumps(r["rejected"])
