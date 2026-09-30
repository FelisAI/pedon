"""The library must not cap the design — for HARDSCAPE too, not just objects.

The asset library's limits must not limit the model: what the library lacks is found
or generated, never refused. `objects.kind` and `plants.species` are free text for that
reason, and the surfaces must be too. With closed lists for them:

    path material     brick, timber_boardwalk, pebble_mosaic, stone_sett  -> ALL REJECTED
    patio purpose     tea_ceremony, meditation, raked_gravel_court        -> ALL REJECTED
    object kind       "moon gate"                                         -> accepted
    bed mulch         "raked white granite"                               -> accepted

Which is backwards. Hardscape is most of what a garden is physically made of, and a
Japanese nobedan, a Chinese pebble-mosaic court, a brick path and a timber
boardwalk are not decoration — they ARE the style. A design agent that cannot
write any of them down turns a 'Mediterranean / Japanese / Chinese fusion' into
gravel and planting.

The renderer is not the blocker: design.js's groundSurface() and wallSurface()
both fall back to a named default with a console.warn. Only a closed schema
would forbid it.

So: free text, the modelled list kept as GUIDANCE, and an unmatched material
reported as a WANT — the same honest downgrade an unmodelled object kind gets,
rather than a rejection.
"""
import json
import os
import re
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import agent    # noqa: E402


@pytest.fixture(scope="module")
def site():
    with open(agent.SITE_PATH) as f:
        return json.load(f)


def design(**kw):
    d = {"version": 1, "units": "meters", "beds": [], "plants": [], "patios": [],
         "paths": [], "edges": [], "steps": [], "objects": []}
    d.update(kw)
    return d


def schema_errors(d, site):
    return [e for e in agent.validate(d, site)[0] if e.startswith("schema")]


REAL = {
    "brick": "a brick path is the most ordinary hardscape there is",
    "timber_boardwalk": "the right answer over a wet or root-filled stretch",
    "pebble_mosaic": "Chinese garden paving; the style IS the surface",
    "stone_sett": "a nobedan of cut and natural stone — Japanese garden paving",
}


@pytest.mark.needs_site
def test_a_path_may_be_made_of_something_the_library_has_not_modelled(site):
    bad = []
    for mat, why in REAL.items():
        d = design(paths=[{"id": "p", "spline": [[15, -6], [15, -3]],
                           "width_m": 1.2, "material": mat}])
        if schema_errors(d, site):
            bad.append(f"{mat} ({why})")
    assert not bad, "the schema forbids real hardscape:\n  " + "\n  ".join(bad)


@pytest.mark.needs_site
def test_a_patio_may_be_for_something_nobody_enumerated(site):
    for purpose in ("tea_ceremony", "meditation", "raked_gravel_court"):
        d = design(patios=[{"id": "t", "polygon": [[15, -6], [17, -6], [17, -4], [15, -4]],
                            "material": "gravel", "purpose": purpose, "level_m": -2.0}])
        assert not schema_errors(d, site), f"a patio may not be for {purpose}"


@pytest.mark.needs_site
def test_an_edge_may_be_built_of_something_new(site):
    d = design(edges=[{"id": "e", "spline": [[15, -6], [15, -3]],
                       "height_m": 0.4, "material": "gabion", "retains": "uphill"}])
    assert not schema_errors(d, site), "gabion is a real retaining system and is refused"


@pytest.mark.needs_site
def test_the_op_vocabulary_agrees_with_the_schema(site):
    """The model writes OPS, not files. A tool schema that still lists an enum is
    the same wall one layer up — and it is the layer the model actually reads, so
    opening only the on-disk schema would change nothing about what gets asked
    for."""
    props = (agent.OPS_SCHEMA["properties"]["ops"]["items"]
             ["properties"]["input"]["properties"])
    for field in ("material", "purpose", "edge_material"):
        assert field in props, f"{field} left the op vocabulary entirely"
        assert "enum" not in props[field], (
            f"input.{field} is a closed list in the schema the model reads: "
            f"{props[field].get('enum')}")
        assert "description" in props[field], (
            f"input.{field} is open and says nothing about what IS modelled — "
            f"free text without guidance is a worse tool, not a better one")
    # Closed on purpose, and it must stay closed: a direction is not a library.
    assert props["retains"]["enum"] == ["uphill", "downhill", "none"]
    ops = agent.OPS_SCHEMA["properties"]["ops"]["items"]["properties"]["tool"]
    assert "enum" in ops, "the op NAMES are the vocabulary and are not free text"


def test_what_is_actually_modelled_is_still_offered_as_guidance():
    """Free text must not mean "no help". The point is that the model can ask for
    anything AND knows what will render as itself."""
    assert len(agent.PATH_MATERIALS) >= 6
    assert "decomposed_granite" in agent.PATH_MATERIALS
    assert isinstance(agent.EDGE_SUITS, dict) and len(agent.EDGE_SUITS) >= 8


@pytest.mark.needs_site
def test_an_unmodelled_material_is_reported_not_hidden(site):
    """The one thing worse than a rejection is a silent substitution. A brick path
    that renders as decomposed granite and says nothing is the invisible downgrade
    objects.js exists to prevent."""
    d = design(paths=[{"id": "p", "spline": [[15, -6], [15, -3]],
                       "width_m": 1.2, "material": "pebble_mosaic"}])
    _, warnings = agent.validate(d, site)
    hit = [w for w in warnings if "pebble_mosaic" in w]
    assert hit, f"nothing tells anyone the material is not modelled: {warnings}"
    assert "not modelled" in hit[0] or "renders" in hit[0], hit[0]


def test_the_modelled_list_matches_what_the_renderer_can_actually_draw():
    """Same guard as tests/test_core_edges.py puts on the wall table: two lists of
    material names in two languages drift apart, and the only thing that keeps
    them together is a test that reads both."""
    src = open(os.path.join(ROOT, "viewer", "src", "design.js")).read()
    block = re.search(r"const GROUND_SURFACES = \{(.*?)\n\};", src, re.S)
    assert block, "GROUND_SURFACES moved; fix this parse rather than deleting the check"
    drawn = set(re.findall(r"^\s{2}(\w+):", block.group(1), re.M))
    missing = [m for m in agent.PATH_MATERIALS if m not in drawn]
    assert not missing, (
        f"agent.py offers {missing} as modelled path materials and design.js cannot "
        f"draw them — it knows {sorted(drawn)}")
