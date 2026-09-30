"""A USDZ for the native PEDON app, at 1:1 — with the PLANTS in it, and no scan.

The plants are what the user needs to see on the phone. A file carrying the scan renders
in RealityKit, the native app’s renderer, as a grey shell of scan over the whole yard
with the design underneath it. So the viewer sends the plants as pictures of themselves
and the owner's landmarks as posts, and this file converts that — without the scan.

These run the exporter for real with the two slow things stood in for: the viewer (the
broker) and Blender. What is checked is what it asks for, what it writes where, and
what it cleans up.
"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import ar_export  # noqa: E402


def stand_in(monkeypatch, tmp_path, blender_ok=True):
    """The exporter in a sandbox: its own data dir, a viewer that answers, a Blender that
    writes a file (or fails). Returns what the viewer was asked for."""
    root = tmp_path
    (root / "data" / "photoreal").mkdir(parents=True)
    snap = root / "data" / "photoreal" / "scene_1234.glb"
    snap.write_bytes(b"glTF")
    # the site is a PROJECT, as every site is: the viewer's reply names "data/photoreal/…", and
    # only the resolver knows that is this folder — not the checkout the code sits in
    monkeypatch.setenv("PEDON_PROJECT", str(root / "data"))
    monkeypatch.setattr(ar_export, "ROOT", str(root / "checkout"))
    monkeypatch.setattr(ar_export, "OUT_DIR", str(root / "data" / "ar"))
    blender = root / "Blender"
    blender.write_text("")
    monkeypatch.setattr(ar_export, "BLENDER", str(blender))
    asked = []

    def viewer(payload, timeout=60):
        asked.append(payload)
        # the working file, as it usually is: the owner loads a saved design into it and edits
        return {"path": "data/photoreal/scene_1234.glb", "design_source": "data/design.json",
                "plants": 159, "plants_in_design": 159, "species": 22, "landmarks": ["a", "b"],
                "origin": "side_yard_hedge_row", "second": "south_fence_east_corner", "apart_m": 15.7,
                "phases": {"pictures_ms": 2000}}
    monkeypatch.setattr(ar_export.broker, "data", viewer)

    def run(cmd, capture_output, text):
        args = cmd[cmd.index("--") + 1:]
        out = args[1]
        if blender_ok:
            with open(out, "wb") as f:
                f.write(b"PK-new")
            return subprocess.CompletedProcess(cmd, 0, 'USDZ_STATS {"triangles": 155102, "points": 92533, '
                                               '"card_triangles": 2300, "cutouts": 34}\n', "")
        return subprocess.CompletedProcess(cmd, 1, "", "Traceback: it broke")
    monkeypatch.setattr(ar_export.subprocess, "run", run)
    return asked, snap


def test_it_asks_the_viewer_for_the_plants_as_pictures_and_for_no_scan(monkeypatch, tmp_path):
    asked, _ = stand_in(monkeypatch, tmp_path)
    path, info = ar_export.export_usdz()
    assert path, info
    assert asked == [{"op": "export_scene", "plants": "cards"}], (
        "the viewer was asked for something other than the phone's scene — "
        f"the scan, or the planting as markers: {asked}")


def test_the_file_says_which_design_it_is_and_where_to_stand(monkeypatch, tmp_path):
    """The phone page must not offer a file with no name, made from nobody knows what:
    the sidecar names the design and where to stand, and it is what the page reads."""
    stand_in(monkeypatch, tmp_path)
    path, info = ar_export.export_usdz(name="huajing_J_sunroom")
    side = json.load(open(os.path.join(ar_export.OUT_DIR, "yard.json")))
    # the name the viewer's top bar shows, not "the working design"
    assert side["design_name"] == "huajing_J_sunroom"
    assert side["design_source"] == "data/design.json"
    assert (side["plants"], side["species"]) == (159, 22)
    assert (side["origin"], side["second"]) == ("side_yard_hedge_row", "south_fence_east_corner")
    assert side["cutouts"] == 34 and side["card_triangles"] == 2300
    assert open(path, "rb").read() == b"PK-new"
    # with no name from the viewer, it is named from its source
    assert ar_export.design_name("data/designs/huajing_J_sunroom.json") == "huajing_J_sunroom"
    assert ar_export.design_name("/data/design.json") == "the working design"


def test_the_half_made_file_is_never_where_the_phone_looks(monkeypatch, tmp_path):
    """The phone's server lists every `*.usdz` in data/ar. A temp file beside the real one
    named `yard.usdz.making.usdz` would be listed, and served half-written."""
    stand_in(monkeypatch, tmp_path)
    seen = []
    real = ar_export.subprocess.run

    def watch(cmd, capture_output, text):
        seen.append(cmd[cmd.index("--") + 2])
        return real(cmd, capture_output=capture_output, text=text)
    monkeypatch.setattr(ar_export.subprocess, "run", watch)
    ar_export.export_usdz()
    tmp = seen[0]
    assert os.path.dirname(tmp) != ar_export.OUT_DIR, f"made where the phone looks: {tmp}"
    assert os.path.basename(os.path.dirname(tmp)).startswith("."), "the phone's server would list it"
    assert os.listdir(ar_export.OUT_DIR) and all(not n.endswith(".usdz") or n == "yard.usdz"
                                                  for n in os.listdir(ar_export.OUT_DIR))


def test_a_failed_conversion_keeps_the_last_good_file_and_still_cleans_up(monkeypatch, tmp_path):
    asked, snap = stand_in(monkeypatch, tmp_path, blender_ok=False)
    os.makedirs(ar_export.OUT_DIR)
    good = os.path.join(ar_export.OUT_DIR, "yard.usdz")
    open(good, "wb").write(b"PK-last-good")
    path, info = ar_export.export_usdz()
    assert path is None and info["error"] == "convert_failed" and "it broke" in info["detail"]
    assert open(good, "rb").read() == b"PK-last-good", "a failure overwrote the file the phone opens"
    assert not snap.exists(), "the viewer's snapshot GLB is left behind on every failed run"


def test_the_snapshot_is_deleted_and_photoreals_cache_is_never_touched(monkeypatch, tmp_path):
    """Making the phone file must never save over data/photoreal/scene.glb —
    photoreal's --reuse-scene cache."""
    _, snap = stand_in(monkeypatch, tmp_path)
    cache = tmp_path / "data" / "photoreal" / "scene.glb"
    cache.write_bytes(b"photoreal's")
    ar_export.export_usdz()
    assert not snap.exists(), "the snapshot GLB is left in data/photoreal on every run"
    assert cache.read_bytes() == b"photoreal's"


def test_it_refuses_clearly_when_the_viewer_is_shut(monkeypatch, tmp_path):
    """The geometry comes from the VIEWER. With no viewer the answer must name the
    fix, not hang."""
    stand_in(monkeypatch, tmp_path)

    def shut(payload, timeout=60):
        raise ar_export.broker.ViewerDown("not reachable")
    monkeypatch.setattr(ar_export.broker, "data", shut)
    path, info = ar_export.export_usdz()
    assert path is None and info["error"] == "no_viewer"
    assert "localhost:5178" in info["fix"], "the refusal does not say how to fix it"


def test_what_blender_is_told_to_do():
    """The conversion script cannot run in the suite (Blender is seconds to start), so its
    decisions are read from it — each one has a measured reason, noted beside it."""
    src = ar_export.CONVERT
    # the pictures are cut-outs: without a threshold every card is a pale box
    assert 'CreateInput("opacityThreshold"' in src and 'ConnectToSource(texture.ConnectableAPI(), "a")' in src
    # the cards and posts carry their own back faces; a double-sided front would fight them
    assert "CreateDoubleSidedAttr().Set(False)" in src
    # plants and landmarks are never decimated; the hardscape is WELDED before it is
    assert ar_export.KEEP_WHOLE == ("plant-card", "ar-landmark")
    assert src.index("remove_doubles") < src.index('modifiers.new("dec", "DECIMATE")'), (
        "decimating unwelded triangles drops faces and keeps every vertex: 1.02 M points for 160 k triangles")
    # METRES — 1:1 is the whole requirement — and Apple's own packager
    assert 'convert_scene_units="METERS"' in src
    assert "CreateNewARKitUsdzPackage" in src
    # the triangle count is of the EVALUATED mesh, after the modifier
    assert "evaluated_depsgraph_get" in src and "to_mesh_clear" in src


def test_blender_is_not_assumed_to_be_on_PATH():
    """On macOS it is a .app and `blender` fails with command not found, which
    leaves every Blender-backed capability silently unusable."""
    assert ar_export.BLENDER.endswith("Blender")
    assert ar_export.BLENDER.startswith("/Applications"), ar_export.BLENDER


def test_scan_is_a_separate_full_resolution_file_in_the_same_frame(monkeypatch, tmp_path):
    stand_in(monkeypatch, tmp_path)
    scan = tmp_path / "data" / "photoreal" / "scene_scan.glb"
    scan.write_bytes(b"scan")
    viewer = ar_export.broker.data
    monkeypatch.setattr(ar_export.broker, "data", lambda *a, **k: {
        **viewer(*a, **k), "scan_path": "data/photoreal/scene_scan.glb", "shift": [3, 1, -7]})
    called = []
    convert = ar_export.subprocess.run
    def run(cmd, **kw):
        called.append(cmd[cmd.index("--") + 1:])
        return convert(cmd, **kw)
    monkeypatch.setattr(ar_export.subprocess, "run", run)
    path, info = ar_export.export_usdz()
    assert path and info["scan"]["file"].endswith(".scan.usdz")
    assert info["shift"] == [3, 1, -7]
    assert len(called) == 2 and called[1][2] == "1.0"
    assert os.path.isfile(os.path.join(ar_export.OUT_DIR, info["scan"]["file"]))
    assert not scan.exists()


def test_plant_details_keep_design_sizes_and_only_exact_catalogue_facts(monkeypatch):
    import plant_catalog
    doc = {"plants": [
        {"species": "Salvia microphylla 'Hot Lips'", "aliases": ["Hot Lips"],
         "sun": "sun", "water": "low", "bloom": "spring_autumn", "evergreen": True,
         "note": "Bicolour flowers", "cat_safe": None, "mature_height_m": 2.0},
        {"species": "Unsafe genus", "cat_safe": False,
         "cat_safety": {"evidence_scope": "genus"}, "note": "Not this cultivar's description"},
    ]}
    monkeypatch.setattr(plant_catalog, "catalog", lambda: doc)
    original = [{"id": "p1", "species": "Hot Lips", "mature_height_m": 0.9144, "size_override": True},
                {"id": "p2", "species": "Unsafe unknown"}, {"id": "p3", "species": "Missing"}]
    result = ar_export.plant_details(original)
    assert result[0]["mature_height_m"] == 0.9144
    assert result[0]["size_override"] is True
    assert result[0]["details"]["sun"] == "sun"
    assert result[0]["details"]["evergreen"] is True
    assert result[0]["details"]["cat_safe"] is None
    assert result[1]["details"] is None and result[2]["details"] is None
    assert "details" not in original[0]
