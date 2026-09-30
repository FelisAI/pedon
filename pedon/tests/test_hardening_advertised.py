"""Nothing the capability map advertises may be a capability that cannot run.

Why this exists
---------------
AGENTS.md, with the docs it indexes, is the capability map — it is what a cold
session reads instead of the code, so a line in it is a promise. A promise that fails on invocation costs more
than no promise at all: the session spends its first minutes on a tool that was
never going to work, and then distrusts the rest of the map. A tool that cannot
even be invoked in this environment (`ModuleNotFoundError` for a provider's API
client, say) is saved from being a broken promise only by a sentence saying so —
and a tool that cannot run here should be deleted, not documented.

So this checks the map against the tools, both directions:
  * every command shown in a fence must survive `--help` with the API keys
    scrubbed out of the environment and the network blocked — the standing
    constraint here is subscription CLIs only, and a tool that reaches for a key
    or a socket just to print its usage would fail the same way for a session
    that has neither;
  * every subcommand a fence names must actually exist in that tool's parser;
  * and a tool that CANNOT run must not appear as a runnable command at all.

Blender-hosted scripts (`blender -b -P tools/gen_trees.py`) are exempt from the
python3 checks and only from those: they import `bpy`, which only exists inside
Blender, and the doc advertises them with the interpreter that has it.

Not duplicated here: whether every tool is MENTIONED at all — that is
tools/capability_check.py's job, and it is the discoverability question rather
than the honesty one.
"""
from __future__ import annotations
import glob
import os
import re
import shlex
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Overridable ONLY so this guard can be proven to go red against a doctored copy
# of the doc: several agents share the real docs and editing them to test a
# test would collide with all of them. Nothing in the repo sets it.
# The map is a SET of files: AGENTS.md indexes pedon/docs/*. A command is
# advertised if any of them shows it being run.
def _doc_paths():
    override = os.environ.get("YARDTWIN_DOC_PATH")
    if override:
        return [override]
    up = os.path.dirname(ROOT)
    paths = [os.path.join(up, "AGENTS.md")] + sorted(glob.glob(os.path.join(ROOT, "docs", "*.md")))
    paths += [os.path.join(ROOT, n) for n in ("DESIGNING.md", "EXTENSIONS.md", "ASSET_FIDELITY.md")]
    return [p for p in paths if os.path.exists(p)]

DOC_PATHS = _doc_paths()
DOC = DOC_PATHS[0]

FENCE = re.compile(r"```[a-z]*\n(.*?)```", re.S)
# A shell line is advertised as runnable if a fence shows it being run. The two
# interpreters this project uses are python3 and blender -b -P.
PY_LINE = re.compile(r"^python3\s+(tools/[\w_]+\.py)\s*(.*)$")
# A blender-hosted script, however blender is spelled. It is NOT always the bare
# word: on macOS Blender is a .app and may not be on $PATH at all, so the doc
# invokes it through a variable or an absolute path. A parser that insists on
# the literal `blender` finds ZERO blender-hosted scripts in such a doc, and the
# next test then tries to run them under python3 and demands they be marked
# broken.
BLENDER_LINE = re.compile(
    r"""^(?:blender|"?\$\w+"?|/\S*[Bb]lender\S*)\s+-b\s+-P\s+(tools/[\w_]+\.py)""")
MENTION = re.compile(r"tools/([\w_]+\.py)")
# What lets a tool be named without being a promise: the doc says, in the same
# breath, that it does not work.
DEAD_MARKERS = ("unusable", "cannot run", "does not run", "ignore it", "no keys",
                "not usable", "dead")


def _doc():
    """Every doc in the set, concatenated — a command is advertised if any shows it."""
    return "\n".join(open(p).read() for p in DOC_PATHS)


def _fence_lines(doc):
    for block in FENCE.findall(doc):
        for line in block.splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                yield line


def advertised(doc):
    """{tool path: set of subcommand names claimed for it} from the fences.

    A subcommand claim is the first bare word after the script — `site_api.py
    ground 15 -6` claims `ground`. A leading dash is a flag, and a quote is a
    prompt (`agent.py "…"`), neither of which is a subcommand.
    """
    out = {}
    for line in _fence_lines(doc):
        m = PY_LINE.match(line)
        if not m:
            continue
        tool, rest = m.group(1), m.group(2)
        subs = out.setdefault(tool, set())
        for tok in rest.split():
            if tok.startswith(("-", '"', "'", "#", "|")):
                break
            subs.add(tok)
            break
    return out


def command_lines(doc):
    """Every `python3 tools/…` line a fence shows, as argv, comments stripped.

    Shared with tests/test_hardening_degraded.py, which runs these same lines
    against an empty property: the point of both files is that what the doc
    SHOWS is what gets exercised, so neither may keep its own list.
    """
    out = []
    for line in _fence_lines(doc):
        if not PY_LINE.match(line):
            continue
        argv = []
        for tok in shlex.split(line, comments=True):
            if tok == "|":        # `sun.py season | day | position` shows three
                break             # alternatives on one line, not three arguments
            argv.append(tok)
        out.append(argv[1:])      # drop the interpreter
    return out


def blender_hosted(doc):
    return {m.group(1) for line in _fence_lines(doc) for m in [BLENDER_LINE.match(line)] if m}


def mentioned(doc):
    return {f"tools/{n}" for n in MENTION.findall(doc)}


DOC_TEXT = _doc()
ADVERTISED = advertised(DOC_TEXT)
BLENDER = blender_hosted(DOC_TEXT)
SUB_CLAIMS = sorted((t, s) for t, subs in ADVERTISED.items() for s in subs)


def keyless_env(d, viewer="http://127.0.0.1:9"):
    """An environment with no API keys and no network at all.

    sitecustomize is imported by every interpreter start, so this blocks sockets
    before the tool's own imports run — which is the point: a tool that phones
    home or reads a key while merely printing its usage is not usable by a
    session that has neither, and that is the standing constraint here.

    Shared with tests/test_hardening_degraded.py.
    """
    # Methods, not the class: `ssl` does `class SSLSocket(socket.socket)` at
    # import, so replacing socket.socket outright breaks every tool that imports
    # urllib — which looks exactly like the failure these tests hunt for.
    (d / "sitecustomize.py").write_text(
        "import socket\n"
        "def _blocked(*a, **k):\n"
        "    raise OSError('network blocked: tools must be invokable offline')\n"
        "socket.socket.connect = _blocked\n"
        "socket.socket.connect_ex = _blocked\n"
        "socket.create_connection = _blocked\n"
        "socket.getaddrinfo = _blocked\n")
    env = {k: v for k, v in os.environ.items()
           if not re.search(r"(API_KEY|_TOKEN|SECRET|PASSWORD)$", k)}
    env["PYTHONPATH"] = str(d)
    env["YARDTWIN_VIEWER"] = viewer                    # discard port: nothing listens
    # AN EMPTY PROJECT, through the product's own switch: a sandbox of symlinked
    # tools isolates nothing, because python resolves a script's folder and imports
    # tools/project.py from the REAL checkout. Without this a sandboxed run reads —
    # and can write — the owner's real site files.
    env["PEDON_PROJECT"] = str(d / "data")
    # and an empty LIBRARY: the models, catalogue and photographs are the user's, shared by
    # every project, so an empty project alone still reads them — and a fetch would write them
    env["PEDON_LIBRARY"] = str(d / "library")
    return env


@pytest.fixture(scope="module")
def keyless(tmp_path_factory):
    return keyless_env(tmp_path_factory.mktemp("keyless"))


def _help(tool, env):
    p = subprocess.run([sys.executable, os.path.join(ROOT, tool), "--help"],
                       capture_output=True, text=True, cwd=ROOT, env=env,
                       stdin=subprocess.DEVNULL, timeout=120)
    return p.returncode, p.stdout, p.stderr


@pytest.fixture(scope="module")
def helps(keyless):
    """Every tool's `--help`, run once. Includes the ones NOT advertised as
    python3 commands, because the dead-tool direction needs them too."""
    tools = sorted(set(ADVERTISED) | mentioned(DOC_TEXT))
    return {t: _help(t, keyless) for t in tools
            if os.path.exists(os.path.join(ROOT, t))}


def test_the_doc_parser_actually_found_the_commands():
    """Presence and count first. Every later assertion in this file is
    parametrised over what this parse produced, so a parse that quietly returned
    nothing would make all of them pass while checking nothing."""
    assert len(ADVERTISED) >= 8, f"only found {sorted(ADVERTISED)} in {DOC}"
    for expected in ("tools/site_api.py", "tools/agent.py", "tools/analyze_site.py",
                     "tools/geodata.py", "tools/selftest.py", "tools/capability_check.py"):
        assert expected in ADVERTISED, f"{expected} is not advertised as a command any more"
    assert len(SUB_CLAIMS) >= 10, f"only {len(SUB_CLAIMS)} subcommand claims: {SUB_CLAIMS}"
    assert ("tools/site_api.py", "ground") in SUB_CLAIMS
    assert ("tools/site_api.py", "zones") in SUB_CLAIMS
    # >= not ==: a third blender-hosted script is a legitimate addition, and this
    # is a check that the blender parser still finds any, not a freeze of the doc.
    assert BLENDER >= {"tools/gen_trees.py", "tools/blender_export.py"}, BLENDER


@pytest.mark.parametrize("tool", sorted(ADVERTISED))
def test_every_advertised_command_is_invokable_without_a_key_or_a_network(tool, helps):
    rc, out, err = helps[tool]
    assert "Traceback (most recent call last)" not in err, \
        f"{tool} --help raised rather than printed:\n{err}"
    assert rc == 0, f"{tool} --help exited {rc}\nstdout:{out}\nstderr:{err}"
    assert "usage:" in (out + err).lower(), f"{tool} --help printed no usage:\n{out}{err}"


@pytest.mark.parametrize("tool,sub", SUB_CLAIMS)
def test_every_advertised_subcommand_still_exists(tool, sub, helps):
    """A renamed subcommand is the quietest kind of broken promise: the tool
    runs, so nothing looks wrong until a session pastes the documented line."""
    _rc, out, err = helps[tool]
    # A choice in the usage's [--option {a,b}] is not a subcommand. The
    # positional help entry starts with the braces; an option starts with --.
    choices = re.search(r"(?m)^\s+\{([\w,\-]+)\}", out + err)
    if not choices:
        pytest.skip(f"{tool} has no subcommands; `{sub}` is a positional argument")
    names = choices.group(1).split(",")
    assert sub in names, f"AGENTS.md runs `{tool} {sub}`, but the tool offers {names}"


def test_subcommand_check_does_not_mistake_option_choices_for_commands():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=['native', 'realized'])
    parser.add_subparsers().add_parser('inspect')
    helps = {'fixture.py': (0, parser.format_help(), '')}
    test_every_advertised_subcommand_still_exists('fixture.py', 'inspect', helps)
    with pytest.raises(AssertionError, match='offers'):
        test_every_advertised_subcommand_still_exists('fixture.py', 'missing', helps)


def test_a_tool_that_cannot_run_is_never_advertised_as_runnable(helps):
    """The general rule: if a tool cannot be invoked here, the
    doc may still mention it — but only while saying it does not work, and never
    as a command line somebody could paste."""
    # Assert the SAMPLE before asserting the property. Without this the loop
    # below passes trivially whenever `helps` is empty or every tool was skipped —
    # a green that means "nothing was checked". Assert presence and count before
    # deltas.
    checked = [t for t in helps if t not in BLENDER]
    assert len(checked) >= 8, (
        f"only {len(checked)} tool(s) collected, so this proves almost nothing: {checked}")

    broken = []
    for tool, (rc, out, err) in sorted(helps.items()):
        if tool in BLENDER:                     # runs under blender, not python3
            continue
        if rc != 0 or "Traceback (most recent call last)" in err:
            broken.append((tool, err.strip().splitlines()[-1] if err.strip() else f"exit {rc}"))

    for tool, why in broken:
        assert tool not in ADVERTISED, (
            f"AGENTS.md shows `python3 {tool}` as a runnable command, but it cannot "
            f"run here: {why}")
        para = [p for p in DOC_TEXT.split("\n\n") if tool in p]
        assert para, f"{tool} is broken ({why}) and mentioned nowhere — unreachable state"
        assert any(any(mark in p.lower() for mark in DEAD_MARKERS) for p in para), (
            f"AGENTS.md names {tool} without saying it does not work here ({why}). "
            f"Either delete the mention or mark it unusable.")
