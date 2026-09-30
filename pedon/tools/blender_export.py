"""Headless Blender: vendor plant model (FBX/OBJ/.blend) -> web-ready GLB(s).

Usage:
  blender -b -P tools/blender_export.py -- \
      --in path/to/model.fbx --out assets/plants/acer_palmatum.glb \
      --target-tris 50000 --lods 2

What it does (per the verified macOS Blender 5.2 LTS pipeline):
  1. Imports FBX/OBJ or appends all objects from a .blend.
  2. Flattens materials: finds the base-color / alpha image textures (descending
     into node groups) and rebuilds a plain Principled BSDF. Alpha goes through
     a Math:ROUND node so the glTF exporter emits alphaMode=MASK (a bare alpha
     link exports as BLEND, which sorts badly in three.js).
  3. Decimates to the target triangle budget (collapse) per LOD.
  4. Exports GLB with Draco compression. LOD files: name.glb, name_lod1.glb ...

`--out assets/…` is the user's LIBRARY (tools/project.py), like every model: never the app.

Notes:
  - KTX2 texture compression is intentionally skipped (needs toktx).
  - A vendor model's licence stays with it in the library; the app ships none.
"""
import argparse
import math
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import project  # noqa: E402  — where assets/… is: the user's library


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", required=True)
    ap.add_argument("--out", dest="out", required=True)
    ap.add_argument("--target-tris", type=int, default=50000)
    ap.add_argument("--lods", type=int, default=2, help="extra LOD levels, each /4 tris")
    ap.add_argument("--height-m", type=float, default=None,
                    help="if set, uniformly rescale so bounding-box height equals this")
    return ap.parse_args(argv)


def clean_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_source(src):
    ext = os.path.splitext(src)[1].lower()
    if ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=src)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=src)
    elif ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=src)
    elif ext == ".blend":
        with bpy.data.libraries.load(src) as (data_from, data_to):
            data_to.objects = data_from.objects
        for ob in data_to.objects:
            if ob is not None:
                bpy.context.collection.objects.link(ob)
    else:
        raise SystemExit(f"unsupported input: {ext}")


def find_image_nodes(node_tree, depth=0):
    """Yield (image, is_probably_color, node) descending into groups."""
    if node_tree is None or depth > 4:
        return
    for node in node_tree.nodes:
        if node.type == "TEX_IMAGE" and node.image is not None:
            yield node.image, node
        elif node.type == "GROUP":
            yield from find_image_nodes(node.node_tree, depth + 1)


def flatten_material(mat):
    """Rebuild mat as plain Principled BSDF with base color + ROUND(alpha)."""
    if not mat.use_nodes:
        return
    images = [(img, node) for img, node in find_image_nodes(mat.node_tree)]
    if not images:
        return
    # heuristics: prefer an image whose name hints at color/diffuse/albedo
    def score(img):
        n = img.name.lower()
        s = 0
        for k, v in (("col", 3), ("albedo", 3), ("diff", 3), ("leaf", 1), ("bark", 1)):
            if k in n:
                s += v
        for k in ("normal", "nrm", "rough", "gloss", "bump", "disp", "spec", "ao", "translu"):
            if k in n:
                s -= 5
        return s
    images.sort(key=lambda t: score(t[0]), reverse=True)
    base_img = images[0][0]
    # opacity map: separate alpha image if present, else the base image's alpha
    alpha_img = None
    for img, _ in images:
        n = img.name.lower()
        if any(k in n for k in ("opac", "alpha", "mask")):
            alpha_img = img
            break

    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = base_img
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    rnd = nt.nodes.new("ShaderNodeMath")
    rnd.operation = "ROUND"
    if alpha_img is not None:
        atex = nt.nodes.new("ShaderNodeTexImage")
        atex.image = alpha_img
        atex.image.colorspace_settings.name = "Non-Color"
        nt.links.new(atex.outputs["Color"], rnd.inputs[0])
    else:
        nt.links.new(tex.outputs["Alpha"], rnd.inputs[0])
    nt.links.new(rnd.outputs[0], bsdf.inputs["Alpha"])
    mat.blend_method = "CLIP"


def mesh_objects():
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]


def total_tris():
    n = 0
    for o in mesh_objects():
        m = o.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh()
        m.calc_loop_triangles()
        n += len(m.loop_triangles)
    return n


def decimate_to(target):
    cur = total_tris()
    if cur <= target or cur == 0:
        return cur
    ratio = target / cur
    for o in mesh_objects():
        mod = o.modifiers.new("dec", "DECIMATE")
        mod.ratio = ratio
    return cur


def world_height():
    import mathutils
    mn, mx = math.inf, -math.inf
    for o in mesh_objects():
        for corner in o.bound_box:
            w = o.matrix_world @ mathutils.Vector(corner)
            mn, mx = min(mn, w.z), max(mx, w.z)
    return mx - mn


def rescale_height(h_target):
    h = world_height()
    if h <= 0:
        print("[warn] zero-height model; skipping --height-m")
        return
    f = h_target / h
    # Uniform scale about the WORLD ORIGIN: scale every parentless scene object's
    # scale AND location (scaling only .scale leaves multi-root assemblies distorted,
    # because object origins stay put). Vendor FBX with an Empty root also works —
    # children inherit the root's transform.
    for o in bpy.context.scene.objects:
        if o.parent is None:
            o.scale = [sc * f for sc in o.scale]
            o.location = [lc * f for lc in o.location]
    bpy.context.view_layer.update()
    new_h = world_height()
    if abs(new_h - h_target) / h_target > 0.02:
        raise SystemExit(f"rescale failed: height {new_h:.2f} m != target {h_target:.2f} m "
                         "(unexpected object hierarchy — inspect the file in Blender)")
    print(f"[ok] rescaled to {new_h:.2f} m tall")


def export_glb(path):
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_apply=True,
        export_draco_mesh_compression_enable=True,
        export_yup=True,
    )


def main():
    args = parse_args()
    clean_scene()
    import_source(os.path.abspath(args.src))
    bpy.context.view_layer.update()   # matrices are stale until the depsgraph runs
    for mat in bpy.data.materials:
        try:
            flatten_material(mat)
        except Exception as e:  # keep going; report
            print(f"[warn] material {mat.name}: {e}")
    if args.height_m:
        rescale_height(args.height_m)

    # assets/… is the library's; any other relative path is where it was typed
    out = project.resolve(args.out) if args.out.split("/")[0] in project.LIBRARY_ROOTS else args.out
    out_base, ext = os.path.splitext(os.path.abspath(out))
    budgets = [args.target_tris] + [max(500, args.target_tris // (4 ** (i + 1)))
                                    for i in range(args.lods)]
    before = total_tris()
    for i, budget in enumerate(budgets):
        # remove previous decimate modifiers, re-apply for this budget
        for o in mesh_objects():
            for m in [m for m in o.modifiers if m.name.startswith("dec")]:
                o.modifiers.remove(m)
        decimate_to(budget)
        path = f"{out_base}{ext}" if i == 0 else f"{out_base}_lod{i}{ext}"
        export_glb(path)
        print(f"[ok] {path}  (~{min(before, budget)} tris budget, source {before})")


if __name__ == "__main__":
    main()
