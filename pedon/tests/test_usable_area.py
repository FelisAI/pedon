"""Usable ground is DERIVABLE from slope — with two traps that make it not free.

The question: "can't you tell from slope? less slope == usable area". Largely yes,
and `site_api usable-area` is that answer. It is not an entry in site.areas[]:
those are regions the owner DREW, and the rule that they are never
model-generated guards against inventing INTENT via a name (a vision pass can
label the south fence "back_fence" and send every design that trusts it into the
wrong part of the site).
A measurement names no intention and is re-derivable, so it cannot drift.

Trap 1: data/terrain.json is a BFS-filled grid that INVENTS flat ground past the
scan edge. Measured on this property, 46 cells read as gentle whose own height is
invented, against 16 that are real — so a naive slope<9 mask is nearly 3x phantom.

Trap 2, which this file exists to keep closed: ALSO requiring the four gradient
neighbours to be scanned erodes a region by one cell on every side, and this
property's gentle ground is a bench ONE TO TWO CELLS WIDE, so that strict rule
deletes real measured ground and reports 2 m2 where there are 16.
"""
import pytest
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import site_api as S


def test_outline_of_one_block_is_its_four_corners():
    loops = S._trace_outline({(0, 0), (1, 0), (0, 1), (1, 1)}, 1.0)
    assert len(loops) == 1
    import geom
    assert abs(abs(geom.polygon_area(loops[0])) - 4.0) < 1e-9


def test_disjoint_blocks_are_separate_regions():
    # a yard's usable ground is not one shape; reporting it as one bounding blob
    # would claim the slope between two benches
    loops = S._trace_outline({(0, 0), (5, 5)}, 1.0)
    assert len(loops) == 2


@pytest.mark.needs_site
def test_ground_whose_own_height_is_invented_is_excluded(monkeypatch):
    monkeypatch.setattr(S, "_cell_grade", lambda x, y, r=1.0: 1.0)   # everywhere flat
    monkeypatch.setattr(S, "scan_at", lambda x, y: None)             # nothing scanned
    out = S.cmd_usable_area(_args())
    assert out["usable_area_m2"] == 0, "phantom flat ground was reported as usable"
    assert out["excluded_gentle_but_unscanned_cells"] > 0


@pytest.mark.needs_site
def test_a_one_cell_wide_bench_survives(monkeypatch):
    """THE REGRESSION. A bench one cell wide has interpolated ground either side,
    so a rule that demands scanned neighbours erases exactly the feature being
    asked about."""
    monkeypatch.setattr(S, "_cell_grade", lambda x, y, r=1.0: 1.0)
    # only a ONE-CELL-WIDE band of x is real ground. Written as a band rather than
    # an exact coordinate so the test does not silently depend on whether cells are
    # sampled at their corners or their centres — pinning x == 15.0 when cells are
    # sampled at 15.5 fails for a reason that has nothing to do with the behaviour
    # under test.
    monkeypatch.setattr(S, "scan_at",
                        lambda x, y: -2.0 if 15.0 <= x < 16.0 else None)
    out = S.cmd_usable_area(_args())
    assert out["usable_area_m2"] > 0, \
        "a one-cell-wide bench was eroded to nothing by requiring scanned neighbours"
    assert out["kept_but_slope_from_filled_cells"] > 0, \
        "cells kept on a filled gradient must be COUNTED, not hidden"


def _args():
    class A:
        zone = "back_yard"
        box = "[10,-16,18,17]"
        max_slope = 9.0
        step = 1.0
    return A()
