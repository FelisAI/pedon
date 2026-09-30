"""What `run()` SAVED, measured after the last op — not what the model thinks.

The design agent verifies its own work by applying its ops to a scratch file and
calling `composition` on it. Then `run()` applies the ops for real, so the model's
check happens BEFORE the last mutation, and the two answers can be far apart:

    the model's summary:  "73 plants in twelve species ... 1.04 m2 per plant"
    the file on disk:      33 plants, 3.17 m2 per plant

Both numbers are honestly produced. The model measures a design that never
reaches disk when a later op deletes 40 of its plants. Unless something measures
the artefact that was actually written, a 55% loss of planting reaches the owner
as a garden with 73 plants in it.

So there is one line of output, at the one moment the truth is available: after
the final op, from the saved design. It makes such a loss visible at a glance
instead of by comparing a paragraph of prose against a JSON file.
"""
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import project  # noqa: E402  where the active site's files are
sys.path.insert(0, os.path.join(ROOT, "tools"))
import agent    # noqa: E402

# about a REAL site — skipped without the reference site (tests/conftest.py)
pytestmark = pytest.mark.needs_site


@pytest.fixture(scope="module")
def site():
    with open(agent.SITE_PATH) as f:
        return json.load(f)


def test_there_is_a_function_that_measures_a_saved_design(site):
    with open(project.data("design.json")) as f:
        d = json.load(f)
    line = agent.final_report(d, site)
    assert isinstance(line, str) and line, "no report at all"
    assert str(len(d["plants"])) in line, (
        f"the report does not state the plant count that is actually on disk: {line}")


def test_it_states_the_things_that_went_wrong_before(site):
    """Plant count and density are the two numbers that track the owner's verdict
    on a design, and the two a model's own summary can get wrong."""
    with open(project.data("design.json")) as f:
        d = json.load(f)
    line = agent.final_report(d, site).lower()
    for want in ("plant", "m²", "hard"):
        assert want in line, f"{want!r} missing from the final report: {line}"


def test_it_is_honest_about_a_design_with_nothing_in_it(site):
    empty = {"version": 1, "units": "meters", "beds": [], "paths": [], "patios": [],
             "plants": [], "edges": [], "steps": [], "objects": []}
    line = agent.final_report(empty, site)
    assert isinstance(line, str)
    assert "0 plant" in line or "no plant" in line.lower(), line


def test_it_never_takes_the_run_down(site):
    """A REPORT must not be able to fail a design that already applied. This runs
    after the ops are committed, so an exception here would turn a good run into a
    stack trace and an exit code."""
    for junk in ({}, {"plants": None}, {"plants": [{"no": "position"}]},
                 {"beds": [{"id": "b"}], "plants": [{"position": [1]}]}):
        line = agent.final_report(junk, site)
        assert isinstance(line, str), f"final_report returned {line!r} for {junk}"


def test_run_prints_what_it_saved(monkeypatch, tmp_path, site, capsys):
    """The wiring. A function nothing calls is not a capability, so the report
    has to reach the output."""
    src = project.data("design.json")
    dst = tmp_path / "d.json"
    with open(src) as f:
        doc = json.load(f)
    dst.write_text(json.dumps(doc))

    reply = json.dumps({"ops": [], "summary": "s", "confidence": "high", "cautions": "c"})
    monkeypatch.setattr(agent, "call_claude",
                        lambda prompt, model, timeout_s=600, schema_json=None: reply)
    agent.run("do nothing", design_path=str(dst), quiet=False)
    out = capsys.readouterr().out
    assert "[final]" in out, f"run() never reports what it saved:\n{out[-600:]}"
    assert str(len(doc["plants"])) in out
