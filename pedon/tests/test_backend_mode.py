"""Codex backend dispatch, structured output and shared YardEye wiring.

These tests check the local contract without calling a model; a real subscription
run is a separate, manual smoke test.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import agent


def test_codex_explore_has_a_live_budget():
    assert agent.backend_warning("codex", True) is None
    assert agent.takes_call_budget(agent.call_codex_explore)


def test_the_combinations_that_are_fine_stay_silent():
    # the complement — a warning that fires on everything is noise, and noise is
    # how the real one stops being read
    assert agent.backend_warning("claude", True) is None
    assert agent.backend_warning("claude", False) is None
    assert agent.backend_warning("codex", False) is None


def test_run_actually_consults_it():
    # the predicate can be perfect and never reached; this is the wiring half
    import inspect
    src = inspect.getsource(agent.run)
    assert "backend_warning(" in src, "run() never calls backend_warning"


def _argv_of_codex_call(monkeypatch, **kw):
    """The command line call_codex would run, without running codex."""
    seen = {}

    class Res:
        returncode = 0
        stdout = ""
        stderr = ""

    def fake_run(cmd, **_):
        seen["cmd"] = cmd
        # call_codex reads the --output-last-message file afterwards
        i = cmd.index("--output-last-message")
        with open(cmd[i + 1], "w") as f:
            f.write("{}")
        return Res()

    monkeypatch.setattr(agent.subprocess, "run", fake_run)
    agent.call_codex("a prompt", None, **kw)
    return seen["cmd"]


def test_codex_is_handed_the_output_schema():
    # The schema builder's own comment says it is "kept to the simple subset both
    # CLIs accept (claude --json-schema / codex --output-schema)" — the shape is
    # written for both backends, so codex must be given it too. Asked only in
    # prose for one JSON object, nothing enforces that it returns one.
    import pytest

    mp = pytest.MonkeyPatch()
    try:
        cmd = _argv_of_codex_call(mp, schema_json='{"type":"object"}')
    finally:
        mp.undo()
    assert "--output-schema" in cmd, "codex is asked for JSON with no schema"
    path = cmd[cmd.index("--output-schema") + 1]
    assert path.endswith(".json")


def test_no_schema_means_no_flag():
    # The complement: passing the flag with an empty path would be worse than
    # omitting it, and a caller with nothing to enforce must still work.
    import pytest

    mp = pytest.MonkeyPatch()
    try:
        cmd = _argv_of_codex_call(mp)
    finally:
        mp.undo()
    assert "--output-schema" not in cmd


def test_run_hands_codex_a_schema():
    import inspect
    src = inspect.getsource(agent.run)
    assert "schema_json=codex_schema" in src, \
        "run() calls codex without a schema"


def _spawn_of(fn, **kw):
    """The argv and cwd `fn` would spawn, without spawning it."""
    import pytest
    seen = {}

    class Res:
        returncode = 0
        stdout = ""
        stderr = ""

    def fake_run(cmd, **rest):
        seen["cmd"], seen["cwd"] = cmd, rest.get("cwd")
        i = cmd.index("--output-last-message")
        with open(cmd[i + 1], "w") as f:
            f.write("{}")
        return Res()

    mp = pytest.MonkeyPatch()
    try:
        mp.setattr(agent.subprocess, "run", fake_run)
        fn("a prompt", None, **kw)
    finally:
        mp.undo()
    return seen


def test_codex_explore_is_given_the_same_eyes_claude_gets():
    # codex has a shell and gets EXPLORE_BRIEF, so it can ask the ground — but
    # look/preview_design/walk_through come from .mcp.json, and without an MCP
    # config the brief's central loop (apply to a scratch file, preview THAT,
    # look at it) dies at step two: the model is instructed to look at something
    # it has no tool to look at.
    cmd = _spawn_of(agent.call_codex_explore)["cmd"]
    joined = " ".join(cmd)
    assert "mcp_servers.yardeye.command" in joined, "codex explore has no eyes"
    assert "tools/view_mcp.py" in joined, "the yardeye server is not the one wired"


def test_the_mcp_config_is_derived_from_the_file_claude_uses():
    # One source of truth. Two backends looking through different eyes while both
    # log "look" is exactly the drift a second copy invites.
    args = agent.codex_mcp_args(os.path.join(agent.ROOT, ".mcp.json"))
    assert args, ".mcp.json produced no codex overrides"
    assert args.count("-c") == len(args) // 2, "every override needs its own -c"
    # a missing or broken file must not crash a design run
    assert agent.codex_mcp_args("/no/such/file.json") == []


def test_codex_explore_runs_from_the_project_root():
    # EXPLORE_BRIEF names `python3 tools/site_api.py` by RELATIVE path, so a run
    # started from anywhere else silently has no site tools. The claude path
    # passes cwd=ROOT, and the codex one must too.
    assert _spawn_of(agent.call_codex_explore)["cwd"] == agent.ROOT


def test_explore_selects_the_exploring_codex_call():
    import inspect
    src = inspect.getsource(agent.run)
    assert "call_codex_explore if explore else call_codex" in src, \
        "--backend codex --explore no longer reaches the exploring path"
