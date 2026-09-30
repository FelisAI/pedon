"""TWO PROPOSALS FOR ONE CORNER — and the one mistake here loses work.

Groups let the user compare alternative designs for one area of the site.
Each proposal is a separate group, with only the chosen proposal active.

Hiding is not enough: it is a drawing trick and does not remove geometry, so
every count still sees both proposals. Counting two measured proposals together
changes plants 205 -> 414 and density 0.43 -> 0.21 m2 per plant. So the document
declares the two mutually exclusive and everything that MEASURES resolves.

Everything that WRITES must not, and that asymmetry is what these tests are for.
"""
import json
import os
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import project  # noqa: E402  where the active site's files are
sys.path.insert(0, os.path.join(ROOT, "tools"))

import alternatives as A  # noqa: E402


def design(**over):
    d = {
        "version": 1, "units": "meters",
        "beds": [], "paths": [], "edges": [], "patios": [], "steps": [], "objects": [],
        "plants": [{"id": "p1", "species": "Salvia apiana", "position": [1, 1]},
                   {"id": "p2", "species": "Salvia apiana", "position": [2, 2]},
                   {"id": "p3", "species": "Salvia apiana", "position": [3, 3]}],
        "groups": [{"id": "gravel", "name": "gravel court",
                    "members": ["p1"], "alt_of": "east"},
                   {"id": "planted", "name": "planted",
                    "members": ["p2"], "alt_of": "east"}],
        "alternatives": {"east": "gravel"},
    }
    d.update(over)
    return d


def test_only_the_chosen_proposal_is_measured():
    got = A.active_design(design())
    assert [p["id"] for p in got["plants"]] == ["p1", "p3"], (
        "the proposal that was not chosen is still being counted")


def test_switching_the_choice_switches_the_garden():
    got = A.active_design(design(alternatives={"east": "planted"}))
    assert [p["id"] for p in got["plants"]] == ["p2", "p3"]


def test_an_undeclared_choice_is_still_ONE_garden():
    # the failure this exists to prevent must not arrive through the default:
    # a document that names alternatives and forgets to choose measures the
    # FIRST, never both
    got = A.active_design(design(alternatives={}))
    assert [p["id"] for p in got["plants"]] == ["p1", "p3"]
    got2 = A.active_design(design(alternatives={"east": "no_such_group"}))
    assert [p["id"] for p in got2["plants"]] == ["p1", "p3"], (
        "a choice naming a group that does not exist showed both proposals")


def test_an_object_in_BOTH_proposals_survives():
    # a shared object belongs to either proposal, and dropping it because one
    # of its groups loses would delete the part they agree on
    d = design()
    d["groups"][0]["members"] = ["p1", "p3"]
    d["groups"][1]["members"] = ["p2", "p3"]
    got = A.active_design(d)
    assert "p3" in [p["id"] for p in got["plants"]]


def test_a_design_with_no_alternatives_is_untouched():
    d = design(groups=[], alternatives={})
    assert A.active_design(d) is d, (
        "the common case pays for a feature it does not use")


def test_the_losing_group_goes_too():
    got = A.active_design(design())
    assert [g["id"] for g in got["groups"]] == ["gravel"], (
        "the tree would show a proposal with no geometry under it")


def test_plain_groups_are_never_touched():
    """A group without `alt_of` is a folder, not a proposal.

    Use TWO plain groups: if a mutation sweeps them into a single nameless set,
    one group alone wins and nothing is dropped, so the test cannot detect it.
    With two, the second one loses and its geometry disappears.
    """
    d = design()
    d["plants"].append({"id": "p4", "species": "Salvia apiana", "position": [4, 4]})
    d["groups"].append({"id": "stones", "name": "the triad", "members": ["p3"]})
    d["groups"].append({"id": "pots", "name": "the pots", "members": ["p4"]})
    got = A.active_design(d)
    kept = [g["id"] for g in got["groups"]]
    assert "stones" in kept and "pots" in kept, (
        f"a group with no alt_of was treated as a losing proposal: kept {kept}")
    ids = [p["id"] for p in got["plants"]]
    assert "p3" in ids and "p4" in ids, (
        f"geometry in a plain group was dropped: {ids}")


def test_the_validator_judges_one_garden():
    """The judge must not complain about geometry that is never built together.

    Asserting `not errs` on two proposals is insufficient if their union also
    produces no ERRORS: the mature-spread rejection is on the op path, not a
    whole-document sweep. The test must distinguish resolved alternatives from
    their union.

    `validate` DOES sweep for plants standing on a path. So: a path in one
    proposal, plants standing where it runs in the other. Built together that is
    a real fault; as alternatives it is two ideas for one strip of ground.
    """
    import agent
    base = {"version": 1, "units": "meters",
            "beds": [], "edges": [], "patios": [], "steps": [], "objects": []}
    path = {"id": "walk", "spline": [[0, 0], [6, 0]], "width_m": 0.8, "material": "gravel"}
    on_it = [{"id": f"q{i}", "species": "Salvia apiana", "position": [i, 0.0]}
             for i in range(1, 5)]

    def on_path(warnings):
        return [w for w in warnings if "stand ON path" in w]

    _, union = agent.validate(
        dict(base, paths=[path], plants=on_it, groups=[], alternatives={}), None)
    assert on_path(union), (
        "premise broken: the union no longer warns, so this test proves nothing")

    _, apart = agent.validate(dict(
        base, paths=[path], plants=on_it,
        groups=[{"id": "A", "members": ["walk"], "alt_of": "corner"},
                {"id": "B", "members": [p["id"] for p in on_it], "alt_of": "corner"}],
        alternatives={"corner": "A"}), None)
    assert not on_path(apart), (
        "the judge complained that plants stand on a path they are an "
        "ALTERNATIVE to — the two are never built together")


# ── THE ASYMMETRY: measuring resolves, writing never does ────────────────
def _run(*args, design_path=None):
    cmd = [sys.executable, os.path.join(ROOT, "tools", "site_api.py"), *args]
    if design_path:
        cmd += ["--design", design_path]
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)
    return r


def test_measuring_sees_one_proposal_and_the_file_keeps_both(tmp_path):
    """THE MISTAKE THAT LOSES WORK.

    `active_design` DROPS geometry. A caller that resolves and then writes back
    deletes the unchosen proposal — silently, leaving only any archived copy.
    So `_design()` returns the whole document, and only measuring commands call
    `_measured()`.
    """
    src = os.path.join(ROOT, "tools", "site_api.py")
    body = open(src).read()
    # the write path must read the WHOLE document
    import re
    defs = [(m.start(), m.group(1)) for m in re.finditer(r"^def (\w+)\(", body, re.M)]

    def owner(idx):
        return max((d for d in defs if d[0] < idx), key=lambda d: d[0])[1]

    resolved, whole = set(), set()
    for m in re.finditer(r"_(measured|design)\(a\.design\)", body):
        (resolved if m.group(1) == "measured" else whole).add(owner(m.start()))
    assert "cmd_apply_ops" in whole, (
        "apply-ops resolves alternatives before writing — it would delete the "
        "proposal the user did not choose")
    assert "cmd_apply_ops" not in resolved
    assert "cmd_check_ops" in whole, (
        "check-ops must dry-run against the same document apply-ops writes")
    for cmd in ("cmd_composition", "cmd_scene", "cmd_near", "cmd_area", "cmd_validate"):
        assert cmd in resolved, f"{cmd} measures the union of both proposals"


@pytest.mark.needs_site
def test_composition_counts_one_proposal(tmp_path):
    d = json.load(open(project.data("design.json")))
    plants = d["plants"]
    half = len(plants) // 2
    d["groups"] = [
        {"id": "A", "name": "A", "members": [p["id"] for p in plants[:half]], "alt_of": "corner"},
        {"id": "B", "name": "B", "members": [p["id"] for p in plants[half:]], "alt_of": "corner"}]
    d["alternatives"] = {"corner": "A"}
    p = tmp_path / "alt.json"
    p.write_text(json.dumps(d))
    r = _run("composition", design_path=str(p))
    assert r.returncode == 0, r.stderr
    got = json.loads(r.stdout)
    assert got["plants"] < len(plants), (
        f"composition counted {got['plants']} of {len(plants)} — it measured both "
        "proposals as one garden")


@pytest.mark.needs_site
def test_apply_ops_does_not_eat_the_other_proposal(tmp_path):
    """End to end: write through the real path, the losing proposal survives."""
    d = json.load(open(project.data("design.json")))
    keep = [p["id"] for p in d["plants"][:3]]
    drop = [p["id"] for p in d["plants"][3:6]]
    d["groups"] = [{"id": "A", "name": "A", "members": keep, "alt_of": "corner"},
                   {"id": "B", "name": "B", "members": drop, "alt_of": "corner"}]
    d["alternatives"] = {"corner": "A"}
    p = tmp_path / "live.json"
    p.write_text(json.dumps(d))
    before = len(d["plants"])
    r = _run("apply-ops", "[]", design_path=str(p))
    assert r.returncode == 0, r.stderr
    after = json.loads(p.read_text())
    assert len(after["plants"]) == before, (
        f"apply-ops wrote back {len(after['plants'])} of {before} plants — the "
        "proposal the user did not choose was deleted from disk")
    assert len(after.get("groups") or []) == 2, "a losing proposal's group was erased"


@pytest.mark.needs_site
def test_removing_the_chosen_proposal_says_so_and_leaves_no_dead_choice(tmp_path):
    """A group's members are object ids, and `next_id` recycles those.
    `alternatives` holds a GROUP id; those are timestamps, never reused, so it
    cannot re-bind. It can DANGLE if the chosen group is emptied and the map
    keeps its id. `chosen()` falls back to the first surviving option, changing
    the active proposal and every measurement. Removing the chosen proposal must
    clear the dead choice and report which proposal counts now."""
    d = json.load(open(project.data("design.json")))
    keep = [p["id"] for p in d["plants"][:3]]
    drop = [p["id"] for p in d["plants"][3:6]]
    d["groups"] = [{"id": "A", "name": "A", "members": keep, "alt_of": "corner"},
                   {"id": "B", "name": "B", "members": drop, "alt_of": "corner"}]
    d["alternatives"] = {"corner": "B"}                       # the user chooses B ...
    assert A.chosen(d, "corner") == "B"
    p = tmp_path / "live.json"
    p.write_text(json.dumps(d))
    ops = json.dumps([{"tool": "remove_objects", "input": {"ids": drop}}])   # ... and B is removed
    r = _run("apply-ops", ops, design_path=str(p))
    assert r.returncode == 0, r.stderr
    said = json.loads(r.stdout)["applied"][0]["result"]
    assert 'the chosen proposal for "corner" (B) is gone' in said and '"A" counts now' in said, said
    after = json.loads(p.read_text())
    assert "B" not in json.dumps(after.get("alternatives") or {}), "the dead group id is still the recorded choice"
    assert [g["id"] for g in after["groups"]] == ["A"]


@pytest.mark.needs_site
def test_removing_a_LOSING_proposal_leaves_the_choice_alone(tmp_path):
    d = json.load(open(project.data("design.json")))
    keep = [p["id"] for p in d["plants"][:3]]
    drop = [p["id"] for p in d["plants"][3:6]]
    d["groups"] = [{"id": "A", "name": "A", "members": keep, "alt_of": "corner"},
                   {"id": "B", "name": "B", "members": drop, "alt_of": "corner"}]
    d["alternatives"] = {"corner": "A"}
    p = tmp_path / "live.json"
    p.write_text(json.dumps(d))
    r = _run("apply-ops", json.dumps([{"tool": "remove_objects", "input": {"ids": drop}}]), design_path=str(p))
    assert r.returncode == 0, r.stderr
    assert "chosen proposal" not in json.loads(r.stdout)["applied"][0]["result"]
    assert json.loads(p.read_text())["alternatives"] == {"corner": "A"}


def test_the_schema_accepts_the_new_fields():
    """A design carrying alternatives (or lineage) must validate.

    The schema must accept `from` so saved lineage validates. Run the Python
    judge on the design document; JS tests alone do not check its validation.
    """
    import agent
    d = design()
    d["from"] = "huajing_C_split"
    errs, _ = agent.validate(d, None)
    assert not errs, errs
