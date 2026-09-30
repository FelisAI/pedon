"""The property's retaining walls, found in the scan.

Without a wall detector, a bed extended across the crest and face of a retaining
wall passes every rule, because validate() asks whether ground is inside the
house footprint and never whether it is a wall — adding soil and plants on top
of the wall goes unreported, and only the eye catches it.

find_walls is find_building's little brother. The building is the enclosed hole
the scanner could not see into; a wall is a near-VERTICAL band — long and thin in
plan, standing up rather than lying down.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import analyze_site as A
import agent


class G:
    """A 1 m grid with a step down the middle: flat at 0, flat at -1.5."""
    def __init__(self, rise=1.5):
        self.cell = 1.0
        self.x0, self.y1 = 0.0, 10.0
        self.rows = [[0.0 if c < 5 else -rise for c in range(10)] for _ in range(10)]


def test_a_step_in_the_ground_is_found():
    walls = A.find_walls(G())
    assert walls, "a 1.5 m step over one metre is not being read as a wall"
    w = walls[0]
    assert w["rise_m"] >= 1.4
    assert w["cell_xy"], "a wall must carry its own cells, not only a bounding box"


def test_a_natural_bank_is_NOT_a_wall():
    # this property's steepest natural ground is 27 deg (grade 0.51) and its zones
    # top out at "over 18 deg, leave it as slope". A hillside must not read as
    # masonry or the warning becomes noise on every sloped design.
    class Bank(G):
        def __init__(self):
            super().__init__()
            # 0.55 per metre: steep for a hillside, and ABOVE min_rise_m, so this
            # exercises the GRADE threshold rather than the rise one. At a 1 m cell
            # the two numbers are the same quantity, so a bank of 0.4 would be
            # rejected by min_rise_m on its own, leaving the grade threshold
            # untested and the test passing when it is mutated.
            self.rows = [[-0.55 * c for c in range(10)] for _ in range(10)]
    assert not A.find_walls(Bank()), "a 0.55 grade bank is being reported as a wall"


def test_a_single_steep_cell_is_not_a_wall():
    # a boulder, a scan artefact or the edge of a step
    class Blip(G):
        def __init__(self):
            super().__init__()
            self.rows = [[0.0] * 10 for _ in range(10)]
            self.rows[5][5] = -2.0
    assert not A.find_walls(Blip()), "one steep cell is being reported as a wall"


def _site_with_wall():
    return {"walls_detected": [{"cell_m": 1.0, "cell_xy": [[12.0, -6.0], [13.0, -6.0]],
                                "cells": 2, "rise_m": 1.9, "length_m": 1.0,
                                "bounds_m": {"x": [12.0, 13.0], "y": [-6.0, -6.0]}}]}


def test_a_bed_laid_on_a_wall_is_reported():
    d = {"version": 1, "units": "meters", "paths": [], "patios": [], "edges": [],
         "steps": [], "objects": [], "plants": [],
         "beds": [{"id": "b1", "polygon": [[12.0, -6.0], [14.0, -6.0], [14.0, -4.0],
                                           [12.0, -4.0]], "mulch": "bark"}]}
    errors, warnings = agent.validate(d, _site_with_wall())
    hit = [w for w in warnings if "retaining wall" in w]
    assert hit, "a bed whose outline sits on a detected wall goes unmentioned"
    assert "b1" in hit[0]


def test_it_is_a_warning_and_a_bed_BESIDE_a_wall_is_silent():
    # a retained bed legitimately abuts a wall -- that is what retaining is for --
    # and the detector reads a 1 m scan that is fragmentary near structures, so a
    # hard rejection would block correct designs on imperfect data.
    d = {"version": 1, "units": "meters", "paths": [], "patios": [], "edges": [],
         "steps": [], "objects": [], "plants": [],
         "beds": [{"id": "b2", "polygon": [[16.0, -6.0], [18.0, -6.0], [18.0, -4.0],
                                           [16.0, -4.0]], "mulch": "bark"}]}
    errors, warnings = agent.validate(d, _site_with_wall())
    assert not [e for e in errors if "retaining wall" in e], "it became a hard rejection"
    assert not [w for w in warnings if "retaining wall" in w], "a bed 3 m away is being flagged"
