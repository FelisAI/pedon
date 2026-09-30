"""The call log records what HAPPENED, not just what was asked.

A `site_api_calls.log` that records requests and never RESULTS leaves no trace
of a refusal, so "was the agent refused, and did it understand why" cannot be
answered after a run.

This file is the EVIDENCE every traffic figure is quoted from: `claude -p`
prints only its final answer, so without the log there is no way to tell
whether the model queried the site or simply guessed well. Half of that
question is whether it was TOLD NO — and a row written before the call ran
cannot say.
"""
import pytest
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.join(ROOT, "tools")


def rows(log):
    if not os.path.exists(log):
        return []
    with open(log) as f:
        return [json.loads(l) for l in f if l.strip()]


def run(tool, args, log, env=None):
    e = dict(os.environ, YARDTWIN_CALL_LOG=str(log))
    e.update(env or {})
    return subprocess.run([sys.executable, os.path.join(TOOLS, tool), *args],
                          capture_output=True, text=True, cwd=ROOT, env=e, timeout=120)


@pytest.mark.needs_site
def test_an_answered_query_is_recorded_as_answered(tmp_path):
    log = tmp_path / "calls.log"
    r = run("site_api.py", ["ground", "15", "-6"], log)
    assert r.returncode == 0, r.stdout + r.stderr
    got = rows(log)
    assert len(got) == 1, got
    assert got[0]["cmd"] == "ground"
    assert got[0]["ok"] is True
    assert got[0]["exit"] == 0
    assert "refused" not in got[0]


@pytest.mark.needs_site
def test_a_REFUSAL_says_so_and_says_why(tmp_path):
    """The whole point. A row that only carries cmd and args is indistinguishable
    from a successful one, so a run in which the agent is refused twenty times
    reads exactly like a run in which it is answered twenty times."""
    log = tmp_path / "calls.log"
    r = run("site_api.py", ["area", "there_is_no_such_area"], log)
    assert r.returncode == 1
    got = rows(log)
    assert len(got) == 1, got
    assert got[0]["ok"] is False
    assert got[0]["exit"] == 1
    assert "there_is_no_such_area" in got[0]["refused"], got[0]


def test_a_property_that_is_not_set_up_far_enough_is_a_DIFFERENT_refusal(tmp_path):
    """Exit 2 is "this property is not set up far enough to ask", which is a fact
    about the yard rather than about the query. The log has to keep them apart or
    a run against an unsurveyed property reads as twenty broken queries."""
    empty = tmp_path / "empty"
    (empty / "data").mkdir(parents=True)
    (empty / "tools").mkdir()
    for fn in os.listdir(TOOLS):
        if fn.endswith(".py") or fn == "lib":
            os.symlink(os.path.join(TOOLS, fn), empty / "tools" / fn)
    os.symlink(os.path.join(ROOT, "schema"), empty / "schema")     # part of every checkout
    log = tmp_path / "calls.log"
    e = dict(os.environ, YARDTWIN_CALL_LOG=str(log), PEDON_PROJECT=str(empty / "data"))
    r = subprocess.run([sys.executable, str(empty / "tools" / "site_api.py"), "zones"],
                       capture_output=True, text=True, cwd=str(empty), env=e, timeout=120)
    assert r.returncode == 2, (r.returncode, r.stdout, r.stderr)
    got = rows(log)
    assert got and got[-1]["exit"] == 2
    assert got[-1]["refused"] in ("no_site", "no_scan"), got[-1]


def test_ONE_row_per_call_however_it_ended(tmp_path):
    """Two rows for one call would double every traffic figure — and those
    figures are the measurements this architecture is argued from
    (67% single-point ground/slope against 2.9% for the batch tools)."""
    log = tmp_path / "calls.log"
    run("site_api.py", ["ground", "15", "-6"], log)
    run("site_api.py", ["area", "nope"], log)
    run("site_api.py", ["zones"], log)
    got = rows(log)
    assert len(got) == 3, [g["cmd"] for g in got]


@pytest.mark.needs_site
def test_the_MCP_half_records_the_same_shape(tmp_path):
    """Same file on purpose: the traffic question is "how is the model asking",
    and an answer split across two logs cannot be compared."""
    log = tmp_path / "calls.log"
    run("view_mcp.py", ["zones", "{}"], log)
    run("view_mcp.py", ["area", '{"name":"nope"}'], log)
    got = rows(log)
    assert len(got) == 2, got
    assert all(g["via"] == "mcp" for g in got)
    assert got[0]["ok"] is True and "refused" not in got[0]
    assert got[1]["ok"] is False and "nope" in got[1]["refused"]


def test_a_refusal_the_SCHEMA_makes_is_logged_too(tmp_path):
    """If `do_site` returns on a missing required argument without writing
    anything at all, the model asks, is told no, and the run's evidence shows no
    call. That is the sharpest form of the fault this closes."""
    log = tmp_path / "calls.log"
    run("view_mcp.py", ["ground", "{}"], log)
    got = rows(log)
    assert len(got) == 1, "a schema refusal still leaves no trace"
    assert got[0]["ok"] is False
    assert "missing" in got[0]["refused"]


def test_looked_at_own_work_still_reads_it(tmp_path):
    """The must-look gate reads this file, so widening the shape is its own change.

    It keys on `cmd`/`tool` and `rendered`; fields being ADDED must not disturb
    it, and a row that now says ok:false must not start counting as a look.
    """
    sys.path.insert(0, TOOLS)
    import agent
    log = tmp_path / "calls.log"
    log.write_text("\n".join(json.dumps(r) for r in [
        {"cmd": "ground", "args": {}, "ok": True, "exit": 0},
        {"cmd": "look", "via": "mcp", "args": {}, "ok": False, "refused": "no_viewer"},
    ]) + "\n")
    assert agent.looked_at_own_work(str(log), 0) is False, \
        "a REFUSED look counted as having looked"
    log.write_text(json.dumps({"cmd": "look", "via": "mcp", "args": {},
                               "rendered": True, "ok": True}) + "\n")
    assert agent.looked_at_own_work(str(log), 0) is True
