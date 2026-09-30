"""Hand-placement needs an op path that APPLIES, not just one that rehearses.

The viewer's place/move gestures POST an op list to /api/ops, deliberately, so a
hand edit goes through agent.execute() + validate() exactly like a model-emitted
op — ONE write path is the load-bearing constraint. A hand edit that bypassed the
validators would reintroduce the floating and off-scan geometry they exist to
catch, except authored by the owner, who will trust it more.

check-ops mirrors the apply loop but writes nothing, by design. This is the
writing half, and it must reuse the same execute() rather than growing a second
one: two implementations of one idea drift apart — two height lookups can
disagree by up to 0.99 m, so the tool that sizes a pad and the validator that
judges it would use different rulers.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import project  # noqa: E402  where the active site's files are

# about a REAL site — skipped without the reference site (tests/conftest.py)
pytestmark = pytest.mark.needs_site
SITE_API = os.path.join(ROOT, "tools", "site_api.py")


def run(args, design):
    """Always against a COPY: a test must never edit the owner's design."""
    return json.loads(subprocess.run(
        [sys.executable, SITE_API, *args, "--design", design],
        capture_output=True, text=True, timeout=120).stdout or "{}")


@pytest.fixture
def scratch(tmp_path):
    dst = tmp_path / "design.json"
    shutil.copy(project.data("design.json"), dst)
    return str(dst)


GOOD = json.dumps([{"tool": "set_patio", "input": {
    "id": "hand_placed", "polygon": [[14, -9], [18, -9], [18, -4], [14, -4]],
    "material": "decomposed_granite"}}])

BAD = json.dumps([{"tool": "set_patio", "input": {
    "id": "way_off", "polygon": [[514, -509], [518, -509], [518, -504], [514, -504]],
    "material": "decomposed_granite"}}])


def test_check_ops_still_writes_nothing(scratch):
    """Guard the pair: if the dry run started writing, the test below proves nothing."""
    before = open(scratch).read()
    out = run(["check-ops", GOOD], scratch)
    assert out["would_apply"] == 1
    assert open(scratch).read() == before, "check-ops is a DRY run and must stay one"


def test_apply_ops_writes_the_change(scratch):
    out = run(["apply-ops", GOOD], scratch)
    assert out.get("applied"), f"nothing applied: {out}"
    d = json.load(open(scratch))
    assert [p for p in d["patios"] if p["id"] == "hand_placed"], "the op did not reach the file"


def test_a_rejected_op_writes_nothing(scratch):
    """The whole reason hand edits go through here."""
    before = open(scratch).read()
    out = run(["apply-ops", BAD], scratch)
    assert out.get("rejected"), f"an off-scan patio should be rejected: {out}"
    assert open(scratch).read() == before, "a rejected op still changed the file"


def test_apply_and_check_agree_on_what_would_happen(scratch):
    """One execute(), not two. Same op, same verdict from both paths."""
    dry = run(["check-ops", BAD], scratch)
    wet = run(["apply-ops", BAD], scratch)
    assert dry["would_reject"] == len(wet.get("rejected", []))
    assert [r["why"] for r in dry["rejected"]] == [r["why"] for r in wet["rejected"]]


# ── A DRY RUN OF NOTHING MUST COST ALMOST NOTHING ─────────────────────
def test_check_ops_judges_the_design_a_fixed_number_of_times(scratch, monkeypatch):
    """The design agent calls `check-ops` before every apply. Re-deriving the
    baseline's warnings INSIDE the comprehension that filters them — `validate()`,
    and a re-read of the file, once per warning — makes 248 warnings 250 validates
    and `check-ops '[]'` on a working design 15.5 s. The cost creeps: every plant
    placed makes every later dry run slower, and no single change is the cause.

    Counted, not timed: a wall-clock assertion here would measure the machine."""
    import argparse
    import site_api
    import plant_catalog
    # A newly designed garden may legitimately have fewer than twenty warnings.
    # Give this performance guard its own crowded temporary planting instead of
    # requiring the owner's live design to remain problematic.
    fixture = json.load(open(scratch))
    entry = plant_catalog.lookup("Salvia officinalis 'Berggarten'")
    specimen = {k: entry[k] for k in ("species", "common", "form",
                                     "mature_height_m", "mature_spread_m")}
    specimen["position"] = [12, -4]
    fixture["plants"] = [{**specimen, "id": f"perf_crowded_{i}"} for i in range(10)]
    with open(scratch, "w") as f:
        json.dump(fixture, f)
    calls = {"n": 0}
    real = site_api._agent.validate

    def counting(*a, **k):
        calls["n"] += 1
        return real(*a, **k)

    monkeypatch.setattr(site_api._agent, "validate", counting)
    out = site_api.cmd_check_ops(argparse.Namespace(ops="[]", ops_file=None, design=str(scratch)))
    warned = len(real(json.load(open(scratch)), site_api._site())[1])
    assert warned > 20, "the fixture design has too few warnings to show the fault"
    assert out["new_warnings"] == [], "an empty op list cannot introduce a warning"
    assert calls["n"] <= 3, (
        f"validate() ran {calls['n']} times for an EMPTY op list on a design with "
        f"{warned} warnings — it is being re-run per warning")
