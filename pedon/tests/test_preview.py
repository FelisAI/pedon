"""The design agent must be able to LOOK at the design it is proposing.

agent.py applies the proposed op list only after run() returns, and the viewer
renders data/design.json and nothing else. Without a preview, every `look` in a run
renders the owner's existing working design, so the eye-level check that this whole
"browser as eyes" capability exists to provide is, for the entire run, a check of
somebody else's design — and the model can only notice at the end.

That is worse than not having the capability. A tool that answers confidently about
the wrong subject is how frame bugs survive: everything looks right.

The fix is a preview channel — the viewer can be told to render a DIFFERENT design
file, so the loop becomes: apply the proposal to a scratch file (site_api apply-ops
--design), point the viewer at it, look, iterate. Nothing about the owner's working
design is touched.
"""
import json
import os
import shutil
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))


def test_the_mcp_server_offers_a_preview_tool():
    """The model reaches for tools it is offered; prose in a brief loses to
    affordance shape here, which is why the site queries are MCP tools at all."""
    msgs = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}]
    r = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "view_mcp.py")],
                       input="\n".join(json.dumps(m) for m in msgs) + "\n",
                       capture_output=True, text=True, timeout=60)
    names = set()
    for line in r.stdout.splitlines():
        try:
            m = json.loads(line)
        except ValueError:
            continue
        if m.get("id") == 2:
            names = {t["name"] for t in m["result"]["tools"]}
    assert names, f"server never listed its tools: {r.stdout[:300]} {r.stderr[:300]}"
    assert "preview_design" in names, (
        f"no preview tool, so `look` can only ever show data/design.json — the model "
        f"cannot see its own proposal. Offered: {sorted(names)}")


def test_the_design_agent_is_allowed_to_call_it():
    """Registered but not allowlisted leaves a tool correct, tested, and
    unreachable from the only caller."""
    import agent
    assert "mcp__yardeye__preview_design" in agent.MCP_TOOLS, (
        "preview_design is not in agent.MCP_TOOLS, so the design agent cannot call it")


def test_the_brief_tells_the_model_the_loop():
    """A capability nobody knows the shape of is not a capability. The model must
    be told that a proposal is invisible until previewed."""
    import agent
    brief = agent.EXPLORE_BRIEF.lower()
    assert "preview" in brief, (
        "EXPLORE_BRIEF never mentions preview, so the model will keep calling look "
        "on the owner's design and believing it is looking at its own work")


def test_the_viewer_can_render_a_file_that_is_not_design_json():
    """The viewer half. Source-level, because rendering needs a browser."""
    with open(os.path.join(ROOT, "viewer", "src", "main.js")) as f:
        main = f.read()
    with open(os.path.join(ROOT, "viewer", "src", "viewport.js")) as f:
        vp = f.read()
    assert "preview" in vp, "viewport.js has no preview op"
    assert "previewSource" in main or "previewPath" in main, (
        "main.js has no notion of a design source other than data/design.json")
