"""Derive everything the design agent knows about a property, from the scan.

Why this exists
---------------
Four analysis steps underlie everything the design agent reasons about: the 1 m
raycast of the scan, the site zones, the grade breakdown and gentlest pocket per
zone, and the maximum level-pad width. Done by hand in a browser console, they
would have to be repeated by a human for every new property — the single largest
thing standing between this tool and being general.

This does all four, for any scan, in one command. The raycast half has to happen
in the browser — the scan mesh only exists there — so it goes through the render
broker that already exists for `look`. The analysis half is here.

    cd viewer && npm run dev      # and open the page, with a capture loaded
    python3 tools/analyze_site.py            # writes terrain_scan.json + site.zones
    python3 tools/analyze_site.py --dry-run  # print what it would write

Nothing here is specific to one property. Zones are found by carving the scanned
ground around the building rather than by assuming a shape, so a flat lot, an
L-shaped lot or a courtyard all work; a property with no detectable building
falls back to a single zone.
"""
from __future__ import annotations
import broker
import agent
import geodata
import argparse
import json
import math
import os
import project  # the active project's files — the ONE owner
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VIEWER = os.environ.get("YARDTWIN_VIEWER", "http://localhost:5178")
# NOT typed here. These are jurisdiction- and owner-dependent (1.2 m is roughly
# California's 4-ft permit trigger), and every other tool reads them from
# site.constraints via agent.constraints(). Typing them again would make the pad
# widths written into site.zones ignore a site that sets its own limits — the zones
# would quote widths computed for 1.2 m on a site that says 0.9 m.


def fetch_scan_grid(cell, extent):
    """Ask the open viewer to raycast the scan. This is the only browser step.

    Through the shared client (tools/broker.py), so with the viewer down it says so
    in a sentence rather than a raw traceback — and it is the FIRST command run when
    onboarding a property.
    """
    try:
        return broker.data({"op": "scan_grid", "cell_m": cell, "extent_m": extent},
                           timeout=240)
    except broker.ViewerDown as e:
        raise SystemExit(f"could not reach the scan: {e}")
    except broker.BrokerRefused as e:
        raise SystemExit(f"could not reach the scan: {e}")

class Grid:
    """The raycast grid, with ENU lookups. Rows run north-first."""

    def __init__(self, g):
        self.g = g
        self.rows = g["rows"]
        self.cell = g["cell_m"]
        self.x0, self.y1 = g["x0"], g["y1"]

    def at(self, x, y):
        c = round((x - self.x0) / self.cell)
        r = round((self.y1 - y) / self.cell)
        if 0 <= r < len(self.rows) and 0 <= c < len(self.rows[r]):
            return self.rows[r][c]
        return None

    def cells(self):
        for r, row in enumerate(self.rows):
            for c, v in enumerate(row):
                if v is not None:
                    yield (self.x0 + c * self.cell, self.y1 - r * self.cell, v)

    def slope_at(self, x, y, r=1.0):
        e, w = self.at(x + r, y), self.at(x - r, y)
        n, s = self.at(x, y + r), self.at(x, y - r)
        if None in (e, w, n, s):
            return None
        dx, dy = (e - w) / (2 * r), (n - s) / (2 * r)
        return math.degrees(math.atan(math.hypot(dx, dy))), dx, dy


def find_building(grid):
    """
    The building is the region the scanner could not see into: a hole in the
    ground enclosed by ground on all sides. Found by flooding the empty cells
    inward from the boundary — whatever empty cells are unreachable are enclosed.

    Deliberately NOT taken from the map footprint: that is fetched from public
    data, can be stale or misaligned, and may be absent entirely for a new site.
    """
    rows = grid.rows
    H, W = len(rows), len(rows[0])
    outside = set()
    stack = []
    for r in range(H):
        for c in (0, W - 1):
            if rows[r][c] is None and (r, c) not in outside:
                outside.add((r, c)); stack.append((r, c))
    for c in range(W):
        for r in (0, H - 1):
            if rows[r][c] is None and (r, c) not in outside:
                outside.add((r, c)); stack.append((r, c))
    while stack:
        r, c = stack.pop()
        for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nr, nc = r + dr, c + dc
            if 0 <= nr < H and 0 <= nc < W and rows[nr][nc] is None and (nr, nc) not in outside:
                outside.add((nr, nc)); stack.append((nr, nc))

    holes = [(r, c) for r in range(H) for c in range(W)
             if rows[r][c] is None and (r, c) not in outside]
    if not holes:
        return None
    # largest connected hole
    seen, best = set(), []
    hs = set(holes)
    for h in holes:
        if h in seen:
            continue
        stack, cur = [h], []
        seen.add(h)
        while stack:
            r, c = stack.pop(); cur.append((r, c))
            for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                n = (r + dr, c + dc)
                if n in hs and n not in seen:
                    seen.add(n); stack.append(n)
        if len(cur) > len(best):
            best = cur
    if len(best) * grid.cell ** 2 < 20:          # too small to be a building
        return None
    xs = [grid.x0 + c * grid.cell for _, c in best]
    ys = [grid.y1 - r * grid.cell for r, _ in best]
    return {"bounds_m": {"x": [min(xs), max(xs)], "y": [min(ys), max(ys)]},
            "area_m2": round(len(best) * grid.cell ** 2, 1)}


def find_walls(grid, min_rise_m=0.45, max_natural_grade=0.65, min_run_m=1.0):
    """Retaining walls: near-VERTICAL bands in the height field.

    `find_building` above locates the house as the enclosed hole the scanner could
    not see into. A wall is the same problem one scale down — long and thin in
    plan, and standing up rather than lying down. Without it, a bed extended across
    the crest and face of one passes every rule this project has, because
    validate() asks whether ground is inside the house footprint and never whether
    it is a wall.

    The test is grade between neighbouring cells. Steep natural garden ground runs
    to about 27 deg (grade 0.51), and the zones top out at "over 18 deg: leave it
    as slope"; a grade over 1.0 (45 deg) sustained across a cell is not a
    hillside.
    Runs shorter than min_run_m are dropped — a single steep cell is a boulder, a
    scan artefact or the edge of a step, not a wall.

    Returned in the DERIVED half of site.json, never the owner half: this is
    measurement, like zones, and `save-owner` refuses derived keys by design.
    """
    rows, cell = grid.rows, grid.cell
    H, W = len(rows), len(rows[0])
    steep = set()
    falls = []                      # unit direction of DROP for every steep pair
    for r in range(H):
        for c in range(W):
            z = rows[r][c]
            if z is None:
                continue
            for dr, dc in ((0, 1), (1, 0)):
                nr, nc = r + dr, c + dc
                if not (0 <= nr < H and 0 <= nc < W):
                    continue
                nz = rows[nr][nc]
                if nz is None:
                    continue
                rise = abs(z - nz)
                if rise >= min_rise_m and rise / cell > max_natural_grade:
                    steep.add((r, c)); steep.add((nr, nc))
                    # which way the ground drops across this pair
                    sgn = 1.0 if nz < z else -1.0
                    falls.append(((r, c), (nr, nc), (dc * sgn, dr * sgn)))

    seen, walls = set(), []
    for start in steep:
        if start in seen:
            continue
        comp, stack = [], [start]
        seen.add(start)
        while stack:
            r, c = stack.pop()
            comp.append((r, c))
            for dr in (-1, 0, 1):
                for dc in (-1, 0, 1):
                    n = (r + dr, c + dc)
                    if n in steep and n not in seen:
                        seen.add(n); stack.append(n)
        if len(comp) < 2:
            continue
        xs = [grid.x0 + c * cell for _, c in comp]
        ys = [grid.y1 - r * cell for r, _ in comp]
        span = max(max(xs) - min(xs), max(ys) - min(ys))
        if span < min_run_m:
            continue
        # A WALL FALLS ONE WAY; A BLIP FALLS INWARD FROM EVERY SIDE.
        #
        # Size alone cannot separate them: a single deep cell surrounded by flat
        # ground makes a five-cell component spanning two metres, which passes the
        # run test and would be reported as a 2 m wall. A boulder, a scan dropout or the
        # nose of a step all look like that.
        #
        # The difference is direction. Every steep pair across a wall drops the
        # same way, so the fall vectors add; around a pit or a pimple they point at
        # each other and cancel. The ratio of the summed vector to the summed
        # magnitudes is ~1 for a wall and ~0 for a blip.
        cs = set(comp)
        vs = [v for a, b, v in falls if a in cs and b in cs]
        if vs:
            sx = sum(v[0] for v in vs); sy = sum(v[1] for v in vs)
            coherence = (sx * sx + sy * sy) ** 0.5 / len(vs)
            if coherence < 0.5:
                continue
        zs = [rows[r][c] for r, c in comp if rows[r][c] is not None]
        walls.append({
            # the CELLS, not only their bounding box. A wall runs diagonally as
            # often as not, and a bbox test flags every bed within the diagonal's
            # rectangle — on a real site, three beds that are beside the wall rather
            # than on it.
            "cell_m": cell,
            "cell_xy": [[round(grid.x0 + c * cell, 1), round(grid.y1 - r * cell, 1)]
                        for r, c in comp],
            "cells": len(comp),
            "length_m": round(span, 1),
            "rise_m": round(max(zs) - min(zs), 2),
            "top_m": round(max(zs), 2),
            "bottom_m": round(min(zs), 2),
            "bounds_m": {"x": [round(min(xs), 1), round(max(xs), 1)],
                         "y": [round(min(ys), 1), round(max(ys), 1)]},
        })
    walls.sort(key=lambda w: -w["rise_m"])
    return walls


# Until north is set, the scan's x axis is the scanner's own heading, not east — so a zone
# called "east_yard" would be a claim the geometry cannot make, and a designer reasoning
# about morning sun on it would be reasoning about a fiction (a new site surveyed before
# north is set). Named by the scan's axes instead, and replaced by compass names on
# the first survey after north is set (these are never kept as the owner's names).
COMPASS = ("east_yard", "west_yard", "north_yard", "south_yard")
UNORIENTED = ("plus_x_side", "minus_x_side", "plus_y_side", "minus_y_side")


def north_is_set(site):
    """Whether bearings mean anything yet: the viewer's calibration, or what site.json recorded."""
    try:
        with open(project.data("calibration.json")) as f:
            if json.load(f).get("northSet"):
                return True
    except (OSError, ValueError):
        pass
    return bool((site or {}).get("frame", {}).get("north_set"))


def side_names(oriented=True, yaw_deg=0.0):
    """What each side of the building is called: (+x, -x, +y, -y). The grid is the SCAN's frame,
    not the compass's — a stored bearing is true only after the yaw (true = stored - yaw, sun.py)
    — so with north set each side is named by where it truly faces. Named by the stored axes, a
    capture turned 90 deg would call its north yard "east_yard" — invisible at yaw 0."""
    if not oriented:
        return UNORIENTED[0], UNORIENTED[1], UNORIENTED[2], UNORIENTED[3]
    by_bearing = {0: "north_yard", 1: "east_yard", 2: "south_yard", 3: "west_yard"}
    # the nearest compass point, a tie (45 deg) always to the next one clockwise: round() rounds
    # half to EVEN, and at 45 deg two sides would come out with the same name
    return tuple(by_bearing[int(((stored - yaw_deg) % 360 + 45) // 90) % 4] for stored in (90, 270, 0, 180))


def carve_zones(grid, building, oriented=True, yaw_deg=0.0):
    """
    Split the scanned ground into yards around the building.

    If there is no building, the whole scan is one zone — which is the right
    answer for a courtyard, a roof terrace or a field.
    """
    if not building:
        return {"yard": list(grid.cells())}
    bx = building["bounds_m"]["x"]
    by = building["bounds_m"]["y"]
    east, west, north, south = side_names(oriented, yaw_deg)     # the +x, -x, +y, -y sides
    zones = {east: [], west: [], north: [], south: []}
    for x, y, h in grid.cells():
        if bx[0] <= x <= bx[1] and by[0] <= y <= by[1]:
            continue                                    # on the building
        if x > bx[1]:
            zones[east].append((x, y, h))
        elif x < bx[0]:
            zones[west].append((x, y, h))
        elif y > by[1]:
            zones[north].append((x, y, h))
        elif y < by[0]:
            zones[south].append((x, y, h))
    return {k: v for k, v in zones.items() if v}


def summarise_zone(name, cells, grid, site=None):
    xs = [c[0] for c in cells]
    ys = [c[1] for c in cells]
    hs = sorted(c[2] for c in cells)
    n = len(cells)

    # least-squares plane -> slope and the direction water runs
    mx, my, mh = sum(xs) / n, sum(ys) / n, sum(hs) / n
    sxx = syy = sxy = sxh = syh = 0.0
    for x, y, h in cells:
        dx, dy, dh = x - mx, y - my, h - mh
        sxx += dx * dx; syy += dy * dy; sxy += dx * dy
        sxh += dx * dh; syh += dy * dh
    det = sxx * syy - sxy * sxy
    gx = (syy * sxh - sxy * syh) / det if det else 0.0
    gy = (sxx * syh - sxy * sxh) / det if det else 0.0
    slope = math.degrees(math.atan(math.hypot(gx, gy)))
    bearing = (math.degrees(math.atan2(-gx, -gy)) + 360) % 360

    # per-cell grade, smoothed over 3 m: usability is a property of a patch
    bands = {"flat_under_9deg": 0, "moderate_9_18": 0, "steep_over_18": 0}
    gentle = set()
    for x, y, _ in cells:
        vals = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                s = grid.slope_at(x + dx * grid.cell, y + dy * grid.cell)
                if s:
                    vals.append(s[0])
        if not vals:
            continue
        sm = sum(vals) / len(vals)
        bands["flat_under_9deg" if sm < 9 else
              "moderate_9_18" if sm < 18 else "steep_over_18"] += 1
        if sm < 10:
            gentle.add((x, y))

    # largest connected pocket of gentle ground — the scarcest thing on a slope
    pocket, seen = [], set()
    for g0 in gentle:
        if g0 in seen:
            continue
        stack, cur = [g0], []
        seen.add(g0)
        while stack:
            px, py = stack.pop(); cur.append((px, py))
            for dx, dy in ((grid.cell, 0), (-grid.cell, 0), (0, grid.cell), (0, -grid.cell)):
                nb = (px + dx, py + dy)
                if nb in gentle and nb not in seen:
                    seen.add(nb); stack.append(nb)
        if len(cur) > len(pocket):
            pocket = cur

    t = math.tan(math.radians(slope)) if slope > 0.1 else 0
    out = {
        "zone": name,
        "area_m2": round(n * grid.cell ** 2, 1),
        "bounds_m": {"x": [round(min(xs), 1), round(max(xs), 1)],
                     "y": [round(min(ys), 1), round(max(ys), 1)]},
        "ground_m": {"min": round(hs[0], 2), "median": round(hs[n // 2], 2),
                     "max": round(hs[-1], 2)},
        "slope_deg": round(slope, 1),
        "downhill_bearing_deg": round(bearing),
        "contour_bearing_deg": round((bearing + 90) % 180),
        "grade_breakdown_m2": {k: round(v * grid.cell ** 2, 1) for k, v in bands.items()},
    }
    if t:
        c = agent.constraints(site)
        out["max_level_pad_width_m"] = round(2 * c["retain_limit_m"] / t, 1)
        out["easy_level_pad_width_m"] = round(2 * c["footing_threshold_m"] / t, 1)
        # the limits these widths were measured against: the site's limits can change after
        # the survey, and the brief rescales from THESE, not from the defaults
        out["pad_width_limits_m"] = {k: c[k] for k in ("retain_limit_m", "footing_threshold_m")}
    if pocket:
        px = [p[0] for p in pocket]; py = [p[1] for p in pocket]
        out["gentlest_pocket"] = {"area_m2": round(len(pocket) * grid.cell ** 2, 1),
                                  "x": [round(min(px), 1), round(max(px), 1)],
                                  "y": [round(min(py), 1), round(max(py), 1)]}
    return out


def calibration_yaw_deg():
    """The active capture's yaw, in degrees (0 without one): what turns a stored bearing true."""
    try:
        with open(project.data("calibration.json")) as f:
            return math.degrees(float(json.load(f).get("yaw") or 0.0))
    except (OSError, ValueError, TypeError):
        return 0.0


def derive(g, site, cell, oriented=True, yaw_deg=0.0):
    """The DERIVED half of site.json from a scan grid (terrain_scan.json's shape): the zones
    around the building, the scanned area, the building found. Needs no viewer — the viewer only
    makes the grid — so a site whose grid is known (tools/demo_site.py) derives the same way.
    Returns (derived, building)."""
    grid = Grid(g)
    building = find_building(grid)
    zones = [summarise_zone(k, v, grid, site) for k, v in carve_zones(grid, building, oriented, yaw_deg).items()]
    zones.sort(key=lambda z: -z["area_m2"])

    # Keep names the owner or a previous run already gave these zones. Compass
    # names are all this can honestly infer on a new property — "back yard"
    # depends on where the front door is, which the geometry does not know — but
    # renaming an established zone would break every saved design that scopes to
    # it, and a tool that damages your data on a second run is worse than no tool.
    prior = site or {}
    for z in zones:
        for old_z in prior.get("zones", []):
            ob, nb = old_z.get("bounds_m"), z["bounds_m"]
            if not ob:
                continue
            overlap = (min(ob["x"][1], nb["x"][1]) - max(ob["x"][0], nb["x"][0]) > 0 and
                       min(ob["y"][1], nb["y"][1]) - max(ob["y"][0], nb["y"][0]) > 0)
            centre_close = (abs((ob["x"][0] + ob["x"][1]) / 2 - (nb["x"][0] + nb["x"][1]) / 2) < 6 and
                            abs((ob["y"][0] + ob["y"][1]) / 2 - (nb["y"][0] + nb["y"][1]) / 2) < 6)
            # a placeholder name is not the owner's, and a compass name made before north
            # was set is not true: neither is kept over what this run can now say
            placeholder = old_z["zone"] in UNORIENTED or (old_z["zone"] in COMPASS and not oriented)
            if overlap and centre_close and not placeholder:
                if old_z["zone"] != z["zone"]:
                    print(f"  keeping the existing name \"{old_z['zone']}\" for what geometry "
                          f"calls {z['zone']}")
                z["zone"] = old_z["zone"]
                if old_z.get("note"):
                    z["note"] = old_z["note"]
                break
    derived = {
        "zones": zones,
        "scan_coverage": {
            "method": f"{cell} m downward raycast onto the scan mesh, lowest hit per column",
            "scanned_ground_m2": round(g["scanned_cells"] * cell ** 2, 1),
            "generated_by": "tools/analyze_site.py"},
    }
    if building:
        derived["house_measured"] = {
            "source": "enclosed unscanned region in the scan mesh",
            "bounds_m": {"x": [round(v, 1) for v in building["bounds_m"]["x"]],
                         "y": [round(v, 1) for v in building["bounds_m"]["y"]]},
            "area_m2": building["area_m2"]}
    return derived, building


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--cell", type=float, default=1.0)
    ap.add_argument("--extent", type=float, default=26.0)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    site_path = project.data("site.json")
    # Read BEFORE the raycast, not after. summarise_zone needs site.constraints
    # for its pad widths and the name-preserving pass needs the previous zones,
    # so this read is needed anyway — doing it first means a site.json that
    # will not parse costs nothing. We are not going to write over a file we
    # cannot read (geodata.SiteUnreadable says why), and asking the browser for
    # a 1 m raycast first would spend minutes to reach the same refusal.
    try:
        site = geodata.load_site(site_path)
    except geodata.SiteUnreadable as e:
        raise SystemExit(str(e))

    print(f"asking the viewer to raycast the scan at {a.cell} m …")
    g = fetch_scan_grid(a.cell, a.extent)
    print(f"  {g['scanned_cells']} of {g['total_cells']} cells hit ground "
          f"({g['scanned_cells'] * a.cell ** 2:.0f} m2 scanned)")
    oriented = north_is_set(site)
    if not oriented:
        print("  north is not set: zones are named by the scan's own axes, not the compass")
    derived, building = derive(g, site, a.cell, oriented, calibration_yaw_deg() if oriented else 0.0)
    zones = derived["zones"]
    print(f"  building: {building['area_m2']} m2 at x {building['bounds_m']['x']}, "
          f"y {building['bounds_m']['y']}" if building else "  no enclosed building found")

    for z in zones:
        gp = z.get("gentlest_pocket")
        print(f"  {z['zone']:14s} {z['area_m2']:6.0f} m2  slope {z['slope_deg']:4.1f} deg "
              f"-> {z['downhill_bearing_deg']:3d} deg  "
              f"flat {z['grade_breakdown_m2']['flat_under_9deg']:5.0f} m2"
              + (f"  pocket {gp['area_m2']:.0f} m2" if gp else "  no gentle pocket"))

    if a.dry_run:
        print("\n--dry-run: nothing written")
        return

    scan_path = project.data("terrain_scan.json")
    with open(scan_path, "w") as f:
        json.dump(g, f)

    # Only the derived half, and merged onto a FRESH read: `site` above is now
    # minutes old — the raycast happens in a browser the owner is looking at,
    # and they can draw an area while it runs. geodata.merge_section rejects a
    # write outside this half rather than trusting the dict assembled here.
    try:
        site = geodata.merge_section(geodata.load_site(site_path), "derived", derived)
    except geodata.SiteUnreadable as e:
        raise SystemExit(f"{e} (the raycast is safe in {os.path.relpath(scan_path, ROOT)})")
    geodata.save_site(site, site_path)
    print(f"\nwrote {os.path.relpath(scan_path, ROOT)} and site.zones "
          f"({len(zones)} zones) into {os.path.relpath(site_path, ROOT)}")


if __name__ == "__main__":
    main()
