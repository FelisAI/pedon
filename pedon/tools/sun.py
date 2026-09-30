#!/usr/bin/env python3
"""Where the sun is, and — only if north has been set — what any slope receives.

    python3 tools/sun.py day --date 2026-06-21        # sunrise, sunset, altitude track
    python3 tools/sun.py season                       # solstice/equinox noon altitudes
    python3 tools/sun.py north                        # is the scan tied to true north yet?
    python3 tools/sun.py zone back_yard               # REFUSES until north is set
    python3 tools/sun.py slope --slope 14.3 --aspect 200   # aspect YOU supply, labelled

Two halves, and they fail for opposite reasons.

Sun position needs a latitude and a clock, nothing else. That half always works,
and nothing in this file may gate it: refusing to say how long the day is because
the scan's heading is unknown would be a broken tool, not a careful one.

Everything about the GROUND's orientation — aspect, incident irradiance, hours of
direct sun on a slope — needs the active capture's heading tied to true north.
Calibration belongs to each capture: a GLB with `northSet: false, yaw 0` cannot
use a PLY's `northSet: true, yaw 0.4069` (23.3 deg). Every stored bearing in
site.json is relative to its scan's arbitrary heading; a ~23 deg error can turn
a south-facing slope into a south-east one.

So this file FAILS CLOSED. Skipping unknown ground in validation can approve a
49 m2 patio 78 m off the scan with 0 errors. Defaulting an unknown yaw to 0 would
likewise treat missing evidence as a valid answer. Every bearing-dependent query
returns {"refused": true, ...} carrying no number a
caller could mistake for an answer, plus the reason and the two-click fix.

The bearing conversion, once north is set
------------------------------------------------------
analyze_site.py measures `downhill_bearing_deg` on the ENU grid with atan2(east,
north) in the SCAN's frame. North is a pure viewing transform:
geoGroup carries the yaw, enuGroup hangs under it, and no stored coordinate ever
migrates. So a stored bearing becomes a true bearing only after applying the yaw:

    true = stored - degrees(yaw)

Two independent derivations agree. (1) three.js rotates a stored vector by
R_y(+yaw); writing a = x, b = -z (east, north) maps (a,b) -> (a cos y - b sin y,
a sin y + b cos y), i.e. azimuth -> azimuth - yaw. (2) Set north itself computes
g = atan2(dx, -dz) for the clicked direction and ADDS g to calib.yaw so that
direction lands on -z; that only works if the map is az -> az - yaw.

`test_true_bearing_applies_the_yaw_in_the_viewer_s_direction` locks the convention
but cannot prove agreement with the viewer. That requires checking real data in
the viewer at a non-zero yaw, with north set on the active capture.

The irradiance model is clear-sky and open-sky: no clouds, and NO shadow from the
house, the fences, the neighbours' trees or the hill itself. It answers "what does
this aspect do to the sun a slope gets", which is the question aspect is for. Real
shade needs the mesh, and the mesh only exists in the browser.

No dependencies and no keys — latitude, longitude and a heading are all on disk.
"""
from __future__ import annotations
import argparse
import datetime as dt
import json
import math
import os
import project  # the active project's files — the ONE owner
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = None      # None: the ACTIVE project (project.data); module-level so tests can point it elsewhere

UTC = dt.timezone.utc

# Sunrise/sunset are conventionally the moment the sun's UPPER LIMB touches a sea
# horizon: 0.833 deg below geometric, being 0.267 deg of semidiameter plus 0.566
# deg of mean refraction. Checked against published SF times, this lands within a
# minute; the geometric horizon would be ~5 minutes out at each end.
SUNRISE_ZENITH = 90.833

SOLAR_CONSTANT = 1361.0     # W/m2 at mean Earth-Sun distance
TURBIDITY_BASE = 0.7        # clear-sky beam transmittance at air mass 1 (Meinel)
DIFFUSE_FRACTION = 0.10     # diffuse ~ 10% of beam horizontal under a clear sky
DEFAULT_ALBEDO = 0.2        # dry grass / soil ground reflectance


# ── files ─────────────────────────────────────────────────────────────────
# Read through DATA_DIR every time rather than caching: the tests swap the
# directory to exercise both sides of the gate, and a cache would make the
# second call answer from the first directory.
#
# Not site_api._site(): importing site_api exec's agent.py, which parses argv and
# loads the terrain grids at import time, and nothing here needs a height. The
# shared-lookup rule applies to height-field INDEXING, where duplicate
# implementations can disagree. This file does not index anything: it reads
# two JSON files, including the viewer's calibration.json, and does trigonometry.

def _load(name):
    p = os.path.join(DATA_DIR, name) if DATA_DIR else project.data(name)
    if not os.path.exists(p):
        return None
    try:
        with open(p) as f:
            return json.load(f)
    except (ValueError, OSError):
        return None


def site():
    return _load("site.json") or {}


def calibration():
    return _load("calibration.json")


# ── astronomy: latitude and a clock, nothing else ─────────────────────────
# NOAA's solar position algorithm (the one behind their spreadsheet), good to a
# hundredth of a degree over centuries — three orders of magnitude better than
# anything a garden needs, and it costs nothing.

def _julian_day(when):
    """Julian day from an aware UTC datetime."""
    u = when.astimezone(UTC)
    y, m = u.year, u.month
    d = u.day + (u.hour + u.minute / 60 + (u.second + u.microsecond / 1e6) / 3600) / 24
    if m <= 2:
        y, m = y - 1, m + 12
    a = y // 100
    b = 2 - a + a // 4
    return int(365.25 * (y + 4716)) + int(30.6001 * (m + 1)) + d + b - 1524.5


def _sun_terms(jd):
    """Declination (deg) and the equation of time (minutes) for a Julian day."""
    t = (jd - 2451545.0) / 36525.0
    l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360.0
    m = 357.52911 + t * (35999.05029 - 0.0001537 * t)
    e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t)
    mr = math.radians(m)
    c = (math.sin(mr) * (1.914602 - t * (0.004817 + 0.000014 * t))
         + math.sin(2 * mr) * (0.019993 - 0.000101 * t)
         + math.sin(3 * mr) * 0.000289)
    true_long = l0 + c
    omega = 125.04 - 1934.136 * t
    app_long = true_long - 0.00569 - 0.00478 * math.sin(math.radians(omega))
    mean_obliq = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60
    obliq = mean_obliq + 0.00256 * math.cos(math.radians(omega))
    decl = math.degrees(math.asin(math.sin(math.radians(obliq))
                                  * math.sin(math.radians(app_long))))
    vy = math.tan(math.radians(obliq / 2)) ** 2
    l0r = math.radians(l0)
    eot = 4 * math.degrees(
        vy * math.sin(2 * l0r) - 2 * e * math.sin(mr)
        + 4 * e * vy * math.sin(mr) * math.cos(2 * l0r)
        - 0.5 * vy * vy * math.sin(4 * l0r)
        - 1.25 * e * e * math.sin(2 * mr))
    return decl, eot


def _refraction(alt_deg):
    """Atmospheric refraction, deg. Zero at the zenith, ~0.57 at the horizon."""
    if alt_deg > 85:
        return 0.0
    a = math.radians(alt_deg)
    if alt_deg > 5:
        r = 58.1 / math.tan(a) - 0.07 / math.tan(a) ** 3 + 0.000086 / math.tan(a) ** 5
    elif alt_deg > -0.575:
        r = 1735 + alt_deg * (-518.2 + alt_deg * (103.4 + alt_deg * (-12.79 + alt_deg * 0.711)))
    else:
        r = -20.772 / math.tan(a)
    return r / 3600.0


def solar_position(lat, lon, when):
    """Altitude and azimuth of the sun. `when` must be timezone-aware.

    A naive datetime is 8 hours ambiguous on the US west coast — enough to move the
    sun from morning to afternoon — so it is refused rather than assumed.
    Azimuth is a compass bearing of the SKY (0 = north, 90 = east, clockwise),
    which needs only latitude and longitude. It is NOT gated on north being set:
    what the scan's heading is missing for is the GROUND's orientation.
    """
    if when.tzinfo is None or when.utcoffset() is None:
        raise ValueError("solar_position needs a timezone-aware datetime — a naive "
                         "one is 8 h ambiguous here; pass tzinfo=datetime.timezone.utc")
    u = when.astimezone(UTC)
    decl, eot = _sun_terms(_julian_day(u))
    minutes = u.hour * 60 + u.minute + u.second / 60
    tst = (minutes + eot + 4 * lon) % 1440          # true solar time, minutes
    ha = tst / 4 - 180                              # hour angle, deg (0 at solar noon)
    phi, d, h = math.radians(lat), math.radians(decl), math.radians(ha)
    sin_alt = math.sin(phi) * math.sin(d) + math.cos(phi) * math.cos(d) * math.cos(h)
    alt = math.degrees(math.asin(max(-1.0, min(1.0, sin_alt))))
    # atan2 form rather than NOAA's acos-plus-branch: no domain errors at the
    # poles and no sign branch to get backwards. It gives azimuth from SOUTH,
    # positive westward; +180 puts it on the project's compass convention.
    az = (math.degrees(math.atan2(math.sin(h),
                                  math.cos(h) * math.sin(phi) - math.tan(d) * math.cos(phi)))
          + 180) % 360
    return {"utc": u.replace(microsecond=0).isoformat(),
            "altitude_deg": round(alt, 3),
            "apparent_altitude_deg": round(alt + _refraction(alt), 3),
            "azimuth_deg": round(az, 3),
            "declination_deg": round(decl, 3),
            "hour_angle_deg": round(ha, 3),
            "eq_of_time_min": round(eot, 2),
            "true_solar_time_h": round(tst / 60, 3)}


def solar_noon(lat, lon, day):
    """The instant the sun crosses the meridian, and how high it gets.

    720 - 4*lon - eot, in UTC minutes. The equation of time is evaluated at the
    estimate and the estimate redone: dropping that term moves noon by up to 16
    minutes, which is invisible in an altitude and obvious in a shadow.
    """
    minutes = 720 - 4 * lon
    for _ in range(2):
        when = dt.datetime.combine(day, dt.time(), UTC) + dt.timedelta(minutes=minutes)
        _, eot = _sun_terms(_julian_day(when))
        minutes = 720 - 4 * lon - eot
    when = dt.datetime.combine(day, dt.time(), UTC) + dt.timedelta(minutes=minutes)
    p = solar_position(lat, lon, when)
    p["date"] = day.isoformat()
    return p


def day_arc(lat, lon, day, step_min=30):
    """Sunrise, sunset, day length and the altitude track. Latitude only."""
    noon = solar_noon(lat, lon, day)
    noon_utc = dt.datetime.fromisoformat(noon["utc"])
    phi, d = math.radians(lat), math.radians(noon["declination_deg"])
    cos_ha = ((math.cos(math.radians(SUNRISE_ZENITH)) - math.sin(phi) * math.sin(d))
              / (math.cos(phi) * math.cos(d)))
    if cos_ha < -1:                                  # midnight sun
        rise = set_ = None
        length = 24.0
    elif cos_ha > 1:                                 # polar night
        rise = set_ = None
        length = 0.0
    else:
        ha = math.degrees(math.acos(cos_ha))
        rise = noon_utc - dt.timedelta(minutes=4 * ha)
        set_ = noon_utc + dt.timedelta(minutes=4 * ha)
        length = 8 * ha / 60

    # Walk sunrise -> sunset, not the UTC calendar day. At longitude -122 a UTC
    # day splices the PREVIOUS local evening onto this local morning: an altitude
    # track of 39 deg, then 5 deg, then back up to 23 deg can span two different
    # afternoons. Only in the polar cases, where there is no rise or set to walk
    # between, does it fall back to the UTC day.
    track = []
    t = rise or dt.datetime.combine(day, dt.time(), UTC)
    end = set_ or (t + dt.timedelta(days=1))
    while t <= end:
        p = solar_position(lat, lon, t)
        if p["altitude_deg"] > 0 or rise is not None:
            track.append({"utc": p["utc"], "altitude_deg": p["altitude_deg"],
                          "azimuth_deg": p["azimuth_deg"]})
        t += dt.timedelta(minutes=step_min)

    return {"date": day.isoformat(),
            "latitude": round(lat, 5), "longitude": round(lon, 5),
            "sunrise_utc": rise.replace(microsecond=0).isoformat() if rise else None,
            "sunset_utc": set_.replace(microsecond=0).isoformat() if set_ else None,
            "solar_noon_utc": noon["utc"],
            "day_length_h": round(length, 3),
            "noon_altitude_deg": noon["altitude_deg"],
            "noon_azimuth_deg": noon["azimuth_deg"],
            "declination_deg": noon["declination_deg"],
            "track": track,
            "note": "UTC throughout. Solar noon is the meridian crossing, not 12:00 "
                    "local clock time; the two differ by the equation of time plus "
                    "the longitude offset within the zone."}


# Fixed dates rather than the true solstice/equinox instants: those drift a few
# hours between years and move the noon altitude by under 0.02 deg.
SEASON_DATES = {"march_equinox": (3, 20), "june_solstice": (6, 21),
                "september_equinox": (9, 22), "december_solstice": (12, 21)}


def season_range(lat, lon, year):
    """The seasonal envelope: how high and how long, at each turn of the year."""
    out = {}
    for name, (m, d) in SEASON_DATES.items():
        a = day_arc(lat, lon, dt.date(year, m, d), step_min=60)
        out[name] = {"date": a["date"],
                     "noon_altitude_deg": a["noon_altitude_deg"],
                     "day_length_h": a["day_length_h"],
                     "sunrise_utc": a["sunrise_utc"], "sunset_utc": a["sunset_utc"]}
    out["noon_altitude_range_deg"] = round(
        out["june_solstice"]["noon_altitude_deg"]
        - out["december_solstice"]["noon_altitude_deg"], 2)
    out["latitude"] = round(lat, 5)
    return out


# ── irradiance on a tilted plane ──────────────────────────────────────────

def _clear_sky(alt_deg, doy):
    """Beam-normal and diffuse-horizontal irradiance, W/m2, under a clear sky."""
    if alt_deg <= 0:
        return 0.0, 0.0
    sin_h = math.sin(math.radians(alt_deg))
    # Kasten-Young air mass: the plain 1/sin(h) form diverges near the horizon
    # and would inflate every low-sun hour, which is exactly where aspect bites.
    am = 1.0 / (sin_h + 0.50572 * (alt_deg + 6.07995) ** -1.6364)
    e0 = 1 + 0.033 * math.cos(2 * math.pi * doy / 365.25)
    dni = SOLAR_CONSTANT * e0 * TURBIDITY_BASE ** (am ** 0.678)
    return dni, DIFFUSE_FRACTION * dni * sin_h


def slope_irradiance(lat, lon, day, slope_deg, aspect_deg, step_min=5,
                     albedo=DEFAULT_ALBEDO):
    """Clear-sky daily energy on a tilted plane, against flat ground.

    `aspect_deg` is the compass bearing the slope FACES — for a yard zone that is
    its downhill bearing, in TRUE degrees. This function does not read site.json
    and cannot check where the number came from, which is why every caller-facing
    result labels the source; `zone_sun()` is the one that goes to disk, and it
    is the one that refuses.

    Open sky: no cloud, and no shadow from the house, fences, trees or the hill.
    """
    beta = math.radians(slope_deg)
    face = math.radians(aspect_deg)
    doy = day.timetuple().tm_yday
    step_h = step_min / 60.0
    horiz = tilt = direct_h = 0.0
    first = last = None
    t = dt.datetime.combine(day, dt.time(), UTC)
    end = t + dt.timedelta(days=1)
    while t < end:
        p = solar_position(lat, lon, t)
        alt = p["altitude_deg"]
        if alt > 0:
            dni, dhi = _clear_sky(alt, doy)
            a = math.radians(alt)
            # cosine of the angle between the sun and the slope's normal
            cos_i = (math.cos(beta) * math.sin(a)
                     + math.sin(beta) * math.cos(a)
                     * math.cos(math.radians(p["azimuth_deg"]) - face))
            ghi = dni * math.sin(a) + dhi
            horiz += ghi * step_h
            tilt += (dni * max(cos_i, 0.0)
                     + dhi * (1 + math.cos(beta)) / 2
                     + albedo * ghi * (1 - math.cos(beta)) / 2) * step_h
            if cos_i > 0:
                direct_h += step_h
                first = first or p["utc"]
                last = p["utc"]
        t += dt.timedelta(minutes=step_min)

    return {"date": day.isoformat(),
            "slope_deg": round(slope_deg, 2),
            "aspect_deg": round(aspect_deg % 360, 1),
            "aspect_source": "caller-supplied — NOT measured from the scan",
            "horizontal_kwh_m2": round(horiz / 1000, 3),
            "slope_kwh_m2": round(tilt / 1000, 3),
            "slope_over_horizontal": round(tilt / horiz, 3) if horiz else None,
            "direct_sun_h": round(direct_h, 2),
            "first_direct_utc": first, "last_direct_utc": last,
            "exposure": _exposure_band(direct_h),
            "model": ("clear-sky: Kasten-Young air mass, 0.7^AM^0.678 beam, 10% "
                      "diffuse, isotropic sky, albedo " + format(albedo, ".2f")),
            "excludes": "cloud, and every shadow — house, fence, neighbours' trees, "
                        "the hill itself. Open sky only."}


def _exposure_band(hours):
    """The horticultural bands, so a species list can be checked against them.

    The caveat rides along in the string. This is the one field a planting rule
    would read as a verdict, and it is computed from open-sky beam hours: a
    December north-east slope in California can score 7.8 h and read "full sun" only because
    the model cannot see the house, the fence or the neighbours' trees.
    """
    if hours >= 6:
        band = "full sun (6 h or more of direct sun"
    elif hours >= 4:
        band = "part sun (4-6 h"
    elif hours >= 2:
        band = "part shade (2-4 h"
    else:
        band = "shade (under 2 h"
    return band + ", open sky — no shadow from house, fence or trees)"


# ── the north gate ────────────────────────────────────────────────────────

def true_bearing(stored_deg, yaw_rad):
    """Stored-frame bearing -> true compass bearing.

    true = stored - degrees(yaw). See the module docstring for the two derivations;
    getting this backwards is an error of twice the yaw.
    """
    return (stored_deg - math.degrees(yaw_rad)) % 360


def _capture_key(name):
    """Captures are recorded as a served path OR a bare filename, depending on
    whether the file was opened from data/captures/ or hand-picked. Comparing the
    raw strings would refuse a perfectly consistent pair."""
    return os.path.basename(name).strip().lower() if name else None


def north_status():
    """Is the active capture's heading tied to true north, and by how much?

    calibration.json is authoritative: it is what the viewer writes when Set north
    runs, and each capture keeps its own copy. site.json's frame
    block and the zones' `bearings_unverified` are cross-checks — nothing clears
    them automatically, so treating them as a hard gate would jam it shut after
    the two clicks. They raise `stale` instead, and `stale` is reported loudly.
    """
    calib = calibration()
    if calib is None:
        return {"north_set": False,
                "reason": "data/calibration.json is missing or unreadable, so the "
                          "scan's heading is unknown. A yaw of 0 is not a safe "
                          "default: it is a claim that the scan happens to be "
                          "north-aligned.",
                "capture": None}

    capture = calib.get("captureUrl") or calib.get("capture")
    if not capture:
        return {"north_set": False,
                "reason": "calibration.json names no active capture, so there is "
                          "nothing to check a heading against.",
                "capture": None}

    per_capture = (calib.get("captures") or {}).get(capture)
    if per_capture is None:
        # the stash is keyed by whichever form the viewer had; try the other
        for k, v in (calib.get("captures") or {}).items():
            if _capture_key(k) == _capture_key(capture):
                per_capture = v
                break
    flags = [calib.get("northSet")]
    if per_capture is not None:
        flags.append(per_capture.get("northSet"))
    if not all(f is True for f in flags):
        return {"north_set": False, "capture": capture,
                "reason": "north has not been set on %s (calibration northSet is %s). "
                          "Every bearing in site.json is therefore relative to the "
                          "scan's own arbitrary heading. A 23.3 deg heading offset "
                          "means a 23.3 deg bearing error; another capture's "
                          "calibration cannot correct this one."
                          % (capture, ", ".join(repr(f) for f in flags))}

    yaw = calib.get("yaw")
    if not isinstance(yaw, (int, float)):
        return {"north_set": False, "capture": capture,
                "reason": "calibration says northSet on %s but carries no numeric "
                          "yaw, so the correction from the stored frame to true "
                          "north cannot be applied." % capture}

    s = site()
    analysis_capture = (s.get("frame") or {}).get("capture") or s.get("landmarks_frame")
    if analysis_capture and _capture_key(analysis_capture) != _capture_key(capture):
        return {"north_set": False, "capture": capture,
                "reason": "the active capture is %s but site.json's bearings were "
                          "measured in %s. A bearing is only meaningful in the frame "
                          "it was measured in, and one capture's yaw does not convert "
                          "another's." % (capture, analysis_capture)}

    stale = []
    if (s.get("frame") or {}).get("north_set") is False:
        stale.append("site.json frame block still says north_set false")
    if any(z.get("bearings_unverified") for z in s.get("zones", [])):
        stale.append("site.json zones still carry bearings_unverified")
    return {"north_set": True, "capture": capture,
            "yaw_rad": round(yaw, 6), "yaw_deg": round(math.degrees(yaw), 2),
            "stale_site_flags": stale}


def _refusal(quantity, status, reason=None):
    """A refusal carrying no number a caller could read back as an answer.

    Deliberately not an exception and deliberately not None: an unknown must
    remain distinguishable from a successful answer so callers cannot fail open.
    """
    return {"refused": True,
            "quantity": quantity,
            "reason": reason or status.get("reason", "north is not set"),
            "north": {k: v for k, v in status.items() if k != "reason"},
            "fix": ["In the viewer, open the active capture and use Set north "
                    "(click two points along a line you know runs north), then "
                    "Save calibration.",
                    "Then re-run `python3 tools/analyze_site.py` so site.json's "
                    "frame block and the zone bearings stop saying unverified."],
            "available_without_north": [
                "python3 tools/sun.py day --date YYYY-MM-DD — sunrise, sunset, day "
                "length and the altitude track",
                "python3 tools/sun.py season — noon altitude and day length at the "
                "solstices and equinoxes",
                "python3 tools/sun.py slope --slope D --aspect B — irradiance for an "
                "aspect you supply yourself, labelled as unmeasured"]}


def _latlon():
    o = site().get("origin") or {}
    lat, lon = o.get("lat"), o.get("lon")
    if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
        return None
    return lat, lon


def zone_sun(zone_name, day, step_min=5):
    """Everything the sun does to one measured yard — or why it cannot be said.

    This is the only function here that goes to disk for an aspect, so it is the
    only one that can be lied to by a stale frame, and the only one that refuses.
    """
    status = north_status()
    ll = _latlon()
    if ll is None:
        return _refusal("zone_sun(%s)" % zone_name, status,
                        reason="site.json has no origin lat/lon, so even the sun's "
                               "position is unknown. Run tools/geodata.py --address.")
    if not status["north_set"]:
        return _refusal("zone_sun(%s)" % zone_name, status)

    zones = site().get("zones", [])
    z = next((q for q in zones if q.get("zone") == zone_name), None)
    if z is None:
        return _refusal("zone_sun(%s)" % zone_name, status,
                        reason="no zone named %r in site.json (have: %s). Zones are "
                               "measured, not named by hand — run tools/analyze_site.py."
                               % (zone_name, ", ".join(q.get("zone", "?") for q in zones)))
    if not isinstance(z.get("downhill_bearing_deg"), (int, float)):
        return _refusal("zone_sun(%s)" % zone_name, status,
                        reason="zone %r has no downhill_bearing_deg, so it has no "
                               "measured aspect. Re-run tools/analyze_site.py." % zone_name)

    lat, lon = ll
    aspect = true_bearing(z["downhill_bearing_deg"], status["yaw_rad"])
    slope = float(z.get("slope_deg") or 0.0)
    out = slope_irradiance(lat, lon, day, slope, aspect, step_min=step_min)
    out["aspect_source"] = ("measured: zone downhill bearing %s deg in the scan frame, "
                            "yaw-corrected by %s deg to true north"
                            % (z["downhill_bearing_deg"], status["yaw_deg"]))
    out["zone"] = zone_name
    out["stored_bearing_deg"] = z["downhill_bearing_deg"]
    out["yaw_deg"] = status["yaw_deg"]
    out["capture"] = status["capture"]
    arc = day_arc(lat, lon, day, step_min=60)
    out["day_length_h"] = arc["day_length_h"]
    out["noon_altitude_deg"] = arc["noon_altitude_deg"]
    out["seasonal_direct_sun_h"] = {
        name: slope_irradiance(lat, lon, dt.date(day.year, m, d), slope, aspect,
                               step_min=15)["direct_sun_h"]
        for name, (m, d) in (("june_solstice", SEASON_DATES["june_solstice"]),
                             ("december_solstice", SEASON_DATES["december_solstice"]))}
    warnings = []
    if status.get("stale_site_flags"):
        warnings.append(
            "north IS set on the capture, but " + "; ".join(status["stale_site_flags"])
            + ". Those flags predate the calibration and nothing clears them "
              "automatically — re-run `python3 tools/analyze_site.py`. The bearing "
              "above is still correct: stored ENU never migrates, and "
              "the yaw is applied here.")
    out["stale_site_analysis"] = bool(status.get("stale_site_flags"))
    out["warnings"] = warnings
    return out


# ── CLI ───────────────────────────────────────────────────────────────────
# Shaped like site_api.py: one JSON object per invocation. Per the capability
# map's "decide WHO the tool is for", the real consumers are the design agent
# (which should reach this through an MCP tool, not a filename) and the planting
# rules; the CLI is what a session editing this code can run.

def _date(s):
    return dt.date.fromisoformat(s) if s else dt.date.today()


def cmd_position(a):
    ll = _latlon()
    if ll is None:
        return {"error": "site.json has no origin lat/lon — run tools/geodata.py --address"}
    lat, lon = ll
    d = _date(a.date)
    hh, mm = (a.time.split(":") + ["0"])[:2]
    tz = dt.timezone(dt.timedelta(hours=a.utc_offset))
    when = dt.datetime(d.year, d.month, d.day, int(hh), int(mm), tzinfo=tz)
    p = solar_position(lat, lon, when)
    p["input_interpreted_as"] = when.isoformat()
    return p


def cmd_day(a):
    ll = _latlon()
    if ll is None:
        return {"error": "site.json has no origin lat/lon — run tools/geodata.py --address"}
    return day_arc(ll[0], ll[1], _date(a.date), step_min=a.step)


def cmd_season(a):
    ll = _latlon()
    if ll is None:
        return {"error": "site.json has no origin lat/lon — run tools/geodata.py --address"}
    return season_range(ll[0], ll[1], a.year or dt.date.today().year)


def cmd_north(a):
    s = north_status()
    if not s["north_set"]:
        return _refusal("any bearing-dependent quantity", s)
    return s


def cmd_zone(a):
    return zone_sun(a.zone, _date(a.date))


def cmd_slope(a):
    ll = _latlon()
    if ll is None:
        return {"error": "site.json has no origin lat/lon — run tools/geodata.py --address"}
    return slope_irradiance(ll[0], ll[1], _date(a.date), a.slope, a.aspect)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("position", help="sun altitude and azimuth at an instant")
    p.add_argument("--date"); p.add_argument("--time", default="12:00")
    p.add_argument("--utc-offset", type=float, default=0.0,
                   help="hours; the time above is UTC unless you say otherwise")
    p.set_defaults(fn=cmd_position)

    p = sub.add_parser("day", help="sunrise, sunset, day length, altitude track")
    p.add_argument("--date"); p.add_argument("--step", type=int, default=30)
    p.set_defaults(fn=cmd_day)

    p = sub.add_parser("season", help="noon altitude and day length round the year")
    p.add_argument("--year", type=int)
    p.set_defaults(fn=cmd_season)

    p = sub.add_parser("north", help="is the scan tied to true north yet, and by how much")
    p.set_defaults(fn=cmd_north)

    p = sub.add_parser("zone", help="sun on one measured yard (needs north set)")
    p.add_argument("zone"); p.add_argument("--date")
    p.set_defaults(fn=cmd_zone)

    p = sub.add_parser("slope", help="irradiance for a slope and aspect YOU supply")
    p.add_argument("--slope", type=float, required=True)
    p.add_argument("--aspect", type=float, required=True,
                   help="true compass bearing the slope faces, 0=N 90=E")
    p.add_argument("--date")
    p.set_defaults(fn=cmd_slope)

    a = ap.parse_args()
    try:
        out = a.fn(a)
    except Exception as e:                      # a tool must never hand back a traceback
        print(json.dumps({"error": "%s: %s" % (type(e).__name__, e)}))
        sys.exit(1)
    print(json.dumps(out, indent=1))
    # 2 is a refusal, distinct from 1 (broken) and 0 (answered). A refusal that
    # exits 0 is indistinguishable from an answer to anything downstream.
    sys.exit(2 if out.get("refused") else (1 if out.get("error") else 0))


if __name__ == "__main__":
    main()
