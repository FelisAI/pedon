"""The session tripwires in conftest.py: a test run that changes the site's files FAILS and
puts them back — and the site it reads is a COPY, so the real one is never touched;
a run that writes to the fixture library FAILS too. Seen red on purpose — a tripwire nobody
has watched trip is decoration. Runs a throwaway suite against a throwaway project, never the owner's."""
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _careless_run(tmp_path, test_source, site_json):
    """A throwaway checkout — this conftest, its fixture library, the real tools and schema — with
    one careless test, run against a throwaway site. Returns (the run, the site folder)."""
    (tmp_path / "tests").mkdir()
    (tmp_path / "tests" / "conftest.py").write_text(open(os.path.join(ROOT, "tests", "conftest.py")).read())
    shutil.copytree(os.path.join(ROOT, "tests", "fixtures", "library"), tmp_path / "tests" / "fixtures" / "library")
    (tmp_path / "tests" / "test_careless.py").write_text(test_source)
    for name in ("tools", "schema"):
        os.symlink(os.path.join(ROOT, name), tmp_path / name)
    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / "site.json").write_text(site_json)
    # the suite pins itself to the reference site (conftest), so name this one as it
    env = dict(os.environ, PEDON_TEST_SITE=str(proj), PYTHONDONTWRITEBYTECODE="1")
    r = subprocess.run([sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "tests"],
                       cwd=tmp_path, env=env, capture_output=True, text=True, timeout=120)
    return r, proj


def test_a_run_that_writes_the_site_fails_and_the_site_comes_back(tmp_path):
    r, proj = _careless_run(tmp_path, (
        "import project\n"
        "def test_writes_the_site():\n"
        "    open(project.data('site.json'), 'w').write('{\"zones\": \"clobbered\"}')\n"),
        '{"zones": "the owner\'s"}')
    assert r.returncode != 0, r.stdout[-600:]
    assert "changed the owner's site.json" in r.stdout, r.stdout[-800:]
    # the run reads a COPY of the site, so the real one is never written at all — and
    # the write into the copy still fails the run, loudly
    assert json.load(open(proj / "site.json")) == {"zones": "the owner's"}, "the real site was written"
    assert not [n for n in os.listdir(proj) if "changed-during-tests" in n], "the real site was touched"


def test_a_run_that_CREATES_a_site_file_fails_and_it_is_removed(tmp_path):
    """A project with no calibration yet must not get one from a test."""
    r, proj = _careless_run(tmp_path, (
        "import project\n"
        "def test_writes_a_calibration():\n"
        "    open(project.data('calibration.json'), 'w').write('{}')\n"), "{}")
    assert r.returncode != 0 and "calibration.json" in r.stdout, r.stdout[-600:]
    assert not (proj / "calibration.json").exists(), "the real site got a calibration"


def test_a_run_that_writes_to_the_fixture_library_fails(tmp_path):
    """Every test reads the fixture library, which is part of the source: a tool that wrote to
    "the library" during a test would edit the repository without a word."""
    r, _ = _careless_run(tmp_path, (
        "import project\n"
        "def test_writes_the_catalogue():\n"
        "    open(project.data('plant_palette.json'), 'a').write(' ')\n"), "{}")
    assert r.returncode != 0 and "wrote to the fixture library" in r.stdout, r.stdout[-800:]
    assert "plant_palette.json" in r.stdout, r.stdout[-800:]
