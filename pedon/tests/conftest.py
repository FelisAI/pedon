"""Put tools/ on sys.path so every test file can `import agent` / `import site_api`.

That is ALL this file does, deliberately. Fixtures live in the test file that
uses them, so two people adding tests in parallel never have to edit the same
file.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))


# The call log is evidence, not scratch space. data/site_api_calls.log is where
# every traffic figure comes from — call counts per run, the share of single-point
# queries that the batch tools answer — and site_api appends to it
# on EVERY invocation, so a suite that shells out to it silently rewrites the
# record it is quoting. Redirect the whole suite, once, here rather than hoping
# each test remembers. See tests/test_call_log.py.
import os as _os
import tempfile as _tempfile

_CALL_LOG_SINK = _os.path.join(_tempfile.gettempdir(), "pedon-test-calls.log")
_os.environ.setdefault("YARDTWIN_CALL_LOG", _CALL_LOG_SINK)


# WHICH SITE THE SUITE READS. Tests about a real, measured site read a COPY of the
# REFERENCE site (tools/project.py test_site, snapshot) — pinned for the whole session and
# every subprocess, so a site switched or edited in the viewer never changes what the suite
# measures, and nothing the suite does can reach the real one. Without one,
# the suite runs on an EMPTY project, as a fresh checkout would, and those tests SKIP
# rather than fail: they are marked `needs_site`.
import project as _project
import pytest as _pytest

# WHICH LIBRARY THE SUITE READS. The app ships no catalogue, and what the user's own holds is
# theirs to change — so the app's tests read a FIXTURE library (tests/fixtures/library: a small
# catalogue, no models, no species code), the same on every machine; subprocesses too, through
# the product's own switch. A test ABOUT the user's library is marked `real_library`: it reads
# theirs, and skips without one.
FIXTURE_LIBRARY = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "fixtures", "library")
REAL_LIBRARY = _project.LIBRARY
_os.environ["PEDON_LIBRARY"] = FIXTURE_LIBRARY
_project.LIBRARY = FIXTURE_LIBRARY

REFERENCE_SITE = _project.test_site()
# a COPY of it, never the site itself: its owner may be using it in the viewer right now
_os.environ["PEDON_PROJECT"] = _project.snapshot(REFERENCE_SITE) if REFERENCE_SITE else _project.empty_project()


def pytest_configure(config):
    config.addinivalue_line("markers", "needs_site: reads the reference site (PEDON_TEST_SITE or "
                                       "<projects>/.test_site); skipped when there is none")
    config.addinivalue_line("markers", "real_library: about the user's own library, not the "
                                       "fixture; skipped when they have none")


def pytest_runtest_setup(item):
    import pytest
    if REFERENCE_SITE is None and item.get_closest_marker("needs_site"):
        pytest.skip("about a real site: set PEDON_TEST_SITE (or ~/PEDON/.test_site) to one")
    if item.get_closest_marker("real_library") and not _os.path.exists(
            _os.path.join(REAL_LIBRARY, "plant_palette.json")):
        pytest.skip("about the user's library: none at $PEDON_LIBRARY or ~/PEDON/library")


@_pytest.fixture(scope="session", autouse=True)
def _the_fixture_library_is_read_only():
    """Every test reads the fixture library, and it is part of the source: a tool that WROTE to
    "the library" in a test would edit the repository. The run fails if any file in it changed."""
    import hashlib

    def state():
        out = {}
        for folder, _, names in _os.walk(FIXTURE_LIBRARY):
            for n in names:
                p = _os.path.join(folder, n)
                with open(p, "rb") as fh:
                    out[_os.path.relpath(p, FIXTURE_LIBRARY)] = hashlib.sha1(fh.read()).hexdigest()
        return out
    before = state()
    assert before, f"the fixture library is empty or missing: {FIXTURE_LIBRARY}"
    yield
    after = state()
    assert after == before, ("a test wrote to the fixture library (tests/fixtures/library): "
                             f"{sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))}")


@_pytest.fixture(scope="session")
def real_library():
    """Where the user's own library is — the subject of a `real_library` test."""
    return REAL_LIBRARY


@_pytest.fixture(autouse=True)
def _the_library_the_test_is_about(request, monkeypatch):
    """A `real_library` test reads the user's library; every other one the fixture."""
    if request.node.get_closest_marker("real_library"):
        import plant_catalog
        monkeypatch.setattr(_project, "LIBRARY", REAL_LIBRARY)
        monkeypatch.setenv("PEDON_LIBRARY", REAL_LIBRARY)
        monkeypatch.setattr(plant_catalog, "PALETTE", plant_catalog.Path(_project.data("plant_palette.json")))
    yield


# THE SITE'S FILES ARE NOT A FIXTURE, and the site under test is a copy. A sandbox that
# isolates a test by patching a module's ROOT, or by symlinking tools/, isolates nothing,
# because every data path goes through tools/project.py — such a test rewrites the owner's
# own data/site.json and terrain_scan.json. Isolation is PEDON_PROJECT at an empty folder,
# the product's own switch, and this makes the class impossible to repeat silently: the
# active project's site files are read at the
# start; at the end, a changed one is kept beside the original as
# <name>.changed-during-tests-<stamp>, the original is put back, and the run FAILS.
_GUARDED = ("site.json", "design.json", "terrain_scan.json", "terrain.json", "calibration.json",
            "project.json")


@_pytest.fixture(scope="session", autouse=True)
def _the_owners_files_come_back_as_they_went():
    import time
    import project
    folder = project.folder()
    before = {}
    for name in _GUARDED:
        try:
            with open(_os.path.join(folder, name), "rb") as f:
                before[name] = f.read()
        except OSError:
            before[name] = None               # absent — and it must still be absent after
    yield
    stamp = time.strftime("%Y%m%d-%H%M%S")
    changed = []
    for name, data in before.items():
        path = _os.path.join(folder, name)
        try:
            with open(path, "rb") as f:
                now = f.read()
        except OSError:
            now = None
        if now != data:
            if now is not None:
                with open(f"{path}.changed-during-tests-{stamp}", "wb") as f:
                    f.write(now)
            if data is None:
                _os.remove(path)              # a test CREATED it: put the absence back
            else:
                with open(path, "wb") as f:
                    f.write(data)
            changed.append(name)
    if changed:
        raise AssertionError(
            f"the test run changed the owner's {', '.join(changed)} in {folder}. Restored; the "
            f"changed copies are beside them as *.changed-during-tests-{stamp}. A test is writing "
            "real data — isolate it with PEDON_PROJECT pointed at a temporary folder.")
