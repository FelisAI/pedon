"""resync_palette — a catalogue correction has to reach the plants already placed.

`place_plants` COPIES mature_height_m / mature_spread_m out of the palette into
the design, so correcting the catalogue leaves everything already planted on the
old figure. The obvious workaround — remove and re-place — is wrong in a way that
is easy to miss: `place_plants` always mints a FRESH id, so it would silently
empty the owner's groups and invalidate anything else holding an id. Keeping the
ids is the whole reason this is an op.
"""
import pytest
import copy
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import project  # noqa: E402  where the active site's files are
sys.path.insert(0, os.path.join(ROOT, "tools"))
import agent  # noqa: E402
from plant_catalog import catalog  # noqa: E402

# about a REAL site — skipped without the reference site (tests/conftest.py)
pytestmark = pytest.mark.needs_site


def _site():
    with open(project.data("site.json")) as f:
        return json.load(f)


def _entry(species="Westringia fruticosa"):
    return next(r for r in catalog()["plants"] if r["species"] == species)


def _design(entry, n=3, off=0.4):
    return {"version": 1, "units": "meters", "beds": [], "paths": [], "patios": [],
            "groups": [{"id": "g1", "name": "the hedge", "members": [f"p{i}" for i in range(n)]}],
            "plants": [{"id": f"p{i}", "species": entry["species"], "common": entry["common"],
                        "position": [12.0 + i * 2.0, -5.0],
                        "mature_height_m": entry["mature_height_m"] - off,
                        "mature_spread_m": entry["mature_spread_m"] - off}
                       for i in range(n)]}


def test_it_brings_planted_sizes_up_to_the_catalogue():
    e = _entry()
    out, msg = agent.execute(_design(e), _site(), "resync_palette", {})
    assert all(p["mature_height_m"] == e["mature_height_m"]
               and p["mature_spread_m"] == e["mature_spread_m"] for p in out["plants"])
    assert "resynced 3" in msg and e["species"] in msg, msg


def test_the_ids_survive_so_a_group_is_not_emptied():
    """The reason this is an op and not remove + place_plants."""
    e = _entry()
    before = _design(e)
    out, _ = agent.execute(before, _site(), "resync_palette", {})
    assert [p["id"] for p in out["plants"]] == [p["id"] for p in before["plants"]]
    assert out["groups"][0]["members"] == ["p0", "p1", "p2"], "the group lost its members"


def test_position_and_species_are_not_touched():
    e = _entry()
    before = _design(e)
    out, _ = agent.execute(copy.deepcopy(before), _site(), "resync_palette", {})
    for a, b in zip(before["plants"], out["plants"]):
        assert a["position"] == b["position"], "resync moved a plant"
        assert a["species"] == b["species"] and a["common"] == b["common"]


def test_a_design_already_in_step_is_left_alone():
    e = _entry()
    out, msg = agent.execute(_design(e, off=0.0), _site(), "resync_palette", {})
    assert "already matches" in msg, msg
    assert out["plants"][0]["mature_height_m"] == e["mature_height_m"]


def test_scoping_to_one_species_leaves_the_others_behind():
    e = _entry()
    other = _entry("Salvia rosmarinus")
    d = _design(e)
    d["plants"].append({"id": "px", "species": other["species"], "common": other["common"],
                        "position": [20.0, -5.0],
                        "mature_height_m": other["mature_height_m"] - 0.3,
                        "mature_spread_m": other["mature_spread_m"] - 0.3})
    out, msg = agent.execute(d, _site(), "resync_palette", {"species": [e["species"]]})
    px = next(p for p in out["plants"] if p["id"] == "px")
    assert px["mature_height_m"] == other["mature_height_m"] - 0.3, "an unnamed species was resynced"
    assert other["species"] not in msg


def test_an_unknown_species_is_refused_rather_than_silently_skipped():
    e = _entry()
    try:
        agent.execute(_design(e), _site(), "resync_palette", {"species": ["Ficus imaginarius"]})
    except ValueError as err:
        assert "no palette entry" in str(err)
    else:
        raise AssertionError("a species that is not in the palette was accepted")


def test_an_empty_species_list_is_refused_not_read_as_all():
    """`[]` almost certainly means a filter that produced nothing, and treating
    it as 'every species' would resync the whole design by accident."""
    e = _entry()
    try:
        agent.execute(_design(e), _site(), "resync_palette", {"species": []})
    except ValueError as err:
        assert "empty" in str(err)
    else:
        raise AssertionError("an empty species list silently resynced everything")
