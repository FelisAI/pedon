"""The viewer may only write the half of site.json it owns — enforced, not agreed.

site.json is split by writer: fetched (geodata), derived (analyze_site), owner
(the viewer — landmarks, drawn areas, names). geodata.merge_section makes that
real for the two PYTHON writers, and raises rather than passing an out-of-section
key through, because a silent pass is a fail-open preserve-list under a new name.

The third writer is the viewer, and it owns the irreplaceable half. A POST of the
whole file to the generic /api/save does no ownership check at all — merge_section
cannot see that path, so the one writer whose data cannot be regenerated goes
through `save-owner` instead. Landmarks and areas are owner ground truth: nothing
can recompute them, and saved designs scope to areas by name.

This drives the enforcement directly, which is the only way to test it without a
browser.
"""
import json
import os
import shutil
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import project  # noqa: E402  where the active site's files are
sys.path.insert(0, os.path.join(ROOT, "tools"))
import geodata  # noqa: E402

SITE_API = os.path.join(ROOT, "tools", "site_api.py")


@pytest.fixture
def scratch(tmp_path):
    dst = tmp_path / "site.json"
    shutil.copy(project.data("site.json"), dst)
    return str(dst)


def run(payload, site):
    r = subprocess.run(
        [sys.executable, SITE_API, "save-owner", "--site", site],
        input=json.dumps(payload), capture_output=True, text=True, timeout=60)
    try:
        return json.loads(r.stdout or "{}"), r.returncode
    except ValueError:
        return {"stdout": r.stdout, "stderr": r.stderr}, r.returncode


def test_the_subcommand_exists():
    """Every refusal test below asserts rc != 0, which is ALSO what an unknown
    subcommand returns — so without this they all pass on a tool that was never
    written. Assert the mechanism before asserting what it refuses."""
    r = subprocess.run([sys.executable, SITE_API, "save-owner", "--help"],
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, (
        f"site_api has no `save-owner` subcommand, so the refusals below prove "
        f"nothing: {r.stderr[:300]}")


def test_the_owner_section_is_the_one_we_think():
    """Guard the premise: if `areas` stopped being owner-owned, the tests below
    would be checking the wrong half."""
    own = geodata.SECTIONS["owner"]["keys"]
    assert "areas" in own and "landmarks" in own
    assert "zones" not in own, "zones is derived — analyze_site owns it"
    assert "address" not in own, "address is fetched — geodata owns it"


@pytest.mark.needs_site
def test_the_viewer_may_write_its_own_half(scratch):
    out, rc = run({"areas": [{"name": "test_area", "polygon": [[0, 0], [1, 0], [1, 1]]}]}, scratch)
    assert rc == 0, out
    assert out.get("ok"), out
    saved = json.load(open(scratch))
    assert any(a["name"] == "test_area" for a in saved["areas"])


@pytest.mark.needs_site
def test_the_viewer_cannot_write_the_derived_half(scratch):
    before = open(scratch).read()
    out, rc = run({"zones": [{"zone": "invented", "area_m2": 1}]}, scratch)
    assert rc != 0 or not out.get("ok"), f"a viewer write of `zones` was accepted: {out}"
    assert open(scratch).read() == before, "the file changed on a refused write"


@pytest.mark.needs_site
def test_the_viewer_cannot_write_the_fetched_half(scratch):
    before = open(scratch).read()
    out, rc = run({"address": "somewhere else"}, scratch)
    assert rc != 0 or not out.get("ok"), f"a viewer write of `address` was accepted: {out}"
    assert open(scratch).read() == before


@pytest.mark.needs_site
def test_an_undeclared_key_is_refused_rather_than_absorbed(scratch):
    """The failure mode the split exists to close: a key nobody owns slipping in unnoticed."""
    before = open(scratch).read()
    out, rc = run({"whatever_this_is": 1}, scratch)
    assert rc != 0 or not out.get("ok"), f"an undeclared key was accepted: {out}"
    assert open(scratch).read() == before


@pytest.mark.needs_site
def test_a_refusal_says_who_does_own_it(scratch):
    """A rejection the owner cannot act on is a wall, not a guard."""
    out, _ = run({"zones": []}, scratch)
    msg = json.dumps(out)
    assert "analyze_site" in msg, f"the refusal does not name the real writer: {msg}"
