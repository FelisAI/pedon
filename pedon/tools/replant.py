"""Point and segment geometry for placing plants.

Nothing here arranges plants. Arrangement is agent driven, not hardcoded Python
rules: re-placing a design's plants by rule (grading tall to the back, drifts along
a bed's long axis, specimens off-centre) would keep the model's species and counts
and throw its coordinates away, so where a plant goes is the design agent's call.

There is no spacing formula either. How close plants stand is the designer's
decision; hardcoded code checks only for absolute mistakes — the validator refuses
two plants in one hole or a plant in a tree's trunk (agent.PLANTING_HOLE_M /
TRUNK_M, agent.one_hole) — and site_api.planting_character MEASURES the rest.

What it holds: the small point/segment helpers compose.py uses (tests/test_dry.py
holds them in agreement with the validator's copies).
"""
from __future__ import annotations
from geom import point_in_polygon, polygon_area   # noqa: F401  re-exported: ONE implementation, tools/geom.py
import math
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def closest_on_segment(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    L = vx * vx + vy * vy
    t = 0.0 if L == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / L))
    return ax + vx * t, ay + vy * t


def seg_dist(px, py, ax, ay, bx, by):
    qx, qy = closest_on_segment(px, py, ax, ay, bx, by)
    return math.hypot(px - qx, py - qy)


def dist_to_edge(px, py, poly):
    return min(seg_dist(px, py, *poly[i], *poly[(i + 1) % len(poly)])
               for i in range(len(poly)))
