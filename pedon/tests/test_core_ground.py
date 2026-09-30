"""One height field.

EXPLORE_BRIEF orders the model to run every pad through `site_api check-pad` and
every route through `check-route`. Those read data/terrain_scan.json — a 1 m
raycast of the actual mesh, bilinearly interpolated. data/terrain.json is a 2 m
BFS-FILLED grid that invents ground past the scan edge and smooths real relief
away. A validate() that read it would judge with a different ruler from the
tools, by construction.

Measured over the 28 designs in data/designs/ plus the live data/design.json:
the two sources give the same pass/fail verdicts, but 22 of 28 designs get at
least one different message — e.g. the firepit terrace in the live design reads
0.95 m of fill off the filled grid and 0.88 m off the mesh, and backyard_native
carries an error only the mesh shows (edge_middle_terrace stands 1.35 m, not the
1.10 m the filled grid claims). The disagreement is real.

These tests pin the contract: ground_at IS the raycast wherever the scanner saw
ground, the filled grid survives only as a named fallback beyond it, and there is
exactly one implementation of each.
"""
import pytest
import argparse
import json
import os

import agent
import site_api

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import project  # noqa: E402  where the active site's files are

# Real ground on this site: a 4x4 m square east of the house, fully covered by the
# raycast and clear of the footprint. Chosen because the two height sources
# disagree here by ~0.2 m, which is the difference between "engineered footing"
# and not.
SCANNED_PAD = [[9, 2], [13, 2], [13, 6], [9, 6]]
PAD_LEVEL = -1.2


def _site():
    with open(project.data("site.json")) as f:
        return json.load(f)


def _cell_centres():
    """Every 1 m cell centre of the raycast grid."""
    t = site_api._scan_grid()
    assert t, "data/terrain_scan.json missing — every test in this file would be vacuous"
    x = t["x0"] + 0.5
    while x < t["x1"]:
        y = t["y0"] + 0.5
        while y < t["y1"]:
            yield x, y
            y += 1.0
        x += 1.0


@pytest.mark.needs_site
def test_ground_at_is_the_raycast_wherever_the_scan_saw_ground():
    """The validator must read the same metres site_api reports, not a smoothed copy."""
    checked, worst = 0, (0.0, None)
    for x, y in _cell_centres():
        s = site_api.scan_at(x, y)
        if s is None:
            continue
        checked += 1
        g = agent.ground_at(x, y)
        assert g is not None
        if abs(g - s) > worst[0]:
            worst = (abs(g - s), (x, y, g, s))
    assert checked > 100, f"only {checked} scanned cells — fixture is not exercising the mesh"
    assert worst[0] < 1e-9, (
        f"agent.ground_at disagrees with site_api.scan_at by up to {worst[0]:.2f} m "
        f"at {worst[1]} over {checked} scanned cells")


@pytest.mark.needs_site
def test_the_filled_grid_survives_only_as_a_named_fallback():
    """Past the scan edge there is nothing else, so terrain.json still answers —
    but explicitly, through filled_at(), not by being the primary source."""
    probes = [(x, y) for x, y in _cell_centres()
              if site_api.scan_at(x, y) is None and agent.filled_at(x, y) is not None]
    assert len(probes) > 50, (
        f"only {len(probes)} cells are off-scan-but-filled; this test would prove nothing")
    for x, y in probes:
        assert agent.ground_at(x, y) == agent.filled_at(x, y)


@pytest.mark.needs_site
def test_ground_at_is_none_only_where_neither_source_has_ground():
    for x, y in _cell_centres():
        if agent.ground_at(x, y) is None:
            assert site_api.scan_at(x, y) is None and agent.filled_at(x, y) is None


def test_one_implementation_of_each_lookup():
    """A hand-rolled copy of the height-field indexing is easy to get wrong —
    indexing rows the wrong way round. site_api must re-export, not copy."""
    assert site_api.scan_at is agent.scan_at
    assert site_api.ground_at is agent.ground_at


@pytest.mark.needs_site
def test_validator_and_check_pad_report_the_same_cut_and_fill():
    """The end-to-end point: the model is told to size a pad with
    check-pad, so validate() must not then grade it against different metres."""
    pts = agent._walk_polygon(SCANNED_PAD)
    assert site_api.coverage(pts) == 1.0, "fixture pad has drifted off the raycast"

    pad = site_api.cmd_check_pad(
        argparse.Namespace(polygon=json.dumps(SCANNED_PAD), level=PAD_LEVEL))
    design = {"version": 1, "units": "meters", "beds": [], "paths": [], "plants": [],
              "patios": [{"id": "pad", "polygon": SCANNED_PAD, "material": "flagstone",
                          "level_m": PAD_LEVEL}]}
    errors, warnings = agent.validate(design, _site())
    assert not errors, errors

    said = {}
    for w in warnings:
        for label in ("fill", "cut"):
            key = f" m of {label};"
            if key in w:
                said[label] = float(w.split("implies ")[1].split(" m of ")[0])
    assert said, f"no cut/fill warning fired, so this test proves nothing: {warnings}"
    for label, v in said.items():
        assert v == pad[f"max_{label}_m"], (
            f"validate() says {v} m of {label}, check-pad says {pad[f'max_{label}_m']} m "
            f"for the same pad at the same level")
