"""Keep planting ARRANGEMENT decisions with the model in the design loop.

Why this exists
---------------
Plant placement, drifts, specimens and knitting distance are design decisions.
Code measures and validates; it must not rearrange the model's planting.
Tests must exercise the real design flow: correct but unreachable code does
not establish that the flow works.

The grouping ratio is (mean nearest SAME species)
/ (mean nearest OTHER species), below 1.0 when a plant's own kind is nearer than
a stranger, which is what a drift IS. The pinned fixture has a ratio of **1.62**
(same-species nearest 2.06 m, other-species 1.27 m — a scatter). A ratio of 0.71
instead puts a plant's own kind nearer on average. These are measurements,
not instructions to move plants.

These tests assert the two halves of preserving the model's decisions:

  (a) `rearrange` is absent from OPS_SCHEMA and agent.execute() rejects it;
  (b) agent.run() keeps plants where the model places them — tested by driving
      the real run() loop with a stubbed backend, because a claim about the
      design flow that never enters the design flow is not a test.

Reads committed JSON off disk and stubs the CLI call. No viewer, no network,
no model.
"""
from __future__ import annotations
import copy
import json
import math
import os
import re
import sys
import tempfile

import pytest

# conftest.py does this too. Repeat it so this test module can import the tools
# independently of conftest.py.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))
import agent                                                    # noqa: E402
import replant                                                  # noqa: E402

# A PINNED fixture, not agent.DESIGN_PATH. The starting design must remain a
# SCATTER (grouping ratio 1.62), so input changes cannot invalidate the tests.
# agent.DESIGN_PATH is the owner's working file, which changes with every design
# run and every hand-placed plant. tests/fixtures/scattered_design.json stays fixed.
LIVE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "fixtures", "scattered_design.json")


@pytest.fixture(scope="module")
def site():
    with open(agent.SITE_PATH) as f:
        return json.load(f)


@pytest.fixture
def live():
    with open(LIVE) as f:
        return json.load(f)


def baseline(design, site):
    return frozenset(agent.validate(design, site)[0])


def counts(plants):
    out = {}
    for p in plants:
        out[p["species"]] = out.get(p["species"], 0) + 1
    return out


# ── spacing is the designer's; the validator refuses only one hole ────
@pytest.mark.needs_site
def test_the_scatter_draws_no_spacing_verdict(live, site):
    """This fixture is a SCATTER. How close plants stand is the designer's call;
    the validator reports measurements (site_api.planting_character) and refuses
    physically impossible placements, without prescribing spacing."""
    errors, warnings = agent.validate(live, site)
    assert not [w for w in warnings if "suggested at mature spread" in w or re.match(r"plants \S+/\S+ are ", w)]


@pytest.mark.needs_site
def test_the_validator_reads_the_one_hole_rule(site, monkeypatch):
    """Behavioural, not name-matching: move the rule and the validator moves with it,
    or it is quoting a second copy of the number (compose.py reads the same one)."""
    d = {"version": 1, "units": "meters", "plants": [
        {"id": "a", "species": "Salvia clevelandii", "position": [0, 0], "mature_height_m": 1.2, "mature_spread_m": 1.5},
        {"id": "b", "species": "Thymus vulgaris", "position": [0.04, 0], "mature_height_m": 0.3, "mature_spread_m": 0.6}]}
    assert [e for e in agent.validate(d, site)[0] if "one planting hole" in e]
    monkeypatch.setattr(agent, "one_hole", lambda a, b: (0.0, None))
    assert not [e for e in agent.validate(d, site)[0] if "planting hole" in e]


def test_the_arrangement_layer_is_retired():
    """Where a plant stands is the LLM's decision; code must not rearrange it."""
    import registry
    assert "rearrange" not in agent.OPS_SCHEMA["properties"]["ops"]["items"]["properties"]["tool"]["enum"]
    assert not hasattr(replant, "replant"), "the placer is back"
    try:
        agent.execute({"version": 1, "units": "meters", "beds": [], "plants": []}, {}, "rearrange", {})
    except Exception:
        pass
    else:
        raise AssertionError("an op the vocabulary no longer has was applied")


# ── (b) the design flow keeps what the MODEL decided ─────────
def stub_backend(monkeypatch, ops):
    """Drive the real run() loop with a canned model reply.

    run() resolves call_claude as a module global, so replacing it here exercises
    every line of the loop that matters — execute(), the rejection path, the
    orphan-wall cleanup and whatever run() does about arrangement — without a
    subprocess, a subscription or a minute of wall clock.
    """
    reply = json.dumps({"ops": ops, "summary": "s", "confidence": "high", "cautions": "c"})
    seen = []

    def fake(prompt, model, timeout_s=600, schema_json=None):
        seen.append(prompt)
        return reply

    monkeypatch.setattr(agent, "call_claude", fake)
    return seen


PLANTING_OP = {"tool": "place_plants", "input": {"plants": [
    # deliberately scattered inside bed_north_slope: three of one species spread
    # to the far corners of the bed; the loop must preserve those positions
    {"species": "Muhlenbergia rigens", "common": "deergrass", "position": [12.4, 7.0],
     "mature_spread_m": 1.2, "mature_height_m": 1.2},
    {"species": "Muhlenbergia rigens", "common": "deergrass", "position": [16.4, 7.2],
     "mature_spread_m": 1.2, "mature_height_m": 1.2},
    {"species": "Muhlenbergia rigens", "common": "deergrass", "position": [14.0, 11.4],
     "mature_spread_m": 1.2, "mature_height_m": 1.2}]}}


@pytest.fixture
def live_copy():
    """run() reads a design file off disk, so give it its own copy: this suite
    must never write data/design.json."""
    with open(LIVE) as f:
        src = f.read()
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as tf:
        tf.write(src)
        path = tf.name
    try:
        yield path
    finally:
        os.unlink(path)


def test_the_design_flow_keeps_where_the_model_put_each_plant(monkeypatch, live_copy):
    """Code measures; the model decides.

    A plant stands where the model puts it. run() must not replace those
    coordinates with positions chosen by hardcoded planting rules.
    """
    stub_backend(monkeypatch, [PLANTING_OP])
    with open(live_copy) as f:
        start = json.load(f)["plants"]
    design, mutations, *_ = agent.run("plant the north bed", design_path=live_copy, quiet=True)
    assert mutations == 1
    placed = [p["position"] for p in design["plants"] if p["species"] == "Muhlenbergia rigens"
              and p["id"] not in {q["id"] for q in start}]
    asked = [p["position"] for p in PLANTING_OP["input"]["plants"]]
    assert sorted(placed) == sorted(asked), f"the loop moved the model's plants: {placed} != {asked}"
    kept = {p["id"]: p["position"] for p in design["plants"]}
    assert all(kept.get(p["id"]) == p["position"] for p in start), "the loop moved plants it was not asked to"


def test_the_brief_leaves_positions_to_the_model():
    """The brief makes the model responsible for plant positions."""
    brief = agent.EXPLORE_BRIEF + agent.SYSTEM
    assert "agonise" not in brief and "applied for you" not in brief
    assert "Nothing re-places them after you" in brief


@pytest.mark.needs_site
def test_a_wall_holding_nothing_is_reported_not_deleted(monkeypatch, live_copy):
    """Deleting a wall that holds nothing is a design decision: the validator
    reports it, and the model (or the owner) decides whether to keep the wall."""
    stub_backend(monkeypatch, [{"tool": "set_edge", "input": {
        # ground under it runs -2.84..-2.49; the fixture's surfaces are at -2.1 and -1.75,
        # so neither its top (-2.3) nor its foot (-2.6) holds anything
        "id": "lonely_wall", "spline": [[13.0, 8.0], [14.5, 8.4]], "height_m": 0.3,
        "level_m": -2.3, "edge_material": "dry_stone", "retains": "uphill"}}])
    design, mutations, *_ = agent.run("add a wall", design_path=live_copy, quiet=True)
    assert mutations == 1, "the wall op itself was rejected — the fixture no longer tests this"
    assert any(e["id"] == "lonely_wall" for e in design["edges"]), "the loop deleted the model's wall"
    _, warnings = agent.validate(design, json.load(open(agent.SITE_PATH)))
    assert any("lonely_wall" in w and "holds nothing" in w for w in warnings)


def test_the_flow_leaves_a_design_alone_when_no_plants_were_placed(monkeypatch, live_copy):
    """A request to move a wall must not silently reshuffle 58 plants. The
    arrangement follows planting, not every edit."""
    stub_backend(monkeypatch, [{"tool": "set_path", "input": {
        "id": "walk_arr_test", "spline": [[11.5, -2], [12.5, 2], [13, 6]],
        "width_m": 1.2, "material": "flagstone"}}])
    with open(live_copy) as f:
        before = json.load(f)["plants"]
    design, mutations, *_ = agent.run("add a walk", design_path=live_copy, quiet=True)
    assert mutations == 1
    assert design["plants"] == before, "a path edit moved the planting"


def test_both_backends_are_sent_to_the_one_design_method():
    """Design guidance lives in DESIGNING.md; both backends must read it — at a path that is
    there from the folder the run starts in (agent.ROOT), not from the repository root."""
    brief = agent.explore_brief(50)
    assert brief.startswith("BEFORE YOU DESIGN") and "DESIGNING.md" in brief
    docs = re.findall(r"[\w./-]*/[\w.-]+\.md\b", brief)
    assert any(d.endswith("/DESIGNING.md") for d in docs), docs
    for doc in docs:
        assert os.path.isfile(os.path.join(agent.ROOT, doc)), f"the brief sends the agent to {doc}, which is not there"


def test_a_run_that_runs_out_of_time_says_where_its_work_is(monkeypatch, live_copy, capsys):
    """A timeout must report the scratch file that holds the design.

    A whole-garden run can exceed 1,800 s; a traceback alone does not tell the
    user where to find the saved work.
    """
    import subprocess as sp

    def slow(prompt, model, timeout_s=600, schema_json=None):
        with open(agent.scratch_for(live_copy), "w") as f:
            f.write("{}")
        raise sp.TimeoutExpired(cmd="claude", timeout=timeout_s)

    monkeypatch.setattr(agent, "call_claude", slow)
    try:
        agent.run("design it", design_path=live_copy, quiet=True, timeout_s=77)
    except agent.AgentTimedOut as e:
        msg = str(e)
        assert "ran out of time" in msg and os.path.basename(agent.scratch_for(live_copy)) in msg, msg
    else:
        raise AssertionError("a timeout was not reported as one")
    finally:
        if os.path.exists(agent.scratch_for(live_copy)):
            os.unlink(agent.scratch_for(live_copy))
    assert agent.DEFAULT_EXPLORE_TIMEOUT_S >= 3600, "a whole garden measured over 1,800 s"


def test_a_backend_that_fails_says_what_it_said_and_where_the_work_is(monkeypatch, live_copy):
    """A failed CLI can report its reason on stdout with stderr empty.
    The runner must report that reason and the scratch file holding the work."""
    import subprocess as sp

    class Res:
        returncode, stderr = 1, ""
        stdout = "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)"

    monkeypatch.setattr(agent.subprocess, "run", lambda *a, **k: Res())
    try:
        agent.call_claude("p", "m")
    except agent.BackendFailed as e:
        assert "ENOTFOUND" in str(e), str(e)
    else:
        raise AssertionError("a failed CLI was not reported")

    def dead(prompt, model, timeout_s=600, schema_json=None):
        with open(agent.scratch_for(live_copy), "w") as f:
            f.write("{}")
        raise agent._cli_failure("claude", Res())

    monkeypatch.setattr(agent, "call_claude", dead)
    try:
        agent.run("design it", design_path=live_copy, quiet=True)
    except agent.AgentStopped as e:
        assert "ENOTFOUND" in str(e) and os.path.basename(agent.scratch_for(live_copy)) in str(e), str(e)
    else:
        raise AssertionError("a dead backend was not a clean stop")
    finally:
        if os.path.exists(agent.scratch_for(live_copy)):
            os.unlink(agent.scratch_for(live_copy))
