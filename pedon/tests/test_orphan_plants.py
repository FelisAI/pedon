"""A plant that belongs to no bed is usually a leftover from a bed that moved.

A bed extended over a retaining wall, planted, and then pulled back to the
measured base of the bank is replanted only INSIDE the corrected outline -- so the
plants the wide version put on the wall are orphaned outside it. Still in the file,
still rendered, standing on a pad 0.2-1.2 m above the bank.

validate() checks the house footprint, scan coverage, grade and spacing; unless
belonging to a bed is checked too, only the eye catches plants left standing on
top of a retaining wall.

A WARNING and not a rejection, because a specimen set outside a bed is legitimate
and this project enforces physical facts while only reporting taste. But an
orphan is also a plant nothing will mulch or irrigate.
"""
import pytest
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import agent
import project  # noqa: E402  where the active site's files are

# about a REAL site — skipped without the reference site (tests/conftest.py)
pytestmark = pytest.mark.needs_site


def _site():
    with open(project.data("site.json")) as f:
        return json.load(f)


BED = [[12.0, -6.0], [14.0, -6.0], [14.0, -4.0], [12.0, -4.0]]


def _design(*positions):
    return {
        "version": 1, "units": "meters", "paths": [], "patios": [], "edges": [],
        "steps": [], "objects": [],
        "beds": [{"id": "b1", "polygon": BED, "mulch": "bark"}],
        "plants": [{"id": f"p{i}", "species": "Thymus vulgaris", "position": list(pos),
                    "mature_height_m": 0.3, "mature_spread_m": 0.6}
                   for i, pos in enumerate(positions)],
    }


def test_a_plant_stranded_outside_every_bed_is_reported():
    errors, warnings = agent.validate(_design([13.0, -5.0], [9.0, -5.0]), _site())
    loose = [w for w in warnings if "no bed" in w]
    assert loose, "a plant outside every bed goes unmentioned — so plants can be left " \
                  "standing on a retaining wall"
    assert "p1" in loose[0], "the warning does not name which plant"


def test_it_is_a_WARNING_and_never_blocks():
    # physical facts and code are enforced, taste is only ever reported. A
    # specimen placed outside a bed is a legitimate design choice.
    errors, warnings = agent.validate(_design([9.0, -5.0]), _site())
    assert not [e for e in errors if "no bed" in e], "the orphan check became a hard rejection"


def test_plants_inside_a_bed_are_silent():
    # the complement: a warning that fires on a correct design is noise, and noise
    # is how the real one stops being read
    errors, warnings = agent.validate(_design([13.0, -5.0], [12.5, -4.5]), _site())
    assert not [w for w in warnings if "no bed" in w]


def test_a_design_with_no_beds_at_all_says_nothing():
    # plants before any bed exists is a normal intermediate state, not a fault
    d = _design([13.0, -5.0])
    d["beds"] = []
    errors, warnings = agent.validate(d, _site())
    assert not [w for w in warnings if "no bed" in w]
