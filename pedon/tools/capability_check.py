"""Find capabilities that exist in the code but are invisible to a new session.

Why this exists
---------------
This project grows by accretion: a limitation gets hit, the cause gets measured,
a tool gets built to remove it. That only compounds if the NEXT session can find
the tool. A tool that is built, tested and shipped but named nowhere a fresh
session reads is never called: a cold-started session proposes doing by hand the
exact thing the tool already does.

Documentation drift is not a discipline problem, it is a detection problem. This
scans what actually exists — tool scripts, their subcommands, and standalone
viewer pages — and reports anything a new session could not discover from
CLAUDE.md. Run it after adding a capability; it is fast and has no dependencies.

It is deliberately narrow. Buttons, endpoints and minor flags are self-revealing
to anyone already looking at the UI or the code; what is genuinely invisible is
that a script or a subcommand exists at all.

    python3 tools/capability_check.py           # report
    python3 tools/capability_check.py --strict  # exit 1 if anything is undocumented
"""
from __future__ import annotations
import argparse
import ast
import json
import glob
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# THE MAP IS A SET OF FILES, not one file. `AGENTS.md` one level up is the entry
# point every tool reads (Claude Code reaches it through CLAUDE.md's import), and
# it indexes the topic docs rather than repeating them — so "discoverable" means
# "reachable from the entry point", which is this whole set.
#
# Local work logs are deliberately NOT in it. They mention every tool this project
# has ever had, so including them would make this check pass by accident for
# anything — which is the opposite of what it is for.
def _doc_set():
    up = os.path.dirname(ROOT)
    paths = [os.path.join(up, "AGENTS.md"), os.path.join(up, "README.md")]
    paths += sorted(glob.glob(os.path.join(ROOT, "docs", "*.md")))
    paths += [os.path.join(ROOT, n) for n in
              ("DESIGNING.md", "EXTENSIONS.md", "ASSET_FIDELITY.md")]
    return [p for p in paths if os.path.exists(p)]

DOCS = _doc_set()
DOC = DOCS[0] if DOCS else os.path.join(os.path.dirname(ROOT), "AGENTS.md")

# Things that are deliberately internal, or documented under another name.
EXEMPT = {
    # agent.py's model-facing tool names live in its own SYSTEM prompt; the
    # audience there is the spawned model, not a future session
    "set_path", "upsert_bed", "set_patio", "set_edge", "place_plants", "remove_objects",
}


def argparse_subcommands(path):
    """Subcommand names from `sub.add_parser("name", ...)` without importing."""
    try:
        tree = ast.parse(open(path).read())
    except SyntaxError:
        return []
    out = []
    for node in ast.walk(tree):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "add_parser" and node.args
                and isinstance(node.args[0], ast.Constant)):
            out.append(node.args[0].value)
    return out


def collect():
    """
    Capabilities a new session could NOT find by looking.

    Deliberately narrow. A noisy check gets ignored, and most of what a codebase
    exposes is self-revealing: viewer buttons are visible in the UI, an endpoint
    is visible to the code that calls it, and a flag is one --help away ONCE you
    know the script exists. What is genuinely invisible is the existence of a
    script, and the existence of a subcommand on a script nobody told you to run.
    So: every tool script must be named in CLAUDE.md, every subcommand must be
    named or its script must be shown with a pointer to --help, and every
    standalone viewer page must be named.
    """
    caps = []

    for fn in sorted(os.listdir(os.path.join(ROOT, "tools"))):
        if not fn.endswith(".py") or fn == "capability_check.py":
            continue
        p = os.path.join(ROOT, "tools", fn)
        caps.append({"kind": "script", "name": f"tools/{fn}", "token": fn})
        for sc in argparse_subcommands(p):
            caps.append({"kind": f"{fn} subcommand", "name": f"{fn} {sc}", "token": sc})

    for fn in sorted(os.listdir(os.path.join(ROOT, "viewer"))):
        if fn.endswith(".html") and fn != "index.html":
            caps.append({"kind": "viewer page", "name": f"viewer/{fn}", "token": fn})

    seen, out = set(), []
    for c in caps:
        if c["token"] in seen or c["token"] in EXEMPT:
            continue
        seen.add(c["token"])
        out.append(c)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--strict", action="store_true",
                    help="exit 1 when something is undocumented (for a pre-commit hook)")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    if not DOCS:
        print(f"AGENTS.md not found at {DOC} — a new session has no orientation at all")
        sys.exit(1)
    doc = "\n".join(open(p).read() for p in DOCS)

    caps = collect()
    missing = [c for c in caps if c["token"] not in doc]

    if a.json:
        print(json.dumps({"documented": len(caps) - len(missing), "total": len(caps),
                          "missing": missing}, indent=1))
    else:
        print(f"{len(caps) - len(missing)}/{len(caps)} capabilities are discoverable "
              f"from AGENTS.md and the {len(DOCS) - 1} docs it indexes\n")
        if missing:
            print("NOT discoverable by a new session:")
            by_kind = {}
            for m in missing:
                by_kind.setdefault(m["kind"], []).append(m["name"])
            for kind, names in sorted(by_kind.items()):
                print(f"  {kind}:")
                for n in sorted(names):
                    print(f"    - {n}")
            print("\nAdd them to the right doc under pedon/docs/ (AGENTS.md indexes\n"
                  "them), or to EXEMPT here if they are genuinely internal.")
        else:
            print("Everything a new session needs is reachable from AGENTS.md.")

    sys.exit(1 if (a.strict and missing) else 0)


if __name__ == "__main__":
    main()
