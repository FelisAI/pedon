"""The real data/site.json must survive the ownership split untouched.

The split (geodata.SECTIONS) governs a file that already exists, that every
tool reads, and that saved designs depend on by name. So the test that matters
is not "the code is self-consistent" — it is "run the write paths over the
REAL file and every existing consumer still gets what it expects". A check that
only passes on data it invented itself is vacuous.

Read-only: data/site.json is copied into tmp_path and every write happens there.
"""
import json
import os
import shutil

import pytest

import agent
import geodata
import site_api
from test_site_ownership import run_geodata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import project  # noqa: E402  where the active site's files are

# about a REAL site — skipped without the reference site (tests/conftest.py)
pytestmark = pytest.mark.needs_site
SITE = project.data("site.json")
DESIGN = project.data("design.json")


@pytest.fixture
def committed():
    with open(SITE) as f:
        return json.load(f)


def _consumers(site):
    """Everything the existing readers actually pull out of site.json, as one
    comparable value. agent.validate is in here because it is the reader whose
    answer a designer sees; the rest are the lookups the viewer, site_api and
    agent.py do by key and by NAME."""
    with open(DESIGN) as f:
        design = json.load(f)
    return {
        "constraints": agent.constraints(site),
        "validate": json.dumps(agent.validate(design, site), sort_keys=True),
        "footprint": site.get("footprint"),
        "origin": site.get("origin"),
        "usda_zone": site.get("usda_zone"),
        # by NAME — this is the lookup agent.py --area and site_api area do,
        # and the reason deleting `areas` is unrecoverable
        "areas": {a["name"]: a["polygon"] for a in site.get("areas", [])},
        "zones": {z["zone"]: z.get("bounds_m") for z in site.get("zones", [])},
        "landmarks": {l["name"]: (l["x"], l["y"]) for l in site.get("landmarks", [])},
        "house_measured": site.get("house_measured"),
        "scan_coverage": site.get("scan_coverage"),
        "terrain": site.get("terrain"),
        "frame": site.get("frame"),
    }


def test_the_committed_file_has_the_data_these_checks_claim_to_protect(committed):
    """Presence and count first: every assertion below compares before with
    after, and comparing two empty dicts passes for the wrong reason."""
    assert len(committed["areas"]) >= 1
    assert len(committed["landmarks"]) >= 10
    assert len(committed["zones"]) >= 4
    assert len(committed["footprint"]) >= 3
    c = _consumers(committed)
    assert c["areas"] and c["zones"] and c["landmarks"]


def test_every_key_in_the_committed_file_has_an_owner(committed):
    """A key nobody owns can be carried through but never updated. This is the
    test that stops the ownership map rotting into a stale list of keys."""
    unowned = sorted(k for k in committed if geodata.owner_of(k) is None)
    assert unowned == [], (
        f"{unowned} is in site.json but not declared in geodata.SECTIONS — "
        f"add it to the section of whichever tool writes it")


def test_a_geodata_rerun_over_the_committed_file_changes_only_fetched_keys(
        tmp_path, monkeypatch, committed):
    shutil.copy(SITE, tmp_path / "site.json")
    o = committed["origin"]
    after = run_geodata(tmp_path, monkeypatch, address="a different address",
                        lat=o["lat"], lon=o["lon"], zip5=committed["zip"])

    assert after["address"] == "a different address"      # it really did re-run
    assert set(after) == set(committed), "a key appeared or vanished"
    changed = {k for k in committed if committed[k] != after[k]}
    assert changed <= set(geodata.SECTIONS["fetched"]["keys"]), sorted(changed)

    before_c, after_c = _consumers(committed), _consumers(after)
    for k in ("areas", "zones", "landmarks", "house_measured", "scan_coverage",
              "terrain", "frame", "constraints", "validate"):
        assert after_c[k] == before_c[k], f"consumer {k} sees a different site"


def test_an_analyze_site_rerun_over_the_committed_file_keeps_the_owner_half(committed):
    """analyze_site's payload, merged onto the real file. Its own half is
    replaced; nothing else may move."""
    derived = {"zones": [{"zone": "east_yard", "area_m2": 1.0}],
               "scan_coverage": {"scanned_ground_m2": 1.0},
               "house_measured": {"area_m2": 1.0}}
    after = geodata.merge_section(committed, "derived", derived)

    assert after["zones"] == derived["zones"]             # it really did write
    assert set(after) == set(committed)
    before_c, after_c = _consumers(committed), _consumers(after)
    for k in ("areas", "landmarks", "terrain", "frame", "footprint", "origin",
              "usda_zone", "constraints"):
        assert after_c[k] == before_c[k], f"consumer {k} sees a different site"


def test_a_rerun_adds_no_new_schema_violation(tmp_path, monkeypatch, committed):
    """Against schema/site.schema.json — but as a DELTA, not a pass/fail. A real
    file can already violate it (`imagery_quality` is null when a site is
    fetched without a Solar API key), and a re-run must not make that worse."""
    jsonschema = pytest.importorskip("jsonschema")
    with open(os.path.join(ROOT, "schema", "site.schema.json")) as f:
        validator = jsonschema.Draft202012Validator(json.load(f))

    def faults(site):
        return sorted(e.json_path for e in validator.iter_errors(site))

    shutil.copy(SITE, tmp_path / "site.json")
    o = committed["origin"]
    after = run_geodata(tmp_path, monkeypatch, address="a different address",
                        lat=o["lat"], lon=o["lon"], zip5=committed["zip"])
    assert after["address"] == "a different address"      # it really did re-run
    assert faults(after) == faults(committed)


def test_site_api_still_reads_the_committed_file():
    """site_api opens data/site.json by an absolute path of its own, so this is
    the one check that runs against the real file in place."""
    lim = site_api.limits()
    assert lim["retain_limit_m"] > 0
    names = [a["name"] for a in site_api._site().get("areas", [])]
    assert names, "site_api can no longer see the owner's drawn areas"
