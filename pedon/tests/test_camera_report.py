"""Where a camera stands and what it frames.

A saved camera is the owner's and is never moved, but it can outlive the walk it was saved from:
left standing inside a bed and aimed at it, a sheet made to judge the next bed shows the wrong
garden. What a session needs is to be TOLD, against the design it is judging, where each one
stands and what it frames. And the camera the look gate
suggests for a place nobody looked at stands where a person stands — on a walk or a patio,
looking at the place — not five metres along a compass bearing, in whatever is there.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import agent  # noqa: E402

# a bed between two walks, a patio at its foot, and a second bed across the east walk
DESIGN = {
    "paths": [{"id": "west_walk", "spline": [[0, 0], [0, 10]], "width_m": 1.0},
              {"id": "east_walk", "spline": [[4, 0], [4, 10]], "width_m": 1.0}],
    "patios": [{"id": "seat", "polygon": [[0.6, -2], [3.4, -2], [3.4, -0.6], [0.6, -0.6]]}],
    "beds": [{"id": "middle", "polygon": [[0.6, 0], [3.4, 0], [3.4, 10], [0.6, 10]]},
             {"id": "far", "polygon": [[4.6, 0], [8, 0], [8, 10], [4.6, 10]]}],
}


def test_a_camera_inside_a_bed_is_said_to_be_there():
    rep = agent.camera_report({"eye": [6, 5, 1.65], "look": [6, 9], "fov": 55}, DESIGN)
    assert rep["stands"].startswith("inside bed far"), rep


def test_a_camera_on_a_walk_names_the_walk_and_the_bed_it_frames():
    rep = agent.camera_report({"eye": [0.2, 5, 1.65], "look": [2, 5], "fov": 55}, DESIGN)
    assert rep["stands"] == "on path west_walk", rep
    assert rep["aimed_at"] == "middle", rep
    assert rep["frames"] and rep["frames"][0].startswith("middle"), rep


def test_a_camera_aimed_up_the_far_bed_does_not_claim_the_middle_one():
    # a camera left standing at the far bed's edge, looking up it
    rep = agent.camera_report({"eye": [6, 1, 1.65], "look": [6.5, 9], "fov": 55}, DESIGN)
    assert rep["aimed_at"] == "far", rep
    assert not any(f.startswith("middle") for f in rep["frames"][:1]), rep


def test_the_suggested_camera_stands_on_paving_and_sees_the_place():
    cam = agent.look_here(2.0, 5.0, footprint=[], design=DESIGN)
    x, y = cam["eye"][:2]
    rep = agent.camera_report({"eye": cam["eye"], "look": cam["look_at"], "fov": 55}, DESIGN)
    assert rep["stands"].startswith(("on path", "on patio")), (cam, rep)
    assert agent.sees({"eye": cam["eye"], "look": cam["look_at"], "fov": 55}, (2.0, 5.0))
    assert 1.9 <= ((x - 2.0) ** 2 + (y - 5.0) ** 2) ** 0.5 <= 8.0, cam


def test_a_camera_above_head_height_is_a_deck_or_window_not_a_bed():
    """The owner's deck view stands 4.6 m over a bed: a person is on the deck, not in the bed."""
    rep = agent.camera_report({"eye": [6, 5, 4.6], "look": [2, 5, 0.3], "fov": 55}, DESIGN)
    assert rep["stands"].startswith("raised 4.6 m over bed far"), rep


def test_list_viewpoints_says_where_each_saved_view_stands_and_what_it_frames(monkeypatch, tmp_path):
    """The report reaches the reader who chooses a camera — a pure function is half a guard."""
    import json
    import view_mcp
    d = tmp_path / "judged.json"
    d.write_text(json.dumps(DESIGN))
    monkeypatch.setattr(view_mcp, "saved_viewpoints", lambda: [
        {"name": "up the far bed", "eye": [6, 1, 1.65], "look_at": [6.5, 9, 0.3]},
        {"name": "from the west walk", "eye": [0.2, 5, 1.65], "look_at": [2, 5, 0.3]}])
    body = json.loads(view_mcp.do_list({"design": str(d)})["content"][0]["text"])
    far, west = body["saved_views"]
    assert far["stands"].startswith("inside bed far") and far["frames"][0].startswith("far"), far
    assert west["stands"] == "on path west_walk" and west["frames"][0].startswith("middle"), west


def test_a_raised_camera_frames_the_bed_it_looks_at_not_the_one_under_the_window():
    # the sun room, in miniature: 3.2 m up at the west walk, aimed into the far bed
    rep = agent.camera_report({"eye": [0.2, 5, 3.2], "look": [6, 5, 0.3], "fov": 55}, DESIGN)
    assert rep["frames"] and rep["frames"][0].startswith("far"), rep
