"""The limits the validator enforces are SITE DATA, not constants in tools/.

1.2 m is roughly California's 4-ft trigger for an engineered retaining wall and a
permit. It is not physics, it is not universal, and this tool is supposed to work
on any yard — site.json already knows the address, so the limits belong beside it
in `site.constraints`, with the shipped numbers as the documented fallback.

The test that matters is test_retain_limit_is_site_data: changing
site.constraints.retain_limit_m to 1.0 must change what validate() REJECTS. A
number that has been copied into a defaults dict but is still read from a literal
somewhere passes every other check in this file and fails that one.

The second thing pinned here is that there is ONE copy of each limit. Two
copies of the ground lookup can disagree by up to 0.99 m on a real site; two
copies of "how tall a wall may be" is the same shape of bug, so the tool that
sizes a pad (check-pad) and the validator that judges it must quote the same
number by construction, not by coincidence.
"""
from __future__ import annotations
import argparse
import copy
import json
import math
import os
import sys

import pytest

# conftest.py does this too. Repeated deliberately: a test that only runs when
# another file's setup survives is not a test.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))
import agent                                                    # noqa: E402
import site_api                                                 # noqa: E402


# ── fixtures on real ground ───────────────────────────────────────────────
# The front yard west of the house: outside the measured footprint, 100% covered
# by the 1 m RAYCAST (not merely by the BFS-filled grid, which invents ground
# past the scan edge — check-pad refuses to give a verdict below 80% real
# coverage), and nearly flat
# (3.89-4.08 m) so a level can be set to produce an EXACT cut/fill and these
# tests measure the limit rather than the terrain.
# test_fixture_is_real_ground asserts all of that.
PAD = [[-18, -8], [-15, -8], [-15, -5.6], [-18, -5.6]]
WALL = [[-18, -7], [-15, -7]]
UPHILL_PAD = [[-17.5, -6.6], [-15.5, -6.6], [-15.5, -4.6], [-17.5, -4.6]]   # 0.4 m N of WALL


@pytest.fixture(scope="module")
def site():
    with open(agent.SITE_PATH) as f:
        return json.load(f)


def with_constraints(site, **over):
    """A copy of the real site with an explicit constraints block."""
    s = copy.deepcopy(site)
    s["constraints"] = dict(s.get("constraints") or {}, **over)
    return s


def pad_level(fill_m):
    """The level that makes PAD need exactly `fill_m` of fill and no cut.

    Derived from the measured ground rather than typed, so a re-scan moves the
    number instead of silently making these tests test nothing.
    """
    hs = [g for g in (agent.ground_at(x, y) for x, y in agent._walk_polygon(PAD)) if g is not None]
    return round(min(hs) + fill_m, 3)


def design(**kw):
    d = {"version": 1, "units": "meters", "beds": [], "paths": [], "plants": []}
    d.update(kw)
    return d


def patio_design(fill_m):
    return design(patios=[{"id": "pad_test", "polygon": PAD, "material": "decomposed_granite",
                           "level_m": pad_level(fill_m)}])


def messages(design_obj, site_obj):
    e, w = agent.validate(design_obj, site_obj)
    return e, w


@pytest.mark.needs_site
def test_fixture_is_real_ground(site):
    pts = [tuple(p) for poly in (PAD, WALL, UPHILL_PAD) for p in poly]
    inside = [p for p in pts if agent.point_in_poly(p, site["footprint"])]
    assert not inside, f"fixture points inside the house footprint: {inside}"
    for name, shape in (("PAD", agent._walk_polygon(PAD)),
                        ("UPHILL_PAD", agent._walk_polygon(UPHILL_PAD)),
                        ("WALL", agent._walk_line(WALL))):
        assert site_api.coverage(shape) == 1.0, (
            f"{name} is not entirely on RAYCAST ground; the filled height field would be "
            f"answering for it and check-pad would refuse a verdict")
    hs = [g for g in (agent.ground_at(x, y) for x, y in agent._walk_polygon(PAD)) if g is not None]
    assert max(hs) - min(hs) < 0.4, (
        "PAD is no longer flat, so pad_level() no longer controls cut/fill and every "
        "limit test below is measuring the terrain instead of the limit")


# ── the limit is not a constant in the code ───────────────────────────────
@pytest.mark.needs_site
def test_retain_limit_is_site_data(site):
    """THE test. Same design, same ground; only site.constraints changes."""
    d = patio_design(1.1)
    errors, _ = messages(d, site)
    assert not errors, f"1.1 m of fill should pass the shipped 1.2 m limit, got {errors}"

    errors, _ = messages(d, with_constraints(site, retain_limit_m=1.0))
    assert any("pad_test" in e for e in errors), (
        "site.constraints.retain_limit_m = 1.0 did not reject a pad needing 1.1 m of fill — "
        "the validator is still reading a literal")


@pytest.mark.needs_site
def test_error_quotes_the_limit_it_enforced(site):
    """A message that says 1.2 while enforcing 1.0 sends the model to fix the wrong thing."""
    errors, _ = messages(patio_design(1.1), with_constraints(site, retain_limit_m=1.0))
    msg = "; ".join(errors)
    assert f"{agent.fmt_m(1.0)} m an edge can retain" in msg, msg
    assert "1.2" not in msg, f"message still quotes the old constant: {msg}"


@pytest.mark.needs_site
def test_bed_uses_the_same_limit(site):
    """Beds have their own cut/fill wording but must not have their own number."""
    d = design(beds=[{"id": "bed_test", "polygon": PAD, "mulch": "shredded_hardwood",
                      "level_m": pad_level(1.1)}])
    assert not messages(d, site)[0]
    errors, _ = messages(d, with_constraints(site, retain_limit_m=1.0))
    assert any("bed_test" in e for e in errors), errors


@pytest.mark.needs_site
def test_edge_height_bound_is_site_data(site):
    """The declared-height range is the same limit, not a parallel one."""
    d = design(edges=[{"id": "wall_test", "spline": WALL, "height_m": 1.15,
                       "material": "corten_steel"}])
    assert not messages(d, site)[0]
    errors, _ = messages(d, with_constraints(site, retain_limit_m=1.0))
    assert any("wall_test" in e and "1.15" in e for e in errors), errors


@pytest.mark.needs_site
def test_schema_bound_follows_the_site_upward(site):
    """A yard allowed a 1.5 m wall must not be rejected by a schema that hardcodes 1.2.

    This is the direction that proves the JSON Schema copy of the number moved
    too: relaxing site.constraints can only work if the schema's maximum is
    filled in from the site at validate time.
    """
    d = design(edges=[{"id": "tall_wall", "spline": WALL, "height_m": 1.35,
                       "material": "concrete"}])
    assert messages(d, site)[0], "1.35 m must be rejected under the shipped 1.2 m limit"
    errors, _ = messages(d, with_constraints(site, retain_limit_m=1.5))
    assert not errors, f"site allows 1.5 m walls but something still capped it at 1.2: {errors}"


@pytest.mark.needs_site
def test_footing_threshold_is_one_number(site):
    """One footing threshold for patios and check-pad alike.

    Two thresholds for the same sentence — "this face needs an engineered
    footing" — is the ground-lookup bug in miniature: with a patio warning above
    0.7 m and check-pad saying 'needs a footing' at 0.6 m, the tool that sizes the
    pad and the validator that judges it disagree for every pad in between. One
    number, and both sides read it.
    """
    _, warnings = messages(patio_design(0.65), site)
    assert any("footing" in w for w in warnings), (
        f"0.65 m of fill did not warn under a 0.6 m footing threshold: {warnings}")
    _, warnings = messages(patio_design(0.65), with_constraints(site, footing_threshold_m=0.8))
    assert not any("footing" in w for w in warnings), warnings


def test_defaults_are_the_numbers_this_project_shipped():
    """Pinned so a default cannot drift silently — changing one is a decision."""
    c = agent.constraints(None)
    assert c["retain_limit_m"] == 1.2
    assert c["footing_threshold_m"] == 0.6
    assert c["walk_grade"] == 0.08
    assert c["max_grade"] == 0.20
    assert c == agent.constraints({}) == agent.constraints({"constraints": {}})


@pytest.mark.needs_site
def test_unknown_constraint_key_is_reported(site):
    """A typo in site.json otherwise silently enforces the default forever."""
    _, warnings = messages(design(), with_constraints(site, retain_limit=1.0))
    assert any("retain_limit" in w and "unknown" in w.lower() for w in warnings), warnings


# ── one copy of each limit ────────────────────────────────────────────────
def test_site_api_has_no_second_copy():
    assert site_api.constraints is agent.constraints, (
        "site_api must re-export the one constraints(), not define its own")
    for gone in ("RETAIN_LIMIT_M", "COMFORTABLE_M", "WALK_GRADE", "MAX_GRADE"):
        assert not hasattr(site_api, gone), (
            f"site_api.{gone} is a second copy of a limit that lives in site.constraints")


@pytest.mark.needs_site
def test_check_pad_verdict_follows_the_site(site, monkeypatch):
    """check-pad is what the design agent sizes pads with. It must be judged by
    the same limit it quotes, or the model is told to build what will be rejected."""
    poly = json.dumps(PAD)
    a = argparse.Namespace(polygon=poly, level=pad_level(1.1))

    monkeypatch.setattr(site_api, "_site", lambda: site)
    assert site_api.cmd_check_pad(a)["verdict"] == "needs an engineered footing"

    monkeypatch.setattr(site_api, "_site", lambda: with_constraints(site, retain_limit_m=1.0))
    assert site_api.cmd_check_pad(a)["verdict"].startswith("REJECTED")


@pytest.mark.needs_site
def test_walk_and_max_grade_are_site_data(site, monkeypatch):
    """A route at 14% mean / 20% worst: 'not a ramp' under the shipped limits,
    a ramp under a site that accepts steeper ones."""
    a = argparse.Namespace(spline=json.dumps([[11, -12], [13, -4]]), width=1.2)

    monkeypatch.setattr(site_api, "_site", lambda: site)
    assert site_api.cmd_check_route(a)["walkable_as_a_ramp"] is False

    monkeypatch.setattr(site_api, "_site",
                        lambda: with_constraints(site, walk_grade=0.20, max_grade=0.25))
    assert site_api.cmd_check_route(a)["walkable_as_a_ramp"] is True


@pytest.mark.needs_site
def test_steps_needed_comes_from_the_site_riser(site, monkeypatch):
    """"needs steps" without a riser count leaves the model guessing how much
    length to reserve — and the riser it should use is a code number, per site.

    The fall it counts is the fall over the stretches that ACTUALLY need
    stepping, not the whole route's. This route falls 1.17 m end to end but only
    0.63 m of that is over the limit, and a flight sized for 1.17 m is a flight
    built across ground somebody walks. The whole-route fall answers "step the
    entire route", which misreads a path that is mostly walkable.
    """
    a = argparse.Namespace(spline=json.dumps([[11, -12], [13, -4]]), width=1.2,
                           level=None, steps=None)

    monkeypatch.setattr(site_api, "_site", lambda: with_constraints(site, max_grade=0.15))
    r = site_api.cmd_check_route(a)
    assert "needs steps" in r["verdict"]
    steep_fall = abs(sum(s["fall_m"] for s in r["circulation"]["stretches"]
                         if s["kind"] == "needs_steps"))
    assert 0 < steep_fall < abs(r["total_fall_m"]), (
        f"this route no longer mixes walked and steep ground ({steep_fall} of "
        f"{r['total_fall_m']} m), so it cannot show the difference")
    assert r["steps_needed"]["risers"] == math.ceil(steep_fall / 0.18)
    assert r["steps_needed"]["min_run_m"] == round(r["steps_needed"]["risers"] * 0.28, 2)

    monkeypatch.setattr(site_api, "_site",
                        lambda: with_constraints(site, max_grade=0.15, step_riser_max_m=0.09))
    r2 = site_api.cmd_check_route(a)
    steep2 = abs(sum(s["fall_m"] for s in r2["circulation"]["stretches"]
                     if s["kind"] == "needs_steps"))
    assert r2["steps_needed"]["risers"] == math.ceil(steep2 / 0.09)
    assert r2["steps_needed"]["risers"] > r["steps_needed"]["risers"], (
        "halving the riser did not lengthen the flight — the site constraint is not reaching it")


@pytest.mark.needs_site
def test_terrace_setback_is_enforced(site):
    """An upper bench crowding the wall below it surcharges that wall. How far
    back it has to sit is a soil/code number, so it is site data too.

    Measured over 28 saved designs: 24 pairs of (levelled wall, higher surface)
    exist and NONE fires — every wall in them is buried along its whole run. So
    the warning is not noise on ordinary designs.
    """
    d = design(
        patios=[{"id": "upper_bench", "polygon": UPHILL_PAD, "material": "decomposed_granite",
                 "level_m": 4.9}],                      # 1.01 m of fill: inside the 1.2 m limit
        edges=[{"id": "lower_wall", "spline": WALL, "height_m": 0.6,
                "material": "stone", "level_m": 4.56}])  # stands 0.63 m out of the ground
    _, warnings = messages(d, site)
    assert any("upper_bench" in w and "lower_wall" in w for w in warnings), (
        f"a 0.6 m wall with a bench 0.4 m behind it did not warn: {warnings}")
    _, warnings = messages(d, with_constraints(site, terrace_setback_ratio=0.5))
    assert not any("upper_bench" in w and "lower_wall" in w for w in warnings), warnings


# ── the model is told the limit it will be judged against ─────────────────
@pytest.mark.needs_site
def test_prompt_quotes_the_limit_the_validator_enforces(site):
    """The brief quotes this site's limit, not a fixed "more than 1.2 m of cut or
    fill ... will be rejected".

    On a site whose limit is 1.0 that fixed sentence is a lie in the direction that
    costs the most: the model designs to 1.2, every pad is rejected, and the
    single retry is spent discovering a number the prompt had already stated.
    """
    c = agent.constraints(with_constraints(site, retain_limit_m=1.0))
    brief = agent.with_limits(agent.EXPLORE_BRIEF, c)
    assert f"{agent.fmt_m(1.0)} m of cut or fill" in brief
    assert "1.2" not in brief
    assert "<retain_limit_m>" not in brief, "a placeholder survived into the prompt"


@pytest.mark.needs_site
def test_tool_schema_quotes_the_limit(site):
    """The set_edge description IS a prompt — it is handed to the CLI as
    --json-schema and is the only place the model is told what height an edge may
    be. Hardcoded, it teaches the wrong range on any site but this one."""
    c = agent.constraints(with_constraints(site, retain_limit_m=1.0))
    schema = agent.ops_schema_json(c)
    assert f"0.05-{agent.fmt_m(1.0)} m" in schema
    assert "1.2" not in schema
    assert json.loads(schema), "the substitution must leave valid JSON"


@pytest.mark.needs_site
def test_run_hands_the_model_this_site_s_limits(site, tmp_path, monkeypatch):
    """The pieces above are right; this is whether run() actually uses them.

    Every other test in this file calls the helper directly. A prompt assembled
    from the wrong helper would pass all of them and still ship the old number to
    the model, which is precisely the failure mode this file exists to prevent.
    """
    site_path = tmp_path / "site.json"
    site_path.write_text(json.dumps(with_constraints(site, retain_limit_m=1.0)))
    monkeypatch.setattr(agent, "SITE_PATH", str(site_path))

    seen = {}

    def fake_cli(prompt, model, timeout_s=1800, schema_json=None):
        seen["prompt"], seen["schema"] = prompt, schema_json
        return json.dumps({"ops": [], "summary": "", "confidence": "high", "cautions": ""})

    monkeypatch.setattr(agent, "call_claude_explore", fake_cli)
    agent.run("do nothing", explore=True, quiet=True)

    # assert on the BRIEF's own sentence, not merely on the number: asserting
    # "1 m of cut or fill" alone stays green with the substitution ripped out of
    # run(), because the zone paragraph — built by a different code path —
    # contains the same phrase.
    assert f"{agent.fmt_m(1.0)} m of cut or fill will be rejected" in seen["prompt"]
    assert "<retain_limit_m>" not in seen["prompt"], "a placeholder reached the model"
    assert f"0.05-{agent.fmt_m(1.0)} m" in seen["schema"], (
        "the tool schema the CLI enforces still quotes a limit this site does not use")


@pytest.mark.needs_site
def test_zone_facts_quote_and_rescale_with_the_limit(site):
    """The per-zone "widest level pad" figures are computed by analyze_site.py
    from ITS copy of the limits. Quoting them beside a different limit would
    hand the model two numbers that cannot both be true."""
    if not any(z.get("max_level_pad_width_m") for z in site.get("zones", [])):
        pytest.skip("no zone carries max_level_pad_width_m in this site.json")
    z = next(z for z in site["zones"] if z.get("max_level_pad_width_m"))
    wide = z["max_level_pad_width_m"]

    facts = agent.zone_facts(site, agent.constraints(site))
    assert f"{wide} m ACROSS" in facts

    half = with_constraints(site, retain_limit_m=0.6)     # half the shipped 1.2
    facts = agent.zone_facts(half, agent.constraints(half))
    assert f"{round(wide / 2, 1)} m ACROSS" in facts, (
        "halving the retaining limit must halve the widest level pad it quotes")
    assert f"more than {agent.fmt_m(0.6)} m of cut or fill" in facts
