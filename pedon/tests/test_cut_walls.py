"""A wall holds its surface at its top (fill) OR at its foot (cut).

A terrace sunk 0.29 m into the slope can have stones set along the cut. An
orphan-wall rule that knows only fill walls calls those cut stones "a wall holding
nothing" — while the rule's real job, catching a wall whose bench was rejected,
must still fire.
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import agent  # noqa: E402

TERRACE = [[14.6, -5.2], [15.3, -4.6], [16.5, -4.7], [17.0, -5.8], [16.9, -7.6],
           [16.2, -8.9], [15.1, -9.0], [14.4, -8.2], [14.0, -6.6], [14.2, -5.7]]
CUT = [[14.75, -5.0], [14.22, -5.66], [13.97, -6.6], [14.35, -8.25], [15.08, -9.08]]


def design(patio_level, edge_level, height):
    return {"version": 1, "units": "meters", "beds": [], "paths": [], "plants": [], "steps": [],
            "objects": [],
            "patios": [] if patio_level is None else [
                {"id": "t", "polygon": TERRACE, "material": "decomposed_granite", "level_m": patio_level}],
            "edges": [{"id": "stones", "spline": CUT, "height_m": height, "level_m": edge_level,
                       "material": "boulder", "retains": "uphill"}]}


def orphan(d):
    _, warnings = agent.validate(d, {})
    return [w for w in warnings if "holds nothing" in w]


def test_a_cut_wall_holds_the_terrace_at_its_foot():
    assert orphan(design(-1.97, -1.68, 0.29)) == []


def test_a_fill_wall_holds_the_bench_at_its_top():
    assert orphan(design(-1.68, -1.68, 0.29)) == []


def test_a_wall_whose_terrace_is_gone_still_holds_nothing():
    got = orphan(design(None, -1.68, 0.29))
    assert got and "at its foot (-1.97 m" in got[0]
    assert orphan(design(-2.40, -1.68, 0.29)), "a terrace at neither the top nor the foot was accepted"
