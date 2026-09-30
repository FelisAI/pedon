"""A DEMO SITE, made by code: a small sloping garden — a house, a stone patio at its door, a
fence with a gate, three boulders — as a scan, its calibration, its ground truth and a starter
design, all consistent with each other, so someone can try PEDON before scanning their own ground.

Nothing here is shipped as a file: the scan is generated, so the app still carries no assets.

The pieces follow the app's own conventions (docs/site.md, viewer/src/main.js):
  - the scan is a GLB mesh in the capture frame, y up, levelled: a site point (x east, y north,
    h up) is the GLB point (x, h, -y); the house is WALLS ONLY, as a scan from the ground has no
    roof — so the house is found the way a real one is, as ground the scan never saw;
  - north is SET, at a yaw that is not zero (true = stored - yaw), so the demo exercises every
    frame conversion, which a site at yaw 0 cannot;
  - terrain_scan.json is the raycast analyze_site.py would get from this mesh — the lowest hit
    per 1 m column, north row first; measured against the viewer's own raycast of the GLB, 0 of
    612 cells differ — and the zones are derived from it by analyze_site's own code
    (analyze_site.derive), not written by hand;
  - landmarks, areas and viewpoints are the demo's ground truth, authored here as its owner;
  - the starter design goes through the one write path (site_api.py apply-ops).

    python3 tools/demo_site.py [--open]     # creates <projects>/demo-garden, or says it exists
"""
from __future__ import annotations
import argparse
import datetime as _dt
import json
import math
import os
import struct
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import project  # noqa: E402  where sites live
import analyze_site  # noqa: E402  the derived half, by the same code a real site uses

SLUG = "demo-garden"
NAME = "Demo garden"
CAPTURE = "/data/captures/demo-garden.glb"
YAW_DEG = 25.0                                  # north is set, and not along the scan's axes

LOT = (-14.0, 14.0, -10.0, 12.0)                # x0, x1, y0, y1 — metres, site frame
HOUSE = (-7.0, 5.0, 5.0, 11.0)                  # walls only
INTERIOR = (-6.5, 4.5, 5.5, 10.5)               # what no scan sees: inside the walls
WALL_H, WALL_T = 3.2, 0.2
FENCE_H, FENCE_T = 1.4, 0.08
GATE = (-14.0, -3.5, -1.5)                      # a gap in the west fence: x, y from, y to
PATIO = (-3.0, 1.0, 2.2, 5.0)
STONES = [(4.2, -5.0, 0.9, 0.55), (6.1, -6.3, 0.6, 0.4), (-8.5, -6.5, 0.7, 0.45)]   # x, y, radius, height


def ground(x, y):
    """The ground's height above the levelled plane: a fall toward the south-west, a gentle roll."""
    return round(0.075 * (y + 10) + 0.02 * (x + 14) + 0.10 * math.sin(x / 3.1) * math.cos(y / 4.3), 4)


def _in(box, x, y, strict=False):
    x0, x1, y0, y1 = box
    return (x0 < x < x1 and y0 < y < y1) if strict else (x0 <= x <= x1 and y0 <= y <= y1)


# ── the scan: one mesh, vertex-coloured ─────────────────────────────────────────────────────

class Mesh:
    def __init__(self):
        self.pos, self.col, self.idx = [], [], []

    def quad(self, a, b, c, d, colour):
        """Four site points (x, y, h), counter-clockwise seen from outside; `colour` one RGB, or a
        function of (x, y) for a colour that runs smoothly across quads."""
        base = len(self.pos)
        for x, y, h in (a, b, c, d):
            self.pos.append((x, h, -y))               # site -> capture frame
            self.col.append(colour(x, y) if callable(colour) else colour)
        self.idx += [base, base + 1, base + 2, base, base + 2, base + 3]

    def box(self, x0, x1, y0, y1, h0, h1, colour, bottom=False):
        c = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
        for i in range(4):
            (ax, ay), (bx, by) = c[i], c[(i + 1) % 4]
            self.quad((ax, ay, h0), (bx, by, h0), (bx, by, h1), (ax, ay, h1), colour)
        self.quad((x0, y0, h1), (x1, y0, h1), (x1, y1, h1), (x0, y1, h1), colour)
        if bottom:
            self.quad((x0, y1, h0), (x1, y1, h0), (x1, y0, h0), (x0, y0, h0), colour)


def _grass(x, y):
    """Grass that varies over a few metres, and a worn line of bare soil across the east side."""
    t = 0.5 + 0.25 * math.sin(x / 2.3 + math.cos(y / 3.1) * 1.5) + 0.25 * math.sin(y / 1.7 - x / 4.1)
    soil = max(0.0, 1.0 - abs(y - 1.0) / 0.7) * min(1.0, max(0.0, x - 2.5))
    g = (0.29 + 0.07 * t, 0.41 + 0.09 * t, 0.19 + 0.04 * t)
    return tuple(g[i] * (1 - soil) + (0.45, 0.36, 0.26)[i] * soil for i in range(3))


def scan_mesh():
    m = Mesh()
    x0, x1, y0, y1 = LOT
    step = 0.5
    nx, ny = int((x1 - x0) / step), int((y1 - y0) / step)
    for i in range(nx):
        for j in range(ny):
            ax, ay = x0 + i * step, y0 + j * step
            bx, by = ax + step, ay + step
            cx, cy = (ax + bx) / 2, (ay + by) / 2
            # no floor: the scan never saw inside — but the ground runs on under the walls, so a
            # ray down a wall line meets ground, as analyze_site's raycast must (cut AT the wall
            # line, seven wall cells read the wall top, 4.2 m, and turn two zones 17 deg)
            if _in(INTERIOR, cx, cy, strict=True):
                continue
            m.quad((ax, ay, ground(ax, ay)), (bx, ay, ground(bx, ay)),
                   (bx, by, ground(bx, by)), (ax, by, ground(ax, by)), _grass)
    # the house: four walls standing on the ground at their lowest corner, no roof
    hx0, hx1, hy0, hy1 = HOUSE
    base = min(ground(x, y) for x in (hx0, hx1) for y in (hy0, hy1)) - 0.2
    stucco = (0.86, 0.82, 0.74)
    m.box(hx0, hx1, hy0 - WALL_T / 2, hy0 + WALL_T / 2, base, base + WALL_H, stucco)
    m.box(hx0, hx1, hy1 - WALL_T / 2, hy1 + WALL_T / 2, base, base + WALL_H, stucco)
    m.box(hx0 - WALL_T / 2, hx0 + WALL_T / 2, hy0, hy1, base, base + WALL_H, stucco)
    m.box(hx1 - WALL_T / 2, hx1 + WALL_T / 2, hy0, hy1, base, base + WALL_H, stucco)
    # the patio: a level stone slab at the door, its top at the ground's highest corner
    px0, px1, py0, py1 = PATIO
    top = max(ground(x, y) for x in (px0, px1) for y in (py0, py1)) + 0.05
    m.box(px0, px1, py0, py1, min(ground(x, y) for x in (px0, px1) for y in (py0, py1)) - 0.1, top,
          (0.72, 0.66, 0.56))
    # the fence, with a gate in the west side
    wood = (0.48, 0.36, 0.24)
    fb = lambda x, y: ground(x, y) - 0.1
    m.box(x0, x1, y0 - FENCE_T / 2, y0 + FENCE_T / 2, fb(0, y0), fb(0, y0) + FENCE_H + 0.3, wood)
    m.box(x0, x1, y1 - FENCE_T / 2, y1 + FENCE_T / 2, fb(0, y1), fb(0, y1) + FENCE_H, wood)
    m.box(x1 - FENCE_T / 2, x1 + FENCE_T / 2, y0, y1, fb(x1, 0), fb(x1, 0) + FENCE_H, wood)
    gx, gy0, gy1 = GATE
    m.box(gx - FENCE_T / 2, gx + FENCE_T / 2, y0, gy0, fb(gx, y0), fb(gx, y0) + FENCE_H + 0.2, wood)
    m.box(gx - FENCE_T / 2, gx + FENCE_T / 2, gy1, y1, fb(gx, y1), fb(gx, y1) + FENCE_H, wood)
    # the boulders: low domes of stone
    for sx, sy, r, h in STONES:
        rings, segs = 5, 14
        g = ground(sx, sy) - 0.08
        ring = lambda k: [(sx + r * math.cos(k / rings * math.pi / 2) * math.cos(t / segs * 2 * math.pi),
                           sy + r * math.cos(k / rings * math.pi / 2) * math.sin(t / segs * 2 * math.pi),
                           g + h * math.sin(k / rings * math.pi / 2)) for t in range(segs + 1)]
        for k in range(rings):
            lo, hi = ring(k), ring(k + 1)
            shade = 0.52 + 0.06 * k / rings
            for t in range(segs):
                m.quad(lo[t], lo[t + 1], hi[t + 1], hi[t], (shade, shade * 0.97, shade * 0.93))
    return m


def write_glb(mesh, path):
    """A GLB of one vertex-coloured, flat-shaded primitive — no dependencies."""
    # flat normals: each quad's own, so the stone and the walls read as faces
    normals = [None] * len(mesh.pos)
    for k in range(0, len(mesh.idx), 6):
        a, b, c = (mesh.pos[i] for i in mesh.idx[k:k + 3])
        u = [b[i] - a[i] for i in range(3)]
        v = [c[i] - a[i] for i in range(3)]
        n = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
        ln = math.sqrt(sum(x * x for x in n)) or 1.0
        for i in set(mesh.idx[k:k + 6]):
            normals[i] = tuple(x / ln for x in n)
    blobs = [b"".join(struct.pack("<3f", *p) for p in mesh.pos),
             b"".join(struct.pack("<3f", *n) for n in normals),
             b"".join(struct.pack("<3f", *c) for c in mesh.col),
             b"".join(struct.pack("<I", i) for i in mesh.idx)]
    views, offset, binary = [], 0, b""
    for blob, target in zip(blobs, (34962, 34962, 34962, 34963)):
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(blob), "target": target})
        binary += blob
        offset += len(blob)
    lo = [min(p[i] for p in mesh.pos) for i in range(3)]
    hi = [max(p[i] for p in mesh.pos) for i in range(3)]
    n = len(mesh.pos)
    gltf = {
        "asset": {"version": "2.0", "generator": "PEDON tools/demo_site.py"},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0, "name": "demo-garden"}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1, "COLOR_0": 2},
                                    "indices": 3, "material": 0}]}],
        "materials": [{"pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0,
                                                "roughnessFactor": 0.92}, "doubleSided": True}],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": n, "type": "VEC3", "min": lo, "max": hi},
            {"bufferView": 1, "componentType": 5126, "count": n, "type": "VEC3"},
            {"bufferView": 2, "componentType": 5126, "count": n, "type": "VEC3"},
            {"bufferView": 3, "componentType": 5125, "count": len(mesh.idx), "type": "SCALAR"}],
        "bufferViews": views,
        "buffers": [{"byteLength": len(binary)}],
    }
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    binary += b"\0" * (-len(binary) % 4)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(binary)))
        f.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        f.write(struct.pack("<II", len(binary), 0x004E4942) + binary)


# ── what the app would measure from that scan ───────────────────────────────────────────────

def scan_grid(cell=1.0, extent=26.0):
    """terrain_scan.json as analyze_site.py's raycast returns it: the lowest hit per column —
    the ground, which runs under the patio, the stones and the fence — north row first, null
    where nothing was hit (outside the lot, and inside the house)."""
    r = int(extent)
    rows = []
    for y in range(r, -r - 1, -int(cell)):
        row = []
        for x in range(-r, r + 1, int(cell)):
            inside = _in(LOT, x, y) and not _in(HOUSE, x, y, strict=True)
            row.append(round(ground(x, y), 2) if inside else None)
        rows.append(row)
    scanned = sum(v is not None for row in rows for v in row)
    return {"source": "tools/demo_site.py: the demo's own ground", "cell_m": cell,
            "x0": -extent, "x1": extent, "y0": -extent, "y1": extent, "rows": rows,
            "scanned_cells": scanned, "total_cells": len(rows) * len(rows[0])}


def calibration():
    """The scan is metric and level already; north is set at YAW_DEG."""
    yaw = math.radians(YAW_DEG)
    # the ground's mean fall, as the viewer's fitGround measures it: the plane normal in the
    # capture frame, whose horizontal part points downhill
    gx, gy = 0.02, 0.075                               # dh/dx, dh/dy of ground()
    n = (-gx, 1.0, gy)                                 # capture (x, h, -y): d/dz = -d/dy
    ln = math.sqrt(sum(v * v for v in n))
    normal = {"x": n[0] / ln, "y": n[1] / ln, "z": n[2] / ln}
    slope = math.degrees(math.atan(math.hypot(gx, gy)))
    keys = {"plane": {"nx": 0, "ny": 1, "nz": 0, "d": 0}, "scale": 1, "yaw": yaw, "tx": 0, "tz": 0,
            "spans": [], "groundNormal": normal, "slopeDeg": slope, "northSet": True}

    def world(x, h, z):                               # three.js R_y(yaw), for the camera
        return [round(x * math.cos(yaw) + z * math.sin(yaw), 3), round(h, 3),
                round(-x * math.sin(yaw) + z * math.cos(yaw), 3)]
    return {**keys, "scaleAccepted": True, "capture": CAPTURE, "captureUrl": CAPTURE,
            "captures": {CAPTURE: dict(keys)},
            # the first view: from above the south-west corner, over the garden to the house
            "bookmarks": {"default": {"pos": world(-17.0, 13.0, 19.0), "target": world(0.0, 1.0, -1.0)}}}


def site_json():
    hx0, hx1, hy0, hy1 = HOUSE
    px0, px1, py0, py1 = PATIO
    now = _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()
    lm = lambda name, x, y: {"name": name, "x": x, "y": y, "local": [x, round(ground(x, y), 3), -y]}
    return {
        # FETCHED (geodata.py's half), for a place that does not exist
        "version": 1, "units": "meters", "crs": "local ENU, x=east y=north, origin at `origin`",
        "address": "PEDON demo garden — a made-up place", "zip": "",
        "origin": {"lat": 34.42, "lon": -119.70}, "usda_zone": "10a", "usda_temp_range_f": "30 to 35",
        "footprint": [[hx0, hy0], [hx1, hy0], [hx1, hy1], [hx0, hy1]],
        "footprint_source": "tools/demo_site.py — the demo house", "roof_segments": [],
        "imagery_quality": None, "existing_trees": [], "lot": None, "fetched_at": now,
        # OWNER (the demo's): what someone standing in this garden would mark
        "landmarks": [lm("back_door", -1.0, 5.0), lm("gate", -14.0, -2.5),
                      lm("big_stone", STONES[0][0], STONES[0][1]), lm("patio_corner", px0, py0),
                      lm("fence_corner_southeast", 14.0, -10.0)],
        "landmarks_frame": CAPTURE,
        "areas": [{"name": "sunny_bank", "polygon": [[3.0, -2.0], [12.5, -2.0], [12.5, -8.5], [3.0, -8.5]]},
                  {"name": "by_the_patio", "polygon": [[-6.5, 1.5], [-3.4, 1.5], [-3.4, 4.6], [-6.5, 4.6]]}],
        "viewpoints": [
            {"name": "from the back door", "eye": [-1.0, 4.3, 1.6], "look_at": [3.0, -6.0, 0.4]},
            {"name": "from the gate", "eye": [-13.0, -2.5, 1.6], "look_at": [4.0, 1.0, 0.6]}],
        "frame": {"capture": CAPTURE, "north_set": True, "yaw_rad": round(math.radians(YAW_DEG), 6)},
        "terrain": {"slope_deg": round(calibration()["slopeDeg"], 1)},
    }


STARTER = [
    {"tool": "upsert_bed", "input": {"id": "bank_bed", "mulch": "shredded_hardwood",
     "polygon": [[3.5, -2.5], [12.0, -2.5], [12.0, -8.0], [7.0, -8.6], [3.5, -7.0]]}},
    {"tool": "set_path", "input": {"id": "gate_walk", "width_m": 1.0, "material": "decomposed_granite",
     "spline": [[-13.2, -2.5], [-9.0, -1.2], [-5.0, 0.8], [-2.8, 2.4]]}},
    {"tool": "place_plants", "input": {"plants": [
        {"species": "Olea europaea", "common": "Olive", "form": "tree", "mature_height_m": 4.5,
         "mature_spread_m": 4.0, "foliage": "#7d8c6a", "position": [8.5, -4.2]},
        *[{"species": "Lavandula angustifolia", "common": "English lavender", "form": "mound",
           "mature_height_m": 0.6, "mature_spread_m": 0.8, "foliage": "#8a9a7e", "flower": "#8e7cc3",
           "position": p} for p in ([4.8, -3.4], [5.6, -4.6], [4.6, -5.8])],
        *[{"species": "Muhlenbergia capillaris", "common": "Pink muhly", "form": "grass",
           "mature_height_m": 0.9, "mature_spread_m": 0.9, "foliage": "#7f8a55", "flower": "#d58fb4",
           "position": p} for p in ([10.8, -3.6], [11.2, -5.0], [10.2, -6.2])],
        *[{"species": "Achillea millefolium", "common": "Yarrow", "form": "perennial",
           "mature_height_m": 0.6, "mature_spread_m": 0.6, "foliage": "#7a8f5c", "flower": "#f2e6c9",
           "position": p} for p in ([7.4, -6.9], [6.4, -7.2], [8.6, -7.4])],
    ]}},
]


def create(open_it=False):
    """Make <projects>/demo-garden, or report that it is already there. Returns its slug."""
    folder = os.path.join(project.PROJECTS, SLUG)
    if os.path.exists(folder):
        if open_it:
            project.activate(SLUG)
        return SLUG
    tmp = folder + ".making"
    if os.path.exists(tmp):
        import shutil
        shutil.rmtree(tmp)
    os.makedirs(os.path.join(tmp, "captures"))
    os.makedirs(os.path.join(tmp, "designs"))
    write_glb(scan_mesh(), os.path.join(tmp, "captures", "demo-garden.glb"))
    calib = calibration()
    site = site_json()
    g = scan_grid()
    derived, _ = analyze_site.derive(g, site, g["cell_m"], oriented=True, yaw_deg=YAW_DEG)
    site.update(derived)
    for name, doc in (("calibration.json", calib), ("site.json", site), ("terrain_scan.json", g),
                      ("design.json", project.EMPTY_DESIGN),
                      ("project.json", {"name": NAME, "units": "metric", "demo": True,
                                        "created": _dt.date.today().isoformat()})):
        with open(os.path.join(tmp, name), "w") as f:
            json.dump(doc, f, indent=1)
    # the starter garden through the ONE write path, as any hand edit or model edit goes
    ops = os.path.join(tmp, "starter-ops.json")
    with open(ops, "w") as f:
        json.dump(STARTER, f)
    r = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "site_api.py"),
                        "apply-ops", "--ops-file", ops],
                       env=dict(os.environ, PEDON_PROJECT=tmp, YARDTWIN_CALL_LOG=os.devnull),
                       capture_output=True, text=True, timeout=120)
    os.remove(ops)
    # its ANSWER, not its exit code: apply-ops exits 0 having refused every op and written
    # nothing, and read by its exit code the demo would come out an empty garden without a word
    try:
        answer = json.loads(r.stdout)
    except ValueError:
        answer = {}
    if r.returncode != 0 or not answer.get("ok") or not answer.get("wrote"):
        raise SystemExit(f"the demo's starter design was refused:\n{r.stdout}{r.stderr}")
    os.rename(tmp, folder)
    if open_it:
        project.activate(SLUG)
    return SLUG


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--open", action="store_true", help="make it the active site")
    a = ap.parse_args()
    existed = os.path.exists(os.path.join(project.PROJECTS, SLUG))
    slug = create(open_it=a.open)
    print(json.dumps({"project": slug, "folder": os.path.join(project.PROJECTS, slug),
                      "created": not existed, "active": project.active() == slug}))


if __name__ == "__main__":
    main()
