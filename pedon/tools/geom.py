"""The plane-geometry primitives, written ONCE.

This module exists because small pieces of geometry, transcribed instead of
imported, drift apart. A copied height-field lookup can index the rows the wrong
way round, mirroring the whole yard and producing a confident, entirely wrong bug
report; a ray-crossing test or a shoelace written again in each tool that needs
one (the validator, the footprint fetcher, the planting helpers) is the same risk.

A leaf module rather than putting these in agent.py: geodata.py is a data-fetching
script and should not have to import the design engine to ask whether a point is
inside a ring.

Coordinate-system agnostic — these are pure plane maths, so ENU metres and
lon/lat rings both work. Callers are responsible for not mixing frames.
"""
from __future__ import annotations


def point_in_polygon(px, py, poly):
    """Ray-crossing (even-odd) test. Points exactly on an edge are undefined,
    which is fine for every caller here: nothing places geometry on a boundary
    to the micron, and the alternative is an epsilon that has to be tuned per
    coordinate system (metres vs degrees differ by ~10^5)."""
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i][0], poly[i][1]
        x2, y2 = poly[(i + 1) % n][0], poly[(i + 1) % n][1]
        if (y1 > py) != (y2 > py):
            if px < (x2 - x1) * (py - y1) / (y2 - y1) + x1:
                inside = not inside
    return inside


def polygon_area(poly):
    """Shoelace. Absolute, so winding order does not matter to callers."""
    a = 0.0
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i][0], poly[i][1]
        x2, y2 = poly[(i + 1) % n][0], poly[(i + 1) % n][1]
        a += x1 * y2 - x2 * y1
    return abs(a) / 2
