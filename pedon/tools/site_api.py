"""Read-only site queries for the design agent — measured answers about the ground.

Why this exists
---------------
The design agent needs measured answers beyond the facts pre-computed into its
prompt. Estimating from a 2 m ASCII grid can miss the relief that determines
whether a design is buildable:

  * pads and terraces can need 1.4-2.9 m of cut when the level is guessed
    from the grid
  * a bench at constant x on ground falling ENE can drop 1.1 m along its
    own length, even if it is narrow
  * a wall declared 0.7 m can stand 2.59 m where the ground dips between
    two spline points

Pre-computing landmark heights, zone bounds, contour bearing, max pad width and
heights inside the gentlest pocket cannot anticipate every ground question.

This makes the site ASKABLE. Every command prints one JSON object to stdout. The
exit code says which kind of object it is: 0 answered, 1 broken ({"error": ...}),
2 REFUSED ({"no_scan": true, ...}) because this property has never been raycast —
the same three-way split tools/sun.py uses for its north gate, and the reason is
the same, that a refusal exiting 0 is indistinguishable from an answer to
anything reading $?. The CLI is callable from subscription CLIs through a shell
without an API key, server or additional protocol.

    python tools/site_api.py ground 15 -6
    python tools/site_api.py slope 15 -6
    python tools/site_api.py ground-many '[[15,-6],[16,-6],[17,-6]]'
    python tools/site_api.py slope-many  '[[15,-6],[16,-6],[17,-6]]'
    python tools/site_api.py profile 13 -14 13 10
    python tools/site_api.py check-pad '[[14,-8],[18,-8],[18,-3],[14,-3]]' --level -2.1
    python tools/site_api.py check-route '[[11,-12],[13,-4],[15,4]]' --width 1.2
    python tools/site_api.py best-bench 13 -12 18 2 --across 4
    python tools/site_api.py near 15 -6 --radius 3
    python tools/site_api.py constraints
    python tools/site_api.py validate

Ground truth comes from data/terrain_scan.json — a 1 m raycast of the actual
scan mesh — and falls back to the 2 m BFS-filled height field only where the
raycast never saw ground. That distinction matters: the filled field invents
flat ground beyond the scan edge: a pad can appear to need only 0.05 m of cut
where just 12 of 35 raycasts hit ground. Every answer that depends on it reports
scan_coverage so the caller can tell measurement from interpolation.

agent.validate() reads the same lookup, so a pad sized with check-pad is
graded against the same metres. The scan and filled field yield different
messages for most real designs. check-pad flags coverage below 80%
rather than silently blessing invented ground.

The LIMITS every verdict here is reached with are site data too, in
site.constraints — 1.2 m is roughly California's 4-foot permit trigger, not a
universal constant, and this file is meant to answer for any yard. `constraints`
prints them and says which came from site.json. A shared source prevents
disagreement: a 0.65 m face needs an engineered footing at a 0.6 m threshold
but not at 0.7 m.

Neither lookup is reimplemented here — both are agent.scan_at / agent.ground_at,
re-exported. Separate copies of the height-field indexing risk reversing the
rows and mirroring the site north-to-south.
"""
from __future__ import annotations
import argparse
import importlib.util
import json
import math
import alternatives as _alternatives   # two proposals for one corner — ONE resolver
import geom as _geom            # polygon_area — never a second copy (tests/test_dry.py)
import project                  # the active project's files — the ONE owner
import datetime as dt
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# import agent.py for ground_at() and validate() rather than copying either.
# ONE module object, not two: executing agent.py under a second name creates two
# copies of every height cache and two distinct function objects for the same
# lookup, which can drift apart. Reuse an already-imported copy of the same file
# when there is one.
AGENT_PATH = os.path.join(ROOT, "tools", "agent.py")
_agent = next((m for m in (sys.modules.get("agent"), sys.modules.get("yt_agent"))
               if m is not None and getattr(m, "__file__", None) == AGENT_PATH), None)
if _agent is None:
    _spec = importlib.util.spec_from_file_location("agent", AGENT_PATH)
    _agent = importlib.util.module_from_spec(_spec)
    # REGISTERED BEFORE IT RUNS, as a normal import does. agent.py imports registry, which
    # imports agent; registering afterwards lets that nested import load a SECOND agent.
    # Registering first keeps `import site_api` then `import agent` on one ground_at function.
    sys.modules["agent"] = _agent
    _argv, sys.argv = sys.argv, ["agent.py"]    # agent.py parses argv at import
    try:
        _spec.loader.exec_module(_agent)
    except BaseException:
        sys.modules.pop("agent", None)
        raise
    finally:
        sys.argv = _argv

# geodata.py holds the site.json OWNERSHIP MAP (SECTIONS/merge_section). Imported
# for the same reason agent is: one implementation of the rule, not a second copy
# of it written in this file.
if os.path.join(ROOT, "tools") not in sys.path:
    sys.path.insert(0, os.path.join(ROOT, "tools"))
import geodata as _geodata          # noqa: E402

# ── ground truth ──────────────────────────────────────────────────────────
# Both lookups live in agent.py and are re-exported here, not reimplemented. They
# give the tool sizing a pad and the validator judging it the same number. The
# 1 m raycast and the 2 m BFS-filled grid can differ by up to 0.99 m on measured
# ground, so choosing different sources changes the verdict.
_scan_grid = _agent._scan_grid
scan_at = _agent.scan_at            # raycast, bilinear; None off the scan
filled_at = _agent.filled_at        # 2 m BFS fill; invents ground past the edge
ground_at = _agent.ground_at        # scan_at, then filled_at


def coverage(pts):
    """Fraction of these points that sit on genuinely scanned ground."""
    if not _scan_grid():
        return None
    hit = sum(1 for x, y in pts if scan_at(x, y) is not None)
    return round(hit / len(pts), 2) if pts else 0.0


# ── the limits ────────────────────────────────────────────────────────────
# The four defaults (1.2 / 0.6 / 0.08 / 0.20) belong to one shared table. Separate
# 0.6 m and 0.7 m footing thresholds disagree on a 0.65 m patio face. These are
# regulatory numbers about a particular address, so they live in site.constraints,
# with agent.DEFAULT_CONSTRAINTS as the one fallback table.
constraints = _agent.constraints          # site dict -> the limits it is judged by
# What a wall is built out of, per material — thickness, batter, footing depth.
# Re-exported for the same reason as the lookups above: viewer/src/design.js
# already draws walls from these numbers and a third copy would be a third
# ruler. edge_section(edge) resolves what an edge STATES over its material's
# default, and is the only correct way to ask how thick a wall is.
EDGE_SECTION = _agent.EDGE_SECTION
edge_section = _agent.edge_section


class NoSite(Exception):
    """data/site.json does not exist yet. Carries the answer, not the exception."""


def _site():
    """The site file, or a refusal that says how to create it.

    A missing site.json needs a sentence and a fix, rather than a raw
    FileNotFoundError. The same convention applies across tools: sun.py names
    the two clicks that set north, the ground commands name analyze_site, and
    replant names the file it cannot read.

    A new property has no site.json before `geodata.py --address` runs, so a
    session querying it needs setup instructions.
    """
    path = project.data("site.json")
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        raise NoSite(json.dumps({
            "no_site": True,
            "reason": "data/site.json does not exist — this property has no address, "
                      "lot, zone or measured ground yet, so nothing here can be answered "
                      "about it.",
            "fix": ["make or open the project first: the viewer's project window (New project…), "
                    "or python3 tools/project.py new \"NAME\" --open",
                    'then python3 tools/geodata.py --address "1425 Example St, Town, ST 12345"',
                    "then: cd viewer && npm run dev, load the capture, and "
                    "python3 tools/analyze_site.py"],
            "answerable_without_a_site_file": ["nothing in site_api; geodata.py --address "
                                               "is the first command on a new property"],
        }))
    except json.JSONDecodeError as e:
        raise NoSite(json.dumps({
            "no_site": True,
            "reason": f"data/site.json is present but unparseable ({e}). Refusing to "
                      f"answer from it, and refusing to overwrite it.",
            "fix": ["fix the JSON by hand, or move it aside and re-run geodata.py"],
        }))


def limits():
    """This site's limits. Read fresh each call — one command does a handful of
    lookups, and a cache here would just be a fifth copy of the numbers waiting
    to go stale."""
    try:
        return constraints(_site())
    except (OSError, json.JSONDecodeError):
        return constraints(None)


def _design(path=None):
    """The design document AS IT IS ON DISK — every alternative still in it.

    Deliberately NOT resolved here, even though nine of the ten callers want it
    resolved. `cmd_apply_ops` reads through this function and writes the result
    back, so resolving at the read would silently delete the owner's unchosen
    proposal. The measuring commands call `_measured()` instead; the asymmetry is
    the whole safety property and `tests/test_alternatives.py` asserts it.
    """
    p = project.resolve(path) if path else project.data("design.json")
    with open(p) as f:
        return json.load(f)


def _measured(path=None):
    """The design as ONE garden, for anything that counts or judges.

    A document may carry two proposals for one corner. Measuring the union
    reports a site with two of everything: the plant count doubles and the ground
    per plant halves. Density informs the owner's choice, so it must describe only
    the active proposal.
    """
    return _alternatives.active_design(_design(path))


def _grade_between(ax, ay, bx, by):
    """Slope of the straight line between two points, as a fraction and degrees."""
    ga, gb = ground_at(ax, ay), ground_at(bx, by)
    run = math.hypot(bx - ax, by - ay)
    if ga is None or gb is None or run < 1e-6:
        return None
    rise = gb - ga
    return {"rise_m": round(rise, 2), "run_m": round(run, 2),
            "grade_pct": round(100 * rise / run, 1),
            "grade_deg": round(math.degrees(math.atan(abs(rise) / run)), 1)}


def _no_scan_notice():
    """Say "this property has never been measured", not "that point is unmeasured".

    {"ground_m": null, "scanned": false} alone is byte-identical for
    a point 500 m off a real mesh and for a fresh capture with no raycast at all.
    It invents no ground but leaves the caller unable to tell whether the whole
    property needs a raycast. A separate notice names the command that fixes it.

    Shaped like tools/sun.py's refusal, which names the two clicks that fix it.
    Returns None when a scan exists, so the normal path pays nothing.

    ONE notice, used by every command that touches the ground, keeps all ground
    queries consistent and avoids duplicated setup instructions that can drift.
    The wording says "missing" deliberately — tests/test_hardening_
    degraded.py pattern-matches an honest failure on words a caller can act on.
    """
    if _agent._scan_grid() is not None:
        return None
    return {"no_scan": True,
            "reason": "data/terrain_scan.json is missing — this property has "
                      "not been raycast yet, so NOTHING here is measured ground "
                      "and no elevation, grade or cut/fill figure can be honest.",
            "fix": ["cd viewer && npm run dev, open the page and load the capture",
                    "python3 tools/analyze_site.py   (this writes terrain_scan.json "
                    "and the measured zones)"],
            "answerable_without_a_scan": [
                "python3 tools/site_api.py areas — the regions the owner has drawn",
                "python3 tools/site_api.py near X Y — what the design already puts there",
                "python3 tools/site_api.py constraints — the limits this address is judged by",
                "python3 tools/geodata.py --address '…' — writes site.json, the step "
                "BEFORE analyze_site"]}


def _refuse_without_scan(quantity):
    """The whole answer, for a command whose whole answer IS the ground.

    Carries no number a caller could read back as one, like sun.py's _refusal:
    an unknown must not look like a pass. `best-bench` answering "candidates": []
    on a property nobody has raycast implies there is no level pad on the site,
    which is a measurement nobody made.

    Returns None when a scan exists, so every caller is a three-line guard at the
    top of the command and the normal path pays one cached dict lookup. It goes
    BEFORE argument parsing on purpose: `ground-many 'not json'` on an unmeasured
    property has two true answers, and "run analyze_site" is the one that gets the
    caller a number — fixing the JSON only gets them a page of nulls.
    """
    notice = _no_scan_notice()
    return dict(notice, refused=True, quantity=quantity) if notice else None


def cmd_ground(a):
    refused = _refuse_without_scan(f"ground({a.x}, {a.y})")
    if refused:
        return refused
    h = ground_at(a.x, a.y)
    s = scan_at(a.x, a.y)
    # "scanned" means a raycast hit, not merely a height: ground_at falls back to
    # the 2 m BFS-filled grid past the scan edge. On a real capture's 1 m lattice,
    # over half the cells with heights can have no raycast hit. Use scan_at so rows
    # agree with ground-many's on_scan count and EXPLORE_BRIEF's field description.
    out = {"x": a.x, "y": a.y,
           "ground_m": None if h is None else round(h, 2),
           "scanned": s is not None,
           "source": None if h is None else ("raycast" if s is not None else "filled")}
    return out


def cmd_slope(a):
    """Local gradient by central differences, plus which way is downhill."""
    refused = _refuse_without_scan(f"slope({a.x}, {a.y})")
    if refused:
        return refused
    r = a.radius
    e, w = ground_at(a.x + r, a.y), ground_at(a.x - r, a.y)
    n, s = ground_at(a.x, a.y + r), ground_at(a.x, a.y - r)
    c = ground_at(a.x, a.y)
    if c is None:
        return {"error": f"({a.x}, {a.y}) is not on scanned ground"}
    dx = (e - w) / (2 * r) if e is not None and w is not None else None
    dy = (n - s) / (2 * r) if n is not None and s is not None else None
    if dx is None or dy is None:
        return {"x": a.x, "y": a.y, "ground_m": round(c, 2),
                "error": "not enough neighbours to measure a gradient here"}
    slope = math.degrees(math.atan(math.hypot(dx, dy)))
    bearing = (math.degrees(math.atan2(-dx, -dy)) + 360) % 360
    band = ("flat" if slope < 9 else "moderate" if slope < 18 else "steep")
    return {"x": a.x, "y": a.y, "ground_m": round(c, 2),
            "slope_deg": round(slope, 1), "slope_pct": round(100 * math.hypot(dx, dy), 1),
            "downhill_bearing_deg": round(bearing),
            "contour_bearing_deg": round((bearing + 90) % 180),
            "band": band,
            "usable_for": ("a level pad, needs least work" if band == "flat"
                           else "paths, terraced planting, a bench held by a low wall"
                           if band == "moderate" else "planting only — do not build here")}


def _points(raw):
    """Parse a JSON [[x,y], ...] list into floats.

    Floats, not whatever JSON gave: `[[15,-6]]` parses to ints, and a batch that
    answered {"x": 15} where the single call answers {"x": 15.0} would be a batch
    the model has to reconcile. The two must be byte-identical or there is no
    reason to trust the cheaper one.
    """
    try:
        pts = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"points must be JSON like [[x,y],[x,y],...] — {e}")
    if not isinstance(pts, list) or not pts:
        raise ValueError("no points — pass JSON like '[[15,-6],[16,-6]]'")
    out = []
    for p in pts:
        if not isinstance(p, (list, tuple)) or len(p) != 2:
            raise ValueError(f"each point must be [x, y]; got {json.dumps(p)}")
        try:
            out.append((float(p[0]), float(p[1])))
        except (TypeError, ValueError):
            raise ValueError(f"each point must be [x, y] numbers; got {json.dumps(p)}")
    return out


def _batch(rows, pts):
    """The part every -many command shares: how much of this was measured.

    The warning is not decoration. Every other verdict in this file flags
    coverage under 0.8, and a model reading forty rows will only ever see the
    summary — so a batch that reported coverage as a bare number would be the one
    answer here that lets invented ground through quietly.
    """
    cov = coverage(pts)
    out = {"count": len(rows), "scan_coverage": cov,
           "on_scan": sum(1 for x, y in pts if scan_at(x, y) is not None)}
    if cov is not None and cov < 0.8:
        out["warning"] = (f"only {cov:.0%} of these points are on ground the scanner saw — "
                          f"the rest are the 2 m filled grid, which invents flat ground past "
                          f"the scan edge. Do not size anything off them")
    return out


def cmd_ground_many(a):
    """Ground at N points in ONE call.

    Batching avoids one process per point. Left to itself a model makes far more
    single-point `ground` and `slope` calls than batch calls;
    prose in EXPLORE_BRIEF alone is insufficient to encourage batching. The
    per-point rows are cmd_ground's, not a reimplementation, so a batch cannot
    disagree with a single call. Different ground lookups can differ by 0.99 m.
    """
    refused = _refuse_without_scan("ground-many")
    if refused:
        return refused
    pts = _points(a.points)
    rows = [cmd_ground(argparse.Namespace(x=x, y=y)) for x, y in pts]
    hs = [r["ground_m"] for r in rows if r["ground_m"] is not None]
    out = _batch(rows, pts)
    # "a height came back" is NOT "the scanner saw it": ground_at falls back to
    # the BFS-filled grid past the scan edge, which can make a pad appear viable
    # where only 12 of 35 raycasts hit ground.
    out["with_ground"] = len(hs)
    if hs:
        out["ground_m"] = {"min": min(hs), "max": max(hs), "fall": round(max(hs) - min(hs), 2)}
        out["lowest"] = min(rows, key=lambda r: (r["ground_m"] is None, r["ground_m"]))
        out["highest"] = max(rows, key=lambda r: (r["ground_m"] is not None, r["ground_m"]))
    out["points"] = rows
    return out


def cmd_slope_many(a):
    """Slope at N points in ONE call, with the flattest one named.

    Naming the flattest is the point, not a convenience: flat ground is the
    scarce resource on a sloping site — a back yard can have only a few square
    metres under 9 degrees — so "which of these is buildable" is the question a
    run of `slope` calls is always being used to answer by hand.
    """
    refused = _refuse_without_scan("slope-many")
    if refused:
        return refused
    pts = _points(a.points)
    rows = [cmd_slope(argparse.Namespace(x=x, y=y, radius=a.radius)) for x, y in pts]
    graded = [r for r in rows if r.get("slope_deg") is not None]
    out = _batch(rows, pts)
    out["measured"] = len(graded)
    if graded:
        bands = {"flat_under_9deg": 0, "moderate_9_18": 0, "steep_over_18": 0}
        for r in graded:
            bands["flat_under_9deg" if r["slope_deg"] < 9 else
                  "moderate_9_18" if r["slope_deg"] < 18 else "steep_over_18"] += 1
        out["bands"] = bands
        out["flattest"] = min(graded, key=lambda r: r["slope_deg"])
        out["steepest"] = max(graded, key=lambda r: r["slope_deg"])
    out["points"] = rows
    out["note"] = ("rows are identical to `slope X Y` per point. To SITE something, "
                   "prefer best-bench — it searches positions and orientations you "
                   "have not thought to list.")
    return out


def cmd_profile(a):
    """Ground along a line, with the grade of each step and the worst of them."""
    refused = _refuse_without_scan(
        f"profile({a.x1}, {a.y1} -> {a.x2}, {a.y2})")
    if refused:
        return refused
    n = max(2, int(math.hypot(a.x2 - a.x1, a.y2 - a.y1) / a.step))
    pts = []
    for i in range(n + 1):
        t = i / n
        x = a.x1 + (a.x2 - a.x1) * t
        y = a.y1 + (a.y2 - a.y1) * t
        h = ground_at(x, y)
        pts.append({"x": round(x, 1), "y": round(y, 1),
                    "ground_m": None if h is None else round(h, 2)})
    known = [p for p in pts if p["ground_m"] is not None]
    if len(known) < 2:
        return {"points": pts, "error": "line is mostly off the scanned ground"}
    grades = []
    for i in range(1, len(known)):
        run = math.hypot(known[i]["x"] - known[i - 1]["x"], known[i]["y"] - known[i - 1]["y"])
        if run > 1e-6:
            grades.append(100 * (known[i]["ground_m"] - known[i - 1]["ground_m"]) / run)
    total = _grade_between(a.x1, a.y1, a.x2, a.y2)
    lim = limits()
    return {"points": pts, "overall": total,
            "steepest_step_pct": round(max(grades, key=abs), 1) if grades else None,
            "walkable_without_steps": bool(total and abs(total["grade_pct"]) <= lim["walk_grade"] * 100
                                           and grades
                                           and max(map(abs, grades)) <= lim["max_grade"] * 100)}


def _poly_samples(poly, step=0.5):
    """Perimeter plus a 1 m interior grid — the same sampling the validator uses."""
    return _agent._walk_polygon(poly, step)


def cmd_check_pad(a):
    """What a level pad here would actually cost, WITHOUT committing it."""
    refused = _refuse_without_scan("check-pad")
    if refused:
        return refused
    poly = json.loads(a.polygon)
    pts = _poly_samples(poly)
    cov = coverage(pts)
    hs = [g for g in (ground_at(x, y) for x, y in pts) if g is not None]
    if not hs:
        return {"error": "that outline is not on scanned ground"}
    lo, hi = min(hs), max(hs)
    lvl = a.level if a.level is not None else round((lo + hi) / 2, 2)
    fill = round(max(lvl - h for h in hs), 2)
    cut = round(max(h - lvl for h in hs), 2)
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    lim = limits()
    verdict = ("buildable" if max(fill, cut) <= lim["footing_threshold_m"]
               else "needs an engineered footing" if max(fill, cut) <= lim["retain_limit_m"]
               else "REJECTED — over what an edge can retain")
    out = {"level_m": lvl, "area_m2": round(_poly_area(poly), 1),
           "ground_range_m": [round(lo, 2), round(hi, 2)],
           "max_fill_m": fill, "max_cut_m": cut,
           "balanced": abs(fill - cut) < 0.2,
           "verdict": verdict,
           "wall_height_needed_m": fill, "cut_face_height_m": cut,
           "span_x_m": round(max(xs) - min(xs), 1), "span_y_m": round(max(ys) - min(ys), 1),
           "scan_coverage": cov,
           # state the numbers the verdict was reached with: they are this site's,
            # not universal — the model must not assume 1.2 m everywhere
           "judged_against": {"retain_limit_m": lim["retain_limit_m"],
                              "footing_threshold_m": lim["footing_threshold_m"]}}
    if cov is not None and cov < 0.8:
        out["verdict"] = f"UNTRUSTWORTHY — only {cov:.0%} of this outline is on scanned ground"
        out["suggestion"] = ("move it onto ground the scanner actually saw, or re-scan that "
                             "corner; elevations outside the scan are interpolated and the "
                             "cut/fill figures above are not real")
    if verdict.startswith("REJECTED"):
        out["suggestion"] = (f"level {round((lo + hi) / 2, 2)} m balances it best; if that is still "
                             f"over the limit the pad is too wide ACROSS the fall line — narrow it "
                             f"and lengthen it along the contour instead")
    return out


def _flight_over(mid, steps):
    """The flight covering this point, or None. agent._under_steps decides."""
    for st in steps or []:
        if _agent._under_steps(mid, [st]):
            return st
    return None


def cmd_check_route(a):
    """A route as CIRCULATION: which stretches are walked, which are stepped.

    A flight of steps covers a steep stretch: for an 8.6 m route with 3.7 m over
    a 20% walk limit, set_steps across those 3.7 m addresses the grade rejection.
    Grading a bare list of points misses that context and incorrectly reports
    that the route still needs steps. A path declaring `level_m` is a bench,
    flat by construction; validate() exempts it from grading because the raw
    slope underneath is not walked.

    `--level` and `--steps` supply that context. ONE JUDGE: the route is handed
    to agent.validate() and its verdict is reported back, so the tool and the
    judge cannot drift. Ignoring this context changes real verdicts: a stepped
    or levelled path would be graded as a bare ramp.

    The route is split into contiguous stretches, so a 30 m walk with one 4 m
    flight reads as a design rather than as a failure. An unstepped steep
    stretch names set_steps as the op that answers it.
    """
    refused = _refuse_without_scan("check-route")
    if refused:
        return refused
    spline = json.loads(a.spline)
    level = getattr(a, "level", None)
    level = None if level is None else float(level)
    raw_steps = getattr(a, "steps", None)
    steps = json.loads(raw_steps) if isinstance(raw_steps, str) else (raw_steps or [])
    width = float(getattr(a, "width", None) or 1.2)

    walked = _agent.path_steps(spline, 0.5)
    pts = _agent._walk_line(spline, 0.5)
    lim = limits()
    max_pct = lim["max_grade"] * 100
    walk_pct = lim["walk_grade"] * 100

    # ── the judge, first. Same design shape validate() sees in a real design, so
    # the sentence it produces here is the sentence it produces there.
    path = {"id": "route", "spline": spline, "width_m": width, "material": "gravel"}
    if level is not None:
        path["level_m"] = level
    errors, warnings = _agent.validate(
        {"version": 1, "units": "meters", "beds": [], "plants": [],
         "paths": [path], "steps": steps}, _site())

    # ── the stretches. A step is classified once and consecutive ones merge.
    def kind_of(grade, mid):
        if grade is None:
            return "unmeasured"          # never graded: the filled field invents a 357% cliff here
        if _flight_over(mid, steps):
            return "steps"
        if level is not None:
            return "bench"               # this path IS the surface; the slope under it is not walked
        return "needs_steps" if abs(grade) > max_pct else "walk"

    runs = []
    for grade, run, mid, at in walked:
        k = kind_of(grade, mid)
        if runs and runs[-1]["kind"] == k:
            runs[-1]["to_m"] += run
            runs[-1]["_fall"] += 0.0 if grade is None else grade * run / 100
            runs[-1]["_grades"].append(grade)
            runs[-1]["_end"] = mid
        else:
            runs.append({"kind": k, "from_m": at, "to_m": at + run,
                         "_fall": 0.0 if grade is None else grade * run / 100,
                         "_grades": [grade], "_start": mid, "_end": mid})

    stretches = []
    for r in runs:
        gs = [g for g in r["_grades"] if g is not None]
        fall = round(r["_fall"], 2)
        st = {"kind": r["kind"],
              "from_m": round(r["from_m"], 2), "to_m": round(r["to_m"], 2),
              "length_m": round(r["to_m"] - r["from_m"], 2),
              "fall_m": fall,
              "steepest_pct": (round(max(gs, key=abs), 1) if gs else None)}
        if r["kind"] == "needs_steps" and abs(fall) > 1e-9:
            # Risers off the ROUNDED fall this stretch reports, so the arithmetic
            # the model can redo by hand is the arithmetic that produced it.
            st["flight_needed"] = dict(
                _agent.steps_for_fall(fall, lim["step_riser_max_m"], lim["step_going_min_m"]),
                op="set_steps",
                note=(f"set_steps across this stretch clears the rejection — risers up to "
                      f"{lim['step_riser_max_m']:g} m and going at least "
                      f"{lim['step_going_min_m']:g} m, from site.constraints"))
        stretches.append(st)

    by = lambda k: round(sum(s["length_m"] for s in stretches if s["kind"] == k), 2)
    stepped_m, walk_m, steep_m = by("steps"), by("walk") + by("bench"), by("needs_steps")
    flights = {}
    for grade, run, mid, at in walked:
        f = _flight_over(mid, steps)
        if f:
            flights.setdefault(f.get("id") or id(f), f)
    risers_total = 0
    for st in stretches:
        if st["kind"] == "steps":
            f = _flight_over(runs[stretches.index(st)]["_start"], steps) or {}
            riser = float(f.get("riser_m") or lim["step_riser_max_m"])
            risers_total += _agent.steps_for_fall(st["fall_m"], riser,
                                                  lim["step_going_min_m"])["risers"]

    # A LANDING is the one piece of a stepped route the schema cannot infer from
    # the two elements alone: the flight and the walk both end at the same point
    # and neither of them owns the level ground there.
    landings = []
    for prev, nxt in zip(runs, runs[1:]):
        pair = {prev["kind"], nxt["kind"]}
        if "steps" in pair and pair & {"walk", "needs_steps", "bench"}:
            landings.append({
                "at_m": round(nxt["from_m"], 2),
                "xy": [round(nxt["_start"][0], 2), round(nxt["_start"][1], 2)],
                "why": ("a landing belongs where the flight meets the walk — both end here "
                        "and neither element carries the level ground they need")})

    graded = [g for g, _, _, _ in walked if g is not None]
    if not graded:
        return {"length_m": round(sum(r for _, r, _, _ in walked), 1),
                "unmeasured_m": round(sum(r for _, r, _, _ in walked), 1),
                "scan_coverage": coverage(pts),
                "off_scan_points": sum(1 for x, y in pts if scan_at(x, y) is None),
                "mean_grade_pct": None, "steepest_pct": None, "total_fall_m": None,
                "walkable_as_a_ramp": None,
                "verdict": "not measured — no part of this route is on scanned ground",
                "validator": {"applies_clean": not errors,
                              "errors": errors, "warnings": warnings},
                "circulation": {"reads_as": "nothing here has been measured, so nothing "
                                            "about how it walks is known",
                                "walk_m": 0, "stepped_m": 0, "steep_unstepped_m": 0,
                                "unmeasured_m": round(sum(r for _, r, _, _ in walked), 1),
                                "flights": 0, "risers_total": 0,
                                "stretches": stretches, "landings": landings}}
    free = [(g, r) for g, r, m, _ in walked
            if g is not None and not _flight_over(m, steps)]
    if level is not None:
        free = []
    worst = max((g for g, _ in free), key=abs, default=0.0)
    mean = (sum(abs(g) for g, _ in free) / len(free)) if free else 0.0
    over = sum(r for g, r in free if abs(g) > max_pct)

    if level is not None:
        reads_as = (f"a level bench at {level:g} m — flat by construction, so the slope "
                    f"underneath is not what anybody walks on")
    elif stepped_m and walk_m:
        reads_as = (f"a walk with {len(flights)} flight{'s' if len(flights) != 1 else ''} "
                    f"of steps in it — {walk_m:g} m walked, {stepped_m:g} m stepped")
    elif stepped_m:
        reads_as = f"a staircase rather than a walk — {stepped_m:g} m of it is stepped"
    elif steep_m:
        reads_as = (f"a route that is not yet walkable — {steep_m:g} m of it is over "
                    f"{max_pct:g}% with nothing built across it")
    else:
        reads_as = f"a walk, end to end — {walk_m:g} m at {mean:.1f}% average"

    verdict = ("comfortable ramp" if not free or (mean <= walk_pct and abs(worst) <= 12)
               else "walkable but steep in places" if abs(worst) <= max_pct
               else f"needs steps — {over:.1f} m of this runs over {max_pct:g}%")
    if level is not None:
        verdict = "a declared level surface — graded as a bench, not as a ramp"

    total_len = sum(r for _, r, _, _ in walked)
    unmeasured = sum(r for g, r, _, _ in walked if g is None)
    out = {"length_m": round(total_len, 1),
           "total_fall_m": round(sum(g * r / 100 for g, r, _, _ in walked if g is not None), 2),
           "mean_grade_pct": round(sum(map(abs, graded)) / len(graded), 1),
           "steepest_pct": round(max(graded, key=abs), 1),
           "max_grade_pct": round(max_pct, 1),
           "metres_over_max_grade": round(over, 1),
           "off_scan_points": sum(1 for x, y in pts if scan_at(x, y) is None),
           "unmeasured_m": round(unmeasured, 1),
           "scan_coverage": coverage(pts),
           # A declared bench walks at 0% by construction — reporting it as
           # unwalkable because the natural ground under it is steep is the same
           # error as grading it, one field over.
           "walkable_as_a_ramp": (True if level is not None
                                  else bool(free) and abs(worst) <= max_pct and mean <= walk_pct),
           "verdict": verdict,
           # The judge's own words. Reported rather than re-derived, because the
            # tool and validator must reach the same conclusion.
           "validator": {"applies_clean": not errors, "errors": errors, "warnings": warnings},
           "circulation": {"reads_as": reads_as,
                           "walk_m": walk_m, "stepped_m": stepped_m,
                           "steep_unstepped_m": steep_m,
                           "unmeasured_m": by("unmeasured"),
                           "flights": len(flights), "risers_total": risers_total,
                           "stretches": stretches, "landings": landings}}
    if steep_m and abs(out["total_fall_m"]) > 1e-6:
        out["steps_needed"] = dict(
            _agent.steps_for_fall(sum(s["fall_m"] for s in stretches
                                      if s["kind"] == "needs_steps"),
                                  lim["step_riser_max_m"], lim["step_going_min_m"]),
            note=(f"at most {lim['step_riser_max_m']:g} m per riser and at least "
                  f"{lim['step_going_min_m']:g} m of going, from site.constraints. "
                  f"set_steps across the steep stretch is what clears the rejection"))
    return out


def cmd_best_bench(a):
    """
    Search a region for the level pad that costs least earthwork.

    A model eyeballing an elevation grid to find a bench location is doing badly
    what a search does perfectly. This tries every position and orientation on a
    coarse lattice and returns the ones that balance cut against fill — which is
    also the ones where no soil has to leave the site.
    """
    refused = _refuse_without_scan(
        f"best-bench({a.x0}, {a.y0} -> {a.x1}, {a.y1})")
    if refused:
        return refused
    best = []
    across, along = a.across, a.along
    retain = limits()["retain_limit_m"]       # hoisted: the search runs thousands of cells
    for deg in range(0, 180, 15):
        th = math.radians(deg)
        ux, uy = math.cos(th), math.sin(th)          # along the bench
        px, py = -uy, ux                              # across it
        x = a.x0
        while x <= a.x1:
            y = a.y0
            while y <= a.y1:
                poly = [(x + ux * along / 2 + px * across / 2, y + uy * along / 2 + py * across / 2),
                        (x + ux * along / 2 - px * across / 2, y + uy * along / 2 - py * across / 2),
                        (x - ux * along / 2 - px * across / 2, y - uy * along / 2 - py * across / 2),
                        (x - ux * along / 2 + px * across / 2, y - uy * along / 2 + py * across / 2)]
                spts = _poly_samples(poly, 1.0)
                cov = coverage(spts)
                hs = [g for g in (ground_at(cx, cy) for cx, cy in spts) if g is not None]
                if len(hs) >= 4 and (cov is None or cov >= 0.85):
                    lvl = (min(hs) + max(hs)) / 2
                    fill = max(lvl - h for h in hs)
                    cut = max(h - lvl for h in hs)
                    worst = max(fill, cut)
                    if worst <= retain:
                        best.append({"centre": [round(x, 1), round(y, 1)],
                                     "bearing_deg": deg, "level_m": round(lvl, 2),
                                     "max_fill_m": round(fill, 2), "max_cut_m": round(cut, 2),
                                     "worst_face_m": round(worst, 2),
                                     "imbalance_m": round(abs(fill - cut), 2),
                                     "scan_coverage": cov,
                                     "polygon": [[round(c[0], 1), round(c[1], 1)] for c in poly]})
                y += 1.0
            x += 1.0
    best.sort(key=lambda b: (b["worst_face_m"], b["imbalance_m"]))
    # de-duplicate near-identical placements so the list is worth reading
    picked = []
    for b in best:
        if all(math.hypot(b["centre"][0] - p["centre"][0],
                          b["centre"][1] - p["centre"][1]) > 2.5 for p in picked):
            picked.append(b)
        if len(picked) >= a.top:
            break
    return {"searched_region": [a.x0, a.y0, a.x1, a.y1],
            "pad_size_m": [across, along],
            "candidates": picked,
            "note": "sorted by the tallest face needed, then by how well cut balances fill; "
                    "a balanced pad means no soil leaves the site. Candidates on less than "
                    "85% genuinely scanned ground are excluded — the filled height field "
                    "invents flat ground past the scan edge."}


def _area(name):
    for a in _site().get("areas", []):
        if a["name"].lower() == name.lower():
            return a
    return None


# Polygon area and containment use agent.py's implementations so geometry
# measurements cannot drift between the tools and the validator.
_poly_area = _agent.poly_area


def _inside(px, py, poly):
    return _agent.point_in_poly((px, py), poly)


def cmd_areas(a):
    """List the regions the owner has drawn, so a new session can find them."""
    out = []
    for ar in _site().get("areas", []):
        xs = [p[0] for p in ar["polygon"]]
        ys = [p[1] for p in ar["polygon"]]
        out.append({"name": ar["name"], "area_m2": round(_poly_area(ar["polygon"]), 1),
                    "bounds_m": {"x": [round(min(xs), 1), round(max(xs), 1)],
                                 "y": [round(min(ys), 1), round(max(ys), 1)]},
                    "vertices": len(ar["polygon"]),
                    "note": ar.get("note", "")})
    return {"count": len(out), "areas": out,
            "note": "these are drawn by the owner and are ground truth. Use "
                    "`area NAME` for detail, and `agent.py --area NAME` to design in one."}


def cmd_area(a):
    """
    Everything measurable about one drawn region.

    This answers "what is this ground like and what is already here" from data.
    It cannot answer "what IS that wooden thing" — that needs looking at it, and
    the walkthrough renderer is the tool for that.
    """
    ar = _area(a.name)
    if not ar:
        have = [x["name"] for x in _site().get("areas", [])]
        return {"error": f"no area named '{a.name}'",
                "available": have or "none drawn yet — use Draw area in the viewer"}
    poly = ar["polygon"]
    pts = _poly_samples(poly, 0.5)
    cov = coverage(pts)
    hs = [g for g in (ground_at(x, y) for x, y in pts) if g is not None]
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    cx, cy = sum(xs) / len(xs), sum(ys) / len(ys)

    # grade breakdown across the region, the number that decides what it is good for
    bands = {"flat_under_9deg": 0, "moderate_9_18": 0, "steep_over_18": 0}
    slopes = []
    step = 1.0
    x = min(xs)
    while x <= max(xs):
        y = min(ys)
        while y <= max(ys):
            if _inside(x, y, poly):
                r = 1.0
                e, w = ground_at(x + r, y), ground_at(x - r, y)
                n, sth = ground_at(x, y + r), ground_at(x, y - r)
                if None not in (e, w, n, sth):
                    sl = math.degrees(math.atan(math.hypot((e - w) / (2 * r), (n - sth) / (2 * r))))
                    slopes.append(sl)
                    bands["flat_under_9deg" if sl < 9 else
                          "moderate_9_18" if sl < 18 else "steep_over_18"] += 1
            y += step
        x += step

    zone = None
    for z in _site().get("zones", []):
        b = z["bounds_m"]
        if b["x"][0] <= cx <= b["x"][1] and b["y"][0] <= cy <= b["y"][1]:
            zone = z["zone"]
            break

    d = _measured(a.design)
    contents = []
    for pl in d.get("plants", []):
        if _inside(pl["position"][0], pl["position"][1], poly):
            contents.append({"kind": "plant", "id": pl.get("id"), "what": pl.get("species")})
    for key, label, geom in _agent.DESIGN_GEOM:
        for o in d.get(key, []):
            if any(_inside(px, py, poly) for px, py in (o.get(geom) or [])):
                contents.append({"kind": label, "id": o.get("id"),
                                 "what": o.get("material") or o.get("purpose") or ""})
    for lm in _site().get("landmarks", []):
        if _inside(lm["x"], lm["y"], poly):
            contents.append({"kind": "landmark", "id": lm["name"], "what": "clicked by the owner"})

    out = {"name": ar["name"], "area_m2": round(_poly_area(poly), 1),
           "in_zone": zone, "centre": [round(cx, 1), round(cy, 1)],
           "bounds_m": {"x": [round(min(xs), 1), round(max(xs), 1)],
                        "y": [round(min(ys), 1), round(max(ys), 1)]},
           "polygon": poly, "scan_coverage": cov,
           "contains": contents, "note": ar.get("note", "")}
    if hs:
        out["ground_m"] = {"min": round(min(hs), 2), "max": round(max(hs), 2),
                           "fall_m": round(max(hs) - min(hs), 2)}
    if slopes:
        out["mean_slope_deg"] = round(sum(slopes) / len(slopes), 1)
        out["grade_m2"] = bands
        out["suits"] = ("a level pad — this is usable ground as it stands"
                        if bands["flat_under_9deg"] > len(slopes) * 0.5
                        else "planting; too steep to build on without terracing"
                        if bands["steep_over_18"] > len(slopes) * 0.5
                        else "paths and terraced planting; a low wall here buys the most")
    if cov is not None and cov < 0.8:
        out["warning"] = (f"only {cov:.0%} of this region is on scanned ground — the "
                          f"elevation figures are partly interpolated")
    # `area` is only HALF a ground question, so it is the one command here that
    # answers and warns rather than refusing. The polygon, its size and what the
    # design already puts inside it are owner ground truth and stay true with no
    # raycast at all — sun.py's precedent is to refuse the bearing and still hand
    # back the altitude. The ground half is simply absent above (hs and slopes are
    # empty), and without this notice its absence looks like a flat, featureless
    # region rather than an unmeasured one. It still exits 2: the answer is
    # incomplete for a reason one command fixes.
    notice = _no_scan_notice()
    return {**notice, **out} if notice else out


def cmd_near(a):
    """What is already at a spot — so the model stops planting on its own paths."""
    d = _measured(a.design)
    found = []
    for pl in d.get("plants", []):
        px, py = pl["position"][:2]
        dist = math.hypot(px - a.x, py - a.y)
        if dist <= a.radius:
            found.append({"kind": "plant", "id": pl.get("id"), "what": pl.get("species"),
                          "distance_m": round(dist, 2),
                          "mature_spread_m": pl.get("mature_spread_m")})
    for key, label, geom in _agent.DESIGN_GEOM:
        for o in d.get(key, []):
            pts = o.get(geom) or []
            if not pts:
                continue
            dist = min(math.hypot(px - a.x, py - a.y) for px, py in pts)
            if dist <= a.radius:
                found.append({"kind": label, "id": o.get("id"),
                              "what": o.get("material") or o.get("purpose") or "",
                              "distance_m": round(dist, 2)})
    for lm in _site().get("landmarks", []):
        dist = math.hypot(lm["x"] - a.x, lm["y"] - a.y)
        if dist <= a.radius:
            found.append({"kind": "landmark", "id": lm["name"], "what": "clicked by the owner",
                          "distance_m": round(dist, 2)})
    found.sort(key=lambda f: f["distance_m"])
    return {"x": a.x, "y": a.y, "radius_m": a.radius, "count": len(found), "found": found}


def cmd_check_ops(a):
    """
    Dry-run a proposed op list and report what would happen — writing nothing.

    Check proposed ops before committing them, so the model can discover
    cut/fill limits and fix invalid ops before answering without spending its
    submission retry on a rejection.

    It mirrors agent.run()'s apply loop exactly — same execute(), same
    baseline_errors, same raise-means-rejected contract — so a dry run cannot
    disagree with the real apply.
    """
    ops = json.loads(a.ops) if a.ops else json.load(open(a.ops_file))
    if isinstance(ops, dict):
        ops = ops.get("ops", [])
    d = _design(a.design)
    site = _site()
    # pre-existing problems must not be blamed on the new ops — errors OR warnings.
    # Both come from this ONE call. Re-reading the design and calling validate()
    # inside a comprehension's condition repeats validation ONCE PER WARNING:
    # 248 warnings mean 250 validates and 15.5 s for an empty dry run in a
    # measured case. Reuse both baseline lists to avoid that cost.
    base_errs, base_warns = _agent.validate(d, site)
    baseline = frozenset(base_errs)
    seen_warns = frozenset(base_warns)
    applied, rejected = [], []
    for op in ops:
        try:
            d, msg = _agent.execute(d, site, op.get("tool", "?"),
                                    op.get("input", {}), baseline)
            applied.append({"tool": op.get("tool"), "id": op.get("input", {}).get("id"),
                            "result": msg})
        except Exception as e:
            rejected.append({"tool": op.get("tool"), "id": op.get("input", {}).get("id"),
                             "why": str(e)})
    errs, warns = _agent.validate(d, site)
    new_errs = [e for e in errs if e not in baseline]
    new_warns = [w for w in warns if w not in seen_warns]
    return {"would_apply": len(applied), "would_reject": len(rejected),
            "applied": applied, "rejected": rejected,
            "new_errors": new_errs, "new_warnings": new_warns,
            "ok": not rejected and not new_errs,
            "advice": ("submit it" if not rejected and not new_errs
                       else "fix the rejected ops and check again — submitted as-is "
                            "they will simply be dropped")}


def cmd_apply_ops(a):
    """Run an op list for real and WRITE it — the path a hand edit takes.

    Same execute(), same baseline_errors, same raise-means-rejected contract as
    cmd_check_ops, because a hand edit must be judged exactly like a model edit.
    The viewer emits an op rather than mutating the design, so placement,
    dragging and the model all share one pipeline — which also makes
    every hand edit undoable through the existing timeline for free.

    ALL-OR-NOTHING on write: if any op is rejected the file is left alone. A
    partially applied gesture is the worst outcome — the owner sees some of what
    they asked for and no reason for the rest, and the design on disk is a state
    nobody chose.
    """
    ops = json.loads(a.ops) if a.ops else json.load(open(a.ops_file))
    if isinstance(ops, dict):
        ops = ops.get("ops", [])
    path = a.design or _agent.DESIGN_PATH
    d = _design(a.design)
    before = json.loads(json.dumps(d))
    site = _site()
    base = frozenset(_agent.validate(d, site)[0])
    applied, rejected = [], []
    for op in ops:
        try:
            d, msg = _agent.execute(d, site, op.get("tool", "?"),
                                    op.get("input", {}), base)
            applied.append({"tool": op.get("tool"),
                            "id": op.get("input", {}).get("id"), "result": msg})
        except Exception as e:
            rejected.append({"tool": op.get("tool"),
                             "id": op.get("input", {}).get("id"), "why": str(e)})
    wrote = False
    if applied and not rejected:
        _archive(path)          # what it is replacing, so an undo past it is recoverable
        _agent.write_design(d, path) if hasattr(_agent, "write_design") else _write(path, d)
        wrote = True
        # WHERE THIS EDIT CHANGED THE GROUND, measured from the design before and after,
        # for the call log (not the reply). The look gate needs a look after each place's
        # own last change. A removal in the op list names ids, not places, so the
        # before-and-after comparison is necessary to locate it.
        a._touched = [[round(x, 2), round(y, 2)] for x, y in _agent.changed_places(before, d)]
    errs, warns = _agent.validate(d, site)
    return {"applied": applied, "rejected": rejected, "wrote": wrote,
            "errors": errs, "warnings": warns,
            "ok": bool(applied) and not rejected}


def _archive(path):
    """Keep what a write is about to replace. One rule for every writer:
    agent.archive_working_design — only the working design, only when it holds something."""
    _agent.archive_working_design(path)


def _write(path, design):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(design, f, indent=1)
    os.replace(tmp, path)          # atomic: a half-written design is unreadable


def cmd_save_owner(a):
    """Merge a viewer edit into the OWNER half of site.json, and nothing else.

    site.json is split by writer so a tool can only rewrite its own half.
    geodata.merge_section enforces this for the two Python writers and raises
    on an out-of-section key; silently accepting such a key fails open.

    The third writer is the viewer, and it owns the half nothing can regenerate:
    landmarks and hand-drawn areas are ground truth, and saved designs scope
    to areas BY NAME. The generic /api/save does no ownership check, so viewer
    edits must use this guarded merge instead of posting the whole file there.

    Reads the patch from stdin so a large area polygon never has to survive a
    shell quote. Enforcement is merge_section's, not a second copy of the rule.
    """
    patch = json.loads(sys.stdin.read() or "{}")
    if not isinstance(patch, dict):
        return {"ok": False, "error": "expected a JSON object of owner keys"}
    path = a.site or _agent.SITE_PATH
    try:
        prev = _geodata.load_site(path)
    except Exception as e:
        return {"ok": False, "error": f"site.json unreadable, refusing to overwrite it: {e}"}
    try:
        merged = _geodata.merge_section(prev, "owner", patch)
    except ValueError as e:
        return {"ok": False, "error": str(e), "refused": sorted(patch)}
    _geodata.save_site(merged, path)
    return {"ok": True, "wrote": sorted(patch)}


def cmd_validate(a):
    """Run the real validator on a draft, so the model can fix before committing."""
    d = _measured(a.design)
    errors, warnings = _agent.validate(d, _site())
    return {"errors": errors, "warnings": warnings,
            "ok": not errors,
            "counts": {"errors": len(errors), "warnings": len(warnings)}}


def cmd_constraints(a):
    """The limits every verdict in this file is reached with.

    Discoverability, which is the thing that decides whether a capability gets
    used: check-pad saying "REJECTED" is only actionable if the caller can find
    out what it was judged against, and these numbers are per-site. Says
    which came from site.json and which are the fallback, so a missing
    constraints block is visible rather than silently assumed.
    """
    s = {}
    try:
        s = _site()
    except (OSError, json.JSONDecodeError):
        pass
    given = (s.get("constraints") or {})
    lim = constraints(s)
    return {"constraints": lim,
            "source": {k: ("site.json" if k in given else "default") for k in lim},
            "complaints": _agent.constraint_complaints(s),
            "address": s.get("address"),
            "edge_section": EDGE_SECTION,
            "note": "these are regulatory and soil numbers for THIS address, not universal. "
                    "retain_limit_m is the tallest wall an edge may hold and the cut/fill cap "
                    "on a pad; above footing_threshold_m a face needs an engineered footing. "
                    "Edit them in data/site.json under \"constraints\". edge_section is what a "
                    "wall of each material is BUILT from — thickness, batter and footing depth — "
                    "used when an edge does not state its own. wall_stack_setback_ratio is how "
                    "far behind one wall the next may start, measured face to face: closer than "
                    "that and the pair is judged as one wall of their combined height."}


def cmd_zones(a):
    s = _site()
    return {"zones": s.get("zones", []),
            "house_bounds_m": s.get("house_measured", {}).get("bounds_m"),
            "note": "bounds are the scanned extent of each yard; grade_breakdown_m2 says "
                    "how much of it is usable as-is versus needs terracing versus should "
                    "stay planting"}


def _seg_dist(px, py, ax, ay, bx, by):
    """Distance from a point to a segment — a path is a ribbon, not a polyline."""
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _covers_ribbon(px, py, spline, half):
    return any(_seg_dist(px, py, *spline[i], *spline[i + 1]) <= half
               for i in range(len(spline) - 1))


def _cell_grade(x, y, r=1.0):
    e, w = ground_at(x + r, y), ground_at(x - r, y)
    n, s = ground_at(x, y + r), ground_at(x, y - r)
    if None in (e, w, n, s):
        return None
    return math.degrees(math.atan(math.hypot((e - w) / (2 * r), (n - s) / (2 * r))))


def _trace_outline(cells, step):
    """A rectilinear outline round a set of grid cells.

    Cells that share an edge share it exactly, so the boundary is every cell edge
    that has no neighbour across it, stitched end to end. No smoothing: the
    outline is the measurement, and rounding a corner here would quietly claim
    ground that was never measured.
    """
    edges = {}
    for (i, j) in cells:
        x0, y0 = i * step, j * step
        x1, y1 = x0 + step, y0 + step
        for nb, seg in (((i, j - 1), ((x0, y0), (x1, y0))),
                        ((i + 1, j), ((x1, y0), (x1, y1))),
                        ((i, j + 1), ((x1, y1), (x0, y1))),
                        ((i - 1, j), ((x0, y1), (x0, y0)))):
            if nb not in cells:
                edges.setdefault(seg[0], []).append(seg[1])
    loops = []
    while edges:
        start = next(iter(edges))
        loop, cur = [start], start
        while True:
            nxts = edges.get(cur)
            if not nxts:
                break
            nxt = nxts.pop()
            if not nxts:
                edges.pop(cur, None)
            if nxt == start:
                break
            loop.append(nxt)
            cur = nxt
        if len(loop) >= 4:
            loops.append(loop)
    loops.sort(key=lambda L: abs(_geom.polygon_area(L)), reverse=True)
    return loops


def cmd_usable_area(a):
    """Where the ground is gentle enough to USE — MEASURED, not drawn.

    Slope identifies ground gentle enough to use. This is deliberately NOT an
    entry in `site.areas[]`: those are regions the owner drew, and the rule that
    they are never model-generated protects against a model inventing INTENT and
    a later session reading the invented name as ground truth. An inferred name
    such as "back_fence" can point a design at the wrong part of the site.
    Nothing here names an intention. It reports a measurement, re-derivable
    from `data/terrain_scan.json` at any time, so it cannot
    drift into fiction the way a name can.

    In a measured region, 19% of the ground that reads as under 9 degrees is not
    scanned at all. `data/terrain.json` is a BFS-filled grid that INVENTS flat
    ground past the scan edge, so a naive
    slope < threshold mask hands the design phantom terraces — five cells along
    the east edge in that region. Every kept cell requires `scan_at` on itself.
    Gradients from filled neighbours are counted separately because those grades
    are partly interpolated. `best-bench` guards the same hazard by excluding
    candidates under 85% coverage.

    Flat is necessary and not sufficient: this says where the ground would let you
    stand, never that you would want to. Reaching it, what it looks at, and
    whether it should be paved at all are design questions, and `check-route`,
    `scene` and the owner answer those.
    """
    refused = _refuse_without_scan("usable-area")
    if refused:
        return refused
    step = float(a.step)
    max_slope = float(a.max_slope)
    if a.box:
        x0, y0, x1, y1 = json.loads(a.box)
        scope = "box"
    else:
        zones = {z["zone"]: z for z in _site().get("zones", [])}
        # NO ZONE NAMED: the largest measured one. A fixed name such as "back_yard"
        # need not exist on another site. Choose by measurement and say so.
        name = a.zone or (max(zones.values(), key=lambda z: z.get("area_m2") or 0)["zone"] if zones else None)
        z = zones.get(name)
        if not z:
            return {"error": f"no zone called {name!r}" if name else "no zones measured yet",
                    "known": sorted(zones), "fix": ["Survey the ground (Project settings), or "
                                                    "python3 tools/analyze_site.py"]}
        (x0, x1), (y0, y1) = z["bounds_m"]["x"], z["bounds_m"]["y"]
        scope = name if a.zone else f"{name} (the largest measured zone; name one with zone)"
    cells, gentle_but_unscanned, tested, slope_from_filled = set(), 0, 0, 0
    i0, i1 = int(math.floor(x0 / step)), int(math.ceil(x1 / step))
    j0, j1 = int(math.floor(y0 / step)), int(math.ceil(y1 / step))
    for i in range(i0, i1 + 1):
        for j in range(j0, j1 + 1):
            cx, cy = (i + 0.5) * step, (j + 0.5) * step
            deg = _cell_grade(cx, cy, step)
            if deg is None:
                continue
            tested += 1
            if deg > max_slope:
                continue
            # The CELL must be real ground — that is the bit you would stand on.
            # Its gradient leans on the four neighbours, and requiring those to be
            # scanned too erodes a region by one cell on every side. On a bench
            # ONE TO TWO CELLS WIDE, this can exclude 2 m2 of measured ground
            # and report it as unusable. Keep the cell, and report separately
            # how many kept cells have a gradient partly derived
            # from the filled grid, so the caller can weigh it instead of being
            # silently handed either phantom ground or none.
            if scan_at(cx, cy) is None:
                gentle_but_unscanned += 1
                continue
            cells.add((i, j))
            if not all(scan_at(px, py) is not None for px, py in
                       ((cx + step, cy), (cx - step, cy),
                        (cx, cy + step), (cx, cy - step))):
                slope_from_filled += 1
    loops = _trace_outline(cells, step)
    regions = []
    for L in loops:
        poly = [[round(x, 2), round(y, 2)] for x, y in L]
        area = abs(_geom.polygon_area(L))
        xs = [x for x, _ in L]
        ys = [y for _, y in L]
        regions.append({"area_m2": round(area, 1),
                        "bounds_m": {"x": [round(min(xs), 1), round(max(xs), 1)],
                                     "y": [round(min(ys), 1), round(max(ys), 1)]},
                        "polygon": poly})
    return {
        "scope": scope, "max_slope_deg": max_slope, "cell_m": step,
        "cells_tested": tested,
        "usable_area_m2": round(sum(r["area_m2"] for r in regions), 1),
        "regions": regions,
        "excluded_gentle_but_unscanned_cells": gentle_but_unscanned,
        "kept_but_slope_from_filled_cells": slope_from_filled,
        "note": "gentle AND standing on genuinely scanned ground. Cells whose own "
                "height is invented by the BFS-filled grid are excluded and counted; "
                "cells kept whose GRADIENT used a filled neighbour are counted too, "
                "because a bench one cell wide has interpolated ground either side of "
                "it and deleting those leaves nothing. This is a "
                "measurement, not a region the owner drew: it says where the ground "
                "would let you stand, never that you would want to stand there.",
    }


def cmd_scene(a):
    """Does this region compose as a PICTURE, or only as a plant list?

    Measure both a mixed herbaceous border (花境) and a painterly scene (画境),
    a view worth framing. These are different design intentions with shared
    measurable properties: height, season and colour. The tool measures what
    both need and grades neither.

    `composition` already answers what a design is MADE OF, in square metres of
    paving against planting. It cannot answer this: a region can be 33% planted,
    perfectly balanced, and still be a single flat textural layer that flowers
    pale in spring and does nothing for the rest of the year. A measured
    27-plant example has:

        6 species, and only TWO forms (14 mound, 13 grass)
        median height 0.50 m, nothing at all over 1.5 m
        18 of 27 flowering in spring, no autumn whatever
        every one of the six flower colours muted: greys, bone, dull gold

    These measurements expose a lack of height, seasonal and colour variety
    that the planted share alone cannot describe.

    Like `composition` this MEASURES AND DOES NOT GRADE. Arbitrary restrictions
    can hinder design choices: requiring three height layers does not establish
    quality and can contradict the owner's preferences. The tool reports
    layers, seasons and colours; the owner decides what the picture should be.
    """
    d = _measured(a.design)
    from plant_catalog import catalog          # the one reader of the user's catalogue
    palette = {p["species"]: p for p in catalog().get("plants", [])}

    region, where = None, "the whole design"
    if getattr(a, "area", None):
        ar = _area(a.area)
        if not ar:
            have = [x["name"] for x in _site().get("areas", [])]
            return {"error": f"no area named '{a.area}'", "available": have or "none drawn"}
        region, where = ar.get("polygon") or [], f"area '{a.area}'"
    elif getattr(a, "box", None):
        try:
            x0, y0, x1, y1 = json.loads(a.box)
        except Exception:
            return {"error": "--box wants [x0,y0,x1,y1]"}
        region = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
        where = f"box {[x0, y0, x1, y1]}"

    rows = []
    for p in d.get("plants", []) or []:
        pos = p.get("position") or []
        if len(pos) < 2:
            continue
        if region and not _inside(pos[0], pos[1], region):
            continue
        rows.append({**palette.get(p.get("species"), {}), **p})
    if not rows:
        return {"where": where, "plants": 0,
                "note": "nothing planted here — a picture needs something in it"}

    # LAYERS, because a picture has a foreground, a middle and a distance. The
    # bands are body-scale rather than chosen: what you look over, what you look
    # into, and what you look up at.
    bands = {"ground_under_0.3m": 0, "knee_0.3_0.8m": 0, "waist_0.8_1.5m": 0,
             "head_over_1.5m": 0}
    for r in rows:
        h = float(r.get("mature_height_m") or 0)
        key = ("ground_under_0.3m" if h < 0.3 else "knee_0.3_0.8m" if h < 0.8
               else "waist_0.8_1.5m" if h < 1.5 else "head_over_1.5m")
        bands[key] += 1

    colours, forms, species = {}, {}, {}
    for r in rows:
        for key, field in (("colours", "flower"), ("forms", "form"), ("species", "species")):
            v = r.get(field) or "(not declared)"
            locals()[key][v] = locals()[key].get(v, 0) + 1

    # how far apart the flower colours are, as the spread of their hues
    hexes = [c for c in colours if isinstance(c, str) and c.startswith("#") and len(c) == 7]
    sat = []
    for c in hexes:
        r_, g_, b_ = (int(c[i:i + 2], 16) / 255 for i in (1, 3, 5))
        mx, mn = max(r_, g_, b_), min(r_, g_, b_)
        sat.append(0.0 if mx == 0 else (mx - mn) / mx)

    return {
        "where": where,
        "design": os.path.basename(a.design or _agent.DESIGN_PATH),
        "plants": len(rows),
        "species": len(species),
        "forms": forms,
        "height_layers": bands,
        "layers_occupied": sum(1 for v in bands.values() if v),
        "tallest_m": round(max(float(r.get("mature_height_m") or 0) for r in rows), 2),
        "the_year": the_year(rows),
        "flower_colours": len(hexes),
        "colour_saturation": {"max": round(max(sat), 2) if sat else None,
                              "mean": round(sum(sat) / len(sat), 2) if sat else None},
        "note": "layers_occupied is how many of the four body-scale bands have anything "
                "in them: a picture needs something to look over, something to look into "
                "and something to look up at, and a region sitting in one band is a "
                "texture rather than a scene. the_year is what the region does across "
                "the year (composition's own measure, one owner) — a season with nothing "
                "in flower is a season the picture is blank. colour_saturation near 0 means every flower here is a grey. "
                "None of these is a rule; they are the numbers a designer gets for free "
                "by standing there in October.",
    }


# Crowns that overlap by at least this share of the smaller one's width are REPORTED — the
# smaller is half inside the other at full size. Whether that is a carpet knitting under a
# grass or two shrubs growing into each other is the designer's reading, not this file's.
OVERLAP_REPORTED = 0.5


def own_kind_nearest(plants):
    """The share of plants whose nearest neighbour is their OWN species, over the plants that
    have any kin in the planting — a DIAGNOSTIC for a scatter, never a score.

    Reference plantings read 0.64-0.79; shuffling their species among the same positions
    gives 0.06-0.26. But this does not rank good designs: a preferred design reads 0.38
    while a rejected one reads 0.93, so it measures arrangement, not quality. Low
    indicates no drifts, which an intermingled matrix planting means to do."""
    same = n = 0
    by = {}
    for p in plants:
        by.setdefault(p["species"], 0)
        by[p["species"]] += 1
    for a in plants:
        if by[a["species"]] < 2:
            continue                 # a specimen has no kin to be near
        near = min((math.dist(a["position"][:2], b["position"][:2]), b["species"] == a["species"])
                   for b in plants if b is not a)
        n += 1
        same += near[1]
    return round(same / n, 2) if n else None


def crowns_overlapping(plants, tree_height_m=None):
    """Pairs of DIFFERENT species whose mature crowns overlap by OVERLAP_REPORTED of the
    smaller's width or more, split by whether they grow at one height (the taller under
    twice the shorter) or one stands over the other. Trees are left out: a crown overhead
    is not ground (bed_mature_coverage says the same). Measured, not judged."""
    tree = _agent.TREE_HEIGHT_M if tree_height_m is None else tree_height_m
    ps = [p for p in plants if (p.get("mature_height_m") or 0) < tree]
    level, layered = [], []
    for i, a in enumerate(ps):
        for b in ps[i + 1:]:
            if a["species"] == b["species"]:
                continue
            ra, rb = (a.get("mature_spread_m") or 0) / 2, (b.get("mature_spread_m") or 0) / 2
            if not ra or not rb:
                continue
            share = (ra + rb - math.dist(a["position"][:2], b["position"][:2])) / (2 * min(ra, rb))
            if share < OVERLAP_REPORTED:
                continue
            ha, hb = a.get("mature_height_m") or 0, b.get("mature_height_m") or 0
            pair = (round(min(share, 1.0), 2), a, b)
            (layered if max(ha, hb) >= 2 * max(min(ha, hb), 0.01) else level).append(pair)
    name = lambda p: f"{p['id']} {p.get('common') or p['species']}"
    return {"at_one_height": len(level), "one_over_another": len(layered),
            "at_one_height_most": [f"{name(a)} / {name(b)}: {int(sh * 100)}% of the smaller crown"
                                   for sh, a, b in sorted(level, key=lambda t: -t[0])[:4]]}


SEASONS = ("winter", "spring", "summer", "autumn")


def seasons_of(bloom):
    """The catalogue's `bloom` ("spring", "summer_autumn", "winter_spring", "late_spring")
    as the seasons it covers, running forward through the year."""
    parts = [x for x in str(bloom or "").split("_") if x in SEASONS]
    if len(parts) == 2:
        i, j = SEASONS.index(parts[0]), SEASONS.index(parts[1])
        return [SEASONS[(i + k) % 4] for k in range((j - i) % 4 + 1)]
    return parts[:1]


def colour_family(hex_colour):
    """A flower colour's name, the way a designer says it — from the catalogue's hex."""
    import colorsys
    try:
        r, g, b = (int(hex_colour[i:i + 2], 16) / 255 for i in (1, 3, 5))
    except (TypeError, ValueError, IndexError):
        return None
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    h *= 360
    if s < 0.18 or (l > 0.82 and s < 0.5):
        return "white/cream"
    if h < 15 or h >= 345:
        return "pink" if l > 0.68 else "red"
    if h < 42:
        return "orange"
    if h < 70:
        return "yellow"
    if h < 170:
        return "green"
    if h < 245:
        return "blue"
    if h < 290:
        return "violet"
    return "pink" if l > 0.6 else "magenta"


def the_year(plants, tree_height_m=None):
    """What the planting does season by season, from the catalogue: the share of the
    ground-layer canopy (at full size) in flower, and in which colours; and the evergreen
    share, which is what holds the garden in winter. A MEASUREMENT: the method asks
    the designer to plan the year, and this is how to check it. The seasons are the
    catalogue's, coarse — a plant in flower "all summer" counts all summer."""
    from plant_catalog import catalog
    cat = {r["species"]: r for r in catalog().get("plants", [])}
    tree = _agent.TREE_HEIGHT_M if tree_height_m is None else tree_height_m
    ps = [p for p in plants if (p.get("mature_height_m") or 0) < tree]
    area = lambda p: math.pi * ((p.get("mature_spread_m") or 0) / 2) ** 2
    total = sum(area(p) for p in ps)
    if not total:
        return None
    out = {}
    for season in SEASONS:
        colours = {}
        for p in ps:
            r = cat.get(p["species"]) or {}
            if season in seasons_of(r.get("bloom")):
                fam = colour_family(r.get("flower")) or "unrecorded"
                colours[fam] = colours.get(fam, 0) + area(p)
        out[season] = {"in_flower": round(sum(colours.values()) / total, 2),
                       "colours": {k: round(v / total, 2)
                                   for k, v in sorted(colours.items(), key=lambda kv: -kv[1])[:4]}}
    out["evergreen"] = round(sum(area(p) for p in ps if (cat.get(p["species"]) or {}).get("evergreen")) / total, 2)
    return out


def planting_character(design):
    """What a planting is MADE OF: species, forms, mass size and height.

    Reported, never enforced — taste is the designer's. A varied reference planting has
    21 species, no touching mass of one species over 7, and a third of its plants upright;
    more uniform plantings have half the species, masses of 10-35, and a low, flat
    majority. The reference numbers live in DESIGNING.md, once.
    """
    import collections
    from plant_catalog import catalog
    cat = {r["species"]: r for r in catalog().get("plants", [])}
    plants = design.get("plants") or []
    n = len(plants)
    if not n:
        return {"species": 0, "forms": {}, "upright_share": 0.0, "largest_mass": None,
                "note": "no plants"}
    form = lambda p: p.get("form") or (cat.get(p["species"]) or {}).get("form") or "unknown"
    forms = collections.Counter(form(p) for p in plants)
    # a MASS: plants of one species whose mature canopies touch, followed from plant to plant
    best = (0, "")
    by = collections.defaultdict(list)
    for p in plants:
        by[p["species"]].append(p)
    for sp, ps in by.items():
        seen = set()
        for i in range(len(ps)):
            if i in seen:
                continue
            seen.add(i)
            stack, size = [i], 0
            while stack:
                a = ps[stack.pop()]
                size += 1
                for j in range(len(ps)):
                    if j in seen:
                        continue
                    b = ps[j]
                    reach = (a.get("mature_spread_m", 0) + b.get("mature_spread_m", 0)) / 2 * 1.15
                    if math.dist(a["position"], b["position"]) <= reach:
                        seen.add(j)
                        stack.append(j)
            best = max(best, (size, sp))
    return {"species": len(by),
            "forms": {k: round(v / n, 2) for k, v in forms.most_common()},
            "upright_share": round(sum(1 for p in plants if p.get("mature_height_m", 0) >= 0.9) / n, 2),
            "largest_mass": {"plants": best[0], "species": best[1]},
            "own_kind_nearest": own_kind_nearest(plants),
            "crowns_overlapping": crowns_overlapping(plants),
            "the_year": the_year(plants),
            "note": "species, the mix of forms, the share of plants 0.9 m or taller, the "
                    "biggest group of ONE species whose mature canopies touch, the share of "
                    "plants whose nearest neighbour is their own kind (under ~0.3 is a scatter; "
                    "above it, not a score), crowns of different plants half inside one "
                    "another at full size, and the_year: per season the share of the planting "
                    "in flower and its colours, and the evergreen share that holds winter. Reference measurements: "
                    "DESIGNING.md, 'A sea is one plant, big and low' and 'Spacing is yours'. "
                    "Reported, not a rule."}


def cmd_composition(a):
    """What the design is MADE OF, as shares of the zone's real ground.

    Every other tool here answers about one thing: this pad, that route, this
    region. A garden is also a BALANCE: adding one reasonable path at a time
    can fill the site with paving without any single op looking wrong. A
    measured comparison shows path area increasing 21.5 -> 46.5 m2 while plant
    count falls 58 -> 41 in MORE bed area. Beds twice as large and half as full
    look sparsely planted even though more ground is reserved for planting.

    Deliberately not a rule. The right balance is taste — a courtyard and a
    meadow are both correct. Arbitrary restrictions can hinder design choices;
    even a plausible connectivity rule can reject the owner's preferred design.
    This measures and does not grade. It is the number a human designer gets
    for free by standing in the garden and looking.

    Sampled on a 0.5 m grid over genuinely scanned ground, so the shares are of
    real yard, not of a bounding box. Paving counts ahead of planting where the
    two overlap, which is what a path through a bed actually is.
    """
    d = _measured(a.design)
    zones = _site().get("zones", [])
    if not zones:
        return {"error": "no zones — run tools/analyze_site.py first"}

    ribbons = [(o["spline"], (o.get("width_m") or 1.2) / 2.0, key)
               for key in ("paths", "steps")
               for o in d.get(key, []) if len(o.get("spline") or []) > 1]
    polys = [(o["polygon"], key) for key in ("patios", "beds")
             for o in d.get(key, []) if len(o.get("polygon") or []) > 2]

    def classify(x, y):
        for spline, half, key in ribbons:
            if _covers_ribbon(x, y, spline, half):
                return key
        for poly, key in polys:
            if _inside(x, y, poly):
                return key
        return "open"

    # Which zone to report: the one the design actually sits in, unless asked.
    def zone_of(px, py):
        for z in zones:
            b = z["bounds_m"]
            if b["x"][0] <= px <= b["x"][1] and b["y"][0] <= py <= b["y"][1]:
                return z
        return None

    zone = None
    if getattr(a, "zone", None):
        zone = next((z for z in zones if z["zone"] == a.zone), None)
        if not zone:
            return {"error": f"no zone named '{a.zone}'",
                    "available": [z["zone"] for z in zones]}
    else:
        tally = {}
        for poly, _ in polys:
            z = zone_of(*poly[0])
            if z:
                tally[z["zone"]] = tally.get(z["zone"], 0) + _poly_area(poly)
        for pl in d.get("plants", []):
            z = zone_of(*pl["position"][:2])
            if z:
                tally[z["zone"]] = tally.get(z["zone"], 0) + 1
        name = max(tally, key=tally.get) if tally else zones[0]["zone"]
        zone = next(z for z in zones if z["zone"] == name)

    b = zone["bounds_m"]
    step = 0.5
    cell = step * step
    counts = {"paths": 0.0, "steps": 0.0, "patios": 0.0, "beds": 0.0, "open": 0.0}
    hard_grade = {"under_9deg": 0.0, "9_to_18": 0.0, "over_18": 0.0}
    scanned = 0
    y = b["y"][0]
    while y <= b["y"][1]:
        x = b["x"][0]
        while x <= b["x"][1]:
            if scan_at(x, y) is not None:
                scanned += 1
                k = classify(x, y)
                counts[k] += cell
                if k in ("paths", "steps", "patios"):
                    g = _cell_grade(x, y)
                    if g is not None:
                        hard_grade["under_9deg" if g < 9 else
                                   "9_to_18" if g < 18 else "over_18"] += cell
            x += step
        y += step

    ground = scanned * cell
    if ground <= 0:
        return {**(_no_scan_notice() or {}), "zone": zone["zone"],
                "zone_area_m2": 0, "note": "no scanned ground inside this zone"}

    hard = counts["paths"] + counts["steps"] + counts["patios"]
    planted, opn = counts["beds"], counts["open"]
    pct = lambda v: round(100.0 * v / ground, 1)
    n_plants = sum(1 for pl in d.get("plants", [])
                   if b["x"][0] <= pl["position"][0] <= b["x"][1]
                   and b["y"][0] <= pl["position"][1] <= b["y"][1])

    out = {"design": os.path.basename(a.design or "design.json"),
           "zone": zone["zone"],
           "zone_area_m2": round(ground, 1),
           "hardscape_m2": round(hard, 1), "hardscape_pct": pct(hard),
           "planted_m2": round(planted, 1), "planted_pct": pct(planted),
           "open_m2": round(opn, 1), "open_pct": pct(opn),
           "hardscape_by_kind_m2": {"path": round(counts["paths"], 1),
                                    "patio": round(counts["patios"], 1),
                                    "steps": round(counts["steps"], 1)},
           "hardscape_by_grade_m2": {k: round(v, 1) for k, v in hard_grade.items()},
           "plants": n_plants,
           "planting_density_m2_per_plant": (round(planted / n_plants, 2)
                                             if n_plants else None),
           # AT FULL MATURITY, bed by bed: the density a design is spaced
           # for, not the ~5-year picture the viewer draws by default
           "mature_coverage_by_bed": _agent.bed_mature_coverage(d),
           "character": planting_character(d),
           "note": "shares of genuinely scanned ground on a 0.5 m grid; paving "
                   "counts ahead of planting where they overlap, because a path "
                   "crossing a bed is paving. Density is bed area per plant: a "
                   "knitted drift comes out near 1 m2 each, a specimen planting "
                   "several times that. mature_coverage_by_bed is each bed's "
                   "canopy at FULL maturity over its own ground: about 1.0-1.3x "
                   "closes, over 1.6x the plants are growing into each other. "
                   "hardscape_by_grade says where the paving "
                   "landed — paving on ground over 18 deg is paving that had to "
                   "be cut in."}
    # Rounding the three shares independently can land on 99.9 or 100.1; the
    # largest share absorbs it so they read as a partition, which is what they are.
    drift = round(100.0 - (out["hardscape_pct"] + out["planted_pct"] + out["open_pct"]), 1)
    if drift:
        biggest = max(("hardscape_pct", "planted_pct", "open_pct"), key=lambda k: out[k])
        out[biggest] = round(out[biggest] + drift, 1)
    notice = _no_scan_notice()
    return {**notice, **out} if notice else out


def cmd_crowding(a):
    """Which SAVED designs are crowded at full maturity, bed by bed.

    For the viewer's Saved list: a count such as `203 plants · 31 species` does
    not reveal crowding, and variants that read alike by count can differ past 2.0x
    mature coverage, so coverage helps the owner compare them. The measurement is
    agent.bed_mature_coverage and the bands are agent.MATURE_COVERAGE_BANDS; this
    only walks the folder, so the dev server has no geometry of its own to drift.
    """
    folder = project.data("designs")
    names = [n for n in (a.names.split(",") if a.names else []) if n]
    if not names:
        names = sorted(f[:-5] for f in os.listdir(folder) if f.endswith(".json"))
    out = {}
    for name in names:
        path = os.path.join(folder, os.path.basename(name) + ".json")
        try:
            with open(path) as f:
                beds = _agent.bed_mature_coverage(json.load(f))
        except (OSError, ValueError, KeyError, TypeError):
            continue                       # an unreadable variant still gets a row
        over = sorted(((m["coverage"], bid) for bid, m in beds.items()
                       if m["coverage"] is not None and m["coverage"] >= _agent.MATURE_COVERAGE_WARN),
                      reverse=True)
        out[name] = {"beds_measured": len(beds),
                     "over": [{"bed": bid, "coverage": cov, "reading": beds[bid]["reading"]}
                              for cov, bid in over]}
    return {"warn_from": _agent.MATURE_COVERAGE_WARN, "designs": out}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("ground", help="ground elevation at a point")
    p.add_argument("x", type=float); p.add_argument("y", type=float)
    p.set_defaults(fn=cmd_ground)

    p = sub.add_parser("slope", help="local slope, downhill bearing and what the grade suits")
    p.add_argument("x", type=float); p.add_argument("y", type=float)
    p.add_argument("--radius", type=float, default=2.0)
    p.set_defaults(fn=cmd_slope)

    p = sub.add_parser("ground-many", help="ground at MANY points in one call")
    p.add_argument("points", help='JSON [[x,y],...]')
    p.set_defaults(fn=cmd_ground_many)

    p = sub.add_parser("slope-many", help="slope at MANY points in one call, flattest named")
    p.add_argument("points", help='JSON [[x,y],...]')
    p.add_argument("--radius", type=float, default=2.0)
    p.set_defaults(fn=cmd_slope_many)

    p = sub.add_parser("profile", help="ground along a line, with grades")
    p.add_argument("x1", type=float); p.add_argument("y1", type=float)
    p.add_argument("x2", type=float); p.add_argument("y2", type=float)
    p.add_argument("--step", type=float, default=2.0)
    p.set_defaults(fn=cmd_profile)

    p = sub.add_parser("check-pad", help="cut/fill for a level pad, without committing it")
    p.add_argument("polygon", help='JSON [[x,y],...]')
    p.add_argument("--level", type=float, default=None,
                   help="omit to get the best-balanced level")
    p.set_defaults(fn=cmd_check_pad)

    p = sub.add_parser("check-route", help="circulation along a proposed path: walked vs stepped")
    p.add_argument("spline", help='JSON [[x,y],...]')
    p.add_argument("--width", type=float, default=1.2)
    # The level and steps are context the VALIDATOR needs. Without them a bare
    # list of points grades the underlying ground instead of the built route.
    p.add_argument("--level", type=float, default=None,
                   help="the path declares this level_m — it IS the bench, so the "
                        "slope underneath is not what is walked")
    p.add_argument("--steps", default=None,
                   help='JSON steps[] already in the design; a stretch a flight '
                        'covers is stepped, not a failed ramp')
    p.set_defaults(fn=cmd_check_route)

    p = sub.add_parser("best-bench", help="search a region for the cheapest level pad")
    p.add_argument("x0", type=float); p.add_argument("y0", type=float)
    p.add_argument("x1", type=float); p.add_argument("y1", type=float)
    p.add_argument("--across", type=float, default=4.0)
    p.add_argument("--along", type=float, default=6.0)
    p.add_argument("--top", type=int, default=5)
    p.set_defaults(fn=cmd_best_bench)

    p = sub.add_parser("composition", help="what a design is MADE OF: hardscape vs planted vs open")
    p.add_argument("--design", default=None)
    p.add_argument("--zone", default=None)
    p.set_defaults(fn=cmd_composition)

    p = sub.add_parser("scene", help="does a region compose as a PICTURE: layers, seasons, colour")
    p.add_argument("--design", default=None)
    p.add_argument("--area", default=None, help="scope to a region the owner drew")
    p.add_argument("--box", default=None, help="scope to [x0,y0,x1,y1]")
    p.set_defaults(fn=cmd_scene)

    p = sub.add_parser("areas", help="list the regions the owner has drawn")
    p.set_defaults(fn=cmd_areas)

    p = sub.add_parser("area", help="everything measurable about one drawn region")
    p.add_argument("name")
    p.add_argument("--design", default=None)
    p.set_defaults(fn=cmd_area)

    p = sub.add_parser("near", help="what is already within a radius")
    p.add_argument("x", type=float); p.add_argument("y", type=float)
    p.add_argument("--radius", type=float, default=3.0)
    p.add_argument("--design", default=None)
    p.set_defaults(fn=cmd_near)

    p = sub.add_parser("check-ops", help="dry-run a proposed op list; writes nothing")
    p.add_argument("ops", nargs="?", help='JSON [{tool,input},...] or {"ops":[...]}')
    p.add_argument("--ops-file", help="read the op list from a file instead")
    p.add_argument("--design", default=None)
    p.set_defaults(fn=cmd_check_ops)

    p = sub.add_parser("apply-ops", help="run an op list for REAL and write it")
    p.add_argument("ops", nargs="?", help='JSON [{tool,input},...] or {"ops":[...]}')
    p.add_argument("--ops-file", help="read the op list from a file instead")
    p.add_argument("--design", default=None)
    p.set_defaults(fn=cmd_apply_ops)

    p = sub.add_parser("save-owner",
                       help="merge a viewer edit into the OWNER half of site.json (patch on stdin)")
    p.add_argument("--site", default=None)
    p.set_defaults(fn=cmd_save_owner)

    p = sub.add_parser("validate", help="run the real validator on a draft")
    p.add_argument("--design", default=None)
    p.set_defaults(fn=cmd_validate)

    p = sub.add_parser("zones", help="the measured yard zones and their grade breakdown")
    p.set_defaults(fn=cmd_zones)

    p = sub.add_parser("usable-area",
                       help="where the ground is gentle enough to use, measured")
    p.add_argument("--zone", default=None, help="a measured zone (see `zones`); default the largest")
    p.add_argument("--box", default=None, help="[x0,y0,x1,y1] instead of a zone")
    p.add_argument("--max-slope", type=float, default=9.0, dest="max_slope")
    p.add_argument("--step", type=float, default=1.0)
    p.set_defaults(fn=cmd_usable_area)

    p = sub.add_parser("constraints", help="the limits this site is judged against")
    p.set_defaults(fn=cmd_constraints)

    p = sub.add_parser("crowding", help="which SAVED designs are crowded at full maturity, bed by bed")
    p.add_argument("--names", default="", help="comma-separated design names; default every saved design")
    p.set_defaults(fn=cmd_crowding)

    a = ap.parse_args()
    if getattr(a, "design", None):
        a.design = project.resolve(a.design)   # "data/designs/x.json" is the active project's
    from agent import budget_from_env
    budget_note = budget_from_env(a.cmd)
    if budget_note:
        print(budget_note, file=sys.stderr)
    # Log every invocation. `claude -p` prints only its final answer, so without
    # this there is no way to tell whether the model actually queried the site or
    # simply guessed well — and "did the tools help" is the whole question this
    # architecture has to answer.
    # YARDTWIN_CALL_LOG so a test run, or anything else that is not real traffic,
    # can be pointed somewhere else. This file is the EVIDENCE for traffic
    # measurements; adding test traffic or deleting rows makes those figures
    # impossible to reproduce. tests/conftest.py sets this for the whole suite.
    # THE OUTCOME, not just the request: cmd and args alone cannot show whether
    # the agent was refused or why. Record the result so refusals can be reviewed.
    #
    # Record crashes as well as results: a call that takes the process down is
    # worth knowing about. `looked_at_own_work` reads `cmd` and `rendered` and is
    # unaffected by fields being ADDED.
    log_path = os.environ.get("YARDTWIN_CALL_LOG") or project.data("site_api_calls.log")
    row = {"cmd": a.cmd, "args": {k: v for k, v in vars(a).items()
                                  if k not in ("fn", "cmd")}}

    def _write():
        try:
            with open(log_path, "a") as lf:
                lf.write(json.dumps(row, default=str) + "\n")
        except Exception:
            pass                                # logging must never break a query

    try:
        out = a.fn(a)
    except NoSite as e:
        # Already a formed answer, not an exception message. Same exit code as an
        # unraycast property: both mean "this property is not set up far enough to
        # ask that", which is a fact about the yard rather than about the query —
        # and a THIRD meaning for a shell's one byte would be worse than two.
        print(e.args[0])
        row.update(ok=False, exit=2, refused="no_site")
        _write()
        sys.exit(2)
    except BaseException as e:                   # a tool must never hand back a traceback
        row.update(ok=False, exit=1, refused=f"{type(e).__name__}")
        _write()
        if isinstance(e, Exception):
            print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
            sys.exit(1)
        raise                                    # Ctrl-C and SystemExit stay themselves
    print(json.dumps(out, indent=1))
    # THREE exit codes, because $? is the only part of this a shell script or a
    # model checking a command's success ever sees. 0 answered, 1 this query is
    # broken, 2 this property is not set up far enough to ask — never raycast
    # (no_scan), or no site.json at all (no_site, see NoSite). tools/sun.py's north gate
    # uses the same split: a refusal exiting 0 is indistinguishable from an
    # answer to anything downstream. Keep the meaning of 2 consistent across
    # the repo.
    #
    # The refusal gate must preserve legitimate scripted use:
    #
    #   * READING the ground before it is measured is never legitimate — that is
    #     the bug. CLAUDE.md's onboarding order is geodata.py -> open the viewer
    #     -> Fit ground / Set north / lock the scale -> analyze_site.py -> query,
    #     so nothing documented asks a ground question before the raycast exists.
    #   * WRITING before it is measured is the normal case, and it is the one that
    #     must remain available. viewer/vite.config.js shells `site_api.py save-owner`
    #     for every landmark and drawn area and `apply-ops` for every placement,
    #     and both happen BEFORE analyze_site in that same order. Neither is gated:
    #     no _refuse_without_scan in cmd_save_owner or cmd_apply_ops, deliberately,
    #     and tests/test_site_no_scan.py pins that they still exit 0.
    #   * `near`, `areas` and `constraints` read the design, the owner's polygons
    #     and site.json — no ground, no gate.
    #
    # The viewer parses stdout and ignores $?, but the writers deliberately stay
    # outside the gate so shell callers also receive the correct success code.
    code = 0
    refused = None
    if isinstance(out, dict):
        if out.get("error"):
            code, refused = 1, str(out["error"])[:120]
        elif out.get("no_scan") or out.get("no_site"):
            code, refused = 2, "no_scan" if out.get("no_scan") else "no_site"
    row.update(ok=code == 0, exit=code, **({"refused": refused} if refused else {}))
    if getattr(a, "_touched", None) is not None:
        row["touched"] = a._touched
    _write()
    sys.exit(code)


if __name__ == "__main__":
    main()
