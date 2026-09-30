#!/usr/bin/env python3
"""Path-trace one view of the design, with Cycles, at the real sun.

    python3 tools/photoreal.py --viewpoint "from the back door"
    python3 tools/photoreal.py --subject bank_bed --samples 64 --width 960
    python3 tools/photoreal.py --export-only        # just the .glb, no render

"PHOTOREALISTIC" MEANS TWO THINGS, AND THEY PULL OPPOSITE WAYS
-----------------------------------------------------------------------
TRUTHFUL is what this file does: path-trace the geometry that is really there, at
the sun angle `tools/sun.py` computes, so every pixel still corresponds to
measured ground and to the plant that is actually specified. Slow — minutes, not
the ~1 s the render broker takes — and it invents nothing.

GENERATIVE is the other one: a diffusion model conditioned on the frame. Prettier,
faster, and IT WILL LIE. Asked to "make this photorealistic" it changes species,
invents windows, moves stones, grows a tree that is not there — which is exactly
the failure this project guards against, a design that measures correctly beside
a picture that does not correspond to it. Running one needs a local image model
installed (Draw Things, ComfyUI, diffusers, MLX or CoreML), so that is an install
decision as well as a truth decision, and nothing here takes it.

THE GEOMETRY COMES FROM THE VIEWER, NOT FROM design.json
---------------------------------------------------------
The viewer is the only place that knows the ENU-to-world yaw, the ground height
under every object, which GLB each species routes to, and what growth scale is
applied. Rebuilding any of that here would be a second copy of the nastiest bug
class in this project — world coordinates stored as ENU, which is invisible until
north is set. So `export_scene` hands over geometry that has ALREADY been placed,
and this file only frames it, lights it and renders it.

Blender is already a dependency (`gen_trees.py`, `blender_export.py`,
`blender_plant_instances.py`), and on macOS it is NOT on $PATH — it is a .app,
so it is found through `project.BLENDER`, never by name alone.
"""
from __future__ import annotations
import argparse
import json
import math
import os
import project  # the active project's files — the ONE owner
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import broker  # noqa: E402  — the ONE client for the viewer's render broker
from render_process import run_bounded, render_slot, RenderBusy

BLENDER = project.BLENDER             # $PEDON_BLENDER, `blender` on the PATH, or the macOS app
OUT_DIR = project.data("photoreal")
REVIEW_TIMEOUT_S = 600  # fresh geometry export plus a Cycles frame

# The render script, run INSIDE Blender. Kept here rather than in its own file so
# the framing, the sun and the geometry travel together — the three things a
# photoreal frame can get wrong independently.
BLENDER_SCRIPT = r'''
import bpy, sys, json, math, os
argv = sys.argv[sys.argv.index("--") + 1:]
cfg = json.loads(argv[0])

bpy.ops.wm.read_factory_settings(use_empty=True)
sys.path.insert(0, cfg["tools"])
from blender_plant_instances import import_instances
from render_process import phase
phase('blender_ready')
import_instances(cfg["glb"], measure=False, realize=True, progress=phase)
phase('configure_cycles')

scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = cfg["samples"]
scene.cycles.use_denoising = True
try:
    scene.cycles.device = "GPU"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "METAL"
    prefs.get_devices()
    for d in prefs.devices:
        d.use = True
except Exception as e:
    print("[photoreal] GPU unavailable, falling back to CPU:", e)
    scene.cycles.device = "CPU"
scene.render.resolution_x = cfg["width"]
scene.render.resolution_y = cfg["height"]
scene.render.resolution_percentage = 100
scene.render.film_transparent = False
scene.render.filepath = cfg["out"]
scene.render.image_settings.file_format = "PNG"

# ONE FRAME, and it is Blender's. MEASURED, not assumed: the glTF importer's
# Y-up to Z-up conversion is a default that can be off, and the two conventions
# differ by a 90-degree rotation about X — which renders as a garden hanging from
# the top of the frame. So the extent is read and the import rotated only if it
# needs it.
#
# The CAMERA arrives in Blender coordinates from python, where site_api knows the
# ground. Converting ENU -> viewer-world -> Blender here would be two conversions
# to get wrong instead of none, and the ENU/world confusion is this project's
# nastiest bug class.

# WHICH WAY IS UP, MEASURED rather than assumed. The glTF importer's Y-up to
# Z-up conversion is a default that can be off, and the two conventions differ by
# a 90-degree rotation about X — which renders as a garden hanging from the top of
# the frame. So read the geometry's own extent: a yard is wide and flat, so the
# SHORTEST axis of its bounding box is up.
mins = [1e9]*3; maxs = [-1e9]*3
for ob in scene.objects:
    if ob.type != "MESH":
        continue
    for c in ob.bound_box:
        w = ob.matrix_world @ __import__("mathutils").Vector(c)
        for i in range(3):
            mins[i] = min(mins[i], w[i]); maxs[i] = max(maxs[i], w[i])
extent = [round(b - a, 2) for a, b in zip(mins, maxs)]
up_axis = extent.index(min(extent))
print("[photoreal] imported extent", extent, "-> up is axis", up_axis)
if up_axis != 2 and not cfg.get("world_from_viewer"):
    # the importer left it Y-up; rotate the whole import into Blender's frame
    # rather than converting the camera the other way, so everything downstream
    # (sun, sky, the camera idiom) stays in ONE convention
    rot = __import__("mathutils").Matrix.Rotation(math.radians(90), 4, "X")
    for ob in scene.objects:
        if ob.parent is None:
            ob.matrix_world = rot @ ob.matrix_world
    print("[photoreal] rotated the import Y-up -> Z-up")

sun_data = bpy.data.lights.new("sun", type="SUN")
sun_data.energy = cfg["sun"]["energy"]
sun_data.angle = math.radians(0.53)      # the sun's real angular diameter: soft shadows
sun = bpy.data.objects.new("sun", sun_data)
scene.collection.objects.link(sun)
alt = math.radians(cfg["sun"]["altitude_deg"])
az = math.radians(cfg["sun"]["azimuth_deg"])
# compass bearing (0 = north, clockwise) to a Blender direction, Z up
d = (math.sin(az) * math.cos(alt), math.cos(az) * math.cos(alt), math.sin(alt))
sun.location = tuple(c * 60 for c in d)
sun.rotation_mode = "QUATERNION"
sun.rotation_quaternion = __import__("mathutils").Vector(d).to_track_quat("Z", "Y")

# A SKY, because a garden takes most of its fill light from above and bounce from
# below — the same reason the viewer samples a physical sky into both background
# and environment rather than lighting with a lamp alone (lighting.js).
world = bpy.data.worlds.new("sky")
scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
sky = world.node_tree.nodes.new("ShaderNodeTexSky")
# PICKED FROM WHAT THIS BLENDER OFFERS, not hardcoded. "NISHITA" was the
# physical sky in 4.x and is gone in 5.2 — the enum is now SINGLE_SCATTERING /
# MULTIPLE_SCATTERING / PREETHAM / HOSEK_WILKIE. Names move between versions:
# pin behaviour, never a spelling.
_types = [i.identifier for i in sky.bl_rna.properties["sky_type"].enum_items]
for want in ("MULTIPLE_SCATTERING", "NISHITA", "HOSEK_WILKIE", "PREETHAM"):
    if want in _types:
        sky.sky_type = want
        break
print("[photoreal] sky model:", sky.sky_type, "of", _types)
sky.sun_elevation = alt
sky.sun_rotation = az
world.node_tree.links.new(sky.outputs[0], bg.inputs[0])
bg.inputs[1].default_value = cfg["sun"]["sky_strength"]

cam_data = bpy.data.cameras.new("cam")
cam_data.lens = cfg["camera"]["lens_mm"]
if "fov_deg" in cfg["camera"]:
    cam_data.sensor_fit = "VERTICAL"
    cam_data.angle = math.radians(cfg["camera"]["fov_deg"])
cam = bpy.data.objects.new("cam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
eye = tuple(cfg["camera"]["eye"])
look = tuple(cfg["camera"]["look"])
cam.location = eye
v = __import__("mathutils").Vector((look[0] - eye[0], look[1] - eye[1], look[2] - eye[2]))
cam.rotation_mode = "QUATERNION"
cam.rotation_quaternion = v.to_track_quat("-Z", "Y")
bpy.context.view_layer.update()
_m = cam.matrix_world
print("[photoreal] scene z range", round(mins[2], 2), "to", round(maxs[2], 2))
print("[photoreal] camera at", [round(c, 2) for c in cam.location],
      "looking at", [round(c, 2) for c in look])
print("[photoreal] camera up", [round(c, 3) for c in (_m[0][1], _m[1][1], _m[2][1])],
      "forward", [round(-c, 3) for c in (_m[0][2], _m[1][2], _m[2][2])])

t0 = __import__("time").time()
phase('cycles_render')
bpy.ops.render.render(write_still=True)
phase('render_complete')
print("[photoreal] rendered in %.1f s" % (__import__("time").time() - t0))
'''


def export_scene(include, timeout_s=195, view=None):
    """Ask the open viewer for the placed geometry, as a .glb."""
    try:
        data = broker.data({"op": "export_scene", "include": include,
                            **({"view": view} if view is not None else {})}, timeout=timeout_s) or {}
    except broker.ViewerDown as e:
        return None, {"error": "no_viewer", "detail": str(e)}
    except broker.BrokerRefused as e:
        return None, {"error": "refused", "detail": str(e)}
    # the viewer writes the .glb itself, through the dev server, and tells us
    # where — base64 through the broker's JSON reply throws "Invalid string
    # length" on a full design
    if not data.get("path"):
        return None, {"error": "the viewer returned no geometry", "detail": data}
    path = project.resolve(data["path"])   # data/… is the active site's
    if not os.path.isfile(path):
        return None, {"error": "the viewer said it wrote a scene that is not there",
                      "path": data["path"]}
    return path, data


def camera_from_view(view):
    """The viewer already placed this camera, including yaw and measured ground.

    glTF's Y-up world becomes Blender Z-up on import: (x, y, z) -> (x, -z, y).
    Geometry and camera cross the same boundary; no ENU lookup is repeated here.
    """
    camera = view["camera_world"]
    convert = lambda p: [p[0], -p[2], p[1]]
    return {"eye": convert(camera["eye"]), "look": convert(camera["look"]),
            "fov_deg": camera["fov_deg"], "from": view.get("subject", "viewer camera")}


def capture_hour():
    """(date, HH:MM) off the capture's own filename, the way the viewer reads it.

    `Scaniverse 2025-06-01 171728.glb` was photographed at 17:17 on 1 June,
    and that is the only hour whose shadows agree with the plate. sunclock.js
    does the same thing in the browser; this is the same convention, not a second
    one — it reads the filename site.json already records.
    """
    import re
    import site_api
    try:
        name = ((site_api._site().get("frame") or {}).get("capture")
                or site_api._site().get("landmarks_frame") or "")
    except Exception:
        return None
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})[ _](\d{2})(\d{2})", os.path.basename(name))
    if not m:
        return None
    y, mo, d, hh, mm = m.groups()
    return (f"{y}-{mo}-{d}", f"{hh}:{mm}")


def sun_position_args(when):
    """Interpret the capture's wall clock locally, as sunclock.js does.

    sun.py defaults to UTC. Omitting the offset silently lights a 17:17 capture
    at another hour (10:17 at UTC-7) while the result still claims the capture hour.
    """
    from datetime import datetime
    argv = [sys.executable, os.path.join(ROOT, "tools", "sun.py"), "position"]
    if when:
        local = datetime.fromisoformat(f"{when[0]}T{when[1]}").astimezone()
        offset = local.utcoffset().total_seconds() / 3600
        argv += ["--date", when[0], "--time", when[1], "--utc-offset", str(offset)]
    return argv


def _design():
    import site_api
    try:
        return site_api._design(None) or {}
    except Exception:
        try:
            with open(project.data("design.json")) as f:
                return json.load(f)
        except Exception:
            return {}


def _scan(x, y):
    """The RAYCAST ground, or None off the scan — never the filled height field.

    `data/terrain.json` invents flat ground past the scan edge, and standing a
    camera on invented ground is how a frame comes back showing nothing.
    """
    import site_api
    try:
        g = site_api.scan_at(x, y)
        return g if isinstance(g, (int, float)) else None
    except Exception:
        return None


def _ground(x, y):
    """The measured ground at a point, or 0 — never a guess dressed as a number."""
    import site_api
    try:
        g = site_api.scan_at(x, y)
        return g if isinstance(g, (int, float)) else 0.0
    except Exception:
        return 0.0


def _blender(ex, en, above, ground=None):
    """ENU east/north plus a height ABOVE THE GROUND -> Blender x, y, z.

    Blender's x is east and y is north once the import is Z-up, so the mapping is
    the identity in the ground plane and the only real work is the height. That
    is the whole reason the camera is built here: `site_api` is where the measured
    ground lives, and a camera placed at a guessed elevation can stand inside the
    terrain or float above it.
    """
    g = _ground(ex, en) if ground is None else ground
    return [round(ex, 3), round(en, 3), round(g + above, 3)]


def camera_for(args):
    """Where to stand and what to look at, in BLENDER coordinates.

    A SAVED VIEWPOINT FIRST, because that is a place the owner decided matters
    — judging a change from one is judging it where they will see it. A
    saved viewpoint is stored as x, y and a height ABOVE THE GROUND, which is
    `look`'s own convention, so expanding one is a lookup rather than a
    conversion and no second frame exists to get wrong.
    """
    import site_api
    site = site_api._site()
    if args.viewpoint:
        want = args.viewpoint.strip().lower()
        for v in site.get("viewpoints") or []:
            if str(v.get("name", "")).strip().lower() == want:
                ex, en, eh = v["eye"]
                lx, ly, lh = v["look_at"]
                return {"eye": _blender(ex, en, eh), "look": _blender(lx, ly, lh),
                        "from": f'saved view "{v.get("name")}"'}
        return None
    if args.subject:
        pts = None
        # A DESIGN OBJECT FIRST, the same order `look` resolves in: a bed or a
        # patio is what you usually want a picture OF, and an area is a region the
        # owner drew to talk about. Both are legitimate; the design is the common case.
        d = _design()
        for key in ("beds", "patios", "paths", "edges", "steps"):
            o = next((x for x in d.get(key) or [] if x.get("id") == args.subject), None)
            if o:
                pts = o.get("polygon") or o.get("spline")
                break
        if pts is None:
            o = next((x for x in d.get("objects") or []
                      if x.get("id") == args.subject), None)
            if o and o.get("position"):
                px, py = o["position"]
                pts = [[px, py]]
        a = next((x for x in site.get("areas") or []
                  if x.get("name") == args.subject), None)
        if pts is None and a and a.get("polygon"):
            pts = a["polygon"]
        if pts:
            cx = sum(p[0] for p in pts) / len(pts)
            cy = sum(p[1] for p in pts) / len(pts)
            # stand back by the area's own size rather than a fixed eight metres:
            # a 2 m planter and a 30 m yard are not looked at from the same place
            span = max(max(p[0] for p in pts) - min(p[0] for p in pts),
                       max(p[1] for p in pts) - min(p[1] for p in pts))
            back = max(6.0, span * 0.9)
            # STAND ON GROUND THAT EXISTS. Backing off blindly puts the camera
            # inside the hill on a 13 degree slope, or off the scan entirely —
            # and a frame shot from inside the terrain is the "black render"
            # class of failure wearing a different hat. Try eight bearings and
            # take the first that is on scanned ground and not underneath it.
            best = None
            for i in range(8):
                th = i * math.pi / 4
                ex, en = cx + math.cos(th) * back, cy + math.sin(th) * back
                g = _scan(ex, en)
                if g is None:
                    continue                       # off the scan
                tgt = _ground(cx, cy)
                if g + args.eye_m <= tgt:
                    continue                       # standing below what we look at
                score = g + args.eye_m - tgt       # prefer looking slightly down
                if best is None or score > best[0]:
                    best = (score, ex, en, g)
            if best:
                _, ex, en, g = best
                return {"eye": _blender(ex, en, args.eye_m, ground=g),
                        "look": _blender(cx, cy, 0.9),
                        "from": f"{args.subject}, from {back:.0f} m back on scanned ground"}
            return {"eye": _blender(cx - back / 1.41, cy - back / 1.41, args.eye_m),
                    "look": _blender(cx, cy, 0.9),
                    "from": f"{args.subject}, from {back:.0f} m back (no scanned "
                            "standing point found — the frame may be inside the terrain)"}
    return None


def _main(argv, cleanup) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--viewpoint", help="a view the OWNER saved, by name")
    ap.add_argument("--subject", help="an area name, if no viewpoint is saved yet")
    ap.add_argument("--samples", type=int, default=64,
                    help="Cycles samples. 32 is a look, 256 is a picture.")
    ap.add_argument("--width", type=int, default=960)
    ap.add_argument("--height", type=int, default=600)
    ap.add_argument("--lens-mm", type=float, default=32.0)
    ap.add_argument("--eye-m", type=float, default=1.65,
                    help="eye height above the ground. 1.65 is standing, which is the "
                         "view the garden is actually seen from.")
    ap.add_argument("--export-only", action="store_true")
    ap.add_argument("--reuse-scene", action="store_true",
                    help="skip the export and use the .glb already on disk. The export "
                         "is 78 s and 648 MB for this design; re-framing the same "
                         "geometry should not pay it again.")
    ap.add_argument("--when", help="HH:MM. Defaults to the hour the SCAN was "
                                   "photographed, because the plate's own shadows are "
                                   "baked in and lighting it at another hour puts two "
                                   "suns in one frame.")
    ap.add_argument("--no-scan", action="store_true",
                    help="design only, on bare ground — the plate's own shadows are "
                         "photographed in, so at any other hour it carries two suns")
    ap.add_argument("--out")
    ap.add_argument("--profile", help="Save render memory samples and measured phase boundaries (also saved on failure)")
    ap.add_argument("--view-json", help="A YardEye look request; exports the current preview and its exact camera")
    args = ap.parse_args(argv)

    if args.view_json and args.reuse_scene:
        ap.error("--view-json requires a fresh export of the proposal being reviewed")

    t_export = time.time()
    existing = os.path.join(OUT_DIR, "scene.glb")
    if args.reuse_scene and os.path.isfile(existing):
        glb, info = existing, {"bytes": os.path.getsize(existing), "reused": True}
    else:
        include = ["design"] if args.no_scan else ["design", "scan"]
        glb, info = export_scene(include, view=json.loads(args.view_json) if args.view_json else None)
        if not glb:
            print(json.dumps({"error": "export failed", "detail": info}, indent=1))
            return 1
    t_export = time.time() - t_export
    if args.view_json and os.path.dirname(glb) == OUT_DIR and os.path.basename(glb).startswith("scene_"):
        from pathlib import Path
        cleanup.callback(Path(glb).unlink, missing_ok=True)
        cleanup.callback(Path(glb).with_suffix('.native-instances.json').unlink, missing_ok=True)
    if args.export_only:
        print(json.dumps({"ok": True, "glb": glb, **info,
                          "export_s": round(t_export, 1)}, indent=1))
        return 0

    if args.view_json and (info.get("render_quality") != "detailed" or info.get("growth") != "mature"):
        print(json.dumps({"error": "the viewer did not confirm full-detail mature geometry; reload it"}))
        return 1
    if args.view_json and not os.path.basename(glb).startswith("scene_"):
        print(json.dumps({"error": "the viewer returned a shared scene instead of a fresh review snapshot; reload it"}))
        return 1
    cam = camera_from_view(info["view"]) if args.view_json else camera_for(args)
    if not cam:
        import site_api
        site = site_api._site()
        print(json.dumps({
            "error": "no camera",
            "detail": "pass --viewpoint (a view you saved in the viewer) or --subject "
                      "(an area you drew). A photoreal frame is expensive; it should "
                      "look at somewhere you chose.",
            "saved_views": [v.get("name") for v in site.get("viewpoints") or []],
            "areas": [a.get("name") for a in site.get("areas") or []]}, indent=1))
        return 1

    if not os.path.isfile(BLENDER):
        print(json.dumps({
            "error": "no_blender", "looked_in": BLENDER,
            "detail": "Blender was not found: install it, or set PEDON_BLENDER to its executable."}))
        return 1

    # THE CAPTURE'S OWN HOUR by default, not "now". The scan is a photograph and
    # its shadows are painted into it; lighting the design at a different hour is
    # the one error you cannot art-direct around. Left at "now", the sun can be
    # below the horizon (a measured altitude of -21.7 degrees) — a correct,
    # truthful picture of the middle of the night.
    when = args.when or capture_hour()
    if isinstance(when, str):
        from datetime import date
        when = ((capture_hour() or (date.today().isoformat(),))[0], when)
    sun_args = sun_position_args(when)
    sun = subprocess.run(sun_args, capture_output=True, text=True, cwd=ROOT)
    s = json.loads(sun.stdout or "{}")
    alt = s.get("altitude_deg")
    az = s.get("azimuth_deg")
    if alt is None:
        print(json.dumps({"error": "no_sun", "detail": sun.stdout[:300]}))
        return 1

    # IS THE BEARING REAL? `sun.py position` gives a TRUE compass azimuth and is
    # deliberately not gated — a bearing of the sky needs only a latitude and a
    # clock. What needs north is putting that bearing into THIS SCENE, and until
    # north is set the scan's heading is unknown (a capture's own heading can be
    # 20-odd degrees off true).
    #
    # So the shadows in the frame point in an arbitrary direction, and this is
    # the most convincing picture this system can produce — which makes it the
    # most dangerous place to leave that unsaid. THE FILE ITSELF carries the
    # caveat, in its name: a frame whose artefact says nothing otherwise gets
    # read as a photograph of the garden.
    north = subprocess.run(
        [sys.executable, os.path.join(ROOT, "tools", "sun.py"), "north"],
        capture_output=True, text=True, cwd=ROOT)
    try:
        refused = bool(json.loads(north.stdout or "{}").get("refused"))
    except Exception:
        refused = True

    os.makedirs(OUT_DIR, exist_ok=True)
    stem = "view_BEARING-UNVERIFIED" if refused else "view"
    out = project.resolve(args.out) if args.out else os.path.join(OUT_DIR, f"{stem}.png")
    cfg = {
        "tools": os.path.join(ROOT, "tools"),
        "world_from_viewer": bool(args.view_json),
        "glb": glb, "out": out, "samples": args.samples,
        "width": args.width, "height": args.height,
        "camera": {"eye": cam["eye"], "look": cam["look"], "lens_mm": args.lens_mm,
                   **({"fov_deg": cam["fov_deg"]} if "fov_deg" in cam else {})},
        # energy and sky strength are Blender's units, not lux — tuned once here
        # and reported, so a frame that comes out dark is a number somebody can see
        "sun": {"altitude_deg": alt, "azimuth_deg": az or 0.0,
                "energy": 4.0, "sky_strength": 1.0},
    }
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f:
        f.write(BLENDER_SCRIPT)
        script = f.name
    t0 = time.time()
    profile_path = args.profile or os.path.join(OUT_DIR, 'last-render-profile.json')
    try:
        # --python-exit-code BEFORE -P: it governs the python run that follows, so
        # after it the flag is read as an argument and a script that raises still
        # exits 0 — so a render that never happened would report success
        r = run_bounded([BLENDER, "-b", "--python-exit-code", "1", "-P", script,
                            "--", json.dumps(cfg)],
                        cwd=ROOT, timeout=max(1, REVIEW_TIMEOUT_S - t_export - 30),
                        new_session=False, profile_path=profile_path)
    except (RuntimeError, OSError) as error:
        print(json.dumps({"error": str(error), "profile": profile_path}))
        return 1
    finally:
        os.unlink(script)
    took = time.time() - t0
    if r.returncode != 0 or not os.path.isfile(out):
        print(json.dumps({"error": "render failed", "exit": r.returncode,
                          "stderr": r.stderr[-600:], "stdout": r.stdout[-600:]}, indent=1))
        return 1
    diag = [l for l in (r.stdout or "").splitlines() if l.startswith("[photoreal]")]
    print(json.dumps({
        "ok": True, "image": out, "blender": diag,
        "kb": round(os.path.getsize(out) / 1024),
        "export_s": round(t_export, 1), "render_s": round(took, 1),
        "peak_memory_gib": round(r.peak_memory_bytes / 1024 ** 3, 2),
        "profile": profile_path,
        "samples": args.samples, "size": [args.width, args.height],
        "camera_from": cam["from"],
        **({"view": info["view"], "render_quality": info.get("render_quality"),
            "growth": info.get("growth"), "design_source": info.get("design_source")}
           if args.view_json else {}),
        "lit_at": {"date": when[0], "time": when[1], "why": "the hour the scan was "
                   "photographed — the only one whose shadows agree with the plate"}
                  if when else {"why": "now"},
        "sun": {"altitude_deg": alt, "azimuth_deg": az},
        **({"WARNING": "THE SHADOW DIRECTION IN THIS FRAME IS ARBITRARY. North has "
                       "not been set on this capture, so the scan's heading is "
                       "unknown and the sun's true bearing does not correspond to "
                       "it (measured 23.3 degrees off on a reference capture). "
                       "The sun's HEIGHT is real; where the shadows "
                       "fall is not. Set north in the viewer and re-run. The file "
                       "name says so too, because an artefact that does not carry "
                       "its own caveat gets read as if it had none."}
           if refused else {}),
        "note": "TRUTHFUL, not generative: every pixel is the geometry that is really "
                "there. Nothing was invented." }, indent=1))
    return 0


def main(argv=None) -> int:
    # One export/render per property, across MCP processes and manual CLI calls.
    import signal
    from contextlib import ExitStack
    try:
        with render_slot(OUT_DIR):
            def cancelled(*_):
                raise KeyboardInterrupt("Render cancelled")
            previous = signal.signal(signal.SIGTERM, cancelled)
            try:
                with ExitStack() as cleanup:
                    return _main(argv, cleanup)
            finally:
                signal.signal(signal.SIGTERM, previous)
    except RenderBusy as error:
        print(json.dumps({"error": str(error)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
