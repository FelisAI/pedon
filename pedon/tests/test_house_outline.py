"""Nothing is built or planted inside the house — on a NEW site too.

A rule that reads site.footprint only switches itself OFF, silently, on a new site: there is
no footprint until its address is looked up, and public records may have none (an Overture
release can be missing the building at a real address). The survey measures the house — a
box round the enclosed unscanned region — and stands in for it.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))
import agent  # noqa: E402


def design(x, y):
    return {"version": 1, "units": "meters", "beds": [], "plants": [
        {"id": "p", "species": "Thymus vulgaris", "position": [x, y], "mature_height_m": 0.3, "mature_spread_m": 0.6}]}


MEASURED = {"house_measured": {"bounds_m": {"x": [-8, 9], "y": [-12, 6]}}}


def test_without_a_footprint_the_measured_house_is_the_house():
    errors, _ = agent.validate(design(0, 0), MEASURED)
    assert [e for e in errors if "inside the house as the survey measured it" in e], errors
    errors, _ = agent.validate(design(12, 0), MEASURED)
    assert not [e for e in errors if "inside the house" in e], errors


def test_a_footprint_wins_over_the_box():
    site = dict(MEASURED, footprint=[[-2, -2], [2, -2], [2, 2], [-2, 2]])
    errors, _ = agent.validate(design(6, 0), site)          # in the box, outside the walls
    assert not [e for e in errors if "inside the house" in e], errors
    errors, _ = agent.validate(design(0, 0), site)
    assert [e for e in errors if "inside the house footprint" in e], errors


def test_with_neither_there_is_nothing_to_refuse():
    errors, _ = agent.validate(design(0, 0), {})
    assert not [e for e in errors if "inside the house" in e]
