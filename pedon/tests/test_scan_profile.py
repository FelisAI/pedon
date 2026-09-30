"""The scan along a line, every few centimetres — `scan_profile`.

A question like how short a French drain can be if it goes UNDER one railroad tie
and comes to daylight above the next needs the mesh itself. Every other ground tool
in the project reads a 1 m raycast grid, and `profile` along a side yard returns a
smooth 17% ramp with no ties in it at all. The mesh has them: five, 1.8 m apart,
faces of 0.12-0.23 m.

The raycast happens in the browser, so what is tested here is the half that can be:
the step finder, on ground shaped like the real thing, and the seams between the
tool, the viewer op and the lists that offer it.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import view_mcp  # noqa: E402


def staircase(step=0.05, grade=0.05, ties=((3.0, 0.20), (6.0, 0.15))):
    """A side yard: a gentle ramp with a timber riser at each `ties` distance."""
    pts = []
    for i in range(int(9 / step)):
        d = round(i * step, 3)
        z = 2.5 - grade * d - sum(h for at, h in ties if d > at)
        pts.append({"d": d, "x": d, "y": 0.0, "z": round(z, 3), "top": round(z, 3)})
    return pts


def test_it_finds_each_tie_where_it_is_and_how_tall():
    steps = view_mcp.find_steps(staircase())
    assert [round(s["at_m"], 1) for s in steps] == [3.0, 6.0], steps
    # the face is the tie PLUS the ramp's own fall across the window, within 3 cm
    assert abs(steps[0]["change_m"] + 0.20) < 0.03 and abs(steps[1]["change_m"] + 0.15) < 0.03, steps
    assert steps[0]["from_m"] > steps[0]["to_m"]


def test_a_steady_bank_is_not_a_staircase():
    """The yard's own 20% slope falls 5 cm per 0.25 m. If that counted, every
    profile on this property would be nothing but steps and the word would mean
    nothing — which is the failure a threshold picked too low produces."""
    bank = [{"d": i * 0.05, "x": 0, "y": 0, "z": 2.0 - 0.20 * i * 0.05} for i in range(200)]
    assert view_mcp.find_steps(bank) == []


def test_a_hole_in_the_scan_is_not_a_step_and_does_not_hide_one():
    pts = staircase()
    for p in pts:
        if 1.0 < p["d"] < 1.5:
            p["z"] = None                  # the scan has holes; the real line had one
    assert [round(s["at_m"], 1) for s in view_mcp.find_steps(pts)] == [3.0, 6.0]


def test_a_rise_is_reported_as_a_rise():
    up = [{"d": p["d"], "x": p["x"], "y": 0, "z": 5 - p["z"]} for p in staircase(grade=0.0)]
    steps = view_mcp.find_steps(up)
    assert len(steps) == 2 and all(s["change_m"] > 0 for s in steps), steps


def test_the_tool_is_offered_and_wired_end_to_end():
    names = {t["name"] for t in view_mcp.TOOLS} if hasattr(view_mcp, "TOOLS") else set()
    src = open(os.path.join(ROOT, "tools", "view_mcp.py")).read()
    assert '"name": "scan_profile"' in src and '"scan_profile": do_scan_profile' in src
    assert not names or "scan_profile" in names
    # the description has to say WHEN, in the asker's terms, or it is never reached for
    desc = re.search(r'"name": "scan_profile",\s*"description": \((.*?)\),\s*"inputSchema"', src, re.S).group(1)
    assert "railroad tie" in desc and "1 m grid" in desc
    # and the viewer has to answer the op the tool posts
    assert '{"op": "scan_profile"' in src
    vp = open(os.path.join(ROOT, "viewer", "src", "viewport.js")).read()
    assert 'cmd.op === "scan_profile" ? scanProfileOp(cmd, full)' in vp
    assert re.search(r'NON_DRAWING = new Set\(\[[^\]]*"scan_profile"', vp), \
        "a raycast must still work on a lost WebGL context, as scan_grid does"
