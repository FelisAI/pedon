"""Every tool the MCP server registers must be one the design agent may call.

The site queries are on MCP so the model can ask the ground a question without
remembering a filename — AGENTS.md's own rule is that the right shape for the
design agent mid-design is an MCP tool. If agent.py's --allowedTools list names
only some of them, the rest are registered, correct, tested, and unreachable
from the only caller they were built for.

A tool that is built, tested and shipped but that nothing offers gets ZERO calls
from a cold-start session. A capability nobody can reach is not a capability.
"""
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))


_REGISTERED = None


def registered_tools():
    """Ask the server, the way a real client does — once.

    Spawning view_mcp.py per test would triple the cost of this file for three
    identical answers, and tools/selftest.py holds the suite to a CPU budget
    precisely so it stays cheap enough to run before and after every change.
    """
    global _REGISTERED
    if _REGISTERED is not None:
        return _REGISTERED
    msgs = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}]
    proc = subprocess.run(
        [sys.executable, os.path.join(ROOT, "tools", "view_mcp.py")],
        input="\n".join(json.dumps(m) for m in msgs) + "\n",
        capture_output=True, text=True, timeout=60)
    for line in proc.stdout.splitlines():
        try:
            m = json.loads(line)
        except ValueError:
            continue
        if m.get("id") == 2:
            _REGISTERED = {t["name"] for t in m["result"]["tools"]}
            return _REGISTERED
    raise AssertionError(f"server never answered tools/list: {proc.stdout[:400]} {proc.stderr[:400]}")


def allowed_tools():
    """Read the list agent.py actually passes, not the source text around it.

    A regex over the --allowedTools literal breaks the moment the names are
    factored into a constant — the test would go red on a REFACTOR while staying
    blind to a real drift, which is the wrong way round."""
    import agent
    prefix = "mcp__yardeye__"
    return {t[len(prefix):] for t in agent.MCP_TOOLS if t.startswith(prefix)}


def test_the_allowlist_is_the_one_the_subprocess_gets():
    """Guard the indirection: MCP_TOOLS must really reach --allowedTools."""
    with open(os.path.join(ROOT, "tools", "agent.py")) as f:
        src = f.read()
    i = src.index('"--allowedTools"')
    assert "MCP_TOOLS" in src[i:src.index("]", i)], (
        "--allowedTools no longer spreads MCP_TOOLS, so allowed_tools() below is "
        "reading a list nothing passes")


def test_the_server_registers_more_than_the_three_viewer_tools():
    """Otherwise the comparison below is trivially satisfiable."""
    got = registered_tools()
    assert len(got) >= 10, f"only {len(got)} tools registered: {sorted(got)}"


def test_every_registered_tool_is_offered_to_the_design_agent():
    registered, allowed = registered_tools(), allowed_tools()
    missing = registered - allowed
    assert not missing, (
        f"{len(missing)} MCP tool(s) the model cannot call: {sorted(missing)} — "
        f"registered by view_mcp.py, absent from agent.py's --allowedTools")


def test_nothing_is_allowed_that_does_not_exist():
    """A stale name in the allowlist is a silent no-op, and reads as coverage."""
    registered, allowed = registered_tools(), allowed_tools()
    ghosts = allowed - registered
    assert not ghosts, f"allowlisted but not registered: {sorted(ghosts)}"
