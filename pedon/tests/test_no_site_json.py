"""A property with no site.json must be told to run geodata, not shown a traceback.

The first command a new property meets is site_api. Before `geodata.py --address`
has ever run there is no data/site.json, and `zones` / `areas` must not answer with a raw
`{"error": "FileNotFoundError: [Errno 2] No such file or directory: .../site.json"}`.

Every other tool in this repo degrades with a sentence and a fix: sun.py refuses a
bearing and names the two clicks, site_api refuses a ground question and names
analyze_site, replant names the file it could not read. Handing back the exception
text instead leaves the reader to work out that the answer is one command.

Onboarding a new property is the case this project most wants to win, and this
is minute one of it.
"""
import json
import os
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE_API = os.path.join(ROOT, "tools", "site_api.py")


@pytest.fixture(scope="module")
def fresh(tmp_path_factory):
    """A property with tools but no data at all — the state after `git clone`."""
    d = tmp_path_factory.mktemp("fresh")
    (d / "data").mkdir()
    for name in ("tools", "schema"):
        os.symlink(os.path.join(ROOT, name), d / name)
    return d


def run(fresh, *args):
    # the empty project through the product's own switch — see test_hardening_advertised
    env = dict(os.environ, PEDON_PROJECT=str(fresh / "data"))
    r = subprocess.run([sys.executable, os.path.join(fresh, "tools", "site_api.py"), *args],
                       capture_output=True, text=True, cwd=fresh, timeout=60, env=env)
    try:
        return json.loads(r.stdout or "{}"), r.returncode
    except ValueError:
        return {"_raw": r.stdout + r.stderr}, r.returncode


SITE_BACKED = ["zones", "areas", "constraints"]


def test_the_fixture_really_has_no_site_json(fresh):
    """Guard the premise: with a site.json present these all answer and this
    file would be asserting nothing."""
    assert not os.path.exists(os.path.join(fresh, "data", "site.json"))
    assert os.path.exists(os.path.join(fresh, "tools", "site_api.py"))


@pytest.mark.parametrize("cmd", SITE_BACKED)
def test_no_command_answers_with_an_exception_name(fresh, cmd):
    out, _rc = run(fresh, cmd)
    blob = json.dumps(out)
    for leak in ("FileNotFoundError", "Traceback", "No such file or directory"):
        assert leak not in blob, (
            f"`{cmd}` handed back the exception text instead of a sentence: {blob[:200]}")


@pytest.mark.parametrize("cmd", SITE_BACKED)
def test_no_command_pretends_to_have_answered(fresh, cmd):
    out, rc = run(fresh, cmd)
    if rc == 0:
        # answering without a site.json is only honest if the answer needs none
        assert out and "no_site" not in out, f"`{cmd}` exited 0 with {json.dumps(out)[:150]}"
    else:
        assert out.get("no_site") or out.get("error"), (
            f"`{cmd}` failed without saying why: {json.dumps(out)[:200]}")


def test_the_refusal_names_the_command_that_fixes_it(fresh):
    out, rc = run(fresh, "zones")
    assert rc != 0, f"zones answered on a property with no site.json: {out}"
    assert "geodata" in json.dumps(out), (
        f"the refusal does not say how to create site.json: {json.dumps(out)[:250]}")
