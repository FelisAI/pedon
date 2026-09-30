"""The suite has to stay fast enough that anyone actually runs it.

Why the budget lives in tools/selftest.py and not in an assertion in here
------------------------------------------------------------------------
The obvious shape — a test that runs the whole suite in a subprocess and
asserts the clock — DOUBLES the suite, which is precisely the cost it exists to
police: measured here, a 14.5 s suite would become 29 s, and the guard would
then break the very budget it asserts. So the budget is enforced by the runner,
at the only moment that can measure the real thing (`python3 tools/selftest.py`,
which AGENTS.md tells you to run before and after any change), and this file
tests the runner instead. Nested runs here use a throwaway suite of one trivial
test, so they cost ~0.3 s and cannot recurse.

It is a CPU budget rather than wall clock because several agents run this suite
concurrently in this tree: measured on this machine the full suite is 14.2 s of
CPU against 14.5 s of wall clock, and wall clock under parallel load measures
the machine, not the suite — a wall-clock budget would fail everybody's run at
once for a slowdown none of them caused. Wall clock is still printed, because
that is the number a human feels.
"""
from __future__ import annotations
import os
import re
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SELFTEST = os.path.join(ROOT, "tools", "selftest.py")

TRIVIAL = "def test_trivial():\n    assert True\n"
FAILING = "def test_broken():\n    assert 1 == 2\n"


def _suite(tmp_path, body):
    """A throwaway ROOT with tools/selftest.py and a one-test suite under it.

    selftest resolves ROOT from its own __file__ and os.path.abspath does NOT
    resolve symlinks, so a symlinked copy makes the runner treat tmp_path as the
    whole project — which is how this can time a suite without running the real
    one inside itself.
    """
    (tmp_path / "tools").mkdir(exist_ok=True)
    link = tmp_path / "tools" / "selftest.py"
    if not link.exists():
        link.symlink_to(SELFTEST)
    (tmp_path / "tests").mkdir(exist_ok=True)
    (tmp_path / "tests" / "test_sandbox.py").write_text(body)
    return link


def _run(link, budget=None):
    env = dict(os.environ)
    env.pop("YARDTWIN_SELFTEST_BUDGET_S", None)
    if budget is not None:
        env["YARDTWIN_SELFTEST_BUDGET_S"] = str(budget)
    p = subprocess.run([sys.executable, str(link), "-q", "-p", "no:randomly"],
                       capture_output=True, text=True, env=env, timeout=120)
    return p.returncode, p.stdout + p.stderr


@pytest.fixture(scope="module")
def green_run(tmp_path_factory):
    """One nested run of a one-test suite, shared: two assertions read it, and a
    test file that polices the suite's cost may not be careless with its own."""
    return _run(_suite(tmp_path_factory.mktemp("green"), TRIVIAL))


def test_the_runner_reports_how_long_the_suite_took(green_run):
    """Nobody notices a suite creeping from 14 s to 90 s unless it says so."""
    rc, out = green_run
    assert rc == 0, out
    assert re.search(r"finished in \d+\.\d s wall, \d+\.\d s cpu", out), \
        f"the runner never said how long it took:\n{out}"


def test_the_budget_defaults_to_the_documented_number(green_run):
    """The runner must enforce the number its own docstring justifies.

    Hardcoding the number would make a deliberate, reasoned change to the budget
    fail the test for being a change rather than for being wrong — and the
    honest response to that is to edit the literal, which teaches people the
    test is noise. What is actually worth catching is the opposite: someone
    raising the constant WITHOUT touching the paragraph that explains it, so the
    docstring quietly stops describing the program.

    So: read both, and require them to agree.
    """
    rc, out = green_run
    assert rc == 0, out
    enforced = re.search(r"budget (\d+(?:\.\d+)?) s cpu", out)
    assert enforced, f"the runner never named its budget:\n{out}"

    src = open(os.path.join(ROOT, "tools", "selftest.py")).read()
    doc = src[:src.index('"""', src.index('"""') + 3)]
    justified = re.findall(r"(\d+(?:\.\d+)?) s is deliberately", doc)
    assert justified, (
        "selftest.py's docstring no longer justifies a budget — the number is now "
        "unexplained, which is how a tripwire becomes noise")
    assert float(enforced.group(1)) == float(justified[0]), (
        f"the runner enforces {enforced.group(1)} s but its docstring justifies "
        f"{justified[0]} s — change the reasoning too, or the doc is now fiction")


def test_a_suite_over_budget_fails_the_run(tmp_path):
    """Reporting a slow suite is not enough — a warning nobody gates on is a
    warning nobody reads. Over budget has to be a non-zero exit."""
    rc, out = _run(_suite(tmp_path, TRIVIAL), budget=0.001)
    assert rc != 0, f"a suite 300x over budget still exited 0:\n{out}"
    assert "over budget" in out.lower(), f"it failed without saying why:\n{out}"
    assert "0.001" in out, f"it did not name the budget it broke:\n{out}"


def test_a_failing_suite_is_never_reported_as_merely_slow(tmp_path):
    """Precedence matters: a red suite that also ran long must report the
    failure. Telling someone their broken suite is 'over budget' sends them to
    optimise a test that is failing."""
    rc, out = _run(_suite(tmp_path, FAILING), budget=0.001)
    assert rc != 0
    assert "over budget" not in out.lower(), \
        f"a FAILING suite was reported as a budget problem:\n{out}"


def test_the_real_suite_is_inside_its_own_budget():
    """Not a second run of the suite — that is what this file refuses to do.
    It reads the budget the runner enforces and asserts it is a number the real
    suite meets, so the two cannot silently drift apart."""
    src = open(SELFTEST).read()
    m = re.search(r"YARDTWIN_SELFTEST_BUDGET_S[^)]*?\"(\d+)\"", src)
    assert m, "the runner no longer has a default budget to enforce"
    # A budget nobody would notice is not a budget. 90 s is about the longest a
    # person will sit through twice per change, so it is a real ceiling — if it
    # needs raising, the honest move is to find what got slow, not to move the line.
    #
    # THE CEILING IS ABOUT WHAT A PERSON SITS THROUGH, which is WALL clock — and
    # the budget is CPU, on purpose (several agents share this tree, so wall
    # measures the machine). The two are the same number only while everything runs
    # in one process; with the node half running files concurrently, CPU is several
    # times wall. Holding a CPU budget to a 90 s HUMAN limit would leave two ways to
    # pass — delete coverage, or override the budget by hand — and an override hides
    # a real regression. So the human limit is applied to the wall time the budget
    # implies at the runner's OWN concurrency. It still bites: 400 s of cpu is 100 s
    # of wall.
    conc = re.search(r"--test-concurrency=(\d+)", src)
    assert conc, "the runner no longer states its node concurrency — this ceiling needs it"
    implied_wall = float(m.group(1)) / int(conc.group(1))
    assert float(m.group(1)) >= 5 and implied_wall <= 90, (
        f"a {m.group(1)} s cpu budget at concurrency {conc.group(1)} allows ~{implied_wall:.0f} s of "
        "wall clock: under ~5 s cannot be met, and over ~90 s is not a budget anybody would notice")


@pytest.mark.parametrize("arg", ["-k", "--maxfail"])
def test_pytest_arguments_still_pass_straight_through(tmp_path, arg):
    """The runner's whole contract is `any pytest arg passes through`; adding
    timing must not eat them."""
    link = _suite(tmp_path, TRIVIAL)
    val = "test_trivial" if arg == "-k" else "1"
    p = subprocess.run([sys.executable, str(link), "-q", arg, val],
                       capture_output=True, text=True, timeout=120)
    assert p.returncode == 0, p.stdout + p.stderr
    assert "1 passed" in p.stdout + p.stderr


# ── the machine's price for work ───────────────────────────────────
# CPU time is the budget because wall clock measures the machine. On a Mac CPU
# time does too: the same test file costs 22 s of CPU on a performance core and
# 49.6 s on an efficiency core, and when another process holds the performance
# cores the suite spills onto the efficiency ones, so the budget can break with no
# test slower. So the runner prices a fixed loop around each half and judges the
# budget at a quiet machine's price.
def _price(out):
    m = re.search(r"paid (\d+\.\d+)x per unit of work", out)
    assert m, f"the runner never said what this machine charged for the work:\n{out}"
    return float(m.group(1))


def test_the_runner_says_what_the_machine_charged(green_run):
    rc, out = green_run
    assert rc == 0, out
    assert re.search(r"= \d+\.\d s at a quiet machine's price \(budget \d+(\.\d+)? s cpu\)", out), out
    assert _price(out) > 0


@pytest.mark.skipif(not os.path.exists("/usr/sbin/taskpolicy"),
                    reason="needs macOS taskpolicy to force efficiency cores")
def test_efficiency_cores_are_charged_to_the_machine_not_the_suite(tmp_path):
    """The instrument, seen working: forced onto efficiency cores the same trivial
    suite must report that it paid about twice as much per unit of work (measured
    2.2-2.3x), so what the budget judges does not double with it."""
    link = _suite(tmp_path, TRIVIAL)
    p = subprocess.run(["/usr/sbin/taskpolicy", "-b", sys.executable, str(link), "-q"],
                       capture_output=True, text=True, timeout=120)
    out = p.stdout + p.stderr
    assert p.returncode == 0, out
    assert _price(out) >= 1.6, f"efficiency cores were charged to the suite:\n{out}"
