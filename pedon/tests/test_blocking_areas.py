"""A wall across ground the owner drew is a contradiction of ground truth.

`court_cut_stones` — a 4.9 m stone edge — runs through `back_yard_entrance`,
the area the owner marks as the route out of the house. And `walk_bank_wall`,
11.9 m of dry stone, runs through `need a path`, an area requiring a path.

Areas are owner ground truth, never model-generated or inferred from a name.
A barrier standing in one can contradict the owner's stated use. But a wall
may legitimately edge an area, and a screen may suit a courtyard; only the
owner can decide. So this WARNS and names what it crosses, just as a warning
names a wall that holds nothing — information at the point of decision, not
a veto. Arbitrary restrictions must not limit the model's design choices.
"""
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import agent    # noqa: E402

# about a REAL site — skipped without the reference site (tests/conftest.py)
pytestmark = pytest.mark.needs_site


@pytest.fixture(scope="module")
def site():
    with open(agent.SITE_PATH) as f:
        return json.load(f)


def base(**kw):
    d = {"version": 1, "units": "meters", "beds": [], "plants": [], "patios": [],
         "paths": [], "edges": [], "steps": [], "objects": []}
    d.update(kw)
    return d


def test_the_premise_the_owner_drew_these(site):
    names = {a["name"] for a in site.get("areas", [])}
    assert {"back_yard_entrance", "need a path"} <= names, sorted(names)


def test_a_wall_across_a_drawn_area_is_named_in_the_warnings(site):
    """The exact geometry from designed_v1 crosses the entrance area."""
    d = base(edges=[{"id": "court_cut_stones", "material": "boulder", "height_m": 0.4,
                     "spline": [[9.45, 4.4], [9.35, 6], [9.6, 7.6], [9.5, 9.3]]}])
    errors, warnings = agent.validate(d, site)
    hit = [w for w in warnings if "court_cut_stones" in w and "back_yard_entrance" in w]
    assert hit, f"nothing says the wall crosses the entrance:\n{warnings}"
    assert not [e for e in errors if "back_yard_entrance" in e], (
        "this is a warning, not a rejection — a wall may legitimately edge an area "
        "and only the owner can say")


def test_an_object_standing_in_a_drawn_area_is_named_too(site):
    """court_screen: 1.8 m tall, standing in the entrance area."""
    d = base(objects=[{"id": "court_screen", "kind": "screen", "position": [9.5, 5.2],
                       "height_m": 1.8}])
    _, warnings = agent.validate(d, site)
    assert [w for w in warnings if "court_screen" in w and "back_yard_entrance" in w], warnings


def test_low_things_and_open_things_do_not_cry_wolf(site):
    """A bed, a path or a 5 cm mowing strip in an area blocks nothing. Warning
    about them would make the real warning invisible, which is how a validator
    stops being read."""
    quiet = base(
        beds=[{"id": "b", "polygon": [[8.6, 4.4], [10.4, 4.4], [10.2, 6.2], [8.7, 6.2]],
               "mulch": "shredded bark"}],
        paths=[{"id": "p", "spline": [[9.0, 4.4], [9.6, 6.4]], "width_m": 1.1,
                "material": "decomposed_granite"}],
        edges=[{"id": "strip", "material": "aluminium", "height_m": 0.06,
                "spline": [[9.45, 4.4], [9.35, 6]]}])
    _, warnings = agent.validate(quiet, site)
    noisy = [w for w in warnings if "back_yard_entrance" in w]
    assert not noisy, f"warned about things that block nothing:\n{noisy}"


def test_it_says_WHICH_area_and_what_that_area_is_for(site):
    """"crosses a drawn area" is not actionable; the NAME is the whole point,
    because `need a path` identifies the area's required use."""
    d = base(edges=[{"id": "walk_bank_wall", "material": "dry_stone", "height_m": 0.45,
                     "spline": [[10.9, 3.8], [11.05, 2], [11.4, -0.4], [11.7, -2.6],
                                [12.0, -5.0], [12.2, -7.4], [12.4, -9.6]]}])
    _, warnings = agent.validate(d, site)
    hit = [w for w in warnings if "walk_bank_wall" in w and "need a path" in w]
    assert hit, f"the wall through 'need a path' is not reported:\n{warnings}"
    assert "0.45" in hit[0] or "0.4" in hit[0], f"the height is not stated: {hit[0]}"
