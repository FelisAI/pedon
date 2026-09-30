"""A WALK is not a FLIGHT, and check-route must say which one a route is.

A path that seems to have gone may have been turned into STAIRS.
`walk_kitchen_to_dining` runs 8.6 m from the kitchen door to the dining terrace;
3.7 m of it is over the 20% a walk can be, and a `set_steps` flight over exactly
that stretch is the correct move on that ground and the one the validator's own
rejection message asks for.

With that flight in place (`steps_kitchen_descent`, riser 0.16, going 0.45,
width 1.2), the judge accepts the route, while grading the bare points does not:

    >>> agent.validate({that spline as a path, that flight as steps}, site)
    ([], ['path route: 16.9% at its steepest — steeper than the 8% that walks as
          a comfortable ramp, under the 20% that needs steps'])
    $ python3 tools/site_api.py check-route '[[10.6,-11.2],...,[14.9,-4.2]]'
    {"walkable_as_a_ramp": false,
     "verdict": "needs steps — 3.7 m of this runs over 20%"}

A check-route that grades a bare list of points has no way to be told that a
flight covers the steep part, so a model that does exactly what the rejection
asked for is told by the next query that it failed.

The second half of the same defect, measured over a corpus of 57 paths, is a
path that declares `level_m`:

    data/designs/backyard_native.json  walk_bottom_terrace  level_m = -2
      validate():    'level -2 m implies up to 0.90 m of cut/fill' (a warning)
      check-route:   'needs steps — 0.5 m of this runs over 20%'

validate() exempts a path that declares `level_m` from grading — that path IS the
bench, flat by construction — while a bare check-route grades the raw slope under
it. Same cause: a command that takes a spline and nothing else cannot be told the
two things the validator knows.

So the answer is not a new number. It is CONTEXT (`--level`, `--steps`) plus one
judge: cmd_check_route hands agent.validate() the route it was asked about and
reports the validator's own verdict, so the two cannot drift. What check-route
adds on top is the route broken into contiguous stretches, walked ones and
stepped ones, so a 30 m walk with one 4 m flight in it reads as a design rather
than as a failure.
"""
from __future__ import annotations
import argparse
import copy
import glob
import json
import math
import os
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import project  # noqa: E402  where the active site's files are
# conftest.py does this too, deliberately repeated: several people add files
# under tests/ at once and a test that only runs when someone else's conftest
# survives is not a test.
sys.path.insert(0, os.path.join(ROOT, "tools"))
import agent                                                    # noqa: E402
import site_api                                                 # noqa: E402
import view_mcp                                                 # noqa: E402


# ── fixtures: the real kitchen descent, on raycast ground ─────────────────
# MIXED is usable_v3/coherent_v1's walk_kitchen_to_dining, verbatim. 8.6 m,
# 100% on the 1 m raycast, 3.7 m of it over 20% at the bottom and 4.9 m of
# walkable traverse above it — the one route in the corpus that is genuinely
# both things at once.
MIXED = [[10.6, -11.2], [12, -10.4], [13, -8.6], [13.4, -6.6], [14.2, -5], [14.9, -4.2]]
# data/design.json's own steps_kitchen_descent: the flight over MIXED's steep
# bottom. Its own arithmetic passes the validator.
FLIGHT = {"id": "steps_kitchen_descent", "spline": [[10.6, -11.2], [13, -8.6]],
          "riser_m": 0.16, "going_m": 0.45, "width_m": 1.2}
# data/design.json's walk_spine: 16.8 m with nothing over the limit — the control
# that stops "call everything a staircase" from passing this file.
WALK_ONLY = [[9.9, 5.7], [11.1, 4.1], [12.55, 2.2], [13.6, 0.7], [14.6, -0.2],
             [14.95, -3.3], [15.75, -6.4], [16.35, -9.3]]
# backyard_native's walk_bottom_terrace, the one corpus disagreement, with the
# level it declares.
BENCH = [[16.2, 0], [16.2, 4], [16.2, 8]]
BENCH_LEVEL = -2.0


@pytest.fixture(scope="module")
def site():
    with open(agent.SITE_PATH) as f:
        return json.load(f)


def with_constraints(site, **over):
    s = copy.deepcopy(site)
    s["constraints"] = dict(s.get("constraints") or {}, **over)
    return s


def route(spline, level=None, steps=None):
    return site_api.cmd_check_route(argparse.Namespace(
        spline=json.dumps(spline),
        level=level,
        steps=None if steps is None else json.dumps(steps)))


def circ(r):
    return r["circulation"]


def kinds(r):
    return [s["kind"] for s in circ(r)["stretches"]]


# ── the fixtures are what the docstring claims ────────────────────────────
@pytest.mark.needs_site
def test_the_fixtures_are_the_routes_this_file_is_about(site):
    """A fixture that drifted off the raycast, or onto ground with no steep
    stretch, would make most of this file vacuous — and a geometric fixture
    that is not asserted rots."""
    for name, spline in (("MIXED", MIXED), ("WALK_ONLY", WALK_ONLY),
                         ("FLIGHT", FLIGHT["spline"])):
        assert site_api.coverage(agent._walk_line(spline)) == 1.0, \
            f"{name} is no longer entirely on RAYCAST ground"
    lim = agent.constraints(site)
    max_pct = lim["max_grade"] * 100

    samples, _ = agent.path_grades(MIXED)
    steep = [g for g in samples if abs(g[0]) > max_pct]
    walkable = [g for g in samples if abs(g[0]) <= max_pct]
    assert steep and walkable, "MIXED is no longer both a walk and a stair"
    assert all(agent._under_steps(g[2], [FLIGHT]) for g in steep), \
        "FLIGHT no longer covers every over-limit stretch of MIXED"

    plain, _ = agent.path_grades(WALK_ONLY)
    assert plain and not [g for g in plain if abs(g[0]) > max_pct], \
        "WALK_ONLY has grown a stretch over the limit"


# ── the disagreement, both halves ─────────────────────────────────────────
@pytest.mark.needs_site
def test_a_walk_with_a_flight_over_its_steep_stretch_is_not_a_failed_route(site):
    """THE test. The validator accepts this exact pair, so the tool the model is
    told to check every path through must not say 'needs steps' about it, or
    doing what the rejection asked for looks like failing."""
    errors, _ = agent.validate(
        {"version": 1, "units": "meters", "beds": [], "plants": [],
         "paths": [{"id": "route", "spline": MIXED, "width_m": 1.2, "material": "gravel"}],
         "steps": [FLIGHT]}, site)
    assert not errors, f"the fixture no longer applies clean: {errors}"

    r = route(MIXED, steps=[FLIGHT])
    assert r["validator"]["applies_clean"] is True, r["validator"]
    assert "needs steps" not in r["verdict"], (
        f"the flight covers every over-limit metre and validate() accepts it, "
        f"and check-route still says {r['verdict']!r}")


@pytest.mark.needs_site
def test_the_same_route_without_a_flight_is_a_REQUEST_for_set_steps(site):
    """The control, and the other half of the point: unstepped steep ground is
    still called out — but as the op that answers it, not as a dead end."""
    r = route(MIXED)
    assert r["validator"]["applies_clean"] is False
    assert "needs steps" in r["verdict"], r["verdict"]
    steep = [s for s in circ(r)["stretches"] if s["kind"] == "needs_steps"]
    assert steep, kinds(r)
    assert "set_steps" in json.dumps(steep), \
        f"a steep stretch must name the op that fixes it: {steep}"
    assert steep[0]["flight_needed"]["risers"] >= 1


@pytest.mark.needs_site
def test_a_level_bench_is_judged_as_a_bench_not_as_a_ramp(site):
    """The one disagreement in the corpus. A path that declares level_m IS the
    bench; validate() grades the walking surface it declares, not the slope
    underneath, and check-route is told the level through --level."""
    bare = route(BENCH)
    assert "needs steps" in bare["verdict"], (
        "BENCH's raw ground is no longer over the limit, so this test proves nothing")

    r = route(BENCH, level=BENCH_LEVEL)
    assert "needs steps" not in r["verdict"], r["verdict"]
    assert r["circulation"]["reads_as"].startswith("a level bench"), r["circulation"]
    errors, warnings = agent.validate(
        {"version": 1, "units": "meters", "beds": [], "plants": [],
         "paths": [{"id": "route", "spline": BENCH, "width_m": 1.2,
                    "material": "gravel", "level_m": BENCH_LEVEL}]}, site)
    assert r["validator"]["errors"] == errors and r["validator"]["warnings"] == warnings


def _grade_verdict(messages, pid):
    """What the validator concluded about THIS path's gradient: rejected, warned
    or silent. The two sides quote the same sentence, so compare the sentence."""
    mine = [m for m in messages if m.startswith(f"path {pid}:") and "at its steepest" in m]
    return sorted(m.split(":", 1)[1].strip() for m in mine)


@pytest.mark.needs_site
def test_check_route_agrees_with_validate_on_every_path_in_the_corpus(site):
    """The anti-drift guard, over data/design.json plus data/designs/*.json.

    The point of running the whole corpus rather than one fixture is that the
    next disagreement will be some case nobody thought of — level_m and a flight
    covering the steep stretch are two such cases.
    """
    files = [project.data("design.json")]
    files += sorted(glob.glob(project.data("designs", "*.json")))
    checked, disagreements = 0, []
    for f in files:
        with open(f) as fh:
            design = json.load(fh)
        errors, warnings = agent.validate(design, site)
        for p in design.get("paths", []):
            r = route(p["spline"], level=p.get("level_m"), steps=design.get("steps"))
            checked += 1
            want = (_grade_verdict(errors, p["id"]), _grade_verdict(warnings, p["id"]))
            got = (_grade_verdict(r["validator"]["errors"], "route"),
                   _grade_verdict(r["validator"]["warnings"], "route"))
            if want != got:
                disagreements.append(f"{os.path.relpath(f, ROOT)}::{p['id']}\n"
                                     f"    validate():   {want}\n"
                                     f"    check-route:  {got}")
    assert checked >= 50, f"only {checked} paths — the corpus is not being read"
    assert not disagreements, (
        f"{len(disagreements)} of {checked} paths get a different circulation verdict "
        f"from the tool than from the judge:\n" + "\n".join(disagreements))


# ── the report is CIRCULATION, not one verdict ────────────────────────────
@pytest.mark.needs_site
def test_the_route_is_split_into_stretches_that_account_for_its_whole_length(site):
    """"needs steps" over a 30 m route says nothing about WHERE, and a route is
    almost never one thing end to end."""
    r = route(MIXED, steps=[FLIGHT])
    st = circ(r)["stretches"]
    assert {"steps", "walk"} <= set(kinds(r)), kinds(r)
    assert abs(sum(s["length_m"] for s in st) - r["length_m"]) < 0.06, \
        f"stretches sum to {sum(s['length_m'] for s in st)} of {r['length_m']} m"
    for a, b in zip(st, st[1:]):
        assert abs(a["to_m"] - b["from_m"]) < 1e-6, "stretches are not contiguous"
    assert abs(sum(s["fall_m"] for s in st) - r["total_fall_m"]) < 0.06
    c = circ(r)
    assert c["stepped_m"] > 3 and c["walk_m"] > 4, c
    assert c["steep_unstepped_m"] == 0, c


@pytest.mark.needs_site
def test_a_stepped_stretch_states_its_fall_and_the_flight_the_SITE_asks_for(site, monkeypatch):
    """Risers come from the constraint table, not from this file. A 0.09 m riser
    site needs twice the flight the 0.18 m one does, and the number that decides
    whether a route still fits is the RUN those risers eat."""
    monkeypatch.setattr(site_api, "_site", lambda: site)
    tall = [s for s in circ(route(MIXED))["stretches"] if s["kind"] == "needs_steps"][0]

    monkeypatch.setattr(site_api, "_site", lambda: with_constraints(site, step_riser_max_m=0.09))
    short = [s for s in circ(route(MIXED))["stretches"] if s["kind"] == "needs_steps"][0]

    assert abs(tall["fall_m"] - short["fall_m"]) < 1e-9, "the ground changed, not the riser"
    assert short["flight_needed"]["risers"] >= 2 * tall["flight_needed"]["risers"] - 1, \
        (tall["flight_needed"], short["flight_needed"])
    assert short["flight_needed"]["min_run_m"] > tall["flight_needed"]["min_run_m"]
    assert tall["flight_needed"]["risers"] == math.ceil(
        abs(tall["fall_m"]) / agent.constraints(site)["step_riser_max_m"])


@pytest.mark.needs_site
def test_a_landing_is_reported_where_the_flight_meets_the_walk(site):
    """Where a flight meets a walk there is a landing, and it is the one piece
    of a stepped route the schema cannot infer from the two elements alone —
    both of them end at the same point and neither owns the level ground there."""
    r = route(MIXED, steps=[FLIGHT])
    lands = circ(r)["landings"]
    assert len(lands) == 1, lands
    at = lands[0]
    assert 3.5 < at["at_m"] < 5.0, at
    assert abs(at["xy"][0] - 13.1) < 0.5 and abs(at["xy"][1] + 8.1) < 0.5, at
    assert "landing" in at["why"].lower()

    assert not circ(route(WALK_ONLY))["landings"], "a plain walk needs no landing"


@pytest.mark.needs_site
def test_a_walk_reads_as_a_walk_and_a_staircase_reads_as_a_staircase(site):
    """Turning a walk into stairs is a legitimate move on a 25%
    fall AND a silent downgrade of circulation; the owner is entitled to be told
    which one happened, and 'walkable: true' cannot say it."""
    plain = circ(route(WALK_ONLY))
    assert plain["flights"] == 0 and plain["stepped_m"] == 0
    assert "walk" in plain["reads_as"] and "flight" not in plain["reads_as"], plain

    stair = circ(route(FLIGHT["spline"], steps=[FLIGHT]))
    assert stair["walk_m"] == 0 and stair["flights"] == 1
    assert "stair" in stair["reads_as"], stair["reads_as"]

    both = circ(route(MIXED, steps=[FLIGHT]))
    assert "walk" in both["reads_as"] and "flight" in both["reads_as"], both["reads_as"]
    assert both["risers_total"] >= 1


@pytest.mark.needs_site
def test_unmeasured_ground_is_a_stretch_of_its_own_not_a_grade(site):
    """The filled field invents a 357% cliff on this site. A stretch nobody
    measured is reported as unmeasured, never graded and never stepped."""
    r = route(BENCH)                      # 2.5 m of BENCH is off the raycast
    gaps = [s for s in circ(r)["stretches"] if s["kind"] == "unmeasured"]
    assert gaps, kinds(r)
    assert abs(sum(s["length_m"] for s in gaps) - r["unmeasured_m"]) < 0.06
    assert all(s.get("steepest_pct") is None for s in gaps)


# ── the model has to be able to reach it ──────────────────────────────────
def test_the_mcp_tool_offers_the_context_and_teaches_set_steps():
    """A capability nobody can reach is not a capability.
    The design agent never types a CLI — it gets check_route over MCP, and a
    `steps` argument it is not offered is one it cannot pass."""
    spec = [t for t in view_mcp.SITE_TOOLS if t["name"] == "check_route"][0]
    props = spec["inputSchema"]["properties"]
    assert "steps" in props and "level" in props, list(props)
    assert "steps" in spec.get("json_args", ()), spec.get("json_args")
    assert "set_steps" in spec["description"], spec["description"]
    assert "mcp__yardeye__check_route" in agent.MCP_TOOLS


@pytest.mark.needs_site
def test_the_cli_takes_the_same_two_arguments():
    """The MCP layer marshals into the CLI's own Namespace, so an argument the
    parser does not have is a tool that raises on its first call."""
    out = subprocess.run(
        [sys.executable, os.path.join(ROOT, "tools", "site_api.py"), "check-route",
         json.dumps(MIXED), "--steps", json.dumps([FLIGHT])],
        capture_output=True, text=True, cwd=ROOT)
    assert out.returncode == 0, out.stderr[-800:]
    r = json.loads(out.stdout)
    assert r["circulation"]["flights"] == 1, r["circulation"]
    assert r["validator"]["applies_clean"] is True


@pytest.mark.needs_site
def test_a_bench_reports_no_grades_at_all_not_just_a_kinder_verdict(site):
    """The half the verdict string hides.

    Without this test, the line that empties the graded samples for a level path
    can be deleted with every test above still passing, because `verdict` is
    overridden for a bench anyway. But the NUMBERS beside the verdict are read
    too, and a bench that reports "3.4 m over 20%" and walkable_as_a_ramp=false is telling
    the model the slope under a flat terrace is a problem it has to solve. An
    unproven line is not a line this project keeps.
    """
    r = route(BENCH, level=BENCH_LEVEL)
    assert r["metres_over_max_grade"] == 0, (
        f"a declared bench reports {r['metres_over_max_grade']} m over the limit — "
        f"that is the ground under it, which nobody walks on")
    assert r["walkable_as_a_ramp"] is not False, r["walkable_as_a_ramp"]
    bare = route(BENCH)
    assert bare["metres_over_max_grade"] > 0, "the raw ground is no longer steep — re-measure"
