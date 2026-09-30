#!/usr/bin/env python3
"""COMPOSE A PLANTING FROM DRAWN MASSES — the designer draws the shapes, this fills them.

Draw the masses before choosing individual coordinates (DESIGNING.md): sketch
their footprints in metres, then place plants within those shapes. Computing the
coordinates here avoids hand-written placements and separate spacing rules.

The designer's call stays the designer's: WHICH species, HOW MANY, and the SHAPE
of each mass — an outline, or an ellipse that can be long, narrow and turned. This
spreads each mass's plants evenly THROUGH its own shape (Lloyd relaxation on a fine
grid of the shape), so the drift keeps the outline that was drawn instead of
collapsing to the nearest free points (DESIGNING.md warns about exactly that). The
fill stays inside the bed, off the paths and patios and clear of objects. Where two
drifts are drawn to overlap they are planted THROUGH each other — a carpet under a
grass, a scatter of alliums in a sage — because how close plants stand is the
designer's decision. The only ground not offered is ground nobody could plant:
within one planting hole of a plant already there, or in a tree's trunk
(`agent.one_hole`, the validator's own rule). When the shape cannot hold the count it
SAYS SO rather than squeezing.

It writes ops. It applies nothing — `site_api.py check-ops --ops-file` and
`apply-ops` are still the one write path, and their validator is the one judge.

    python3 tools/compose.py COMPOSITION.json --ops ops.json [--plan plan.png]

    {"design": "data/designs/X.json",
     "replace_in": ["bed_a"],          # beds whose other plants are removed ("all" for every bed)
     "keep": ["p3"],                   # ...except these
     "masses": [{"species": "Salvia leucophylla", "count": 5, "bed": "bed_a",
                 "ellipse": [13.2, -2.0, 1.8, 0.9, 30]},        # cx, cy, rx, ry, degrees
                {"species": "Carex pansa", "count": 5, "bed": "bed_a",
                 "along": [0.2, 0.45], "across": [0, 0.5]},     # a PART of the bed: along its long
                                                                # axis (0 = south/west end), across it
                                                                # (0 = west/north side)
                {"species": "Thymus vulgaris", "count": 9, "shape": [[x, y], ...], "loose": 0.2}],
     "place": [{"species": "Olea europaea (fruitless)", "at": [15.1, -3.0]}],
     "beds": [{"id": "bed_a", "outline": [[x, y], ...], "mulch": "gravel"}]}   # drawn ROUGH:
                                       # trimmed to the paths, terraces and house (below)

It never chooses for you (AGENTS.md: code measures, the LLM decides). The count is
yours; each mass's report MEASURES what it makes — how far apart its plants stand on
centre, as a share of their mature spread, how many would sit one mature spread apart,
which other plants already stand in the shape — as information, not a verdict. Every plant lands inside the shape you drew — nothing grows a
drift beyond its outline, and nothing re-places one after.

Species come from the palette (botanical or common name); a species only in the
design is copied from its plant there.
"""
from __future__ import annotations
import argparse
import collections
import json
import math
import os
import project  # the active project's files — the ONE owner
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import agent      # noqa: E402  _near_corridor: the validator's own "on the path" test
import replant    # noqa: E402  dist_to_edge
from geom import point_in_polygon, polygon_area  # noqa: E402
from plant_catalog import catalog  # noqa: E402  the one palette reader
from planting_plan import spacing_on_centre  # noqa: E402  the schedule's SPACING O.C.

INSET_M = 0.15          # a plant centre this far inside the bed line, not on it
PATH_CLEAR_M = 0.15     # ...and this far off a path's edge (its canopy may overhang)
OBJECT_CLEAR_M = 0.35   # ...and from an object's centre: a stone the planting touches, not buries
FIELDS = ("species", "common", "mature_height_m", "mature_spread_m", "form", "foliage", "flower")


def species_record(name, design=None):
    """A place_plants entry (without position) for a botanical or common name."""
    want = name.strip().lower()
    for r in catalog().get("plants", []):
        names = [r.get("species", ""), r.get("common", "")] + list(r.get("aliases") or [])
        if want in (n.lower() for n in names if n):
            return {k: r[k] for k in FIELDS if r.get(k) is not None}
    for p in (design or {}).get("plants", []):
        if want in (str(p.get("species", "")).lower(), str(p.get("common", "")).lower()):
            return {k: p[k] for k in FIELDS if p.get(k) is not None}
    raise KeyError(f"no species called {name!r} in the palette or the design — "
                   "data/plant_palette.json lists what there is")


def ellipse(cx, cy, rx, ry, deg=0.0, n=20):
    t = math.radians(deg)
    c, s = math.cos(t), math.sin(t)
    return [[cx + rx * math.cos(a) * c - ry * math.sin(a) * s,
             cy + rx * math.cos(a) * s + ry * math.sin(a) * c]
            for a in (2 * math.pi * k / n for k in range(n))]


def _edge_dist(x, y, poly):
    return replant.dist_to_edge(x, y, poly)


def bed_frame(bed, step=0.2):
    """A bed's own axes, from its interior: `along` is its long axis, running south to north
    (west to east when it lies east-west); `across` is that turned a quarter clockwise, so its
    0 is the west side of a north-south bed and the north side of an east-west one."""
    xs, ys = [p[0] for p in bed], [p[1] for p in bed]
    pts = [(x, y) for x in _frange(min(xs), max(xs), step) for y in _frange(min(ys), max(ys), step)
           if point_in_polygon(x, y, bed)] or [tuple(p[:2]) for p in bed]
    mx = sum(p[0] for p in pts) / len(pts)
    my = sum(p[1] for p in pts) / len(pts)
    sxx = sum((p[0] - mx) ** 2 for p in pts); syy = sum((p[1] - my) ** 2 for p in pts)
    sxy = sum((p[0] - mx) * (p[1] - my) for p in pts)
    a = 0.5 * math.atan2(2 * sxy, sxx - syy)                     # the long axis
    u = (math.cos(a), math.sin(a))
    if u[1] < -1e-9 or (abs(u[1]) <= 1e-9 and u[0] < 0):          # south->north, else west->east
        u = (-u[0], -u[1])
    v = (u[1], -u[0])                                             # a quarter clockwise
    pa = [(p[0] - mx) * u[0] + (p[1] - my) * u[1] for p in pts]
    pc = [(p[0] - mx) * v[0] + (p[1] - my) * v[1] for p in pts]
    runs = "south to north" if abs(u[1]) >= abs(u[0]) else "west to east"
    return {"origin": (mx, my), "u": u, "v": v, "along": (min(pa), max(pa)),
            "across": (min(pc), max(pc)), "runs": runs,
            "across_from": "the west side" if runs == "south to north" else "the north side"}


def _frange(a, b, step):
    x = a + step / 2
    while x < b:
        yield x
        x += step


def part_of_bed(bed, along=(0, 1), across=(0, 1)):
    """The rectangle of a bed's own frame between those fractions — a drift drawn as a PART
    of its bed ("the west third, near side"), which free_ground then trims to the bed."""
    f = bed_frame(bed)
    (a0, a1), (c0, c1) = f["along"], f["across"]
    A = [a0 + t * (a1 - a0) for t in along]
    C = [c0 + t * (c1 - c0) for t in across]
    ox, oy = f["origin"]
    return [[ox + a * f["u"][0] + c * f["v"][0], oy + a * f["u"][1] + c * f["v"][1]]
            for a, c in ((A[0], C[0]), (A[1], C[0]), (A[1], C[1]), (A[0], C[1]))], f


def mass_shape(mass, bed=None):
    if mass.get("along") is not None or mass.get("across") is not None:
        if bed is None:
            raise ValueError(f"{mass['species']}: `along`/`across` are parts of a BED — name the bed")
        return part_of_bed(bed, mass.get("along") or (0, 1), mass.get("across") or (0, 1))[0]
    if mass.get("shape"):
        return [list(p[:2]) for p in mass["shape"]]
    if mass.get("ellipse"):
        return ellipse(*mass["ellipse"])
    return None


def free_ground(shape, bed, design, placed, record, step):
    """Grid points a plant of `record` may stand on inside `shape` (and its bed).

    Returns (free points, shape_points, taken): `shape_points` is the drawn shape
    inside the bed, and `taken` counts, per plant name, the shape points lost to a plant
    already standing there (its planting hole, or a tree's trunk) — so a collision names
    what it collided with. Nothing else is taken: drawn overlaps interplant."""
    xs, ys = [p[0] for p in shape], [p[1] for p in shape]
    obstacles = [(o["position"][0], o["position"][1]) for o in design.get("objects", []) if o.get("position")]
    paths = [(p.get("spline") or p.get("points") or [], float(p.get("width_m") or 0) / 2)
             for p in design.get("paths", []) + design.get("steps", [])]
    patios = [p["polygon"] for p in design.get("patios", []) if p.get("polygon")]
    others = [(q["position"][0], q["position"][1], q.get("common") or q["species"],
               agent.one_hole(record, q)[0])
              for q in placed]
    out, in_shape, taken = [], 0, {}
    y = min(ys) + step / 2
    while y < max(ys):
        x = min(xs) + step / 2
        while x < max(xs):
            ok = point_in_polygon(x, y, shape)
            if ok and bed is not None:
                ok = point_in_polygon(x, y, bed) and _edge_dist(x, y, bed) >= INSET_M
            if ok:
                in_shape += 1
                ok = not any(point_in_polygon(x, y, p) for p in patios)
            if ok:
                ok = not any(len(line) > 1 and agent._near_corridor((x, y), line, half + PATH_CLEAR_M)
                             for line, half in paths)
            if ok:
                ok = all(math.hypot(x - ox, y - oy) >= OBJECT_CLEAR_M for ox, oy in obstacles)
            if ok:
                hit = next((name for ox, oy, name, need in others if math.hypot(x - ox, y - oy) < need), None)
                if hit:
                    taken[hit] = taken.get(hit, 0) + 1
                    ok = False
            if ok:
                out.append((x, y))
            x += step
        y += step
    return out, in_shape, taken


def fill(ground, n, seed, loose=0.0, iterations=30, floor=0.0):
    """n points spread evenly through `ground` (a list of grid points): farthest-point
    seeding, then Lloyd relaxation — each point moves to the centre of the ground
    nearest it, so the set covers the SHAPE rather than clumping or lining up.

    EVENLY is the arithmetic asked for, so its yardstick is the drift's own pitch — the
    count and the shape the designer gave — never a spacing of this file's choosing.
    `floor` is the one physical limit: no two points nearer (one planting hole)."""
    if n <= 0 or not ground:
        return []
    n = min(n, len(ground))
    cx = sum(p[0] for p in ground) / len(ground)
    cy = sum(p[1] for p in ground) / len(ground)
    pts = [min(ground, key=lambda p: (p[0] - cx) ** 2 + (p[1] - cy) ** 2)]
    d = [(p[0] - pts[0][0]) ** 2 + (p[1] - pts[0][1]) ** 2 for p in ground]
    while len(pts) < n:
        k = max(range(len(ground)), key=d.__getitem__)
        pts.append(ground[k])
        d = [min(d[i], (g[0] - ground[k][0]) ** 2 + (g[1] - ground[k][1]) ** 2) for i, g in enumerate(ground)]
    for _ in range(iterations):
        sx, sy, sc = [0.0] * n, [0.0] * n, [0] * n
        for g in ground:
            j = min(range(n), key=lambda j: (g[0] - pts[j][0]) ** 2 + (g[1] - pts[j][1]) ** 2)
            sx[j] += g[0]
            sy[j] += g[1]
            sc[j] += 1
        # the centroid of a non-convex cell can fall outside the shape: snap it back
        pts = [min(ground, key=lambda g: (g[0] - sx[j] / sc[j]) ** 2 + (g[1] - sy[j] / sc[j]) ** 2)
               if sc[j] else pts[j] for j in range(n)]
    if loose > 0 and n > 1:
        rng = random.Random(seed)
        pitch = math.sqrt(len(ground) * _cell(ground) / n)      # metres between neighbours
        moved = []
        for k, (x, y) in enumerate(pts):
            a, r = rng.uniform(0, 2 * math.pi), rng.uniform(0, loose * pitch)
            tx, ty = x + r * math.cos(a), y + r * math.sin(a)
            q = min(ground, key=lambda g: (g[0] - tx) ** 2 + (g[1] - ty) ** 2)
            # a nudge may not land a plant in a neighbour's hole: keep it where it was
            clash = any(math.dist(q, o) < floor for o in moved + pts[k + 1:])
            moved.append((x, y) if clash else q)
        pts = moved
    min_gap = max(floor, 0.5 * math.sqrt(len(ground) * _cell(ground) / n)) if n > 1 else 0
    if min_gap > 0 and n > 1:
        # Fragmented ground (a drift threaded between two others) can leave Lloyd with a
        # pair closer than the rule while open ground remains elsewhere in the SAME shape:
        # move the later of the closest pair to the free point farthest from the rest.
        for _ in range(3 * n):
            i, j, dist = min(((a, b, math.dist(pts[a], pts[b])) for a in range(n) for b in range(a + 1, n)),
                             key=lambda t: t[2])
            if dist >= min_gap:
                break
            rest = pts[:j] + pts[j + 1:]
            best = max(ground, key=lambda g: min(math.dist(g, q) for q in rest))
            if min(math.dist(best, q) for q in rest) <= dist:
                break                          # nowhere better: the shape is simply full
            pts[j] = best
    return [(round(x, 2), round(y, 2)) for x, y in pts]


def _cell(ground):
    """The grid step the ground was sampled at (area of one sample)."""
    xs = sorted({g[0] for g in ground})
    step = min((b - a for a, b in zip(xs, xs[1:])), default=0.1)
    return step * step


def on_centre(points):
    """A drift's spacing on centre — the planting schedule's own measure, not a copy of it."""
    return spacing_on_centre([{"position": p} for p in points])


# ── beds drawn rough, trimmed to what is built ───────────────────────
#
# A bed that stops 0.3 m short of the walk leaves a ribbon of raw ground the owner
# reads as unfinished. Meeting the walk requires offsetting its centreline by half
# its width and intersecting that with the terrace outline. A designer draws the
# bed over the walk and trims it to the edge. This cuts away the paths, terraces,
# house and any bed already there, keeping a hair of gap.

TRIM_GAP_M = 0.05


def _loops(inside, nx, ny):
    """Marching squares on a boolean grid: closed loops of (i, j) cell-edge points."""
    segs = []
    v = lambda i, j: 0 <= i < nx and 0 <= j < ny and inside[j][i]
    for j in range(-1, ny):
        for i in range(-1, nx):
            a, b, c, d = v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j + 1)
            top, right, bottom, left = (i + 0.5, j), (i + 1, j + 0.5), (i + 0.5, j + 1), (i, j + 0.5)
            code = a * 1 + b * 2 + c * 4 + d * 8
            table = {1: [(left, top)], 2: [(top, right)], 3: [(left, right)], 4: [(right, bottom)],
                     5: [(left, top), (right, bottom)], 6: [(top, bottom)], 7: [(left, bottom)],
                     8: [(bottom, left)], 9: [(bottom, top)], 10: [(top, right), (bottom, left)],
                     11: [(bottom, right)], 12: [(right, left)], 13: [(right, top)], 14: [(top, left)]}
            segs += table.get(code, [])
    nxt = {}
    for p, q in segs:
        nxt.setdefault(p, []).append(q)
    loops, used = [], set()
    for start in list(nxt):
        if start in used:
            continue
        loop, p = [], start
        while p not in used and p in nxt:
            used.add(p)
            loop.append(p)
            p = nxt[p][0] if len(nxt[p]) == 1 or nxt[p][0] not in used else nxt[p][-1]
        if len(loop) > 2:
            loops.append(loop)
    return loops


def _simplify(pts, tol):
    """Douglas-Peucker on a closed ring."""
    def dp(a):
        if len(a) < 3:
            return a
        (x1, y1), (x2, y2) = a[0], a[-1]
        L = math.hypot(x2 - x1, y2 - y1) or 1e-9
        far, k = max(((abs((y2 - y1) * x - (x2 - x1) * y + x2 * y1 - y2 * x1) / L, i)
                      for i, (x, y) in enumerate(a[1:-1], 1)), default=(0, 0))
        return dp(a[:k + 1])[:-1] + dp(a[k:]) if far > tol else [a[0], a[-1]]
    far = max(range(len(pts)), key=lambda i: math.dist(pts[0], pts[i]))
    return dp(pts[:far + 1])[:-1] + dp(pts[far:] + [pts[0]])[:-1]


def trim_outline(outline, design, site=None, keep_out=(), step=0.05, tol=0.04):
    """The bed you drew, minus every path corridor, patio, house and `keep_out` bed,
    each kept TRIM_GAP_M off. Returns (pieces, holes): the pieces over 0.5 m2, largest
    first — a walk drawn across a bed leaves two — and how many holes were left."""
    xs, ys = [p[0] for p in outline], [p[1] for p in outline]
    x0, y0 = min(xs) - step, min(ys) - step
    nx, ny = int((max(xs) - x0) / step) + 2, int((max(ys) - y0) / step) + 2
    paths = [(p.get("spline") or p.get("points") or [], float(p.get("width_m") or 0) / 2)
             for p in design.get("paths", []) + design.get("steps", [])]
    solid = [p["polygon"] for p in design.get("patios", []) if p.get("polygon")]
    solid += [b["polygon"] for b in design.get("beds", []) if b.get("id") in keep_out]
    if site and site.get("footprint"):
        solid.append([q[:2] for q in site["footprint"]])
    inside = []
    for j in range(ny):
        row = []
        for i in range(nx):
            x, y = x0 + (i + 0.5) * step, y0 + (j + 0.5) * step
            ok = point_in_polygon(x, y, outline)
            ok = ok and not any(len(line) > 1 and agent._near_corridor((x, y), line, half + TRIM_GAP_M)
                                for line, half in paths)
            ok = ok and not any(point_in_polygon(x, y, q) or _edge_dist(x, y, q) < TRIM_GAP_M for q in solid)
            row.append(ok)
        inside.append(row)
    to_m = lambda p: [x0 + (p[0] + 0.5) * step, y0 + (p[1] + 0.5) * step]
    rings = [[to_m(p) for p in loop] for loop in _loops(inside, nx, ny)]
    # a ring inside another is a HOLE (a patio the bed surrounds): the schema has no
    # holes, so it is reported rather than silently filled
    outer = [r for r in rings if not any(r is not o and polygon_area(o) > polygon_area(r)
                                         and point_in_polygon(*r[0], o) for o in rings)]
    pieces = sorted((r for r in outer if polygon_area(r) >= 0.5), key=polygon_area, reverse=True)
    return [[[round(x, 2), round(y, 2)] for x, y in _simplify(r, tol)] for r in pieces], len(rings) - len(outer)


def compose(design, comp, step=0.1, site=None):
    """(ops, new_plants, report). Pure: reads `design`, writes nothing."""
    bed_ops, bed_notes = [], []
    if comp.get("beds"):
        design = json.loads(json.dumps(design))
        for b in comp["beds"]:
            pieces, holes = trim_outline(b["outline"], design, site, keep_out=b.get("keep_out", ()))
            if not pieces:
                raise ValueError(f"bed {b['id']}: nothing is left of its outline once the paths, "
                                 "terraces and house are cut away")
            for k, poly in enumerate(pieces):
                bid = b["id"] if k == 0 else f"{b['id']}_{k + 1}"
                op = {"id": bid, "polygon": poly, **{f: b[f] for f in ("mulch", "level_m") if f in b}}
                bed_ops.append({"tool": "upsert_bed", "input": op})
                design["beds"] = [x for x in design.get("beds", []) if x["id"] != bid] + [dict(op)]
            bed_notes.append({"bed": b["id"], "pieces": [round(polygon_area(q), 1) for q in pieces],
                              **({"holes": holes} if holes else {})})
    beds = {b["id"]: b["polygon"] for b in design.get("beds", [])}
    scope = comp.get("replace_in") or []
    scope = set(beds) if scope == "all" else set(scope)
    keep = set(comp.get("keep") or [])

    def bed_of(p):
        return next((bid for bid, poly in beds.items() if point_in_polygon(*p["position"][:2], poly)), None)
    removed = [p["id"] for p in design.get("plants", []) if bed_of(p) in scope and p["id"] not in keep]
    placed = [p for p in design.get("plants", []) if p["id"] not in removed]
    new, report = [], []
    for q in comp.get("place") or []:
        rec = dict(species_record(q["species"], design), position=[round(q["at"][0], 2), round(q["at"][1], 2)])
        new.append(rec)
        placed.append(rec)
    masses = comp.get("masses") or []
    for i, m in enumerate(masses):
        rec = species_record(m["species"], design)
        bed = beds.get(m["bed"]) if m.get("bed") else None
        if m.get("bed") and bed is None:
            raise KeyError(f"mass {i}: no bed {m['bed']!r} in the design (beds: {', '.join(beds) or 'none'})")
        shape = mass_shape(m, bed) or bed
        if shape is None:
            raise ValueError(f"mass {i} ({m['species']}): give it a bed, a shape or an ellipse")
        if not isinstance(m.get("count"), int) or m["count"] < 1:
            raise ValueError(f"mass {i} ({m['species']}): the count is a design decision and it is "
                             "yours — give a whole number; the report says how many would fit")
        ground, in_shape, taken = free_ground(shape, bed, design, placed, rec, step)
        spread = rec.get("mature_spread_m") or 0.5
        asked = m["count"]
        pts = fill(ground, asked, seed=f"{m['species']}|{i}", loose=float(m.get("loose", 0.12)),
                   floor=agent.PLANTING_HOLE_M)
        shape_m2 = in_shape * step * step
        # MEASURED, not judged: how far apart these stand on centre, as a share of
        # their mature spread (1.0 = crowns just touching at full size), how many would sit
        # one mature spread apart here, the canopy at FULL maturity over the ground drawn,
        # and what else already stands in the shape. How close is the designer's call.
        oc = on_centre(pts)
        fits = int(len(ground) * step * step / (0.866 * spread * spread))
        line = {"mass": i, "bed": m.get("bed"), "species": rec["species"], "common": rec.get("common"),
                "asked": asked, "fits_at_mature_spread": fits,
                "placed": len(pts), "shape_m2": round(shape_m2, 2), "free_m2": round(len(ground) * step * step, 2),
                "on_centre_m": None if oc is None else round(oc, 2),
                "on_centre_of_spread": None if oc is None else round(oc / spread, 2),
                "mature_cover": round(len(pts) * math.pi * (spread / 2) ** 2 / shape_m2, 2) if shape_m2 else None}
        among = collections.Counter(q.get("common") or q["species"] for q in placed
                                    if q["species"] != rec["species"] and point_in_polygon(*q["position"][:2], shape))
        if among:
            line["shares_ground_with"] = dict(among.most_common(4))
        if (m.get("along") is not None or m.get("across") is not None) and bed is not None:
            f = bed_frame(bed)
            line["part"] = (f"along {list(m.get('along') or (0, 1))} of the bed, which runs {f['runs']}; "
                            f"across {list(m.get('across') or (0, 1))} from {f['across_from']}")
        if taken:
            lost = sorted(taken.items(), key=lambda kv: -kv[1])
            line["taken_by"] = {k: round(v * step * step, 2) for k, v in lost[:3]}
        if not in_shape:
            line["problem"] = "the shape does not overlap its bed (inset from the edge)"
        elif len(pts) < asked:
            line["problem"] = f"the shape has room for only {len(pts)}, one planting hole each" + \
                (f" — {', '.join(line['taken_by'])} already stand there" if taken else "")
        report.append(line)
        for x, y in pts:
            r = dict(rec, position=[x, y])
            new.append(r)
            placed.append(r)
    # the BED's reading at full maturity, from the validator's own function: a mass can
    # be dense inside its outline while the bed around it stays two-thirds bare
    candidate = dict(design, plants=[dict(p, id=p.get("id") or f"new{i}") for i, p in enumerate(placed)])
    touched = scope | {m["bed"] for m in comp.get("masses") or [] if m.get("bed")}
    beds_now = {bid: {"coverage": v["coverage"], "reading": v["reading"], "plants": v["plants"]}
                for bid, v in agent.bed_mature_coverage(candidate).items() if bid in touched}
    # ...and how its plants sit, at the point of decision: drifts drawn over each other
    # are planted THROUGH each other, so overlapping crowns and a mix that reads as a
    # scatter are reported here for the designer to judge.
    import site_api
    for bid in beds_now:
        inside = [p for p in candidate["plants"] if bed_of(p) == bid]
        crowns = site_api.crowns_overlapping(inside)
        beds_now[bid].update(own_kind_nearest=site_api.own_kind_nearest(inside),
                             crowns_at_one_height=crowns["at_one_height"],
                             **({"crowns_at_one_height_most": crowns["at_one_height_most"][:2]}
                                if crowns["at_one_height"] else {}))
    ops = list(bed_ops)
    if removed:
        ops.append({"tool": "remove_objects", "input": {"ids": removed}})
    if new:
        ops.append({"tool": "place_plants", "input": {"plants": new}})
    return ops, new, {"removed": removed, "masses": report, "beds": beds_now,
                      **({"drawn_beds": bed_notes} if bed_notes else {}),
                      "problems": [f"{r['common'] or r['species']}: {r['problem']}" for r in report if r.get("problem")]}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument("composition", help="a composition JSON (see the module docstring)")
    ap.add_argument("--ops", required=True, help="where to write the op list")
    ap.add_argument("--plan", help="also draw the result over the site plan, PNG")
    ap.add_argument("--bounds", nargs=4, type=float, metavar=("X0", "Y0", "X1", "Y1"))
    a = ap.parse_args(argv)
    comp = json.load(open(a.composition))
    src = project.resolve(comp["design"])
    design = json.load(open(src))
    site_path = project.data("site.json")
    site = json.load(open(site_path)) if os.path.exists(site_path) else None
    try:
        ops, new, report = compose(design, comp, site=site)
    except (KeyError, ValueError) as e:
        print(f"compose: {e.args[0] if e.args else e}", file=sys.stderr)
        return 2
    a.ops = project.resolve(a.ops)                  # review/… is the site's
    json.dump(ops, open(a.ops, "w"), indent=1)
    if a.plan:
        import site_plan
        preview = json.loads(json.dumps(design))
        preview["plants"] = [p for p in preview.get("plants", []) if p["id"] not in report["removed"]] + \
            [dict(p, id=f"new{i}") for i, p in enumerate(new)]
        report["plan"] = site_plan.render(project.resolve(a.plan), preview, bounds=a.bounds)["out"]
    report["ops"] = a.ops
    report["next"] = f"python3 tools/site_api.py check-ops --ops-file {a.ops} --design {comp['design']}"
    print(json.dumps(report, indent=1))
    return 1 if report["problems"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
