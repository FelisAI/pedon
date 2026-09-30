"""Solar geometry, and the gate that stops it lying about which way a slope faces.

Why this exists
---------------
Two halves, and they fail for opposite reasons.

The astronomy half is pure arithmetic on a latitude, so it is exactly what a unit
test is for: solar-noon altitude at this site's latitude is 90 - |lat - decl| by
construction, and sun.py must reproduce that from a completely different route
(the NOAA series) or it is wrong. Day lengths are checked against published
sunrise/sunset for San Francisco, close enough to the reference site for the
published figures to apply.

The gate half matters because, without north set on the GLB, every stored
bearing is relative to the scan's arbitrary heading and can be out by ~23 deg.
Validators must fail closed: skipping unknown ground can approve a 49 m2 patio
78 m off-scan with 0 errors. Aspect and shade have the same requirement: an
aspect computed on an unverified heading can be confidently wrong. Every
bearing-dependent quantity must REFUSE while north is unset, and the refusal
must contain no number a caller could mistake for an answer.

A gate that always refuses would pass those tests and be useless, so the fail-
closed tests come in pairs: the same query against a temp data dir where north
IS set must return numbers. Both branches are exercised on disk, through the
real loaders — there is no injection hook to bypass them.
"""
from __future__ import annotations
import datetime as dt
import json
import math
import os
import subprocess
import sys

import pytest

# conftest.py does this too. Repeat the setup so this file can run independently
# of conftest.py.
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import project  # noqa: E402  where the active site's files are
sys.path.insert(0, os.path.join(ROOT, "tools"))
import sun                                                      # noqa: E402


UTC = dt.timezone.utc

# Dates, not instants. The solstice/equinox instants drift a few hours year to
# year; solar-noon altitude moves under 0.02 deg over that, well inside 0.5.
JUNE = dt.date(2026, 6, 21)
MARCH = dt.date(2026, 3, 20)
DEC = dt.date(2026, 12, 21)

OBLIQUITY = 23.44        # Earth's axial tilt; declination at the solstices
DECL = {JUNE: OBLIQUITY, MARCH: 0.0, DEC: -OBLIQUITY}


@pytest.fixture(scope="module")
def site():
    with open(project.data("site.json")) as f:
        return json.load(f)


@pytest.fixture(scope="module")
def latlon(site):
    o = site["origin"]
    return o["lat"], o["lon"]


# ── the astronomy: bearing-independent, so it must work with north unset ──

@pytest.mark.needs_site
def test_solar_noon_altitude_matches_textbook_declination(latlon):
    """90 - |lat - decl|, reached by a different route than sun.py takes.

    sun.py runs the NOAA series; this identity is plane trigonometry. Agreement
    to 0.5 deg means the series, the Julian day and the hour angle are all right.
    """
    lat, lon = latlon
    for d, decl in DECL.items():
        expect = 90.0 - abs(lat - decl)
        got = sun.solar_noon(lat, lon, d)["altitude_deg"]
        assert abs(got - expect) < 0.5, f"{d}: noon altitude {got}, expected ~{expect:.2f}"


@pytest.mark.needs_site
def test_solar_noon_altitude_pinned_for_this_site(latlon):
    """The actual numbers for the reference site, so a reader sees real values."""
    lat, lon = latlon
    assert abs(sun.solar_noon(lat, lon, JUNE)["altitude_deg"] - 75.9) < 0.5
    assert abs(sun.solar_noon(lat, lon, MARCH)["altitude_deg"] - 52.5) < 0.5
    assert abs(sun.solar_noon(lat, lon, DEC)["altitude_deg"] - 29.0) < 0.5


@pytest.mark.needs_site
def test_noon_azimuth_is_due_south(latlon):
    """The site is well north of the tropics, so the sun crosses due south.

    This pins the azimuth convention to the one the rest of the project uses for
    bearings: 0 = north, 90 = east, clockwise.
    """
    lat, lon = latlon
    for d in DECL:
        az = sun.solar_noon(lat, lon, d)["azimuth_deg"]
        assert abs(az - 180.0) < 0.5, f"{d}: noon azimuth {az}, expected due south"


def test_day_length_matches_published_sunrise_sunset():
    """Against the almanac for San Francisco (37.77 N, 122.42 W): 14h48m at the June
    solstice, 12h08m at the March equinox, 9h33m in December. Three minutes covers the
    almanac's rounding and refraction; a dropped refraction term is five."""
    lat, lon = 37.77, -122.42
    assert abs(sun.day_arc(lat, lon, JUNE)["day_length_h"] - (14 + 48 / 60)) < 0.05
    assert abs(sun.day_arc(lat, lon, MARCH)["day_length_h"] - (12 + 8 / 60)) < 0.05
    assert abs(sun.day_arc(lat, lon, DEC)["day_length_h"] - (9 + 33 / 60)) < 0.05


@pytest.mark.needs_site
def test_sunrise_sunset_bracket_noon_and_span_the_day_length(latlon):
    lat, lon = latlon
    a = sun.day_arc(lat, lon, JUNE)
    rise = dt.datetime.fromisoformat(a["sunrise_utc"])
    set_ = dt.datetime.fromisoformat(a["sunset_utc"])
    noon = dt.datetime.fromisoformat(a["solar_noon_utc"])
    assert rise < noon < set_
    assert abs((set_ - rise).total_seconds() / 3600 - a["day_length_h"]) < 0.02


@pytest.mark.needs_site
def test_altitude_peaks_at_solar_noon(latlon):
    """The tracked maximum must land on the computed noon, not near it.

    A wrong longitude sign or a dropped equation of time moves noon by up to
    half an hour while leaving every altitude plausible.
    """
    lat, lon = latlon
    a = sun.day_arc(lat, lon, JUNE, step_min=1)
    peak = max(a["track"], key=lambda p: p["altitude_deg"])
    noon = dt.datetime.fromisoformat(a["solar_noon_utc"])
    assert abs((dt.datetime.fromisoformat(peak["utc"]) - noon).total_seconds()) <= 90


@pytest.mark.needs_site
def test_seasonal_range_is_twice_the_obliquity(latlon):
    lat, lon = latlon
    s = sun.season_range(lat, lon, 2026)
    spread = (s["june_solstice"]["noon_altitude_deg"]
              - s["december_solstice"]["noon_altitude_deg"])
    assert abs(spread - 2 * OBLIQUITY) < 0.2


@pytest.mark.needs_site
def test_naive_datetime_is_rejected(latlon):
    """A datetime with no timezone is ambiguous by 8 hours here. Refuse it."""
    lat, lon = latlon
    with pytest.raises(ValueError):
        sun.solar_position(lat, lon, dt.datetime(2026, 6, 21, 12, 0))


# ── the irradiance model: pure, the caller supplies the aspect ──

@pytest.mark.needs_site
def test_flat_ground_receives_exactly_the_horizontal_total(latlon):
    lat, lon = latlon
    r = sun.slope_irradiance(lat, lon, JUNE, slope_deg=0.0, aspect_deg=180.0)
    assert abs(r["slope_kwh_m2"] - r["horizontal_kwh_m2"]) < 1e-6
    assert abs(r["slope_over_horizontal"] - 1.0) < 1e-6


@pytest.mark.needs_site
def test_south_slope_beats_north_slope_in_winter(latlon):
    """The whole reason aspect matters. Winter sun is low, so a north-facing
    slope at this latitude loses most of the beam and a south-facing one gains.
    A sign error in the cosine-of-incidence term inverts this."""
    lat, lon = latlon
    south = sun.slope_irradiance(lat, lon, DEC, 20.0, 180.0)
    north = sun.slope_irradiance(lat, lon, DEC, 20.0, 0.0)
    flat = sun.slope_irradiance(lat, lon, DEC, 0.0, 0.0)
    assert south["slope_kwh_m2"] > flat["slope_kwh_m2"] > north["slope_kwh_m2"]
    assert south["direct_sun_h"] > north["direct_sun_h"]


@pytest.mark.needs_site
def test_east_and_west_slopes_are_near_symmetric_at_the_equinox(latlon):
    """Not exactly equal — the declination drifts through the day — but a
    swapped sin/cos in the azimuth would break this badly."""
    lat, lon = latlon
    e = sun.slope_irradiance(lat, lon, MARCH, 20.0, 90.0)["slope_kwh_m2"]
    w = sun.slope_irradiance(lat, lon, MARCH, 20.0, 270.0)["slope_kwh_m2"]
    assert abs(e - w) / max(e, w) < 0.03


@pytest.mark.needs_site
def test_caller_supplied_aspect_is_labelled_as_such(latlon):
    """It must be impossible to read a hand-typed aspect back as a measurement."""
    lat, lon = latlon
    r = sun.slope_irradiance(lat, lon, JUNE, 14.3, 70.0)
    assert "caller" in r["aspect_source"].lower()
    assert "not" in r["aspect_source"].lower()


# ── the north gate ──

def _write_data(tmp_path, north_set, yaw_rad=0.0, capture="/data/captures/x.glb",
                site_capture=None, with_calib=True, bearings_unverified=False):
    """A minimal data dir: only what sun.py reads."""
    if with_calib:
        (tmp_path / "calibration.json").write_text(json.dumps({
            "capture": capture, "captureUrl": capture,
            "yaw": yaw_rad, "northSet": north_set,
            "captures": {capture: {"yaw": yaw_rad, "northSet": north_set}},
        }))
    zone = {"zone": "back_yard", "area_m2": 232, "slope_deg": 14.3,
            "downhill_bearing_deg": 70, "contour_bearing_deg": 160}
    if bearings_unverified:
        zone["bearings_unverified"] = True
    (tmp_path / "site.json").write_text(json.dumps({
        "origin": {"lat": 34.42, "lon": -119.70},
        "zones": [zone],
        "frame": {"capture": site_capture or capture, "north_set": north_set},
    }))
    return str(tmp_path)


def _numeric_leaves(o, path=""):
    """Every number in a nested structure, with the key that holds it."""
    out = []
    if isinstance(o, dict):
        for k, v in o.items():
            out += _numeric_leaves(v, f"{path}.{k}")
    elif isinstance(o, list):
        for i, v in enumerate(o):
            out += _numeric_leaves(v, f"{path}[{i}]")
    elif isinstance(o, (int, float)) and not isinstance(o, bool):
        out.append((path, o))
    return out


def test_zone_sun_refuses_when_north_is_not_set(monkeypatch, tmp_path):
    monkeypatch.setattr(sun, "DATA_DIR", _write_data(tmp_path, north_set=False))
    r = sun.zone_sun("back_yard", JUNE)
    assert r["refused"] is True
    for k in ("aspect_deg", "true_bearing_deg", "slope_kwh_m2",
              "slope_over_horizontal", "direct_sun_h"):
        assert k not in r, f"refusal leaked {k}"


def test_refusal_contains_no_number_that_reads_as_an_answer(monkeypatch, tmp_path):
    """A refusal must not print an irradiance that callers can read as an answer."""
    monkeypatch.setattr(sun, "DATA_DIR", _write_data(tmp_path, north_set=False))
    r = sun.zone_sun("back_yard", JUNE)
    banned = ("aspect", "bearing", "azimuth", "kwh", "irradian", "sun_h", "hours")
    for path, val in _numeric_leaves(r):
        assert not any(b in path.lower() for b in banned), \
            f"refusal carries a bearing-dependent number at {path} = {val}"


def test_refusal_names_the_two_click_fix(monkeypatch, tmp_path):
    monkeypatch.setattr(sun, "DATA_DIR", _write_data(tmp_path, north_set=False))
    fix = " ".join(sun.zone_sun("back_yard", JUNE)["fix"]).lower()
    assert "set north" in fix
    assert "analyze_site" in fix


def test_refusal_still_offers_what_latitude_alone_can_answer(monkeypatch, tmp_path):
    monkeypatch.setattr(sun, "DATA_DIR", _write_data(tmp_path, north_set=False))
    r = sun.zone_sun("back_yard", JUNE)
    assert any("day" in s or "season" in s for s in r["available_without_north"])


def test_the_gate_opens_when_north_is_set(monkeypatch, tmp_path):
    """The anti-vacuity twin: a gate that can never open is not a gate."""
    monkeypatch.setattr(sun, "DATA_DIR",
                        _write_data(tmp_path, north_set=True, yaw_rad=0.4068501929340919))
    r = sun.zone_sun("back_yard", JUNE)
    assert not r.get("refused"), r
    assert isinstance(r["aspect_deg"], (int, float))
    assert isinstance(r["slope_kwh_m2"], (int, float))
    assert r["slope_kwh_m2"] > 0


def test_missing_calibration_refuses_rather_than_assuming_yaw_zero(monkeypatch, tmp_path):
    """No calibration on disk is exactly the state where yaw 0 looks harmless
    and is wrong by whatever the scan's heading happens to be."""
    monkeypatch.setattr(sun, "DATA_DIR",
                        _write_data(tmp_path, north_set=True, with_calib=False))
    assert sun.zone_sun("back_yard", JUNE)["refused"] is True


def test_analysis_from_a_different_capture_refuses(monkeypatch, tmp_path):
    """Each capture keeps its own calibration, and north set on the PLY says
    nothing about the GLB. Bearings measured in one capture's frame
    must not be yaw-corrected with another capture's yaw."""
    monkeypatch.setattr(sun, "DATA_DIR", _write_data(
        tmp_path, north_set=True, yaw_rad=0.4,
        capture="/data/captures/a.glb", site_capture="/data/captures/b.ply"))
    r = sun.zone_sun("back_yard", JUNE)
    assert r["refused"] is True
    assert "capture" in r["reason"].lower()


def test_unknown_zone_refuses(monkeypatch, tmp_path):
    monkeypatch.setattr(sun, "DATA_DIR", _write_data(tmp_path, north_set=True, yaw_rad=0.4))
    assert sun.zone_sun("no_such_yard", JUNE)["refused"] is True


def test_stale_site_flags_are_reported_when_calibration_disagrees(monkeypatch, tmp_path):
    """Nothing clears `bearings_unverified`, so refusing on it would jam
    the gate shut forever after the two clicks. It is a loud warning instead —
    and it must actually be loud."""
    monkeypatch.setattr(sun, "DATA_DIR", _write_data(
        tmp_path, north_set=True, yaw_rad=0.4, bearings_unverified=True))
    r = sun.zone_sun("back_yard", JUNE)
    assert not r.get("refused")
    assert r["stale_site_analysis"] is True
    assert "analyze_site" in " ".join(r["warnings"])


def test_true_bearing_applies_the_yaw_in_the_viewer_s_direction():
    """true = stored - yaw. Two derivations agree: geoGroup rotates stored ENU by +yaw
    about +Y, which maps azimuth az -> az - yaw; and Set north itself computes
    g = atan2(dx, -dz) for the clicked direction and ADDS g to the yaw so that
    direction lands on -z. Wrong sign here is a 2 x 23 deg error, which is the
    difference between a south-facing and a south-east-facing slope.
    """
    assert sun.true_bearing(70.0, 0.0) == pytest.approx(70.0)
    assert sun.true_bearing(70.0, math.radians(23.3)) == pytest.approx(46.7, abs=1e-6)
    assert sun.true_bearing(10.0, math.radians(23.3)) == pytest.approx(346.7, abs=1e-6)


# ── the live site, as it stands on disk ──

@pytest.mark.needs_site
def test_live_site_refuses_because_north_is_unset(latlon):
    """The active capture must refuse bearing-dependent queries when north is
    unset. Skip this check when the owner has set north."""
    if sun.north_status()["north_set"]:
        pytest.skip("north is set on the active capture — the gate's "
                    "closed branch is still covered by the temp-dir tests")
    r = sun.zone_sun("back_yard", JUNE)
    assert r["refused"] is True
    assert "north" in r["reason"].lower()


@pytest.mark.needs_site
def test_live_site_still_answers_the_latitude_only_questions(latlon):
    """Bearing-independent results must NOT be caught by the gate, or the
    refusal is just a broken tool."""
    lat, lon = latlon
    a = sun.day_arc(lat, lon, JUNE)
    assert a["day_length_h"] > 14
    assert "refused" not in a


# ── the CLI, since that is how a session reaches this ──

def _cli(*args):
    p = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "sun.py"), *args],
                       capture_output=True, text=True)
    return p.returncode, json.loads(p.stdout)


def test_cli_zone_exits_nonzero_on_a_refusal():
    """A refusal that exits 0 is indistinguishable from an answer in a pipeline.

    The skip is keyed on north_status(), NOT on whether the output happens to be
    a refusal. Skipping based on the output would let a broken-open gate skip
    the test precisely when it must fail.
    """
    if sun.north_status()["north_set"]:
        pytest.skip("north is set on the active capture")
    code, out = _cli("zone", "back_yard", "--date", "2026-06-21")
    assert out.get("refused") is True, out
    assert code == 2


@pytest.mark.needs_site
def test_cli_day_works_with_north_unset():
    code, out = _cli("day", "--date", "2026-06-21")
    assert code == 0
    assert out["day_length_h"] > 14


@pytest.mark.needs_site
def test_cli_slope_requires_an_explicit_aspect_and_labels_it():
    code, out = _cli("slope", "--slope", "14.3", "--aspect", "70", "--date", "2026-06-21")
    assert code == 0
    assert "caller" in out["aspect_source"].lower()


@pytest.mark.needs_site
def test_track_covers_one_continuous_daylight_span(latlon):
    """The UTC calendar day at longitude -122 splices the previous local evening
    onto this local morning: a track can jump from 39 deg to 5 deg, then back up
    to 23 deg. The site's daylight track must run continuously from sunrise to
    sunset so readings describe one local day."""
    lat, lon = latlon
    a = sun.day_arc(lat, lon, JUNE, step_min=30)
    rise = dt.datetime.fromisoformat(a["sunrise_utc"])
    set_ = dt.datetime.fromisoformat(a["sunset_utc"])
    times = [dt.datetime.fromisoformat(p["utc"]) for p in a["track"]]
    assert times == sorted(times)
    assert rise <= times[0] and times[-1] <= set_
    assert (times[0] - rise).total_seconds() <= 1800
    assert (set_ - times[-1]).total_seconds() <= 1800
    # rises to the peak, then falls — one arc, not two
    alts = [p["altitude_deg"] for p in a["track"]]
    peak = alts.index(max(alts))
    assert alts[:peak + 1] == sorted(alts[:peak + 1])
    assert alts[peak:] == sorted(alts[peak:], reverse=True)


@pytest.mark.needs_site
def test_sunrise_and_sunset_land_at_the_published_clock_times(latlon):
    """An absolute anchor, not a self-consistent one.

    Day length only pins sunset MINUS sunrise, and "noon is due south" is true by
    construction whatever longitude you feed in — flip the sign of the longitude
    and both still pass while every time of day is 16 hours out. Published SF
    times for the June solstice are 05:47 and 20:35 PDT, i.e. 12:47 and 03:35
    UTC; the reference site's offset from the city centre is worth well under a
    minute, far inside the tolerance.
    """
    lat, lon = latlon
    a = sun.day_arc(lat, lon, JUNE)
    rise = dt.datetime.fromisoformat(a["sunrise_utc"])
    set_ = dt.datetime.fromisoformat(a["sunset_utc"])
    assert abs((rise - dt.datetime(2026, 6, 21, 12, 47, tzinfo=UTC)).total_seconds()) < 300
    assert abs((set_ - dt.datetime(2026, 6, 22, 3, 35, tzinfo=UTC)).total_seconds()) < 300


@pytest.mark.needs_site
def test_exposure_band_carries_the_open_sky_caveat(latlon):
    """"full sun" is a horticultural verdict, and this model cannot see the
    house, the fence or the neighbours' trees. A December north-east slope
    scores 7.8 direct hours here purely because nothing shades it in the model.
    The band string has to say so where it is read, not only in `excludes`."""
    lat, lon = latlon
    band = sun.slope_irradiance(lat, lon, DEC, 14.3, 46.7)["exposure"]
    assert "full sun" in band
    assert "open sky" in band and "shadow" in band
