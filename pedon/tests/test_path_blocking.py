"""A bed or a barrier standing in a PATH is the same class as one in an area.

The downhill horizontal walkway must remain clear. In the reference design,
`bed_terrace_apron` clears the 1.05 m corridor by 0.35 m and the moon gate's jamb
by 0.45 m. `bed_shoulder` narrows it from 1.05 m to 0.79 m. Validation must
identify the actual obstruction by measurement rather than by the user's guess.

The rule warns rather than rejects, like the area check: a bed may
legitimately run right up to a path, stepping stones are MEANT to sit in
planting, and a lantern beside a tea walk is correct. Only the owner can say.
"""
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import project  # noqa: E402  where the active site's files are
sys.path.insert(0, os.path.join(ROOT, "tools"))
import agent  # noqa: E402

# about a REAL site — skipped without the reference site (tests/conftest.py)
pytestmark = pytest.mark.needs_site


@pytest.fixture(scope="module")
def site():
    with open(project.data("site.json")) as f:
        return json.load(f)


def warns(design, site, needle):
    _, w = agent.validate(design, site)
    return [x for x in w if needle in x]


BED = [[0.0, -1.0], [6.0, -1.0], [6.0, 0.35], [0.0, 0.35]]   # lies over the path


def design_with(**kw):
    d = {"paths": [{"id": "walk", "spline": [[0, 0], [6, 0]],
                    "width_m": 1.2, "material": "decomposed_granite"}],
         "beds": [], "edges": [], "objects": [], "plants": [], "patios": [], "steps": []}
    d.update(kw)
    return d


def test_a_bed_over_the_path_is_reported_by_what_is_LEFT(site):
    # the number that matters is the walkable remainder, not the share taken
    d = design_with(beds=[{"id": "greedy", "polygon": BED, "mulch": "bark"}])
    hits = warns(d, site, "walkable surface")
    assert hits, "a bed covering more than half the path raised nothing"
    assert "greedy" in hits[0]
    assert "walk" in hits[0]


def test_a_bed_beside_the_path_is_NOT_reported(site):
    # beds run up to paths; that is what beds do, and a warning that fires on it
    # is one nobody reads
    beside = [[0.0, 0.61], [6.0, 0.61], [6.0, 2.0], [0.0, 2.0]]
    d = design_with(beds=[{"id": "tidy", "polygon": beside, "mulch": "bark"}])
    assert not warns(d, site, "walkable surface")


def test_the_pinch_is_measured_at_the_NARROWEST_point(site):
    # A short deep bite is what stops you walking, and it averages away to almost
    # nothing: bed_shoulder takes 3.2% of the contour walk's surface and still
    # leaves it 0.79 m wide where it bites. A share-of-total rule misses it.
    bite = [[2.8, -1.0], [3.4, -1.0], [3.4, 0.45], [2.8, 0.45]]   # 0.6 m of the 6 m run
    d = design_with(beds=[{"id": "bite", "polygon": bite, "mulch": "bark"}])
    hits = warns(d, site, "walkable surface")
    assert hits, "a deep bite over one short stretch was averaged away"
    assert "bite" in hits[0]


def test_a_barrier_across_a_route_is_reported(site):
    d = design_with(edges=[{"id": "wall", "spline": [[3, -1], [3, 1]],
                            "height_m": 0.8, "material": "dry_stone"}])
    assert warns(d, site, "stands in the walkway")


def test_a_low_edge_is_not_a_barrier(site):
    # a mowing strip is not a wall — same BLOCKING_HEIGHT_M rule the area check uses
    d = design_with(edges=[{"id": "strip", "spline": [[3, -1], [3, 1]],
                            "height_m": 0.06, "material": "steel"}])
    assert not warns(d, site, "stands in the walkway")


def test_an_object_beside_a_path_is_allowed_but_one_ON_it_is_not(site):
    on = design_with(objects=[{"id": "post", "kind": "screen", "position": [3, 0],
                               "height_m": 1.8, "width_m": 0.6}])
    assert warns(on, site, "reaches into the walkway")
    beside = design_with(objects=[{"id": "lamp", "kind": "lantern", "position": [3, 1.15],
                                   "height_m": 1.2, "width_m": 0.4}])
    assert not warns(beside, site, "reaches into the walkway"), \
        "a lantern set beside a path is correct and must not warn"


def test_the_apron_and_moon_gate_do_NOT_block_the_walk(site):
    # Use the measured reference design, tracked as a fixture. Reading the live
    # working file would make this depend on the owner's current design and fail
    # for a different moon gate even when the rule is correct.
    with open(os.path.join(os.path.dirname(__file__), "fixtures",
                           "hua_jing_design.json")) as f:
        d = json.load(f)
    hits = warns(d, site, "walkway") + warns(d, site, "walkable surface")
    named = [h for h in hits if "bed_terrace_apron" in h or "moon_gate" in h]
    assert not named, (
        "bed_terrace_apron or moon_gate is reported as blocking the contour walk. "
        "Their measured clearances are 0.35 m and 0.45 m; bed_shoulder narrows it. "
        f"Re-measure before acting on the owner's brief: {named}")
