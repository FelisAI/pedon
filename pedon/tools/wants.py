"""What every saved design asked for that nothing can draw.

    python3 tools/wants.py            # the work queue, readable
    python3 tools/wants.py --json     # the same, for a tool

`kind` is FREE TEXT on purpose: the model asks for what the design
needs and an unmodelled kind draws as a marked placeholder rather than being
refused. That is only half of it. The other half — a missing asset should be
found or generated — needs somebody to know WHAT is missing, across every design
and not just the one open in the viewer, at the sizes that were actually asked
for. That is this.

Feed a row to `tools/gen_object.py` to have one built.
"""
from __future__ import annotations

import argparse
import json
import os
import project  # the active project's files — the ONE owner
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import objects_index as oi   # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--json", action="store_true", help="machine-readable")
    ap.add_argument("--build", action="store_true",
                    help="BUILD every outstanding kind with tools/gen_object.py. Each is "
                         "verified by running it and reverted if it fails, so a bad one "
                         "cannot reach the viewer.")
    ap.add_argument("--data", default=project.data())
    a = ap.parse_args(argv)

    try:
        oi.known_kinds()                     # fails loudly and early if there is no viewer
        rows = oi.wants_across(a.data)
    except oi.NoViewer as e:
        # exit 2, this project's code for "this property is not set up far enough
        # to ask" — as against 1 for a broken query and 0 for an answer
        print(json.dumps({"error": "no_viewer", "detail": str(e),
                          "fix": ["run from a checkout containing viewer/src/objects.js"]},
                         indent=1) if a.json else f"cannot answer: {e}", file=sys.stderr)
        return 2
    if a.json:
        print(json.dumps({"wants": rows,
                          "buildable": oi.known_kinds()}, indent=1))
        return 0
    if not rows:
        print("nothing outstanding — every object every design asks for can be drawn")
        print(f"buildable kinds: {', '.join(oi.known_kinds())}")
        return 0
    print(f"{len(rows)} kind(s) no design can draw:\n")
    for r in rows:
        size = " x ".join(str(v) for v in (r["height_m"], r["width_m"]) if v)
        print(f"  {r['kind']:22} {r['count']:2d} asked for"
              + (f", about {size} m" if size else ", no size given"))
        for d in r["designs"][:4]:
            print(f"      {d}")
        if len(r["designs"]) > 4:
            print(f"      ... and {len(r['designs']) - 4} more")
    if a.build:
        import gen_object
        print()
        made = 0
        for r in rows:
            ok, why = gen_object.generate(r["kind"], height_m=r["height_m"] or 1.8,
                                          width_m=r["width_m"])
            print(f"  {'built  ' if ok else 'FAILED '} {r['kind']:22} {why[:90]}")
            made += bool(ok)
        print(f"\n{made} of {len(rows)} built. The ones that failed are unchanged on disk.")
        return 0 if made == len(rows) else 1
    print("\n  build one:   python3 tools/gen_object.py --kind \"<kind>\"")
    print("  build all:   python3 tools/wants.py --build")
    return 0


if __name__ == "__main__":
    sys.exit(main())
