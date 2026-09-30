"""Design, look, design, look — a LOOP, not a gate.

The model must design with space in mind and repeatedly inspect its work.
Mixed herbaceous borders (花境) are difficult planting compositions that require
repeated visual judgement.

A render gate ensures one look but does not provide an iterative design loop.
The loop must support the designer's process: sketch, stand in it, say what is
wrong with the GARDEN, change it, stand in it again — until it stops improving.

Three things are hard about that and all three are tested here.

WHEN TO STOP. A loop with no stopping rule burns a subscription and a night. So:
a hard round budget, AND an early stop the moment a round changes nothing, AND a
way for the model to say it has looked and would change nothing. All three, not
one — the budget alone spends every round it is given, and convergence alone
never terminates against a model that keeps fiddling.

WHAT "BETTER" MEANS. Not a metric. Hardscape coverage and area per plant are
references, never targets. A design at 24.6% hardscape and 1.12 m2 per plant can
have an overly wide path even with a reference of 17.0% and 1.16 m2 per plant:
optimising measurable values can neglect visual quality. So the loop never
scores anything. It requires evidence in the call log that the model LOOKED,
and that it says in WORDS what it saw. The words are the deliverable; the
stopping rule is arithmetic on the design, not on its quality.

THE TWO BUDGETS ARE NOT THE SAME BUDGET. run()'s `for attempt in range(3)` counts
FAILURES — malformed JSON, rejected ops — and its budget is a recovery allowance.
A design round counts SUCCESSES being deepened. Sharing one counter would mean a
parse error silently costs a look, and a third round leaves nothing to recover a
rejected op with. `test_a_parse_error_does_not_cost_a_design_round` is the
discriminator: it needs four model calls to pass and no shared 3-counter can
give them.

Everything here stubs the backend, so the whole file costs zero model calls.

    python3 -m pytest tests/test_design_loop.py -q
"""
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import agent    # noqa: E402


EMPTY = {"version": 1, "units": "meters", "beds": [], "paths": [], "patios": [],
         "plants": [], "edges": [], "steps": [], "objects": []}

# a bed that validates on the real scan — the same one tests/test_must_look.py uses
BED = [[12, -8], [16, -8], [16, -4], [12, -4]]


def bed_op(shift=0.0):
    return {"tool": "upsert_bed",
            "input": {"id": "b1", "mulch": "shredded bark",
                      "polygon": [[x + shift, y] for x, y in BED]}}


def reply(ops, summary="s", **extra):
    return json.dumps({"ops": ops, "summary": summary, "confidence": "high",
                       "cautions": "", **extra})


@pytest.fixture
def yard(tmp_path, monkeypatch):
    """A design file, a private call log, and a recorder of every model call."""
    design = tmp_path / "d.json"
    design.write_text(json.dumps(EMPTY))
    log = tmp_path / "calls.log"
    log.write_text("")
    monkeypatch.setenv("YARDTWIN_CALL_LOG", str(log))

    state = {"prompts": [], "log": log, "design": design, "tmp": tmp_path}

    def saw(cmd="walk_through"):
        # a look AT the fixture bed: a frame that points elsewhere is not a look
        with open(log, "a") as f:
            f.write(json.dumps({"cmd": cmd, "via": "mcp", "rendered": True,
                                "views": [{"eye": [14, -16], "look": [14, -6], "fov": 62}]}) + "\n")
    state["saw"] = saw

    def install(responder):
        def fake(prompt, model, timeout_s=600, schema_json=None, **kw):
            state["prompts"].append(prompt)
            return responder(len(state["prompts"]), prompt)
        monkeypatch.setattr(agent, "call_claude_explore", fake)
        monkeypatch.setattr(agent, "call_claude", fake)
    state["install"] = install
    return state


# ── the capability has to exist and be nameable ───────────────────────────
def test_run_takes_a_round_budget():
    import inspect
    sig = inspect.signature(agent.run)
    assert "rounds" in sig.parameters, (
        "run() has no round budget, so there is no loop to bound")


def test_there_is_a_way_to_ask_whether_a_round_changed_anything():
    assert hasattr(agent, "design_fingerprint"), (
        "nothing can tell whether a revision round changed the design, so the "
        "loop cannot stop early and will always spend its whole budget")
    a = json.loads(json.dumps(EMPTY))
    b = json.loads(json.dumps(EMPTY))
    b["beds"] = [{"id": "b1", "polygon": BED}]
    assert agent.design_fingerprint(a) == agent.design_fingerprint(a)
    assert agent.design_fingerprint(a) != agent.design_fingerprint(b)


def test_the_fingerprint_ignores_bookkeeping_not_geometry():
    """A round that only bumped a version number has changed nothing."""
    a = json.loads(json.dumps(EMPTY))
    a["beds"] = [{"id": "b1", "polygon": BED}]
    b = json.loads(json.dumps(a))
    b["version"] = 99
    b["history"] = ["something"]
    assert agent.design_fingerprint(a) == agent.design_fingerprint(b)


# ── the default is unchanged: one round, one call ─────────────────────────
def test_one_round_is_the_default_and_costs_one_call(yard):
    """Control. A loop that turns itself on would multiply the cost of every
    existing caller — the viewer's Design button spawns agent.py with a 31-minute
    execFile timeout and a single explore call is already allowed 30 of those.
    """
    yard["install"](lambda n, p: (yard["saw"](), reply([bed_op()], "once"))[1])
    _, mutations, summary, *_ = agent.run("make a bed", design_path=str(yard["design"]),
                                          explore=True, quiet=True)
    assert len(yard["prompts"]) == 1, yard["prompts"]
    assert summary == "once" and mutations == 1


# ── the loop itself ───────────────────────────────────────────────────────
def test_a_round_budget_of_three_iterates_three_times(yard):
    def responder(n, prompt):
        yard["saw"]()
        return reply([bed_op(shift=0.1 * n)], f"round{n}")
    yard["install"](responder)
    _, mutations, summary, *_ = agent.run("make a bed", design_path=str(yard["design"]),
                                          explore=True, quiet=True, rounds=3)
    assert len(yard["prompts"]) == 3, (
        f"asked for 3 design rounds, the model was called {len(yard['prompts'])} time(s)")
    assert "round3" in summary, summary
    assert mutations >= 3, (
        f"mutations={mutations}: the ops applied in earlier rounds were lost, so "
        f"main() would decide there was nothing to save")


def test_the_second_round_is_told_it_is_revising_its_own_work(yard):
    def responder(n, prompt):
        yard["saw"]()
        return reply([bed_op(shift=0.1 * n)], f"round{n}")
    yard["install"](responder)
    agent.run("make a bed", design_path=str(yard["design"]),
              explore=True, quiet=True, rounds=2)
    first, second = yard["prompts"]
    assert agent.REVISE_FEEDBACK.split("\n")[0] not in first, (
        "the FIRST pass was told to revise a design that did not exist yet")
    assert agent.REVISE_FEEDBACK.split("\n")[0] in second, (
        "the second round was not told it is looking at its own built design")
    assert "2 of 2" in second, (
        "the round is not numbered, so the model cannot tell a first revision "
        "from its last chance")


def test_the_round_can_SEE_what_it_built_without_rebuilding_it(yard):
    """A revising round is a fresh `claude -p` with no memory of the last one. If
    it has to reconstruct its own design from the JSON in the prompt before it can
    preview it, the look is expensive and it may skip it. The built design must
    be available directly for preview.
    """
    def responder(n, prompt):
        yard["saw"]()
        return reply([bed_op(shift=0.1 * n)], f"round{n}")
    yard["install"](responder)
    agent.run("make a bed", design_path=str(yard["design"]),
              explore=True, quiet=True, rounds=2)
    scratch = agent.scratch_for(str(yard["design"]))
    assert os.path.exists(scratch), (
        "nothing put the built design anywhere the model can preview it")
    built = json.loads(open(scratch).read())
    assert [b["id"] for b in built.get("beds", [])] == ["b1"], built.get("beds")
    assert os.path.basename(scratch) in yard["prompts"][1], (
        "the revise brief does not name the file holding the design to look at")


# ── stopping ──────────────────────────────────────────────────────────────
def test_a_round_that_changes_nothing_stops_the_loop(yard):
    """The cheap stopping rule, and the one that does not need the model's
    cooperation: if the design after this round is the design before it, another
    round is another twenty minutes for the same file.
    """
    def responder(n, prompt):
        yard["saw"]()
        return reply([bed_op()], f"round{n}")      # identical ops every time
    yard["install"](responder)
    agent.run("make a bed", design_path=str(yard["design"]),
              explore=True, quiet=True, rounds=5)
    assert len(yard["prompts"]) == 2, (
        f"the loop spent {len(yard['prompts'])} calls repeating a round that "
        f"changed nothing")


def test_the_model_may_say_it_has_looked_and_would_change_nothing(yard):
    """The other stopping rule, and the one that is a JUDGEMENT rather than a
    diff. It costs a round to discover convergence by fingerprint; a model that
    stood in the garden and found it right can say so and save that round.
    """
    def responder(n, prompt):
        yard["saw"]()
        if n == 1:
            return reply([bed_op()], "built it")
        return reply([], "stood in it; the line of the walk is right", done=True)
    yard["install"](responder)
    _, mutations, summary, *_ = agent.run("make a bed", design_path=str(yard["design"]),
                                          explore=True, quiet=True, rounds=5)
    assert len(yard["prompts"]) == 2, (
        f"`done` was ignored — the loop ran {len(yard['prompts'])} rounds")
    assert mutations == 1, mutations


def test_done_is_offered_to_the_model_in_the_schema(yard):
    """A field the model is never told about is a field the model never writes.
    The schema must expose the completion and observation fields so the model
    can use them.
    """
    props = agent.OPS_SCHEMA["properties"]
    assert "done" in props, "the model has no way to say it is finished"
    assert "seen" in props, "the model has no field for what it SAW"
    assert "done" not in agent.OPS_SCHEMA["required"], (
        "`done` is required, so a first pass must declare itself unfinished")


def test_the_stop_reason_is_reported(yard, capsys):
    def responder(n, prompt):
        yard["saw"]()
        return reply([bed_op()], f"round{n}")
    yard["install"](responder)
    agent.run("make a bed", design_path=str(yard["design"]), explore=True, rounds=4)
    out = capsys.readouterr().out
    assert "[round]" in out, out[-800:]
    assert "changed nothing" in out, (
        "the loop stopped and never said why — an unexplained early stop is "
        "indistinguishable from a crash")


# ── what the owner ends up reading ────────────────────────────────────────
def test_what_the_model_SAW_reaches_the_owner(yard):
    """The judgement cannot be a number, so it has to be words, and the words are
    worth nothing sitting in a subprocess's stdout. run()'s summary is the only
    string the viewer's Design button ever shows the owner.
    """
    def responder(n, prompt):
        yard["saw"]()
        return reply([bed_op(shift=0.1 * n)], f"round{n}",
                     seen=f"round {n}: the bed reads as a rectangle from the door")
    yard["install"](responder)
    _, _, summary, *_ = agent.run("make a bed", design_path=str(yard["design"]),
                                  explore=True, quiet=True, rounds=2)
    assert "reads as a rectangle" in summary, summary
    assert "round 1" in summary and "round 2" in summary, summary


def test_a_single_round_summary_is_left_alone(yard):
    """No round-by-round apparatus around a run that had one round."""
    yard["install"](lambda n, p: (yard["saw"](), reply([bed_op()], "just this"))[1])
    _, _, summary, *_ = agent.run("make a bed", design_path=str(yard["design"]),
                                  explore=True, quiet=True)
    assert summary == "just this", summary


def test_run_keeps_its_five_value_contract(yard):
    yard["install"](lambda n, p: (yard["saw"](), reply([bed_op()], "x"))[1])
    out = agent.run("make a bed", design_path=str(yard["design"]),
                    explore=True, quiet=True, rounds=2)
    assert len(out) == 5, out
    design, mutations, summary, confidence, cautions = out
    assert isinstance(design, dict) and isinstance(mutations, int)
    assert confidence == "high"


# ── the two budgets are separate ──────────────────────────────────────────
def test_a_parse_error_does_not_cost_a_design_round(yard):
    """The discriminator for "beside, not inside".

    Round 1 wastes one attempt on malformed JSON; round 2 wastes another. That is
    four model calls, and no single `range(3)` counter can produce four. If the
    design loop were nested inside the attempts loop this test cannot pass.
    """
    def responder(n, prompt):
        if n in (1, 3):
            return "not json at all"
        yard["saw"]()
        return reply([bed_op(shift=0.1 * n)], f"call{n}")
    yard["install"](responder)
    _, _, summary, *_ = agent.run("make a bed", design_path=str(yard["design"]),
                                  explore=True, quiet=True, rounds=2)
    assert len(yard["prompts"]) == 4, (
        f"{len(yard['prompts'])} calls: the parse-error retry and the design round "
        f"are sharing one budget")
    assert summary == "call4", summary


def test_a_retry_inside_a_round_still_carries_the_revise_brief(yard):
    """Otherwise the retry is prompted as if it were a fresh design and the round
    silently becomes a first pass again."""
    def responder(n, prompt):
        if n == 2:
            return "not json"
        yard["saw"]()
        return reply([bed_op(shift=0.1 * n)], f"call{n}")
    yard["install"](responder)
    agent.run("make a bed", design_path=str(yard["design"]),
              explore=True, quiet=True, rounds=2)
    assert len(yard["prompts"]) == 3, yard["prompts"]
    third = yard["prompts"][2]
    assert agent.REVISE_FEEDBACK.split("\n")[0] in third, (
        "the JSON-retry prompt dropped the revise brief")
    assert "NOT VALID JSON" in third, "the retry was not told what was wrong"


# ── the render gate is per ROUND, not per run ─────────────────────────────
def test_a_revision_that_never_looked_is_sent_back_too(yard):
    """The gate discards a first pass that produces geometry and never renders it.
    A REVISION that never rendered is the same defect wearing a later number —
    and the run-level flag would excuse it, because round 1 already looked.
    """
    def responder(n, prompt):
        if n == 1:
            yard["saw"]()                 # round 1 looks
        # round 2 (call 2) deliberately does not
        if n == 3:
            yard["saw"]()
        return reply([bed_op(shift=0.1 * n)], f"call{n}")
    yard["install"](responder)
    agent.run("make a bed", design_path=str(yard["design"]),
              explore=True, quiet=True, rounds=2)
    assert len(yard["prompts"]) == 3, (
        f"{len(yard['prompts'])} calls: a revision round that never rendered its "
        f"own change was accepted")
    assert agent.LOOK_FEEDBACK in yard["prompts"][2], (
        "the blind revision was re-prompted without the look-again brief")


def test_round_ones_walk_does_not_excuse_round_two(yard):
    """The same lesson as `test_only_calls_from_THIS_run_count`, one level down:
    the call log is append-only, so the mark has to move at the start of every
    round or a single early walkthrough licenses every later round.
    """
    marks = []
    real = agent.looked_at_own_work

    def spy(log_path, since):
        marks.append(since)
        return real(log_path, since)
    import unittest.mock as mock
    with mock.patch.object(agent, "looked_at_own_work", spy):
        def responder(n, prompt):
            yard["saw"]()
            return reply([bed_op(shift=0.1 * n)], f"call{n}")
        yard["install"](responder)
        agent.run("make a bed", design_path=str(yard["design"]),
                  explore=True, quiet=True, rounds=2)
    assert len(marks) == 2, marks
    assert marks[1] > marks[0], (
        f"the log mark did not move between rounds ({marks}) — round 1's walk is "
        f"still counted as round 2's")


# ── the brief must not become a rule ──────────────────────────────────────
def test_the_revise_brief_asks_for_SEEING_not_for_a_score():
    """Metrics in the brief can encourage overly wide paths instead of visual
    judgement. The loop gives the model more seeing, never more rules.
    """
    msg = agent.REVISE_FEEDBACK
    low = msg.lower()
    for word in ("look", "walk_through", "saw"):
        assert word in low, f"{word!r} missing from the revise brief"
    for banned in ("%", "ratio", "score", "at least", "must be", "m2 per plant",
                   "species", "target"):
        assert banned not in low, f"the revise brief smuggles in a metric: {banned!r}"


def test_the_loop_scores_nothing():
    """No comparator anywhere decides one round is BETTER than another. The only
    arithmetic the loop does is 'is this the same design', which is identity, not
    quality — the moment a run can rank its own rounds, the next session will let
    it optimise the ranking.
    """
    src = open(os.path.join(ROOT, "tools", "agent.py")).read()
    i = src.index("REVISE_FEEDBACK")
    block = src[i:src.index("def run(", i)].lower()
    for banned in ("better", "improve", "score", "quality"):
        assert banned not in block, (
            f"the design loop has grown an opinion — {banned!r} — about which "
            f"round is good. Only the owner ranks designs")
