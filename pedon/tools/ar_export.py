#!/usr/bin/env python3
"""SEE THE DESIGN ON SITE, AT 1:1 — a USDZ for the native PEDON app.

The user needs the PEDON app to show the design's plants and hardscape at 1:1 on site.

**WHAT GOES IN** must keep the planting visible. In RealityKit — the native app’s renderer — a whole-site scan draws as a flat grey shell over the design, hiding
planting represented by 3.5 cm rings. The export therefore contains:

- **The plants, as pictures of themselves.** Each species is built once at full detail
  in the viewer and photographed from the side and from above; every plant is three
  crossed cards of that picture at its mature size (`viewer/src/ar_cards.js`). Real
  foliage for a garden runs to gigabytes, and even Fast preview to millions of triangles.
- **The hardscape as drawn** — beds, paths, walls, steps, objects.
- **The owner's landmarks, not the scan.** A post and their name for it at each.
  Landmarks provide alignment references; the scan is a second copy of what the
  camera already shows, drawn OVER the garden.

**WHERE IT LANDS.** The app matches two points on the original scan to the same points
on real ground, solving a turn and translation at scale 1. The origin stays near the
planting; the design and the separate textured scan use the same frame.

**The geometry comes from the VIEWER**, through `export_scene`, because
only the viewer knows the ground under each object and which model a species routes to.

    python3 tools/ar_export.py       # the design on screen -> data/ar/yard.usdz
"""
import argparse
import json
import hashlib
import zipfile
import os
import project  # the active project's files — the ONE owner
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import broker  # the ONE render-broker client (tests/test_dry.py)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = project.data("ar")
OUT_NAME = "yard.usdz"
BLENDER = project.BLENDER             # $PEDON_BLENDER, `blender` on the PATH, or the macOS app

# Names ar_cards.js gives what must never be decimated: a card is two triangles, and a
# landmark ring decimated to 35% is a polygon. As USD prim names, ':' and '-' become '_'.
KEEP_WHOLE = ("plant-card", "ar-landmark")
# alpha cut-out for the pictures: RealityKit honours UsdPreviewSurface.opacityThreshold
ALPHA_CUT = 0.5

CONVERT = r'''
import bpy, json, os, re, sys, tempfile, shutil
from pxr import Usd, UsdGeom, UsdShade, UsdUtils, Sdf
argv = sys.argv[sys.argv.index("--") + 1:]
src, dst, ratio, cut = argv[0], argv[1], float(argv[2]), float(argv[3])
keep = tuple(KEEP_WHOLE_PY)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)

# DECIMATE THE HARDSCAPE ONLY, as a modifier: beds are draped far finer than a phone needs.
# WELD FIRST. The viewer's drapes arrive as triangles that share no vertex, and a collapse
# cannot collapse an edge nobody else holds: it drops faces but leaves every vertex
# behind — 1,021,915 points for 160,224 triangles can occupy 22 MB of a 33 MB file.
import bmesh
if ratio < 0.999:
    for o in bpy.data.objects:
        if o.type == "MESH" and not o.name.startswith(keep) and len(o.data.polygons) > 200:
            bm = bmesh.new()
            bm.from_mesh(o.data)
            bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0005)
            bm.to_mesh(o.data)
            bm.free()
            o.modifiers.new("dec", "DECIMATE").ratio = ratio

# COUNT THE EVALUATED MESH, not the base one: a decimate modifier does not touch o.data,
# and a count taken there contradicts the file size printed beside it.
dg = bpy.context.evaluated_depsgraph_get()
tris = cards = points = 0
for o in bpy.data.objects:
    if o.type != "MESH":
        continue
    ev = o.evaluated_get(dg)
    me = ev.to_mesh()
    me.calc_loop_triangles()
    tris += len(me.loop_triangles)
    points += len(me.vertices)
    cards += len(me.loop_triangles) if o.name.startswith("plant-card") else 0
    ev.to_mesh_clear()

# METRES, EXPLICITLY. A model at the wrong scale looks plausible and is silently a
# different garden, and 1:1 is the whole requirement.
work = tempfile.mkdtemp(prefix="ar_usd_")
usdc = os.path.join(work, "yard.usdc")
bpy.ops.wm.usd_export(filepath=usdc, convert_scene_units="METERS", export_textures_mode="NEW",
                      export_lights=False, export_cameras=False)

# WHAT BLENDER DOES NOT WRITE, written here and checked by counting. A picture card is a
# cut-out: its alpha must drive opacity with a threshold, or RealityKit draws the
# transparent corners of every card as a pale box. And no face is double-sided — the
# cards and labels carry their own back faces, and a double-sided front would fight them.
st = Usd.Stage.Open(usdc)
cutouts = 0
for prim in st.Traverse():
    if prim.IsA(UsdGeom.Mesh):
        UsdGeom.Mesh(prim).CreateDoubleSidedAttr().Set(False)
    if not prim.IsA(UsdShade.Material):
        continue
    if not re.sub(r"[^a-z]", "", prim.GetName().lower()).startswith(("plantcard", "arlandmarklabel")):
        continue
    for sh in Usd.PrimRange(prim):
        shader = UsdShade.Shader(sh)
        if not shader or shader.GetIdAttr().Get() != "UsdPreviewSurface":
            continue
        colour = shader.GetInput("diffuseColor")
        srcs = colour.GetConnectedSources()[0] if colour else []
        if not srcs:
            continue
        texture = UsdShade.Shader(srcs[0].source.GetPrim())
        texture.CreateOutput("a", Sdf.ValueTypeNames.Float)
        opacity = shader.CreateInput("opacity", Sdf.ValueTypeNames.Float)
        opacity.ConnectToSource(texture.ConnectableAPI(), "a")
        shader.CreateInput("opacityThreshold", Sdf.ValueTypeNames.Float).Set(cut)
        cutouts += 1
st.Save()
# the ARKit packager, not a plain zip: it lays the files out the way RealityKit reads them
if not UsdUtils.CreateNewARKitUsdzPackage(Sdf.AssetPath(usdc), dst):
    raise SystemExit("could not package the usdz")
shutil.rmtree(work, ignore_errors=True)
print("USDZ_STATS " + json.dumps({"triangles": tris, "points": points, "card_triangles": cards, "cutouts": cutouts}))
'''.replace("KEEP_WHOLE_PY", repr(KEEP_WHOLE))


def design_name(source):
    """"data/designs/variant_a.json" -> "variant_a"; the working file by what it is."""
    s = str(source or "").lstrip("/")
    if not s or s == "data/design.json":
        return "the working design"
    return os.path.splitext(os.path.basename(s))[0]


def scan_fingerprint(path):
    """Identify the scan content independently of USDZ packaging timestamps."""
    digest = hashlib.sha256()
    with zipfile.ZipFile(path) as archive:
        for item in sorted(archive.infolist(), key=lambda entry: entry.filename):
            digest.update(item.filename.encode("utf-8") + b"\0")
            digest.update(str(item.file_size).encode("ascii") + b"\0")
            with archive.open(item) as data:
                for block in iter(lambda: data.read(1024 * 1024), b""):
                    digest.update(block)
    return digest.hexdigest()


def plant_details(items):
    """Optional catalogue facts; the rendered plant's own dimensions always win."""
    import plant_catalog
    result = []
    for item in items or []:
        row = plant_catalog.lookup(item.get("species")) or {}
        # lookup also has an evidence-scoped toxicity fallback. That cannot identify a
        # cultivar or supply its horticultural description.
        names = [row.get("species"), *row.get("aliases", [])]
        if plant_catalog.normalize(item.get("species")) not in [plant_catalog.normalize(n) for n in names if n]:
            row = {}
        details = {key: row[key] for key in ("sun", "water", "bloom", "evergreen", "ca_native", "form",
                                            "note", "cat_safe", "identity_status", "flowering_height_range_m") if key in row}
        result.append({**item, "details": details if row else None})
    return result


def export_usdz(out_name=OUT_NAME, timeout_s=240, ratio=0.35, name=None):
    """Ask the viewer for the phone's scene, then convert it to USDZ. -> (path, info)."""
    os.makedirs(OUT_DIR, exist_ok=True)
    t0 = time.time()
    try:
        data = broker.data({"op": "export_scene", "plants": "cards"}, timeout=timeout_s) or {}
    except broker.ViewerDown as e:
        return None, {"error": "no_viewer", "detail": str(e),
                      "fix": "open http://localhost:5178 and keep the tab visible"}
    except broker.BrokerRefused as e:
        return None, {"error": "refused", "detail": str(e)}
    if not data.get("path"):
        return None, {"error": "no_geometry", "detail": data.get("error") or str(data)[:200]}
    scan_glb = project.resolve(data["scan_path"]) if data.get("scan_path") else None
    scan_info = None
    glb = project.resolve(data["path"])   # data/… is the active site's
    if not os.path.isfile(glb):
        return None, {"error": "missing_glb", "detail": glb}
    t_viewer = time.time() - t0
    try:
        if not os.path.isfile(BLENDER):
            return None, {"error": "no_blender", "detail": BLENDER,
                          "fix": "Blender is a .app on this machine and is not on $PATH"}
        dst = os.path.join(OUT_DIR, out_name)
        # made in a hidden folder and swapped in whole: the phone keeps being served the
        # last good one while this is made, never half of a new one. NOT beside it as
        # `yard.usdz.making.usdz` — that name is a `.usdz` the phone's server would list.
        making = os.path.join(OUT_DIR, ".making")
        os.makedirs(making, exist_ok=True)
        tmp = os.path.join(making, out_name)
        r = subprocess.run([BLENDER, "-b", "--python-exit-code", "1", "--python-expr", CONVERT,
                            "--", glb, tmp, str(ratio), str(ALPHA_CUT)],
                           capture_output=True, text=True)
        stats = next((json.loads(l.split(" ", 1)[1]) for l in (r.stdout or "").splitlines()
                      if l.startswith("USDZ_STATS ")), None)
        if r.returncode != 0 or not stats or not os.path.isfile(tmp):
            return None, {"error": "convert_failed", "detail": (r.stderr or r.stdout)[-600:]}
        if scan_glb:
            # A separate original capture for choosing REAL alignment references. It never
            # enters the AR overlay. Preserve every triangle for precise surface picks.
            scan_name = f"{os.path.splitext(out_name)[0]}-{time.time_ns()}.scan.usdz"
            scan_tmp = os.path.join(making, scan_name)
            scan_result = subprocess.run([BLENDER, "-b", "--python-exit-code", "1", "--python-expr", CONVERT,
                                          "--", scan_glb, scan_tmp, "1.0", str(ALPHA_CUT)],
                                         capture_output=True, text=True)
            if scan_result.returncode or not os.path.isfile(scan_tmp):
                return None, {"error": "scan_convert_failed", "detail": (scan_result.stderr or scan_result.stdout)[-600:]}
            os.replace(scan_tmp, os.path.join(OUT_DIR, scan_name))
            scan_info = {"file": scan_name, "bounds": data.get("scan_bounds"),
                         "content_hash": scan_fingerprint(os.path.join(OUT_DIR, scan_name))}
        os.replace(tmp, dst)
    finally:
        if scan_glb and data["scan_path"].startswith("data/photoreal/scene_"):
            try:
                os.remove(scan_glb)
            except OSError:
                pass
        if data["path"].startswith("data/photoreal/scene_"):   # the viewer's snapshot, ours to delete
            try:
                os.remove(glb)
            except OSError:
                pass
    info = {"file": out_name, "bytes": os.path.getsize(dst), "made_ms": int(time.time() * 1000),
            "seconds": round(time.time() - t0, 1), "viewer_seconds": round(t_viewer, 1),
            "design_source": data.get("design_source"),
            "design_name": name or design_name(data.get("design_source")), "ratio": ratio, **stats,
            "scan": scan_info, "shift": data.get("shift"),
            **{k: data.get(k) for k in ("plants", "plants_in_design", "species", "landmarks",
                                        "origin", "second", "apart_m", "phases", "plan", "ground")}}
    info["plant_items"] = plant_details(data.get("plant_items"))
    # What the native app reads: the design, its plants and alignment reference.
    with open(os.path.join(OUT_DIR, os.path.splitext(out_name)[0] + ".json"), "w") as f:
        json.dump(info, f, indent=1)
    return dst, info


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--ratio", type=float, default=0.35,
                    help="decimation of the HARDSCAPE (1.0 keeps everything); plants and "
                         "landmarks are never decimated")
    ap.add_argument("--name", help="the design's name as the viewer shows it, for the phone page")
    a = ap.parse_args(argv)
    path, info = export_usdz(ratio=a.ratio, name=a.name)
    if not path:
        print(f"[ar] {info.get('error')}: {info.get('detail', '')}", file=sys.stderr)
        if info.get("fix"):
            print(f"[ar] {info['fix']}", file=sys.stderr)
        return 2
    print(f"[ar] {os.path.relpath(path, ROOT)} — {info['bytes'] / 1048576:.1f} MB, "
          f"{info['triangles']:,} triangles, {info['plants']} plants as {info['species']} "
          f"pictures, in {info['seconds']} s")
    if info.get("plants_in_design") and info["plants"] < info["plants_in_design"]:
        print(f"[ar] {info['plants_in_design'] - info['plants']} plants had no picture and are "
              "NOT in the file", file=sys.stderr)
    if info.get("origin"):
        print(f"[ar] stand at {info['origin']}: its post is where the model lands"
              + (f"; turn it until the {info['second']} post stands on the real one"
                 if info.get("second") else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
