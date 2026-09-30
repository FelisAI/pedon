"""Build data/site.json for a US address from public geodata.

Sources (all free at one-house volume):
  - US Census geocoder (address -> lat/lon/zip, no key)
  - Google Solar API buildingInsights + dataLayers (needs GOOGLE_MAPS_API_KEY
    with the Solar API enabled on the Cloud project)
  - Overture Maps building footprints (via the `overturemaps` CLI, no key)
  - phzmapi.org (zip -> USDA hardiness zone, no key)

Usage:
  python tools/geodata.py --address "1234 Example St, Atlanta, GA" \
      [--quality BASE] [--radius 60] [--no-datalayers] [--out data/site.json]

This module also holds the OWNERSHIP MAP for site.json — SECTIONS, load_site,
merge_section, save_site — because it is the tool that creates the file. Any
tool that writes site.json goes through merge_section so it can only ever
replace its own half; see the block below for why.
"""
from __future__ import annotations
from geom import point_in_polygon
import argparse
import datetime as dt
import json
import math
import os
import project  # the active project's files — the ONE owner
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

M_PER_DEG_LAT = 110_540.0       # an equirectangular approximation: good to centimetres across a site
M_PER_DEG_LON_EQ = 111_320.0


def lonlat_to_enu(lon, lat, origin_lon, origin_lat):
    """Longitude and latitude to metres east and north of the origin, (x_east_m, y_north_m)."""
    x = (lon - origin_lon) * M_PER_DEG_LON_EQ * math.cos(math.radians(origin_lat))
    y = (lat - origin_lat) * M_PER_DEG_LAT
    return x, y

# `requests` is imported inside the four functions that make an HTTP call, not
# at module scope, because this module is also the home of the site.json
# ownership map below — and analyze_site.py, which never touches the network,
# imports it for that.

SOLAR = "https://solar.googleapis.com/v1"


# ── who may rewrite what in data/site.json ────────────────────────────────
# site.json holds three kinds of fact with three different authors. Rebuilding
# the whole file and copying back a hand-maintained list of survivors is
# fail-OPEN: every key anybody adds later is unprotected until someone remembers
# to add it, so a re-run after an address typo would silently delete the
# measured site analysis AND the owner's hand-drawn areas, the only enforced
# spatial scoping there is. Nothing fails loudly when a key simply stops
# existing, so the loss would surface only when a design was scoped to an area
# that no longer existed.
#
# So the rule is inverted: a tool starts from the file ON DISK and may replace
# only the keys its own section declares; everything else — including keys this
# code has never heard of — is carried through untouched. merge_section()
# REJECTS a write outside the caller's half rather than reporting it, for the
# reason CLAUDE.md gives: a validator decision belongs in the validator.
SECTIONS = {
    "fetched": {
        "writer": "tools/geodata.py",
        # public data about an address. Cheap to lose: re-run this tool.
        "keys": ("version", "units", "crs", "address", "zip", "origin",
                 "usda_zone", "usda_temp_range_f", "footprint", "footprint_source",
                 "roof_segments", "imagery_quality", "existing_trees", "lot",
                 "fetched_at"),
    },
    "derived": {
        "writer": "tools/analyze_site.py",
        # measured off the scan mesh. Re-derivable, but only with the viewer
        # open and the right capture loaded — minutes, and a human in the loop.
        "keys": ("zones", "house_measured", "scan_coverage", "slope_survey",
                 # the property's own retaining walls, found by find_walls as
                 # near-vertical bands in the height field. DERIVED, so save-owner
                 # refuses them and a re-run replaces them.
                 "walls_detected", "walls_detected_note"),
    },
    "owner": {
        "writer": "the viewer (Places, Draw area, Set north)",
        # ground truth a human placed by hand. IRREPLACEABLE: no tool can
        # re-derive a landmark, and saved designs scope to areas BY NAME.
        "keys": ("landmarks", "landmarks_frame", "areas", "terrain",
                 "constraints", "registration", "frame",
                 # VIEWPOINTS the owner placed, such as the view from a kitchen
                 # window. Owner ground truth exactly like landmarks and areas —
                 # a camera nobody stood at is not a viewpoint, and nothing can
                 # re-derive which views the owner cares about. Stored in
                 # `look`'s own convention (x, y, height ABOVE GROUND) so a saved
                 # viewpoint IS a stored look() call and needs no second frame.
                 "viewpoints"),
    },
}

# Never carried forward, whatever the file says. `key` can hold a Google Maps
# API key, and carrying every other key through would otherwise carry a secret
# through every future re-run of a file that is committed to the repo.
SCRUBBED = ("key",)


class SiteUnreadable(RuntimeError):
    """site.json exists but will not parse.

    Both tools refuse to write in this case. A half-written file is still the
    only copy of the owner's landmarks and areas, and a tool that cannot read a
    file has no business replacing it — catching JSONDecodeError and writing a
    brand-new site.json would destroy them.
    """


def owner_of(key):
    """Which section owns `key`, or None for a key no tool has claimed."""
    for name, sec in SECTIONS.items():
        if key in sec["keys"]:
            return name
    return None


def load_site(path):
    """The site file as a dict; {} when there is no file yet.

    Raises SiteUnreadable rather than returning {} for a corrupt one, because
    the two mean opposite things: {} says "nothing to lose", and a parse error
    says "something to lose that I cannot see".
    """
    if not os.path.exists(path):
        return {}
    try:
        with open(path) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        raise SiteUnreadable(
            f"{path} exists but will not parse ({e}). Refusing to overwrite it — "
            f"it holds the only copy of the landmarks and areas. Fix or move the "
            f"file, then re-run.")


def merge_section(prev, section, values):
    """`prev` with the keys in `values` replaced. Pure; `prev` is not mutated.

    `values` may only carry keys that `section` owns. A key belonging to another
    section, or to no section at all, raises: writing outside your half is the
    defect this exists to make impossible, and passing it through silently would
    just be a fail-open list of survivors wearing a different name.
    """
    own = SECTIONS[section]["keys"]
    for k in values:
        if k not in own:
            held = owner_of(k)
            where = (f"{held!r} is written by {SECTIONS[held]['writer']}" if held
                     else f"{k!r} is not declared in geodata.SECTIONS")
            raise ValueError(
                f"{SECTIONS[section]['writer']} tried to write {k!r} into the "
                f"{section!r} half of site.json, but {where}.")
    out = {k: v for k, v in prev.items() if k not in SCRUBBED}
    out.update(values)
    return out


def save_site(site, path):
    """Write the whole site file, atomically.

    Atomically because load_site() refuses to overwrite a file it cannot
    parse: a crash halfway through a plain truncate-and-write would lock both
    tools out of the file they just half-destroyed.
    """
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".", suffix=".json")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(site, f, indent=2)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def rebase_to_origin(site, prev_origin, new_origin):
    """Shift owner-authored ENU coordinates when the origin moves. Returns the
    number of shapes moved.

    The one sanctioned write across the ownership boundary, and it is sanctioned
    because an ENU offset is meaningless without the origin it hangs off: the
    origin is fetched, the coordinates are the owner's, so only the fetcher can
    know they have to move. Areas move too — they are ENU polygons exactly like
    landmarks, and a re-based landmark sitting inside an un-re-based area is
    worse than neither moving, because the validator scopes designs to areas.
    """
    po = prev_origin or {}
    if po.get("lat") is None or po.get("lon") is None:
        return 0
    dx, dy = lonlat_to_enu(po["lon"], po["lat"], new_origin["lon"], new_origin["lat"])
    if abs(dx) <= 0.05 and abs(dy) <= 0.05:
        return 0
    moved = 0
    for lm in site.get("landmarks") or []:
        if "x" in lm and "y" in lm:
            lm["x"] = round(lm["x"] + dx, 2)
            lm["y"] = round(lm["y"] + dy, 2)
            moved += 1
    for ar in site.get("areas") or []:
        poly = ar.get("polygon")
        if poly:
            ar["polygon"] = [[round(x + dx, 2), round(y + dy, 2)] for x, y in poly]
            moved += 1
    if moved:
        print(f"[site] origin moved {dx:+.2f}, {dy:+.2f} m — re-based {moved} "
              f"owner-authored shape(s)")
    return moved


def geocode(address: str):
    import requests
    r = requests.get(
        "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress",
        params={"address": address, "benchmark": "Public_AR_Current", "format": "json"},
        timeout=30)
    r.raise_for_status()
    matches = r.json()["result"]["addressMatches"]
    if not matches:
        raise SystemExit(f"Census geocoder: no match for {address!r}")
    m = matches[0]
    lat, lon = m["coordinates"]["y"], m["coordinates"]["x"]  # y=lat, x=lon
    zip5 = m.get("addressComponents", {}).get("zip", "")
    print(f"[geocode] {m['matchedAddress']} -> {lat:.6f}, {lon:.6f} (zip {zip5})")
    return lat, lon, zip5


def building_insights(lat, lon, key, quality):
    import requests
    r = requests.get(f"{SOLAR}/buildingInsights:findClosest", params={
        "location.latitude": lat, "location.longitude": lon,
        "requiredQuality": quality, "key": key}, timeout=30)
    if r.status_code == 403:
        try:
            msg = r.json().get("error", {}).get("message", "403 Forbidden")
        except Exception:
            msg = "403 Forbidden"
        print(f"[solar] buildingInsights: {msg} — is the Solar API enabled for this key? Skipping.")
        return None
    if r.status_code == 404:
        print("[solar] buildingInsights: no coverage for this location (404)")
        return None
    r.raise_for_status()
    return r.json()


def data_layers(lat, lon, key, radius_m, quality, out_dir):
    import requests
    r = requests.get(f"{SOLAR}/dataLayers:get", params={
        "location.latitude": lat, "location.longitude": lon,
        "radiusMeters": radius_m, "view": "FULL_LAYERS",
        "requiredQuality": quality, "key": key}, timeout=60)
    if r.status_code == 403:
        try:
            msg = r.json().get("error", {}).get("message", "403 Forbidden")
        except Exception:
            msg = "403 Forbidden"
        print(f"[solar] dataLayers: {msg} — is the Solar API enabled for this key? Skipping.")
        return None
    if r.status_code == 404:
        print("[solar] dataLayers: no coverage (404) — skipping")
        return None
    r.raise_for_status()
    layers = r.json()
    os.makedirs(out_dir, exist_ok=True)
    for name in ("dsmUrl", "rgbUrl", "maskUrl"):
        url = layers.get(name)
        if not url:
            continue
        tif = requests.get(url, params={"key": key}, timeout=120)
        tif.raise_for_status()
        path = os.path.join(out_dir, name.replace("Url", "") + ".tif")
        with open(path, "wb") as f:
            f.write(tif.content)
        print(f"[solar] saved {path} ({len(tif.content)//1024} KB)")
    return layers


def overture_cli():
    """The `overturemaps` command, wherever requirements.txt put it. Not by bare name
    alone: the viewer runs the system python, so an address lookup from it cannot find a
    tool that lives in the checkout's .venv. PATH first, then the checkout's .venv, then
    this python's own module; else a sentence, never a traceback."""
    import importlib.util
    import shutil
    found = shutil.which("overturemaps")
    if found:
        return [found]
    venv = os.path.join(project.ROOT, ".venv", "bin", "overturemaps")
    if os.access(venv, os.X_OK):
        return [venv]
    if importlib.util.find_spec("overturemaps"):
        return [sys.executable, "-m", "overturemaps"]
    raise SystemExit("the building outline needs the `overturemaps` tool, which is not installed: "
                     "pip install -r requirements.txt (python 3.10 or newer)")


def overture_footprint(lat, lon, half_m=120.0):
    """Download building footprints around the point; return the polygon ring
    (list of [lon, lat]) containing the point, else the nearest by centroid."""
    dlat = half_m / 110_540.0
    import math
    dlon = half_m / (111_320.0 * math.cos(math.radians(lat)))
    bbox = f"{lon - dlon},{lat - dlat},{lon + dlon},{lat + dlat}"  # W,S,E,N
    with tempfile.NamedTemporaryFile(suffix=".geojson", delete=False) as tf:
        out = tf.name
    cmd = overture_cli() + ["download", f"--bbox={bbox}", "-f", "geojson",
                            "--type=building", "-o", out]
    print("[overture]", " ".join(cmd))
    try:
        subprocess.run(cmd, check=True)
        try:
            with open(out) as f:
                gj = json.load(f)
        except ValueError:
            gj = {}                 # an EMPTY answer: the release has nothing here
    finally:
        for path in (out, out + ".state"):
            if os.path.exists(path):
                os.unlink(path)
    feats = gj.get("features", [])
    print(f"[overture] {len(feats)} building footprints in bbox")
    if not feats:
        return None, None

    def rings(geom):
        if geom["type"] == "Polygon":
            yield geom["coordinates"][0]
        elif geom["type"] == "MultiPolygon":
            for poly in geom["coordinates"]:
                yield poly[0]

    # ray casting on a [[lon,lat],...] ring — the SAME test as everywhere else,
    # so it is imported rather than transcribed a fourth time
    def contains(ring, x, y):
        return point_in_polygon(x, y, ring)

    best, best_d = None, float("inf")
    for feat in feats:
        for ring in rings(feat["geometry"]):
            if contains(ring, lon, lat):
                return ring, feat.get("properties", {})
            cx = sum(p[0] for p in ring) / len(ring)
            cy = sum(p[1] for p in ring) / len(ring)
            d = (cx - lon) ** 2 + (cy - lat) ** 2
            if d < best_d:
                best, best_d = (ring, feat.get("properties", {})), d
    print("[overture] point not inside any footprint; using nearest centroid")
    return best if best else (None, None)


def hardiness(zip5: str):
    import requests
    if not zip5:
        return None
    r = requests.get(f"https://phzmapi.org/{zip5}.json", timeout=15)
    if r.status_code != 200:
        return None
    return r.json()


def render_siteplan(site, out_png):
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        print("[plan] Pillow not installed — skipping siteplan.png")
        return
    fp = site["footprint"]
    if len(fp) < 3:
        print("[plan] no building outline — skipping siteplan.png")
        return
    xs = [p[0] for p in fp]; ys = [p[1] for p in fp]
    pad = 8
    w = max(xs) - min(xs) + 2 * pad
    h = max(ys) - min(ys) + 2 * pad
    scale = 1024 / max(w, h)
    os.makedirs(os.path.dirname(out_png) or ".", exist_ok=True)
    img = Image.new("RGB", (int(w * scale), int(h * scale)), (245, 247, 242))
    d = ImageDraw.Draw(img)
    def to_px(x, y):  # ENU y=north -> image up
        return ((x - min(xs) + pad) * scale, img.height - (y - min(ys) + pad) * scale)
    d.polygon([to_px(x, y) for x, y in fp], outline=(160, 60, 50), width=3)
    # numbered corners — indices match the red posts in the viewer
    for i, (x, y) in enumerate(fp):
        px, py = to_px(x, y)
        r = 14
        d.ellipse([px - r, py - r, px + r, py + r], fill=(200, 65, 54))
        d.text((px, py), str(i), fill=(255, 255, 255), anchor="mm")
    # north arrow (ENU y = north = image up)
    ax, ay = img.width - 50, 70
    d.line([ax, ay, ax, ay - 40], fill=(30, 40, 34), width=4)
    d.polygon([(ax - 7, ay - 36), (ax + 7, ay - 36), (ax, ay - 52)], fill=(30, 40, 34))
    d.text((ax, ay + 12), "N", fill=(30, 40, 34), anchor="mm")
    d.line([to_px(min(xs), min(ys) - 4), to_px(min(xs) + 10, min(ys) - 4)], fill=(30, 40, 34), width=4)
    d.text(to_px(min(xs), min(ys) - 7), "10 m", fill=(30, 40, 34))
    img.save(out_png)
    print(f"[plan] saved {out_png}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--address", required=True)
    ap.add_argument("--zip", dest="zip5", default=None)
    ap.add_argument("--quality", default="BASE", choices=["HIGH", "MEDIUM", "BASE"],
                    help="requiredQuality floor; BASE accepts whatever exists")
    ap.add_argument("--radius", type=int, default=60)
    ap.add_argument("--no-datalayers", action="store_true")
    ap.add_argument("--out", default="data/site.json")
    args = ap.parse_args()
    # FIRST, before anything reads it: "data/site.json" is the ACTIVE site's. Resolved only
    # at the write, the read below would find no file, merge into nothing and write over
    # the survey's zones.
    args.out = project.resolve(args.out)

    key = os.environ.get("GOOGLE_MAPS_API_KEY", "")
    # Before a minute of network, and before touching a file at all: if the
    # existing site.json will not parse we are not going to write over it, so
    # say so now rather than after the fetch.
    try:
        load_site(args.out)
    except SiteUnreadable as e:
        raise SystemExit(str(e))
    lat, lon, zip5 = geocode(args.address)
    zip5 = args.zip5 or zip5

    bi = None
    if key:
        bi = building_insights(lat, lon, key, args.quality)
    else:
        print("[solar] GOOGLE_MAPS_API_KEY not set — skipping Solar API (footprint still works)")
    if bi:
        lat0 = bi["center"]["latitude"]; lon0 = bi["center"]["longitude"]
    else:
        lat0, lon0 = lat, lon

    ring, props = overture_footprint(lat0, lon0)
    if ring is None:
        # NOT a failure of the whole lookup: public records may have no outline here,
        # and the address, origin and climate zone are still worth keeping. The validator's
        # house rule falls back to the survey's measured house (agent.house_outline).
        print("[overture] no building outline here in the current release — keeping the address, "
              "origin and climate zone; the survey's measured house stands in for the outline")
        ring = [[lon0, lat0]]
    # Center the local frame on the chosen footprint so all site coords sit near 0
    # (the geocode point can be far from the matched building's centroid).
    cen_lon = sum(p[0] for p in ring) / len(ring)
    cen_lat = sum(p[1] for p in ring) / len(ring)
    off_x, off_y = lonlat_to_enu(cen_lon, cen_lat, lon0, lat0)
    if (off_x ** 2 + off_y ** 2) ** 0.5 > 10:
        print(f"[frame] footprint centroid is {(off_x**2+off_y**2)**0.5:.0f} m from the "
              f"geocode/solar point — re-centering origin on the footprint")
    lon0, lat0 = cen_lon, cen_lat
    footprint = [list(lonlat_to_enu(p[0], p[1], lon0, lat0)) for p in ring]
    footprint = [[round(x, 3), round(y, 3)] for x, y in footprint]
    if footprint[0] == footprint[-1]:
        footprint = footprint[:-1]
    if len(footprint) < 3:
        footprint = []              # a point is an origin, not an outline

    roof_segments = []
    if bi:
        for seg in bi.get("solarPotential", {}).get("roofSegmentStats", []):
            c = seg.get("center", {})
            ex, ey = lonlat_to_enu(c.get("longitude", lon0), c.get("latitude", lat0), lon0, lat0)
            roof_segments.append({
                "pitch_deg": seg.get("pitchDegrees"),
                "azimuth_deg": seg.get("azimuthDegrees"),
                "plane_height_asl_m": seg.get("planeHeightAtCenterMeters"),
                "area_m2": seg.get("stats", {}).get("areaMeters2"),
                "center_enu": [round(ex, 2), round(ey, 2)],
            })

    zone = hardiness(zip5)
    fetched = {
        "version": 1,
        "units": "meters",
        "crs": "local ENU, x=east y=north, origin at `origin`",
        "address": args.address,
        "zip": zip5,
        "origin": {"lat": lat0, "lon": lon0},
        "usda_zone": zone["zone"] if zone else None,
        "usda_temp_range_f": zone.get("temperature_range") if zone else None,
        "footprint": footprint,
        "footprint_source": f"Overture Maps ({(props or {}).get('sources', [{}])[0].get('dataset', 'unknown') if isinstance((props or {}).get('sources'), list) else 'overture'})",
        "roof_segments": roof_segments,
        "imagery_quality": bi.get("imageryQuality") if bi else None,
        "existing_trees": [],
        "lot": None,
        "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
    }

    # Rewrite ONLY the fetched half. Read again here rather than reusing the
    # check at the top of main(): the viewer has had the whole fetch — a minute
    # or more — to add a landmark, and writing back a stale snapshot is exactly
    # the mistake viewer/src/main.js updateSite() was written to avoid.
    try:
        prev = load_site(args.out)
    except SiteUnreadable as e:
        raise SystemExit(str(e))
    site = merge_section(prev, "fetched", fetched)
    rebase_to_origin(site, prev.get("origin"), fetched["origin"])

    save_site(site, args.out)
    print(f"[site] wrote {args.out}: {len(footprint)}-vertex footprint, "
          f"{len(roof_segments)} roof segments, zone {site['usda_zone']}, "
          f"imagery {site['imagery_quality']}")

    render_siteplan(site, project.data("geodata", "siteplan.png"))

    if key and bi and not args.no_datalayers:
        data_layers(lat0, lon0, key, args.radius, args.quality, project.data("geodata"))


if __name__ == "__main__":
    main()
