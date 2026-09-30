#!/usr/bin/env python3
"""THE DRAWINGS A PLANT GOES INTO THE GROUND FROM.

The drawings must locate plants accurately on the ground using the trade's standard
drawing and diagram formats.

What the trade builds from is three things, and this writes all three from a design
document, as one printable HTML file of inline SVG (open it, print it, walk outside):

  L-1  PLANTING PLAN   — plan view TO SCALE; every plant a circle at its MATURE
                          spread with a centre mark, labelled with a key code.
  L-2  PLANT SCHEDULE  — code, botanical name, common name, quantity, size at
                          planting, mature size, spacing on centre, notes. It is
                          the shopping list and the key to L-1.
  L-3  SETTING OUT     — how a point on paper becomes a point on the ground, by the
                          two methods the trade uses: TRIANGULATION from two fixed
                          points for the control stakes, then STATION AND OFFSET along
                          the staked baseline for every plant.

Sources for the conventions: UF/IFAS ENH1195 "Drawing a Planting Plan" (symbol =
mature spread, spacing on centre, schedule columns), and the baseline-offset /
triangulation methods of linear surveying (RHS; Oxford College of Garden Design).

**Why triangulation from the owner's markers, and not bearings or GPS.** North may not
be set, and phone GPS is good to 3-5 m. A distance between two points is the
same number in any frame — so two tapes from two of their own landmarks need neither.

**Distances are TAUT-TAPE distances**, ground to ground, not plan distances: on
ground falling 20%, 10 m of plan is 20 cm short of the tape, which is the width of a
plant. The ground comes from agent.ground_at, the one function the validator uses too.

    python3 tools/planting_plan.py --design data/designs/variant_a.json \\
        --baseline gate_walk --beds bank_bed,upper_bed
"""
from __future__ import annotations
import argparse
import html
import json
import math
import os
import project  # the active project's files — the ONE owner
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import agent  # noqa: E402  ground_at — the one owner of "how high is the ground here"
import geom   # noqa: E402  point_in_polygon — the one owner of that too

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCALE = 50                      # 1:50 — 1 m on the ground is 20 mm on paper
PAGE_W, PAGE_H = 259.0, 190.0   # printable mm on US Letter, landscape, 10 mm margins
TITLE_H = 16.0


# ── lengths, as a tape reads them ────────────────────────────────────────────
def feet_inches(m: float) -> str:
    """7.62 -> 25' 0\"; to the nearest half inch, which is what a tape resolves."""
    half_inches = round(m / 0.0254 * 2)
    feet, rest = divmod(half_inches, 24)
    inches, half = divmod(rest, 2)
    return f"{feet}' {inches}{'½' if half else ''}\""


def both(m: float) -> str:
    return f"{m:.2f} m · {feet_inches(m)}"


# ── geometry ─────────────────────────────────────────────────────────────────
def taut(a, b, site) -> float:
    """Straight-line distance between two GROUND points — what a taut tape reads."""
    za, zb = agent.ground_at(a[0], a[1]), agent.ground_at(b[0], b[1])
    dz = (za - zb) if (za is not None and zb is not None) else 0.0
    return math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + dz * dz)


def side_of(a, b, p) -> str:
    """Which side of the line a->b the point p is on, for someone at a FACING b."""
    cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
    return "left" if cross > 0 else "right"


def station_offset(p, line):
    """(station_m, offset_m, side, segment_index, clamped) of p against a polyline.

    `station` runs from the first point; `side` is left/right for someone walking the
    line in that direction. `clamped` is True when p lies beyond an end of the line —
    a perpendicular offset means nothing there, and the caller must not print one.
    """
    best = None
    run = 0.0
    for i in range(len(line) - 1):
        ax, ay = line[i]
        bx, by = line[i + 1]
        dx, dy = bx - ax, by - ay
        length = math.hypot(dx, dy)
        if length == 0:
            continue
        t_raw = ((p[0] - ax) * dx + (p[1] - ay) * dy) / (length * length)
        t = max(0.0, min(1.0, t_raw))
        qx, qy = ax + t * dx, ay + t * dy
        d = math.hypot(p[0] - qx, p[1] - qy)
        clamped = (i == 0 and t_raw < 0) or (i == len(line) - 2 and t_raw > 1)
        if best is None or d < best[1]:
            best = (run + t * length, d, side_of((ax, ay), (bx, by), p), i, clamped, (qx, qy))
        run += length
    return best


def intersection_angle(a, b, p) -> float:
    """Angle at p between the two tapes, degrees. Near 90 is a sharp fix; under ~30 or
    over ~150 the two arcs cross so obliquely that a centimetre of tape is ten on the
    ground — the trade's rule for a 'well-conditioned' triangle."""
    v1 = (a[0] - p[0], a[1] - p[1])
    v2 = (b[0] - p[0], b[1] - p[1])
    n = math.hypot(*v1) * math.hypot(*v2)
    if n == 0:
        return 0.0
    return math.degrees(math.acos(max(-1.0, min(1.0, (v1[0] * v2[0] + v1[1] * v2[1]) / n))))


def pick_controls(landmarks, stakes, names=None):
    """Two fixed points to tape from: named, or else chosen.

    THE SHORTEST TAPES THAT STILL FIX EVERY STAKE WELL. Optimizing only for the angle
    nearest 90 deg can favour landmarks 17 m and 21 m away over a fence corner 8 m off.
    A sharper triangle on paper can be worse in a planted, sloping site, where every
    metre of tape is a metre of sag and snag. So: among the
    pairs that see EVERY stake between 35 and 145 deg, the pair with the least tape;
    only if there is none, the best-conditioned pair regardless of length."""
    by_name = {l["name"]: l for l in landmarks}
    if names:
        missing = [n for n in names if n not in by_name]
        if missing:
            raise SystemExit(f"no landmark called {missing} — the site has: {sorted(by_name)}")
        if len(names) != 2:
            raise SystemExit("--from takes exactly two landmark names, A,B")
        return [by_name[n] for n in names]
    if len(landmarks) < 2:
        raise SystemExit("setting out needs at least two landmarks — mark two fixed points in Places first")
    scored = []
    for i, a in enumerate(landmarks):
        for b in landmarks[i + 1:]:
            pa, pb = (a["x"], a["y"]), (b["x"], b["y"])
            angles = [intersection_angle(pa, pb, q) for q in stakes]
            worst = max(abs(90 - g) for g in angles)
            tape = sum(math.hypot(pa[0] - q[0], pa[1] - q[1]) + math.hypot(pb[0] - q[0], pb[1] - q[1]) for q in stakes)
            scored.append((worst > 55, tape if worst <= 55 else worst, a, b))
    _, _, a, b = min(scored, key=lambda t: (t[0], t[1]))
    return [a, b]


# ── the key codes ────────────────────────────────────────────────────────────
def key_codes(species_list):
    """{species: CODE}. Genus + epithet, three letters each — 'MUH CAP' — which is how a
    planting plan keys its symbols; a cultivar takes its own letters so two cultivars of
    one species never share a code. Collisions get a digit."""
    out, used = {}, set()
    for sp in sorted(species_list):
        cultivar = re.search(r"'([^']+)'", sp)
        words = re.sub(r"'[^']*'", "", sp).replace("×", " ").replace(" x ", " ").split()
        genus = (words[0] if words else "UNK")[:3].upper()
        second = cultivar.group(1) if cultivar else (words[1] if len(words) > 1 else "SP")
        second = re.sub(r"[^A-Za-z]", "", second)[:3].upper() or "SP"
        code, n = f"{genus} {second}", 2
        while code in used:
            code = f"{genus} {second[:2]}{n}"
            n += 1
        used.add(code)
        out[sp] = code
    return out


def spacing_on_centre(plants):
    """Median distance from each plant to its nearest neighbour OF ITS OWN KIND — what
    this design actually does, measured, rather than a rule restated."""
    if len(plants) < 2:
        return None
    nearest = []
    for i, p in enumerate(plants):
        d = min(math.hypot(p["position"][0] - q["position"][0], p["position"][1] - q["position"][1])
                for j, q in enumerate(plants) if j != i)
        nearest.append(d)
    nearest.sort()
    return nearest[len(nearest) // 2]


def drifts(plants, small_m=0.8):
    """Masses of one small species, as lists of plants: neighbours closer than 1.3x
    their spread are one drift. The trade labels a mass ONCE — "7 - THY PIN" on a
    leader — because seven codes stacked in seven 10 mm circles form a black smudge.
    Bigger plants are labelled singly."""
    small = [p for p in plants if p["mature_spread_m"] < small_m]
    seen, out = set(), []
    for p in small:
        if id(p) in seen:
            continue
        group, todo = [], [p]
        seen.add(id(p))
        while todo:
            a = todo.pop()
            group.append(a)
            for b in small:
                if id(b) in seen or b["species"] != a["species"]:
                    continue
                if math.hypot(a["position"][0] - b["position"][0], a["position"][1] - b["position"][1]) \
                        <= 1.3 * max(a["mature_spread_m"], b["mature_spread_m"]):
                    seen.add(id(b))
                    todo.append(b)
        if len(group) >= 3:
            out.append(group)
    return out


def auto_baseline(design, bed_ids=None, reach_m=3.0):
    """The path with the most plants within `reach_m` of it — the walk a border is
    planted off — counting only the plants of `bed_ids` when beds are named. One home
    for the rule, so the viewer can ask for drawings of the beds the user selects and get
    the answer a session typing the command would."""
    plants = design.get("plants", [])
    if bed_ids:
        polys = [[q[:2] for q in b["polygon"]] for b in design.get("beds", []) if b["id"] in bed_ids]
        plants = [pl for pl in plants if any(geom.point_in_polygon(pl["position"][0], pl["position"][1], poly) for poly in polys)]
    best = None
    for p in design.get("paths", []):
        line = [q[:2] for q in p["spline"]]
        if len(line) < 2:
            continue
        n = sum(1 for pl in plants if station_offset(pl["position"][:2], line)[1] <= reach_m)
        if best is None or n > best[0]:
            best = (n, p["id"])
    if not best or not best[0]:
        raise SystemExit("no path has any plant within 3 m of it — name one with --baseline")
    return best[1]


def auto_beds(design, baseline_id, reach_m=3.0):
    """Beds most of whose plants stand within `reach_m` of the baseline."""
    line = [q[:2] for q in next(p for p in design["paths"] if p["id"] == baseline_id)["spline"]]
    out = []
    for b in design.get("beds", []):
        poly = [q[:2] for q in b["polygon"]]
        inside = [pl for pl in design.get("plants", []) if geom.point_in_polygon(pl["position"][0], pl["position"][1], poly)]
        near = [pl for pl in inside if station_offset(pl["position"][:2], line)[1] <= reach_m]
        if inside and len(near) * 2 >= len(inside):
            out.append(b["id"])
    return out


# ── drawing ──────────────────────────────────────────────────────────────────
class Sheet:
    """A region of the site drawn at 1:SCALE in millimetres, long axis along the page."""

    def __init__(self, box):
        x0, y0, x1, y1 = box
        self.box = box
        self.rot = (y1 - y0) > (x1 - x0)          # taller than wide: turn it, and say so
        w_m, h_m = ((y1 - y0), (x1 - x0)) if self.rot else ((x1 - x0), (y1 - y0))
        self.w, self.h = w_m * 1000 / SCALE, h_m * 1000 / SCALE

    def pt(self, x, y):
        x0, y0, x1, y1 = self.box
        if self.rot:                               # site +y (nominal north) points LEFT
            return ((y1 - y) * 1000 / SCALE, (x1 - x) * 1000 / SCALE)
        return ((x - x0) * 1000 / SCALE, (y1 - y) * 1000 / SCALE)

    def mm(self, metres):
        return metres * 1000 / SCALE

    def pts(self, line):
        return " ".join(f"{a:.2f},{b:.2f}" for a, b in (self.pt(x, y) for x, y in line))


def draw_plan(sheet, design, plants, codes, beds, baseline=None, stakes=False):
    e = []
    for b in design.get("beds", []):
        if b["id"] in beds:
            e.append(f'<polygon class="bed" points="{sheet.pts(b["polygon"])}"/>')
    for p in design.get("paths", []):
        e.append(f'<polyline class="path" points="{sheet.pts(p["spline"])}" stroke-width="{sheet.mm(p.get("width_m", 1)):.1f}"/>')
    for s in design.get("steps", []):
        e.append(f'<polyline class="steps" points="{sheet.pts(s["spline"])}" stroke-width="{sheet.mm(s.get("width_m", 1)):.1f}"/>')
    for w in design.get("edges", []):
        e.append(f'<polyline class="edge" points="{sheet.pts(w["spline"])}"/>')
    for o in design.get("objects", []):
        x, y = sheet.pt(*o["position"][:2])
        r = max(1.2, sheet.mm((o.get("width_m") or o.get("height_m") or 0.4) / 2))
        e.append(f'<circle class="rock" cx="{x:.2f}" cy="{y:.2f}" r="{r:.2f}"/>')
        if r >= 5:                  # big enough to be mistaken for a plant: say what it is
            e.append(f'<text class="objname" x="{x:.2f}" y="{y + 0.8:.2f}">{html.escape(str(o.get("kind", "")))}</text>')
    massed = {id(p): g for g in drifts(plants) for p in g}
    for p in plants:
        x, y = sheet.pt(*p["position"][:2])
        r = sheet.mm(p["mature_spread_m"] / 2)
        tall = p["mature_height_m"] >= 2.5
        e.append(f'<circle class="plant{" tree" if tall else ""}" cx="{x:.2f}" cy="{y:.2f}" r="{r:.2f}"/>')
        e.append(f'<path class="tick" d="M{x - 0.9:.2f},{y:.2f}h1.8M{x:.2f},{y - 0.9:.2f}v1.8"/>')
        if id(p) in massed:
            continue                # its drift is labelled once, below
        size = 1.9 if r >= 5 else 1.5
        g, s2 = codes[p["species"]].split(" ")
        e.append(f'<text class="code" x="{x:.2f}" y="{y - 1.1:.2f}" font-size="{size}">{g}</text>')
        e.append(f'<text class="code" x="{x:.2f}" y="{y + size + 0.9:.2f}" font-size="{size}">{s2}</text>')
    for g in {id(g): g for g in massed.values()}.values():
        cx = sum(q["position"][0] for q in g) / len(g)
        cy = sum(q["position"][1] for q in g) / len(g)
        x, y = sheet.pt(cx, cy)
        e.append(f'<text class="callout" x="{x:.2f}" y="{y + 0.8:.2f}">{len(g)} – {codes[g[0]["species"]]}</text>')
    if baseline and stakes:
        e.append(f'<polyline class="base" points="{sheet.pts(baseline)}"/>')
        for i, (bx, by) in enumerate(baseline):
            x, y = sheet.pt(bx, by)
            e.append(f'<circle class="stake" cx="{x:.2f}" cy="{y:.2f}" r="1.3"/>'
                     f'<text class="stakeno" x="{x + 1.8:.2f}" y="{y - 1.6:.2f}">P{i}</text>')
    return "\n".join(e)


def furniture(sheet, north_set):
    """Scale bar and direction arrow — the two things that make a print checkable."""
    x, y = 4, sheet.h - 5
    bar = "".join(f'<rect x="{x + sheet.mm(a):.1f}" y="{y}" width="{sheet.mm(b - a):.1f}" height="1.6" class="bar{i % 2}"/>'
                  for i, (a, b) in enumerate([(0, 1), (1, 2), (2, 5)]))
    ticks = "".join(f'<text class="small" x="{x + sheet.mm(v):.1f}" y="{y - 1}">{v}</text>' for v in (0, 1, 2, 5))
    ax, ay = sheet.w - 12, 12
    arrow = ('<path class="north" d="M0,7 L0,-7 M-2.5,-3 L0,-7 L2.5,-3"/>')
    turn = -90 if sheet.rot else 0
    label = "N" if north_set else "+y of the scan"
    return (f'{bar}{ticks}<text class="small" x="{x + sheet.mm(5) + 2:.1f}" y="{y + 1.5}">m — 1:{SCALE} when printed at 100%</text>'
            f'<g transform="translate({ax},{ay}) rotate({turn})">{arrow}</g>'
            f'<text class="small" x="{ax - 9}" y="{ay + 12}">{label}</text>')


CSS = """
@page { size: letter landscape; margin: 10mm; }
* { box-sizing: border-box; }
body { margin: 0; font: 9pt/1.35 Helvetica, Arial, sans-serif; color: #111; background: #fff; }
section { page-break-after: always; padding: 0; }
header.tb { display: flex; justify-content: space-between; align-items: baseline;
  border-bottom: 1.2pt solid #111; padding-bottom: 2mm; margin-bottom: 3mm; }
header.tb h1 { font-size: 13pt; margin: 0; letter-spacing: .04em; }
header.tb .meta { font-size: 8pt; color: #333; text-align: right; }
svg { display: block; }
.bed { fill: #f3efe4; stroke: #555; stroke-width: .35; }
.path { fill: none; stroke: #d9d2bf; stroke-linecap: round; stroke-linejoin: round; }
.steps { fill: none; stroke: #bdb6a3; stroke-dasharray: 1.2 .8; }
.edge { fill: none; stroke: #111; stroke-width: 1.1; }
.rock { fill: #cfcfcf; stroke: #555; stroke-width: .3; }
.plant { fill: rgba(120,160,110,.16); stroke: #2c4a2c; stroke-width: .3; }
.plant.tree { fill: rgba(120,160,110,.08); stroke-width: .7; stroke-dasharray: 2 1; }
.tick { stroke: #111; stroke-width: .25; fill: none; }
.code { text-anchor: middle; font-family: Helvetica, Arial, sans-serif; font-weight: 700; fill: #111;
  paint-order: stroke; stroke: #fff; stroke-width: .5; stroke-linejoin: round; }
.callout { text-anchor: middle; font: 700 2.3px Helvetica, Arial, sans-serif; fill: #111;
  paint-order: stroke; stroke: #fff; stroke-width: 1.1; stroke-linejoin: round; }
.objname { text-anchor: middle; font: 2.1px Helvetica, Arial, sans-serif; fill: #444; }
.base { fill: none; stroke: #b3261e; stroke-width: .5; stroke-dasharray: 2 1; }
.stake { fill: #b3261e; } .stakeno { font-size: 2.6px; fill: #b3261e; font-weight: 700; }
.bar0 { fill: #111; } .bar1 { fill: #fff; stroke: #111; stroke-width: .2; }
.small { font-size: 2.6px; fill: #111; } .north { stroke: #111; stroke-width: .6; fill: none; }
table { border-collapse: collapse; width: 100%; font-size: 8.5pt; }
th { text-align: left; border-bottom: 1pt solid #111; padding: 1.2mm 1.5mm; font-size: 7.5pt; letter-spacing: .06em; }
td { border-bottom: .3pt solid #bbb; padding: 1mm 1.5mm; vertical-align: top; }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.code { font-weight: 700; white-space: nowrap; }
.note { font-size: 8pt; color: #333; max-width: 240mm; margin: 2mm 0 3mm; }
.warn { color: #8a1c14; font-weight: 700; }
h2 { font-size: 10pt; margin: 4mm 0 1.5mm; }
tr { page-break-inside: avoid; }
@media screen { body { background: #777; } section { background: #fff; width: 279mm; min-height: 216mm;
  margin: 8mm auto; padding: 10mm; box-shadow: 0 2px 12px rgba(0,0,0,.4); } }
"""


def build(design, site, palette, baseline_id, bed_ids, control_names=None, title=""):
    beds = {b["id"]: b for b in design.get("beds", []) if b["id"] in bed_ids}
    if not beds:
        raise SystemExit(f"none of {sorted(bed_ids)} is a bed in this design — it has {[b['id'] for b in design.get('beds', [])]}")
    path = next((p for p in design.get("paths", []) if p["id"] == baseline_id), None)
    if not path:
        raise SystemExit(f"no path called {baseline_id!r} — this design has {[p['id'] for p in design.get('paths', [])]}")
    baseline = [q[:2] for q in path["spline"]]
    plants = [p for p in design.get("plants", [])
              if any(geom.point_in_polygon(p["position"][0], p["position"][1], [q[:2] for q in b["polygon"]]) for b in beds.values())]
    if not plants:
        raise SystemExit("those beds hold no plants")
    codes = key_codes({p["species"] for p in plants})

    xs = [q[0] for b in beds.values() for q in b["polygon"]] + [q[0] for q in baseline]
    ys = [q[1] for b in beds.values() for q in b["polygon"]] + [q[1] for q in baseline]
    pad = 0.8
    box = (min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad)
    sheet = Sheet(box)
    fits = sheet.w <= PAGE_W and sheet.h <= PAGE_H - TITLE_H
    north_set = bool((site.get("frame") or {}).get("north_set"))
    stamp = time.strftime("%Y-%m-%d")

    def title_block(no, name):
        return (f'<header class="tb"><h1>{no} &nbsp; {name}</h1><div class="meta">{html.escape(title)} · '
                f'{len(plants)} plants · {len(codes)} species · {stamp}<br>drawn 1:{SCALE}, metres'
                f'{"" if north_set else " · north NOT set on this site — distances only, no bearings"}</div></header>')

    def svg(stakes):
        return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{sheet.w:.1f}mm" height="{sheet.h:.1f}mm" '
                f'viewBox="0 0 {sheet.w:.1f} {sheet.h:.1f}">{draw_plan(sheet, design, plants, codes, set(beds), baseline, stakes)}'
                f'{furniture(sheet, north_set)}</svg>')

    # ── L-2 the schedule ──
    by_species = {}
    for p in plants:
        by_species.setdefault(p["species"], []).append(p)
    rows = []
    for sp, group in sorted(by_species.items(), key=lambda kv: codes[kv[0]]):
        entry = palette.get(sp, {})
        oc = spacing_on_centre(group)
        cat = entry.get("cat_safe")
        notes = []
        if cat is None:
            notes.append("cat safety NOT verified")
        if group[0]["mature_height_m"] >= 2.5:
            notes.append("tree")
        if entry.get("ca_native"):
            notes.append("CA native")
        rows.append(f'<tr><td class="code">{codes[sp]}</td><td><i>{html.escape(sp)}</i></td>'
                    f'<td>{html.escape(group[0].get("common", ""))}</td><td class="n">{len(group)}</td>'
                    f'<td>—</td><td class="n">{group[0]["mature_height_m"]:.2f} × {group[0]["mature_spread_m"]:.2f} m</td>'
                    f'<td class="n">{both(oc) if oc else "single"}</td><td>{html.escape("; ".join(notes))}</td></tr>')

    # ── L-3 setting out ──
    A, B = pick_controls(site.get("landmarks", []), baseline, control_names)
    a, b = (A["x"], A["y"]), (B["x"], B["y"])
    stake_rows, weak = [], 0
    for i, q in enumerate(baseline):
        ang = intersection_angle(a, b, q)
        bad = ang < 30 or ang > 150
        weak += bad
        stake_rows.append(f'<tr><td class="code">P{i}</td><td class="n">{both(taut(a, q, site))}</td>'
                          f'<td class="n">{both(taut(b, q, site))}</td><td>{side_of(a, b, q)} of A→B</td>'
                          f'<td class="n{" warn" if bad else ""}">{ang:.0f}°</td></tr>')
    plant_rows, beyond = [], 0
    located = sorted(((station_offset(p["position"][:2], baseline), p) for p in plants), key=lambda t: (t[0][0], t[0][1]))
    for (st, off, side, seg, clamped, foot), p in located:
        uphill = None
        zp, zf = agent.ground_at(*p["position"][:2]), agent.ground_at(*foot)
        if zp is not None and zf is not None and abs(zp - zf) > 0.03:
            uphill = "uphill" if zp > zf else "downhill"
        if clamped:
            beyond += 1
            i, j = (0, 1) if seg == 0 else (len(baseline) - 2, len(baseline) - 1)
            how = (f'<td colspan="2">beyond the end — {both(taut(baseline[i], p["position"], site))} from P{i} and '
                   f'{both(taut(baseline[j], p["position"], site))} from P{j}</td>')
        else:
            how = (f'<td class="n">{both(st)}</td>'
                   f'<td class="n">{both(taut(foot, p["position"], site))} {side}{f" ({uphill})" if uphill else ""}</td>')
        plant_rows.append(f'<tr><td class="code">{codes[p["species"]]}</td><td>{html.escape(p.get("common", ""))}</td>'
                          f'{how}<td class="n">P{seg}–P{seg + 1}</td><td>{p["id"]}</td><td>☐</td></tr>')

    out = [f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{html.escape(title)} — planting drawings</title>'
           f'<style>{CSS}</style></head><body>']
    out.append(f'<section>{title_block("L-1", "PLANTING PLAN")}'
               + ("" if fits else f'<p class="note warn">This area is {sheet.w:.0f} × {sheet.h:.0f} mm at 1:{SCALE} and does not fit one Letter sheet — print on tabloid, or pass fewer --beds.</p>')
               + svg(False)
               + '<p class="note">Each circle is one plant at its MATURE spread; the cross is where the hole goes. Codes are keyed on L-2. '
                 'Check the scale bar with a ruler before trusting a measurement off this sheet.</p></section>')
    out.append(f'<section>{title_block("L-2", "PLANT SCHEDULE")}<table><tr><th>CODE</th><th>BOTANICAL NAME</th><th>COMMON NAME</th>'
               '<th class="n">QTY</th><th>SIZE AT PLANTING</th><th class="n">MATURE H × W</th><th class="n">SPACING O.C.</th><th>NOTES</th></tr>'
               + "".join(rows) + f'<tr><td></td><td></td><td><b>total</b></td><td class="n"><b>{len(plants)}</b></td><td colspan="4"></td></tr></table>'
               '<p class="note">SIZE AT PLANTING is blank on purpose: container sizes per species are not recorded in this project yet, and a guessed one is worse than a blank. '
               'SPACING O.C. is measured from this design — the median distance from each plant to its nearest neighbour of the same kind.</p></section>')
    out.append(f'<section>{title_block("L-3", "SETTING OUT")}'
               f'<p class="note"><b>1. Stake the baseline.</b> The red dashed line is the centreline of <b>{html.escape(baseline_id)}</b>. '
               f'Hook one tape on <b>A = {html.escape(A["name"])}</b> and one on <b>B = {html.escape(B["name"])}</b>; where the two distances meet, on the side given, drive stake P<i>n</i>. '
               'Distances are for a TAUT tape from ground to ground — on a 20% slope a plan distance is short by the width of a plant over ten metres. '
               '<b>2. Run a string</b> from stake to stake. <b>3. Plant down the table:</b> STATION is the distance along the string from P0; OFFSET is square off the string, left or right as you walk from P0 towards the last stake.</p>'
               + (f'<p class="note warn">{weak} stake(s) see A and B at under 30° or over 150°: the two arcs cross too obliquely to fix a point well. Mark a third landmark nearer square-on, or pass --from.</p>' if weak else "")
               + svg(True)
               + '<h2>Control stakes</h2><table><tr><th>STAKE</th><th class="n">TAPE FROM A</th><th class="n">TAPE FROM B</th><th>SIDE</th><th class="n">ANGLE AT STAKE</th></tr>'
               + "".join(stake_rows) + "</table></section>")
    out.append(f'<section>{title_block("L-3b", "SETTING OUT — PLANTS, IN WALKING ORDER")}'
               '<table><tr><th>CODE</th><th>COMMON NAME</th><th class="n">STATION</th><th class="n">OFFSET</th><th class="n">BETWEEN</th><th>ID</th><th>IN</th></tr>'
               + "".join(plant_rows) + "</table>"
               + (f'<p class="note">{beyond} plant(s) lie beyond an end of the baseline, where a square offset means nothing; they are given as two tapes from the two end stakes instead.</p>' if beyond else "")
               + "</section>")
    out.append("</body></html>")
    return "".join(out), {"plants": len(plants), "species": len(codes), "stakes": len(baseline), "weak_stakes": weak,
                          "beyond_baseline": beyond, "controls": [A["name"], B["name"]], "fits_letter": fits,
                          "sheet_mm": [round(sheet.w), round(sheet.h)]}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--design", default="data/design.json")
    ap.add_argument("--baseline", default="auto", help="the path whose centreline is staked, e.g. gate_walk (default: the path with the most plants beside it)")
    ap.add_argument("--beds", default="auto", help="comma-separated bed ids to plant from this baseline (default: the beds planted along it)")
    ap.add_argument("--from", dest="controls", default="", help="two landmark names to tape from, A,B (default: the best-conditioned near pair)")
    ap.add_argument("--out", default="")
    a = ap.parse_args()
    def load(path, what, fix):
        # a SENTENCE, never a traceback: on a property with nothing in it yet this is the
        # first thing anyone sees (tests/test_hardening_degraded.py holds every
        # documented command to that)
        try:
            with open(path) as f:
                return json.load(f)
        except FileNotFoundError:
            raise SystemExit(f"{what} not found at {os.path.relpath(path, os.getcwd())} — {fix}")
        except ValueError as e:
            raise SystemExit(f"{what} at {path} is not readable JSON: {e}")

    design = load(project.resolve(a.design), "design", "pass --design, or save one from the viewer first")
    site = load(project.data("site.json"), "site file",
                "setting out needs the owner's landmarks; onboard the property first (docs/site.md)")
    from plant_catalog import catalog          # names and cat safety; empty without a catalogue
    palette = {p["species"]: p for p in catalog().get("plants", [])}
    name = os.path.splitext(os.path.basename(a.design))[0]
    if a.beds != "auto":
        known = {b["id"] for b in design.get("beds", [])}
        unknown = [b for b in a.beds.split(",") if b and b not in known]
        if unknown:                     # said FIRST, or the baseline search reports a different fault
            raise SystemExit(f"{unknown} is not a bed in this design — it has {sorted(known)}")
    if a.baseline == "auto":
        a.baseline = auto_baseline(design, None if a.beds == "auto" else set(filter(None, a.beds.split(","))))
    if a.beds == "auto":
        a.beds = ",".join(auto_beds(design, a.baseline))
    doc, info = build(design, site, palette, a.baseline, set(filter(None, a.beds.split(","))),
                      [n for n in a.controls.split(",") if n] or None, title=name)
    out = project.resolve(a.out or f"review/planting-plan-{name}.html")
    with open(out, "w") as f:
        f.write(doc)
    print(json.dumps({"wrote": os.path.relpath(out, ROOT), "baseline": a.baseline, "beds": a.beds.split(","), **info}, indent=1))


if __name__ == "__main__":
    main()
