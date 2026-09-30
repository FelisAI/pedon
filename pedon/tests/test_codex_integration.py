"""Codex's real failure modes: strict schema, usable tools, truthful review.

The subscription smoke run is separate; these tests need no account or viewer.
"""
import base64
import json
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import jsonschema
import pytest

import agent
import codex_setup
import view_mcp
import project  # noqa: E402


def strict_objects(schema):
    if not isinstance(schema, dict):
        return
    if schema.get("type") == "object":
        yield schema
    for value in schema.values():
        if isinstance(value, dict):
            yield from strict_objects(value)
        elif isinstance(value, list):
            for child in value:
                yield from strict_objects(child)


def test_schema_satisfies_the_service_contract_and_allows_garden_objects():
    shared = json.loads(agent.ops_schema_json(agent.constraints(None)))
    strict = agent.codex_output_schema(shared)
    for obj in strict_objects(strict):
        assert obj.get("additionalProperties") is False
        assert set(obj["required"]) == set(obj["properties"])
    fields = strict["properties"]["ops"]["items"]["properties"]["input"]["properties"]
    inp = dict.fromkeys(fields)
    inp.update(id="pause", kind="bench", position=[-2, 9], height_m=.45, width_m=1.5)
    response = dict(ops=[dict(tool="place_object", input=inp)], summary="A place to pause",
                    confidence="high", cautions="", seen=None, done=None)
    jsonschema.validate(response, strict)
    clean = agent.without_null_fields(response)
    assert "level_m" not in clean["ops"][0]["input"]  # stand on ground by default
    assert clean["ops"][0]["input"]["position"] == [-2, 9]
    jsonschema.validate(clean, shared)
    assert "done" not in clean
    assert "additionalProperties" not in shared  # other backend unchanged


@pytest.mark.parametrize("name,result,expected", [
    ("look", {"content": [{"type": "text", "text": "Could not render: context lost"}]}, False),
    ("walk_through", {"content": []}, False),
    ("check_ground_contact", {"content": [{"type": "text", "text": "Nothing floats"}]}, False),
    ("look", {"content": [{"type": "image", "data": "aW1hZ2U="}]}, True),
    ("walk_through", {"content": [{"type": "image", "data": "aW1hZ2U="}], "isError": True}, False),
])
def test_gate_checks_returned_images_not_attempts(monkeypatch, tmp_path, name, result, expected):
    log = tmp_path / "calls.jsonl"
    monkeypatch.setattr(view_mcp, "CALL_LOG", str(log))
    monkeypatch.setattr(view_mcp, "HANDLERS", {name: lambda args: result})
    view_mcp.call_tool(name, {})
    assert agent.looked_at_own_work(str(log), 0) is expected


def test_legacy_attempt_log_is_not_visual_evidence(tmp_path):
    log = tmp_path / "calls.jsonl"
    log.write_text(json.dumps({"cmd": "look"}) + "\n")
    assert agent.looked_at_own_work(str(log), 0) is False


def test_blind_retries_cannot_eventually_bypass_review(monkeypatch, tmp_path):
    design = tmp_path / "design.json"
    original = json.dumps({"version": 1, "units": "meters", "beds": [], "plants": [],
                           "paths": [], "patios": [], "edges": [], "steps": [], "objects": []})
    design.write_text(original)
    monkeypatch.setenv("YARDTWIN_CALL_LOG", str(tmp_path / "missing.log"))
    reply = json.dumps({"ops": [{"tool": "upsert_bed", "input": {
        "id": "b1", "mulch": "bark", "polygon": [[12,-8],[16,-8],[16,-4],[12,-4]]}}],
        "summary": "unseen", "confidence": "high", "cautions": ""})
    monkeypatch.setattr(agent, "call_codex_explore", lambda *a, **kw: reply)
    with pytest.raises(RuntimeError, match="visual review"):
        agent.run("make a bed", backend="codex", explore=True, quiet=True, design_path=str(design))
    assert design.read_text() == original


@pytest.mark.needs_site
def test_real_cli_and_mcp_share_budget_without_denying_calls(monkeypatch, tmp_path):
    ledger = str(tmp_path / "budget.json")
    agent.budget_reset(ledger, 2)
    monkeypatch.setenv("YARDTWIN_BUDGET_LEDGER", ledger)
    monkeypatch.setattr(view_mcp, "CALL_LOG", str(tmp_path / "mcp.jsonl"))
    first = view_mcp.call_tool("zones", {})
    assert not first.get("isError")
    proc = subprocess.run([sys.executable, str(Path(agent.ROOT)/"tools/site_api.py"), "zones"],
                          capture_output=True, text=True, timeout=30)
    assert proc.returncode == 0
    assert "budget" in proc.stderr.lower()
    json.loads(proc.stdout)  # warnings must not break machine-readable site JSON
    assert agent.budget_load(ledger).spent == 2
    again = view_mcp.call_tool("zones", {})
    assert not again.get("isError")
    assert "budget" in again["content"][-1]["text"].lower()
    assert agent.budget_load(ledger).spent == 3


def test_concurrent_calls_cannot_lose_budget_charges(tmp_path):
    ledger = str(tmp_path / "budget.json")
    agent.budget_reset(ledger, 30)
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda _: agent.budget_spend(ledger), range(20)))
    assert agent.budget_load(ledger).spent == 20


def test_backend_keeps_sandbox_and_delivers_budget_to_both_transports(monkeypatch, tmp_path):
    def fake(cmd, **kwargs):
        assert "--dangerously-bypass-approvals-and-sandbox" not in cmd
        assert cmd[cmd.index("--sandbox") + 1] == "workspace-write"
        assert "--ignore-user-config" in cmd
        assert kwargs["cwd"] == agent.ROOT
        assert str(Path(agent.ROOT).parent / "AGENTS.md") in kwargs["input"]
        # every document the brief sends it to must be there from the folder it starts in
        for doc in re.findall(r"[\w./-]*/[\w.-]+\.md\b", kwargs["input"]):
            assert os.path.isfile(os.path.join(kwargs["cwd"], doc)), f"the brief sends codex to {doc}, which is not there"
        ledger = kwargs["env"]["YARDTWIN_BUDGET_LEDGER"]
        assert agent.budget_load(ledger).limit == 7
        overrides = cmd[cmd.index("--output-last-message")+2:]
        assert 'mcp_servers.yardeye.env.YARDTWIN_BUDGET_LEDGER=' + json.dumps(ledger) in overrides
        assert 'mcp_servers.yardeye.tools.look.approval_mode="approve"' in overrides
        Path(cmd[cmd.index("--output-last-message") + 1]).write_text('{"ops":[]}')
        return subprocess.CompletedProcess(cmd, 0, "", "")
    monkeypatch.setattr(agent.subprocess, "run", fake)
    assert json.loads(agent.call_codex_explore("design", None, call_budget=7)) == {"ops": []}


def _codex_server_command():
    """The yardeye command line the committed .codex/config.toml gives Codex."""
    text = codex_setup.PATH.read_text()
    line = next(l for l in text.splitlines() if l.startswith("mcp_servers.yardeye.args="))
    command = next(l for l in text.splitlines() if l.startswith("mcp_servers.yardeye.command="))
    return [json.loads(command.split("=", 1)[1]), *json.loads(line.split("=", 1)[1])]


def test_the_committed_codex_settings_are_what_mcp_json_gives():
    # Codex reads only its own .codex/config.toml (measured: not .mcp.json). It is committed, so a
    # change to .mcp.json or the tool list must be written through to it, or Codex sessions get a
    # different server from Claude's and the design agent's
    assert codex_setup.main(["--check"]) == 0
    text = codex_setup.PATH.read_text()
    assert str(Path(agent.ROOT)) not in text and "/Users/" not in text and ".cwd=" not in text, (
        "the committed Codex settings name a path on one machine")
    assert ".required=" not in text, "a session in this repository would not open without the site tools"
    for tool in agent.MCP_TOOLS:
        assert f'tools.{tool.removeprefix("mcp__yardeye__")}.approval_mode="approve"' in text


@pytest.mark.parametrize("where", [".", "pedon", "pedon/viewer"])
def test_codex_starts_the_site_tools_from_anywhere_in_the_checkout(where):
    # Codex resolves a relative server folder against the folder IT was started in (measured), so
    # the committed command finds the checkout itself. Started here, it must answer as yardeye.
    hello = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
             "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}}
    r = subprocess.run(_codex_server_command(), input=json.dumps(hello) + "\n", capture_output=True, text=True,
                       cwd=Path(agent.ROOT).parent / where, timeout=60)
    assert r.returncode == 0, r.stderr[-800:]
    assert json.loads(r.stdout.splitlines()[0])["result"]["serverInfo"]["name"] == "yardeye"


def test_the_codex_command_outside_a_checkout_fails_rather_than_start_something_else(tmp_path):
    r = subprocess.run(_codex_server_command(), input="", capture_output=True, text=True, cwd=tmp_path, timeout=60)
    assert r.returncode != 0 and not r.stdout


def test_the_design_agents_eyes_follow_the_viewer_that_started_it():
    # a viewer on another port starts the design agent; its MCP server must ask THAT viewer, not
    # :5178. Claude hands its own environment to an MCP server unless .mcp.json pins the value
    # (measured), and codex hands on only the variables it is told to
    mcp = Path(agent.ROOT) / ".mcp.json"
    spec = json.loads(mcp.read_text())["mcpServers"]["yardeye"]
    assert "YARDTWIN_VIEWER" not in (spec.get("env") or {}), "pinned: the agent looks at :5178 whichever viewer started it"
    env_vars = next(a for a in agent.codex_mcp_args(str(mcp)) if ".env_vars=" in a)
    assert "YARDTWIN_VIEWER" in json.loads(env_vars.split("=", 1)[1]), "codex drops the viewer's address"

def test_design_variants_have_separate_scratch_documents():
    # the site's own designs, as a caller resolves them (project.resolve("data/designs/…"))
    first = agent.scratch_for(project.resolve("data/designs/first.json"))
    second = agent.scratch_for(project.resolve("data/designs/second.json"))
    assert first != second
    assert Path(first).parent == Path(project.data("designs")), "a scratch left the site's designs"


def test_cli_saves_unique_images_from_the_same_handler(monkeypatch, tmp_path, capsys):
    payload = b"sample-image-bytes"
    monkeypatch.setattr(view_mcp, "call_tool", lambda *a: {
        "content": [{"type": "image", "data": base64.b64encode(payload).decode()}]})
    paths = []
    for _ in range(2):
        assert view_mcp.cli(["look", "{}", "--output-dir", str(tmp_path)]) == 0
        result = json.loads(capsys.readouterr().out)
        paths.append(Path(result["content"][0]["path"]))
        assert paths[-1].read_bytes() == payload
        assert "data" not in result["content"][0]
    assert paths[0] != paths[1]


def test_cli_names_a_review_image_when_asked(monkeypatch, tmp_path, capsys):
    """A designer keeps each look in the task's review folder under what it shows:
    random temp names would make a separate copy-out script necessary."""
    payload = b"sample-image-bytes"
    monkeypatch.setattr(view_mcp, "call_tool", lambda *a: {
        "content": [{"type": "image", "data": base64.b64encode(payload).decode()},
                    {"type": "image", "mimeType": "image/png", "data": base64.b64encode(payload).decode()}]})
    assert view_mcp.cli(["look", "{}", "--output-dir", str(tmp_path), "--name", "from-the-bench"]) == 0
    result = json.loads(capsys.readouterr().out)
    got = [Path(b["path"]) for b in result["content"]]
    assert got == [tmp_path / "from-the-bench.jpg", tmp_path / "from-the-bench-2.png"]
    assert all(p.read_bytes() == payload for p in got)
