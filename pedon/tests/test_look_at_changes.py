"""The design agent must LOOK AT WHAT IT CHANGED, not just look.

A "look before you finish" check that passes on any render does not require a render of
the part that changed, and a look that is not at the right thing proves nothing.

Measured over design runs: 73% of edits had no look before them, and the looks beat random
cameras by only 0.64 m against 0.93. So passing on any rendered frame in the round is not
enough; each changed place needs a frame aimed at it.
"""
import pytest
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import project  # noqa: E402  where the active site's files are
sys.path.insert(0, os.path.join(ROOT, "tools"))

import agent  # noqa: E402


def test_changes_are_where_things_were_added_moved_reshaped_or_removed():
    before = {"plants": [{"id": "p1", "position": [1, 1]}, {"id": "p2", "position": [5, 5]}],
              "beds": [{"id": "b1", "polygon": [[20, 20], [24, 20], [24, 24]]}],
              "paths": []}
    after = {"plants": [{"id": "p1", "position": [1, 1]}, {"id": "p2", "position": [7, 5]},
                        {"id": "p3", "position": [40, 2]}],
             "beds": [],
             "paths": [{"id": "w", "spline": [[0, 30], [6, 30]]}]}
    got = set(agent.changed_places(before, after))
    assert (1.0, 1.0) not in got, "an untouched plant counts as a change"
    assert {(5.0, 5.0), (7.0, 5.0)} <= got, "a moved plant must be seen where it was AND where it is"
    assert (40.0, 2.0) in got, "an added plant is not a change"
    assert {(20.0, 20.0), (24.0, 24.0)} <= got, "a removed bed is not a change"
    assert {(0.0, 30.0), (6.0, 30.0)} <= got, "a new path is not a change"


def test_a_frame_sees_the_middle_of_its_wedge_near_enough_to_judge():
    v = {"eye": [0, 0], "look": [10, 0], "fov": 55}
    assert agent.sees(v, (8, 1))
    assert not agent.sees(v, (-5, 0)), "a point BEHIND the camera counted as seen"
    assert not agent.sees(v, (40, 0)), "a point 40 m off counted as seen"
    assert not agent.sees(v, (5, 6)), "a point at the very edge of the frame counted as looked at"
    assert agent.sees(v, (0.2, 0.1)), "standing on it is having seen it"


def test_only_frames_after_the_last_edit_count(tmp_path):
    """A look before the round's last apply-ops was at a garden that is no longer there."""
    log = tmp_path / "calls.log"
    rows = [{"cmd": "look", "rendered": True, "views": [{"eye": [0, 0], "look": [10, 0], "fov": 55}]},
            {"cmd": "apply-ops", "args": {}},
            {"cmd": "look", "rendered": False, "views": [{"eye": [0, 0], "look": [0, 10], "fov": 55}]},
            {"cmd": "walk_through", "rendered": True,
             "views": [{"eye": [0, 0], "look": [-10, 0], "fov": 62}, {"eye": [1, 1], "look": None}]}]
    log.write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    got = agent.views_after_last_edit(str(log), 0)
    assert got == [{"eye": [0, 0], "look": [-10, 0], "fov": 62}], got


def test_every_changed_cell_must_be_looked_at_and_the_miss_says_where():
    changes = [(10, 10), (11, 11), (30, 30), (31, 30)]
    views = [{"eye": [4, 4], "look": [10, 10], "fov": 55}]
    missed = agent.unseen_changes(changes, views)
    assert [(x, y) for x, y, _ in missed] == [(30.5, 30.0)], missed
    fb = agent.unseen_feedback(missed)
    assert "(30.5, 30.0)" in fb and '"look_at": [30.5, 30.0, 0.5]' in fb
    # and the camera it suggests really would see it
    cam = agent.look_here(30.5, 30.0)
    assert agent.sees({"eye": cam["eye"], "look": cam["look_at"], "fov": 55}, (30.5, 30.0))
    assert agent.unseen_changes(changes, views + [{"eye": [25, 25], "look": [30, 30], "fov": 55}]) == []


def test_the_gate_asks_about_what_changed_not_just_whether_it_looked():
    """A pure function is half a guard: the loop must CALL it."""
    src = open(os.path.join(ROOT, "tools", "agent.py")).read()
    gate = src[src.index("# AND AT WHAT CHANGED"):src.index("mutations += applied")]
    assert "unseen_since_touched(changed_places(design_before_ops, design)," in gate
    assert "round_events(log_path, log_mark)" in gate
    assert "(looked is not True or missed)" in gate and "unseen_feedback(missed, design)" in gate


def test_every_look_logs_what_it_was_aimed_at(tmp_path, monkeypatch):
    """The gate can only ask where a look pointed if the log says so."""
    import view_mcp
    img = tmp_path / "v.jpg"
    img.write_bytes(b"\xff\xd8jpeg")
    monkeypatch.setattr(view_mcp, "CALL_LOG", str(tmp_path / "calls.log"))
    monkeypatch.setattr(view_mcp, "_post", lambda path, payload, timeout=45: {
        "ok": True, "id": "v1", "path": str(img),
        "meta": {"render_quality": "detailed", "growth": "mature", "camera_eye_enu": [1, 2],
                 "camera_look_enu": [9, 8], "fov_deg": 55, "camera_height_m": 1.65}})
    view_mcp.call_tool("look", {"eye": [1, 2, 1.65], "look_at": [9, 8, 0.5]})
    rec = json.loads((tmp_path / "calls.log").read_text().splitlines()[-1])
    assert rec["cmd"] == "look" and rec["rendered"] is True
    assert rec["views"] == [{"eye": [1, 2], "look": [9, 8], "fov": 55}]


def test_changes_are_read_from_the_fields_real_designs_use():
    """Every saved path, edge and step is a `spline`; a fixture that draws a path with
    `points`, a field no saved design has, passes while a moved path is never a change.
    Read a REAL saved design and move each kind of thing in it."""
    import copy
    import glob
    real = json.load(open(project.data("design.json")))
    for key in agent.DESIGN_KEYS:
        # chosen by the fields they HAVE, not by what the function can read — filtering on
        # the function under test would skip exactly the items it cannot see
        items = [i for i in real.get(key) or []
                 if isinstance(i, dict) and any(f in i for f in ("position", "polygon", "spline"))]
        if not items:
            continue
        moved = copy.deepcopy(real)
        target = moved[key][real[key].index(items[0])]
        for field in ("position", "polygon", "spline"):
            if field in target:
                v = target[field]
                target[field] = [v[0] + 3, v[1]] if field == "position" else [[q[0] + 3, q[1]] for q in v]
        assert agent.changed_places(real, moved), f"moving a {key[:-1]} is not a change the agent must look at"
    fields = {k for f in glob.glob(project.data("designs", "*.json"))
              for key in agent.DESIGN_KEYS for i in (json.load(open(f)).get(key) or []) if isinstance(i, dict)
              for k, v in i.items() if isinstance(v, list) and v and isinstance(v[0], list)}
    assert fields <= {"polygon", "spline"}, f"a geometry field the gate does not read: {fields - {'polygon', 'spline'}}"


def test_a_conversational_designer_can_hold_itself_to_the_same_rule(tmp_path):
    """Nothing else forces a conversational session to look; look_check is its gate."""
    import subprocess
    before, after, log = tmp_path / "b.json", tmp_path / "a.json", tmp_path / "calls.log"
    before.write_text(json.dumps({"plants": []}))
    after.write_text(json.dumps({"plants": [{"id": "p1", "position": [10, 10]}]}))
    log.write_text(json.dumps({"cmd": "apply-ops"}) + "\n")
    run = lambda: subprocess.run([sys.executable, os.path.join(ROOT, "tools", "look_check.py"), "check",
                                  "--before", str(before), "--after", str(after), "--since", "0"],
                                 capture_output=True, text=True, env={**os.environ, "YARDTWIN_CALL_LOG": str(log)})
    r = run()
    assert r.returncode == 1 and json.loads(r.stdout)["unseen"][0]["at"] == [10.0, 10.0], r.stdout
    with open(log, "a") as f:
        f.write(json.dumps({"cmd": "look", "rendered": True, "views": [{"eye": [5, 5], "look": [10, 10], "fov": 55}]}) + "\n")
    assert run().returncode == 0, "a look at the change was not counted"


def test_the_gate_reads_data_paths_as_the_active_sites(tmp_path):
    """DESIGNING.md writes `--after data/designs/VARIANT.json`; opened from the checkout,
    where no site lives, that path does not exist and look_check crashes. A site's files
    are found through project.py."""
    import subprocess
    site = tmp_path / "site"
    (site / "designs").mkdir(parents=True)
    (site / "designs" / "b.json").write_text(json.dumps({"plants": []}))
    (site / "designs" / "a.json").write_text(json.dumps({"plants": [{"id": "p1", "position": [10, 10]}]}))
    log = tmp_path / "calls.log"
    log.write_text(json.dumps({"cmd": "apply-ops"}) + "\n")
    r = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "look_check.py"), "check",
                        "--before", "data/designs/b.json", "--after", "data/designs/a.json", "--since", "0"],
                       capture_output=True, text=True, cwd=ROOT,
                       env={**os.environ, "YARDTWIN_CALL_LOG": str(log), "PEDON_PROJECT": str(site)})
    assert r.returncode == 1 and json.loads(r.stdout)["unseen"][0]["at"] == [10.0, 10.0], r.stdout + r.stderr


@pytest.mark.needs_site
def test_a_suggested_camera_stands_where_a_person_can():
    """A camera for a bed by the house wall must not stand inside the house, e.g. at (5.5, -14.6)."""
    fp = [[0, -20], [10, -20], [10, -5], [0, -5]]
    cam = agent.look_here(10.5, -9.6, footprint=fp)
    x, y = cam["eye"][:2]
    assert not (0 <= x <= 10 and -20 <= y <= -5), f"the camera {cam['eye']} stands inside the house"
    assert agent.scan_at(x, y) is not None, f"the camera {cam['eye']} stands off the scan"
    assert agent.sees({"eye": cam["eye"], "look": cam["look_at"], "fov": 55}, (10.5, -9.6))
    # and on the SCAN: at the south fence the south-west step lands where no ground was ever seen
    cam = agent.look_here(14.7, -15.5, footprint=[])
    assert agent.scan_at(*cam["eye"][:2]) is not None, f"the camera {cam['eye']} stands off the scan"


def _log(tmp_path, recs):
    p = tmp_path / "calls.log"
    p.write_text("".join(json.dumps(r) + "\n" for r in recs))
    return str(p)


def _apply(points):
    return {"cmd": "apply-ops", "args": {"ops": json.dumps([{"tool": "place_plants", "input": {
        "plants": [{"species": "x", "position": list(q)} for q in points]}}]), "ops_file": None}}


def _look(eye, at):
    return {"cmd": "look", "rendered": True, "views": [{"eye": eye, "look": at, "fov": 55}]}


def test_a_small_tweak_does_not_unsee_the_rest_of_the_garden(tmp_path):
    """Look, then tweak one corner: a gate that resets on any edit calls all 21 places unseen."""
    a, b = (10.0, 10.0), (40.0, 10.0)
    log = _log(tmp_path, [_apply([a, b]), _look([4, 10], [10, 10]), _look([34, 10], [40, 10]),
                          _apply([(40.3, 10.2)]), _look([34, 10], [40, 10])])
    ev = agent.round_events(log, 0)
    assert agent.unseen_since_touched([a, b], ev) == [], "a place seen after ITS last change was called unseen"
    # reading only frames after the round's last edit calls the untouched place unseen
    assert agent.unseen_changes([a, b], agent.views_after_last_edit(log, 0)), "fixture no longer shows the reset-on-any-edit failure"
    # the tweaked place still needs its own look after the tweak
    log2 = _log(tmp_path, [_apply([a, b]), _look([4, 10], [10, 10]), _look([34, 10], [40, 10]),
                           _apply([(40.3, 10.2)])])
    assert [m[:2] for m in agent.unseen_since_touched([a, b], agent.round_events(log2, 0))] == [(40.0, 10.0)]


def test_an_edit_that_cannot_be_placed_still_counts_as_touching_everything(tmp_path):
    a = (10.0, 10.0)
    rm = {"cmd": "apply-ops", "args": {"ops": json.dumps([{"tool": "remove_objects", "input": {"ids": ["p9"]}}])}}
    log = _log(tmp_path, [_apply([a]), _look([4, 10], [10, 10]), rm])
    assert agent.unseen_since_touched([a], agent.round_events(log, 0)), "a removal by id excused an earlier look"
    # and a place no logged edit touched needs a frame after the LAST edit of all
    c = (70.0, 10.0)
    log = _log(tmp_path, [_look([64, 10], [70, 10]), _apply([a])])
    assert agent.unseen_since_touched([c], agent.round_events(log, 0)), "a change never applied to the scratch was excused"



@pytest.mark.needs_site
def test_apply_ops_logs_where_it_changed_the_ground_even_for_a_removal(tmp_path):
    """Removals by id are common (17 of 29 edits in one measured round); the log says where."""
    import subprocess
    d = {"version": 1, "units": "meters", "beds": [], "paths": [], "patios": [], "edges": [], "steps": [],
         "objects": [], "plants": [{"id": "p1", "species": "Thymus vulgaris", "common": "Thyme",
                                    "position": [12.0, 3.0], "mature_height_m": 0.3, "mature_spread_m": 0.6}]}
    src = tmp_path / "d.json"
    src.write_text(json.dumps(d))
    log = tmp_path / "calls.log"
    env = dict(os.environ, YARDTWIN_CALL_LOG=str(log))
    ops = json.dumps([{"tool": "remove_objects", "input": {"ids": ["p1"]}}])
    cp = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "site_api.py"), "apply-ops", ops,
                         "--design", str(src)], capture_output=True, text=True, env=env)
    assert cp.returncode == 0, cp.stdout + cp.stderr
    row = json.loads(log.read_text().splitlines()[-1])
    assert row["touched"] == [[12.0, 3.0]], row.get("touched")
    ev = agent.round_events(str(log), 0)
    assert ev == [("edit", [(12.0, 3.0)])], "the gate did not read the measured place"
