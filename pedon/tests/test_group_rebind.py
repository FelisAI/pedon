"""A group may not hold a member that no longer exists.

`next_id` reuses the lowest free id, so a remove followed by a place — which is
every replant — hands a dead id straight to an unrelated new plant. Any group
still holding that id silently RE-BINDS to the new plant.

Measured on a real design, one replant of two beds is enough to swap 53 members
of a 54-member group from Pink muhly grass to Seaside daisy. A HIDDEN group
re-bound that way quietly hides a different part of the garden than the owner
chose, and nothing reports it — the design contains things nobody put there.
"""
import pytest
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import project  # noqa: E402  where the active site's files are
sys.path.insert(0, os.path.join(ROOT, "tools"))
import agent  # noqa: E402

# about a REAL site — skipped without the reference site (tests/conftest.py)
pytestmark = pytest.mark.needs_site


def _site():
    with open(project.data("site.json")) as f:
        return json.load(f)


def _design(n=6):
    return {"version": 1, "units": "meters", "beds": [], "paths": [], "patios": [],
            "groups": [{"id": "g1", "name": "the drift",
                        "members": [f"p{i}" for i in range(n)]}],
            "plants": [{"id": f"p{i}", "species": "Salvia clevelandii",
                        "common": "Cleveland sage", "position": [12.0 + i * 0.9, -5.0],
                        "mature_height_m": 1.2, "mature_spread_m": 1.2}
                       for i in range(n)]}


def test_removing_a_member_drops_it_from_the_group():
    out, msg = agent.execute(_design(), _site(), "remove_objects", {"ids": ["p0", "p1"]})
    assert out["groups"][0]["members"] == ["p2", "p3", "p4", "p5"]
    assert "group member" in msg, f"the drop is silent: {msg}"


def test_a_recycled_id_cannot_re_bind_to_the_group():
    """The actual fault. Remove two, plant something else, and the new plant must
    NOT find itself inside a group it was never put in."""
    d = _design()
    after_remove, _ = agent.execute(d, _site(), "remove_objects", {"ids": ["p0", "p1"]})
    after_plant, _ = agent.execute(after_remove, _site(), "place_plants",
                                   {"plants": [{"species": "Thymus vulgaris",
                                                "common": "Common thyme",
                                                "position": [13.4, -6.2],
                                                "mature_height_m": 0.3,
                                                "mature_spread_m": 0.6}]})
    thyme = next(p for p in after_plant["plants"] if p["common"] == "Common thyme")
    members = after_plant["groups"][0]["members"]
    assert thyme["id"] not in members, (
        f"the new thyme was handed id {thyme['id']} and landed inside a group of sages")


def test_a_group_emptied_to_one_member_goes():
    """A row holding one thing is not a group, and it is what the owner would
    have to clean up by hand otherwise."""
    out, _ = agent.execute(_design(3), _site(), "remove_objects", {"ids": ["p0", "p1"]})
    assert out.get("groups") == []


def test_removing_nothing_from_a_group_leaves_it_alone():
    """The counterweight: a removal elsewhere must not disturb the grouping."""
    d = _design()
    d["plants"].append({"id": "px", "species": "Thymus vulgaris", "common": "Common thyme",
                        "position": [20.0, -5.0], "mature_height_m": 0.3, "mature_spread_m": 0.6})
    out, msg = agent.execute(d, _site(), "remove_objects", {"ids": ["px"]})
    assert out["groups"][0]["members"] == [f"p{i}" for i in range(6)]
    assert "group member" not in msg, f"reported a group change that did not happen: {msg}"


def test_a_design_with_no_groups_is_untouched():
    d = _design()
    d.pop("groups")
    out, _ = agent.execute(d, _site(), "remove_objects", {"ids": ["p0"]})
    assert "groups" not in out or out["groups"] == []
