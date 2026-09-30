"""Everything a designer would ask about, askable — and advertised.

The model can pull, and KNOWS to pull, all the information it needs — not by
being fed restrictions, but by being given what a human would tell a designer.

Both halves matter and the second is the harder one. A capability the model has
to remember goes unused: a cold-start session makes ZERO site_api calls when
nothing it reads names the tool, and the batch queries get 2.9% of traffic even
while the brief explicitly tells the model to use them. Prose loses to affordance
shape. So a tool is not "available" here until it is registered, allowlisted, and
its description says WHEN to reach for it.

Three things a designer asks, each with an answer:
  * where is the sun, and what is in shade — the first question about any seat
  * what plants and objects EXIST — asking for what the library does not have is
    fine, but not knowing what it does have is a handicap nobody chose
  * what can be SEEN from here — framed views are most of what makes a garden
    read as composed rather than assembled
"""
import json
import os
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))


def tools():
    msgs = [{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}]
    r = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "view_mcp.py")],
                       input="\n".join(json.dumps(m) for m in msgs) + "\n",
                       capture_output=True, text=True, timeout=60)
    for line in r.stdout.splitlines():
        try:
            m = json.loads(line)
        except ValueError:
            continue
        if m.get("id") == 2:
            return {t["name"]: t for t in m["result"]["tools"]}
    raise AssertionError(f"no tools/list reply: {r.stdout[:300]}{r.stderr[:300]}")


DESIGNER_NEEDS = ["sun", "list_assets", "sightline"]


def test_the_server_answers_at_all():
    """Guard the mechanism before asserting what it offers."""
    assert len(tools()) >= 14


@pytest.mark.parametrize("name", DESIGNER_NEEDS)
def test_the_question_can_be_asked(name):
    assert name in tools(), (
        f"a designer asks about this and the model cannot: {name}")


@pytest.mark.parametrize("name", DESIGNER_NEEDS)
def test_the_model_is_allowed_to_call_it(name):
    import agent
    assert f"mcp__yardeye__{name}" in agent.MCP_TOOLS, (
        f"{name} is registered but not allowlisted — so it is unreachable from the "
        f"only caller it was built for")


@pytest.mark.parametrize("name", DESIGNER_NEEDS)
def test_the_description_says_when_to_reach_for_it(name):
    """A description that restates the name teaches nothing; the model has to know
    the OCCASION. check_ground_contact's is the model to follow."""
    d = tools()[name]["description"].lower()
    assert len(d) > 120, f"{name}'s description is too thin to teach anything: {d!r}"
    assert any(w in d for w in ("use this", "before", "after", "when ", "ask ")), (
        f"{name}'s description never says WHEN to call it: {d!r}")
