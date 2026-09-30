"""The ONE python reader of objects.js's object vocabulary.

`viewer/src/objects.js` owns what the viewer can build (`BUILDERS`) and how a
free-text kind resolves to one of them (`ALIASES`). Python needs both — to list
what a design asked for that nothing can draw, and to hand a generator the work.

There is one reader so that there are never two: a second regex scraping
BUILDERS (in `view_mcp.do_list_assets`, say) is the hand-rolled-duplicate-lookup
bug again. The JS is the source of truth and this file only ever reads it; `tests/test_wants.py`
cross-checks every answer against node actually running objects.js, because a
python transcription of a JS regex that merely LOOKS right is precisely how this
would rot without anyone noticing.
"""
from __future__ import annotations

import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OBJECTS_JS = os.path.join(ROOT, "viewer", "src", "objects.js")


class NoViewer(Exception):
    """viewer/src/objects.js is not here. Carries the answer, not the exception.

    The object vocabulary lives in the viewer, so a property with tools but no
    viewer cannot be asked what it can build. That is a REFUSAL, not a crash —
    same contract as site_api's `no_scan`: a traceback buries the one line that
    says what to do about it.
    """


def _source(path=None):
    target = path or OBJECTS_JS
    try:
        with open(target) as f:
            return f.read()
    except OSError as e:
        raise NoViewer(f"cannot read {os.path.relpath(target, ROOT)}: {e.strerror}. "
                       f"The object vocabulary lives in the viewer — run this from a "
                       f"checkout that has viewer/src/objects.js.") from None


def known_kinds(path=None):
    """The keys of BUILDERS, in file order.

    Raises rather than returning [] when the parse finds nothing: a scraper that
    silently comes back empty would report every kind as unbuildable and send
    someone off to build eight things that already exist.
    """
    src = _source(path)
    block = re.search(r"const BUILDERS = \{(.*?)\n\};", src, re.S)
    if not block:
        raise ValueError(f"no BUILDERS block in {path or OBJECTS_JS} — fix this parse, "
                         f"do not let it return nothing")
    kinds = re.findall(r"^\s{2}(\w+):", block.group(1), re.M)
    if not kinds:
        raise ValueError(f"BUILDERS in {path or OBJECTS_JS} parsed to zero kinds")
    return kinds


# JS regex flags this file understands. Anything else is refused rather than
# guessed at, because a silently-dropped flag changes what matches.
_FLAGS = {"i": re.I, "": 0}


def _aliases(path=None):
    """[(compiled regex, kind)] from ALIASES, in ORDER — first match wins there
    too, and the order carries decisions (moon gate before pergola, so "moon
    arch" is not read as an arbour)."""
    src = _source(path)
    block = re.search(r"const ALIASES = \[(.*?)\n\];", src, re.S)
    if not block:
        raise ValueError("no ALIASES block in objects.js — fix this parse")
    out = []
    for body, flags, kind in re.findall(r"\[\s*/(.+?)/(\w*)\s*,\s*\"(\w+)\"\s*\]", block.group(1)):
        if flags not in _FLAGS:
            raise ValueError(f"objects.js alias /{body}/{flags} uses a flag this reader "
                             f"does not understand; add it rather than dropping it")
        # JS and python agree on the constructs these aliases actually use
        # (alternation, \b, ?, character classes, non-capturing groups). A pattern
        # python cannot compile is an error, not a silent miss.
        out.append((re.compile(body, _FLAGS[flags]), kind))
    if not out:
        raise ValueError("ALIASES parsed to zero rules")
    return out


def resolve_kind(kind, path=None):
    """Free-text kind -> a BUILDERS key, or None. Mirrors objects.js resolveKind."""
    name = str(kind or "").strip()
    if not name:
        return None
    flat = re.sub(r"[\s-]+", "_", name.lower())
    if flat in known_kinds(path):
        return flat
    for rx, k in _aliases(path):
        if rx.search(name):
            return k
    return None


def wants(design, path=None):
    """What this design asked for that nothing can draw.

    Carries the SIZE that was asked for, which a bare kind name loses and which is
    the first thing anyone building the asset needs.
    """
    by = {}
    for o in (design or {}).get("objects", []) or []:
        if not isinstance(o, dict):
            continue
        if resolve_kind(o.get("kind"), path):
            continue
        key = str(o.get("kind") or "").strip() or "(unnamed)"
        row = by.setdefault(key, {"kind": key, "count": 0, "ids": [],
                                  "_h": [], "_w": []})
        row["count"] += 1
        row["ids"].append(o.get("id"))
        for src, dst in (("height_m", "_h"), ("width_m", "_w")):
            v = o.get(src)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                row[dst].append(float(v))
    out = []
    for row in by.values():
        h, w = row.pop("_h"), row.pop("_w")
        row["height_m"] = round(sum(h) / len(h), 2) if h else None
        row["width_m"] = round(sum(w) / len(w), 2) if w else None
        out.append(row)
    return sorted(out, key=lambda r: (-r["count"], r["kind"]))


def wants_across(data_dir):
    """Every want in every saved design. A want in a variant the owner has not opened is
    still a want, and the whole point of a work queue is that nobody has to
    remember which file asked for what."""
    files = []
    live = os.path.join(data_dir, "design.json")
    if os.path.exists(live):
        files.append(live)
    designs = os.path.join(data_dir, "designs")
    if os.path.isdir(designs):
        files += sorted(os.path.join(designs, f) for f in os.listdir(designs)
                        if f.endswith(".json"))
    merged = {}
    for f in files:
        try:
            with open(f) as fh:
                d = json.load(fh)
        except (OSError, ValueError):
            continue
        for row in wants(d):
            m = merged.setdefault(row["kind"], {"kind": row["kind"], "count": 0,
                                                "designs": [], "height_m": None,
                                                "width_m": None})
            m["count"] += row["count"]
            m["designs"].append(os.path.relpath(f, ROOT))
            for k in ("height_m", "width_m"):
                if m[k] is None:
                    m[k] = row[k]
    return sorted(merged.values(), key=lambda r: (-r["count"], r["kind"]))
