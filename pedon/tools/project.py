"""Which project is open, and where its files are — the ONE owner.

Every tool finds a site's files through this module, never by joining the checkout root to
"data" — a literal join reads the wrong site. There are three places (schema/project_layout.json):
the APP — this checkout: code, tools, skills, no assets; the user's LIBRARY — every asset made or
fetched along the way, shared by all their projects, ~/PEDON/library unless $PEDON_LIBRARY says
otherwise; and PROJECTS — one folder per site, <projects>/<slug>/, ~/PEDON unless $PEDON_PROJECTS
says otherwise. `data/...` is a VIRTUAL path: the library's names (the plant catalogue, reference
photos, caches) resolve to the library, and every other name — the site, the designs, their
history, the capture — to the active project; `assets/...` is the library's too.

The active project: $PEDON_PROJECT (a slug in the projects folder, or a folder), else the slug
in <projects>/.active (what the viewer's project switcher writes), else the checkout's own data/
— the single-site layout, so a checkout that never made a project still has one site.

Resolved on every call, never cached at import: the viewer's dev server and the MCP server
live across a project switch, and a path frozen at import would write one project's design
into another's folder.
"""
from __future__ import annotations
import datetime as _dt
import json
import os
import re
import sys

def _checkout():
    """The checkout this run belongs to: the one holding the TOOL BEING RUN, when that is a
    tools/ script, else this file's. They are the same folder in any real checkout. They
    differ in the tests' sandboxes — a folder of symlinked tools IS an empty checkout, the
    convention several suites are built on, and python imports this module from the
    symlinks' REAL folder (it resolves a script's directory), which would hand a sandboxed
    tool the owner's data."""
    entry = sys.argv[0] if sys.argv and sys.argv[0] not in ("", "-c", "-m") else ""
    tools = os.path.dirname(os.path.abspath(entry)) if entry else ""
    if tools and os.path.basename(tools) == "tools" and os.path.exists(os.path.join(tools, "project.py")):
        return os.path.dirname(tools)
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


ROOT = _checkout()
with open(os.path.join(ROOT, "schema", "project_layout.json")) as _f:
    LAYOUT = json.load(_f)
LIBRARY_NAMES = frozenset(LAYOUT["library"])      # data/<name> that is the library's
LIBRARY_ROOTS = frozenset(LAYOUT["library_roots"])  # <root>/... that is the library's (assets/)


def _home_path(env, default):
    return os.path.abspath(os.path.expanduser((os.environ.get(env) or "").strip() or default))


def _library_root():
    """The user's LIBRARY: every asset made or fetched along the way — plant and object models,
    textures, reference photos, the plant catalogue — shared by all their projects and never part
    of the app. $PEDON_LIBRARY, else ~/PEDON/library."""
    return _home_path(LAYOUT["library_env"], LAYOUT["library_dir"])


LIBRARY = _library_root()


def library(*parts):
    """A path inside the library."""
    return os.path.join(LIBRARY, *parts)


def _blender():
    """The Blender to run: $PEDON_BLENDER (or the older $YARDTWIN_BLENDER), else `blender` on the
    PATH, else the macOS app. One setting for every tool that renders or makes a model."""
    import shutil
    return ((os.environ.get("PEDON_BLENDER") or os.environ.get("YARDTWIN_BLENDER") or "").strip()
            or shutil.which("blender") or "/Applications/Blender.app/Contents/MacOS/Blender")


BLENDER = _blender()


def _projects_root():
    """Where sites live: $PEDON_PROJECTS, else ~/PEDON — OUTSIDE the checkout, so the
    source never holds a site, and a site survives a fresh clone or a branch switch."""
    return _home_path(LAYOUT["projects_env"], LAYOUT["projects_dir"])


PROJECTS = _projects_root()
ACTIVE_FILE = os.path.join(PROJECTS, LAYOUT["active_file"])
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")

# The smallest design the schema accepts: what a new project starts from.
EMPTY_DESIGN = {"version": 1, "units": "meters", "beds": [], "paths": [], "patios": [],
                "plants": [], "edges": [], "steps": [], "objects": []}


def active():
    """The active project's slug (or folder, from the env), or None for the single-site layout."""
    env = (os.environ.get(LAYOUT["env"]) or "").strip()
    if env:
        return env
    try:
        with open(ACTIVE_FILE) as f:
            slug = f.read().strip()
    except OSError:
        return None
    return slug or None


def folder(name=None):
    """The folder a project's own files live in."""
    name = active() if name is None else name
    if not name:
        return os.path.join(ROOT, "data")
    if os.path.isabs(name):
        return name
    if not SLUG.match(name):
        raise ValueError(f"not a project name: {name!r} (lower-case letters, digits and hyphens)")
    return os.path.join(PROJECTS, name)


def data(*parts):
    """The real path of `data/<parts>`: a library name in the library, anything else in the
    active project."""
    if not parts:
        return folder()
    if parts[0] in LIBRARY_NAMES:
        return library(*parts)
    return os.path.join(folder(), *parts)


def resolve(p):
    """A path a person or a model wrote — "data/designs/x.json", "assets/objects/x.glb",
    "review/…", "tools/…", or absolute — as a real path. `data/…` goes through data();
    `assets/…` is the library's; `review/…` is the active project's; anything else is the app's."""
    if not p:
        return p
    if os.path.isabs(p):
        return p
    parts = os.path.normpath(p).split(os.sep)
    if parts[0] == "data":
        return data(*parts[1:])
    if parts[0] in LIBRARY_ROOTS:
        return library(*parts)                      # assets/... — the library's, wherever it is
    if parts[0] == "review" and active():
        return os.path.join(folder(), *parts)       # what was drawn and looked at for ITS designs
    return os.path.join(ROOT, p)


def policy(name=None):
    """What this SITE asks of its planting — `project.json`'s "policy", e.g. {"cats_have_access":
    true}: the project's, never the library's. In the shared plant catalogue, one garden's cats
    would exclude lavender from every site that uses the library.
    Empty when the site states none."""
    try:
        with open(os.path.join(folder(name), "project.json")) as f:
            return dict(json.load(f).get("policy") or {})
    except (OSError, ValueError, AttributeError, TypeError):
        return {}


def slugify(name):
    s = re.sub(r"[^a-z0-9]+", "-", str(name).lower()).strip("-")[:48].strip("-")
    return s or "site"


def display_name(slug=None):
    """What a site is called on screen: the name given it, else its address, else its slug —
    the order the viewer's project window uses."""
    path = folder(slug)
    for fname, key in (("project.json", "name"), ("site.json", "address")):
        try:
            with open(os.path.join(path, fname)) as f:
                v = json.load(f).get(key)
            if v:
                return str(v)
        except (OSError, ValueError, AttributeError):
            pass
    return slug or "this site"


def is_project(path):
    """A site's folder: a project name, holding one of its files — not the library, not a backup
    folder beside the sites (which would otherwise list as a site)."""
    name = os.path.basename(os.path.normpath(path))
    return (bool(SLUG.match(name)) and os.path.isdir(path) and os.path.abspath(path) != LIBRARY
            and any(os.path.exists(os.path.join(path, m)) for m in LAYOUT["project_markers"]))


def listing():
    """Every project under projects/, with its display name; the single-site layout too, when
    the checkout's data/ holds a site of its own."""
    out = []
    if os.path.isdir(PROJECTS):
        for slug in sorted(os.listdir(PROJECTS)):
            path = os.path.join(PROJECTS, slug)
            if not is_project(path):
                continue
            out.append({"slug": slug, "name": display_name(slug),
                        "has_capture": bool(os.listdir(os.path.join(path, "captures")))
                        if os.path.isdir(os.path.join(path, "captures")) else False})
    return out


def create(name, units="metric"):
    """A new, empty project: its folder, project.json, an empty working design and an empty
    designs/ — nothing about any site. Returns its slug. Does NOT make it active."""
    base = slugify(name)
    slug, n = base, 2
    while os.path.exists(os.path.join(PROJECTS, slug)):
        slug, n = f"{base}-{n}", n + 1
    path = os.path.join(PROJECTS, slug)
    os.makedirs(os.path.join(path, "designs"))
    os.makedirs(os.path.join(path, "captures"))
    with open(os.path.join(path, "project.json"), "w") as f:
        json.dump({"name": str(name).strip() or slug, "units": units,
                   "created": _dt.date.today().isoformat()}, f, indent=1)
    with open(os.path.join(path, "design.json"), "w") as f:
        json.dump(EMPTY_DESIGN, f, indent=1)
    return slug


def activate(slug):
    """Make `slug` the active project (what the viewer's switcher does)."""
    if not SLUG.match(slug or "") or not os.path.isdir(os.path.join(PROJECTS, slug)):
        raise ValueError(f"no project called {slug!r} under projects/")
    os.makedirs(PROJECTS, exist_ok=True)
    tmp = ACTIVE_FILE + ".tmp"
    with open(tmp, "w") as f:
        f.write(slug + "\n")
    os.replace(tmp, ACTIVE_FILE)


TEST_SITE_FILE = os.path.join(PROJECTS, LAYOUT["test_site_file"])


def test_site():
    """The site the regression tests about a REAL site were written against, or None.

    Much of the suite checks the system on one real, measured site — its slopes, its walls,
    its saved designs — and that site is the owner's data, never the product's source. Named
    here, never guessed: $PEDON_TEST_SITE, else the slug in <projects>/.test_site (untracked,
    beside the sites). The suite PINS itself to it, so switching the viewer to another site
    does not change what the tests read; without one, those tests skip and the suite runs on
    an empty project, as a fresh checkout would."""
    name = (os.environ.get("PEDON_TEST_SITE") or "").strip()
    if not name:
        try:
            with open(TEST_SITE_FILE) as f:
                name = f.read().strip()
        except OSError:
            return None
    try:
        path = folder(name) if name else None
    except ValueError:
        return None
    return name if path and os.path.isfile(os.path.join(path, "site.json")) else None


# What a test reads of a real site — its ground truth, measured ground, calibration and
# designs — and nothing large (the capture, renders, exports, review folders).
SNAPSHOT = ("site.json", "design.json", "designs", "terrain_scan.json", "terrain.json",
            "calibration.json", "project.json", "site_api_calls.log")


def snapshot(name):
    """A throwaway COPY of a site's small files, for a test run to read.

    The owner uses the reference site in the viewer while tests run, so a suite reading it in
    place shares its files with the owner: a design the owner loads mid-run looks like a test's
    change, and the tripwire puts the old one back. So a test run never touches a real site at
    all."""
    import shutil
    import tempfile
    src = folder(name)
    dst = tempfile.mkdtemp(prefix="pedon-site-copy-")
    for part in SNAPSHOT:
        p = os.path.join(src, part)
        if os.path.isdir(p):
            shutil.copytree(p, os.path.join(dst, part))
        elif os.path.isfile(p):
            shutil.copy2(p, os.path.join(dst, part))
    return dst


def empty_project():
    """A throwaway project folder holding nothing but an empty design — a fresh site."""
    import tempfile
    path = tempfile.mkdtemp(prefix="pedon-empty-")
    os.makedirs(os.path.join(path, "designs"))
    with open(os.path.join(path, "design.json"), "w") as f:
        json.dump(EMPTY_DESIGN, f)
    return path


def fill_library(source=None):
    """Put the assets an app folder still holds into the library — for a checkout that keeps its
    assets beside the code. Files git tracks are COPIED (the app's history is not rewritten here); files it
    ignores — models, intermediates — are MOVED, since they were never the app's. Nothing already
    in the library is overwritten. Returns {"copied": n, "moved": n, "kept": n}."""
    import shutil
    import subprocess
    source = source or ROOT
    try:
        tracked = set(subprocess.run(["git", "ls-files", "-z"], cwd=source, capture_output=True,
                                     check=True).stdout.decode().split("\0"))
    except (OSError, subprocess.CalledProcessError):
        tracked = None                              # no git: copy everything, move nothing
    count = {"copied": 0, "moved": 0, "kept": 0}
    places = [(os.path.join("data", n), n) for n in sorted(LIBRARY_NAMES)] + [(r, r) for r in sorted(LIBRARY_ROOTS)]
    for rel_src, rel_dst in places:
        src = os.path.join(source, rel_src)
        files = ([src] if os.path.isfile(src) else
                 [os.path.join(d, f) for d, _, fs in os.walk(src) for f in fs] if os.path.isdir(src) else [])
        for f in files:
            rel = os.path.relpath(f, source)
            dst = library(rel_dst, os.path.relpath(f, src)) if os.path.isdir(src) else library(rel_dst)
            if os.path.exists(dst):
                count["kept"] += 1
                continue
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            if tracked is None or rel in tracked:
                shutil.copy2(f, dst); count["copied"] += 1
            else:
                shutil.move(f, dst); count["moved"] += 1
    return count


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description="PEDON projects: list, create, switch; the library.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    sub.add_parser("which")
    c = sub.add_parser("new")
    c.add_argument("name")
    c.add_argument("--open", action="store_true", help="also make it the active project")
    o = sub.add_parser("open")
    o.add_argument("slug")
    dm = sub.add_parser("demo", help="the demo garden: made by tools/demo_site.py, once")
    dm.add_argument("--open", action="store_true", help="also make it the active project")
    lib = sub.add_parser("library", help="where the library is; --fill puts an old checkout's assets in it")
    lib.add_argument("--fill", action="store_true")
    a = ap.parse_args(argv)
    if a.cmd == "list":
        print(json.dumps({"active": active(), "projects": listing()}, indent=1))
    elif a.cmd == "which":
        print(json.dumps({"active": active(), "folder": folder()}, indent=1))
    elif a.cmd == "new":
        slug = create(a.name)
        if a.open:
            activate(slug)
        print(json.dumps({"created": slug, "folder": folder(slug), "active": active()}, indent=1))
    elif a.cmd == "open":
        activate(a.slug)
        print(json.dumps({"active": a.slug, "folder": folder(a.slug)}, indent=1))
    elif a.cmd == "demo":
        import demo_site                          # beside this file: the demo is made by code
        slug = demo_site.create(open_it=a.open)
        print(json.dumps({"created": slug, "folder": folder(slug), "active": active()}, indent=1))
    elif a.cmd == "library":
        out = {"library": LIBRARY}
        if a.fill:
            out.update(fill_library())
        print(json.dumps(out, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
