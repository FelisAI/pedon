"""Give `--explore` a call budget that DEGRADES instead of truncating.

Why this exists
---------------
`--explore` lets the spawned model query the real ground with
`tools/site_api.py`, and unbounded, the count runs far past the useful work.
Measured in `data/site_api_calls.log`:

  * one run made **350** logged queries; the run that produced the *best*
    design made **119**, so the ceiling is nowhere near the useful work;
  * **29** of one run's calls were `validate`, unbounded — the loop narrowing a
    patio by 10 cm against the real validator;
  * **236 of 350 (67%)** were single-point `ground`/`slope`, against **2.9%**
    for `ground-many`/`slope-many`, which answer a whole list in ONE call.

The shape of the fix matters more than the number. A budget that CUTS THE MODEL
OFF mid-design hands back a half-applied op list, and that is worse than a
cheap design: an op the model never got to submit is a
piece of the garden silently lost, exactly like a rejected op. So the budget
warns as it is approached and, when it runs out, instructs the model to finish
with what it already measured. It never raises and it never denies a call.

What is tested here
-------------------
The accounting is driven DIRECTLY — no `claude -p` is spawned, by design: a test
that needs the subscription CLI is a test nobody runs. Three layers:

  (a) `agent.CallBudget` — thresholds, one-shot warnings, exhaustion returning
      an instruction rather than an exception;
  (b) the ledger on disk, because the PreToolUse hook is a FRESH PROCESS per
      tool call and has nowhere else to keep the count;
  (c) the wiring — that `call_claude_explore` actually installs the hook and
      that the brief tells the model the number, since an unwired budget is
      correct code with zero callers.
"""
from __future__ import annotations
import json
import math
import os
import subprocess
import sys
import tempfile

import pytest

# conftest.py does this too. Repeated deliberately: several people are adding
# files under tests/ at once, and a test that only runs when someone else's
# conftest survives is not a test.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))
import agent                                                    # noqa: E402


AGENT_PY = os.path.join(agent.ROOT, "tools", "agent.py")


def drain(budget, n):
    """Spend n calls one at a time; return every message the model would see."""
    return [m for m in (budget.spend() for _ in range(n)) if m]


# ── the number, and that it is a parameter ────────────────────────────────
def test_the_default_budget_is_a_documented_number_between_the_two_measured_runs():
    """119 queries produced the best design; 350 is the run this exists for.

    A default under 119 would tax the run that already works, and one over 350
    would never fire. Asserting the ORDER rather than the literal lets the
    number be retuned without editing a test, but keeps it honest.
    """
    assert isinstance(agent.DEFAULT_CALL_BUDGET, int)
    assert 119 < agent.DEFAULT_CALL_BUDGET < 350, (
        "the default has to leave the 119-call run alone and bite the 350-call one; "
        f"it is {agent.DEFAULT_CALL_BUDGET}")
    assert agent.CallBudget().limit == agent.DEFAULT_CALL_BUDGET


def test_the_budget_is_a_parameter_not_a_constant():
    b = agent.CallBudget(limit=40, warn_at=(0.5,))
    assert b.limit == 40
    assert b.remaining == 40
    drain(b, 39)
    assert b.remaining == 1 and not b.exhausted


def test_the_run_that_already_works_never_sees_a_warning():
    """The 119-call run is the good one. If the budget nags it, the budget is
    mistuned — this is the test that keeps the default honest."""
    b = agent.CallBudget()
    msgs = drain(b, 119)
    assert msgs == [], f"119 calls produced {len(msgs)} message(s): {msgs}"


# ── warnings ──────────────────────────────────────────────────────────────
def test_the_first_warning_fires_exactly_at_the_first_threshold():
    b = agent.CallBudget(limit=100, warn_at=(0.7, 0.9))
    assert drain(b, 69) == [], "warned before the threshold"
    m = b.spend()
    assert m, "no warning at the 70th of 100 calls"
    assert "budget" in m.lower()
    assert "30" in m, f"the warning must say how many are left: {m}"
    assert "ground-many" in m, f"the warning must name the batch tool: {m}"


def test_a_warning_fires_once_and_then_stops_nagging():
    b = agent.CallBudget(limit=100, warn_at=(0.7, 0.9))
    drain(b, 69)
    assert b.spend(), "no warning at the threshold"
    # calls 71..89 are between the two thresholds: silence
    assert drain(b, 19) == [], "the first warning repeated"


def test_the_second_warning_fires_at_the_second_threshold_and_is_more_urgent():
    b = agent.CallBudget(limit=100, warn_at=(0.7, 0.9))
    msgs = drain(b, 90)
    assert len(msgs) == 2, f"expected one message per threshold, got {len(msgs)}: {msgs}"
    first, second = msgs
    assert first != second, "both thresholds said the same thing"
    assert "converge" in second.lower() or "final" in second.lower(), second
    assert drain(b, 9) == [], "the second warning repeated"


def test_every_configured_threshold_gets_its_own_warning():
    """Presence and COUNT before deltas: three thresholds, three messages."""
    b = agent.CallBudget(limit=100, warn_at=(0.25, 0.5, 0.75))
    msgs = drain(b, 99)
    assert len(msgs) == 3, f"{len(msgs)} messages for 3 thresholds: {msgs}"
    assert len(set(msgs)) >= 2, "the thresholds are indistinguishable"


# ── exhaustion: an instruction, never an exception ────────────────────────
def test_exhaustion_returns_a_finish_now_instruction_rather_than_raising():
    b = agent.CallBudget(limit=10, warn_at=(0.7,))
    msgs = drain(b, 10)                         # must not raise
    assert b.exhausted and b.remaining == 0
    last = msgs[-1]
    assert "exhausted" in last.lower(), last
    assert "finish" in last.lower(), (
        "exhaustion has to TELL THE MODEL TO FINISH, not merely report a number: " + last)
    assert "cautions" in last.lower(), (
        "an unverified design must be told to say so in cautions: " + last)


def test_an_exhausted_budget_keeps_answering_instead_of_cutting_the_model_off():
    """A half-applied op list is worse than a cheap one, so spending past the
    limit is allowed and simply repeats the instruction."""
    b = agent.CallBudget(limit=5, warn_at=(0.8,))
    drain(b, 5)
    after = drain(b, 4)                          # must not raise
    assert len(after) == 4, f"went quiet after exhaustion: {after}"
    assert all("exhausted" in m.lower() for m in after)
    assert b.spent == 9, "overrun is not being recorded"


def test_a_single_big_spend_that_skips_a_threshold_still_reports_exhaustion():
    """One Bash line can chain several queries, so a spend can jump the whole
    ladder. It must land on the finish-now message, not on a stale warning."""
    b = agent.CallBudget(limit=20, warn_at=(0.7, 0.9))
    m = b.spend(50)
    assert m and "exhausted" in m.lower(), m
    assert b.spent == 50


def test_a_budget_of_zero_is_the_documented_unbounded_escape_hatch():
    b = agent.CallBudget(limit=0)
    assert drain(b, 500) == []
    assert not b.exhausted


def test_a_budget_of_one_still_degrades_rather_than_erroring():
    b = agent.CallBudget(limit=1)
    m = b.spend()
    assert m and "exhausted" in m.lower(), m


# ── the ledger: the hook is a fresh process every time ────────────────────
def test_the_ledger_carries_the_count_between_processes(tmp_path):
    led = str(tmp_path / "budget.json")
    agent.budget_reset(led, limit=10, warn_at=(0.8,))
    for _ in range(7):
        agent.budget_spend(led)
    assert agent.budget_load(led).spent == 7
    assert agent.budget_load(led).limit == 10, "the ledger lost the run's limit"


def test_the_ledger_remembers_which_warnings_were_already_said(tmp_path):
    led = str(tmp_path / "budget.json")
    agent.budget_reset(led, limit=10, warn_at=(0.5,))
    said = [m for m in (agent.budget_spend(led) for _ in range(9)) if m]
    assert len(said) == 1, f"the warning repeated across processes: {said}"


def test_the_ledger_tallies_what_the_budget_went_on(tmp_path):
    """29 unbounded `validate` calls is the measurement this exists to expose,
    so the ledger has to be able to say so afterwards."""
    led = str(tmp_path / "budget.json")
    agent.budget_reset(led, limit=50)
    agent.budget_spend(led, cmds=["validate", "validate", "ground"])
    assert agent.budget_load(led).by_cmd == {"validate": 2, "ground": 1}


# ── counting what a Bash command line will actually cost ──────────────────
def test_a_chained_command_costs_one_per_site_api_invocation():
    cmds = agent.site_queries_in(
        "python3 tools/site_api.py ground 1 2 && python3 tools/site_api.py slope-many '[[1,2]]'")
    assert cmds == ["ground", "slope-many"]


def test_a_command_that_is_not_a_site_query_costs_nothing():
    assert agent.site_queries_in("ls data/") == []
    assert agent.site_queries_in("python3 tools/agent.py --help") == []
    assert agent.site_queries_in(None) == []


def test_an_unparsable_invocation_still_costs_its_call():
    """Better to charge an unrecognised form than to let it ride free — the
    budget's whole job is that nothing is unbounded."""
    assert agent.site_queries_in("python3 tools/site_api.py $CMD 1 2") == ["?"]


# ── the hook: it must never deny, and never fail loudly ───────────────────
def hook(stdin_obj, ledger):
    return agent.budget_hook_main(["--budget-hook", "--ledger", ledger],
                                  json.dumps(stdin_obj))


def bash(cmd):
    return {"tool_name": "Bash", "tool_input": {"command": cmd}}


def test_the_hook_stays_silent_until_a_threshold_is_crossed(tmp_path):
    led = str(tmp_path / "b.json")
    agent.budget_reset(led, limit=10, warn_at=(0.8,))
    rc, out = hook(bash("python3 tools/site_api.py ground 1 2"), led)
    assert rc == 0 and out == "", out
    assert agent.budget_load(led).spent == 1, "the hook did not charge the call"


def test_the_hook_hands_the_model_the_message_when_one_is_due(tmp_path):
    led = str(tmp_path / "b.json")
    agent.budget_reset(led, limit=10, warn_at=(0.8,))
    for _ in range(7):
        hook(bash("python3 tools/site_api.py ground 1 2"), led)
    rc, out = hook(bash("python3 tools/site_api.py ground 1 2"), led)
    assert rc == 0
    payload = json.loads(out)
    ctx = payload["hookSpecificOutput"]["additionalContext"]
    assert payload["hookSpecificOutput"]["hookEventName"] == "PreToolUse"
    assert "budget" in ctx.lower()


def test_the_hook_never_denies_a_call(tmp_path):
    """Truncation is the failure mode this whole change exists to avoid, so the
    hook must not emit a deny at ANY point, exhausted or not."""
    led = str(tmp_path / "b.json")
    agent.budget_reset(led, limit=3, warn_at=(0.5,))
    outs = []
    for _ in range(8):
        rc, out = hook(bash("python3 tools/site_api.py ground 1 2"), led)
        assert rc == 0, f"the hook exited {rc}; a non-zero PreToolUse hook BLOCKS the call"
        outs.append(out)
    bodies = [json.loads(o) for o in outs if o]
    assert bodies, "the hook said nothing at all across a whole exhausted budget"
    assert not any("deny" in json.dumps(b).lower() for b in bodies), bodies
    assert any("exhausted" in json.dumps(b).lower() for b in bodies), (
        "an exhausted budget never told the model to finish")


def test_the_hook_ignores_a_non_bash_tool_call(tmp_path):
    led = str(tmp_path / "b.json")
    agent.budget_reset(led, limit=5)
    rc, out = hook({"tool_name": "Read", "tool_input": {"file_path": "site_api.py"}}, led)
    assert (rc, out) == (0, "")
    assert agent.budget_load(led).spent == 0


@pytest.mark.parametrize("junk", ["", "not json", "[]", "null", '{"tool_input": 7}'])
def test_the_hook_survives_junk_on_stdin(tmp_path, junk):
    """It runs on every Bash call the design agent makes. A traceback here
    would break a run that has nothing to do with the budget."""
    led = str(tmp_path / "b.json")
    agent.budget_reset(led, limit=5)
    assert agent.budget_hook_main(["--budget-hook", "--ledger", led], junk) == (0, "")


def test_the_hook_survives_an_unwritable_ledger():
    rc, out = hook(bash("python3 tools/site_api.py ground 1 2"),
                   "/nonexistent-dir-for-pedon/budget.json")
    assert (rc, out) == (0, "")


def test_the_hook_runs_as_a_real_command_line(tmp_path):
    """The settings file hands Claude Code a COMMAND. If that command is not
    runnable the budget is silently absent from every explore run, which is
    exactly how an unwired capability hides — so run it for real, once."""
    led = str(tmp_path / "b.json")
    agent.budget_reset(led, limit=2, warn_at=(0.5,))
    ev = json.dumps(bash("python3 tools/site_api.py ground 1 2"))
    r = subprocess.run([sys.executable, AGENT_PY, "--budget-hook", "--ledger", led],
                       input=ev, capture_output=True, text=True, timeout=60, cwd=agent.ROOT)
    assert r.returncode == 0, r.stderr[-800:]
    assert json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"]
    assert agent.budget_load(led).spent == 1


# ── the wiring: an unwired budget is not a budget ─────────────────────────
def test_the_explore_brief_tells_the_model_the_number():
    brief = agent.explore_brief(180)
    assert "180" in brief, "the model is never told its budget"
    assert "ground-many" in brief
    assert "<call_budget" not in brief, "an unsubstituted token leaked into the prompt"


def test_an_unbounded_run_does_not_claim_a_budget_in_the_brief():
    brief = agent.explore_brief(0)
    assert "<call_budget" not in brief
    assert "budgeted" not in brief.lower(), (
        "with --call-budget 0 the model must not be told it has a limit it does not have")


def test_call_claude_explore_installs_the_hook(monkeypatch, tmp_path):
    """Drives the real argv builder with the subprocess stubbed: no claude -p."""
    seen = {}

    class Res:
        returncode, stdout, stderr = 0, '{"ops": []}', ""

    def fake_run(args, **kw):
        seen["args"] = args
        return Res()

    monkeypatch.setattr(agent.subprocess, "run", fake_run)
    agent.call_claude_explore("hi", "claude-opus-5", call_budget=42)
    args = seen["args"]
    assert "--settings" in args, "no settings passed, so no hook, so no budget"
    settings_arg = args[args.index("--settings") + 1]
    settings = json.load(open(settings_arg)) if os.path.exists(settings_arg) \
        else json.loads(settings_arg)
    pre = settings["hooks"]["PreToolUse"]
    cmd = pre[0]["hooks"][0]["command"]
    assert "--budget-hook" in cmd and "agent.py" in cmd, cmd
    assert "--ledger" in cmd, cmd
    # the ledger must exist and already carry this run's limit, or the hook's
    # first spend would silently fall back to the default
    led = cmd.split("--ledger")[1].strip().strip("'\"")
    assert agent.budget_load(led).limit == 42


def test_call_claude_explore_still_passes_strict_mcp_config(monkeypatch):
    """docs/design-agent.md: --strict-mcp-config is not optional. The budget must not have
    displaced it."""
    seen = {}

    class Res:
        returncode, stdout, stderr = 0, "{}", ""

    monkeypatch.setattr(agent.subprocess, "run",
                        lambda args, **kw: (seen.update(args=args), Res())[1])
    agent.call_claude_explore("hi", "claude-opus-5", call_budget=42)
    if os.path.exists(os.path.join(agent.ROOT, ".mcp.json")):
        assert "--strict-mcp-config" in seen["args"]


def test_an_unbounded_run_installs_no_hook(monkeypatch):
    seen = {}

    class Res:
        returncode, stdout, stderr = 0, "{}", ""

    monkeypatch.setattr(agent.subprocess, "run",
                        lambda args, **kw: (seen.update(args=args), Res())[1])
    agent.call_claude_explore("hi", "claude-opus-5", call_budget=0)
    assert "--settings" not in seen["args"]


def test_a_broken_budget_setup_does_not_break_the_design_run(monkeypatch):
    """The budget is an economy measure. If it cannot be installed the run must
    still happen — losing a design to a bookkeeping failure is a bad trade."""
    seen = {}

    class Res:
        returncode, stdout, stderr = 0, "{}", ""

    def boom(*a, **k):
        raise OSError("no temp space")

    monkeypatch.setattr(agent, "budget_reset", boom)
    monkeypatch.setattr(agent.subprocess, "run",
                        lambda args, **kw: (seen.update(args=args), Res())[1])
    agent.call_claude_explore("hi", "claude-opus-5", call_budget=42)
    assert seen["args"][:2] == ["claude", "-p"]
    assert "--settings" not in seen["args"]


def test_run_passes_its_budget_through_to_the_explore_backend(monkeypatch, tmp_path):
    """agent.run() is the only caller. If it drops the parameter the CLI flag is
    decoration."""
    seen = {}

    def fake_explore(prompt, model, timeout_s=1800, schema_json=None,
                     call_budget=agent.DEFAULT_CALL_BUDGET, **kw):
        seen["budget"] = call_budget
        return json.dumps({"ops": [], "summary": "", "confidence": "", "cautions": ""})

    monkeypatch.setattr(agent, "call_claude_explore", fake_explore)
    d = str(tmp_path / "design.json")
    with open(agent.DESIGN_PATH) as f, open(d, "w") as out:
        out.write(f.read())
    agent.run("do nothing", design_path=d, quiet=True, explore=True, call_budget=77)
    assert seen["budget"] == 77


def test_the_cli_exposes_the_budget_as_a_flag():
    """A parameter no one can set from the command line is a constant."""
    r = subprocess.run([sys.executable, AGENT_PY, "--help"],
                       capture_output=True, text=True, timeout=60, cwd=agent.ROOT)
    assert r.returncode == 0, r.stderr[-800:]
    assert "--call-budget" in r.stdout, r.stdout
    assert str(agent.DEFAULT_CALL_BUDGET) in r.stdout, "the default is not documented in --help"


def test_the_real_explore_backend_still_takes_the_budget():
    """run() ASKS its backend whether it takes the budget before forwarding it,
    because several tests stub that backend with a narrower signature. That ask
    is the one thing that could un-wire the budget silently, so pin it."""
    assert agent.takes_call_budget(agent.call_claude_explore), (
        "run() will stop forwarding the budget and nothing else would notice")
    assert agent.takes_call_budget(lambda p, m, **kw: "")
    assert not agent.takes_call_budget(lambda p, m, schema_json=None: "")
