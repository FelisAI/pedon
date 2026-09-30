"""An agent's write keeps what it replaced.

A few accidental undos or a stray move can lose a design, and the user must be able to
recover it. The viewer archives the working design before every switch, restore and
New; an `apply-ops` that wrote straight over it and left no copy would leave an undo
past an agent's change with nothing behind it.
"""
import pytest
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import project  # noqa: E402  where the active site's files are
HISTORY = project.data("history")
DESIGN = project.data("design.json")


def run(ops, design=None):
    cmd = [sys.executable, os.path.join(ROOT, "tools", "site_api.py"), "apply-ops", json.dumps(ops)]
    if design:
        cmd += ["--design", design]
    out = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)
    return json.loads(out.stdout)


def snapshots():
    return set(os.listdir(HISTORY)) if os.path.isdir(HISTORY) else set()


@pytest.mark.needs_site
def test_the_working_design_is_archived_before_an_agent_overwrites_it(tmp_path):
    before_files = snapshots()
    before_bytes = open(DESIGN, "rb").read()      # EXACTLY as it was: the tripwire compares bytes
    before = json.loads(before_bytes)
    plant = before["plants"][0]
    op = [{"tool": "remove_objects", "input": {"ids": [plant["id"]]}},
          {"tool": "place_plants", "input": {"plants": [{k: v for k, v in plant.items() if k != "id"}]}}]
    r = run(op)
    assert r["wrote"], r
    try:
        new = snapshots() - before_files
        assert new, "apply-ops wrote the working design and archived nothing"
        kept = json.load(open(os.path.join(HISTORY, sorted(new)[-1])))
        assert kept == before, "the archived copy is not the design that was replaced"
    finally:
        # put the working design back EXACTLY as it was — its bytes, not a re-serialisation,
        # which the tripwire (tests/conftest.py) rightly reads as a changed file — and take
        # this test's snapshot back out of the history
        with open(DESIGN, "wb") as f:
            f.write(before_bytes)
        for n in snapshots() - before_files:
            os.remove(os.path.join(HISTORY, n))
        for f in snapshots() - before_files:
            os.remove(os.path.join(HISTORY, f))


@pytest.mark.needs_site
def test_a_scratch_file_is_not_archived(tmp_path):
    before_files = snapshots()
    scratch = str(tmp_path / "scratch.json")
    d = json.load(open(DESIGN))
    with open(scratch, "w") as f:
        json.dump(d, f)
    plant = d["plants"][0]
    r = run([{"tool": "remove_objects", "input": {"ids": [plant["id"]]}}], design=scratch)
    assert r["wrote"], r
    assert snapshots() == before_files, "editing a scratch file filled the owner's history"


def test_the_runner_archives_only_the_working_design_and_only_when_it_holds_something(tmp_path, monkeypatch):
    """agent.save() must not copy ANY file it saves into data/history, or a variant's
    empty starting file appears in the history as a past version of the garden."""
    import agent
    monkeypatch.setattr(agent, "ROOT", str(tmp_path))
    monkeypatch.setenv("PEDON_PROJECT", str(tmp_path / "data"))      # history/ is the project's
    working = tmp_path / "data" / "design.json"
    working.parent.mkdir(parents=True)
    monkeypatch.setattr(agent, "DESIGN_PATH", str(working))
    hist = tmp_path / "data" / "history"
    variant = tmp_path / "data" / "designs" / "v.json"
    variant.parent.mkdir(parents=True)
    empty = {"version": 1, "beds": [], "paths": [], "plants": []}
    full = {"version": 1, "beds": [{"id": "b", "polygon": [[0, 0], [1, 0], [1, 1]]}], "paths": [], "plants": []}
    variant.write_text(json.dumps(full))
    agent.save(dict(full), str(variant))
    assert not hist.exists() or not list(hist.iterdir()), "a variant was archived as the working design"
    working.write_text(json.dumps(empty))
    agent.save(dict(full), str(working))
    assert not hist.exists() or not list(hist.iterdir()), "an empty working design was archived"
    agent.save(dict(full), str(working))
    assert len(list(hist.iterdir())) == 1, "replacing the working design left no copy"
