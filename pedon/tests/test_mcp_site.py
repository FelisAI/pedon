"""The site queries, reachable as MCP tools instead of as a filename to remember.

Why this exists
---------------
A design agent that can SEE the yard through MCP (`look`,
`check_ground_contact`) but can only MEASURE it by remembering to shell out to
`python3 tools/site_api.py ...` asks one point at a time. Measured from
data/site_api_calls.log over 350 CLI calls: 236 of them (67%) were single-point
`ground`/`slope`/`near`, against 2.9% for the batch-shaped tools, with
EXPLORE_BRIEF saying "LET THE SEARCH DO THE SEARCHING" in prose the whole time;
the log is what prose is worth against tool shape. So: one MCP tool per QUESTION,
and the two that get asked one point at a time take a LIST.

What these tests pin, and why each one:

  * the tools are actually listed, and the three viewer tools still are — an MCP
    server that dies at import takes `look` with it;
  * an MCP answer is BYTE-IDENTICAL to what the documented CLI prints. That is
    the anti-reimplementation clause: site_api's cmd_ functions are imported and
    called, not re-derived, so the tool and the documented CLI cannot drift — two
    separately derived ground lookups can disagree by 0.99 m;
  * a single point still answers exactly what `ground X Y` answers, so making the
    shape batch-first costs no capability;
  * defaults (--radius, --step, --across, --along, --top) are the CLI's own,
    read out of site_api's parser rather than typed here a second time;
  * a bad argument does not kill the server. An MCP tool that exits takes every
    other tool in the session with it — the same contract test_dry.py pins for
    `look` when the viewer is down;
  * the calls are still LOGGED, because "did the model actually ask the ground"
    is the question this architecture exists to answer, and the log is the only
    evidence. A tool that bypasses it would make the next measurement blind.

Everything here speaks the real protocol to a real subprocess on stdin/stdout,
which is what a client does. Nothing touches the viewer: none of these tools
render, so all of them run headless.
"""
from __future__ import annotations
import argparse
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile

import pytest

# conftest.py does this too. Repeated deliberately, as in test_ops.py and
# test_core_batch.py: a test that only runs while a shared conftest survives is
# not a test.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))
import site_api                                                 # noqa: E402
import view_mcp                                                 # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import project  # noqa: E402  where the active site's files are
SERVER = os.path.join(ROOT, "tools", "view_mcp.py")

# The viewer tools. Listed so a regression that drops them
# while adding the site tools cannot pass.
VIEWER_TOOLS = {"look", "check_ground_contact", "list_viewpoints", "preview_design",
                "sun", "list_assets", "sightline", "walk_through",
                "find_asset", "fetch_asset", "make_asset",   # find it or make it
                "plan", "compose_planting",   # see planting in plan; calculate drifts it drew
                "scan_profile"}     # the mesh along a line: a railroad tie is not in a 1 m grid   # what a designer asks that geometry cannot answer   # points `look` at a proposal rather than the working design
SITE_TOOLS = {"ground", "slope", "profile", "check_pad", "check_route",
              "best_bench", "near", "zones", "areas", "area", "composition", "scene",
              # which ground is usable, not only how steep it is — a site query
              # the DESIGN AGENT should be offered at connect, not one it has to
              # find in the capability map and shell out for
              "usable_area"}

# Ground the 1 m raycast actually covers — east of the house, the same corner
# test_core_batch.py measures on. If these drift off the mesh every comparison
# below is two identical error blobs agreeing with each other, so
# test_the_fixtures_are_on_real_ground asserts they are real first.
PTS = [[13, 6], [9.0, 2.0], [11.0, 4.0]]
PAD = [[10.0, 3.0], [12.0, 3.0], [12.0, 5.0], [10.0, 5.0]]
ROUTE = [[9.0, 2.0], [11.0, 4.0], [13.0, 6.0]]

# Where the server under test is told to log. Every call below is a real call and
# the server logs real calls, so without this the suite would write a few hundred
# rows into data/site_api_calls.log — the dataset the 67% figure was measured
# from, and the one the NEXT measurement (did MCP shape move it?) has to read.
LOG_SINK = os.path.join(tempfile.mkdtemp(prefix="pedon-mcp-test-"), "calls.log")


# ── speaking the protocol ─────────────────────────────────────────────────
def rpc(calls, env=None, timeout=120):
    """Run tools/view_mcp.py as a real client does and return its replies.

    Every request is written up front and stdin closed, so a server that hangs
    fails the test's timeout instead of the whole suite. `calls` is a list of
    (method, params); initialize is prepended because a client always sends it.
    """
    reqs = [("initialize", {"protocolVersion": "2024-11-05"})] + list(calls)
    lines = [json.dumps({"jsonrpc": "2.0", "id": i, "method": m, "params": p})
             for i, (m, p) in enumerate(reqs)]
    e = dict(os.environ, YARDTWIN_CALL_LOG=LOG_SINK)
    e.update(env or {})
    r = subprocess.run([sys.executable, SERVER], input="\n".join(lines) + "\n",
                       capture_output=True, text=True, cwd=ROOT, env=e, timeout=timeout)
    assert r.returncode == 0, f"the server exited {r.returncode}\n{r.stderr[-2000:]}"
    out = []
    for line in r.stdout.splitlines():
        if not line.strip():
            continue
        # Any stray print() inside a handler lands here and corrupts the frames a
        # real client parses, so a non-JSON line is a failure, not noise.
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            raise AssertionError(f"the server wrote a line that is not JSON-RPC: {line[:200]!r}")
    assert len(out) == len(reqs), f"{len(reqs)} requests, {len(out)} replies: {out}"
    assert [m["id"] for m in out] == list(range(len(reqs)))
    return out[1:]                                  # drop the initialize reply


def tools():
    (reply,) = rpc([("tools/list", {})])
    return {t["name"]: t for t in reply["result"]["tools"]}


def call(name, args, env=None):
    """One tools/call, returned as (text, isError)."""
    (reply,) = rpc([("tools/call", {"name": name, "arguments": args})], env=env)
    res = reply["result"]
    text = "\n".join(c["text"] for c in res["content"] if c["type"] == "text")
    return text, bool(res.get("isError"))


# ── the CLI, for comparison ───────────────────────────────────────────────
def cli(argv, tmp_path, monkeypatch):
    """Run the documented CLI and return (stdout, exit code).

    Through main() rather than the cmd_ function, for the reason
    test_core_batch.py gives: argparse's float coercion and json.dumps are part
    of the answer a model sees. ROOT is redirected so the call log lands in tmp —
    data/site_api_calls.log is the evidence the traffic figures in this project
    are measured from and a test suite must not write into its own dataset — and
    site.json/design.json are symlinked back in, because the commands that read
    them must answer about the real property, not an empty one.
    """
    data = tmp_path / "data"
    data.mkdir(parents=True, exist_ok=True)
    for f in ("site.json", "design.json"):
        link = data / f
        if not link.exists():
            link.symlink_to(project.data(f))
    monkeypatch.setattr(site_api, "ROOT", str(tmp_path))
    monkeypatch.setattr(sys, "argv", ["site_api.py"] + argv)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), pytest.raises(SystemExit) as e:
        site_api.main()
    return buf.getvalue(), e.value.code


# Every tool, next to the CLI invocation it must agree with, and the key that
# proves the answer is a real measurement rather than an error blob. The pairs
# are the whole point: they are what makes "it calls site_api" testable from
# outside.
PAIRS = [
    ("ground", {"points": PTS}, ["ground-many", json.dumps(PTS)], "with_ground"),
    ("slope", {"points": PTS}, ["slope-many", json.dumps(PTS)], "flattest"),
    ("slope", {"points": PTS, "radius": 1.0},
     ["slope-many", json.dumps(PTS), "--radius", "1.0"], "flattest"),
    ("profile", {"x1": 9.0, "y1": 2.0, "x2": 13.0, "y2": 6.0},
     ["profile", "9.0", "2.0", "13.0", "6.0"], "steepest_step_pct"),
    ("profile", {"x1": 9.0, "y1": 2.0, "x2": 13.0, "y2": 6.0, "step": 1.0},
     ["profile", "9.0", "2.0", "13.0", "6.0", "--step", "1.0"], "steepest_step_pct"),
    ("check_pad", {"polygon": PAD}, ["check-pad", json.dumps(PAD)], "verdict"),
    ("check_pad", {"polygon": PAD, "level": -2.0},
     ["check-pad", json.dumps(PAD), "--level", "-2.0"], "verdict"),
    ("check_route", {"spline": ROUTE}, ["check-route", json.dumps(ROUTE)], "steepest_pct"),
    ("best_bench", {"x0": 9.0, "y0": 2.0, "x1": 12.0, "y1": 5.0, "across": 3.0, "along": 4.0},
     ["best-bench", "9.0", "2.0", "12.0", "5.0", "--across", "3.0", "--along", "4.0"],
     "candidates"),
    ("near", {"x": 11.6, "y": 6.6}, ["near", "11.6", "6.6"], "found"),
    ("near", {"x": 11.6, "y": 6.6, "radius": 6.0},
     ["near", "11.6", "6.6", "--radius", "6.0"], "found"),
    ("zones", {}, ["zones"], "zones"),
    ("areas", {}, ["areas"], "areas"),
    ("area", {"name": "railroadtie"}, ["area", "railroadtie"], "area_m2"),
]


@pytest.mark.needs_site
def test_the_fixtures_are_on_real_ground():
    """Without this, every comparison below could be two identical "not on
    scanned ground" errors agreeing with each other — green, and guarding
    nothing."""
    for x, y in PTS:
        assert site_api.scan_at(x, y) is not None, f"fixture point {x},{y} is off the scan"
    assert any(isinstance(c, int) for p in PTS for c in p), \
        "no integer-literal coordinate left in the fixture — a model writes [[13,6]], " \
        "and float coercion is what makes the batch row equal the single row"
    names = [a["name"] for a in json.load(open(project.data("site.json")))
             .get("areas", [])]
    assert "railroadtie" in names, f"the area fixture is gone; areas drawn: {names}"


def test_the_site_queries_are_reachable_as_tools():
    t = tools()
    assert VIEWER_TOOLS <= set(t), \
        f"the viewer tools are gone: {sorted(VIEWER_TOOLS - set(t))} — an import that " \
        f"kills the server takes `look` with it"
    missing = sorted(SITE_TOOLS - set(t))
    assert not missing, f"still CLI-only, not reachable as a tool: {missing}"
    assert len(t) == len(SITE_TOOLS | VIEWER_TOOLS), \
        f"unexpected tool list: {sorted(t)}"


def test_every_tool_says_when_to_call_it():
    """A description that names the tool again teaches nothing. check_ground_contact's
    is the standard: what it answers, WHEN to reach for it, and what it prevents."""
    thin = []
    for name, spec in tools().items():
        d = (spec.get("description") or "").lower()
        if len(d) < 120 or not any(c in d for c in
                                   ("use it", "use this", "call it", "call this",
                                    "ask ", "before ", "instead")):
            thin.append(name)
    assert not thin, f"these descriptions do not say when to call them: {thin}"


def test_the_shape_is_batch_first():
    """The measured cost of a one-point shape is 236 single-point calls out of
    350. A tool that takes one point invites exactly that, so the two that get
    asked point by point take a LIST — and the list is the only shape there is."""
    t = tools()
    for name in ("ground", "slope"):
        props = t[name]["inputSchema"]["properties"]
        assert props["points"]["type"] == "array", \
            f"{name} does not take a list of points; the one-point-per-call shape is back"
        assert "points" in t[name]["inputSchema"].get("required", [])


@pytest.mark.parametrize("name,args,argv,key", PAIRS,
                         ids=[f"{p[0]}-{len(p[2])}" for p in PAIRS])
@pytest.mark.needs_site
def test_a_tool_answers_exactly_what_the_cli_prints(name, args, argv, key, tmp_path, monkeypatch):
    """The anti-reimplementation clause. If the MCP layer re-derived any of this
    the two would drift, and the model would have two rulers for one question —
    two derived ground lookups can disagree by 0.99 m."""
    out, code = cli(argv, tmp_path, monkeypatch)
    assert code == 0, f"the CLI itself failed: {out[:400]}"
    parsed = json.loads(out)
    assert "error" not in parsed, f"the CLI answered an error, so this compares nothing: {out[:300]}"
    assert parsed.get(key) not in (None, [], {}), \
        f"{name} answered without {key!r}, so the comparison is vacuous: {out[:300]}"
    text, is_error = call(name, args)
    assert not is_error, text
    assert text == out.rstrip("\n"), \
        f"{name} does not print what `site_api.py {' '.join(argv[:1])}` prints"


@pytest.mark.needs_site
def test_one_point_still_answers_what_the_single_call_answers(tmp_path, monkeypatch):
    """Batch-first must not cost the single-point capability: the row for one
    point has to be the row `ground X Y` prints, byte for byte."""
    single, code = cli(["ground", "13", "6"], tmp_path / "one", monkeypatch)
    assert code == 0
    text, is_error = call("ground", {"points": [[13, 6]]})
    assert not is_error, text
    rows = json.loads(text)["points"]
    assert len(rows) == 1
    assert json.dumps(rows[0], sort_keys=True) == json.dumps(json.loads(single), sort_keys=True), \
        "the one-point row is not the single call's answer — int/float drift"
    assert rows[0]["ground_m"] is not None


@pytest.mark.needs_site
def test_a_bad_argument_does_not_kill_the_server():
    """An MCP server that exits takes every tool in the session with it, `look`
    included. Same contract test_dry.py pins for a dead viewer: answer in words,
    do not raise. The third call proves the process is still answering."""
    replies = rpc([
        ("tools/call", {"name": "ground", "arguments": {"points": "not json"}}),
        ("tools/call", {"name": "area", "arguments": {"name": "no_such_area_xyz"}}),
        ("tools/call", {"name": "ground", "arguments": {}}),
        ("tools/call", {"name": "zones", "arguments": {}}),
    ])
    texts = ["\n".join(c["text"] for c in r["result"]["content"] if c["type"] == "text")
             for r in replies]
    assert "Traceback" not in "\n".join(texts)
    assert "error" in json.loads(texts[0]), texts[0]
    assert "no area named" in texts[1] and "railroadtie" in texts[1], texts[1]
    assert "points" in texts[2].lower(), f"a missing required argument must say which: {texts[2]}"
    assert json.loads(texts[3]).get("zones"), "the server stopped answering after two bad calls"


@pytest.mark.needs_site
def test_a_malformed_point_list_reads_like_the_cli_error(tmp_path, monkeypatch):
    out, code = cli(["ground-many", "[[1]]"], tmp_path, monkeypatch)
    assert code == 1
    text, is_error = call("ground", {"points": [[1]]})
    assert is_error, "a rejected argument must be flagged isError, not read as an answer"
    assert text == out.rstrip("\n"), "the MCP error is not the CLI's error"


# ── the defaults are the CLI's, not a second copy ─────────────────────────
def cli_parser_defaults(monkeypatch):
    """Every subcommand's optional defaults, read out of site_api's own parser.

    site_api.main() builds the parser and immediately consumes it, so there is
    nothing to import — intercepting parse_args is what makes the real defaults
    readable without transcribing them here, which would make a second copy of
    every number, free to drift from the first.
    """
    grabbed = {}

    class Grabbed(Exception):
        pass

    def grab(self, *a, **k):
        grabbed["parser"] = self
        raise Grabbed()

    monkeypatch.setattr(argparse.ArgumentParser, "parse_args", grab)
    with pytest.raises(Grabbed):
        site_api.main()
    subs = [a for a in grabbed["parser"]._actions
            if isinstance(a, argparse._SubParsersAction)]
    assert len(subs) == 1, "site_api no longer has one subparser action"
    return {name: {ac.dest: ac.default for ac in p._actions if ac.dest != "help"}
            for name, p in subs[0].choices.items()}


def test_the_defaults_come_from_the_cli(monkeypatch):
    """--radius 2.0, --step 2.0, --across 4.0, --along 6.0, --top 5, --radius 3.0.
    Typed into the MCP schema they would be a second set, free to drift — a
    limit held in two places can make 0.65 m "needs an engineered footing" to
    check-pad and silent to the validator."""
    cli_defaults = cli_parser_defaults(monkeypatch)
    listed = tools()
    compared = []
    for spec in view_mcp.SITE_TOOLS:
        assert spec["cli"] in cli_defaults, \
            f"{spec['name']} claims to be `site_api.py {spec['cli']}`, which does not exist"
        props = listed[spec["name"]]["inputSchema"].get("properties", {})
        unknown = set(props) - set(cli_defaults[spec["cli"]])
        assert not unknown, f"{spec['name']} exposes arguments {spec['cli']} does not take: {unknown}"
        for arg, p in props.items():
            want = cli_defaults[spec["cli"]][arg]
            if want is None:
                assert "default" not in p, f"{spec['name']}.{arg} states a default the CLI does not have"
                continue
            assert p.get("default") == want, \
                f"{spec['name']}.{arg} defaults to {p.get('default')!r}, the CLI to {want!r}"
            compared.append(f"{spec['name']}.{arg}")
    assert len(compared) >= 6, \
        f"only {len(compared)} defaults compared ({compared}) — the guard is not covering the knobs"


@pytest.mark.needs_site
def test_check_route_width_is_not_offered_because_nothing_reads_it(tmp_path, monkeypatch):
    """The CLI takes --width and cmd_check_route never looks at it. Offering it
    over MCP would be a knob that does nothing, which is worse than no knob. If
    site_api starts reading it this raises AttributeError and says so."""
    ns = argparse.Namespace(spline=json.dumps(ROUTE))
    out = site_api.cmd_check_route(ns)
    assert "steepest_pct" in out
    assert "width" not in tools()["check_route"]["inputSchema"].get("properties", {})


# ── the calls stay measurable ─────────────────────────────────────────────
def test_a_tool_call_is_logged_like_a_cli_call(tmp_path):
    """"Did the model actually ask the ground, or guess well" is the question
    this whole architecture has to answer, and data/site_api_calls.log is the
    only evidence — every traffic figure comes out of it. A tool that queried
    the site without logging would make the next measurement blind, and the
    next measurement is whether the MCP shape moves the 67%."""
    log = tmp_path / "calls.log"
    env = {"YARDTWIN_CALL_LOG": str(log)}
    rpc([("tools/call", {"name": "ground", "arguments": {"points": PTS}}),
         ("tools/call", {"name": "zones", "arguments": {}})], env=env)
    rows = [json.loads(l) for l in log.read_text().splitlines()]
    assert [r["cmd"] for r in rows] == ["ground-many", "zones"], rows
    assert all(r["via"] == "mcp" for r in rows), \
        "MCP traffic is indistinguishable from CLI traffic in the log"
    # the traffic claim itself: N points cost ONE logged call, not N
    assert len(rows) == 2 and rows[0]["args"]["points"] == PTS


def test_edge_materials_say_what_they_are_for():
    """A model can only choose an edge material (steel, natural rock) if it is
    told what each is for.

    Six bare material names from `list_assets` tell a designer that corten_steel
    exists and nothing whatever about when a steel edge is the right call on a
    14 degree slope. A name is not a capability until something says what it is
    for.
    """
    import json as _j
    text, err = call("list_assets", {"kind": "materials"})
    assert not err, text
    body = _j.loads(text)
    mats = body["edge_materials"]
    assert isinstance(mats, dict), "a bare list of names; that teaches nothing"
    for m in ("corten_steel", "boulder", "dry_stone"):
        assert m in mats, f"{m} is not offered, so it will never be specified"
        assert len(mats[m]["suits"]) > 30, f"{m} has no guidance on when to use it"
        assert mats[m]["thickness_m"] > 0


def test_the_design_agent_can_stand_in_what_it_built():
    """The walkthrough critique belongs INSIDE the design loop. Eight eye-level
    viewpoints and "Ask what's wrong", triggered only by the OWNER in the viewer,
    would let the design agent finish every run without once having stood in what
    it built.

    It matters more than any other check because visual defects are caught by eye
    and not by a number — beds standing on a deck, planting launched skyward after
    "Set north", and a spine that looks ugly while measuring perfectly on every
    metric in the repo.
    """
    import agent
    assert "walk_through" in view_mcp.HANDLERS, "the tool has no handler"
    assert "mcp__yardeye__walk_through" in agent.MCP_TOOLS, (
        "walk_through is not allowlisted, so the spawned model is offered a tool it "
        "cannot call")
    assert "walk_through" in agent.EXPLORE_BRIEF, (
        "nothing tells the design agent to walk its own design; a tool it is not "
        "told to use is a tool with zero calls, measured")


def test_every_tool_call_is_logged_not_only_the_site_ones():
    """data/site_api_calls.log is the evidence this project reasons from.

    The cold-start check in AGENTS.md says: run a question, then read the log to
    see whether the tools were used, because `claude -p` prints only its final
    answer and a good-looking reply is NOT evidence the tools were used. The site tools
    log themselves through do_site; the VIEWER tools must log too, or the file is
    blind to `look`, `walk_through`, `preview_design`, `sightline`, `sun` and
    `list_assets` — and the question that matters most about the design agent,
    whether it ever SEES what it builds, cannot be answered from it at all.

    A log that does not record looking reads as "it never looked". Measure the
    source.
    """
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        log = os.path.join(tmp, "calls.log")
        env = dict(os.environ, YARDTWIN_CALL_LOG=log)
        text, _ = call("list_assets", {"kind": "materials"}, env=env)
        assert text
        assert os.path.exists(log), (
            "a viewer tool was called and the call log does not exist — the log "
            "still only records the site tools")
        with open(log) as f:
            body = f.read()
        assert "list_assets" in body, body[:400]


# ─────────────────────────────────────────────────────────────────────────────
# THE RATCHET: a new site query must be OFFERED, not merely documented.
#
# A query documented in the capability map passes capability_check.py while the design
# agent is never told it exists; finding it by reading the capability map and
# shelling out is luck. The project's own rule is that the design agent "should
# not have to know a filename", and a tool arrives at connect with a description
# saying WHEN to reach for it. capability_check only checks the docs, and the
# SITE_TOOLS set above is hand-maintained, so neither catches the gap.
#
# This derives the expectation from site_api itself, so the next new query
# command fails here until it is either exposed or explicitly exempted.
def test_every_site_QUERY_is_offered_to_the_design_agent():
    import re
    import subprocess

    help_text = subprocess.run(
        [sys.executable, os.path.join(ROOT, "tools", "site_api.py"), "--help"],
        capture_output=True, text=True).stdout
    subs = set(re.search(r"\{([a-z0-9,\-_]+)\}", help_text).group(1).split(","))

    # Not queries, and deliberately not tools:
    EXEMPT = {
        "apply-ops", "check-ops",   # the design agent runs these over Bash, by the
                                    # explore brief's own loop (apply to a scratch
                                    # file, preview it, look at it)
        "save-owner",               # writes site.json; owner ground truth, never a model
        "validate",                 # check-ops is the same judgement, before the write
        "constraints",              # the limits are already quoted into the prompt
        "crowding",                 # the VIEWER's consumer: it walks every SAVED
                                    # design for the Saved list. The design agent has the
                                    # same measurement for the design in its hands, as
                                    # composition.mature_coverage_by_bed
        "ground", "slope",          # DELIBERATE: the tools NAMED ground/slope map to
                                    # ground-many/slope-many, so the batch call is what
                                    # the agent reaches for by default. Offering the
                                    # single-point CLI as well would re-open the gap
                                    # the log measured — 67% of one run's traffic was
                                    # single-point while the batch tool sat at 2.9%.
    }
    exposed = {spec["cli"] for spec in view_mcp.SITE_TOOLS}     # note: ground -> ground-many
    missing = sorted(subs - EXEMPT - exposed)
    assert not missing, (
        f"site_api commands the design agent is never offered: {missing}. "
        "Either add a spec to view_mcp.SITE_TOOLS with a description saying WHEN to "
        "reach for it, or add it to EXEMPT here with the reason. Documenting it in "
        "CLAUDE.md is not enough — that is for a session reading the map, not for the "
        "model mid-design.")
