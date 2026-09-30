"""Projects: where a site's files live, and how a new one starts.

A new site is a new project, not a second checkout. A project is a folder under
projects/, `data/…` is a virtual path into the ACTIVE one, and the shared names in
schema/project_layout.json stay in the checkout.
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))
import project  # noqa: E402


@pytest.fixture
def sandbox(tmp_path, monkeypatch):
    """projects/ in a temp folder, and no project active from the caller's shell."""
    monkeypatch.setattr(project, "PROJECTS", str(tmp_path / "projects"))
    monkeypatch.setattr(project, "ACTIVE_FILE", str(tmp_path / "projects" / ".active"))
    monkeypatch.setattr(project, "LIBRARY", str(tmp_path / "library"))
    monkeypatch.delenv("PEDON_PROJECT", raising=False)
    return tmp_path


def test_with_no_project_everything_is_where_it_always_was(sandbox):
    assert project.active() is None
    assert project.data("design.json") == os.path.join(project.ROOT, "data", "design.json")
    assert project.resolve("data/designs/x.json") == os.path.join(project.ROOT, "data", "designs", "x.json")


def test_a_new_project_is_empty_and_becomes_where_data_points(sandbox):
    slug = project.create("12 Oak Lane")
    assert slug == "12-oak-lane"
    folder = os.path.join(sandbox, "projects", slug)
    design = json.load(open(os.path.join(folder, "design.json")))
    assert design["plants"] == [] and design["beds"] == [], "a new project carries someone's garden"
    assert not os.path.exists(os.path.join(folder, "site.json")), "a site is the owner's to give"
    assert json.load(open(os.path.join(folder, "project.json")))["name"] == "12 Oak Lane"
    project.activate(slug)
    assert project.active() == slug
    assert project.data("design.json") == os.path.join(folder, "design.json")
    assert project.resolve("data/designs/a.json") == os.path.join(folder, "designs", "a.json")
    assert project.resolve("review/t/x.png") == os.path.join(folder, "review", "t", "x.png")
    # the catalogue and the models are the user's LIBRARY's, shared by every project
    assert project.data("plant_palette.json") == os.path.join(sandbox, "library", "plant_palette.json")
    assert project.resolve("assets/plants/x.glb") == os.path.join(sandbox, "library", "assets", "plants", "x.glb")
    assert project.resolve("tools/x.py") == os.path.join(project.ROOT, "tools", "x.py")


def test_names_never_collide_and_never_escape(sandbox):
    a, b = project.create("Oak"), project.create("Oak")
    assert (a, b) == ("oak", "oak-2")
    with pytest.raises(ValueError):
        project.activate("../etc")
    with pytest.raises(ValueError):
        project.activate("nope")
    with pytest.raises(ValueError):
        project.folder("../../x")
    assert project.slugify("  ") == "site"


def test_the_env_wins_over_the_switch(sandbox, monkeypatch):
    project.activate(project.create("One"))
    project.create("Two")
    monkeypatch.setenv("PEDON_PROJECT", "two")
    assert project.data("design.json").endswith(os.path.join("projects", "two", "design.json"))


def test_listing_names_what_a_person_called_it(sandbox):
    project.create("Grandma's hillside")
    rows = project.listing()
    assert rows == [{"slug": "grandma-s-hillside", "name": "Grandma's hillside", "has_capture": False}]


def test_a_long_lived_process_follows_a_switch(sandbox, monkeypatch):
    """The MCP server lives across a switch in the viewer: agent.follow_project() must
    re-point the working design, not keep writing the old project's."""
    import agent
    # every global follow_project() touches, put back after the test however it ends —
    # a later test must not inherit this one's switch
    for name in ("DESIGN_PATH", "SITE_PATH", "_FOLLOWING", "_TERRAIN", "_SCAN"):
        monkeypatch.setattr(agent, name, getattr(agent, name))
    agent.follow_project()
    first = agent.DESIGN_PATH
    project.activate(project.create("Elsewhere"))
    agent.follow_project()
    assert agent.DESIGN_PATH == os.path.join(sandbox, "projects", "elsewhere", "design.json")
    assert agent.SITE_PATH == os.path.join(sandbox, "projects", "elsewhere", "site.json")
    os.remove(project.ACTIVE_FILE)
    agent.follow_project()
    assert agent.DESIGN_PATH == first, "switching back did not come back"


def test_the_cli_makes_and_opens_one(sandbox, monkeypatch, capsys):
    assert project.main(["new", "Test Site", "--open"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["created"] == "test-site" and out["active"] == "test-site"


def test_nothing_finds_a_sites_files_but_the_resolver():
    """A literal join of the checkout to "data" reads whichever folder the code was written
    for, not the active site — and escapes a test's sandbox, where it can rewrite the
    owner's real site.json. The same for the LIBRARY: a join of the checkout to "assets" or
    to the catalogue finds nothing, because the app ships no assets, and a test that does it
    fails only once the library has moved. So every tool, every test and the viewer's server
    are read, and only the resolvers — and the tests OF the resolvers, which pin the
    single-site fallback — may join the checkout."""
    import re
    root = project.ROOT
    joined = re.compile(
        r"""join\((?:\w+\.)?(?:ROOT|REPO|repoRoot|HERE)\s*,\s*["'](?:data|assets)["']"""   # join(ROOT, "data"…)
        r"""|join\((?:ROOT|repoRoot),\s*(?:MANIFEST_URL|m\.file|meta\.file|file\b)"""     # join(ROOT, <an app path>)
        r"""|new URL\(["'](?:\.\./)+(?:data|assets)/""")                                # new URL("../../data/…")
    # join(ROOT, <a value>): a path held by a reply or a record is an APP path —
    # "data/photoreal/scene.glb" — and only the resolver knows where that is; joined to the
    # checkout it hides the AR export and photoreal's scene for every site, because sites live
    # outside it. A join to a name the code lists itself (its own docs, its own tools) is the
    # app's own file.
    held = re.compile(r"""join\((?:\w+\.)?(?:ROOT|REPO|repoRoot|HERE)\s*,\s*(?!["'\s])([^,)]+)""")
    own_names = {("tools/capability_check.py", "n"), ("tests/test_hardening_advertised.py", "n"),
                 ("tests/test_hardening_advertised.py", "tool"), ("tests/test_hardening_advertised.py", "t"),
                 ("tests/test_no_site_json.py", "name"), ("tests/test_tripwire.py", "name"),
                 ("tests/test_agent_arrangement.py", "doc")}      # the app's own docs a brief names
    owners = {"tools/project.py", "viewer/project_paths.js",
              "tests/test_project.py", "tests/js/project_paths.test.mjs"}
    files = []
    for folder, exts in (("tools", (".py", ".mjs")), ("viewer", (".js",)), ("viewer/src", (".js",)),
                         ("tests", (".py",)), ("tests/js", (".mjs",)), ("tests/js/lib", (".mjs",))):
        files += [f"{folder}/{n}" for n in sorted(os.listdir(os.path.join(root, folder))) if n.endswith(exts)]
    # presence, not a count: a count drifts every time a file moves out
    must = {"tools/agent.py", "tools/preview_agreement.mjs", "viewer/vite.config.js",
            "viewer/src/plants.js", "tests/test_asset_store.py", "tests/js/plants.test.mjs"}
    assert must <= set(files), f"the guard no longer reads {sorted(must - set(files))}"
    bad = []
    for rel in files:
        if rel in owners:
            continue
        src = open(os.path.join(root, rel)).read()
        bad += [f"{rel}: {m.group(0)}" for m in joined.finditer(src)]
        bad += [f"{rel}: {m.group(0)}" for m in held.finditer(src) if (rel, m.group(1).strip()) not in own_names]
        # the Node tools too, not only the .py files: a .mjs tool that names a data/ path
        # without the resolver reads <checkout>/data/design.json, which is not there, and crashes
        if rel.startswith("tools/") and rel.endswith(".mjs") and re.search(r'"data/', src) \
                and "project_paths" not in src:
            bad.append(f"{rel}: names a data/ path without viewer/project_paths.js")
    assert not bad, "found a site's or the library's files without the resolver:\n  " + "\n  ".join(bad)


def test_sites_live_outside_the_checkout_by_default(monkeypatch):
    """A clone of the source must never hold a site, and a site must survive a new
    clone or a branch switch — so the projects folder defaults to ~/PEDON, not the checkout."""
    import importlib
    monkeypatch.delenv("PEDON_PROJECTS", raising=False)
    fresh = importlib.reload(project)
    try:
        assert fresh.PROJECTS == os.path.expanduser("~/PEDON")
        assert not fresh.PROJECTS.startswith(fresh.ROOT + os.sep)
        monkeypatch.setenv("PEDON_PROJECTS", "/tmp/elsewhere")
        assert importlib.reload(project).PROJECTS == "/tmp/elsewhere"
    finally:
        monkeypatch.delenv("PEDON_PROJECTS", raising=False)
        importlib.reload(project)
