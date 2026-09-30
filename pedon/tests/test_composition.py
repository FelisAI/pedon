"""What the design is MADE OF — the balance a designer sees.

A design can tip into paving without any single op looking wrong. Measured between
two saved designs: path area 21.5 -> 46.5 m2 (2.2x) from usable_v3 to coherent_v1,
and although BED area rose 78.6 -> 99.3 m2, the plant count fell 58 -> 41. Density
halved, 1.4 -> 2.4 m2 per plant. The beds are there and half empty, and the yard
reads as filled with path, even on the slope.

Not a validator. Arbitrary restriction hinders the model's capability: a
connectivity rule would penalise the design the owner likes best, and a
composition RULE would do the same, because the correct ratio of hardscape to
planting is taste, and a courtyard and a meadow are both legitimate.

What the model lacks is not a limit, it is the NUMBER. A human designer sees a
yard turning into paving; a model emits one op at a time and never sees the
balance it is accumulating. So: report it, and let the design decide.
"""
import json
import math
import os
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import project  # noqa: E402  where the active site's files are
sys.path.insert(0, os.path.join(ROOT, "tools"))
import site_api  # noqa: E402

# about a REAL site — skipped without the reference site (tests/conftest.py)
pytestmark = pytest.mark.needs_site


def run(design):
    return site_api.cmd_composition(type("A", (), {"design": design, "zone": None})())


def path_of(name):
    return project.data("designs", f"{name}.json")


def test_the_two_designs_this_came_from_still_exist():
    """Guard the premise: the numbers below are quoted from these files."""
    for n in ("usable_v3", "coherent_v1"):
        assert os.path.exists(path_of(n)), f"{n} is gone — re-derive before trusting this file"


def test_it_reports_what_the_yard_is_made_of():
    c = run(path_of("coherent_v1"))
    for k in ("hardscape_pct", "planted_pct", "open_pct", "planting_density_m2_per_plant"):
        assert k in c, f"no {k} — the balance is still invisible"


def test_it_sees_the_difference_the_owner_saw():
    """The whole point: a shift the owner can see has to be visible in the numbers."""
    old, new = run(path_of("usable_v3")), run(path_of("coherent_v1"))
    op, np_ = old["hardscape_by_kind_m2"]["path"], new["hardscape_by_kind_m2"]["path"]
    assert np_ > op * 1.5, f"path {op} -> {np_} should read as a large increase"
    assert new["planting_density_m2_per_plant"] > old["planting_density_m2_per_plant"] * 1.4, (
        "density halved and the report does not show it")


def test_it_does_not_grade_the_design():
    """No verdict, no threshold, no pass/fail. A courtyard and a meadow are both
    legitimate and the tool must not have an opinion about which the owner wants."""
    c = run(path_of("coherent_v1"))
    blob = json.dumps(c).lower()
    for word in ("too much", "should", "exceeds", "violation", "error", "warning", "limit"):
        assert word not in blob, f"the report editorialises ({word!r}); it must only measure"


def test_percentages_are_of_measured_ground():
    c = run(path_of("coherent_v1"))
    assert c["zone_area_m2"] > 100, "percentages of an unmeasured yard mean nothing"
    total = c["hardscape_pct"] + c["planted_pct"] + c["open_pct"]
    assert abs(total - 100) < 0.5, f"the three shares sum to {total}, not 100"
