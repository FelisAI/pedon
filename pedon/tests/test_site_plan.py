"""The site in plan with coordinates (tools/site_plan.py): what a designer draws on.

Camera views alone do not show where the ground is gentle or where it was never scanned,
and do not let an x, y be read off; the plan does.
"""
import pytest
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import site_plan  # noqa: E402
from planting_plan import key_codes  # noqa: E402


def test_bounds_follow_the_design_then_the_owners_areas_never_a_fixed_yard():
    site = {"areas": [{"name": "a", "polygon": [[100, 100], [104, 100], [104, 103]]}],
            "zones": [{"area_m2": 9, "bounds_m": {"x": [0, 3], "y": [0, 3]}}]}
    d = {"beds": [{"id": "b", "polygon": [[-20, -5], [-16, -5], [-16, -1]]}]}
    assert site_plan.default_bounds(d, site, margin=1) == (-21, -6, -15, 0)
    assert site_plan.default_bounds({}, site, margin=1) == (99, 99, 105, 104)
    assert site_plan.default_bounds({}, {"zones": site["zones"]}, margin=1) == (-1, -1, 4, 4)


def test_grade_is_read_over_two_cells_each_way():
    flat = [[0.0] * 9 for _ in range(9)]
    assert site_plan.grade_deg(flat, 4, 4, 0.5) == 0
    ramp = [[0.25 * i for i in range(9)] for _ in range(9)]      # 0.25 m per 0.5 m = 50%
    assert abs(site_plan.grade_deg(ramp, 4, 4, 0.5) - 26.565) < 0.01
    hole = [row[:] for row in flat]
    hole[4][2] = None                                              # unscanned: no grade invented
    assert site_plan.grade_deg(hole, 4, 4, 0.5) is None


@pytest.mark.needs_site
def test_it_draws_the_design_at_the_asked_scale_with_the_plan_codes(tmp_path):
    d = {"beds": [{"id": "b", "polygon": [[11, -6], [14, -6], [14, -3], [11, -3]]}],
         "plants": [{"id": "p", "species": "Salvia rosmarinus", "position": [12.5, -4.5],
                     "mature_spread_m": 1.2, "form": "mound"}]}
    out = tmp_path / "plan.png"
    got = site_plan.render(str(out), d, bounds=(10, -7, 15, -2), scale=40)
    from PIL import Image
    img = Image.open(out)
    assert img.size == (5 * 40 + 60, 5 * 40 + 44)
    assert got["codes"] == key_codes({"Salvia rosmarinus"}), "the plan's codes must be the planting plan's"
    assert got["plants"] == 1 and got["bounds"] == [10, -7, 15, -2]
