"""Whether cats have the run of a garden is the SITE's to say (project.json "policy"), not the
library's. A rule in the shared plant catalogue would let one garden's cats keep lavender out
of every site using the library — the demo garden's starter bed would be refused."""
import json

import agent
import plant_catalog
import project

LAVENDER = {"id": "p1", "species": "Lavandula angustifolia", "common": "English lavender",
            "form": "mound", "mature_height_m": 0.6, "mature_spread_m": 0.8, "position": [1, 1]}


def _site_folder(tmp_path, name, policy):
    folder = tmp_path / name
    folder.mkdir()
    (folder / "project.json").write_text(json.dumps({"name": name, **({"policy": policy} if policy else {})}))
    return str(folder)


def test_the_fixture_knows_lavender_is_toxic_to_cats():
    # the premise, checked: the tests below mean nothing if the catalogue does not say so
    assert plant_catalog.lookup("Lavandula angustifolia")["cat_safe"] is False


def test_a_site_with_cats_refuses_a_plant_known_toxic_to_them(tmp_path, monkeypatch):
    monkeypatch.setenv("PEDON_PROJECT", _site_folder(tmp_path, "with-cats", {"cats_have_access": True}))
    errors, _ = plant_catalog.plant_issues({"plants": [LAVENDER]})
    assert errors and "toxic to cats" in errors[0], errors
    errs, _ = agent.validate({"plants": [LAVENDER]}, {})
    assert any("toxic to cats" in e for e in errs), errs


def test_a_site_without_cats_plants_it(tmp_path, monkeypatch):
    monkeypatch.setenv("PEDON_PROJECT", _site_folder(tmp_path, "no-cats", None))
    assert plant_catalog.plant_issues({"plants": [LAVENDER]}) == ([], [])


def test_two_sites_on_one_library_each_keep_their_own_rule(tmp_path):
    cats = _site_folder(tmp_path, "cats", {"cats_have_access": True})
    none = _site_folder(tmp_path, "none", {})
    assert project.policy(cats) == {"cats_have_access": True} and project.policy(none) == {}
    assert plant_catalog.plant_issues({"plants": [LAVENDER]}, project.policy(cats))[0]
    assert not plant_catalog.plant_issues({"plants": [LAVENDER]}, project.policy(none))[0]


def test_a_catalogue_that_still_carries_a_policy_brings_no_cats_with_it(tmp_path, monkeypatch):
    # a catalogue may carry "project_policy" inside it; it must not reach a site that states none
    old = json.load(open(plant_catalog.PALETTE))
    old["project_policy"] = {"cats_have_access": True}
    path = tmp_path / "old_palette.json"
    path.write_text(json.dumps(old))
    monkeypatch.setattr(plant_catalog, "PALETTE", plant_catalog.Path(path))
    monkeypatch.setenv("PEDON_PROJECT", _site_folder(tmp_path, "plain", None))
    assert plant_catalog.plant_issues({"plants": [LAVENDER]}) == ([], [])
