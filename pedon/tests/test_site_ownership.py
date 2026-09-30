"""site.json has three authors: tools that fetch, tools that derive, and the owner.

A tool that rebuilds site.json from scratch and copies back a hand-maintained
list of survivors is fail-OPEN: every key the list does not name — zones, areas,
house_measured, scan_coverage, slope_survey, landmarks_frame — is silently
deleted by a re-run after an address typo, including the measured site analysis
AND the owner's hand-drawn areas, which are the only enforced spatial scoping in
the system. Widening the list fixes one instance, never the class: the next key
anybody adds is unprotected until somebody remembers.

These tests hold the inverted rule instead — a tool starts from the file ON DISK
and may only replace the keys its own section declares. What it has never heard
of survives by default.

Nothing here touches the network or the viewer: geodata's four HTTP calls and
analyze_site's browser raycast are replaced, so the REAL main() of each tool runs
end to end against a temp file. That matters — data is lost in main()'s write
path, not in a helper, and a test that only exercised a helper would watch that
path from the wrong side of the room.
"""
import json
import os
import sys

import pytest

import analyze_site
import geodata


# ── a site.json as it exists in the wild ──────────────────────────────────
def _seed(path, **extra):
    """Fetched, derived and owner-authored facts in one flat file — the shape
    every committed site.json has."""
    site = {
        "version": 1,
        "units": "meters",
        "address": "the address that was there before",
        "origin": {"lat": 34.42, "lon": -119.70},
        "footprint": [[0, 0], [5, 0], [5, 5], [0, 5]],
        # owner: irreplaceable. Saved designs scope to areas BY NAME.
        "landmarks": [{"name": "gate", "x": 0.0, "y": 0.0},
                      {"name": "oak", "x": 12.0, "y": -3.0}],
        "landmarks_frame": "/data/captures/whatever.glb",
        "areas": [{"name": "retaining_wood",
                   "polygon": [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]]}],
        "terrain": {"slope_deg": 14.3},
        # derived: re-derivable, but only with the viewer open and a capture loaded
        "zones": [{"zone": "back_yard", "area_m2": 232.0,
                   "bounds_m": {"x": [10, 18], "y": [-16, 17]}}],
        "scan_coverage": {"scanned_ground_m2": 603},
    }
    site.update(extra)
    path.write_text(json.dumps(site, indent=2))
    return json.loads(json.dumps(site))          # a copy, so the test owns it


def _ring(lon0, lat0, half_deg=5e-5):
    """A tiny square building footprint, as Overture returns it: [lon, lat]."""
    return [[lon0 - half_deg, lat0 - half_deg], [lon0 + half_deg, lat0 - half_deg],
            [lon0 + half_deg, lat0 + half_deg], [lon0 - half_deg, lat0 + half_deg]]


def run_geodata(tmp_path, monkeypatch, *, address="1 Test St",
                lat=34.42, lon=-119.70, zip5="00000"):
    """geodata.main() with every network call replaced. The real write path."""
    out = tmp_path / "site.json"
    monkeypatch.setattr(geodata, "geocode", lambda a: (lat, lon, zip5))
    monkeypatch.setattr(geodata, "overture_footprint",
                        lambda la, lo, **k: (_ring(lo, la), {}))
    monkeypatch.setattr(geodata, "hardiness",
                        lambda z: {"zone": "10a", "temperature_range": "30 to 35"})
    monkeypatch.setattr(geodata, "render_siteplan", lambda site, png: None)
    monkeypatch.delenv("GOOGLE_MAPS_API_KEY", raising=False)
    monkeypatch.setenv("PEDON_PROJECT", str(tmp_path / "data"))    # data/ is the project's
    monkeypatch.setattr(sys, "argv",
                        ["geodata.py", "--address", address, "--out", str(out)])
    geodata.main()
    return json.loads(out.read_text())


def _grid(cell=1.0, half=12.0, hole=3.0):
    """A sloped field with an enclosed unscanned hole where the house stands —
    the shape find_building() looks for, at the size analyze_site accepts."""
    n = int(2 * half / cell) + 1
    rows = []
    for r in range(n):
        y = half - r * cell
        row = []
        for c in range(n):
            x = -half + c * cell
            row.append(None if abs(x) <= hole and abs(y) <= hole else round(-0.25 * x, 3))
        rows.append(row)
    scanned = sum(1 for row in rows for v in row if v is not None)
    return {"rows": rows, "cell_m": cell, "x0": -half, "y1": half,
            "scanned_cells": scanned, "total_cells": n * n}


def run_analyze_site(tmp_path, monkeypatch, *, grid=None, calls=None, during=None):
    """analyze_site.main() with the browser raycast replaced.

    `during` runs where the raycast runs — the minutes the owner spends looking
    at the viewer that is doing it, and can therefore spend drawing an area."""
    data = tmp_path / "data"
    data.mkdir(exist_ok=True)

    def fake_fetch(cell, extent):
        if calls is not None:
            calls.append((cell, extent))
        if during is not None:
            during()
        return grid if grid is not None else _grid()

    monkeypatch.setattr(analyze_site, "ROOT", str(tmp_path))
    monkeypatch.setenv("PEDON_PROJECT", str(tmp_path / "data"))    # data/ is the project's
    monkeypatch.setattr(analyze_site, "fetch_scan_grid", fake_fetch)
    monkeypatch.setattr(sys, "argv", ["analyze_site.py"])
    analyze_site.main()


# ── the ownership map itself ──────────────────────────────────────────────
def test_every_key_belongs_to_exactly_one_section():
    seen = {}
    for name, sec in geodata.SECTIONS.items():
        for k in sec["keys"]:
            assert k not in seen, f"{k!r} is claimed by both {seen[k]} and {name}"
            seen[k] = name
    assert len(seen) >= 20, "the map is too small to cover a real site.json"


def test_a_tool_cannot_write_a_key_another_section_owns():
    """The whole point. A preserve-list can only ask a tool nicely."""
    prev = {"areas": [{"name": "retaining_wood", "polygon": []}]}
    with pytest.raises(ValueError) as e:
        geodata.merge_section(prev, "fetched", {"address": "x", "areas": []})
    assert "areas" in str(e.value)
    assert prev["areas"][0]["name"] == "retaining_wood"      # untouched


def test_a_tool_cannot_invent_an_undeclared_key():
    """An undeclared key would join a section by accident and inherit its write
    rights. Declaring it is one line; discovering it deleted something is not."""
    with pytest.raises(ValueError) as e:
        geodata.merge_section({}, "derived", {"zones": [], "sun_hours": {}})
    assert "sun_hours" in str(e.value)


def test_merge_replaces_only_the_keys_handed_to_it():
    prev = {"address": "old", "zip": "00000", "areas": [1, 2, 3]}
    out = geodata.merge_section(prev, "fetched", {"address": "new"})
    assert out["address"] == "new"
    assert out["zip"] == "00000"          # its own section, but not offered: kept
    assert out["areas"] == [1, 2, 3]
    assert prev["address"] == "old"       # pure: the caller's dict is not mutated


# ── geodata's write path ──────────────────────────────────────────────────
def test_a_geodata_rerun_keeps_the_owner_half(tmp_path, monkeypatch):
    before = _seed(tmp_path / "site.json")
    after = run_geodata(tmp_path, monkeypatch, address="1 Test St")

    assert after["address"] == "1 Test St"            # it really did re-run
    assert after["address"] != before["address"]
    assert [a["name"] for a in after["areas"]] == ["retaining_wood"]
    assert after["areas"] == before["areas"]
    assert len(after["landmarks"]) == 2
    assert after["landmarks"] == before["landmarks"]
    assert after["landmarks_frame"] == before["landmarks_frame"]
    assert after["terrain"] == before["terrain"]


def test_a_geodata_rerun_keeps_the_derived_half(tmp_path, monkeypatch):
    before = _seed(tmp_path / "site.json")
    after = run_geodata(tmp_path, monkeypatch, address="1 Test St")

    assert after["address"] == "1 Test St"            # it really did re-run
    assert len(after["zones"]) == 1
    assert after["zones"] == before["zones"]
    assert after["scan_coverage"] == before["scan_coverage"]


def test_a_geodata_rerun_keeps_a_key_no_preserve_list_could_know_about(tmp_path, monkeypatch):
    """The class a preserve-list cannot cover: a list protects only the keys
    that existed the day it was written; this one is written by a tool nobody
    has built yet."""
    _seed(tmp_path / "site.json", sun_hours={"back_yard": 6.5})
    after = run_geodata(tmp_path, monkeypatch, address="1 Test St")

    assert after["address"] == "1 Test St"            # it really did re-run
    assert after["sun_hours"] == {"back_yard": 6.5}


def test_geodata_refuses_to_rewrite_a_site_json_it_cannot_parse(tmp_path, monkeypatch):
    """A half-written file is still the only copy of the owner's areas, so a
    JSONDecodeError stops the run instead of writing a brand-new file over it."""
    p = tmp_path / "site.json"
    corrupt = '{"areas": [{"name": "retaining_wood", "polygon": [[0,0],[1,'
    p.write_text(corrupt)
    with pytest.raises(SystemExit):
        run_geodata(tmp_path, monkeypatch)
    assert p.read_text() == corrupt


def test_moving_the_origin_rebases_areas_as_well_as_landmarks(tmp_path, monkeypatch):
    """Areas are ENU polygons hung off the origin exactly like landmarks, and a
    re-based landmark inside an un-re-based area is worse than neither moving:
    the validator scopes designs to areas."""
    before = _seed(tmp_path / "site.json")
    after = run_geodata(tmp_path, monkeypatch, lat=34.42005, lon=-119.70)

    lm0 = {l["name"]: l for l in before["landmarks"]}
    lm1 = {l["name"]: l for l in after["landmarks"]}
    assert set(lm1) == set(lm0)
    dx = lm1["gate"]["x"] - lm0["gate"]["x"]
    dy = lm1["gate"]["y"] - lm0["gate"]["y"]
    assert abs(dy) > 1.0, "the origin did not move, so this proves nothing"

    assert len(after["areas"]) == 1
    poly0 = before["areas"][0]["polygon"]
    poly1 = after["areas"][0]["polygon"]
    assert len(poly1) == len(poly0) == 4
    for (x0, y0), (x1, y1) in zip(poly0, poly1):
        assert x1 == pytest.approx(x0 + dx, abs=0.02)
        assert y1 == pytest.approx(y0 + dy, abs=0.02)


def test_a_leaked_api_key_is_not_carried_forward(tmp_path, monkeypatch):
    """site.json is committed data. Keeping unknown keys by default would carry
    a leaked `key` forward forever, so the scrub is explicit."""
    _seed(tmp_path / "site.json", key="AIzaSyNOTAREALKEY")
    after = run_geodata(tmp_path, monkeypatch)
    assert "key" not in after
    assert after["areas"]                              # nothing else was scrubbed


# ── analyze_site's write path ─────────────────────────────────────────────
def test_analyze_site_changes_only_the_derived_half(tmp_path, monkeypatch):
    before = _mkdata(tmp_path)
    run_analyze_site(tmp_path, monkeypatch)
    after = json.loads((tmp_path / "data" / "site.json").read_text())

    assert len(after["zones"]) == 4, "the run did not actually derive anything"
    changed = {k for k in set(before) | set(after) if before.get(k) != after.get(k)}
    assert changed, "nothing changed at all — this test would pass on a no-op"
    assert changed <= set(geodata.SECTIONS["derived"]["keys"]), \
        f"analyze_site wrote outside its section: {sorted(changed)}"
    assert after["areas"] == before["areas"]
    assert after["landmarks"] == before["landmarks"]
    assert after["address"] == before["address"]


def test_analyze_site_refuses_a_site_json_it_cannot_parse(tmp_path, monkeypatch):
    """And refuses BEFORE the raycast: a browser round trip costs minutes, and
    there is no point spending it on a file we have already decided not to
    write."""
    data = tmp_path / "data"
    data.mkdir()
    p = data / "site.json"
    corrupt = '{"areas": [{"name": "retaining_wood", "polygon": [[0,0],[1,'
    p.write_text(corrupt)
    calls = []
    with pytest.raises(SystemExit):
        run_analyze_site(tmp_path, monkeypatch, calls=calls)
    assert p.read_text() == corrupt
    assert calls == [], "it asked the viewer to raycast a scan it could not use"
    assert not (data / "terrain_scan.json").exists()


def test_analyze_site_keeps_a_zone_name_the_owner_gave(tmp_path, monkeypatch):
    """Guards the refactor: renaming an established zone breaks every saved
    design scoped to it."""
    _mkdata(tmp_path, zones=[{"zone": "back_yard", "area_m2": 200.0,
                              "bounds_m": {"x": [4, 12], "y": [-12, 12]}}])
    run_analyze_site(tmp_path, monkeypatch)
    after = json.loads((tmp_path / "data" / "site.json").read_text())
    names = [z["zone"] for z in after["zones"]]
    assert len(names) == 4
    assert "back_yard" in names
    assert "east_yard" not in names


def test_analyze_site_does_not_write_back_a_snapshot_taken_before_the_raycast(
        tmp_path, monkeypatch):
    """The raycast is a browser round trip that takes minutes, and the owner is
    looking at that browser. viewer/src/main.js updateSite() re-reads
    immediately before saving for this exact reason; so must this."""
    _mkdata(tmp_path)
    site_path = tmp_path / "data" / "site.json"

    def owner_draws_an_area():
        s = json.loads(site_path.read_text())
        s["areas"].append({"name": "new_bed", "polygon": [[1.0, 1.0], [2.0, 1.0], [2.0, 2.0]]})
        site_path.write_text(json.dumps(s, indent=2))

    run_analyze_site(tmp_path, monkeypatch, during=owner_draws_an_area)
    after = json.loads(site_path.read_text())
    assert len(after["zones"]) == 4, "the run did not actually derive anything"
    assert [a["name"] for a in after["areas"]] == ["retaining_wood", "new_bed"]


def _mkdata(tmp_path, **extra):
    """_seed into tmp/data/site.json, which is where analyze_site looks."""
    data = tmp_path / "data"
    data.mkdir(exist_ok=True)
    return _seed(data / "site.json", **extra)


def test_an_address_lookup_after_the_survey_keeps_the_survey(tmp_path, monkeypatch):
    """The viewer runs Survey and Look up in either order, so geodata resolves "data/site.json"
    to the ACTIVE site before reading it; reading the literal path finds nothing, merges into
    nothing, and writes over the survey's zones. Run the way the viewer runs it: default --out."""
    site = tmp_path / "proj"
    site.mkdir()
    (site / "site.json").write_text(json.dumps({"zones": [{"zone": "z1"}], "scan_coverage": {"scanned_ground_m2": 9},
                                                "house_measured": {"bounds_m": {"x": [0, 1], "y": [0, 1]}}}))
    monkeypatch.setenv("PEDON_PROJECT", str(site))
    monkeypatch.setattr(geodata, "geocode", lambda a: (34.42, -119.70, "00000"))
    monkeypatch.setattr(geodata, "overture_footprint", lambda la, lo, **k: (_ring(lo, la), {}))
    monkeypatch.setattr(geodata, "hardiness", lambda z: {"zone": "10a", "temperature_range": "30 to 35"})
    monkeypatch.setattr(geodata, "render_siteplan", lambda site, png: None)
    monkeypatch.delenv("GOOGLE_MAPS_API_KEY", raising=False)
    monkeypatch.setattr(sys, "argv", ["geodata.py", "--address", "1 Test St"])
    geodata.main()
    out = json.loads((site / "site.json").read_text())
    assert out["zones"] == [{"zone": "z1"}], "the address lookup wiped the survey"
    assert out["usda_zone"] == "10a"


class _Grid:
    def __init__(self, cells):
        self._c = cells

    def cells(self):
        return iter(self._c)


def test_zones_are_not_named_by_a_compass_that_is_not_set():
    """Before north is set, a compass name like "east_yard" would pass the scanner's own
    heading off as a bearing, so until north is set the scan's axes name the zones."""
    import analyze_site
    grid = _Grid([(10, 0, 0), (-10, 0, 0), (0, 10, 0), (0, -10, 0)])
    house = {"bounds_m": {"x": [-5, 5], "y": [-5, 5]}}
    assert set(analyze_site.carve_zones(grid, house, oriented=False)) == set(analyze_site.UNORIENTED)
    assert set(analyze_site.carve_zones(grid, house, oriented=True)) == set(analyze_site.COMPASS)


def test_north_is_read_from_the_calibration_or_the_site(tmp_path, monkeypatch):
    import analyze_site
    monkeypatch.setenv("PEDON_PROJECT", str(tmp_path))
    assert analyze_site.north_is_set({}) is False
    assert analyze_site.north_is_set({"frame": {"north_set": True}}) is True
    (tmp_path / "calibration.json").write_text('{"northSet": true}')
    assert analyze_site.north_is_set({}) is True
