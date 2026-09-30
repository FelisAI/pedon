"""The demo garden (tools/demo_site.py): a site made by code, so a new user has something to
try — and every file in it must agree with every other, or it teaches them a broken site."""
import json
import math
import os
import struct
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.join(ROOT, "tools")


@pytest.fixture(scope="module")
def demo(tmp_path_factory):
    projects = tmp_path_factory.mktemp("projects")
    env = dict(os.environ, PEDON_PROJECTS=str(projects))
    env.pop("PEDON_PROJECT", None)
    r = subprocess.run([sys.executable, os.path.join(TOOLS, "project.py"), "demo", "--open"],
                       env=env, capture_output=True, text=True, timeout=180)
    assert r.returncode == 0, r.stdout + r.stderr
    folder = projects / "demo-garden"
    read = lambda name: json.load(open(folder / name))
    return {"folder": folder, "env": dict(env, PEDON_PROJECT=str(folder)), "projects": projects,
            "site": read("site.json"), "calib": read("calibration.json"),
            "scan": read("terrain_scan.json"), "design": read("design.json"), "out": json.loads(r.stdout)}


def test_it_is_made_opened_and_listed_as_a_site(demo):
    assert demo["out"]["created"] == "demo-garden" and demo["out"]["active"] == "demo-garden"
    assert (demo["projects"] / ".active").read_text().strip() == "demo-garden"
    names = sorted(os.listdir(demo["folder"]))
    assert names == ["calibration.json", "captures", "design.json", "designs", "project.json",
                     "site.json", "terrain_scan.json"], names


def test_the_scan_is_a_glb_the_viewer_can_open(demo):
    data = (demo["folder"] / "captures" / "demo-garden.glb").read_bytes()
    magic, version, length = struct.unpack("<III", data[:12])
    assert (magic, version, length) == (0x46546C67, 2, len(data))
    n, kind = struct.unpack("<II", data[12:20])
    gltf = json.loads(data[20:20 + n])
    assert kind == 0x4E4F534A and gltf["meshes"][0]["primitives"][0]["attributes"].keys() >= {"POSITION", "COLOR_0"}
    assert demo["calib"]["captureUrl"] == "/data/captures/demo-garden.glb" == demo["site"]["landmarks_frame"]


def test_north_is_set_and_not_along_the_scan_axes(demo):
    # the frame rule: a bug that converts between the scan's frame and the compass is invisible
    # at yaw 0, and the demo is the one site where north is set — so it is set at an angle
    c = demo["calib"]
    assert c["northSet"] is True and abs(math.degrees(c["yaw"])) > 5
    assert c["captures"][c["captureUrl"]]["northSet"] is True
    r = subprocess.run([sys.executable, os.path.join(TOOLS, "sun.py"), "north"],
                       env=demo["env"], capture_output=True, text=True, timeout=60)
    status = json.loads(r.stdout)
    assert status["north_set"] is True and not status["stale_site_flags"], status


def test_the_height_grid_is_the_ground_it_was_made_from(demo):
    sys.path.insert(0, TOOLS)
    import demo_site
    g = demo["scan"]
    assert len(g["rows"]) == (g["y1"] - g["y0"]) / g["cell_m"] + 1
    # north row first, as the viewer's raycast writes it: row 0 is y1
    for x, y in ((0, 0), (8, -5), (-12, 10), (12, -9)):
        r, c = int((g["y1"] - y) / g["cell_m"]), int((x - g["x0"]) / g["cell_m"])
        assert g["rows"][r][c] == pytest.approx(demo_site.ground(x, y), abs=0.01), (x, y)
    # the house is ground the scan never saw, and so is everything outside the lot
    assert g["rows"][int(g["y1"] - 8)][int(-1 - g["x0"])] is None
    assert g["rows"][0][0] is None
    assert g["scanned_cells"] == sum(v is not None for row in g["rows"] for v in row)


def test_the_derived_half_is_derived(demo):
    s = demo["site"]
    assert s["scan_coverage"]["generated_by"] == "tools/analyze_site.py"
    assert s["house_measured"]["area_m2"] > 30, "the unscanned house was not found"
    assert {z["zone"] for z in s["zones"]} >= {"south_yard", "east_yard", "west_yard"}


def test_the_tools_answer_about_it(demo):
    run = lambda *a: json.loads(subprocess.run([sys.executable, os.path.join(TOOLS, a[0]), *a[1:]],
                                               env=demo["env"], capture_output=True, text=True,
                                               timeout=120).stdout)
    assert run("site_api.py", "ground", "8", "-5")["scanned"] is True
    v = run("site_api.py", "validate")
    assert v["ok"] and not v["errors"], v
    assert run("sun.py", "zone", "south_yard").get("refused") is not True


def test_the_starter_garden_went_through_the_write_path(demo):
    d = demo["design"]
    assert len(d["beds"]) == 1 and len(d["paths"]) == 1 and len(d["plants"]) == 10
    assert all(p.get("id") for p in d["plants"]), "place_plants gives every plant an id; a hand-written file would not"


def test_a_second_call_opens_the_same_demo_and_changes_nothing(demo):
    before = (demo["folder"] / "design.json").read_bytes()
    r = subprocess.run([sys.executable, os.path.join(TOOLS, "project.py"), "demo", "--open"],
                       env=demo["env"] | {"PEDON_PROJECT": ""}, capture_output=True, text=True, timeout=60)
    assert r.returncode == 0 and json.loads(r.stdout)["created"] == "demo-garden", r.stdout + r.stderr
    assert (demo["folder"] / "design.json").read_bytes() == before
