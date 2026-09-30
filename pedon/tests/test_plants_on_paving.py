"""A plant whose CENTRE stands on the paving.

A bed outline built by offsetting a walk at exactly its own half-width -- to
close a strip of bare scan beside the paving -- also makes the bed polygon
CONTAIN the walk: nearly every sample of the walk's own centreline falls inside
the bed.

Filling that polygon then plants the path, and "inside the bed outline" cannot
stand in for "on soil": in such a design they are different questions. So
validate() reports a plant whose centre stands on paving.

A WARNING and not a rejection: a thyme between stepping stones is a real
planting, and `paths` covers stone runs as well as walks. The CANOPY may overhang
the paving as much as it likes -- the owner wants that overhang -- so only the
centre is tested.
"""
import pytest
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import agent
import project  # noqa: E402  where the active site's files are

# about a REAL site — skipped without the reference site (tests/conftest.py)
pytestmark = pytest.mark.needs_site


def _site():
    with open(project.data("site.json")) as f:
        return json.load(f)


# a straight 1.0 m walk along y = -5, and a bed that SWALLOWS it, which is the
# shape the real design has rather than a contrived one
WALK = [[12.0, -5.0], [16.0, -5.0]]
BED = [[12.0, -7.0], [16.0, -7.0], [16.0, -3.0], [12.0, -3.0]]


def _design(*positions):
    return {
        "version": 1, "units": "meters", "patios": [], "edges": [],
        "steps": [], "objects": [],
        "paths": [{"id": "walk", "spline": WALK, "width_m": 1.0,
                   "material": "decomposed_granite"}],
        "beds": [{"id": "b1", "polygon": BED, "mulch": "bark"}],
        "plants": [{"id": f"p{i}", "species": "Thymus vulgaris", "position": list(pos),
                    "mature_height_m": 0.3, "mature_spread_m": 0.6}
                   for i, pos in enumerate(positions)],
    }


def test_a_plant_standing_on_the_paving_is_reported():
    # p0 is 4 cm off the centreline of a 1.0 m walk: squarely on the surface
    errors, warnings = agent.validate(_design([14.0, -4.96]), _site())
    hit = [w for w in warnings if "stand ON path" in w]
    assert hit, "a plant planted in the middle of a path goes unmentioned"
    assert "walk" in hit[0], "the warning does not name which path"
    assert "p0" in hit[0], "the warning does not name which plant"


def test_the_test_is_the_CENTRE_and_never_the_canopy():
    # 0.6 m from the centreline of a 1.0 m walk: the centre is 0.1 m clear of the
    # paving edge while a 0.6 m canopy reaches 0.2 m across it. A canopy
    # softening the paving edge is a deliberate style the owner wants, so a
    # warning here would fire on the thing they asked for.
    errors, warnings = agent.validate(_design([14.0, -4.4]), _site())
    assert not [w for w in warnings if "stand ON path" in w]


def test_it_is_a_WARNING_and_never_blocks():
    # a thyme set between stepping stones is a legitimate planting.
    errors, warnings = agent.validate(_design([14.0, -5.0]), _site())
    assert not [e for e in errors if "stand ON path" in e], \
        "the paving check became a hard rejection"


def test_a_plant_out_in_the_bed_is_silent():
    # the complement. A warning that fires on a correct design is noise, and
    # noise is how the real one stops being read.
    errors, warnings = agent.validate(_design([14.0, -3.5], [13.0, -6.5]), _site())
    assert not [w for w in warnings if "stand ON path" in w]


def test_every_path_in_the_corpus_carries_a_width():
    # `half <= 0` is guarded rather than asserted, but the guard is defensive and
    # not a supported state: schema/design.schema.json REQUIRES width_m on a path.
    # Checking that here keeps the guard honest — if a widthless path ever became
    # legal, validate() would raise KeyError one line later (agent.py, the
    # `0.5 <= p["width_m"] <= 3.0` range check) rather than report anything.
    import glob
    seen = 0
    for f in glob.glob(project.data("designs", "*.json")):
        with open(f) as fh:
            try:
                d = json.load(fh)
            except json.JSONDecodeError:
                continue
        for pa in d.get("paths") or []:
            assert "width_m" in pa, f"{os.path.basename(f)}: path {pa.get('id')} has no width"
            seen += 1
    assert seen > 20, f"only {seen} paths checked — the corpus was not read"
