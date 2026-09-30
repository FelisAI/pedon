"""Spacing is the designer's; the validator refuses only what cannot be planted.

The designer decides spacing; hardcoded checks reject only physical collisions.

A formula based on spread (0.4x within a species, 0.8x across, plus a layer rule)
conflates taste with collisions: in the reference corpus it flags 13 pairs in a
hand-edited variant, including two hand-moved positions, and ~50 per saved design.
A thyme 4 cm from a Cleveland sage's stem is a physical collision in ~40 designs.
The distinction is:

  * REFUSED: two plants in one planting hole; a plant in a tree's trunk.
  * MEASURED: own_kind_nearest (a scatter reads low) and crowns_overlapping — reported.
  * compose.py plants drawn overlaps through each other and offers no ground in a hole.
"""
import pytest
import collections
import copy
import json
import math
import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import project  # noqa: E402  where the active site's files are
sys.path.insert(0, os.path.join(ROOT, "tools"))

import agent  # noqa: E402
import compose  # noqa: E402
import replant  # noqa: E402
import site_api  # noqa: E402


def plant(pid, species, x, y, h, w):
    return {"id": pid, "species": species, "common": species, "position": [x, y],
            "mature_height_m": h, "mature_spread_m": w}


def errs(*plants):
    return agent.validate({"version": 1, "units": "meters", "beds": [], "plants": list(plants)}, {})


def test_two_plants_in_one_hole_are_refused():
    e, _ = errs(plant("a", "Salvia clevelandii", 0, 0, 1.2, 1.5), plant("b", "Thymus vulgaris", 0.04, 0, 0.3, 0.6))
    assert [x for x in e if "one planting hole" in x], e


def test_two_small_pots_side_by_side_are_not():
    """10 cm is the narrowest pot; two of them touching can be planted — and a value
    stored to 2 decimals as 0.09 may be 0.095 on the ground."""
    e, _ = errs(plant("a", "Thymus vulgaris", 0, 0, 0.3, 0.6), plant("b", "Thymus vulgaris", 0.09, 0, 0.3, 0.6))
    assert not [x for x in e if "planting hole" in x], e


def test_a_plant_in_a_trees_trunk_is_refused_and_one_at_its_foot_is_not():
    tree = plant("t", "Arctostaphylos 'Dr. Hurd'", 0, 0, 4.5, 3.5)
    e, _ = errs(tree, plant("h", "Heuchera", 0.15, 0, 0.4, 0.5))
    assert [x for x in e if "trunk and root flare" in x], e
    e, _ = errs(tree, plant("h", "Heuchera", 0.4, 0, 0.4, 0.5))
    assert not [x for x in e if "trunk" in x], e


def test_close_is_the_designers_call_and_draws_no_verdict():
    """A carpet at a sage's foot, two perennials knitting, three of a kind tight: all
    legal and all silent — spacing preferences are not physical collisions."""
    e, w = errs(plant("s", "Salvia clevelandii", 0, 0, 1.2, 1.5), plant("t", "Thymus vulgaris", 0.3, 0, 0.3, 0.6),
                plant("p", "Penstemon heterophyllus", 1.0, 0, 0.6, 0.6), plant("q", "Erigeron glaucus", 1.2, 0, 0.3, 0.6),
                plant("m1", "Muhlenbergia capillaris", 3, 0, 0.9, 0.9), plant("m2", "Muhlenbergia capillaris", 3.2, 0, 0.9, 0.9))
    assert not [x for x in e if "plants " in x], e
    assert not [x for x in w if "apart" in x or "suggested" in x], w


def test_moving_a_plant_out_of_the_hole_reads_as_better_not_worse():
    """The number in the message is how far INSIDE the limit — so the baseline compare
    (_is_new_or_worse) lets an op that moves a plant away through, and blames one that
    moves it nearer."""
    a = plant("a", "Salvia clevelandii", 0, 0, 1.2, 1.5)
    before = errs(a, plant("b", "Thymus vulgaris", 0.02, 0, 0.3, 0.6))[0]
    base = {agent._error_key(m): m for m in before}
    better = errs(a, plant("b", "Thymus vulgaris", 0.06, 0, 0.3, 0.6))[0]
    worse = errs(a, plant("b", "Thymus vulgaris", 0.01, 0, 0.3, 0.6))[0]
    assert not [m for m in better if agent._is_new_or_worse(m, base)], better
    assert [m for m in worse if agent._is_new_or_worse(m, base)], worse


def test_the_formula_is_gone():
    assert not hasattr(replant, "pair_spacing") and not hasattr(replant, "min_spacing")
    assert not hasattr(replant, "LAYER_BASE"), "layer fractions encode taste as a rule"


BED = [[0, 0], [6, 0], [6, 4], [0, 4]]


def bed_design(plants=()):
    return {"version": 1, "units": "meters", "beds": [{"id": "b", "polygon": BED}], "paths": [], "patios": [],
            "plants": list(plants), "edges": [], "steps": [], "objects": []}


def test_drifts_drawn_to_overlap_are_planted_through_each_other():
    """A thyme carpet drawn THROUGH a rosemary drift must extend between its plants.
    Carving a seam round each rosemary would override the designer's drawing."""
    comp = {"masses": [{"species": "Salvia rosmarinus", "count": 3, "bed": "b", "ellipse": [3, 2, 1.5, 1.2, 0]},
                       {"species": "Thymus vulgaris", "count": 8, "bed": "b", "ellipse": [3, 2, 1.0, 0.8, 0]}]}
    ops, new, rep = compose.compose(bed_design(), comp)
    assert rep["problems"] == [], rep["problems"]
    rosemary = [p["position"] for p in new if p["species"] == "Salvia rosmarinus"]
    thyme = [p["position"] for p in new if p["species"] == "Thymus vulgaris"]
    assert len(thyme) == 8
    near = min(math.dist(t, r) for t in thyme for r in rosemary)
    assert near < 0.6, f"the carpet still keeps a seam off the rosemary ({near:.2f} m)"
    assert near >= agent.PLANTING_HOLE_M, "compose put a thyme in a rosemary's hole"
    assert "Rosemary" in str(rep["masses"][1].get("shares_ground_with")), rep["masses"][1]


def test_no_ground_is_offered_in_a_hole_even_overfull_and_loose():
    d = bed_design([plant("r", "Salvia rosmarinus", 3, 2, 1.4, 1.5)])
    comp = {"masses": [{"species": "Thymus vulgaris", "count": 40, "bed": "b", "ellipse": [3, 2, 0.5, 0.4, 0],
                        "loose": 0.5}]}
    ops, new, rep = compose.compose(d, comp)
    pts = [p["position"] for p in new] + [[3, 2]]
    assert min(math.dist(a, b) for i, a in enumerate(pts) for b in pts[i + 1:]) >= agent.PLANTING_HOLE_M - 1e-9
    e, _ = agent.validate(dict(d, plants=d["plants"] + [dict(p, id=f"n{i}") for i, p in enumerate(new)]), {})
    assert not [x for x in e if "planting hole" in x], e[:3]


def test_a_dense_drift_is_measured_not_refused():
    comp = {"masses": [{"species": "Salvia rosmarinus", "count": 12, "bed": "b", "ellipse": [3, 2, 0.8, 0.6, 0]}]}
    _, _, rep = compose.compose(bed_design(), comp)
    m = rep["masses"][0]
    assert m["placed"] == 12 and not rep["problems"], rep
    assert m["on_centre_of_spread"] < 0.5, m      # the reading says how tight it is


def test_a_count_past_one_plant_per_hole_is_said_not_squeezed():
    comp = {"masses": [{"species": "Thymus vulgaris", "count": 500, "bed": "b", "ellipse": [3, 2, 0.8, 0.6, 0]}]}
    _, _, rep = compose.compose(bed_design(), comp)
    assert rep["problems"] and "room for only" in rep["problems"][0], rep["problems"]


def shuffled(design, seed):
    """The same positions and the same species counts per bed, species dealt at random:
    what a sampler that ignores drifts produces."""
    from geom import point_in_polygon
    d = copy.deepcopy(design)
    rng = random.Random(seed)
    beds = [(b["id"], b["polygon"]) for b in d.get("beds", []) if b.get("polygon")]
    groups = collections.defaultdict(list)
    for p in d["plants"]:
        groups[next((i for i, poly in beds if point_in_polygon(*p["position"][:2], poly)), None)].append(p)
    keys = ("species", "common", "mature_spread_m", "mature_height_m")
    for g in groups.values():
        recs = [{k: p.get(k) for k in keys} for p in g]
        rng.shuffle(recs)
        for p, r in zip(g, recs):
            p.update(r)
    return d


@pytest.mark.needs_site
def test_a_scatter_reads_as_one_in_the_measurement():
    """Own-kind proximity must distinguish drawn drifts from a random scatter without
    spacing warnings: compare the same design as drawn and with species shuffled."""
    liked = json.load(open(project.data("designs", "naturalism_2026_09_25.json")))
    drawn = site_api.planting_character(liked)["own_kind_nearest"]
    dealt = site_api.planting_character(shuffled(liked, 1))["own_kind_nearest"]
    assert drawn >= 0.6 and dealt <= 0.3, (drawn, dealt)


def test_crowns_overlapping_splits_one_height_from_one_over_another():
    ps = [plant("s", "Salvia clevelandii", 0, 0, 1.2, 1.5), plant("p", "Salvia leucophylla", 0.6, 0, 1.2, 1.5),
          plant("t", "Thymus vulgaris", 5, 0, 0.3, 0.6), plant("g", "Muhlenbergia rigens", 5.1, 0, 1.2, 1.2),
          plant("o", "Olea europaea", 9, 0, 5.0, 4.0), plant("u", "Heuchera", 9.5, 0, 0.4, 0.5)]
    c = site_api.crowns_overlapping(ps)
    assert c["at_one_height"] == 1 and c["one_over_another"] == 1, c   # the tree's crown is overhead
    assert "s Salvia clevelandii / p Salvia leucophylla" in c["at_one_height_most"][0]


def test_the_bed_reading_shows_overlap_before_it_is_applied():
    """Nothing carves a seam, so a drawing that overlaps two same-height drifts must
    be SAID at the point of decision — and drawing them apart must read clean."""
    over = {"masses": [{"species": "Salvia leucophylla", "count": 3, "bed": "b", "ellipse": [2.5, 2, 1.2, 1.0, 0]},
                       {"species": "Salvia clevelandii", "count": 3, "bed": "b", "ellipse": [3.2, 2, 1.2, 1.0, 0]}]}
    apart = {"masses": [{"species": "Salvia leucophylla", "count": 2, "bed": "b", "ellipse": [1.3, 2, 0.9, 1.2, 0]},
                        {"species": "Salvia clevelandii", "count": 2, "bed": "b", "ellipse": [4.7, 2, 0.9, 1.2, 0]}]}
    crowded = compose.compose(bed_design(), over)[2]["beds"]["b"]
    clear = compose.compose(bed_design(), apart)[2]["beds"]["b"]
    assert crowded["crowns_at_one_height"] > 0 and crowded["crowns_at_one_height_most"], crowded
    assert clear["crowns_at_one_height"] == 0, clear
    assert clear["own_kind_nearest"] == 1.0, clear
