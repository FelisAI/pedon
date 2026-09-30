"""The traffic log is EVIDENCE, so a test run must not write to it.

data/site_api_calls.log is where every traffic figure in this project comes from
— call counts per run, the share of single-point queries that justifies the batch
tools. It is the only record of whether the model actually
queried the site or simply guessed well, which is the question the whole
tool-calling architecture exists to answer.

It is also append-on-every-invocation, so ordinary development writes to it: a
test suite, a probe from a terminal, an agent checking its own work. An agent
that adds its traffic and then deletes rows to tidy up leaves figures quoted
earlier that can no longer be re-derived from the file. Nothing has to be
malicious and nothing warns anybody — a shared mutable file that everything
writes to by default loses its evidence silently.

So: the path is overridable, the suite redirects it, and this asserts the
redirection actually holds. Evidence that development can silently rewrite is not
evidence.
"""
import pytest
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import project  # noqa: E402  where the active site's files are
REAL_LOG = project.data("site_api_calls.log")
SITE_API = os.path.join(ROOT, "tools", "site_api.py")


def _lines(path):
    try:
        with open(path) as f:
            return sum(1 for _ in f)
    except FileNotFoundError:
        return 0


def test_the_log_path_is_overridable():
    """Guard the mechanism before asserting what it prevents."""
    with open(SITE_API) as f:
        src = f.read()
    assert "YARDTWIN_CALL_LOG" in src, (
        "site_api hardcodes the log path, so nothing can keep a test run out of it")


@pytest.mark.needs_site
def test_the_suite_does_not_write_to_the_real_log(tmp_path):
    """Run a real query with the env var set and prove the evidence file is untouched."""
    before = _lines(REAL_LOG)
    sink = tmp_path / "calls.log"
    env = {**os.environ, "YARDTWIN_CALL_LOG": str(sink)}
    r = subprocess.run([sys.executable, SITE_API, "ground", "15", "-6"],
                       capture_output=True, text=True, env=env, timeout=60)
    assert r.returncode == 0, r.stderr[:300]
    assert _lines(sink) == 1, "the query was not logged to the sink at all"
    assert _lines(REAL_LOG) == before, (
        "a query with YARDTWIN_CALL_LOG set still appended to the real evidence file")


def test_conftest_redirects_the_whole_suite():
    """One test remembering to redirect is not a policy."""
    with open(os.path.join(ROOT, "tests", "conftest.py")) as f:
        src = f.read()
    assert "YARDTWIN_CALL_LOG" in src, (
        "tests/conftest.py does not redirect the call log, so any test that shells "
        "out to site_api writes into the evidence file")


@pytest.mark.needs_site
def test_the_log_is_still_parseable():
    """Whatever else happened to it, every line must still be one JSON record —
    a figure quoted from a file nothing can parse is a figure nobody can check."""
    bad = []
    with open(REAL_LOG) as f:
        for n, line in enumerate(f, 1):
            if not line.strip():
                continue
            try:
                json.loads(line)
            except ValueError:
                bad.append(n)
    assert not bad, f"unparseable log lines: {bad[:10]}"
