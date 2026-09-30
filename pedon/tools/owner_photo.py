#!/usr/bin/env python3
"""Record a photograph the OWNER took of a plant they actually own.

    python3 tools/owner_photo.py add --photo ~/salvia.jpg \
        --species "Salvia apiana" --height-m 0.8 --spread-m 1.1 \
        --where "back yard, by the tea court" --note "three years in the ground"
    python3 tools/owner_photo.py list
    python3 tools/owner_photo.py remove salvia_apiana__owner

The owner photographs plants they have and adds them to the assets, with sizes.

WHY THIS IS BETTER DATA THAN WHAT THE LIBRARY HAS
-------------------------------------------------
`data/refphotos/` holds photographs fetched from Wikimedia, one per palette
species, and a fetched photograph can be of a DIFFERENT SPECIES — a genus-only
entry often caches one, e.g. an *Arctostaphylos uva-ursi*, a
prostrate mat, standing in for the 2.5 m sculptural shrub the palette means.
That is why `plant_photos.py --audit` exists, and a preset modelled from such a
photograph inherits its error.

An owner photograph cannot be wrong about which plant it is: the owner is
standing in front of it. So an owner row OUTRANKS a fetched one for the same
taxon, always — the rule lives in `viewer/src/shell/refphotos.js` and `photo_for()` below, and
`tests/test_owner_photo.py` cross-checks the two so they cannot drift.

THE SAME STORE, NOT A SECOND ONE
--------------------------------
This writes into `data/refphotos/index.json` beside the fetched rows. A parallel
store would mean two things to audit, two things to keep in step, and a consumer
that reads one of them — the same reason geometry lives once, in `tools/geom.py`.

THREE RULES THIS TOOL ENFORCES
------------------------------
1. SIZE COMES FROM THE OWNER, NEVER FROM THE IMAGE. Inferring scale from a
   photograph would be a derived number standing in for a measured one, which is
   the class of error `site_api` exists to prevent. It is also the wrong number: a
   plant's MATURE size is a fact about the species and what the owner can measure
   is what it is NOW. Both are recorded, in different fields, and nothing here
   writes a mature size at all.

2. A PHOTOGRAPH MUST NOT BYPASS CAT SAFETY. `cat_safe` has three states and null
   is NOT safe. A photograph establishes what a plant LOOKS like; it says
   nothing about toxicology. This tool refuses to write `cat_safe` under any
   flag, and an owner row carries no cat-safety claim of any kind.

3. THE FILE IS COPIED, NOT REFERENCED. A path into the owner's home directory
   breaks the moment the photo is moved, and the repo would carry a reference to
   something nobody else can read.
"""
from __future__ import annotations
import argparse
import datetime
import json
import os
import project  # the active project's files — the ONE owner
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = project.data("refphotos")
OWNER_DIR = os.path.join(OUT, "owner")
INDEX = os.path.join(OUT, "index.json")

# what an owner row may carry. `cat_safe` is deliberately absent and RULE 2 above
# is why; `mature_height_m` is absent because a mature size is a fact about the
# species and a photograph of one specimen is not evidence of it.
ALLOWED = {"file", "species", "common", "source", "reference_scope",
           "usable_for_modeling", "photographed_on", "measured_height_m",
           "measured_spread_m", "where", "note", "kb"}
FORBIDDEN = {"cat_safe", "cat_safety", "mature_height_m", "mature_spread_m"}

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".heic"}


def slug(species: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", species.strip().lower()).strip("_")


def load_index() -> dict:
    try:
        with open(INDEX) as f:
            return json.load(f)
    except Exception:
        return {}


def save_index(idx: dict) -> None:
    os.makedirs(OUT, exist_ok=True)
    with open(INDEX, "w") as f:
        json.dump(idx, f, indent=1, sort_keys=True)


def is_owner(row) -> bool:
    return isinstance(row, dict) and row.get("source") == "owner"


def _rank(row) -> int:
    """The same ladder as refphotos.js, for the same reasons."""
    if is_owner(row):
        return 0
    if row.get("reference_scope") == "named_species":
        return 1
    if row.get("usable_for_modeling") is False:
        return 4
    return 2


def rows_for(idx: dict, species: str) -> list:
    want = (species or "").strip().lower()
    if not want:
        return []
    rows = [dict(row, key=key) for key, row in (idx or {}).items()
            if str(row.get("species", "")).strip().lower() == want]
    return sorted(rows, key=_rank)


def photo_for(idx: dict, species: str):
    """The one photograph to model from, or None. An owner row always wins."""
    rows = rows_for(idx, species)
    return rows[0] if rows else None


def add(args) -> int:
    src = os.path.expanduser(args.photo)
    if not os.path.isfile(src):
        print(json.dumps({"error": "no_photo", "detail": f"{src} is not a file"}))
        return 1
    ext = os.path.splitext(src)[1].lower()
    if ext not in IMAGE_EXT:
        print(json.dumps({"error": "not_an_image",
                          "detail": f"{ext or 'no extension'}; expected one of "
                                    + ", ".join(sorted(IMAGE_EXT))}))
        return 1
    # RULE 1. Refused rather than guessed: a tool that silently accepted a photo
    # with no measurement would produce rows indistinguishable from measured ones.
    if args.height_m is None and args.spread_m is None:
        print(json.dumps({
            "error": "no_measurement",
            "detail": "an owner photo is worth having because it comes with a size "
                      "you measured. Pass --height-m and/or --spread-m in METRES. "
                      "Nothing here infers scale from the image.",
        }))
        return 1
    for name, v in (("--height-m", args.height_m), ("--spread-m", args.spread_m)):
        if v is not None and not (0 < v < 30):
            print(json.dumps({"error": "implausible_size",
                              "detail": f"{name} {v} is not a plant in metres"}))
            return 1

    when = args.on or datetime.date.today().isoformat()
    key = f"{slug(args.species)}__owner"
    if key in load_index() and not args.replace:
        print(json.dumps({"error": "already_have_one", "key": key,
                          "detail": "pass --replace to overwrite it"}))
        return 1

    os.makedirs(OWNER_DIR, exist_ok=True)
    dest = os.path.join(OWNER_DIR, f"{slug(args.species)}{ext}")
    shutil.copy2(src, dest)                       # RULE 3

    row = {
        "file": os.path.relpath(dest, ROOT),
        "species": args.species.strip(),
        "source": "owner",
        "reference_scope": "owner_specimen",
        "usable_for_modeling": True,
        "photographed_on": when,
        "kb": max(1, round(os.path.getsize(dest) / 1024)),
    }
    if args.common:
        row["common"] = args.common.strip()
    if args.height_m is not None:
        row["measured_height_m"] = round(float(args.height_m), 2)
    if args.spread_m is not None:
        row["measured_spread_m"] = round(float(args.spread_m), 2)
    if args.where:
        row["where"] = args.where.strip()
    if args.note:
        row["note"] = args.note.strip()

    bad = set(row) - ALLOWED
    assert not bad, f"owner row grew a field nothing checks: {bad}"

    idx = load_index()
    idx[key] = row
    save_index(idx)
    print(json.dumps({
        "ok": True, "key": key, "row": row,
        "note": "this photo now outranks any fetched one for this species. "
                "It carries NO cat-safety claim and NO mature size — a photograph "
                "says what a plant looks like, not what it is toxicologically, and "
                "the size you measured is what it is NOW.",
    }, indent=1))
    return 0


def cmd_list(_args) -> int:
    idx = load_index()
    rows = {k: v for k, v in idx.items() if is_owner(v)}
    print(json.dumps({"owner_photos": len(rows), "of": len(idx), "rows": rows}, indent=1))
    return 0


def remove(args) -> int:
    idx = load_index()
    row = idx.get(args.key)
    if not row or not is_owner(row):
        print(json.dumps({"error": "not_an_owner_photo", "key": args.key}))
        return 1
    del idx[args.key]
    save_index(idx)
    # the FILE stays. Deleting a photograph the owner took is not this tool's decision,
    # and the index is the thing that makes it count.
    print(json.dumps({"ok": True, "removed": args.key,
                      "file_kept": row.get("file")}, indent=1))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("add", help="record a photo you took of a plant you own")
    a.add_argument("--photo", required=True)
    a.add_argument("--species", required=True)
    a.add_argument("--common")
    a.add_argument("--height-m", type=float, help="how tall it is NOW, in metres")
    a.add_argument("--spread-m", type=float, help="how wide it is NOW, in metres")
    a.add_argument("--where", help="where in the yard, in your words")
    a.add_argument("--note")
    a.add_argument("--on", help="YYYY-MM-DD; defaults to today")
    a.add_argument("--replace", action="store_true")
    a.set_defaults(fn=add)

    sub.add_parser("list", help="every owner photo on record").set_defaults(fn=cmd_list)

    r = sub.add_parser("remove", help="drop an owner photo from the index")
    r.add_argument("key")
    r.set_defaults(fn=remove)

    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
