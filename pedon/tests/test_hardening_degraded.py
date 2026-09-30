"""Every documented command fails honestly when the world is not there.

Two ways the world is not there, and production hits both:

  * the viewer is down. Rendering and raycasting only exist in the browser, so
    three CLIs are useless without it, and the one that meets a closed viewer
    most often is `analyze_site` — the FIRST command run when onboarding a new
    property. A broker client that does not catch URLError prints a raw
    traceback instead (see tools/broker.py).
  * the property is empty. No design.json, no site.json, no terrain_scan.json —
    a fresh clone, a new property before analyze_site has run, or a tool pointed
    at the wrong root.

The failure mode that matters is not a crash, it is a SILENT SUCCESS — e.g. a
49 m2 patio sited 78 m off the scan that validates with zero errors. A tool that
answers `null` with exit 0 on a property it has never measured is the same bug
wearing a JSON hat — the caller, usually a
model, reads a confident answer and builds on it.

So: non-zero exit, a message that says what is missing, and never a traceback.

Not duplicated here: tests/test_dry.py already pins the SHAPE of the broker
request and asserts each client's error string names the viewer. This is the
other half — the CLI exit contract, in a real subprocess against a really
refused port, which is what a person or a script actually sees.
"""
from __future__ import annotations
import os
import re
import socket
import subprocess
import sys

import pytest

from test_hardening_advertised import DOC_TEXT, ROOT, command_lines, keyless_env

# Overridable ONLY so these guards can be proven to go red against a doctored
# COPY of the tools: breaking a real file to watch a test fail risks clobbering
# work someone else is doing in the same tree. Nothing in the repo sets it.
TOOLS = os.environ.get("YARDTWIN_TOOLS_DIR", os.path.join(ROOT, "tools"))
TRACEBACK = "Traceback (most recent call last)"
# A message a caller can act on names the thing that is missing or the
# precondition that is not met. Every honest failure in this repo matches.
SAYS_WHY = re.compile(
    r"no such file|not found|could not|cannot|not reachable|is not on|off the scanned|"
    r"no tests directory|has no|missing|error", re.I)

# Commands that need a model or the network by design and so cannot be part of a
# headless matrix: agent.py spawns `claude -p`, geodata.py fetches public data.
# gen_object.py joins agent.py here for the same reason: it CALLS THE MODEL. Run
# against the empty property it spends a real `claude -p` call — 71 s of a 35 s
# suite — and then produces a traceback. Both are the tool behaving correctly for
# a tool of its kind and wrongly for this sweep, which is what this set is for.
# (`wants.py` stays IN the sweep: it only reaches the model behind --build.)
NOT_HEADLESS = {"tools/agent.py", "tools/geodata.py", "tools/gen_object.py"}

# Commands whose subject is NOT THE SITE, and which therefore answer correctly on
# a property with no data at all.
#
# The rule this sweep enforces is real and stays: a command whose answer IS the
# ground must refuse rather than exit 0, because the caller is usually a model and
# it will build on whatever it is handed. But `refdesign.py` is about the
# OWNER'S corpus of reference photographs — images they chose, with their notes
# on them — and that exists whether or not the yard has ever been surveyed. "You have
# no references yet, here is how to add one" is a true answer, and forcing it to
# exit non-zero would make a correct reply indistinguishable from a refusal in the
# other direction.
#
# Kept deliberately SMALL and stated per entry: this set is the escape hatch, and
# an escape hatch with no reason beside it is how a fail-open gets normalised.
# Everything here is still swept for tracebacks below.
SITE_INDEPENDENT = {
    "refdesign.py principles": "the owner's reference corpus, not the ground",
    # which sites exist — on an empty checkout the true answer is "none yet", and it is
    # how a new site starts
    "project.py list": "the list of sites, not a site",
}

# Measured defects that print a traceback, recorded here rather than silently
# asserted away; each reason says what was measured and where the fix belongs.
#
# Every site_api command whose answer IS the ground returns one shared refusal
# on a property with no terrain_scan.json and exits 2, sun.py's code for
# "refused" as against 1 "broken" and 0 "answered"; that contract is pinned in
# tests/test_site_no_scan.py, which tests the message, the exit code, and the
# write path that is deliberately NOT gated. A missing input file is a sentence
# too: `replant: cannot read <path>: no such file.` plus what --in wants, exit 2.
# Empty, and it should stay that way. A fixed bug left marked broken is a lie
# the next session has to re-measure — and an empty set here is not a dead
# constant, it is the assertion that every documented tool degrades with a
# sentence rather than a stack trace.
TRACEBACKS = set()
TRACEBACK_WHY = (
    "a documented command answered with a raw traceback instead of a sentence; "
    "every other tool in this repo names the file and exits non-zero.")


def broker_backed_clis():
    """The CLIs that need the viewer, read off the source rather than listed.

    Listed sets rot, and copies drift apart. A new tool that imports broker
    joins this matrix by existing.
    """
    out = []
    for fn in sorted(os.listdir(TOOLS)):
        if not fn.endswith(".py"):
            continue
        src = open(os.path.join(TOOLS, fn)).read()
        if re.search(r"^import broker", src, re.M) and "__main__" in src:
            out.append(f"tools/{fn}")
    return out


def label(argv):
    """`tools/site_api.py check-pad [[…]]` -> `site_api.py check-pad`."""
    name = os.path.basename(argv[0])
    if len(argv) > 1 and not argv[1].startswith("-"):
        return f"{name} {argv[1]}"
    return name


BROKER_CLIS = broker_backed_clis()
MATRIX = {label(a): a for a in command_lines(DOC_TEXT)
          if a[0] not in NOT_HEADLESS and not any(x in ("--help", "-h") for x in a)}
# Help describes a command and must succeed before a property is configured.


def _param_tb(lbl):
    marks = [pytest.mark.xfail(reason=TRACEBACK_WHY, strict=False)] if lbl in TRACEBACKS else []
    return pytest.param(lbl, marks=marks)


@pytest.fixture(scope="module")
def refused(tmp_path_factory):
    """A URL nothing answers on. Deliberately NOT the blocked-socket environment
    used below: connection REFUSED is the symptom a closed viewer produces, and
    it is the one the broker client translates.

    The port is bound only to learn a free number, then released. Holding it
    bound-without-listen looks tidier — nothing could steal the number — but
    on darwin the SYN is then dropped rather than reset, and the CLIs sit out
    their connect timeouts: measured, 23.5 s of a 12 s suite.
    """
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return f"http://127.0.0.1:{port}"


@pytest.fixture(scope="module")
def viewer_down(refused):
    env = dict(os.environ, YARDTWIN_VIEWER=refused)
    out = {}
    for tool in BROKER_CLIS:
        p = subprocess.run([sys.executable, os.path.join(TOOLS, os.path.basename(tool))],
                           capture_output=True, text=True, cwd=ROOT, env=env,
                           stdin=subprocess.DEVNULL, timeout=120)
        out[tool] = (p.returncode, p.stdout, p.stderr)
    return refused, out


@pytest.fixture(scope="module")
def empty_property(tmp_path_factory):
    """A project root with the real tools and no data at all.

    The tools resolve their data from their own __file__, and os.path.abspath
    does not resolve symlinks, so a tree of symlinked tools IS a second property
    — one that has never been scanned. Nothing here can touch the real data/.
    """
    d = tmp_path_factory.mktemp("empty_property")
    (d / "tools").mkdir()
    for fn in os.listdir(TOOLS):
        if fn.endswith(".py") or fn == "lib":
            os.symlink(os.path.join(TOOLS, fn), d / "tools" / fn)
    # schema/ is part of every checkout — the design schema, and where a project's files
    # live (schema/project_layout.json); it is the DATA that is absent
    os.symlink(os.path.join(os.path.dirname(TOOLS), "schema"), d / "schema")
    env = keyless_env(d)
    runs = {}
    for lbl, argv in MATRIX.items():
        p = subprocess.run([sys.executable, str(d / argv[0])] + argv[1:],
                           capture_output=True, text=True, cwd=str(d), env=env,
                           stdin=subprocess.DEVNULL, timeout=180)
        runs[lbl] = (p.returncode, p.stdout, p.stderr)
    return runs


def test_the_matrices_are_not_empty():
    """Presence and count before any per-case assertion: both matrices are built
    by parsing, and a parse that returned nothing would leave every test below
    passing while running no commands at all."""
    assert set(BROKER_CLIS) >= {"tools/analyze_site.py", "tools/float_check.py",
                                "tools/frame_check.py"}, BROKER_CLIS
    assert len(MATRIX) >= 15, f"only {len(MATRIX)} documented commands: {sorted(MATRIX)}"
    # the escape hatch must name commands that really exist, or it is silently
    # excusing nothing while a real fail-open hides behind a typo
    unknown = set(SITE_INDEPENDENT) - set(MATRIX)
    assert not unknown, f"SITE_INDEPENDENT names commands the sweep never runs: {sorted(unknown)}"
    for expected in ("site_api.py ground", "site_api.py zones", "site_api.py validate",
                     "site_plan.py", "sun.py season", "capability_check.py"):
        assert expected in MATRIX, f"{expected} dropped out of the matrix: {sorted(MATRIX)}"


@pytest.mark.parametrize("tool", BROKER_CLIS)
def test_a_viewer_backed_cli_says_the_viewer_is_down(tool, viewer_down):
    url, runs = viewer_down
    rc, out, err = runs[tool]
    both = out + err
    assert TRACEBACK not in both, f"{tool} printed a traceback at a closed viewer:\n{both}"
    assert rc != 0, f"{tool} exited 0 with no viewer to talk to:\n{both}"
    assert "not reachable" in both and url in both, \
        f"{tool} did not say which viewer it could not reach:\n{both}"
    assert "npm run dev" in both, f"{tool} did not say how to start it:\n{both}"


@pytest.mark.parametrize("lbl", sorted(MATRIX))
def test_a_documented_command_fails_loudly_on_an_empty_property(lbl, empty_property):
    """Non-zero exit and a message. Exit 0 here is the fail-open class: the
    caller is usually a model, and it will build on whatever it is handed."""
    rc, out, err = empty_property[lbl]
    both = out + err
    if lbl in SITE_INDEPENDENT:
        # it answers rather than refuses, ON PURPOSE — its subject is not the site
        assert rc == 0, (f"`{lbl}` is listed as site-independent ({SITE_INDEPENDENT[lbl]}) "
                         f"and yet refused an empty property:\n{both[:400]}")
        return
    assert rc != 0, (f"`{lbl}` answered a property with NO data at all and exited 0:\n"
                     f"{both[:600]}")
    assert 0 < rc < 100, f"`{lbl}` died on a signal or an unexpected code {rc}:\n{both}"
    assert SAYS_WHY.search(both), f"`{lbl}` failed without saying why:\n{both[:600]}"


@pytest.mark.parametrize("lbl", [_param_tb(k) for k in sorted(MATRIX)])
def test_a_documented_command_never_answers_with_a_traceback(lbl, empty_property):
    """A traceback is an unhandled case by definition: it proves nobody decided
    what should happen, and it buries the one line that matters under a stack."""
    _rc, out, err = empty_property[lbl]
    assert TRACEBACK not in (out + err), \
        f"`{lbl}` on an empty property:\n{(out + err)[-800:]}"
