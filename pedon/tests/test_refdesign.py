"""Landscape photographs the owner wants to learn from.

The owner can hand the model a photograph of a landscape design and ask it to
learn from that design and design their site in a similar way.

THE TRAP is the whole design of the file under test. "Design it like this photo"
wants to transplant GEOMETRY, and the owner's ground will not take it: the
reference was shot on someone else's slope, in someone else's light. A design that
looks like the photograph and ignores a measured 1.90 m step is the failure this
project exists to prevent.
"""
import base64
import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import refdesign  # noqa: E402

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


def run(args):
    return subprocess.run([sys.executable, os.path.join(ROOT, "tools", "refdesign.py"), *args],
                          capture_output=True, text=True, cwd=ROOT)


def image(suffix=".png"):
    f = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    f.write(PNG)
    f.close()
    return f.name


def test_a_reading_may_never_carry_geometry():
    """THE refusal. Everything else in this file is scaffolding around it."""
    for bad in [
        {"principles": ["nice"], "polygon": [[0, 0], [1, 1]]},
        {"planting": {"position": [3, 4]}},
        {"paths": [{"spline": [[0, 0]]}]},
        {"principles": ["put the bench at 14.2, -7.9 and aim it uphill"]},
        {"reading": {"x": 3}},
    ]:
        assert refdesign.geometry_in(bad), f"geometry got through: {bad}"
    # and a real reading passes untouched
    good = {
        "height_bands": {"ankle": True, "knee": True, "waist": False, "head": True},
        "open_ground": 0.3, "hard_fraction": 0.22, "drift_size": "5-9",
        "path_width_m": 1.2, "edge": "drifted", "season": "late summer",
        "palette": ["straw", "rust", "smoke"],
        "repetition": "three grasses carry most of it",
        "principles": ["drifts of one species read as a garden",
                       "the walk is wide enough for two and never straight"],
        "not_transferable": ["it is flat", "northern light"],
    }
    assert refdesign.geometry_in(good) == [], refdesign.geometry_in(good)


def test_a_sentence_may_mention_a_path_without_naming_a_place():
    # over-refusing is its own failure: a principle about a walk is the point
    assert refdesign.geometry_in({"principles": ["the path is never straight"]}) == []
    assert refdesign.geometry_in({"principles": ["1.2 m is wide enough for two"]}) == []
    # but a number attached to a place is a transplant
    assert refdesign.geometry_in({"principles": ["the bed runs to 14.5, -7.9"]})


def test_the_schema_itself_contains_no_place():
    """The keys ARE the spec — a reading is proportions, bands, counts and words."""
    for k in refdesign.READING_KEYS:
        assert not refdesign.GEOMETRY.search(k), f"the schema itself names a place: {k}"
    for wanted in ("height_bands", "open_ground", "hard_fraction", "principles",
                   "not_transferable"):
        assert wanted in refdesign.READING_KEYS


def test_the_note_is_required_because_it_is_the_valuable_half():
    p = image()
    try:
        out = json.loads(run(["add", "--image", p]).stdout)
        assert out["error"] == "no_note"
        assert "your own words" in out["detail"]
    finally:
        os.unlink(p)


def test_nothing_here_fetches_or_searches_for_an_image():
    """Owner input, like landmarks and areas — the owner chooses what to learn from.

    A vision pass can label the south fence "back_fence" and send every design
    that trusts it into the wrong part of the site, which is why owner ground
    truth is never model-generated.
    """
    src = open(os.path.join(ROOT, "tools", "refdesign.py")).read()
    # comments and the DENY LIST excluded — "WebSearch" appearing in
    # --disallowedTools is the opposite of reaching out for an image, and a naive
    # substring scan flags the very line that forbids it
    code = "\n".join(l for l in src.split("\n")
                     if not l.strip().startswith("#") and "disallowedTools" not in l
                     and '"Task"' not in l)
    for banned in ("urllib", "requests", "WebSearch(", "WebFetch(", "commons.wikimedia",
                   "http://", "https://"):
        assert banned not in code, f"refdesign.py reaches out for images: {banned}"
    assert "--disallowedTools" in src and "WebSearch" in src, \
        "the reading pass no longer DENIES the web tools"


def test_the_reading_pass_hands_a_file_path_to_a_cli_that_HAS_TOOLS():
    """A prompt built from documentation is NOT INERT.

    A subprocess briefed with ASSET_FIDELITY.md and no tool restriction reads it
    as a work order and writes a builder into objects.js. This prompt hands over
    a file path, so it must be restricted the same way.
    """
    flags = refdesign.NO_TOOLS_BUT_READ
    assert flags[0] == "--allowedTools" and flags[1] == "Read", flags
    assert "--disallowedTools" in flags
    for denied in ("Bash", "Write", "Edit", "Task", "WebFetch", "WebSearch"):
        assert denied in flags, f"{denied} is not denied to the reading pass"
    assert "--allowedTools" in flags and "Bash" not in flags[:2]


def test_the_brief_asks_for_reasons_and_forbids_targets():
    b = refdesign.BRIEF
    assert "NEVER give a coordinate" in b
    assert "never a target" in b, "the brief does not say a principle is a reason"
    assert "say null" in b, "a guess in the reading becomes a fact downstream"


def test_principles_leads_with_the_owners_words_and_says_they_are_not_targets():
    """A number in a brief is a restriction wherever it is written down."""
    out = json.loads(run(["principles"]).stdout)
    assert "how_to_use" in out
    assert "not targets" in out["how_to_use"].lower() or "REASONS" in out["how_to_use"]
    assert "measured" in out["how_to_use"], \
        "nothing says to apply these to ground that has been measured"
    assert set(out) >= {"references", "principles", "not_transferable", "owner_said"}


def test_a_round_trip_keeps_the_owners_words_verbatim(tmp_path, monkeypatch):
    monkeypatch.setattr(refdesign, "OUT", str(tmp_path))
    monkeypatch.setattr(refdesign, "INDEX", str(tmp_path / "index.json"))
    monkeypatch.setattr(refdesign, "ROOT", str(tmp_path))
    p = image()
    note = "the way the grasses hold the light in October, and how much is left open"
    try:
        from types import SimpleNamespace
        assert refdesign.add(SimpleNamespace(
            image=p, note=note, name=None, credit=None, key="ref1", replace=False)) == 0
        idx = json.loads((tmp_path / "index.json").read_text())
        assert idx["ref1"]["note"] == note, "the owner's words were reworded"
        assert idx["ref1"]["source"] == "owner"
        # copied, not referenced
        assert not idx["ref1"]["file"].startswith("/")
        assert os.path.isfile(tmp_path / os.path.basename(idx["ref1"]["file"]))
    finally:
        os.unlink(p)
