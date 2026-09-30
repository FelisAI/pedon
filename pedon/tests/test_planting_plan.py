"""The drawings a plant goes into the ground from.

The goal is to plant things at the right location, from the drawings the trade uses.
The trade builds from a planting plan, a plant schedule and a setting-out sheet. A drawing that
LOOKS right and carries a wrong distance is worse than none — somebody digs a hole by
it — so what is tested is the numbers a tape will be held against.
"""
import json
import math
import os
import re
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import project  # noqa: E402  where the active site's files are
sys.path.insert(0, os.path.join(ROOT, "tools"))

import planting_plan as P  # noqa: E402


def test_a_tape_reads_feet_and_inches_to_the_half_inch():
    assert P.feet_inches(7.62) == "25' 0\""
    assert P.feet_inches(0.3048 * 3 + 0.0254 * 6.5) == "3' 6½\""
    assert P.feet_inches(0.0254 * 11.8) == "1' 0\"", "11.8 in rounds UP to a foot, not to 0' 12\""
    assert P.both(1.0) == "1.00 m · 3' 3½\""


def test_station_and_offset_say_which_side_and_never_lie_beyond_the_end():
    line = [(0, 0), (4, 0), (4, 3)]                    # east 4 m, then north 3 m
    st, off, side, seg, clamped, foot = P.station_offset((1.0, 0.5), line)
    assert (round(st, 3), round(off, 3), side, seg, clamped) == (1.0, 0.5, "left", 0, False)
    st, off, side, seg, clamped, foot = P.station_offset((5.0, 2.0), line)
    assert (round(st, 3), round(off, 3), side, seg) == (6.0, 1.0, "right", 1), "station must run ON along the second leg"
    # past the last stake a square offset means nothing, and the sheet must not print one
    assert P.station_offset((4.5, 4.0), line)[4] is True
    assert P.station_offset((-1.0, 0.2), line)[4] is True
    assert P.station_offset((2.0, -0.4), line)[2] == "right"


def test_a_taut_tape_is_longer_than_the_plan_on_a_slope(monkeypatch):
    monkeypatch.setattr(P.agent, "ground_at", lambda x, y: -0.2 * x)       # this yard: about 20%
    d = P.taut((0, 0), (10, 0), None)
    assert abs(d - math.sqrt(100 + 4)) < 1e-9, d
    assert d - 10 > 0.19, "20 cm over ten metres is the width of a plant — a plan distance plants it short"
    monkeypatch.setattr(P.agent, "ground_at", lambda x, y: None)           # off the scan: plan distance, not a crash
    assert P.taut((0, 0), (3, 4), None) == 5


def test_two_tapes_must_cross_at_a_usable_angle():
    assert round(P.intersection_angle((0, 0), (10, 0), (5, 5))) == 90
    assert P.intersection_angle((0, 0), (10, 0), (5, 0.2)) > 150, "almost on the line A-B: the arcs graze"
    assert P.intersection_angle((0, 0), (1, 0), (30, 5)) < 5


def test_controls_are_the_nearest_pair_that_still_fixes_every_stake():
    stakes = [(5, 5), (6, 6)]
    far = [{"name": "far_a", "x": -40, "y": 5}, {"name": "far_b", "x": 5, "y": 50}]     # a fine angle, 45 m away
    near = [{"name": "near_a", "x": 0, "y": 4}, {"name": "near_b", "x": 6, "y": 0}]     # a fine angle, 5 m away
    lm = far + near
    assert sorted(l["name"] for l in P.pick_controls(lm, stakes)) == ["near_a", "near_b"], "the shorter tapes win when both pairs fix the stakes"
    # ... but NOT when the short pair's tapes graze: near_a and `opposite` face each
    # other across the stakes (~175 deg), so the arcs barely cross
    opposite = {"name": "opposite", "x": 9, "y": 5.8}
    assert P.intersection_angle((0, 4), (9, 5.8), stakes[0]) > 165
    got = sorted(l["name"] for l in P.pick_controls([near[0], opposite, far[1]], stakes))
    assert got != ["near_a", "opposite"], "picked the shortest tapes although they cannot fix a point"
    with pytest.raises(SystemExit):
        P.pick_controls(lm, stakes, ["near_a", "no_such_marker"])
    with pytest.raises(SystemExit):
        P.pick_controls(lm[:1], stakes)


def test_key_codes_are_unique_and_a_cultivar_has_its_own():
    codes = P.key_codes({"Salvia leucantha", "Salvia leucophylla", "Thymus serpyllum 'Pink Chintz'",
                         "Thymus serpyllum 'Elfin'", "Muhlenbergia capillaris", "Teucrium spp."})
    assert len(set(codes.values())) == len(codes), codes
    assert codes["Muhlenbergia capillaris"] == "MUH CAP"
    assert codes["Thymus serpyllum 'Pink Chintz'"] == "THY PIN" and codes["Thymus serpyllum 'Elfin'"] == "THY ELF"
    assert {codes["Salvia leucantha"], codes["Salvia leucophylla"]} == {"SAL LEU", "SAL LE2"}
    assert all(re.fullmatch(r"[A-Z]{3} [A-Z0-9]{2,3}", c) for c in codes.values()), codes


def test_a_drift_is_labelled_once_and_a_big_plant_never_joins_one():
    mk = lambda sp, x, y, w: {"species": sp, "position": [x, y], "mature_spread_m": w}
    plants = [mk("thyme", 0, 0, 0.5), mk("thyme", 0.4, 0, 0.5), mk("thyme", 0.8, 0.1, 0.5),   # a drift of three
              mk("thyme", 9, 9, 0.5),                                                          # a stray
              mk("daisy", 0.2, 0.3, 0.6), mk("daisy", 0.5, 0.4, 0.6),                          # only two: not a mass
              mk("sage", 0, 0.5, 1.5), mk("sage", 1, 0.5, 1.5), mk("sage", 2, 0.5, 1.5)]      # big: labelled singly
    got = P.drifts(plants)
    assert [len(g) for g in got] == [3] and {p["species"] for p in got[0]} == {"thyme"}


@pytest.fixture(scope="module")
def built():
    design = json.load(open(project.data("designs", "huajing_J_sunroom.json")))
    site = json.load(open(project.data("site.json")))
    palette = {p["species"]: p for p in json.load(open(project.data("plant_palette.json")))["plants"]}
    beds = {"hua_jing_lower", "hua_jing_upper", "hua_jing_prelude"}
    doc, info = P.build(design, site, palette, "hua_walk", beds, title="huajing_J_sunroom")
    return design, doc, info


@pytest.mark.needs_site
def test_every_plant_is_on_the_sheets_exactly_once_and_the_schedule_adds_up(built):
    design, doc, info = built
    assert info["plants"] > 80 and info["weak_stakes"] == 0 and info["fits_letter"]
    table = doc[doc.index("SETTING OUT — PLANTS"):]
    ids = re.findall(r"<td>(p\d+)</td><td>☐</td>", table)
    assert len(ids) == info["plants"] and len(set(ids)) == len(ids), "a plant is missing from the walking-order table, or in it twice"
    schedule = doc[doc.index("PLANT SCHEDULE"):doc.index("L-3")]
    qty = [int(n) for n in re.findall(r'</td><td class="n">(\d+)</td><td>—</td>', schedule)]
    assert sum(qty) == info["plants"], f"the schedule buys {sum(qty)} plants and the plan shows {info['plants']}"
    assert doc.count('class="plant') >= 2 * info["plants"], "L-1 and L-3 must both draw every plant"
    # 1:50 is a promise about millimetres: 1 m of bed is 20 mm of paper
    w = float(re.search(r'<svg[^>]*width="([\d.]+)mm"', doc).group(1))
    assert abs(w - info["sheet_mm"][0]) < 1


@pytest.mark.needs_site
def test_the_sheet_is_honest_about_what_this_site_has_not_got(built):
    _, doc, _ = built
    assert "north NOT set" in doc, "bearings must not be implied on a site whose north was never set"
    assert "cat safety NOT verified" in doc, "cat_safe: null is NOT safe — the schedule has to say so"
    assert "blank on purpose" in doc, "container sizes are not recorded; a guessed one is worse than a blank"


@pytest.mark.needs_site
def test_the_baseline_is_chosen_from_the_named_beds():
    design = json.load(open(project.data("designs", "huajing_J_sunroom.json")))
    assert P.auto_baseline(design, {"hua_jing_lower", "hua_jing_upper"}) == "hua_walk"
    assert "hua_jing_upper" in P.auto_beds(design, "hua_walk")
