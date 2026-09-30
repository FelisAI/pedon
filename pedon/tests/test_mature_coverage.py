"""Crowding is measured at FULL maturity, bed by bed.

A design is judged at full maturity: the model must design and look at the
planting as it will be when mature. A bed spaced for the ~5-year look can measure
2.15x / 2.50x mature coverage — too crowded at full size — so validate() reports
it when plants are placed, and composition carries it per bed.
"""
import pytest
import json
import math
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import project  # noqa: E402  where the active site's files are
sys.path.insert(0, os.path.join(ROOT, "tools"))
import agent  # noqa: E402

# about a REAL site — skipped without the reference site (tests/conftest.py)
pytestmark = pytest.mark.needs_site

SITE = json.load(open(project.data("site.json"))) if os.path.exists(project.data("site.json")) else {}   # read at import: guarded so a fresh checkout can COLLECT the file it then skips
BED = [[14.0, -6.0], [18.0, -6.0], [18.0, -2.0], [14.0, -2.0]]      # 16 m2


def design(n_plants, spread=1.0, paths=()):
    plants = []
    for i in range(n_plants):
        plants.append({"id": f"p{i}", "species": "Thymus vulgaris", "common": "Thyme",
                       "position": [14.2 + (i % 8) * 0.5, -5.8 + (i // 8) * 0.5],
                       "mature_height_m": 0.3, "mature_spread_m": spread})
    return {"version": 1, "units": "meters", "beds": [{"id": "b", "polygon": BED}],
            "paths": list(paths), "plants": plants}


def crowding_warnings(d):
    _, warnings = agent.validate(d, SITE, None)
    return [w for w in warnings if w.startswith("bed b: at full maturity")]


def test_coverage_is_canopy_at_mature_spread_over_the_beds_ground():
    d = design(20, spread=1.0)           # 20 x pi/4 = 15.7 m2 of canopy over 16 m2
    m = agent.bed_mature_coverage(d)["b"]
    assert abs(m["ground_m2"] - 16.0) < 0.6
    assert abs(m["coverage"] - 20 * math.pi / 4 / m["ground_m2"]) < 0.01
    assert m["reading"] == "closes, just" or m["reading"] == "thin at maturity"


def test_a_bed_crowded_at_full_maturity_is_reported_and_a_spaced_one_is_not():
    crowded = design(40, spread=1.0)     # ~2x at full size
    assert crowding_warnings(crowded), "a bed at ~2x mature coverage said nothing"
    assert "crowded" in crowding_warnings(crowded)[0] or "tight" in crowding_warnings(crowded)[0]
    spaced = design(20, spread=1.0)      # ~1x
    assert not crowding_warnings(spaced), "a bed spaced for full size was called crowded"


def test_paving_inside_the_outline_is_not_ground():
    # a walk inside a bed outline is not soil — the hua_jing beds contain their walk
    walk = {"id": "w", "spline": [[14.0, -4.0], [18.0, -4.0]], "width_m": 1.0}
    bare, paved = design(0), design(0, paths=[walk])
    g0 = agent.bed_mature_coverage(bare)["b"]["ground_m2"]
    g1 = agent.bed_mature_coverage(paved)["b"]["ground_m2"]
    assert g0 - g1 > 3.0, f"a 4 m x 1 m walk through the bed took only {g0 - g1} m2 off its ground"


def test_it_is_a_report_not_a_rejection():
    errors, _ = agent.validate(design(40, spread=1.0), SITE, None)
    assert not [e for e in errors if "maturity" in e], "density is taste; it must never reject"
