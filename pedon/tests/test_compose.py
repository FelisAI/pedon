"""Drawn masses become plants by the SHARED rules (tools/compose.py).

Without it, designing a garden from the ground up means writing dozens of coordinates
by hand and a private spacing checker. compose.py keeps the designer's call — which
species, how many, the shape of each drift — and places the plants through that shape.
These tests hold it to the rules the validator judges by, not to its own.
"""
import pytest
import json
import math
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import agent  # noqa: E402
import compose  # noqa: E402
import replant  # noqa: E402
from geom import point_in_polygon  # noqa: E402

BED = [[0, 0], [6, 0], [6.5, 2], [6, 4], [0, 4], [-0.5, 2]]


def design(**extra):
    d = {"version": 1, "units": "meters", "beds": [{"id": "b", "polygon": BED}],
         "paths": [], "patios": [], "plants": [], "edges": [], "steps": [], "objects": []}
    d.update(extra)
    return d


def pos(ops):
    return [p["position"] for op in ops if op["tool"] == "place_plants" for p in op["input"]["plants"]]


def test_a_mass_fills_its_own_shape_evenly():
    comp = {"masses": [{"species": "Thymus vulgaris", "count": 9, "bed": "b", "ellipse": [3, 2, 1.4, 0.7, 20]}]}
    ops, new, rep = compose.compose(design(), comp)
    pts = pos(ops)
    assert len(pts) == 9
    shape = compose.ellipse(3, 2, 1.4, 0.7, 20)
    assert all(point_in_polygon(x, y, shape) for x, y in pts), "a drift left the outline it was drawn with"
    # EVENLY, by the drift's own pitch (count and shape are the designer's), never a spacing
    # formula of compose's own: no pair far closer than the rest
    closest = min(math.dist(a, b) for i, a in enumerate(pts) for b in pts[i + 1:])
    assert closest >= 0.5 * rep["masses"][0]["on_centre_m"], (closest, rep["masses"][0])
    # spread THROUGH the shape, not clumped at its centre: both ends of the long axis are used
    t = math.radians(20)
    along = [(x - 3) * math.cos(t) + (y - 2) * math.sin(t) for x, y in pts]
    assert min(along) < -0.7 and max(along) > 0.7, f"the drift collapsed to its middle: {along}"
    assert rep["problems"] == []


def test_too_many_for_the_shape_is_measured_not_refused():
    """Twelve rosemary in a metre and a half is the designer's call — the report
    says how tight it is, in the plants' own spreads, and leaves it there."""
    comp = {"masses": [{"species": "Salvia rosmarinus", "count": 12, "bed": "b", "ellipse": [3, 2, 0.8, 0.6, 0]}]}
    _, _, rep = compose.compose(design(), comp)
    assert not rep["problems"], rep["problems"]
    assert rep["masses"][0]["on_centre_of_spread"] < 0.5, rep["masses"][0]


def test_a_collision_names_what_it_collided_with():
    """The only ground a plant takes from a drift is its own hole: a shape drawn round
    nothing but a rosemary's stem has room for one thyme, and says whose stem it is."""
    d = design(plants=[{"id": "r", "species": "Salvia rosmarinus", "common": "Rosemary", "position": [3, 2],
                        "mature_height_m": 1.4, "mature_spread_m": 1.5}])
    comp = {"masses": [{"species": "Thymus vulgaris", "count": 8, "bed": "b", "ellipse": [3, 2, 0.12, 0.12, 0]}]}
    _, _, rep = compose.compose(d, comp)
    assert "Rosemary" in rep["masses"][0].get("taken_by", {}), rep["masses"][0]
    assert rep["problems"] and "Rosemary" in rep["problems"][0], rep["problems"]


def test_no_plant_on_a_path_a_patio_or_a_stone():
    d = design(paths=[{"id": "w", "spline": [[-1, 2], [7, 2]], "width_m": 0.8}],
               patios=[{"id": "t", "polygon": [[4.5, 2.5], [6, 2.5], [6, 4], [4.5, 4]]}],
               objects=[{"id": "s", "kind": "boulder", "position": [1.5, 3.2]}])
    comp = {"masses": [{"species": "Thymus vulgaris", "count": 30, "bed": "b"}]}
    ops, _, _ = compose.compose(d, comp)
    pts = pos(ops)
    assert pts
    for x, y in pts:
        assert not agent._near_corridor((x, y), [[-1, 2], [7, 2]], 0.4), f"{x, y} stands on the path"
        assert not point_in_polygon(x, y, d["patios"][0]["polygon"]), f"{x, y} stands on the terrace"
        assert math.dist((x, y), (1.5, 3.2)) >= compose.OBJECT_CLEAR_M, f"{x, y} buries the stone"
        assert point_in_polygon(x, y, BED)


def test_the_ops_go_through_the_one_write_path_clean():
    d = design()
    d["plants"] = [{"id": "old", "species": "Thymus vulgaris", "common": "Thyme", "position": [3, 2],
                    "mature_height_m": 0.3, "mature_spread_m": 0.6}]
    comp = {"replace_in": ["b"], "place": [{"species": "Rosemary", "at": [1.2, 2.0]}],
            "masses": [{"species": "Thymus vulgaris", "count": 6, "bed": "b", "ellipse": [4.2, 2, 1.2, 1.0, 0]}]}
    ops, new, rep = compose.compose(d, comp)
    assert ops[0] == {"tool": "remove_objects", "input": {"ids": ["old"]}}
    assert rep["removed"] == ["old"]
    site = {}
    for op in ops:
        d, _ = agent.execute(d, site, op["tool"], op["input"])
    assert len(d["plants"]) == 7 and not any(p["id"] == "old" for p in d["plants"])
    errors, warnings = agent.validate(d, site)
    assert not [e for e in errors if "planting hole" in e or "trunk" in e], "the validator refuses what compose placed"


def test_the_bed_reading_is_the_validators_own():
    comp = {"masses": [{"species": "Thymus vulgaris", "count": 5, "bed": "b", "ellipse": [3, 2, 1.0, 0.8, 0]}]}
    d = design()
    _, new, rep = compose.compose(d, comp)
    after = dict(d, plants=[dict(p, id=f"n{i}") for i, p in enumerate(new)])
    assert rep["beds"]["b"]["coverage"] == agent.bed_mature_coverage(after)["b"]["coverage"]


def test_a_species_is_found_by_either_name_and_an_unknown_one_is_refused():
    assert compose.species_record("Rosemary")["species"] == "Salvia rosmarinus"
    assert compose.species_record("salvia rosmarinus")["common"] == "Rosemary"
    try:
        compose.species_record("Plastic fern")
    except KeyError as e:
        assert "palette" in str(e)
    else:
        raise AssertionError("an unknown species became a plant")


def test_the_cli_writes_ops_and_exits_1_on_a_problem(tmp_path):
    src = tmp_path / "d.json"
    src.write_text(json.dumps(design()))
    comp = tmp_path / "c.json"
    comp.write_text(json.dumps({"design": str(src), "masses": [
        {"species": "Thymus vulgaris", "count": 500, "bed": "b", "ellipse": [3, 2, 0.8, 0.6, 0]}]}))
    out = tmp_path / "ops.json"
    cp = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "compose.py"), str(comp), "--ops", str(out)],
                        capture_output=True, text=True)
    assert cp.returncode == 1, cp.stderr
    assert json.loads(out.read_text())[0]["tool"] == "place_plants"
    assert "check-ops --ops-file" in json.loads(cp.stdout)["next"]


def test_a_drift_drawn_over_the_bed_edge_stays_in_the_bed():
    comp = {"masses": [{"species": "Thymus vulgaris", "count": 6, "bed": "b", "ellipse": [6.2, 2, 1.4, 1.2, 0]}]}
    ops, _, _ = compose.compose(design(), comp)
    pts = pos(ops)
    assert len(pts) == 6
    for x, y in pts:
        assert point_in_polygon(x, y, BED), f"{x, y} is outside the bed its drift belongs to"
        assert replant.dist_to_edge(x, y, BED) >= compose.INSET_M - 1e-9, f"{x, y} sits on the bed line"


def test_a_loose_drift_is_still_inset_from_the_bed_line():
    strip = [[0, 0], [4, 0], [4, 0.9], [0, 0.9]]
    d = design(beds=[{"id": "s", "polygon": strip}])
    comp = {"masses": [{"species": "Thymus vulgaris", "count": 10, "bed": "s", "loose": 0.9}]}
    ops, _, _ = compose.compose(d, comp)
    edge = min(replant.dist_to_edge(x, y, strip) for x, y in pos(ops))
    assert edge >= compose.INSET_M - 1e-9, f"a plant sits {edge:.2f} m from the bed line"


def test_a_bed_drawn_over_the_walk_is_trimmed_to_its_edge_and_split_by_it():
    d = design(beds=[], paths=[{"id": "w", "spline": [[-1, 2], [7, 2]], "width_m": 0.8}],
               patios=[{"id": "t", "polygon": [[4.5, 2.6], [6.5, 2.6], [6.5, 4.5], [4.5, 4.5]]}])
    comp = {"beds": [{"id": "rough", "outline": [[0, 0], [6, 0], [6, 4], [0, 4]], "mulch": "gravel"}],
            "masses": [{"species": "Thymus vulgaris", "count": 4, "bed": "rough_2", "ellipse": [2, 3.2, 1.5, 0.5, 0]}]}
    site = {"footprint": [[-3, -3], [0.5, -3], [0.5, 1.0], [-3, 1.0]]}
    ops, new, rep = compose.compose(d, comp, site=site)
    beds = {o["input"]["id"]: o["input"]["polygon"] for o in ops if o["tool"] == "upsert_bed"}
    assert set(beds) == {"rough", "rough_2"}, "a walk across the bed must leave two beds"
    edge = 0.4 + compose.TRIM_GAP_M
    for poly in beds.values():
        for x, y in poly:
            assert abs(y - 2) >= edge - 0.06, f"({x}, {y}) is on the walk"
            assert not (4.45 < x < 6.55 and 2.55 < y < 4.55) or abs(x - 4.45) < 0.08 or abs(y - 2.55) < 0.08, \
                f"({x}, {y}) is on the terrace"
            assert not (x < 0.5 and y < 1.0) or x >= 0.5 - 0.08 or y >= 1.0 - 0.08, f"({x}, {y}) is in the house"
    # the pieces MEET the walk: their edge sits at the walk's edge plus the gap, not short of it
    near = min(abs(y - 2) for poly in beds.values() for _, y in poly)
    assert near - 0.4 < 0.12, f"the bed stops {near - 0.4:.2f} m short of the walk"
    # and the masses plant the TRIMMED bed
    assert all(p["position"][1] > 2.4 for p in new)
    assert rep["drawn_beds"][0]["bed"] == "rough" and len(rep["drawn_beds"][0]["pieces"]) == 2


def test_the_count_is_the_designers_and_the_report_only_informs_it():
    """Code measures; the LLM decides (AGENTS.md). compose.py does not choose counts
    by formula ("on_centre") or share beds out by geometry ("tile"): it refuses to
    choose, and says how many would fit so the designer can."""
    for bad in ("on_centre", 0, None, 2.5):
        try:
            compose.compose(design(), {"masses": [{"species": "Thymus vulgaris", "count": bad, "bed": "b",
                                                   "ellipse": [3, 2, 1.5, 1.0, 0]}]})
        except ValueError as e:
            assert "yours" in str(e)
        else:
            raise AssertionError(f"compose accepted count={bad!r} and chose a number itself")
    _, new, rep = compose.compose(design(), {"masses": [
        {"species": "Thymus vulgaris", "count": 3, "bed": "b", "ellipse": [3, 2, 1.5, 1.0, 0]}]})
    m = rep["masses"][0]
    assert len(new) == 3, "it planted a number it was not given"
    assert m["fits_at_mature_spread"] == int(m["free_m2"] / (0.866 * 0.6 * 0.6)), m
    # and nothing it places leaves the outline the designer drew
    shape = compose.ellipse(3, 2, 1.5, 1.0, 0)
    assert all(point_in_polygon(*p["position"], shape) for p in new)



@pytest.mark.needs_site
def test_the_agent_can_see_a_plan_and_ask_for_the_arithmetic_without_writing(tmp_path):
    """The design agent has a plan view and a calculator as MCP tools, and
    compose_planting writes nothing — the agent sends the ops itself."""
    import view_mcp
    src = tmp_path / "d.json"
    src.write_text(json.dumps(design()))
    before = src.read_text()
    r = view_mcp.HANDLERS["plan"]({"design": str(src), "bounds": [-1, -1, 7, 5], "scale": 40})
    assert [c["type"] for c in r["content"]] == ["text", "image"]
    r = view_mcp.HANDLERS["compose_planting"]({"design": str(src), "masses": [
        {"species": "Thymus vulgaris", "count": 5, "bed": "b", "ellipse": [3, 2, 1.2, 0.8, 0]}]})
    body = json.loads(r["content"][0]["text"])
    assert [o["tool"] for o in body["ops"]] == ["place_plants"] and len(body["ops"][0]["input"]["plants"]) == 5
    assert r["content"][1]["type"] == "image"
    assert src.read_text() == before, "compose_planting wrote the design"
    r = view_mcp.HANDLERS["compose_planting"]({"design": str(src), "masses": [
        {"species": "Thymus vulgaris", "count": "on_centre", "bed": "b"}]})
    assert r.get("isError") and "yours" in r["content"][0]["text"]


def test_a_drift_can_be_drawn_as_a_PART_of_its_bed():
    """Ellipses guessed from a bed's bounding box miss the real bed — in one measured draft
    20 of 50 masses said "does not overlap its bed" or "room for only 0". So a mass may
    name a part of the bed instead: `along` its own long axis (0 at the south or west end)
    and `across` it (0 on the west or north side), and the report says which way it ran."""
    comp = {"masses": [
        {"species": "Thymus vulgaris", "count": 4, "bed": "b", "along": [0, 0.3]},
        {"species": "Salvia rosmarinus", "count": 1, "bed": "b", "along": [0.7, 1.0], "across": [0, 0.5]}]}
    ops, new, rep = compose.compose(design(), comp)
    thyme = [p["position"] for p in new if p["species"] == "Thymus vulgaris"]
    rosemary = [p["position"] for p in new if p["species"] == "Salvia rosmarinus"]
    assert len(thyme) == 4 and all(x < 1.7 for x, _ in thyme), f"the west third was not the west third: {thyme}"
    assert len(rosemary) == 1 and rosemary[0][0] > 4.0 and rosemary[0][1] > 1.9, \
        f"the east end's north half was not: {rosemary}"
    line = rep["masses"][0]
    assert "west to east" in line["part"], line
    assert rep["problems"] == []
