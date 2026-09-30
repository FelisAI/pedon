"""Which design objects are not sitting on the ground?

The commonest visual defect is an object at the wrong HEIGHT, and it passes every
check that does not measure it — only someone looking at the screen sees it:

  * beds and plants standing on a deck, when the BFS-filled height field reads
    the deck surface as ground (+0.50 where the real mesh is -1.20);
  * a whole section of planting launched into the sky after "Set north", when
    a fallback height field built in the world frame is queried in ENU by
    heightAt().

Eyeballing does not scale and does not run inside a headless design loop, so ask
instead. Positive gap = floating; negative = buried in the ground.

    python3 tools/float_check.py                # exits non-zero if anything floats
    python3 tools/float_check.py --tolerance 0.2
    python3 tools/float_check.py --limit 40

Needs the viewer running with a capture and a design loaded, tab in the
FOREGROUND (a background tab is throttled).
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


def run(tol, limit):
    """Through the shared broker client, so every caller of this POST handles
    errors the same way (see tools/broker.py)."""
    try:
        return broker.data({"op": "float_check", "tolerance_m": tol, "limit": limit}, timeout=60)
    except broker.ViewerDown as e:
        raise SystemExit(str(e))
    except broker.BrokerRefused as e:
        raise SystemExit(f"could not run: {e}")

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tolerance", type=float, default=0.4,
                    help="metres of gap tolerated before an object counts as floating")
    ap.add_argument("--limit", type=int, default=15, help="how many rows to print")
    a = ap.parse_args()

    d = run(a.tolerance, a.limit)
    print(f"{d['checked']} objects checked, tolerance {d['tolerance_m']} m\n")
    print(f"  {'object':26s} {'ENU':>14s} {'base':>7s} {'ground lo..hi':>15s} {'gap':>7s}")
    for r in d["worst"]:
        flag = ""
        if r["gap_m"] > d["tolerance_m"]:
            flag = "  <-- FLOATING clear of the ground"
        elif r["buried_m"] > d["tolerance_m"]:
            flag = "  (cut into the slope)"
        enu = f"{r['enu'][0]},{r['enu'][1]}"
        band = f"{r['ground_min_m']:.2f}..{r['ground_max_m']:.2f}"
        print(f"  {r['id'][:26]:26s} {enu:>14s} {r['bottom_m']:7.2f} "
              f"{band:>15s} {r['gap_m']:7.2f}{flag}")
    print(f"\n{d['verdict']}")
    return 1 if d["floating"] else 0


if __name__ == "__main__":
    sys.exit(main())
