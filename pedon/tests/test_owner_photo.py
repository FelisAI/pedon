"""A photograph the owner took of a plant they actually own.

The requirement: the owner photographs things they have — plants, stones — and
adds them to the assets with their size.

This is strictly better data than the library has: `--audit` exists because a
genus-only entry can cache a photograph of a DIFFERENT SPECIES — in one audit
TEN of 22 did, e.g. an Arctostaphylos uva-ursi mat standing in for a 2.5 m
sculptural shrub, and a preset written from such a photograph inherits the wrong
plant's look. The owner cannot be wrong about which plant it is.
"""
import base64
import json
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import owner_photo  # noqa: E402

# a real one-pixel PNG, so the tool is exercised on something a decoder accepts
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


def run(args, cwd=ROOT):
    return subprocess.run([sys.executable, os.path.join(ROOT, "tools", "owner_photo.py"), *args],
                          capture_output=True, text=True, cwd=cwd)


def photo(suffix=".png"):
    f = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    f.write(PNG)
    f.close()
    return f.name


def test_an_owner_photo_outranks_a_fetched_one_for_the_same_taxon():
    """The whole point. A fetched row can be the wrong species; the owner's cannot."""
    idx = {
        "salvia_apiana": {"species": "Salvia apiana", "source": "https://commons...",
                          "reference_scope": "named_species", "usable_for_modeling": True},
        "salvia_apiana__owner": {"species": "Salvia apiana", "source": "owner",
                                 "reference_scope": "owner_specimen"},
    }
    assert owner_photo.photo_for(idx, "Salvia apiana")["source"] == "owner"
    # and it wins whichever order the dict happens to be in — a resolver written
    # as `byKey[row.species] = row` picks whichever came last
    flipped = dict(reversed(list(idx.items())))
    assert owner_photo.photo_for(flipped, "Salvia apiana")["source"] == "owner"


def test_a_named_species_beats_a_genus_proxy_when_there_is_no_owner_photo():
    idx = {"a": {"species": "X", "reference_scope": "species_proxy", "usable_for_modeling": True},
           "b": {"species": "X", "reference_scope": "named_species", "usable_for_modeling": True}}
    assert owner_photo.photo_for(idx, "X")["reference_scope"] == "named_species"
    assert owner_photo.photo_for(idx, "nothing here") is None
    assert owner_photo.photo_for({}, "X") is None


def test_a_size_is_REQUIRED_and_never_inferred_from_the_image():
    """An owner photo is worth having because it comes with a measurement.

    Inferring scale from a photograph would be a derived number standing in for a
    measured one, which is the class of error site_api exists to prevent — and it
    is the wrong number anyway: MATURE size is a fact about the species, and what
    the owner can measure is what the plant is NOW.
    """
    p = photo()
    try:
        out = json.loads(run(["add", "--photo", p, "--species", "Salvia apiana"]).stdout)
        assert out["error"] == "no_measurement", out
        assert "infers scale" in out["detail"]
    finally:
        os.unlink(p)
    # and nothing in the tool reads pixels
    src = open(os.path.join(ROOT, "tools", "owner_photo.py")).read()
    for banned in ("PIL", "Image.open", "cv2", "imagesize", "exif"):
        assert banned not in src, f"owner_photo.py is measuring the image itself: {banned}"


def test_a_photograph_can_never_touch_cat_safety(tmp_path, monkeypatch):
    """cat_safe has three states and null is NOT safe.

    A photograph establishes what a plant LOOKS like. It says nothing about
    toxicology, and cats may have the run of the garden.
    """
    assert "cat_safe" in owner_photo.FORBIDDEN
    assert "cat_safe" not in owner_photo.ALLOWED
    src = open(os.path.join(ROOT, "tools", "owner_photo.py")).read()
    # the ONLY mentions are the refusal itself — never an assignment
    assert not re.search(r"""row\[["']cat_safe""", src), "an owner row writes cat_safe"
    assert not re.search(r"""["']cat_safe["']\s*:""", src.replace("FORBIDDEN", "")), \
        "an owner row carries a cat-safety claim"


def test_a_mature_size_is_not_something_one_specimen_proves():
    """Two fields, and this tool writes only one of them."""
    assert "mature_height_m" in owner_photo.FORBIDDEN
    assert "mature_height_m" not in owner_photo.ALLOWED
    assert "measured_height_m" in owner_photo.ALLOWED


def test_it_writes_the_SAME_store_rather_than_a_second_one():
    # a parallel store is two things to audit and two things to keep in step,
    # for the same reason geometry lives once in tools/geom.py
    # the store plant_photos.py fetches into and the viewer serves as data/refphotos — the
    # user's library, found the one way every tool finds it
    import project
    assert owner_photo.INDEX == os.path.join(project.data("refphotos"), "index.json")


def test_a_round_trip_records_what_the_owner_measured_and_nothing_else(tmp_path):
    """Against a REAL index file, in a temp copy — never the owner's own."""
    idx_dir = tmp_path / "data" / "refphotos"
    idx_dir.mkdir(parents=True)
    (idx_dir / "index.json").write_text(json.dumps({
        "salvia_apiana": {"species": "Salvia apiana", "source": "https://commons...",
                          "reference_scope": "named_species", "usable_for_modeling": True}}))
    p = photo()
    try:
        env = dict(os.environ)
        r = subprocess.run(
            [sys.executable, "-c",
             "import sys; sys.path.insert(0, %r); import owner_photo as o;"
             "o.ROOT = %r; o.OUT = %r; o.OWNER_DIR = %r; o.INDEX = %r;"
             "sys.exit(o.main(['add','--photo',%r,'--species','Salvia apiana',"
             "'--height-m','0.8','--spread-m','1.1','--where','back yard']))"
             % (os.path.join(ROOT, "tools"), str(tmp_path), str(idx_dir),
                str(idx_dir / "owner"), str(idx_dir / "index.json"), p)],
            capture_output=True, text=True, env=env)
        assert r.returncode == 0, r.stdout + r.stderr
        idx = json.loads((idx_dir / "index.json").read_text())
        row = idx["salvia_apiana__owner"]
        assert row["source"] == "owner"
        assert row["measured_height_m"] == 0.8 and row["measured_spread_m"] == 1.1
        assert "cat_safe" not in row and "mature_height_m" not in row
        assert not set(row) - owner_photo.ALLOWED
        # the fetched row SURVIVES: an owner photo outranks it, it does not delete it
        assert "salvia_apiana" in idx
        assert owner_photo.photo_for(idx, "Salvia apiana")["source"] == "owner"
        # THE FILE IS COPIED, not referenced — a path into the owner's home
        # directory breaks the moment the photo moves, and the repo would carry a
        # pointer to something nobody else can read.
        #
        # Asserted as "inside the store", not "not absolute": `relpath` of a
        # /var/folders path produces a ../../.. chain that is neither absolute
        # nor inside anything, and it still resolves to the real file — so a
        # "not absolute" check passes with the copy replaced by `dest = src`.
        assert ".." not in row["file"].split(os.sep), \
            f"the index points OUT of the repo: {row['file']}"
        assert row["file"].replace(os.sep, "/").startswith("data/refphotos/owner/"), \
            f"the photo was referenced where it lay, not copied into the store: {row['file']}"
        assert os.path.isfile(tmp_path / row["file"])
        assert (tmp_path / row["file"]).read_bytes() == PNG, "the copy is not the photo"
    finally:
        os.unlink(p)


def test_an_implausible_or_unreadable_photo_is_refused():
    out = json.loads(run(["add", "--photo", "/nope/nothing.jpg",
                          "--species", "X", "--height-m", "1"]).stdout)
    assert out["error"] == "no_photo"
    p = photo(".txt")
    try:
        out = json.loads(run(["add", "--photo", p, "--species", "X", "--height-m", "1"]).stdout)
        assert out["error"] == "not_an_image"
    finally:
        os.unlink(p)
    p = photo()
    try:
        out = json.loads(run(["add", "--photo", p, "--species", "X", "--height-m", "400"]).stdout)
        assert out["error"] == "implausible_size"
    finally:
        os.unlink(p)


def test_the_python_and_javascript_halves_rank_identically():
    """Both read this index, so a second opinion about which photo wins is a
    coin toss over which one a plant gets modelled from."""
    js = open(os.path.join(ROOT, "viewer", "src", "shell", "refphotos.js")).read()
    assert "source === \"owner\"" in js, "the browser has no idea what an owner row is"
    assert "named_species" in js, "the browser's ladder is missing a rung python has"
    # the same three cases, answered by both
    cases = [
        ({"o": {"species": "S", "source": "owner"},
          "n": {"species": "S", "reference_scope": "named_species"}}, "o"),
        ({"p": {"species": "S", "reference_scope": "species_proxy"},
          "n": {"species": "S", "reference_scope": "named_species"}}, "n"),
        ({"u": {"species": "S", "usable_for_modeling": False},
          "p": {"species": "S", "reference_scope": "species_proxy"}}, "p"),
    ]
    node = os.path.join(ROOT, "viewer", "src", "shell", "refphotos.js")
    script = (
        "import {photoFor} from %r;"
        "const cases = %s;"
        "console.log(JSON.stringify(cases.map(c => photoFor(c, 'S')?.key)));"
        % (node, json.dumps([c for c, _ in cases]))
    )
    r = subprocess.run(["node", "--input-type=module"], input=script,
                       capture_output=True, text=True, cwd=ROOT)
    assert r.returncode == 0, r.stderr
    got = json.loads(r.stdout)
    for (idx, want), js_key in zip(cases, got):
        assert owner_photo.photo_for(idx, "S")["key"] == want, "python picked the wrong row"
        assert js_key == want, f"javascript picked {js_key}, python picked {want}"
