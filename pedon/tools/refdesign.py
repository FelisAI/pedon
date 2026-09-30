#!/usr/bin/env python3
"""Landscape photographs the OWNER wants to learn from, and what to take from them.

    python3 tools/refdesign.py add --image ~/piet.jpg \
        --note "the way the grasses hold the light in October, and how much is left open"
    python3 tools/refdesign.py list
    python3 tools/refdesign.py read piet_20250601          # one reading pass
    python3 tools/refdesign.py principles                  # the whole corpus, brief-ready

The owner can give the model a landscape photograph to learn design principles
for their site.

THE TRAP, AND IT IS THE WHOLE DESIGN OF THIS FILE
-------------------------------------------------
Copying a photograph's GEOMETRY does not suit the owner's ground: the reference
depicts someone else's slope, light and latitude. A design that looks like the
photograph but ignores a 1.9 m step in the owner's ground is the exact failure this project
exists to prevent.

So a reference is read into PRINCIPLES and NUMBERS-WITHOUT-PLACES — which height
bands are occupied, how much is left open, how big a drift is, how wide the walk,
whether the edges are drawn or drifted, what it is doing in which season. Those
are applied to MEASURED ground. Nothing here may emit a coordinate, an outline or
a plant position, and `tests/test_refdesign.py` fails if the schema grows one.

A number in a brief is a restriction wherever it is written down, so a reference
must contribute a REASON ("drifts of one species read as a garden"), not a target.

OWNER INPUT, LIKE LANDMARKS AND AREAS
-------------------------------------
The owner chooses what they want to learn from. Nothing here fetches an image,
searches for one, or infers that they would like a style. `add` takes a file they
point at and a note in their own words, and the NOTE IS THE VALUABLE HALF — an
image alone does not identify which design decisions they are responding to.

NO API KEYS. The reading pass shells out to the logged-in `claude` CLI, which can
read a local image, with tools restricted to Read and a deny list — a prompt built
from documentation is NOT INERT, and this one hands over a file path.
"""
from __future__ import annotations
import argparse
import datetime
import json
import os
import project  # the active project's files — the ONE owner
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = project.data("refdesigns")
INDEX = os.path.join(OUT, "index.json")
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp"}

# WHAT A READING MAY CONTAIN. Every key is a proportion, a band, a count or a
# word — nothing that names a PLACE. The validator for this file is the absence
# of geometry, so the list is the spec.
READING_KEYS = {
    "height_bands",          # which of ankle/knee/waist/head are occupied
    "open_ground",           # 0-1, how much is deliberately left empty
    "hard_fraction",         # 0-1, paving and structure against planted
    "drift_size",            # plants per single-species group, as a range
    "path_width_m",          # what a walk measures, if one is visible
    "edge",                  # "drawn" | "drifted" | "mixed"
    "season",                # what the photograph is showing
    "palette",               # colour words, never hexes lifted off the image
    "repetition",            # how much of the planting is the same few species
    "principles",            # the sentences a designer would act on
    "not_transferable",      # what is about THAT site and must not be copied
}
# anything matching these is geometry and is refused outright
GEOMETRY = re.compile(r"\b(x|y|z|lat|lon|polygon|spline|position|coords?|coordinates|"
                      r"outline|vertices|points|centre|center|offset_m)\b", re.I)

NO_TOOLS_BUT_READ = ["--allowedTools", "Read",
                     "--disallowedTools", "Bash", "Write", "Edit", "Glob", "Grep",
                     "Task", "WebFetch", "WebSearch", "NotebookEdit"]

BRIEF = """You are looking at ONE photograph of a planted landscape, at {path}.
Read it, and answer ONLY as JSON with exactly these keys:

  height_bands      object with ankle/knee/waist/head -> true or false; which
                    body-scale bands the planting actually occupies
  open_ground       0 to 1; how much of the ground is deliberately left empty
  hard_fraction     0 to 1; paving, walls and structure against planted ground
  drift_size        a range like "5-9", how many plants a single-species group runs to
  path_width_m      what a walk measures, or null if no path is visible
  edge              "drawn", "drifted" or "mixed" — how planting meets paving
  season            what the photograph is showing
  palette           3-6 colour WORDS (not hex), the ones doing the work
  repetition        a sentence on how much of it is the same few species
  principles        3-6 sentences a designer could ACT on, each about a decision
                    somebody made here, not a description of what is in the frame
  not_transferable  2-4 things that are about THAT site — its slope, its light,
                    its climate, its scale — and must NOT be copied elsewhere

RULES.
- NEVER give a coordinate, an outline, a plant position or any placement. This
  reading is applied to different ground, on a 13 degree slope in coastal California, and
  geometry lifted from a photograph would be wrong there in a way no validator
  can catch.
- A principle is a REASON, never a target. "drifts of one species read as a
  garden" is a principle; "use 7 plants per drift" is a number that will be
  obeyed literally and wrongly.
- If you cannot tell from the photograph, say null. A guess here becomes a fact
  downstream.
Answer with the JSON object and nothing else."""


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", (text or "").strip().lower()).strip("_")[:48]


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


def geometry_in(reading) -> list:
    """Every key or string in a reading that names a PLACE rather than a quality."""
    bad = []

    def walk(node, path=""):
        if isinstance(node, dict):
            for k, v in node.items():
                if GEOMETRY.search(str(k)):
                    bad.append(f"{path}{k}")
                walk(v, f"{path}{k}.")
        elif isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, f"{path}[{i}].")
        elif isinstance(node, str):
            # a sentence may legitimately say "the path" — what is refused is a
            # NUMBER attached to a place, which is what transplanting looks like
            if re.search(r"\b(at|to)\s+-?\d+(\.\d+)?\s*,\s*-?\d+", node):
                bad.append(f"{path}<coordinate in prose>")
    walk(reading)
    return bad


def add(args) -> int:
    src = os.path.expanduser(args.image)
    if not os.path.isfile(src):
        print(json.dumps({"error": "no_image", "detail": f"{src} is not a file"}))
        return 1
    ext = os.path.splitext(src)[1].lower()
    if ext not in IMAGE_EXT:
        print(json.dumps({"error": "not_an_image", "detail": ext or "no extension"}))
        return 1
    # THE NOTE IS THE VALUABLE HALF. Without it, the image does not identify what
    # the owner is responding to, so the reading can focus on anything in the frame.
    if not (args.note or "").strip():
        print(json.dumps({
            "error": "no_note",
            "detail": "say what you liked about it, in your own words. The note is "
                      "the half that makes the image worth reading — without it "
                      "nothing knows which of the hundred decisions in the "
                      "photograph you were responding to.",
        }))
        return 1
    key = args.key or f"{slug(args.name or os.path.splitext(os.path.basename(src))[0])}" \
                      f"_{datetime.date.today().strftime('%Y%m%d')}"
    idx = load_index()
    if key in idx and not args.replace:
        print(json.dumps({"error": "already_have_one", "key": key,
                          "detail": "pass --replace to overwrite it"}))
        return 1
    os.makedirs(OUT, exist_ok=True)
    dest = os.path.join(OUT, f"{key}{ext}")
    shutil.copy2(src, dest)
    idx[key] = {
        "file": os.path.relpath(dest, ROOT),
        "note": args.note.strip(),                       # the owner's words, verbatim
        "added_on": datetime.date.today().isoformat(),
        "source": "owner",
        **({"name": args.name.strip()} if args.name else {}),
        **({"credit": args.credit.strip()} if args.credit else {}),
    }
    save_index(idx)
    print(json.dumps({"ok": True, "key": key, "row": idx[key],
                      "next": f"python3 tools/refdesign.py read {key}"}, indent=1))
    return 0


def read_one(args) -> int:
    idx = load_index()
    row = idx.get(args.key)
    if not row:
        print(json.dumps({"error": "no_such_reference", "key": args.key,
                          "have": sorted(idx)}))
        return 1
    path = project.resolve(row["file"])
    if not os.path.isfile(path):
        print(json.dumps({"error": "image_missing", "file": row["file"]}))
        return 1
    prompt = BRIEF.format(path=path) + (
        f"\n\nThe owner said this about it, and it is what they were responding to — "
        f"weight your reading towards it:\n  \"{row['note']}\"")
    try:
        out = subprocess.run(["claude", "-p", prompt, *NO_TOOLS_BUT_READ],
                             capture_output=True, text=True,
                             timeout=args.timeout, cwd=ROOT)
    except FileNotFoundError:
        print(json.dumps({"error": "no_claude_cli",
                          "detail": "the logged-in `claude` CLI is how this reads an "
                                    "image; no API key is used or wanted"}))
        return 1
    except subprocess.TimeoutExpired:
        print(json.dumps({"error": "timeout", "detail": f"{args.timeout}s"}))
        return 1
    if out.returncode != 0:
        print(json.dumps({"error": "claude_failed", "detail": out.stderr[-300:]}))
        return 1
    text = out.stdout.strip()
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        print(json.dumps({"error": "not_json", "detail": text[:300]}))
        return 1
    try:
        reading = json.loads(m.group(0))
    except Exception as e:
        print(json.dumps({"error": "bad_json", "detail": str(e)}))
        return 1

    # THE REFUSAL THAT MAKES THIS SAFE. Geometry lifted from a photograph would
    # be applied to a slope it has never seen.
    bad = geometry_in(reading)
    if bad:
        print(json.dumps({"error": "reading_carries_geometry", "fields": bad,
                          "detail": "a reference is translated into principles applied "
                                    "to measured ground, never copied as shapes"}))
        return 1
    unknown = set(reading) - READING_KEYS
    reading = {k: v for k, v in reading.items() if k in READING_KEYS}

    idx[args.key]["reading"] = reading
    idx[args.key]["read_on"] = datetime.date.today().isoformat()
    save_index(idx)
    print(json.dumps({"ok": True, "key": args.key, "reading": reading,
                      **({"dropped_unknown_keys": sorted(unknown)} if unknown else {})},
                     indent=1))
    return 0


def cmd_list(_args) -> int:
    idx = load_index()
    print(json.dumps({"references": len(idx),
                      "rows": {k: {"note": v.get("note"), "file": v.get("file"),
                                   "read": "reading" in v} for k, v in idx.items()}},
                     indent=1))
    return 0


def principles(_args) -> int:
    """Everything the corpus says, in the shape a design conversation can use.

    Deliberately NOT a spec. A brief listing 17.0% hardscape / 1.16 m2 per plant
    invites numerical optimisation even when those values are labelled references.
    Results of 24.6% and 1.12 m2 per plant can still include an overly wide path.
    Lead with the owner's own words and the REASONS; proportions follow as context.
    """
    idx = load_index()
    out = {"references": [], "principles": [], "not_transferable": [],
           "owner_said": []}
    for key, row in sorted(idx.items()):
        out["references"].append({"key": key, "file": row.get("file")})
        if row.get("note"):
            out["owner_said"].append({"key": key, "note": row["note"]})
        r = row.get("reading") or {}
        for p in r.get("principles") or []:
            out["principles"].append({"from": key, "principle": p})
        for n in r.get("not_transferable") or []:
            out["not_transferable"].append({"from": key, "about_that_site": n})
    out["how_to_use"] = (
        "These are REASONS, not targets. Apply them to ground you have measured: "
        "site_api profile ACROSS anything you have not built on, site_api zones "
        "for where the ground is gentle, scene for whether a corner composes. A "
        "reference was shot on someone else's slope in someone else's light, and "
        "a design that looks like the photograph and ignores the 1.90 m step at "
        "x 8.8 is the failure this whole project exists to prevent.")
    # APPENDED, never replaced: the "these are reasons, not targets" sentence is
    # the point of this command and it must be there on an empty corpus too —
    # that is exactly when somebody is about to add the first one.
    if not idx:
        out["how_to_use"] += (
            "\n\nNothing here yet — `refdesign.py add --image … --note …` with a "
            "photograph the owner chose and what they said about it. The note is the "
            "valuable half.")
    print(json.dumps(out, indent=1))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("add", help="a landscape photograph you want to learn from")
    a.add_argument("--image", required=True)
    a.add_argument("--note", help="what you liked about it, in your own words")
    a.add_argument("--name")
    a.add_argument("--credit", help="photographer or garden, if you know it")
    a.add_argument("--key")
    a.add_argument("--replace", action="store_true")
    a.set_defaults(fn=add)

    r = sub.add_parser("read", help="turn one reference into principles")
    r.add_argument("key")
    r.add_argument("--timeout", type=int, default=300)
    r.set_defaults(fn=read_one)

    sub.add_parser("list", help="every reference on record").set_defaults(fn=cmd_list)
    sub.add_parser("principles",
                   help="the whole corpus, in the shape a design conversation uses"
                   ).set_defaults(fn=principles)

    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
