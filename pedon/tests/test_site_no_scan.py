"""A property that has never been scanned must SAY so, not answer ambiguously.

Measured without the gate: with no data/terrain_scan.json at all,
`site_api ground 15 -6` returns {"ground_m": null, "scanned": false, "source": null}
and exit 0 — byte-identical to asking a fully scanned site about a point 500 m off
its mesh. Two completely different situations, one answer.

That does not invent ground, so it is not a fail-open. It fails in a different
way the case that matters most: onboarding a NEW property. site_api is the
first thing a new session calls, every point comes back unmeasured, and nothing
tells it that the fix is `analyze_site.py`. The session concludes the yard is
unscannable rather than unscanned.

tools/sun.py sets the pattern for this class — it refuses a bearing while north
is unset and says exactly which two clicks fix it. Same shape here.

Two halves: the MESSAGE, on every ground question and not on `ground` alone, and
the EXIT CODE. A message alone leaves every ground question exiting 0. Measured,
without the exit-code half, on a property with no data at all:

    site_api.py ground 15 -6                   -> rc 0
    site_api.py ground-many '[[15,-6],...]'    -> rc 0, three null rows
    site_api.py slope-many  '[[15,-6],...]'    -> rc 0, three "not on scanned ground"
    site_api.py best-bench 13 -12 18 2         -> rc 0, "candidates": []

`candidates: []` reads as "there is no level pad in this yard". A shell script or
a model checking $? sees success on all four. So this file pins BOTH halves: one
notice, every ground command, and an exit code that separates "never measured"
from "answered" and from "broken".
"""
import contextlib
import io
import json
import os
import shutil
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import project  # noqa: E402  where the active site's files are
sys.path.insert(0, os.path.join(ROOT, "tools"))
import agent      # noqa: E402
import site_api   # noqa: E402

# The exit codes this file is about. sun.py's north gate makes the same split
# (`2 is a refusal, distinct from 1 (broken) and 0 (answered)`) and a second
# meaning for 2 in the same repo would be worse than none.
ANSWERED, BROKEN, REFUSED = 0, 1, 2

# Every command whose whole answer IS the ground. Coordinates are the ones
# docs/site.md's own fence uses, so these are literally the first calls a new
# session makes. best-bench gets a 2x2 m region rather than the doc's 5x14: the
# search is O(cells x 12 bearings) and this file runs it on the real site too.
GROUND_QUESTIONS = {
    "ground": ["ground", "15", "-6"],
    "ground-many": ["ground-many", "[[15,-6],[16,-6]]"],
    "slope": ["slope", "15", "-6"],
    "slope-many": ["slope-many", "[[15,-6],[16,-6]]"],
    "profile": ["profile", "13", "-14", "13", "10"],
    "check-pad": ["check-pad", "[[14,-9],[18,-9],[18,-4],[14,-4]]"],
    "check-route": ["check-route", "[[11,-12],[13,-4]]"],
    "best-bench": ["best-bench", "13", "-10", "15", "-8", "--across", "4", "--along", "6"],
}

# Keys that would let a caller read a number back out of a refusal. sun.py's
# _refusal exists precisely so that an unknown cannot look like a pass; a
# refusal that still carried "candidates" or "points" would be the same bug.
ANSWER_KEYS = ("ground_m", "candidates", "points", "count", "verdict", "slope_deg",
               "scan_coverage", "walkable_as_a_ramp", "walkable_without_steps",
               "max_fill_m", "max_cut_m", "on_scan", "level_m")


@pytest.fixture
def unscanned(monkeypatch):
    """A property with no raycast and no filled fallback — a fresh capture."""
    monkeypatch.setattr(agent, "_SCAN", False, raising=False)
    monkeypatch.setattr(agent, "_TERRAIN", False, raising=False)
    yield


def _args(**kw):
    return type("A", (), kw)()


def _cli(argv, monkeypatch, tmp_path):
    """Run the real CLI entry point; return (parsed stdout, exit code).

    Through main() rather than the cmd_ function because the exit code IS the
    half of the contract this file is about, and only main() produces one. The
    call log goes to tmp for the reason tests/test_call_log.py gives: the real
    data/site_api_calls.log is the evidence every tool-traffic figure is
    measured from, and a suite that appends to it rewrites its own dataset.
    """
    monkeypatch.setenv("YARDTWIN_CALL_LOG", str(tmp_path / "calls.log"))
    monkeypatch.setattr(sys, "argv", ["site_api.py"] + argv)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), pytest.raises(SystemExit) as e:
        site_api.main()
    text = buf.getvalue()
    assert "Traceback" not in text, f"{argv} printed a traceback:\n{text}"
    return json.loads(text), e.value.code


# ── the fixture guards: without these every assertion below is vacuous ──────

@pytest.mark.needs_site
def test_the_real_site_still_answers():
    """Guard the fixture: without it these tests could pass on a broken module."""
    out = site_api.cmd_ground(_args(x=15, y=-6))
    assert out["scanned"] is True and out["ground_m"] is not None


@pytest.mark.needs_site
def test_the_matrix_is_the_real_parser_and_answers_when_scanned(monkeypatch, tmp_path):
    """Presence and COUNT before any per-case delta.

    Two ways this file could pass while testing nothing: GROUND_QUESTIONS could
    name a subcommand that no longer exists (argparse would exit 2 — the refusal
    code — and every refusal assertion below would pass on a usage error), or the
    gate could fire on every property, which would make exit 2 universal and the
    tool useless. So: every one of these runs, on the REAL scanned site, and
    answers with 0 and no notice.
    """
    assert len(GROUND_QUESTIONS) == 8, sorted(GROUND_QUESTIONS)
    assert set(GROUND_QUESTIONS) >= {"ground", "ground-many", "slope-many", "best-bench"}
    for name, argv in GROUND_QUESTIONS.items():
        out, code = _cli(argv, monkeypatch, tmp_path / f"ok-{name}")
        assert code == ANSWERED, f"`{name}` exited {code} on the real scanned site: {out}"
        assert "no_scan" not in out, f"`{name}` claims the scanned site has no scan: {out}"
        assert not out.get("refused"), f"`{name}` refused a property that HAS a scan: {out}"


# ── half one: the message, on every command rather than on `ground` ─────────

def test_an_unscanned_property_says_it_has_no_scan(unscanned):
    out = site_api.cmd_ground(_args(x=15, y=-6))
    assert out.get("no_scan") is True, (
        "a never-scanned property answers exactly like a point outside coverage; "
        "a new session cannot tell 'you asked outside the yard' from 'this "
        "property has not been measured yet'")


def test_it_says_how_to_fix_it(unscanned):
    out = site_api.cmd_ground(_args(x=15, y=-6))
    fix = json.dumps(out.get("fix", ""))
    assert "analyze_site" in fix, f"no actionable fix in the answer: {out}"


@pytest.mark.parametrize("name", sorted(GROUND_QUESTIONS))
def test_every_ground_question_says_the_property_is_unmeasured(
        name, unscanned, monkeypatch, tmp_path):
    out, _ = _cli(GROUND_QUESTIONS[name], monkeypatch, tmp_path)
    assert out.get("no_scan") is True, f"`{name}` answered an unmeasured property: {out}"
    assert "analyze_site" in json.dumps(out.get("fix", "")), \
        f"`{name}` says nothing a caller can act on: {out}"


def test_there_is_exactly_one_notice(unscanned, monkeypatch, tmp_path):
    """One message, not eight that drift.

    Copies drift: three copies of the height-field indexing can all index rows
    the wrong way round, and two ground lookups can drift 0.99 m apart. A notice
    is no different — eight hand-written "run analyze_site" strings would
    eventually name eight things.
    """
    seen = {}
    for name, argv in GROUND_QUESTIONS.items():
        out, _ = _cli(argv, monkeypatch, tmp_path / name)
        seen[name] = json.dumps({k: out.get(k) for k in ("no_scan", "reason", "fix")},
                                sort_keys=True)
    assert len(set(seen.values())) == 1, \
        "the no-scan notice is worded differently per command:\n" + \
        "\n".join(f"{k}: {v}" for k, v in sorted(seen.items()))


# ── half two: the exit code, which is what a script and a model actually see ─

@pytest.mark.parametrize("name", sorted(GROUND_QUESTIONS))
def test_every_ground_question_exits_refused_not_zero(
        name, unscanned, monkeypatch, tmp_path):
    """The exit-code half. A message inside JSON is invisible to `$?`."""
    _out, code = _cli(GROUND_QUESTIONS[name], monkeypatch, tmp_path)
    assert code == REFUSED, (
        f"`{name}` exited {code} on a property that has never been raycast; "
        f"{ANSWERED} is indistinguishable from an answer and {BROKEN} says the "
        f"query is broken rather than the property unmeasured")


@pytest.mark.parametrize("name", sorted(GROUND_QUESTIONS))
def test_a_refusal_carries_no_number_to_read_back_as_an_answer(
        name, unscanned, monkeypatch, tmp_path):
    """`best-bench` returning candidates:[] is the sharpest case — it reads as
    "there is no level pad in this yard", which is a measurement nobody made."""
    out, _ = _cli(GROUND_QUESTIONS[name], monkeypatch, tmp_path)
    assert out.get("refused") is True, f"`{name}` did not mark itself refused: {out}"
    leaked = [k for k in ANSWER_KEYS if k in out]
    assert not leaked, f"`{name}` refused but still handed back {leaked}: {out}"


@pytest.mark.needs_site
def test_the_three_exit_codes_stay_distinct(monkeypatch, tmp_path):
    """0 answered / 1 broken / 2 never measured, all three in one run.

    Not the `unscanned` fixture: two of these three only exist on a property that
    HAS a scan, and run entirely unscanned this test would have nothing to
    distinguish — it reports "a malformed point list exited 2, not 1", which is
    not a bug (see the precedence test below) but is a test proving nothing.
    """
    ok, answered = _cli(["ground", "15", "-6"], monkeypatch, tmp_path / "ok")
    broken, code_broken = _cli(["ground-many", "not json"], monkeypatch, tmp_path / "broken")
    monkeypatch.setattr(agent, "_SCAN", False, raising=False)
    monkeypatch.setattr(agent, "_TERRAIN", False, raising=False)
    refusal, code_refused = _cli(["ground", "15", "-6"], monkeypatch, tmp_path / "refused")

    assert answered == ANSWERED and ok["ground_m"] is not None, ok
    assert code_broken == BROKEN, f"a malformed point list exited {code_broken}: {broken}"
    assert "error" in broken and not broken.get("no_scan"), broken
    assert code_refused == REFUSED and refusal.get("no_scan") is True, refusal
    assert len({answered, code_broken, code_refused}) == 3


def test_an_unmeasured_property_refuses_before_it_argues_about_arguments(
        unscanned, monkeypatch, tmp_path):
    """Two true statements, and the refusal is the actionable one.

    `ground-many 'not json'` on a property with no raycast could report either
    "that is not JSON" or "nothing here is measured". Fixing the JSON gets the
    caller a page of nulls; running analyze_site.py gets them an answer. So the
    gate is deliberately the first thing every ground command does, before it
    parses anything, and this pins that order rather than leaving it accidental.
    """
    out, code = _cli(["ground-many", "not json"], monkeypatch, tmp_path)
    assert code == REFUSED and out.get("no_scan") is True, out


@pytest.mark.needs_site
def test_a_point_outside_coverage_is_still_a_different_answer():
    """The two cases must stay distinguishable — that is the whole point."""
    off = site_api.cmd_ground(_args(x=515, y=-506))
    assert off["scanned"] is False
    assert not off.get("no_scan"), (
        "a point off the mesh of a SCANNED property must not claim the property "
        "is unscanned")


@pytest.mark.needs_site
def test_a_point_outside_coverage_still_exits_zero(monkeypatch, tmp_path):
    """Off the scan is an ANSWER — "the scanner never saw that spot" — and the
    gate must not swallow it. If this exits 2 the two cases have collapsed,
    from the other side."""
    out, code = _cli(["ground", "515", "-506"], monkeypatch, tmp_path)
    assert code == ANSWERED, f"a point off a scanned mesh exited {code}: {out}"


# ── what is deliberately NOT gated ──────────────────────────────────────────

@pytest.mark.needs_site
def test_a_partly_measurable_question_still_answers_what_it_can(unscanned, monkeypatch,
                                                                tmp_path):
    """`area NAME` is only half a ground question: the polygon, its size and what
    the design already puts inside it are owner ground truth and stay true with
    no raycast at all. sun.py's precedent is to refuse the bearing and still hand
    back the altitude, so this answers — carrying the notice, and exiting 2
    because the elevation half of the answer is missing for a reason the caller
    can fix in one command."""
    names = [a["name"] for a in site_api._site().get("areas", [])]
    assert names, "no drawn areas on this site — this test proves nothing"
    out, code = _cli(["area", names[0]], monkeypatch, tmp_path)
    assert out.get("no_scan") is True, f"`area` hid that nothing here is measured: {out}"
    assert out.get("area_m2") and out.get("polygon"), \
        f"`area` refused the half it could honestly answer: {out}"
    assert "ground_m" not in out and "suits" not in out, \
        f"`area` quoted elevation on an unmeasured property: {out}"
    assert code == REFUSED


@pytest.mark.needs_site
def test_the_owner_write_path_is_not_gated(unscanned, monkeypatch, tmp_path):
    """The one place a non-zero exit COULD break legitimate scripted use.

    The documented onboarding order (docs/site.md) is geodata.py -> open the
    viewer -> Fit ground, Set north, click the scale span -> analyze_site.py. Landmarks and drawn areas
    therefore arrive BEFORE the raycast exists, and viewer/vite.config.js shells
    `site_api.py save-owner` for every one of them. Gating the writers on a scan
    would make a new property unrecordable, so they are deliberately outside the
    gate — measured here rather than assumed, against a COPY of site.json.
    """
    site_copy = tmp_path / "site.json"
    shutil.copy(project.data("site.json"), site_copy)
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(
        {"landmarks": [{"name": "test_pin", "x": 1.0, "y": 2.0, "z": 0.0}]})))
    out, code = _cli(["save-owner", "--site", str(site_copy)], monkeypatch, tmp_path)
    assert out.get("ok") is True, f"save-owner refused an unscanned property: {out}"
    assert code == ANSWERED, f"save-owner exited {code} before the raycast exists"
    assert "test_pin" in json.dumps(json.loads(site_copy.read_text())), \
        "save-owner reported ok without writing the pin"
