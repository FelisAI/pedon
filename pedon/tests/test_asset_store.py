"""Object assets are files the agent can find or make.

Assets are not baked in: the LLM agent must be able to create a 3D asset itself or find
one somewhere.

Blender and the network are stood in for here (both are seconds each); the real runs —
fetching a Poly Haven lantern, making a trellis and a birdbath, the sandbox refusing the
network and a write outside its folder — are exercised outside this suite.
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import asset_store  # noqa: E402
import pytest  # noqa: E402

CATALOG = {
    "garden_gloves_01": {"name": "Garden Gloves 01", "tags": ["garden", "gloves"], "categories": ["props"],
                         "dimensions": [230, 300, 80], "polycount": 6822, "thumbnail_url": "t1"},
    "painted_wooden_bench": {"name": "Painted Wooden Bench", "tags": ["bench", "seat"], "categories": ["furniture"],
                             # HEAVIER than the gloves, so only the head-noun rule can put it first
                             "dimensions": [1160, 500, 890], "polycount": 9630, "thumbnail_url": "t2"},
    "stone_01": {"name": "Stone 01", "tags": ["stone", "rock"], "categories": ["rocks"],
                 "dimensions": [150, 90, 70], "polycount": 71916, "thumbnail_url": "t3"},
    "coastal_cliff_01": {"name": "Coastal Cliff 01", "tags": ["stone", "cliff"], "categories": ["rocks"],
                         "dimensions": [40000, 20000, 9000], "polycount": 2_400_000, "thumbnail_url": "t4"},
}


@pytest.fixture
def lib(tmp_path, monkeypatch):
    monkeypatch.setattr(asset_store, "LIB", str(tmp_path / "objects"))
    monkeypatch.setattr(asset_store, "ROOT", str(tmp_path))
    os.makedirs(asset_store.LIB)
    return tmp_path


def test_the_thing_asked_for_comes_before_things_that_share_a_word(lib):
    """'garden bench' must not find garden GLOVES first because they match 'garden' in the
    name. The last word names the thing; the rest qualify it."""
    got = asset_store.find("garden bench", catalog=CATALOG)["polyhaven"]
    assert got[0]["id"] == "painted_wooden_bench", [g["id"] for g in got]
    assert got[0]["size_m"] == [1.16, 0.5, 0.89], "Poly Haven sizes are millimetres"


def test_it_says_when_nothing_is_the_thing(lib):
    """'stone birdbath' matches stones. A match on the qualifier is not a birdbath — and
    saying so is what sends the agent to make_asset instead of placing a pebble."""
    got = asset_store.find("stone birdbath", catalog=CATALOG)
    assert got["polyhaven"], "stones do match the word 'stone'"
    assert "birdbath" in got.get("note", "") and "make_asset" in got["note"]
    assert "note" not in asset_store.find("wooden bench", catalog=CATALOG)


def test_a_model_too_heavy_for_a_phone_is_marked_and_ranked_last(lib):
    got = {g["id"]: g for g in asset_store.find("stone", catalog=CATALOG)["polyhaven"]}
    assert got["coastal_cliff_01"]["too_heavy"] and not got["stone_01"]["too_heavy"]


def test_offline_is_an_answer_not_a_crash(lib, monkeypatch):
    def down(*a, **k):
        raise OSError("no network")
    monkeypatch.setattr(asset_store, "polyhaven_catalog", down)
    got = asset_store.find("bench")
    assert got["polyhaven"] == [] and "could not be reached" in got["note"]


def test_the_library_lists_every_model_even_one_with_no_card(lib):
    """A scanned stone dropped into the folder by hand must not be invisible."""
    d = asset_store.LIB
    open(os.path.join(d, "my-stone.glb"), "wb").write(b"glTF")
    open(os.path.join(d, "trellis.glb"), "wb").write(b"glTF")
    json.dump({"name": "cedar trellis", "kind": "trellis", "size_m": [1.2, 0.07, 2]},
              open(os.path.join(d, "trellis.json"), "w"))
    got = {c["model"]: c for c in asset_store.library()}
    assert got["assets/objects/my-stone.glb"]["name"] == "my stone"
    assert got["assets/objects/trellis.glb"]["kind"] == "trellis"


def fake_blender(stats, lib_dir):
    """Stand in for Blender: write the model and picture where finish() would."""
    def run(script, args, work, sandboxed=True):
        slug = args[2]
        open(os.path.join(work, slug + ".glb"), "wb").write(b"glTF")
        open(os.path.join(work, slug + ".png"), "wb").write(b"\x89PNG")
        return stats
    return run


def test_a_made_model_at_the_wrong_size_is_refused_WITH_its_picture(lib, monkeypatch):
    """A script written in centimetres makes a 120 m trellis. Refused, and the picture
    comes back so the agent can see what it made."""
    monkeypatch.setattr(asset_store, "_blender", fake_blender({"size_m": [120, 7, 200], "triangles": 228}, lib))
    with pytest.raises(asset_store.AssetError) as e:
        asset_store.make("trellis", "pass", size_m=[1.2, 0.08, 2.0])
    assert "metres" in str(e.value) and e.value.preview and os.path.isfile(e.value.preview)
    assert not os.listdir(asset_store.LIB), "a refused model reached the library"


def test_a_made_model_too_heavy_for_a_phone_is_refused(lib, monkeypatch):
    monkeypatch.setattr(asset_store, "_blender", fake_blender({"size_m": [1, 1, 1], "triangles": 900_000}, lib))
    with pytest.raises(asset_store.AssetError, match="triangles"):
        asset_store.make("blob", "pass")


def test_a_made_model_goes_in_with_its_script_and_card(lib, monkeypatch):
    monkeypatch.setattr(asset_store, "_blender", fake_blender({"size_m": [1.23, 0.07, 2.0], "triangles": 228}, lib))
    card = asset_store.make("Cedar Trellis", "print('x')", size_m=[1.2, 0.08, 2.0], kind="trellis")
    assert card["model"] == "assets/objects/cedar-trellis.glb" and card["kind"] == "trellis"
    assert card["source"]["from"] == "made"
    for ext in (".glb", ".png", ".py", ".json"):
        assert os.path.isfile(os.path.join(asset_store.LIB, "cedar-trellis" + ext)), ext
    with pytest.raises(asset_store.AssetError, match="exists"):
        asset_store.make("Cedar Trellis", "print('x')")


def test_fetch_refuses_a_heavy_model_and_a_file_path_that_climbs_out(lib, monkeypatch):
    calls = []

    def get(url, timeout=30):
        calls.append(url)
        if "/info/heavy" in url:
            return json.dumps({"polycount": 2_000_000}).encode()
        if "/info/" in url:
            return json.dumps({"name": "Lantern", "polycount": 800, "authors": {"A. Maker": "All"}}).encode()
        if "/files/" in url:
            return json.dumps({"gltf": {"1k": {"gltf": {"url": "https://x/l.gltf", "include": {
                "l.bin": {"url": "https://x/l.bin"}, "../../evil.py": {"url": "https://x/evil"}}}}}}).encode()
        return b"data"
    monkeypatch.setattr(asset_store, "_get", get)
    with pytest.raises(asset_store.AssetError, match="triangles"):
        asset_store.fetch("heavy")
    seen = {}

    def blender(script, args, work, sandboxed=True):
        seen["files"] = sorted(os.listdir(os.path.dirname(args[0])))
        seen["sandboxed"] = sandboxed
        return fake_blender({"size_m": [0.2, 0.2, 0.5], "triangles": 800}, lib)(script, args, work, sandboxed)
    monkeypatch.setattr(asset_store, "_blender", blender)
    card = asset_store.fetch("Lantern_01", kind="lantern")
    assert "https://x/evil" not in calls, "a download path climbing out of the folder was fetched"
    assert seen["files"] == ["l.bin", "l.gltf"] and seen["sandboxed"]
    assert card["source"] == {"from": "polyhaven", "id": "Lantern_01", "url": "https://polyhaven.com/a/Lantern_01",
                              "license": "CC0", "authors": ["A. Maker"]}


def test_the_sandbox_names_REAL_paths(tmp_path):
    """/var is a link to /private/var and the sandbox matches the real path: named by the
    link, Blender cannot write even its own temp files."""
    prof = asset_store._sandbox_profile(str(tmp_path))
    assert f'(subpath "{os.path.realpath(tmp_path)}")' in prof
    assert "(deny network*)" in prof and "(deny file-write*)" in prof
    assert '"/var/' not in prof, "a /var path the sandbox will never match"


def test_the_design_agent_is_told_to_get_the_model_not_settle_for_a_placeholder():
    """The agent must build a missing model: its prompt may not call a placeholder
    "a correct outcome and not a failure", and it must name the asset tools it is offered."""
    import agent
    assert "correct outcome and not a failure" not in agent.SYSTEM
    for tool in ("find_asset", "fetch_asset", "make_asset"):
        assert tool in agent.EXPLORE_BRIEF, f"the explore brief never names {tool}"
        assert f"mcp__yardeye__{tool}" in agent.MCP_TOOLS, f"{tool} is not offered to the agent"
    assert "LOOK AT WHAT YOU CHANGED" in agent.EXPLORE_BRIEF, "the look-at-changes rule is enforced but never told"


# ── plant models ───────────────────────────────────────────────────
# The system creates a model on its own when a design needs one, and find/fetch/make
# covers plants as well as objects.
@pytest.fixture
def plants(lib, monkeypatch):
    d = lib / "plants"
    d.mkdir()
    # a GENERATED model, as tools/gen_trees.py writes it: no `source`
    (d / "manifest.json").write_text(json.dumps({"olive": {
        "name": "olive", "file": "assets/plants/olive.glb", "base_m": 0.0, "height_m": 4.0,
        "spread_m": 3.9, "tris": 655716, "form": "tree"}}))
    monkeypatch.setattr(asset_store, "PLANT_LIB", str(d))
    return d


def test_a_made_plant_model_goes_into_the_PLANT_library_with_a_manifest_entry(plants, monkeypatch):
    monkeypatch.setattr(asset_store, "_blender", fake_blender({"size_m": [0.92, 0.85, 0.31], "triangles": 41_000}, plants))
    got = asset_store.make("Sulfur Buckwheat", "print('x')", size_m=[0.9, 0.9, 0.3],
                           species="Eriogonum umbellatum")
    assert got["asset"] == "sulfur-buckwheat"
    for ext in (".glb", ".png", ".py"):
        assert (plants / f"sulfur-buckwheat{ext}").is_file(), ext
    assert not os.listdir(asset_store.LIB), "a plant model went into the OBJECT library"
    man = json.loads((plants / "manifest.json").read_text())
    e = man["sulfur-buckwheat"]
    # what the viewer's loader reads (assets.js ensureAssets / registerAsset)
    assert e["file"] == "assets/plants/sulfur-buckwheat.glb" and e["base_m"] == 0.0
    assert (e["height_m"], e["spread_m"], e["tris"]) == (0.31, 0.92, 41_000)
    assert e["species"] == "Eriogonum umbellatum" and e["source"]["from"] == "made"
    assert man["olive"]["tris"] == 655716, "adding a model rewrote the rest of the manifest"


def test_a_generated_library_model_is_never_replaced(plants, monkeypatch):
    monkeypatch.setattr(asset_store, "_blender", fake_blender({"size_m": [3, 3, 4], "triangles": 9000}, plants))
    with pytest.raises(asset_store.AssetError, match="gen_trees"):
        asset_store.make("olive", "pass", species="Olea europaea", replace=True)
    assert json.loads((plants / "manifest.json").read_text())["olive"]["tris"] == 655716


def test_a_generated_model_that_says_so_is_never_replaced_either(plants, monkeypatch):
    # gen_trees.py records where its models came from; the protection must not depend
    # on their saying nothing
    man = json.loads((plants / "manifest.json").read_text())
    man["olive"]["source"] = {"from": "generated", "script": "tools/gen_trees.py", "preset": "olive", "seed": 7}
    (plants / "manifest.json").write_text(json.dumps(man))
    monkeypatch.setattr(asset_store, "_blender", fake_blender({"size_m": [3, 3, 4], "triangles": 9000}, plants))
    with pytest.raises(asset_store.AssetError, match="gen_trees"):
        asset_store.make("olive", "pass", species="Olea europaea", replace=True)
    assert json.loads((plants / "manifest.json").read_text())["olive"]["tris"] == 655716


def test_a_made_plant_model_is_replaced_only_when_asked(plants, monkeypatch):
    monkeypatch.setattr(asset_store, "_blender", fake_blender({"size_m": [1, 1, 0.5], "triangles": 900}, plants))
    asset_store.make("mat", "pass", species="Eriogonum umbellatum")
    with pytest.raises(asset_store.AssetError, match="exists"):
        asset_store.make("mat", "pass", species="Eriogonum umbellatum")
    assert asset_store.make("mat", "pass", species="Eriogonum umbellatum", replace=True)["asset"] == "mat"


def test_a_plant_search_looks_at_plants_and_only_plants(plants):
    cat = dict(CATALOG, shrub_02={"name": "Shrub 02", "tags": ["bush", "leaves"],
                                  "categories": ["nature", "plants", "ground cover"],
                                  "dimensions": [900, 800, 600], "polycount": 52317, "thumbnail_url": "t5"},
               stone_shrub={"name": "Stone Shrub Ornament", "tags": ["shrub"], "categories": ["props"],
                            "dimensions": [300, 300, 400], "polycount": 900, "thumbnail_url": "t6"})
    got = asset_store.find("shrub", catalog=cat, plant=True)
    assert [c["id"] for c in got["polyhaven"]] == ["shrub_02"], "a prop called 'shrub' was offered as a plant"
    assert got["builtin_kinds"] == []
    got = asset_store.find("olive tree", catalog=cat, plant=True)
    assert [c["asset"] for c in got["library"]] == ["olive"], "the plant library was not searched"
