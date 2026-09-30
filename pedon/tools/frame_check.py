"""Assert the ENU and world coordinate frames still agree.

Why this exists
---------------
PEDON stores everything in ENU metres (design.json, site.json landmarks and
areas, terrain.json). The browser draws in world space. A calibration hierarchy
maps one to the other:

    scene > geoGroup (north yaw + xz) > levelGroup (ground plane) > the scan
                                      > enuGroup   > designs, areas, pins

At yaw 0 the two frames are the SAME NUMBERS, so a path that confuses them looks
perfectly correct until someone sets north. Any path that stores world
coordinates as if they were ENU is invisible until "Set north" pulls the frames
apart, and then —

  * design and area groups hung off the scene let the scan rotate out from
    under them, landing a bed metres off its own ground;
  * landmark reprojection writes world coordinates into site.json, which is
    on-disk damage, not just a wrong picture;
  * structure detection measures every candidate against the wrong ground.

So this check runs at a deliberately non-zero yaw. Run it after touching
anything that converts between coordinate systems.

    python3 tools/frame_check.py            # exits non-zero if the frames disagree
    python3 tools/frame_check.py --yaw 0.9

Needs the viewer running with a capture loaded, in a FOREGROUND tab.
"""
from __future__ import annotations
import broker
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

VIEWER = os.environ.get("YARDTWIN_VIEWER", "http://localhost:5178")


def run(yaw):
    """Through the shared broker client, so every caller of this POST handles
    errors the same way (see tools/broker.py)."""
    try:
        return broker.data({"op": "frame_check", "yaw": yaw}, timeout=60)
    except broker.ViewerDown as e:
        raise SystemExit(str(e))
    except broker.BrokerRefused as e:
        raise SystemExit(f"could not run: {e}")

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--yaw", type=float, default=0.7,
                    help="test yaw in radians; must not be 0, or the check proves nothing")
    a = ap.parse_args()
    if abs(a.yaw) < 0.05:
        raise SystemExit("--yaw near 0 makes this check vacuous: world and ENU "
                         "coincide there, which is precisely how these bugs hide")

    d = run(a.yaw)
    print(f"frames tested at {d['tested_at_yaw_deg']} deg\n")
    for c in d["checks"]:
        mark = "ok  " if c["pass"] else "FAIL"
        detail = f"  ({c['detail']})" if c.get("detail") else ""
        print(f"  {mark}  {c['check']}{detail}")
    print(f"\n{d['verdict']} — {d['passed']} passed, {d['failed']} failed")
    return 1 if d["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
