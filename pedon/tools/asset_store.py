#!/usr/bin/env python3
"""OBJECT ASSETS ARE FILES, AND THE AGENT CAN FIND OR MAKE THEM.

The design agent must be able to find or create 3D assets without baking them into code.
`gen_object.py` writes a builder into `viewer/src/objects.js` from a CLI, while
`object.model` names a GLB in `assets/objects/` that loads without a manifest.

An object asset is a FILE and a CARD beside it, and three verbs reach it:

- **find** — this library, the built-in kinds, and Poly Haven's CC0 models (no key, real
  sizes, a picture of each). Its catalogue runs to hundreds of models, including
  plants and rocks, plus seating, lanterns and pots.
- **fetch** — a Poly Haven model into the library: downloaded, converted, its base set on
  the ground, licence and authors on the card.
- **make** — a model the agent writes as a Blender script, run headless in a SANDBOX: no
  network, and it may write only into its own work folder (it is code a model wrote).

Every fetched or made asset comes back with a rendered picture, so whoever asked can LOOK
at it before using it. A design uses one as `{"kind": <card.kind>, "model": <card.model>}`.

PLANTS TOO. Plants use hand-written viewer builders or generated GLBs, and the agent
can add models. Give fetch or make a `species` and the model goes
into the PLANT library instead (`assets/plants/<name>.glb`, an entry in its manifest with
species, source and picture), and a design uses it as `place_plants {..., "asset": <name>}` —
the viewer draws that model at the plant's mature height and spread, in place of the builder.
A generated library model (`tools/gen_trees.py` — its `source` says so) or a model with no
recorded source is never replaced this way.

    python3 tools/asset_store.py list
    python3 tools/asset_store.py find "stone lantern"
    python3 tools/asset_store.py fetch Lantern_01 --kind lantern
    python3 tools/asset_store.py make --name "cedar trellis" --script trellis.py --size 1.2,0.08,2.0
    python3 tools/asset_store.py find "flowering shrub" --plant
    python3 tools/asset_store.py make --name "sulfur buckwheat" --species "Eriogonum umbellatum" \
        --script buckwheat.py --size 0.9,0.9,0.3
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import project  # the active project's files — the ONE owner
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# THE USER'S LIBRARY, not the app: what is found, fetched or made belongs to them and every project
LIB = project.resolve("assets/objects")
PLANT_LIB = project.resolve("assets/plants")              # its manifest is what the viewer reads
# Poly Haven's categories that are a plant — "nature" alone is rocks and cliffs too
PLANT_CATEGORIES = {"plants", "trees", "flowers", "grass", "ground cover", "succulent", "potted plants"}
CACHE = project.data("cache")
BLENDER = project.BLENDER
PH_API = "https://api.polyhaven.com"
UA = "PEDON/1.0 (local landscape-design tool; CC0 asset lookup)"
MAX_TRIANGLES = 300_000        # a phone carries the design too; a cliff scan will not do
SIZE_TOLERANCE = 0.35          # a made asset must come out within 35% of the size asked for
BLENDER_TIMEOUT_S = 240


class AssetError(RuntimeError):
    """Something a caller should be told in words, with a picture when there is one."""
    def __init__(self, msg, preview=None):
        super().__init__(msg)
        self.preview = preview


def slugify(name):
    s = re.sub(r"[^a-z0-9]+", "-", str(name).lower()).strip("-")
    return s[:60] or "asset"


def _words(text):
    stop = {"a", "an", "the", "of", "for", "with", "and", "or", "to", "in", "on"}
    return [w for w in re.findall(r"[a-z0-9]+", str(text).lower()) if w not in stop]


def _get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# ── the library: a folder of GLBs and cards ─────────────────────────────────────

def library():
    """Every model a design can name, with its card. A GLB with no card is listed by its
    file name, so a scanned stone dropped in by hand is not invisible."""
    out = []
    if not os.path.isdir(LIB):
        return out
    for f in sorted(os.listdir(LIB)):
        if not f.lower().endswith(".glb"):
            continue
        slug = f[:-4]
        card_path = os.path.join(LIB, slug + ".json")
        card = {}
        if os.path.isfile(card_path):
            try:
                card = json.load(open(card_path))
            except ValueError:
                card = {}
        card.setdefault("name", slug.replace("-", " "))
        card.setdefault("kind", slug.replace("-", "_"))
        card["model"] = f"assets/objects/{f}"
        out.append(card)
    return out


def plant_library():
    """The plant models a design can name as `asset`: the manifest the viewer loads."""
    try:
        return json.load(open(os.path.join(PLANT_LIB, "manifest.json")))
    except (OSError, ValueError):
        return {}


def _score(words, name, tags=(), cats=()):
    """How well a model answers the query: the number of the query's words it answers,
    first — "garden bench" wants a bench before it wants garden gloves — then where they
    appear (name 3, tag 2, category 1)."""
    name_w, tag_w, cat_w = set(_words(name)), set(_words(" ".join(tags))), set(_words(" ".join(cats)))
    s, hit = 0, 0
    for i, w in enumerate(words):
        here = 3 if w in name_w else 2 if w in tag_w else 1 if w in cat_w else 0
        here += 1 if any(t.startswith(w) and t != w for t in name_w | tag_w) else 0
        # the LAST word names the thing ("garden BENCH", "stone LANTERN"); the rest qualify it
        s += here * (2 if i == len(words) - 1 else 1)
        hit += 1 if here else 0
    return hit * 10 + s if s else 0


def polyhaven_catalog(max_age_s=7 * 86400):
    """Poly Haven's model list, cached for a week: one request serves every search."""
    path = os.path.join(CACHE, "polyhaven_models.json")
    if os.path.isfile(path) and time.time() - os.path.getmtime(path) < max_age_s:
        return json.load(open(path))
    data = json.loads(_get(f"{PH_API}/assets?t=models"))
    os.makedirs(CACHE, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f)
    return data


def find(query, limit=8, catalog=None, plant=False):
    """What there is for `query`: in this library, as a built-in kind, and on Poly Haven.
    `plant` searches the plant library and Poly Haven's plants instead."""
    words = _words(query)
    if not words:
        raise AssetError("say what you are looking for, e.g. 'stone lantern'")
    if plant:
        lib = [{"name": k, "asset": k, "species": v.get("species"), "size_m": [v.get("spread_m"), v.get("height_m")],
                "score": _score(words, k.replace("_", " "), [v.get("species") or "", v.get("form") or ""])}
               for k, v in plant_library().items()]
    else:
        lib = [dict(c, score=_score(words, c.get("name", ""), [c.get("kind", "")] + c.get("aliases", [])))
               for c in library()]
    lib = sorted([c for c in lib if c["score"]], key=lambda c: -c["score"])[:limit]
    sys.path.insert(0, os.path.join(ROOT, "tools"))
    import objects_index                       # the ONE reader of BUILDERS/ALIASES
    online, note, cat = [], None, None
    try:
        builtins = [] if plant else [k for k in objects_index.known_kinds() if _score(words, k.replace("_", " "))]
    except objects_index.NoViewer as e:        # a checkout with no viewer has no built-in kinds
        builtins, note = [], str(e)
    try:
        cat = catalog if catalog is not None else polyhaven_catalog()
        for pid, a in cat.items():
            if plant and not PLANT_CATEGORIES & set(a.get("categories") or []):
                continue
            s = _score(words, a.get("name", pid), a.get("tags", []), a.get("categories", []))
            if s:
                dims = a.get("dimensions") or []
                online.append({"id": pid, "name": a.get("name", pid), "score": s,
                               "size_m": [round(d / 1000, 2) for d in dims[:3]] if dims else None,
                               "triangles": a.get("polycount"), "categories": a.get("categories", [])[:4],
                               "thumbnail": a.get("thumbnail_url"), "url": f"https://polyhaven.com/a/{pid}",
                               "too_heavy": (a.get("polycount") or 0) > MAX_TRIANGLES})
        online.sort(key=lambda c: (-c["score"], c["too_heavy"], c["triangles"] or 0))
        online = online[:limit]
    except Exception as e:                     # offline is an answer, not a crash
        off = f"Poly Haven could not be reached ({type(e).__name__}); only the library was searched"
        note = f"{note}; {off}" if note else off
    # NOTHING TO SEARCH is a failure, not an empty answer: no library, no viewer, no network
    if not (plant_library() if plant else library()) and cat is None and not builtins and note:
        raise AssetError(f"there was nothing to search — {note}")
    # DOES ANYTHING ACTUALLY ANSWER IT? "stone birdbath" can match stones and coffee tables:
    # a match on the qualifier is not the thing. Said outright, so the next step is make.
    head = words[-1]

    def names_it(*texts):
        return head in _words(" ".join(" ".join(t) if isinstance(t, (list, tuple)) else str(t) for t in texts))
    has_head = (any(names_it(c.get("name", ""), c.get("kind", ""), c.get("species") or "") for c in lib)
                or any(names_it(k.replace("_", " ")) for k in builtins)
                or any(names_it(c["name"], (cat or {}).get(c["id"], {}).get("tags", [])) for c in online))
    if not has_head:
        miss = f"nothing here is a '{head}' — the matches share a word, not the thing. make_asset it"
        note = f"{note}; {miss}" if note else miss
    return {"query": query, "library": lib, "builtin_kinds": builtins, "polyhaven": online,
            **({"note": note} if note else {})}


# ── Blender, sandboxed ──────────────────────────────────────────────────────────

# The half every asset shares, fetched or made: whatever meshes the scene holds become ONE
# model standing on the ground at the origin, exported as GLB, counted, and photographed.
FINISH = r'''
import bpy, json, math, os, sys
from mathutils import Vector
def finish(work, slug):
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        raise SystemExit("ASSET_ERROR the script made no mesh")
    for o in bpy.context.scene.objects:
        o.select_set(o.type == "MESH")
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    dg = bpy.context.evaluated_depsgraph_get()
    lo, hi, tris = Vector((1e9,) * 3), Vector((-1e9,) * 3), 0
    for o in meshes:
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        me.calc_loop_triangles()
        tris += len(me.loop_triangles)
        for v in me.vertices:
            w = o.matrix_world @ v.co
            lo = Vector(map(min, lo, w)); hi = Vector(map(max, hi, w))
        ev.to_mesh_clear()
    # ON THE GROUND AT THE ORIGIN: centred across, its lowest point at z = 0 — the viewer
    # sets a model on its own base and scales it by height (assets.js buildAssetObject)
    shift = Vector((-(lo.x + hi.x) / 2, -(lo.y + hi.y) / 2, -lo.z))
    for o in bpy.context.scene.objects:
        if o.parent is None and o.type in ("MESH", "EMPTY"):
            o.location += shift
    size = [round(hi.x - lo.x, 3), round(hi.y - lo.y, 3), round(hi.z - lo.z, 3)]
    bpy.ops.export_scene.gltf(filepath=os.path.join(work, slug + ".glb"), export_format="GLB",
                              use_selection=False, export_apply=True)
    # A PICTURE, so the asker can look before using it: three-quarter view, even light.
    # The quick renderer shows a material's DISPLAY colour where it has no image, and a
    # script sets the shading colour. Copy it to the display colour so the preview
    # matches the GLB; the export has already been written.
    for m in bpy.data.materials:
        b = m.node_tree.nodes.get("Principled BSDF") if m.use_nodes and m.node_tree else None
        if b and not b.inputs["Base Color"].is_linked:
            m.diffuse_color = b.inputs["Base Color"].default_value
    scn = bpy.context.scene
    scn.render.engine = "BLENDER_WORKBENCH"
    scn.display.shading.light = "STUDIO"
    scn.display.shading.color_type = "TEXTURE"
    scn.render.resolution_x = scn.render.resolution_y = 512
    scn.render.film_transparent = False
    world = scn.world or bpy.data.worlds.new("w"); scn.world = world
    world.color = (0.32, 0.33, 0.30)
    r = max(size) or 1.0
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    scn.collection.objects.link(cam); scn.camera = cam
    cam.data.lens = 50
    centre = Vector((0, 0, size[2] / 2))
    cam.location = centre + Vector((1.0, -1.6, 0.9)).normalized() * r * 2.1
    cam.rotation_euler = (centre - cam.location).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = os.path.join(work, slug + ".png")
    bpy.ops.render.render(write_still=True)
    print("ASSET_STATS " + json.dumps({"size_m": size, "triangles": tris}))
'''

IMPORT_GLTF = FINISH + r'''
argv = sys.argv[sys.argv.index("--") + 1:]
src, work, slug = argv
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
finish(work, slug)
'''

RUN_SCRIPT = FINISH + r'''
import bmesh, mathutils
argv = sys.argv[sys.argv.index("--") + 1:]
script, work, slug = argv
bpy.ops.wm.read_factory_settings(use_empty=True)
ns = {"bpy": bpy, "bmesh": bmesh, "mathutils": mathutils, "math": math, "__name__": "__asset__"}
exec(compile(open(script).read(), "asset_script.py", "exec"), ns)
finish(work, slug)
'''


def _sandbox_profile(work):
    """No network; writes only into `work` and the system temp folders Blender needs."""
    def conf(k):
        try:
            return subprocess.run(["getconf", k], capture_output=True, text=True).stdout.strip().rstrip("/")
        except OSError:
            return ""
    # REAL paths: /var is a link to /private/var, the sandbox matches the real one, and
    # Blender's own tempfile needs a folder it is allowed to write
    paths = [os.path.realpath(p) for p in (work, conf("DARWIN_USER_TEMP_DIR"), conf("DARWIN_USER_CACHE_DIR")) if p]
    allowed = " ".join(f'(subpath "{p}")' for p in paths)
    return ("(version 1)(allow default)(deny network*)(deny file-write*)"
            f'(allow file-write* {allowed} (literal "/dev/null") (literal "/dev/dtracehelper"))')


def _blender(script_text, args, work, sandboxed=True):
    if not os.path.isfile(BLENDER):
        raise AssetError(f"Blender is not at {BLENDER} (it is a .app, not on $PATH)")
    runner = os.path.join(work, "_runner.py")
    with open(runner, "w") as f:
        f.write(script_text)
    cmd = [BLENDER, "-b", "--factory-startup", "--python-exit-code", "1", "--python", runner, "--", *args]
    if sandboxed:
        cmd = ["sandbox-exec", "-p", _sandbox_profile(work), *cmd]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=BLENDER_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        raise AssetError(f"Blender ran past {BLENDER_TIMEOUT_S} s and was stopped")
    stats = next((json.loads(l.split(" ", 1)[1]) for l in r.stdout.splitlines() if l.startswith("ASSET_STATS ")), None)
    said = next((l.split(" ", 1)[1] for l in r.stdout.splitlines() if l.startswith("ASSET_ERROR ")), None)
    if r.returncode != 0 or not stats:
        tail = "\n".join((r.stderr or r.stdout).strip().splitlines()[-12:])
        raise AssetError(said or f"Blender failed:\n{tail}")
    return stats


def _store(work, slug, card, replace=False):
    """Move the finished model, its picture (and script) into the library, then write the card."""
    os.makedirs(LIB, exist_ok=True)
    dst = os.path.join(LIB, slug + ".glb")
    if os.path.exists(dst) and not replace:
        raise AssetError(f"assets/objects/{slug}.glb exists — choose another name, or replace it")
    for ext in (".glb", ".png", ".py"):
        src = os.path.join(work, slug + ext)
        if os.path.isfile(src):
            shutil.copyfile(src, os.path.join(LIB, slug + ext))
    card = {**card, "model": f"assets/objects/{slug}.glb", "preview": f"assets/objects/{slug}.png",
            "made_ms": int(time.time() * 1000)}
    with open(os.path.join(LIB, slug + ".json"), "w") as f:
        json.dump(card, f, indent=1)
    return card


def _generated(entry):
    """A protected library model: its source names tools/gen_trees.py or is unrecorded
    (docs/library.md). Never replaced by a fetched or made model."""
    src = entry.get("source")
    return not src or (isinstance(src, dict) and src.get("from") == "generated")


def _store_plant(work, slug, species, stats, source, replace=False):
    """Move a finished PLANT model into the plant library and give it a manifest entry —
    the one record the viewer reads to know a model exists (assets.js manifestOnce)."""
    man_path = os.path.join(PLANT_LIB, "manifest.json")
    man = plant_library()
    if slug in man and _generated(man[slug]):
        raise AssetError(f"'{slug}' is a generated library model (tools/gen_trees.py) — choose another name")
    if slug in man and not replace:
        raise AssetError(f"assets/plants/{slug}.glb exists — choose another name, or replace it")
    os.makedirs(PLANT_LIB, exist_ok=True)
    for ext in (".glb", ".png", ".py"):
        src = os.path.join(work, slug + ext)
        if os.path.isfile(src):
            shutil.copyfile(src, os.path.join(PLANT_LIB, slug + ext))
    w, d, h = stats["size_m"]
    entry = {"name": slug, "file": f"assets/plants/{slug}.glb", "base_m": 0.0,
             "height_m": h, "spread_m": round(max(w, d), 3), "tris": stats["triangles"],
             "kb": round(os.path.getsize(os.path.join(PLANT_LIB, slug + ".glb")) / 1024, 1),
             "species": species, "preview": f"assets/plants/{slug}.png", "source": source,
             "made_ms": int(time.time() * 1000)}
    man = plant_library()                      # re-read: gen_trees may have written meanwhile
    man[slug] = entry
    with open(man_path, "w") as f:
        json.dump(man, f, indent=2, sort_keys=True)   # gen_trees.py's format, so diffs stay small
    return {**entry, "asset": slug}


def fetch(pid, name=None, kind=None, resolution="1k", replace=False, species=None):
    """A Poly Haven model into the library, standing on the ground, licence on the card."""
    files = json.loads(_get(f"{PH_API}/files/{pid}"))
    info = json.loads(_get(f"{PH_API}/info/{pid}"))
    if (info.get("polycount") or 0) > MAX_TRIANGLES:
        raise AssetError(f"{pid} is {info['polycount']:,} triangles — over the {MAX_TRIANGLES:,} a phone can carry")
    gl = (files.get("gltf") or {}).get(resolution, {}).get("gltf")
    if not gl:
        raise AssetError(f"{pid} has no {resolution} glTF on Poly Haven")
    slug = slugify(name or info.get("name") or pid)
    with tempfile.TemporaryDirectory(prefix="pedon_asset_") as work:
        src_dir = os.path.join(work, "src")
        os.makedirs(src_dir)
        main = os.path.join(src_dir, os.path.basename(gl["url"]))
        with open(main, "wb") as f:
            f.write(_get(gl["url"]))
        for rel, inc in (gl.get("include") or {}).items():
            # the file's own relative path, never one that climbs out of the folder
            if rel.startswith("/") or ".." in rel.split("/"):
                continue
            p = os.path.join(src_dir, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "wb") as f:
                f.write(_get(inc["url"], timeout=60))
        stats = _blender(IMPORT_GLTF, [main, work, slug], work)
        source = {"from": "polyhaven", "id": pid, "url": f"https://polyhaven.com/a/{pid}",
                  "license": "CC0", "authors": sorted((info.get("authors") or {}).keys())}
        if species:
            return _store_plant(work, slug, species, stats, source, replace)
        return _store(work, slug, {
            "name": name or info.get("name", pid), "kind": kind or slug.replace("-", "_"),
            "size_m": stats["size_m"], "triangles": stats["triangles"], "source": source}, replace)


def make(name, script, size_m=None, kind=None, replace=False, species=None):
    """A model from a Blender script the agent wrote, run sandboxed, checked for size."""
    slug = slugify(name)
    with tempfile.TemporaryDirectory(prefix="pedon_asset_") as work:
        sp = os.path.join(work, slug + ".py")
        with open(sp, "w") as f:
            f.write(script)
        stats = _blender(RUN_SCRIPT, [sp, work, slug], work)
        preview = os.path.join(work, slug + ".png")
        keep = os.path.join(tempfile.gettempdir(), f"pedon_{slug}_rejected.png")
        if stats["triangles"] > MAX_TRIANGLES:
            shutil.copyfile(preview, keep)
            raise AssetError(f"{stats['triangles']:,} triangles — over {MAX_TRIANGLES:,}; simplify it", keep)
        if size_m:
            off = [(got, want) for got, want in zip(stats["size_m"], size_m)
                   if want and abs(got / want - 1) > SIZE_TOLERANCE]
            if off:
                shutil.copyfile(preview, keep)
                raise AssetError(f"it came out {stats['size_m']} m (w, d, h) against the {list(size_m)} asked — "
                                 "Blender is in metres; fix the script", keep)
        sha = hashlib.sha1(script.encode()).hexdigest()[:12]
        if species:
            return _store_plant(work, slug, species, stats,
                                {"from": "made", "script": f"assets/plants/{slug}.py", "sha1": sha}, replace)
        return _store(work, slug, {
            "name": name, "kind": kind or slug.replace("-", "_"), "size_m": stats["size_m"],
            "triangles": stats["triangles"],
            "source": {"from": "made", "script": f"assets/objects/{slug}.py", "sha1": sha}}, replace)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    f = sub.add_parser("find"); f.add_argument("query"); f.add_argument("--plant", action="store_true")
    g = sub.add_parser("fetch"); g.add_argument("id"); g.add_argument("--name"); g.add_argument("--kind")
    g.add_argument("--species", help="a PLANT model, for this species"); g.add_argument("--replace", action="store_true")
    m = sub.add_parser("make"); m.add_argument("--name", required=True); m.add_argument("--script", required=True)
    m.add_argument("--size", help="w,d,h in metres"); m.add_argument("--kind")
    m.add_argument("--species", help="a PLANT model, for this species"); m.add_argument("--replace", action="store_true")
    a = ap.parse_args(argv)
    try:
        if a.cmd == "list":
            out = library()
        elif a.cmd == "find":
            out = find(a.query, plant=a.plant)
        elif a.cmd == "fetch":
            out = fetch(a.id, a.name, a.kind, replace=a.replace, species=a.species)
        else:
            size = [float(x) for x in a.size.split(",")] if a.size else None
            out = make(a.name, open(a.script).read(), size, a.kind, replace=a.replace, species=a.species)
    except AssetError as e:
        print(json.dumps({"error": str(e), **({"preview": e.preview} if e.preview else {})}, indent=1))
        return 2
    print(json.dumps(out, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
