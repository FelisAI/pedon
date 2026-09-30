"""Intentional planning sizes survive catalogue sync without hiding physical errors."""
import copy
import agent
import plant_catalog
import pytest


@pytest.fixture
def design(monkeypatch):
    row = {"species": "Test shrub", "common": "Test shrub", "mature_height_m": 1,
           "mature_spread_m": 1, "cat_safe": None}
    monkeypatch.setattr(plant_catalog, "catalog", lambda: {"plants": [row]})
    return {"version": 1, "units": "meters", "beds": [], "paths": [], "plants": [
        {"id": "p1", "species": row["species"], "common": row["common"],
         "position": [0, 0], "mature_height_m": .7, "mature_spread_m": .8,
         "size_override": True},
        {"id": "p2", "species": row["species"], "common": row["common"],
         "position": [2, 0], "mature_height_m": .7, "mature_spread_m": .8},
    ]}


def test_sync_preserves_chosen_sizes_and_updates_other_plants(design):
    before = copy.deepcopy(design)
    after, _ = agent.execute(design, {}, "resync_palette", {})
    assert after["plants"][0] == before["plants"][0]
    assert after["plants"][1]["mature_spread_m"] == 1
    assert after["plants"][1]["mature_height_m"] == 1


def test_choice_is_valid_and_drift_warning_only_names_unedited_plant(design):
    errors, warnings = agent.validate(design, {})
    assert not [e for e in errors if e.startswith("schema:")], errors
    drift = [w for w in warnings if "palette now says" in w]
    assert len(drift) == 1 and "p2" in drift[0] and "p1" not in drift[0], drift
    assert "1 planted" in drift[0]


def test_override_cannot_bypass_dimension_or_planting_hole_validation(design):
    design["plants"][0]["mature_spread_m"] = -1
    assert any(e.startswith("schema:") for e in agent.validate(design, {})[0])
    design["plants"][0]["mature_spread_m"] = .8
    design["plants"][1]["position"] = [0, 0]
    assert any("planting hole" in e for e in agent.validate(design, {})[0])


def test_ops_offer_the_same_override_field_as_the_document():
    fields = agent.OPS_SCHEMA["properties"]["ops"]["items"]["properties"]["input"]["properties"]["plants"]["items"]["properties"]
    assert fields["size_override"]["type"] == "boolean"
