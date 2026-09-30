"""Moving a group of plants must keep the group.

A drag written as `remove_objects` + `place_plants` per plant loses the group:
`place_plants` always mints a fresh id, and `remove_objects` drops a removed id
from its group, so a five-plant group loses a member per plant and is deleted at
the fourth.

`set_plants` changes a plant IN PLACE and keeps its id, so a move, a species swap
or a model's revision never reaches the group at all.
"""
import copy
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import project  # noqa: E402  where the active site's files are
sys.path.insert(0, os.path.join(ROOT, "tools"))
import agent  # noqa: E402

# about a REAL site — skipped without the reference site (tests/conftest.py)
pytestmark = pytest.mark.needs_site


@pytest.fixture(scope="module")
def site():
    with open(project.data("site.json")) as f:
        return json.load(f)


def _daisy(pid, x, y):
    return {"id": pid, "species": "Erigeron glaucus", "common": "Seaside daisy",
            "position": [x, y], "mature_spread_m": 0.6, "mature_height_m": 0.25,
            "form": "perennial", "foliage": "#7f9280", "flower": "#d9c3dc"}


# A five-plant group taken from a real design: the ids, the positions, and a
# neighbour that is not in it.
GROUP = [("p110", 13.98, -10.92), ("p109", 13.74, -10.68), ("p108", 13.45, -10.82),
         ("p107", 13.18, -10.65), ("p95", 12.81, -10.49)]


def _design():
    return {"version": 1, "units": "meters", "beds": [], "paths": [], "patios": [],
            "plants": [_daisy(i, x, y) for i, x, y in GROUP] + [_daisy("p3", 11.0, -8.0)],
            "groups": [{"id": "grp_muhnz5hq", "name": "group 1",
                        "members": [i for i, _, _ in GROUP]}]}


def _moved(plant, dx, dy):
    return {**plant, "position": [round(plant["position"][0] + dx, 2),
                                  round(plant["position"][1] + dy, 2)]}


def test_moving_the_whole_group_keeps_the_group(site):
    """The drag of a whole group: every member moved by the same offset."""
    d = _design()
    for p in [q for q in d["plants"] if q["id"] != "p3"]:
        d, _ = agent.execute(d, site, "set_plants", {"plants": [_moved(p, 0.07, 0.84)]})
    assert d["groups"] == _design()["groups"], "the group changed when its plants moved"
    by_id = {p["id"]: p for p in d["plants"]}
    for i, x, y in GROUP:
        assert by_id[i]["position"] == [round(x + 0.07, 2), round(y + 0.84, 2)]


def test_the_old_way_still_loses_it(site):
    """The control. Without it the test above could pass because groups are never
    pruned at all — this is a move written as remove + place."""
    d = _design()
    for p in [q for q in d["plants"] if q["id"] != "p3"]:
        d, _ = agent.execute(d, site, "remove_objects", {"ids": [p["id"]]})
        new = {k: v for k, v in _moved(p, 0.07, 0.84).items() if k != "id"}
        d, _ = agent.execute(d, site, "place_plants", {"plants": [new]})
    assert d["groups"] == []


def test_a_plant_keeps_its_id_and_its_place_in_the_list(site):
    d = _design()
    out, msg = agent.execute(d, site, "set_plants", {"plants": [_moved(d["plants"][2], 1, 0)]})
    assert [p["id"] for p in out["plants"]] == [p["id"] for p in d["plants"]]
    assert "p108" in msg
    # nothing else in the design moved
    assert [p for p in out["plants"] if p["id"] != "p108"] == \
        [p for p in d["plants"] if p["id"] != "p108"]


def test_the_record_is_replaced_whole_so_a_swap_sheds_the_old_species(site):
    """Replace, like every other set_* op: a species swap that MERGED would keep the
    daisy's flower colour on a grass."""
    d = _design()
    grass = {"id": "p109", "species": "Muhlenbergia rigens", "common": "deergrass",
             "position": d["plants"][1]["position"], "mature_spread_m": 1.3,
             "mature_height_m": 1.3, "form": "grass"}
    out, _ = agent.execute(d, site, "set_plants", {"plants": [grass]})
    got = next(p for p in out["plants"] if p["id"] == "p109")
    assert got == grass
    assert out["groups"][0]["members"] == _design()["groups"][0]["members"]


def test_many_plants_in_one_op(site):
    d = _design()
    out, _ = agent.execute(d, site, "set_plants",
                           {"plants": [_moved(p, 0, 1) for p in d["plants"][:3]]})
    moved = {p["id"]: p["position"] for p in out["plants"][:3]}
    assert moved == {p["id"]: [p["position"][0], round(p["position"][1] + 1, 2)]
                     for p in d["plants"][:3]}


@pytest.mark.parametrize("plants, says", [
    ([{**_daisy("p999", 12, -9)}], "place_plants"),              # adds are place_plants
    ([{k: v for k, v in _daisy("p110", 12, -9).items() if k != "id"}], "id"),
    ([_daisy("p110", 12, -9), _daisy("p110", 12.5, -9)], "twice"),
    ([{**_daisy("p110", 12, -9), "species": ""}], "species"),
    ([{k: v for k, v in _daisy("p110", 12, -9).items() if k != "position"}], "position"),
    ([], "names no plant"),
])
def test_it_refuses_what_it_cannot_do_and_says_what_to_use(site, plants, says):
    d = _design()
    before = copy.deepcopy(d)
    with pytest.raises(ValueError, match=says):
        agent.execute(d, site, "set_plants", {"plants": plants})
    assert d == before


def test_a_bed_id_is_not_a_plant(site):
    d = _design()
    d["beds"] = [{"id": "bed_a", "polygon": [[10, -12], [15, -12], [15, -7], [10, -7]]}]
    with pytest.raises(ValueError, match="place_plants"):
        agent.execute(d, site, "set_plants", {"plants": [{**_daisy("bed_a", 12, -9)}]})


# ── a plant's model must exist ─────────────────────────────────────
def test_a_plant_may_name_a_model_the_library_has(site):
    d = _design()
    out, _ = agent.execute(d, site, "set_plants", {"plants": [{**d["plants"][0], "asset": "olive"}]})
    assert out["plants"][0]["asset"] == "olive"
    out, _ = agent.execute(d, site, "place_plants", {"plants": [
        {k: v for k, v in _daisy("x", 12.2, -9.2).items() if k != "id"} | {"asset": "olive"}]})
    assert out["plants"][-1]["asset"] == "olive"


@pytest.mark.parametrize("op", ["place_plants", "set_plants"])
def test_a_model_the_library_lacks_is_refused_with_the_way_to_get_one(site, op):
    """The viewer draws an unknown name as the generic shape without a word — so it
    is refused here, where the one who wrote it can hear why."""
    d = _design()
    pl = {**d["plants"][0], "asset": "no-such-model"}
    if op == "place_plants":
        pl = {k: v for k, v in pl.items() if k != "id"}
    with pytest.raises(ValueError, match="make_asset"):
        agent.execute(d, site, op, {"plants": [pl]})
