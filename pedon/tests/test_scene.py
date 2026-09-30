"""Does a region compose as a PICTURE, or only as a plant list?

花境 is a mixed herbaceous border; 画境 is closer to a painterly scene. This
measures what BOTH need and grades neither.

`composition` alone cannot answer this. A region can be 33% planted, perfectly
balanced between paving and bed, and still be one flat textural layer that
flowers pale in spring and does nothing after. For example, a corner with 27
plants, 6 species, two forms, 2 of 4 height bands occupied, 18 of 27 flowering
in spring, no autumn at all and mean flower saturation 0.23 lacks the range of
a surrounding design that occupies 4 bands and 6 seasons.
"""
import json
import os
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = os.path.join(ROOT, "tools", "site_api.py")


# These tests read a design fixture rather than data/design.json.
#
# They assert that a corner occupies four height bands, carries autumn, and clears
# a colour-saturation floor. Those are properties of ONE design — the 花境 fixture.
# A different design can legitimately occupy 3 of 4 bands at 0.33 saturation;
# those measurements do not mean the design is broken.
#
# Reading the live file would impose a QUALITY GATE on every design the owner
# adopts, which this project forbids. `scene` MEASURES AND DOES NOT GRADE;
# physical facts and building code are ENFORCED, taste is only ever REPORTED.
# Height bands, autumn interest and colour saturation are taste.
#
# The fixture makes these regression tests for measurements of a known design.
FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "hua_jing_design.json")


def run(*args):
    p = subprocess.run([sys.executable, API, "scene", "--design", FIXTURE, *args],
                       capture_output=True, text=True, cwd=ROOT)
    return p.returncode, json.loads(p.stdout or "{}")


# ── the fixture's corner is a planted 花境 ────────────────────────────
#
# Its drifts provide four height bands, autumn interest and varied flower colour.
# These assertions describe this fixture, not requirements for other designs.

def test_the_down_slope_corner_is_a_planted_border_now():
    code, d = run("--box", "[12.5,-11.5,18.0,-2.5]")
    assert code == 0, d
    assert d["plants"] > 0
    assert d["layers_occupied"] == 4, (
        f"the corner occupies {d['layers_occupied']} of 4 height bands, not 4. The "
        "ground layer (Monardella, sulfur buckwheat) and the 2.1 m fennel provide "
        "the lowest and highest bands")
    assert d["the_year"]["autumn"]["in_flower"] > 0, (
        "the corner has no autumn flowers; California fuchsia and autumn sage "
        "provide autumn interest in this fixture")
    assert d["colour_saturation"]["mean"] > 0.35, (
        f"flower colour is at {d['colour_saturation']['mean']} mean saturation; "
        "the fixture's reds and yellows should keep it above 0.35")


def test_the_corner_is_no_longer_poorer_than_its_own_garden():
    # Fewer height bands and seasons indicate less range than the surrounding
    # garden. This fixture's corner should match its garden's height bands.
    code, whole = run()
    assert code == 0
    _, corner = run("--box", "[12.5,-11.5,18.0,-2.5]")
    assert corner["layers_occupied"] >= whole["layers_occupied"], (
        f"the corner is at {corner['layers_occupied']} bands against the whole "
        f"design's {whole['layers_occupied']} — the fixture's corner should match it")
    assert corner["species"] >= 8, (
        f"{corner['species']} species in the corner; the fixture expects at least 8, "
        "with drifts of several species rather than a repetition of two")


def test_it_reports_and_does_not_grade():
    # Arbitrary restrictions and numerical targets can distort design decisions.
    # Report measurements without a verdict, score or pass/fail in the answer.
    code, d = run()
    assert code == 0
    blob = json.dumps(d).lower()
    for word in ("score", "grade", "pass", "fail", "should", "must", "too few", "target"):
        assert word not in blob.replace("passed", ""), f"'{word}' appears — this tool grades"


def test_the_four_bands_are_body_scale_and_all_present():
    code, d = run()
    assert code == 0
    assert set(d["height_layers"]) == {
        "ground_under_0.3m", "knee_0.3_0.8m", "waist_0.8_1.5m", "head_over_1.5m"}
    assert sum(d["height_layers"].values()) == d["plants"], \
        "a plant fell outside every band — the bands do not cover the range"


@pytest.mark.needs_site
def test_an_unknown_area_is_refused_with_the_list():
    code, d = run("--area", "definitely-not-drawn")
    assert "error" in d
    assert "available" in d


def test_the_design_agent_is_actually_offered_it():
    # A mid-design question belongs in view_mcp, not only a CLI, so the design
    # agent can discover and use the capability.
    sys.path.insert(0, os.path.join(ROOT, "tools"))
    import agent
    import view_mcp
    assert "mcp__yardeye__scene" in agent.MCP_TOOLS, \
        "scene exists but the design agent is never offered it"
    served = {t["name"]: t for t in view_mcp.TOOLS}
    assert "scene" in served, "the MCP server does not serve scene"
    # SITE_TOOLS carries the wiring; TOOLS is the trimmed shape sent over MCP
    wired = {t["name"]: t for t in view_mcp.SITE_TOOLS}
    assert wired["scene"]["fn"] == "cmd_scene"
    assert wired["scene"]["cli"] == "scene"
    import site_api
    assert hasattr(site_api, wired["scene"]["fn"]), \
        "the MCP entry names a function site_api does not have"
    assert len(served["scene"]["description"]) > 300, \
        "the description must say WHEN to reach for it, not just what it is"
