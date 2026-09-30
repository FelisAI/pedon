#!/usr/bin/env python3
"""THE SITE IN PLAN, WITH COORDINATES — what a designer draws on.

A fresh design starts from a blank sheet, and camera views give a designer nothing
to read x, y off and nothing that shows where the ground is gentle and where it
falls away. Designing from the ground up needs a plan with a metre grid, the grade,
the contours, the house, the owner's drawn areas and landmarks, and the design
drawn over it at FULL MATURE spread — so this draws exactly that, as a PNG.

    python3 tools/site_plan.py --out plan.png                          # the bare site
    python3 tools/site_plan.py --design data/designs/X.json --out plan.png
    python3 tools/site_plan.py --design X.json --bounds 11 -13 17 -4 --scale 90 --out bed.png

Grade is measured over +-1 m (a 0.5 m difference is noise, not a slope) and banded
as DESIGNING.md bands it: under 9 deg, 9-18, over 18. Ground the scanner never saw
is grey — the filled height field invents ground there (agent.scan_at, not
ground_at). Plants are circles at MATURE spread labelled with the planting plan's
own key codes (planting_plan.key_codes), so the two drawings read the same.
"""
from __future__ import annotations
import argparse
import json
import math
import os
import project  # the active project's files — the ONE owner
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import agent  # noqa: E402  ground_at / scan_at: the validator's own ruler
from planting_plan import key_codes  # noqa: E402  one owner for the codes

FLAT_DEG, STEEP_DEG = 9.0, 18.0          # DESIGNING.md's grade bands


def _hex(c, alpha):
    if isinstance(c, str) and len(c) == 7 and c.startswith("#"):
        return tuple(int(c[k:k + 2], 16) for k in (1, 3, 5)) + (alpha,)
    return (95, 143, 90, alpha)


def _points(design):
    for key in ("beds", "patios"):
        for b in design.get(key, []):
            yield from b.get("polygon") or []
    for key in ("paths", "steps", "edges"):
        for p in design.get(key, []):
            yield from p.get("spline") or p.get("points") or []
    for key in ("plants", "objects"):
        for p in design.get(key, []):
            if p.get("position"):
                yield p["position"]


def default_bounds(design, site, margin=2.0):
    """The design, else the owner's drawn areas, else the largest zone — never a
    hard-coded yard."""
    pts = [q[:2] for q in _points(design or {})]
    if not pts:
        pts = [q[:2] for a in site.get("areas", []) for q in (a.get("polygon") or [])]
    if pts:
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        return (min(xs) - margin, min(ys) - margin, max(xs) + margin, max(ys) + margin)
    zones = sorted(site.get("zones", []), key=lambda z: -(z.get("area_m2") or 0))
    if zones and zones[0].get("bounds_m"):
        b = zones[0]["bounds_m"]
        return (b["x"][0] - margin, b["y"][0] - margin, b["x"][1] + margin, b["y"][1] + margin)
    return (-10.0, -10.0, 10.0, 10.0)


def grade_deg(g, i, j, step, reach=2):
    """Slope in degrees at cell (i, j) of a height grid, measured over +-reach cells."""
    ny, nx = len(g), len(g[0])
    a, b = g[j][max(0, i - reach)], g[j][min(nx - 1, i + reach)]
    c, d = g[max(0, j - reach)][i], g[min(ny - 1, j + reach)][i]
    if None in (a, b, c, d):
        return None
    dx = (b - a) / ((min(nx - 1, i + reach) - max(0, i - reach)) * step)
    dy = (d - c) / ((min(ny - 1, j + reach) - max(0, j - reach)) * step)
    return math.degrees(math.atan(math.hypot(dx, dy)))


def render(out, design=None, site=None, bounds=None, scale=None, step=0.5, title=""):
    from PIL import Image, ImageDraw, ImageFont
    site = site if site is not None else json.load(open(project.data("site.json")))
    design = design or {}
    x0, y0, x1, y1 = bounds or default_bounds(design, site)
    scale = scale or max(20, min(120, int(900 / max(x1 - x0, y1 - y0, 1))))
    W, H = int((x1 - x0) * scale), int((y1 - y0) * scale)
    img = Image.new("RGB", (W + 60, H + 44), (24, 26, 22))
    dr = ImageDraw.Draw(img, "RGBA")

    def px(x, y):
        return (40 + (x - x0) * scale, 22 + (y1 - y) * scale)   # north up
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 11)
    except OSError:
        font = ImageFont.load_default()

    nx, ny = int((x1 - x0) / step) + 1, int((y1 - y0) / step) + 1
    g = [[agent.ground_at(x0 + i * step, y0 + j * step) for i in range(nx)] for j in range(ny)]
    seen = [[agent.scan_at(x0 + i * step, y0 + j * step) is not None for i in range(nx)] for j in range(ny)]
    for j in range(ny - 1):
        for i in range(nx - 1):
            x, y = x0 + i * step, y0 + j * step
            if not seen[j][i]:
                dr.rectangle([px(x, y + step), px(x + step, y)], fill=(55, 55, 55, 255))
                continue
            deg = grade_deg(g, i, j, step)
            if deg is None:
                continue
            col = (70, 130, 70) if deg < FLAT_DEG else (170, 150, 60) if deg < STEEP_DEG else (160, 70, 55)
            dr.rectangle([px(x, y + step), px(x + step, y)], fill=col + (255,))
    # contours every 0.5 m, labelled sparsely
    for j in range(ny - 1):
        for i in range(nx - 1):
            h, hx = g[j][i], g[j][i + 1]
            if h is None or hx is None or h == hx or not (seen[j][i] and seen[j][i + 1]):
                continue          # a contour through invented ground is invented too
            for k in range(math.ceil(min(h, hx) / 0.5), math.floor(max(h, hx) / 0.5) + 1):
                lvl = k * 0.5
                x = x0 + (i + (lvl - h) / (hx - h)) * step
                q = px(x, y0 + j * step)
                dr.ellipse([q[0] - 1, q[1] - 1, q[0] + 1, q[1] + 1], fill=(255, 255, 255, 150))
                if j % 12 == 0:
                    dr.text(q, f"{lvl:+.1f}", fill=(255, 255, 255, 220), font=font)
    if site.get("footprint"):
        dr.polygon([px(*p[:2]) for p in site["footprint"]], fill=(90, 90, 100, 255), outline=(200, 200, 210))
    for a in site.get("areas", []):
        poly = a.get("polygon") or []
        if len(poly) > 2:
            dr.polygon([px(*p[:2]) for p in poly], outline=(120, 200, 255), width=2)
            cx, cy = sum(p[0] for p in poly) / len(poly), sum(p[1] for p in poly) / len(poly)
            dr.text(px(cx, cy), a.get("name", ""), fill=(150, 220, 255), font=font)
    for lm in site.get("landmarks", []):
        if "x" in lm and "y" in lm:
            q = px(lm["x"], lm["y"])
            dr.ellipse([q[0] - 4, q[1] - 4, q[0] + 4, q[1] + 4], fill=(255, 150, 40))
            dr.text((q[0] + 5, q[1] - 6), lm.get("name", ""), fill=(255, 190, 120), font=font)

    for b in design.get("patios", []):
        dr.polygon([px(*p[:2]) for p in b["polygon"]], fill=(190, 180, 160, 210), outline="white")
    for b in design.get("beds", []):
        dr.polygon([px(*p[:2]) for p in b["polygon"]], fill=(110, 75, 45, 190), outline=(200, 160, 110))
    for key, colour in (("paths", (230, 215, 180, 230)), ("steps", (255, 255, 255, 230))):
        for p in design.get(key, []):
            line = p.get("spline") or p.get("points") or []
            if len(line) > 1:
                dr.line([px(*q[:2]) for q in line], fill=colour, width=max(2, int(p.get("width_m", 1.0) * scale)),
                        joint="curve")
    for e in design.get("edges", []):
        line = e.get("spline") or []
        if len(line) > 1:
            dr.line([px(*q[:2]) for q in line], fill=(40, 40, 40, 255), width=3)
    plants = [p for p in design.get("plants", []) if p.get("position")]
    codes = key_codes({p["species"] for p in plants}) if plants else {}
    for p in sorted(plants, key=lambda p: -(p.get("mature_spread_m") or 0.5)):
        q = px(*p["position"][:2])
        r = (p.get("mature_spread_m") or 0.5) / 2 * scale
        if p.get("form") == "tree":
            dr.ellipse([q[0] - r, q[1] - r, q[0] + r, q[1] + r], outline=(60, 150, 60, 255), width=3)
        else:
            dr.ellipse([q[0] - r, q[1] - r, q[0] + r, q[1] + r],
                       fill=_hex(p.get("flower") or p.get("foliage"), 190), outline=(0, 0, 0, 140))
    if scale >= 45:                 # a code inside a 10-pixel circle is a smudge
        for p in plants:
            q = px(*p["position"][:2])
            dr.text((q[0] - 12, q[1] - 6), codes[p["species"]], fill="black", font=font)
    for o in design.get("objects", []):
        if o.get("position"):
            q = px(*o["position"][:2])
            dr.rectangle([q[0] - 3, q[1] - 3, q[0] + 3, q[1] + 3], fill="white", outline="black")
    grid = 1 if (x1 - x0) <= 20 else 2
    for x in range(math.ceil(x0), math.floor(x1) + 1):
        if x % grid == 0:
            dr.line([px(x, y0), px(x, y1)], fill=(255, 255, 255, 40))
            dr.text((px(x, y0)[0] - 6, H + 26), str(x), fill="white", font=font)
    for y in range(math.ceil(y0), math.floor(y1) + 1):
        if y % grid == 0:
            dr.line([px(x0, y), px(x1, y)], fill=(255, 255, 255, 40))
            dr.text((4, px(x0, y)[1] - 6), str(y), fill="white", font=font)
    dr.text((44, 4), (title + " · " if title else "") +
            "green <9° · ochre 9-18° · red >18° · grey unscanned · dots 0.5 m contours · north up · plants at MATURE spread",
            fill="white", font=font)
    img.save(out)
    return {"out": out, "bounds": [x0, y0, x1, y1], "scale_px_per_m": scale,
            "plants": len(plants), "codes": codes}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument("--design", help="a design JSON to draw over the site")
    ap.add_argument("--out", required=True, help="PNG to write")
    ap.add_argument("--bounds", nargs=4, type=float, metavar=("X0", "Y0", "X1", "Y1"))
    ap.add_argument("--scale", type=int, help="pixels per metre")
    ap.add_argument("--title", default="")
    a = ap.parse_args(argv)
    design = json.load(open(project.resolve(a.design))) if a.design else None
    from site_api import NoSite, _site      # one owner of the "no site yet" answer
    try:
        site = _site()
    except NoSite as e:
        print(e.args[0])                    # the same refusal, and fix, site_api gives
        return 2
    print(json.dumps(render(project.resolve(a.out), design, site=site, bounds=a.bounds, scale=a.scale, title=a.title), indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
