"""A design run may not finish without having stood in what it built.

A design must read as a designer's work, not as a machine trying to fit things —
and a design that never looked at what it built reads exactly like that.

A loop that measures the ground, emits seventeen ops, and stops produces that
result. Every op is individually justified and the result is an assembly, because
assembling is the only thing the process asks for. A designer sketches, LOOKS,
and revises; a loop with no step between proposing and finishing cannot.

The brief tells the model to look ("SEE WHAT YOU ARE PROPOSING") and to walk, and
telling it is not enough: a tool can be documented, discoverable and still called
zero times until something structural changes.

So: structural. If a run produced geometry and never once looked at it, that is
not a finished design and the run says so and goes round again. This is a
requirement on METHOD, not on taste — the same kind as "measure before you
build".
"""
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import agent    # noqa: E402


def test_there_is_a_way_to_ask_whether_this_run_looked():
    assert hasattr(agent, "looked_at_own_work"), (
        "nothing can tell whether a run ever rendered its own design")


def test_a_run_that_never_looked_is_detected(tmp_path):
    log = tmp_path / "calls.log"
    log.write_text("".join(json.dumps({"cmd": c, "via": "mcp", "rendered": True}) + "\n"
                           for c in ("ground-many", "check-pad", "apply-ops")))
    assert agent.looked_at_own_work(str(log), 0) is False


def test_a_run_that_walked_its_design_is_detected(tmp_path):
    log = tmp_path / "calls.log"
    log.write_text("".join(json.dumps({"cmd": c, "via": "mcp", "rendered": True}) + "\n"
                           for c in ("ground-many", "preview_design", "walk_through")))
    assert agent.looked_at_own_work(str(log), 0) is True


def test_only_calls_from_THIS_run_count(tmp_path):
    """The log is append-only and shared. A walk from an earlier run must not
    excuse this one — that is the same mistake as reading a design file's plant
    count and believing it came from the op you just applied.
    """
    log = tmp_path / "calls.log"
    earlier = json.dumps({"cmd": "walk_through", "via": "mcp", "rendered": True}) + "\n"
    log.write_text(earlier)
    mark = log.stat().st_size
    with open(log, "a") as f:
        f.write(json.dumps({"cmd": "check-pad", "via": "mcp", "rendered": True}) + "\n")
    assert agent.looked_at_own_work(str(log), mark) is False, \
        "a previous run's walkthrough was counted as this one's"
    assert agent.looked_at_own_work(str(log), 0) is True


def test_a_missing_log_never_blocks_a_run(tmp_path):
    """Instrumentation must not be able to fail a design. If the log is absent
    the honest answer is 'I cannot tell', and the run proceeds — refusing to
    finish because a log file is missing would be a tool breaking real work over
    its own bookkeeping.
    """
    assert agent.looked_at_own_work(str(tmp_path / "nope.log"), 0) is None


def test_the_second_pass_asks_for_a_DESIGN_not_more_compliance():
    """What the model is told when it is sent back matters more than that it is
    sent back. 'You did not call a tool' produces one tool call; the point is to
    make it look at the garden and change it.
    """
    msg = agent.LOOK_FEEDBACK
    low = msg.lower()
    assert "walk_through" in msg, msg
    for word in ("look", "revis"):
        assert word in low, f"{word!r} missing from the second-pass brief"
    # it must not read as a rule about counts or ratios — the requirement is to look
    for banned in ("must be", "at least", "%", "ratio"):
        assert banned not in low, f"the second pass smuggles in a metric: {banned!r}"


def test_the_requirement_is_about_method_not_taste():
    """Guard against the next session turning this into a design rule."""
    src = open(os.path.join(ROOT, "tools", "agent.py")).read()
    i = src.index("LOOK_FEEDBACK")
    block = src[i:i + 1600].lower()
    for banned in ("species", "hardscape", "m2 per plant", "grouping ratio"):
        assert banned not in block, (
            f"the look-again feedback has grown an opinion about {banned!r} — this "
            f"is a requirement to LOOK, not a brief about what to design")


# ── the wiring: does run() actually send it back? ─────────────────────────
def test_run_sends_a_blind_pass_back_and_keeps_the_second(monkeypatch, tmp_path):
    """The helper is worth nothing if run() does not act on it — a check with no
    caller passes its own tests and guards nothing.

    Two canned replies: the first places a bed and never looks, the second does
    the same after the model has 'walked' it. The run must reject the first,
    re-prompt with LOOK_FEEDBACK, and keep the second.
    """
    import json as _j
    design = tmp_path / "d.json"
    design.write_text(_j.dumps({"version": 1, "units": "meters", "beds": [], "paths": [],
                                "patios": [], "plants": [], "edges": [], "steps": [],
                                "objects": []}))
    log = tmp_path / "calls.log"
    log.write_text("")
    monkeypatch.setenv("YARDTWIN_CALL_LOG", str(log))

    bed = {"tool": "upsert_bed",
           "input": {"id": "b1", "mulch": "shredded bark",
                     "polygon": [[12, -8], [16, -8], [16, -4], [12, -4]]}}
    prompts, replies = [], [
        _j.dumps({"ops": [bed], "summary": "first", "confidence": "high", "cautions": ""}),
        _j.dumps({"ops": [bed], "summary": "second", "confidence": "high", "cautions": ""}),
    ]

    def fake(prompt, model, timeout_s=600, schema_json=None, **kw):
        prompts.append(prompt)
        # the SECOND pass is the one that walks its scratch design; the first
        # deliberately does not, which is the case being tested
        if len(prompts) == 2:
            with open(log, "a") as f:
                f.write(_j.dumps({"cmd": "walk_through", "via": "mcp", "rendered": True,
                                  "views": [{"eye": [14, -16], "look": [14, -6], "fov": 62}]}) + "\n")
        return replies[min(len(prompts) - 1, len(replies) - 1)]

    monkeypatch.setattr(agent, "call_claude_explore", fake)
    monkeypatch.setattr(agent, "call_claude", fake)
    _, mutations, summary, *_ = agent.run("make a bed", design_path=str(design),
                                          explore=True, quiet=True)
    assert len(prompts) == 2, (
        f"run() called the model {len(prompts)} time(s) — a pass that never rendered "
        f"its own design was accepted")
    assert agent.LOOK_FEEDBACK in prompts[1], (
        "the second pass did not carry the look-again brief")
    assert summary == "second" and mutations >= 1, (summary, mutations)


def test_a_run_that_DID_look_is_not_sent_back(monkeypatch, tmp_path):
    """The control. Sending every run back twice would double the cost of the
    tool for nothing, and would teach the next session that the check is noise.
    """
    import json as _j
    design = tmp_path / "d.json"
    design.write_text(_j.dumps({"version": 1, "units": "meters", "beds": [], "paths": [],
                                "patios": [], "plants": [], "edges": [], "steps": [],
                                "objects": []}))
    log = tmp_path / "calls.log"
    log.write_text("")
    monkeypatch.setenv("YARDTWIN_CALL_LOG", str(log))
    calls = []

    def fake(prompt, model, timeout_s=600, schema_json=None, **kw):
        calls.append(prompt)
        with open(log, "a") as f:                 # it looked, during its own turn
            f.write(_j.dumps({"cmd": "look", "via": "mcp", "rendered": True,
                                  "views": [{"eye": [14, -16], "look": [14, -6], "fov": 62}]}) + "\n")
        return _j.dumps({"ops": [{"tool": "upsert_bed", "input": {
            "id": "b1", "mulch": "shredded bark",
            "polygon": [[12, -8], [16, -8], [16, -4], [12, -4]]}}],
            "summary": "once", "confidence": "high", "cautions": ""})

    monkeypatch.setattr(agent, "call_claude_explore", fake)
    _, _, summary, *_ = agent.run("make a bed", design_path=str(design),
                                  explore=True, quiet=True)
    assert len(calls) == 1, f"a run that looked was still sent back ({len(calls)} calls)"
    assert summary == "once"


# ── the gate survives the design LOOP (tests/test_design_loop.py) ─────────
#
# The gate is per PASS: a pass that produced geometry and never rendered it is
# discarded and re-prompted. The revision loop runs rounds around it, and there
# are two ways that could quietly repeal the gate — by letting a run-level
# flag excuse later rounds, and by counting a discarded pass's ops anyway. Both
# are asserted here rather than in the loop's own file, because it is this file's
# job that the requirement to LOOK does not weaken.

def test_the_gate_still_fires_on_the_first_pass_of_a_multi_round_run(monkeypatch, tmp_path):
    import json as _j
    design = tmp_path / "d.json"
    design.write_text(_j.dumps({"version": 1, "units": "meters", "beds": [], "paths": [],
                                "patios": [], "plants": [], "edges": [], "steps": [],
                                "objects": []}))
    log = tmp_path / "calls.log"
    log.write_text("")
    monkeypatch.setenv("YARDTWIN_CALL_LOG", str(log))
    bed = {"tool": "upsert_bed",
           "input": {"id": "b1", "mulch": "shredded bark",
                     "polygon": [[12, -8], [16, -8], [16, -4], [12, -4]]}}
    prompts = []

    def fake(prompt, model, timeout_s=600, schema_json=None, **kw):
        prompts.append(prompt)
        if len(prompts) >= 2:                     # the first pass never looks
            with open(log, "a") as f:
                f.write(_j.dumps({"cmd": "walk_through", "via": "mcp", "rendered": True,
                                  "views": [{"eye": [14, -16], "look": [14, -6], "fov": 62}]}) + "\n")
        return _j.dumps({"ops": [bed], "summary": f"call{len(prompts)}",
                         "confidence": "high", "cautions": "", "done": True})

    monkeypatch.setattr(agent, "call_claude_explore", fake)
    _, mutations, summary, *_ = agent.run("make a bed", design_path=str(design),
                                          explore=True, quiet=True, rounds=3)
    assert agent.LOOK_FEEDBACK in prompts[1], (
        "asking for three design rounds let a blind first pass through")
    assert summary.startswith("call2"), summary
    assert mutations == 1, (
        f"mutations={mutations}: the discarded blind pass's ops were counted as "
        f"well as the pass that replaced them")


def test_neither_look_brief_has_an_opinion_about_the_garden():
    """The same guard as above, over BOTH briefs the run can send back.

    A second brief is a second place for a metric to appear, and the revise brief
    is the one a session will be tempted to 'sharpen' with a number, because it is
    the one that runs repeatedly.
    """
    src = open(os.path.join(ROOT, "tools", "agent.py")).read()
    for name in ("LOOK_FEEDBACK", "REVISE_FEEDBACK"):
        i = src.index(name)
        block = src[i:i + 2600].lower()
        for banned in ("species", "hardscape", "m2 per plant", "grouping ratio",
                       "at least", "no more than"):
            assert banned not in block, (
                f"{name} has grown an opinion about {banned!r} — these are "
                f"requirements to LOOK, not briefs about what to design")
