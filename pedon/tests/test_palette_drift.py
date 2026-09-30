"""A planted size that no longer matches the palette.

`place_plants` COPIES mature_height_m / mature_spread_m out of the palette into
the design. Correcting the catalogue therefore does nothing to what is already
planted, and without this warning nothing says so: when a species moves from a
sourceless 1.4 x 1.5 planning estimate to a sourced 1.8 x 1.8, every planted copy
silently keeps the old figure, and every bed holding one is still measured as
though the plant stays small.
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


def _design(plants):
    return {"version": 1, "units": "meters", "beds": [], "paths": [], "patios": [],
            "plants": plants}


def _palette_entry():
    from plant_catalog import catalog
    return next(r for r in catalog()["plants"] if r["species"] == "Westringia fruticosa")


def test_a_planted_size_behind_the_palette_is_reported():
    e = _palette_entry()
    stale = _design([{"id": "p1", "species": e["species"], "common": e["common"],
                      "position": [12.0, -5.0],
                      "mature_height_m": e["mature_height_m"] - 0.4,
                      "mature_spread_m": e["mature_spread_m"] - 0.3}])
    warns = agent.validate(stale, _site())[1]
    hit = [w for w in warns if "palette now says" in w]
    assert hit, "a plant a whole 0.4 m behind the catalogue raised nothing"
    assert e["species"] in hit[0]
    assert "p1" in hit[0], "the warning does not say which plant to look at"


def test_a_plant_that_matches_the_palette_is_silent():
    """The counterweight: most planted plants agree with the catalogue (189 of
    201 in a measured design), so a warning that fires on agreement is pure noise."""
    e = _palette_entry()
    ok = _design([{"id": "p1", "species": e["species"], "common": e["common"],
                   "position": [12.0, -5.0],
                   "mature_height_m": e["mature_height_m"],
                   "mature_spread_m": e["mature_spread_m"]}])
    warns = agent.validate(ok, _site())[1]
    assert not [w for w in warns if "palette now says" in w]


def test_it_is_reported_per_species_not_per_plant():
    """Twelve identical lines would bury the one fact worth reading."""
    e = _palette_entry()
    many = _design([{"id": f"p{i}", "species": e["species"], "common": e["common"],
                     "position": [12.0 + i * 0.05, -5.0],
                     "mature_height_m": 1.4, "mature_spread_m": 1.5}
                    for i in range(6)])
    hit = [w for w in agent.validate(many, _site())[1] if "palette now says" in w]
    assert len(hit) == 1, f"one species produced {len(hit)} warnings"
    assert "6 planted" in hit[0], "the warning does not say how many are affected"


def test_it_is_a_warning_and_never_an_error():
    """A cultivar or a measured specimen is a legitimate reason to differ, and
    taste is only ever REPORTED — the house rule this obeys."""
    e = _palette_entry()
    stale = _design([{"id": "p1", "species": e["species"], "common": e["common"],
                      "position": [12.0, -5.0],
                      "mature_height_m": 0.4, "mature_spread_m": 0.7}])
    errs = agent.validate(stale, _site())[0]
    assert not [x for x in errs if "palette" in x], "drifting from the catalogue was REJECTED"
