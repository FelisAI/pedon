"""The same idea, implemented twice — across file boundaries.

Why this file exists
--------------------
A second transcription of a lookup is a defect waiting for its turn: copies of
the height-field indexing can all index the rows the wrong way round, which
produces a mirrored site and a confident, entirely wrong bug report.

tests/test_core_batch.py and tests/test_core_ground.py hold that line INSIDE
agent.py and site_api.py — those two files are collapsed onto one another. This
file watches the boundaries between the other files, which is where duplication
survives. The ideas it watches, and where a copy of each can appear:

  * the 1 m scan-grid lookup — agent.scan_at, analyze_site.Grid.at, and again
    in JavaScript as main.js scanHeight;
  * the ray-crossing test — agent.point_in_poly, replant.point_in_polygon, a
    nested `contains` inside geodata.overture_footprint that nothing can import,
    and areas.js pointInPolygon;
  * the shoelace — agent.poly_area, replant.polygon_area, areas.js polygonArea,
    and main.js polyArea, in a file that already imports areas.js's;
  * point-to-segment distance (agent, replant, areas.js);
  * the render-broker client (view_mcp, float_check, frame_check, analyze_site),
    whose copies drift;
  * agent.DEFAULT_CONSTRAINTS's retain limit, typed again in analyze_site.

Two shapes of test, and the difference is deliberate:

  * where copies AGREE, the test sweeps both and asserts they answer
    identically, so a divergence is caught the day it appears rather than by
    someone noticing a mirrored site;
  * where a copy is simply a copy, an AST/source count asserts the idea is
    written once, so a new copy fails the day it is written.

Nothing here touches the network or the viewer: the broker tests replace
urllib.request.urlopen, and the JavaScript is sliced out of the source and run
in node, the same trick tests/js/clean_scene.test.mjs uses on main.js (which
cannot be imported — it builds a WebGLRenderer at module scope).
"""
import argparse
import ast
import json
import math
import os
import re
import shutil
import subprocess
import urllib.error
import urllib.request

import pytest

import agent
import analyze_site
import float_check
import frame_check
import replant
import site_api
import view_mcp

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.join(ROOT, "tools")
VIEWER_SRC = os.path.join(ROOT, "viewer", "src")
HAVE_NODE = shutil.which("node") is not None


# ── comparing two implementations ─────────────────────────────────────────
def agree(name, cases, *impls, tol=1e-9):
    """Assert every implementation answers the same on every case.

    `impls` are (label, fn) pairs taking one case tuple. The first is the
    reference. A None from one side and a number from the other is a
    disagreement, not a near-miss: at the edge of the scan that is the
    difference between "measured" and "nobody looked", which is the whole
    reason the filled height field is distrusted.
    """
    ref_label, ref = impls[0]
    bad = []
    for case in cases:
        a = ref(case)
        for label, fn in impls[1:]:
            b = fn(case)
            if (a is None) != (b is None) or (a is not None and b is not None
                                              and not isinstance(a, bool)
                                              and abs(a - b) > tol):
                bad.append(f"{case}: {ref_label}={a!r} {label}={b!r}")
            elif isinstance(a, bool) and a != b:
                bad.append(f"{case}: {ref_label}={a!r} {label}={b!r}")
    assert not bad, (f"{name}: {len(bad)} of {len(cases)} cases disagree — "
                     f"two implementations of one idea have drifted\n  "
                     + "\n  ".join(bad[:8]))


def the_copy(mod, name):
    """The duplicate implementation, or a skip once it is gone.

    An equivalence test guards a duplicate that still exists. When someone
    finally collapses one, the comparison has nothing left to compare — and it
    must not then fail, because failing would punish the fix. The paired
    "written once" test above goes XPASS-strict at the same moment, which is
    the loud half: this skip never happens quietly on its own.
    """
    fn = getattr(mod, name, None)
    if fn is None:
        pytest.skip(f"{mod.__name__}.{name} is gone — collapsed onto agent's, "
                    f"nothing left to compare (the xfail counting this should now XPASS)")
    return fn


def test_the_comparison_harness_can_fail():
    """The guard on the guard. A test can be GREEN against a live bug — by
    skipping a group it cannot find, or emitting a weaker assertion when its data
    is missing — so a comparison that cannot go red is assumed broken until it is
    shown failing."""
    cases = [(1.0,), (2.0,), (3.0,)]
    agree("self", cases, ("a", lambda c: c[0]), ("b", lambda c: c[0]))
    with pytest.raises(AssertionError, match="disagree"):
        agree("self", cases, ("a", lambda c: c[0]), ("b", lambda c: c[0] + 0.5))
    with pytest.raises(AssertionError, match="disagree"):
        agree("self", cases, ("a", lambda c: c[0]), ("b", lambda c: None))


# ── running the viewer's JavaScript ───────────────────────────────────────
def js_source(rel):
    with open(os.path.join(VIEWER_SRC, rel)) as f:
        return f.read()


def js_slice(src, decl):
    """The text of one JS declaration, `function f(){}` or `const f = …;`.

    Asserts rather than returning nothing when the declaration is gone: a check
    that quietly skips what it cannot find is how a green suite ends up
    guarding an empty set.
    """
    i = src.find(decl)
    assert i >= 0, (f"{decl!r} is no longer in this file — the function this test "
                    f"compares against was renamed or removed, so the comparison "
                    f"was silently guarding nothing")
    if decl.lstrip().startswith(("function", "export function")):
        depth, opened = 0, src.index("{", i)
        for k in range(opened, len(src)):
            if src[k] == "{":
                depth += 1
            elif src[k] == "}":
                depth -= 1
                if depth == 0:
                    return src[i:k + 1].replace("export function", "function", 1)
        raise AssertionError(f"unbalanced braces after {decl!r}")
    par = brace = brack = 0
    for k in range(i, len(src)):
        c = src[k]
        par += (c == "(") - (c == ")")
        brace += (c == "{") - (c == "}")
        brack += (c == "[") - (c == "]")
        if c == ";" and par == brace == brack == 0:
            return src[i:k + 1].replace("export const", "const", 1)
    raise AssertionError(f"no statement end after {decl!r}")


def node_json(script):
    """Run an ES-module snippet and parse the one JSON line it prints. The snippet goes in on
    stdin: it can carry a whole scan grid, and Linux refuses one argument over 128 KB."""
    r = subprocess.run(["node", "--input-type=module"], input=script,
                       capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, f"node failed:\n{r.stderr[:2000]}"
    return json.loads(r.stdout)


def viewer_shoelaces():
    """Where the cross-product term of a shoelace sum is written in viewer/src."""
    cross = re.compile(r"\w+\s*\*\s*y2\s*-\s*x2\s*\*"
                       r"|\[0\]\s*\*\s*\w+\[1\]\s*-\s*\w+\[0\]\s*\*\s*\w+\[1\]")
    hits = []
    for name in sorted(os.listdir(VIEWER_SRC)):
        if not name.endswith(".js"):
            continue
        for i, line in enumerate(js_source(name).splitlines(), 1):
            if cross.search(line):
                hits.append(f"{name}:{i}")
    return hits


def test_the_javascript_extractor_cannot_silently_skip():
    src = js_source("areas.js")
    assert "polygonArea" in js_slice(src, "export function polygonArea")
    with pytest.raises(AssertionError, match="silently guarding nothing"):
        js_slice(src, "export function thisWasNeverHere")


# ── fixtures: a synthetic scan grid ───────────────────────────────────────
# Synthetic, not data/terrain_scan.json, so these tests state a fact about the
# code rather than about one property — and so a re-run of analyze_site.py
# cannot turn them red. The measured numbers from the real grid are quoted in
# the docstrings of the tests they belong to.
def plane_grid(dzdx=0.30, dzdy=-0.18, z0=2.0, n=21, cell=1.0, x0=-10.0, y1=10.0,
               holes=((7, 8), (7, 9), (8, 8), (14, 3), (3, 16))):
    """A tilted plane on a 1 m grid with a few unscanned cells.

    The holes are the point: an interpolating lookup must refuse to interpolate
    across the edge of coverage — inventing ground there is precisely what makes
    the 2 m filled field untrustworthy — so every implementation has a second,
    nearest-neighbour path, and that path is where they can disagree.
    """
    rows = []
    for r in range(n):
        row = []
        for c in range(n):
            x, y = x0 + c * cell, y1 - r * cell
            row.append(None if (r, c) in holes else round(dzdx * x + dzdy * y + z0, 6))
        rows.append(row)
    return {"rows": rows, "cell_m": cell, "x0": x0, "y1": y1}


@pytest.fixture
def synthetic_scan(monkeypatch):
    """Point every Python lookup at one synthetic grid, and switch the filled
    fallback off so a fallback answer cannot be mistaken for a scanned one.
    monkeypatch restores both: agent's caches are module globals and this file
    runs in the same process as the rest of the suite."""
    g = plane_grid()
    monkeypatch.setattr(agent, "_SCAN", g)
    monkeypatch.setattr(agent, "_TERRAIN", False)
    return g


def grid_points(g, offsets):
    """Query points across the grid at the given sub-cell offsets, plus a ring
    outside it — the fallback path only runs at the edge of coverage."""
    n, cell, x0, y1 = len(g["rows"]), g["cell_m"], g["x0"], g["y1"]
    out = []
    for i in range(-1, n + 1):
        for j in range(-1, n + 1):
            for dx in offsets:
                for dy in offsets:
                    out.append((round(x0 + (i + dx) * cell, 6),
                                round(y1 - (j + dy) * cell, 6)))
    return out


# ── 1. the scan-grid lookup, three implementations ────────────────────────
JS_SCAN = "function scanHeight"


def js_scan_heights(grid, pts):
    src = js_source("main.js")
    fn = js_slice(src, JS_SCAN)
    assert "Math.round" in fn and "t.rows" in fn, "scanHeight is not the lookup this test compares"
    return node_json(f"const scanGrid = {json.dumps(grid)};\n{fn}\n"
                     f"const pts = {json.dumps(pts)};\n"
                     f"console.log(JSON.stringify(pts.map(([x, y]) => scanHeight(x, y))));")


@pytest.mark.skipif(not HAVE_NODE, reason="node is needed to run the viewer's copy of the lookup")
def test_python_and_the_browser_read_the_scan_grid_the_same_way(synthetic_scan):
    """agent.scan_at and main.js scanHeight are the same function typed twice, in
    two languages. The browser draws the design with its copy and float_check
    judges the result through it; the validator sizes and rejects pads with the
    other. This sweeps everywhere except the exact half-cell tie, which the
    test below owns."""
    pts = grid_points(synthetic_scan, (0.0, 0.17, 0.31, 0.68, 0.83))
    js = js_scan_heights(synthetic_scan, pts)
    agree("scan lookup, python vs browser", list(zip(pts, js)),
          ("agent.scan_at", lambda c: agent.scan_at(*c[0])),
          ("main.js scanHeight", lambda c: c[1]))


@pytest.mark.skipif(not HAVE_NODE, reason="node is needed to run the viewer's copy of the lookup")
def test_python_and_the_browser_agree_on_the_half_cell_tie(synthetic_scan):
    """Measured on the real site rather than this fixture: with python's round(),
    of 9604 samples on the 0.5 m lattice agent._walk_line actually walks, 395
    disagree between agent.scan_at and main.js scanHeight — worst 1.66 m, and 281
    of them are one side saying "scanned" where the other says "nobody looked".
    Every one is an exact .5 tie taking the nearest-neighbour fallback, and
    floor(v + 0.5) drops all 395 to zero. 0.5 is not an exotic
    coordinate here: _walk_line samples every run at 0.5 m."""
    pts = grid_points(synthetic_scan, (0.5,))
    js = js_scan_heights(synthetic_scan, pts)
    agree("scan lookup at a half-cell tie", list(zip(pts, js)),
          ("agent.scan_at", lambda c: agent.scan_at(*c[0])),
          ("main.js scanHeight", lambda c: c[1]))


def test_analyze_site_and_agent_index_the_scan_grid_the_same_way(synthetic_scan):
    """analyze_site.Grid.at is the third copy of the indexing. It is
    nearest-neighbour where agent.scan_at is bilinear, so the two are only
    required to agree AT the grid nodes — but that is the comparison that
    matters, because a row indexed the wrong way round mirrors the yard and is
    invisible everywhere except in the answer."""
    g = analyze_site.Grid(synthetic_scan)
    n, cell, x0, y1 = len(synthetic_scan["rows"]), synthetic_scan["cell_m"], \
        synthetic_scan["x0"], synthetic_scan["y1"]
    nodes = [(x0 + c * cell, y1 - r * cell) for r in range(n) for c in range(n)]
    agree("scan grid at its own nodes", nodes,
          ("agent.scan_at", lambda p: agent.scan_at(*p)),
          ("analyze_site.Grid.at", lambda p: g.at(*p)))
    # and the holes: both must say "nobody looked" in the same places
    unscanned = [p for p in nodes if agent.scan_at(*p) is None]
    assert len(unscanned) == 5, f"fixture holes moved: {len(unscanned)} unscanned nodes"


# ── 2. polygon geometry ───────────────────────────────────────────────────
# Deliberately awkward polygons. A ray-crossing test typed a second time is
# usually right in the middle of a shape and wrong on its boundary, so the
# probes hit vertices, horizontal edges and both windings.
POLYS = [
    [(0.0, 0.0), (4.0, 0.0), (4.0, 3.0), (0.0, 3.0)],                     # horizontal edges
    [(0.0, 0.0), (6.0, 0.0), (6.0, 2.0), (3.0, 2.0), (3.0, 5.0), (0.0, 5.0)],  # L, non-convex
    [(0.0, 0.0), (5.0, 1.0), (2.0, 4.0)],                                 # triangle
    [(3.0, 3.0), (3.0, 0.0), (0.0, 0.0), (0.0, 3.0)],                     # clockwise
]


def poly_probes(poly):
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    pts = [(x / 4, y / 4) for x in range(-4, 28) for y in range(-4, 24)]
    pts += [tuple(v) for v in poly]                      # the vertices themselves
    pts += [(x / 4, v[1]) for v in poly for x in range(-4, 28)]   # sweep along each edge's y
    pts += [(v[0], y / 4) for v in poly for y in range(-4, 24)]
    pts += [(min(xs) - 1, y / 4) for y in range(-4, 24)]
    pts += [(max(xs) + 1, y / 4) for y in range(-4, 24)]
    pts += [(x / 4, min(ys) - 1) for x in range(-4, 28)]
    return pts


def test_replant_and_the_validator_agree_on_point_in_polygon():
    """agent.point_in_poly and replant.point_in_polygon are the same ray-crossing
    test typed twice. They decide different things — one whether an op is inside
    the area the owner drew, the other which bed a plant belongs to — so a
    divergence would move plants across a boundary the validator still enforces."""
    pip = the_copy(replant, "point_in_polygon")
    for poly in POLYS:
        agree(f"point-in-polygon on {poly[:2]}…", poly_probes(poly),
              ("agent.point_in_poly", lambda p, q=poly: agent.point_in_poly(p, q)),
              ("replant.point_in_polygon", lambda p, q=poly: pip(p[0], p[1], q)))


def test_replant_and_the_validator_agree_on_polygon_area():
    """The shoelace, typed twice. replant reports bed areas the model reads back;
    agent.poly_area is what set_patio records as the reserved flat ground."""
    agree("shoelace", POLYS,
          ("agent.poly_area", agent.poly_area),
          ("replant.polygon_area", the_copy(replant, "polygon_area")))


def test_replant_and_the_validator_agree_on_distance_to_a_segment():
    """Third copy of the same idea: replant.seg_dist keeps plants off the paths,
    agent._point_to_polyline_m enforces the setback behind a wall. Both measure
    to the SEGMENTS — the nearest part of a run is usually mid-segment — and both
    have their own epsilon for a degenerate segment."""
    cases = []
    for i in range(-6, 7):
        for j in range(-6, 7):
            cases.append((i * 1.7, j * 1.3, -4.0, -3.0, 5.0, 2.0))
            cases.append((i * 0.9, j * 0.9, 2.0, 2.0, 2.0, 2.0))       # degenerate
            cases.append((i * 1.1, j * 1.1, -3.0, 4.0, 6.0, 4.0))      # horizontal
    agree("point to segment", cases,
          ("agent._point_to_polyline_m",
           lambda c: agent._point_to_polyline_m((c[0], c[1]), [(c[2], c[3]), (c[4], c[5])])),
          ("replant.seg_dist", lambda c, f=the_copy(replant, "seg_dist"): f(*c)),
          tol=1e-7)


@pytest.mark.skipif(not HAVE_NODE, reason="node is needed to run the viewer's copies")
def test_the_browser_and_the_validator_agree_on_polygon_geometry():
    """viewer/src/areas.js holds its own ray-crossing test, shoelace and
    point-to-segment distance, and a shoelace in main.js beside its import of
    areas.js's is one more copy. The browser's copies decide what the owner
    drew — the lasso rejects a shape under 0.5 m2 and simplifies it — and the
    python copies then judge designs against that stored outline."""
    areas, main = js_source("areas.js"), js_source("main.js")
    parts = [js_slice(areas, "export function pointInPolygon"),
             js_slice(areas, "export function polygonArea"),
             js_slice(areas, "function segDist")]
    # main.js's own shoelace is the one that should not exist. Compare it while
    # it does, and stand down cleanly the day it is deleted — the xfail counting
    # viewer shoelaces goes XPASS-strict at that moment, so nothing goes quiet.
    duplicate_shoelace = "const polyArea =" in main
    parts.append(js_slice(main, "const polyArea =") if duplicate_shoelace
                 else "const polyArea = polygonArea;")
    fns = "\n".join(parts)
    polys = [[list(p) for p in poly] for poly in POLYS]
    probes = [list(p) for p in poly_probes(POLYS[1])]
    segs = [[i * 1.7, j * 1.3, -4.0, -3.0, 5.0, 2.0] for i in range(-6, 7) for j in range(-6, 7)]
    out = node_json(
        f"{fns}\nconst polys={json.dumps(polys)}, probes={json.dumps(probes)}, "
        f"segs={json.dumps(segs)};\nconsole.log(JSON.stringify({{"
        f"inside: polys.map(p => probes.map(([x, y]) => pointInPolygon(x, y, p))),"
        f"area: polys.map(polygonArea), areaMain: polys.map(polyArea),"
        f"seg: segs.map(([px,py,ax,ay,bx,by]) => segDist([px,py],[ax,ay],[bx,by]))}}));")

    for poly, col in zip(POLYS, out["inside"]):
        agree(f"point-in-polygon, browser vs validator, {poly[:2]}…", list(zip(probes, col)),
              ("agent.point_in_poly", lambda c, q=poly: agent.point_in_poly(tuple(c[0]), q)),
              ("areas.js pointInPolygon", lambda c: c[1]))
    shoelaces = [("agent.poly_area", lambda c: agent.poly_area(c[0])),
                 ("areas.js polygonArea", lambda c: c[1])]
    if duplicate_shoelace:
        shoelaces.append(("main.js polyArea", lambda c: c[2]))
    # every shoelace in viewer/src must be in this comparison; agent's is the extra one
    assert len(shoelaces) - 1 == len(viewer_shoelaces()), \
        f"viewer/src holds {viewer_shoelaces()} but this compares {len(shoelaces) - 1} of them"
    agree("shoelace, browser vs validator", list(zip(POLYS, out["area"], out["areaMain"])), *shoelaces)
    agree("point to segment, browser vs validator", list(zip(segs, out["seg"])),
          ("agent._point_to_polyline_m",
           lambda c: agent._point_to_polyline_m((c[0][0], c[0][1]),
                                                [(c[0][2], c[0][3]), (c[0][4], c[0][5])])),
          ("areas.js segDist", lambda c: c[1]), tol=1e-7)


# ── 3. one definition, or several ─────────────────────────────────────────
def python_functions_containing(fragment, want_source=False):
    """Every function in tools/ that WRITES `fragment`, as file:name.

    Innermost only: a copy of the ray-crossing test hides inside
    geodata.overture_footprint as a nested `contains`, and counting the enclosing
    function as well would report one duplicate as two.
    """
    out = []
    for name in sorted(os.listdir(TOOLS)):
        if not name.endswith(".py"):
            continue
        with open(os.path.join(TOOLS, name)) as f:
            src = f.read()
        try:
            tree = ast.parse(src)
        except SyntaxError:            # blender scripts target another interpreter
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.FunctionDef) or fragment not in ast.unparse(node):
                continue
            if any(isinstance(k, ast.FunctionDef) and k is not node and fragment in ast.unparse(k)
                   for k in ast.walk(node)):
                continue                # an outer function that merely holds the copy
            out.append((f"{name}:{node.name}", ast.get_source_segment(src, node))
                       if want_source else f"{name}:{node.name}")
    return out


def test_the_ray_crossing_test_is_written_once_in_tools():
    """test_core_batch.py asserts this over agent.py and site_api.py only, so a
    copy in any other tool — replant.py, geodata.py — needs this check. The
    geodata one is the least visible and not the least important: it is nested
    inside overture_footprint and it decides WHICH downloaded footprint is this
    house."""
    impls = python_functions_containing("!= (y2 >")
    assert impls == ["geom.py:point_in_polygon"], f"ray-crossing test written {len(impls)} times: {impls}"


def test_geodatas_hidden_copy_agrees_with_the_validator():
    """geodata.contains is nested inside a function, so nothing can import it or
    check it directly. Lift it out with the AST and sweep it against the
    one in agent. It runs on lon/lat rings rather than metres, which changes
    nothing about the algorithm and everything about how visible a mistake in it
    would be — a footprint picked from the wrong ring is a house-shaped hole in
    the wrong place, and site.json keeps it."""
    found = [(n, src) for n, src in python_functions_containing("!= (y2 >", want_source=True)
             if n.startswith("geodata.py:")]
    if not found:
        pytest.skip("geodata's copy is gone — collapsed onto agent.point_in_poly "
                    "(the xfail counting ray-crossing tests should now XPASS)")
    assert len(found) == 1, f"geodata now holds {len(found)} copies: {found}"
    name, src = found[0]
    ns = {}
    exec(src, ns)                              # noqa: S102 — lifting a nested def out to test it
    contains = ns[name.split(":")[1]]          # by its own name, so a rename is still checked
    for poly in POLYS:
        ring = [[x, y] for x, y in poly]       # geodata rings are [[lon, lat], …]
        agree(f"ray crossing, geodata vs validator, {poly[:2]}…", poly_probes(poly),
              ("agent.point_in_poly", lambda p, q=poly: agent.point_in_poly(p, q)),
              ("geodata.contains", lambda p, r=ring: contains(r, p[0], p[1])))


def test_the_shoelace_is_written_once_in_tools():
    impls = python_functions_containing("x1 * y2 - x2 * y1")
    assert impls == ["geom.py:polygon_area"], f"shoelace written {len(impls)} times: {impls}"


def test_the_shoelace_is_written_once_in_the_viewer():
    """A duplicate in the same program as its original is the cheapest kind to
    collapse and the easiest to miss: both are correct today, so nothing fails
    until someone fixes a rounding or an empty-polygon case in one of them."""
    hits = viewer_shoelaces()
    assert hits == ["areas.js:48"], f"shoelace written {len(hits)} times in viewer/src: {hits}"


# ── 4. the render broker client, four times ───────────────────────────────
BROKER_CALLS = [
    ("float_check.run", lambda: float_check.run(0.4, 5)),
    ("frame_check.run", lambda: frame_check.run(0.7)),
    ("view_mcp._post", lambda: view_mcp._post("/api/view/request", {"subject": "x"})),
    ("analyze_site.fetch_scan_grid", lambda: analyze_site.fetch_scan_grid(1.0, 26.0)),
]


@pytest.fixture
def broker(monkeypatch):
    """Capture what each client would send. Nothing leaves the process — the
    human's viewer tab is the only one there is, and a test must never post to
    it."""
    sent = []

    class Reply:
        def __init__(self, body):
            self.body = body

        def read(self):
            return self.body

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake(req, timeout=None):
        sent.append({"url": req.full_url, "method": req.get_method(),
                     "headers": {k.lower(): v for k, v in req.header_items()},
                     "body": json.loads(req.data) if req.data else None})
        return Reply(json.dumps({"ok": True, "data": {
            "rows": [[1.0]], "cell_m": 1.0, "x0": 0, "y1": 0,
            "scanned_cells": 1, "total_cells": 1}}).encode())

    monkeypatch.setattr(urllib.request, "urlopen", fake)
    return sent


def test_every_broker_client_sends_the_same_request(broker):
    """Four copies of "POST the render broker" exist: view_mcp._post,
    float_check.run, frame_check.run, analyze_site.fetch_scan_grid. The dev
    server answers 403 "bad origin" to a request without an Origin header
    (vite.config.js), so a copy that forgets one fails in a way that reads like
    the viewer being down. Timeouts are allowed to differ — a full raycast is
    not a float check — but the endpoint and headers are not."""
    for _, call in BROKER_CALLS:
        call()
    assert len(broker) == len(BROKER_CALLS)
    shape = {(r["url"], r["method"], r["headers"].get("content-type"),
              r["headers"].get("origin")) for r in broker}
    assert len(shape) == 1, f"the four broker clients no longer agree on the request: {shape}"
    url, method, ctype, origin = shape.pop()
    assert method == "POST" and url.endswith("/api/view/request")
    assert ctype == "application/json"
    assert origin and url.startswith(origin), "Origin must be the viewer's own, or the broker returns 403"


def test_every_broker_client_points_at_the_same_viewer():
    """One default, four modules. A copy left on another port answers "not
    reachable" while the viewer is running perfectly."""
    assert {m.VIEWER for m in (float_check, frame_check, view_mcp, analyze_site)} == \
        {os.environ.get("YARDTWIN_VIEWER", "http://localhost:5178")}


@pytest.mark.parametrize("label,call", [
    BROKER_CALLS[0], BROKER_CALLS[1],
    BROKER_CALLS[3],   # the first command run on a new site: it must catch URLError too
])
def test_a_broker_client_says_how_to_start_the_viewer_when_it_is_down(monkeypatch, label, call):
    """Same failure, one response to it: hand-written responses drift, and a
    copy that does not catch URLError prints a raw traceback instead."""
    def refused(req, timeout=None):
        raise urllib.error.URLError("Connection refused")
    monkeypatch.setattr(urllib.request, "urlopen", refused)
    with pytest.raises(SystemExit) as e:
        call()
    msg = str(e.value)
    assert "npm run dev" in msg, f"{label} does not say how to start the viewer: {msg!r}"
    assert view_mcp.VIEWER in msg, f"{label} does not say which viewer it tried: {msg!r}"


def test_the_mcp_tool_answers_in_text_rather_than_exiting(monkeypatch):
    """view_mcp is the one copy that must NOT raise: an MCP tool that exits takes
    the design agent's whole look capability with it, so it answers the model in
    words instead. Different contract, same underlying request — which is why the
    shared thing to collapse is the request, not the error handling."""
    def refused(req, timeout=None):
        raise urllib.error.URLError("Connection refused")
    monkeypatch.setattr(urllib.request, "urlopen", refused)
    out = view_mcp.do_look({"subject": "dining_terrace"})
    text = out["content"][0]["text"]
    assert "npm run dev" in text and view_mcp.VIEWER in text


# ── 5. the limits, and the grade bands ────────────────────────────────────
def test_analyze_site_pad_widths_follow_site_constraints():
    """The pad widths analyze_site writes into site.zones follow site.constraints —
    the one place every other tool takes them from. Module constants
    (RETAIN_LIMIT_M = 1.2, COMFORTABLE_M = 0.6) would quote widths computed for 1.2
    on a site that sets retain_limit_m to 0.9.

    Behavioural, not name-matching: there are no constants to compare for
    equality. What matters is that the OUTPUT moves when the
    site says a different limit."""
    # a synthetic 8x8 m slope, steep enough that a pad width is quoted at all
    cells = [(x * 1.0, y * 1.0, y * 0.25) for x in range(8) for y in range(8)]
    rows = [[y * 0.25 for _x in range(8)] for y in range(7, -1, -1)]
    grid = analyze_site.Grid({"cell_m": 1, "x0": 0, "x1": 7, "y0": 0, "y1": 7,
                              "rows": rows, "scanned_cells": 64, "total_cells": 64})
    wide = analyze_site.summarise_zone("z", cells, grid,
                                       {"constraints": {"retain_limit_m": 1.2,
                                                        "footing_threshold_m": 0.6}})
    tight = analyze_site.summarise_zone("z", cells, grid,
                                        {"constraints": {"retain_limit_m": 0.9,
                                                         "footing_threshold_m": 0.45}})
    if "max_level_pad_width_m" not in wide:
        pytest.skip("this synthetic zone is too flat to quote a pad width")
    assert wide["max_level_pad_width_m"] > tight["max_level_pad_width_m"], (
        "a tighter retaining limit must give a narrower level pad; analyze_site "
        "is not reading site.constraints")


def test_the_limits_have_one_home():
    """test_core_constraints.py holds this line for agent.py and site_api.py:
    every limit is site data, quoted from site.constraints. This extends it to
    every other tool, analyze_site included — the tool that WRITES site.json."""
    # Name AND value, not value alone: sun.py's DEFAULT_ALBEDO is 0.2 and
    # agent's max_grade is 0.20, and a test that called those the same number
    # would be crying wolf about ground reflectance — which is how a check gets
    # deleted instead of obeyed.
    values = set(agent.DEFAULT_CONSTRAINTS.values())
    reads_as_a_limit = re.compile(r"LIMIT|THRESHOLD|RETAIN|FOOTING|GRADE|RISER|GOING|"
                                  r"SETBACK|COMFORT|LEVEL|WALK|STEP", re.I)
    copies = []
    for name in sorted(os.listdir(TOOLS)):
        if not name.endswith(".py") or name == "agent.py":
            continue
        with open(os.path.join(TOOLS, name)) as f:
            try:
                tree = ast.parse(f.read())
            except SyntaxError:
                continue
        for node in tree.body:
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant) \
                    and isinstance(node.value.value, float) and node.value.value in values:
                for t in node.targets:
                    if isinstance(t, ast.Name) and reads_as_a_limit.search(t.id):
                        copies.append(f"{name}:{t.id} = {node.value.value}")
    assert copies == [], f"limits typed a second time outside agent.DEFAULT_CONSTRAINTS: {copies}"


def zone_of(grid, half=6):
    """A square of cells around the origin, in analyze_site's (x, y, h) form."""
    g = analyze_site.Grid(grid)
    cells = [(x * 1.0, y * 1.0, g.at(x, y))
             for x in range(-half, half + 1) for y in range(-half, half + 1)]
    return g, [c for c in cells if c[2] is not None]


def test_analyze_site_and_site_api_measure_the_same_slope(monkeypatch):
    """Two central-difference gradients, in two files, both reporting slope_deg
    and a downhill bearing the design agent then reasons about. A swapped dx/dy
    or a flipped sign is invisible in either one alone."""
    g = plane_grid(dzdx=0.30, dzdy=-0.18, holes=())
    monkeypatch.setattr(agent, "_SCAN", g)
    monkeypatch.setattr(agent, "_TERRAIN", False)
    grid = analyze_site.Grid(g)
    pts = [(0.0, 0.0), (3.0, -2.0), (-4.0, 5.0), (6.0, 6.0), (-7.0, -7.0)]
    agree("slope in degrees", pts,
          ("site_api.cmd_slope",
           lambda p: site_api.cmd_slope(argparse.Namespace(x=p[0], y=p[1], radius=1.0))["slope_deg"]),
          ("analyze_site.Grid.slope_at", lambda p: round(grid.slope_at(*p)[0], 1)),
          tol=0.05)
    # The magnitude alone is NOT enough: hypot(dx, dy) is symmetric, so a copy
    # that swapped its two gradients answers the same degrees and points the
    # water the wrong way: swapping dx and dy in Grid.slope_at leaves the
    # degrees comparison above green. Compare the direction as well.
    def bearing_from(dx, dy):
        return round((math.degrees(math.atan2(-dx, -dy)) + 360) % 360)

    agree("downhill bearing", pts,
          ("site_api.cmd_slope",
           lambda p: site_api.cmd_slope(argparse.Namespace(x=p[0], y=p[1],
                                                           radius=1.0))["downhill_bearing_deg"]),
          ("analyze_site.Grid.slope_at", lambda p: bearing_from(*grid.slope_at(*p)[1:])),
          tol=0.51)
    # the bearing too: analyze_site fits a plane over the whole zone, site_api
    # differences one point, and on a plane they must land on the same compass
    _, cells = zone_of(g)
    z = analyze_site.summarise_zone("test", cells, grid)
    one = site_api.cmd_slope(argparse.Namespace(x=0.0, y=0.0, radius=1.0))
    assert z["downhill_bearing_deg"] == one["downhill_bearing_deg"]
    assert z["contour_bearing_deg"] == one["contour_bearing_deg"]


@pytest.mark.parametrize("deg,band", [(4.0, "flat"), (8.9, "flat"), (9.1, "moderate"),
                                      (17.9, "moderate"), (18.1, "steep")])
def test_the_grade_bands_are_the_same_in_both_tools(monkeypatch, deg, band):
    """"flat under 9, moderate to 18, steep above" is written in site_api.cmd_slope,
    again in site_api.cmd_area, and again in analyze_site.summarise_zone — and the
    third one is what lands in site.zones, which is what the design agent reads
    before it has asked a single question. A boundary moved in one place would
    silently re-classify the ground the model is told to build on."""
    g = plane_grid(dzdx=math.tan(math.radians(deg)), dzdy=0.0, holes=())
    monkeypatch.setattr(agent, "_SCAN", g)
    monkeypatch.setattr(agent, "_TERRAIN", False)
    grid, cells = zone_of(g)
    z = analyze_site.summarise_zone("test", cells, grid)
    breakdown = z["grade_breakdown_m2"]
    key = {"flat": "flat_under_9deg", "moderate": "moderate_9_18", "steep": "steep_over_18"}[band]
    assert breakdown[key] == max(breakdown.values()) and breakdown[key] > 0, \
        f"analyze_site put a {deg} deg plane in {breakdown}"
    one = site_api.cmd_slope(argparse.Namespace(x=0.0, y=0.0, radius=1.0))
    assert one["band"] == band, f"site_api calls a {deg} deg plane {one['band']}"


def test_the_alternative_resolution_has_exactly_one_home_per_language():
    """Two proposals for one corner, resolved in ONE place each.

    This is the shape this file exists for: the rule lives in
    `tools/alternatives.py` and `viewer/src/design_doc.js`, and a second copy
    would be worse than the four ray-crossing tests — a resolver that drifted
    would draw the user one garden while the validator measured another, with both
    halves internally consistent and nothing reporting an error.

    Searched for the DECISION, not the word: whether an object belongs to a
    proposal that is not the live one.
    """
    import re
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    offenders = []
    for sub, ext in (("tools", ".py"), (os.path.join("viewer", "src"), ".js")):
        base = os.path.join(root, sub)
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d != "node_modules"]
            for fn in filenames:
                if not fn.endswith(ext):
                    continue
                full = os.path.join(dirpath, fn)
                src = open(full, encoding="utf8", errors="ignore").read()
                # the home of each language is allowed to hold it
                if fn in ("alternatives.py", "design_doc.js"):
                    continue
                # a file that IMPORTS the resolver is fine; one that re-derives
                # the membership test is not
                if re.search(r"alt_of", src) and not re.search(
                        r"import alternatives|from \"\./design_doc\.js\"|"
                        r"from \"\.\./design_doc\.js\"|design_doc\.js", src):
                    offenders.append(os.path.relpath(full, root))
    assert not offenders, (
        "these files reason about `alt_of` themselves instead of calling the one "
        f"resolver: {offenders}")
