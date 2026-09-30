"""Viewpoints the OWNER placed — "the view from the kitchen window".

The owner places cameras anywhere in the space, so that a person or an LLM can
view the garden from the places the owner thinks matter.

The whole design decision is the FRAME. A saved viewpoint is stored in `look`'s
own convention — x, y, and a height ABOVE THE GROUND at that point — which means
a saved viewpoint IS a stored look() call. Expanding one is a lookup, not a
conversion, and no second frame exists anywhere to get wrong. This project's
nastiest bug class is ENU versus world (a coordinate stored in the wrong frame is
invisible until north is set), so a feature that introduces no new frame at all
is worth the constraint that produced it.

Height above ground rather than an absolute also means the camera FOLLOWS the
ground if the terrain is ever re-derived, which is what a garden viewpoint should
do, and it round-trips exactly because the same heightAt answers at capture and
at replay.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import geodata
import view_mcp


def test_viewpoints_are_OWNER_ground_truth():
    # exactly like landmarks and areas: nothing can re-derive which views the
    # owner cares about, and site.json is the file no tool can regenerate
    assert geodata.owner_of("viewpoints") == "owner"


def test_a_derived_writer_cannot_invent_one():
    try:
        geodata.merge_section({}, "derived", {"viewpoints": [{"name": "guess"}]})
    except ValueError as e:
        assert "viewpoints" in str(e)
    else:
        raise AssertionError("analyze_site was allowed to write viewpoints")


def test_a_fetched_writer_cannot_either():
    try:
        geodata.merge_section({}, "fetched", {"viewpoints": []})
    except ValueError:
        pass
    else:
        raise AssertionError("geodata was allowed to write viewpoints")


def test_an_unknown_name_says_what_IS_saved(monkeypatch):
    monkeypatch.setattr(view_mcp, "saved_viewpoints",
                        lambda: [{"name": "kitchen window", "eye": [9.5, -7, 3.2],
                                  "look_at": [15.2, -7.5, 0.5]}])
    out = json.dumps(view_mcp.do_look({"viewpoint": "the deck"}))
    assert "no saved viewpoint" in out
    # naming what exists is the difference between a dead end and a next step
    assert "kitchen window" in out
    # and it must say who places them, so nothing tries to invent one
    assert "owner" in out.lower()


def test_the_name_is_matched_case_insensitively(monkeypatch):
    # the owner types it into a prompt box; a model asks for it later, in its own case
    seen = {}
    monkeypatch.setattr(view_mcp, "saved_viewpoints",
                        lambda: [{"name": "Kitchen Window", "eye": [1, 2, 1.6],
                                  "look_at": [3, 4, 1.2]}])
    monkeypatch.setattr(view_mcp, "_post", lambda path, body, **kwargs: seen.update(body) or {"ok": False})
    view_mcp.do_look({"viewpoint": "kitchen window"})
    assert seen["eye"] == [1, 2, 1.6], "the saved eye was not used"
    assert seen["look_at"] == [3, 4, 1.2]


def test_a_saved_viewpoint_is_passed_through_UNCHANGED(monkeypatch):
    # the point of storing it in look's own convention: no conversion, so no
    # frame to get wrong. If this ever needs arithmetic, the frame has diverged.
    vp = {"name": "v", "eye": [9.5, -7.0, 3.2], "look_at": [15.2, -7.5, 0.5]}
    seen = {}
    monkeypatch.setattr(view_mcp, "saved_viewpoints", lambda: [vp])
    monkeypatch.setattr(view_mcp, "_post", lambda path, body, **kwargs: seen.update(body) or {"ok": False})
    view_mcp.do_look({"viewpoint": "v"})
    assert seen["eye"] is vp["eye"], "the eye was rebuilt rather than passed through"
    assert seen["look_at"] is vp["look_at"]


def test_list_viewpoints_names_the_saved_views_FIRST(monkeypatch):
    # everything else it lists is something the design or the site happens to
    # contain; a saved view is a statement about where the garden is judged from
    monkeypatch.setattr(view_mcp, "saved_viewpoints",
                        lambda: [{"name": "kitchen window", "eye": [1, 2], "look_at": [3, 4]}])
    text = view_mcp.do_list({})["content"][0]["text"]
    body = json.loads(text)
    assert list(body)[0] == "saved_views", f"saved views are not listed first: {list(body)}"
    assert body["saved_views"][0]["name"] == "kitchen window"


def test_the_tool_schema_advertises_it():
    # a parameter no model is told about is a parameter no model uses
    look = next(t for t in view_mcp.TOOLS if t["name"] == "look")
    props = look["inputSchema"]["properties"]
    assert "viewpoint" in props, "look() does not advertise the viewpoint parameter"
    desc = props["viewpoint"]["description"]
    assert "list_viewpoints" in desc, "it does not say how to find the names"


def test_a_missing_site_file_is_not_an_error(monkeypatch):
    # viewpoints are optional; a property with none must not break `look`
    monkeypatch.setenv("PEDON_PROJECT", "/nonexistent-path-for-this-test")
    assert view_mcp.saved_viewpoints() == []
