"""Drive every design op through agent.execute() + agent.validate().

Why this exists
---------------
An op nothing executes can fail every time without anyone noticing. Take
`set_patio`, the one op that reserves the scarce flat ground: a local named
`area` (the polygon's m2) inside its branch that shadows execute()'s `area`
RESTRICTION parameter makes the trailing `validate(d, site, area)` do
`area["polygon"]` on a float, so every set_patio op raises TypeError and is
silently dropped — while the design agent's answer still says "dining terrace
added".

Exercising the validator (site_api validate/check-ops) and the schema does not
reach the op layer between them. So: every tool in agent.OPS_SCHEMA, applied for
real, on the committed site.

The op list is read OUT of agent.OPS_SCHEMA rather than typed here, so adding a
seventh tool without a fixture fails this file instead of shipping untested.

Nothing here touches the viewer or the network — data/site.json and
data/terrain.json are read off disk, exactly as the validator reads them.
"""
from __future__ import annotations
import copy
import json
import os
import sys

import pytest

# conftest.py does this too. Repeated here deliberately: several people are
# adding files under tests/ at once, and a test that only runs when someone
# else's conftest survives is not a test.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))
import agent                                                    # noqa: E402


# ── fixtures ──────────────────────────────────────────────────────────────
# Coordinates sit in the front yard, west of the house: outside the measured
# footprint and on ground the scan actually covers. test_fixture_ground_is_real
# asserts both, so if site.json is re-derived and the house moves, the failure
# names the cause instead of surfacing as six unrelated rejections.
@pytest.fixture(scope="module")
def site():
    with open(agent.SITE_PATH) as f:
        return json.load(f)


def base_design():
    """A minimal design with one of everything, so remove_objects has a target."""
    return {
        "version": 1,
        "units": "meters",
        "beds": [{"id": "bed_seed",
                  "polygon": [[-17, -11], [-15, -11.4], [-13.5, -10], [-14, -8.5], [-16, -8]]}],
        "paths": [{"id": "path_seed", "spline": [[-17.5, -7], [-15, -6.6], [-12.5, -7]],
                   "width_m": 1.0, "material": "gravel"}],
        "plants": [{"id": "p1", "species": "Rosmarinus officinalis", "common": "rosemary",
                    "position": [-16, -4], "mature_spread_m": 1.0, "mature_height_m": 1.2}],
    }


# One op per tool in OPS_SCHEMA. None carries level_m: the cut/fill rules get
# their own test below, and mixing them in here would mean a terrain change
# breaks the "does the op apply at all" check.
OPS = {
    # A fixture has to be legal ground, not merely somewhere: a run such as
    # (-18,-3)->(-12.5,-5.2) measures 120.3% at its steepest on only 0.73 scan
    # coverage, which tests the grade rule and the scan edge, not the op.
    # This one is 15.9%: over walk_grade so it still exercises the WARNING path,
    # under max_grade so it applies, and on fully scanned ground.
    "set_path": {"id": "walk_test",
                 "spline": [[11.5, -2], [12.5, 2], [13, 6]],
                 "width_m": 1.2, "material": "flagstone"},
    # steps exist for the stretches a path may not take, so this one is
    # deliberately steeper than a walk is allowed to be
    # Deliberately a kind the LIBRARY CANNOT BUILD. place_object exists so a
    # missing model never vetoes a design — it renders as a marked placeholder and
    # becomes a want — so the fixture that exercises it should be exactly that
    # case. A fixture using a modelled kind would pass without touching the
    # guarantee the op is for.
    "place_object": {"id": "obj_test", "kind": "moon gate",
                     "position": [12.4, -3.0], "height_m": 2.2, "width_m": 1.6},
    # resync_palette likewise: omitting `species` means "every one that has
    # drifted from the catalogue", which is how it is actually called. Its own
    # behaviour — ids kept, scoping, refusals — is in tests/test_resync_palette.py;
    # this entry exists so the shared op tests (schema, idempotence, the
    # no-new-errors contract) run against it like every other tool.
    "resync_palette": {},
    # set_plants changes a plant already in planted_design(), keeping its id; its
    # own behaviour — the group survives, refusals — is in tests/test_set_plants.py.
    "set_plants": {"plants": [
        {"id": "q1", "species": "Salvia clevelandii", "common": "cleveland sage",
         "position": [12.4, -8.3], "mature_spread_m": 1.2, "mature_height_m": 1.2}]},
    "set_steps": {"id": "steps_test",
                  "spline": [[11, -12], [13, -4]],
                  "width_m": 1.0},
    "upsert_bed": {"id": "bed_test",
                   "polygon": [[-18, -9], [-16.6, -9.6], [-15, -9.4], [-13.8, -8.6],
                               [-14.2, -7.4], [-15.8, -6.9], [-17.4, -7.6]],
                   "mulch": "shredded_hardwood"},
    "set_patio": {"id": "terrace_test",
                  "polygon": [[-16.5, -12], [-13.5, -12], [-13.5, -9.6], [-16.5, -9.6]],
                  "material": "decomposed_granite", "purpose": "dining"},
    "set_edge": {"id": "wall_test", "spline": [[-16.5, -12], [-13.5, -12]],
                 "height_m": 0.4, "edge_material": "corten_steel", "retains": "downhill"},
    "place_plants": {"plants": [
        {"species": "Ceanothus 'Dark Star'", "common": "california lilac",
         "position": [-17.5, -2], "mature_spread_m": 1.8, "mature_height_m": 1.8},
        {"species": "Ceanothus 'Dark Star'", "common": "california lilac",
         "position": [-15.5, -1.6], "mature_spread_m": 1.8, "mature_height_m": 1.8},
        {"species": "Ceanothus 'Dark Star'", "common": "california lilac",
         "position": [-13.5, -2.2], "mature_spread_m": 1.8, "mature_height_m": 1.8}]},
    "remove_objects": {"ids": ["p1"]},
}

# Where the object each op creates ends up, so a test can assert it actually landed.
# Which array an op's object lands in. The transforms and remove_objects are absent
# on purpose: they change plants that are already there rather than adding anything.
LANDS_IN = {"set_path": "paths", "upsert_bed": "beds", "set_patio": "patios",
            "set_edge": "edges", "place_plants": "plants", "set_steps": "steps",
            "place_object": "objects"}


def schema_tools():
    """The tool names the model is actually offered — from agent.py, not retyped."""
    props = agent.OPS_SCHEMA["properties"]["ops"]["items"]["properties"]
    return set(props["tool"]["enum"])


def baseline(design, site):
    """Pre-existing errors, which execute() must not blame on the new op."""
    return frozenset(agent.validate(design, site)[0])


# ── the fixtures have to be real ground, or every test below is vacuous ───
@pytest.mark.needs_site
def test_fixture_ground_is_real(site):
    fp = site["footprint"]
    pts = [tuple(p) for op in OPS.values()
           for key in ("spline", "polygon")
           for p in op.get(key, [])]
    pts += [tuple(pl["position"]) for pl in OPS["place_plants"]["plants"]]
    for key in ("beds", "paths"):
        for o in base_design()[key]:
            pts += [tuple(p) for p in (o.get("polygon") or o.get("spline"))]
    assert pts
    inside = [p for p in pts if agent.point_in_poly(p, fp)]
    assert not inside, f"fixture points inside the house footprint: {inside}"
    unscanned = [p for p in pts if agent.ground_at(*p) is None]
    assert not unscanned, f"fixture points on unscanned ground: {unscanned}"


def test_every_schema_tool_has_a_fixture():
    assert schema_tools() == set(OPS), (
        "OPS_SCHEMA and this file disagree about which tools exist; "
        f"unfixtured={schema_tools() - set(OPS)} stale={set(OPS) - schema_tools()}")


def planted_design():
    """A design with plants already in it, for the ops that change what is there:
    a bed with TWO species, on fully scanned ground (coverage 1.0, verified) so the
    validator is judging measurement rather than interpolation."""
    return {
        "version": 1, "units": "meters", "paths": [], "patios": [], "edges": [], "steps": [],
        "beds": [{"id": "bed_planted",
                  "polygon": [[11.5, -9], [14.5, -9], [14.5, -6], [11.5, -6]]}],
        "plants": [
            {"id": "q1", "species": "Salvia clevelandii", "common": "cleveland sage",
             "position": [12.2, -8.4], "mature_spread_m": 1.2, "mature_height_m": 1.2},
            {"id": "q2", "species": "Westringia fruticosa", "common": "coast rosemary",
             "position": [13.0, -8.2], "mature_spread_m": 1.0, "mature_height_m": 1.0},
            {"id": "q3", "species": "Salvia clevelandii", "common": "cleveland sage",
             "position": [13.8, -8.5], "mature_spread_m": 1.2, "mature_height_m": 1.2},
            {"id": "q4", "species": "Westringia fruticosa", "common": "coast rosemary",
             "position": [12.4, -7.2], "mature_spread_m": 1.0, "mature_height_m": 1.0},
            {"id": "q5", "species": "Salvia clevelandii", "common": "cleveland sage",
             "position": [13.2, -7.0], "mature_spread_m": 1.2, "mature_height_m": 1.2},
            {"id": "q6", "species": "Westringia fruticosa", "common": "coast rosemary",
             "position": [13.9, -7.3], "mature_spread_m": 1.0, "mature_height_m": 1.0},
        ],
    }


# Ops that TRANSFORM what is already there rather than adding an object. They get
# a design with something to transform, and the "it landed in its array" assertion
# below does not apply to them.
# Ops that CHANGE the planting already in the design rather than adding a row:
# they are checked with `out != d` here and in depth in their own files
# (test_resync_palette.py, test_set_plants.py).
TRANSFORMS = {"resync_palette", "set_plants"}


def design_for(tool):
    return planted_design() if tool in TRANSFORMS else base_design()


# ── every op applies ──────────────────────────────────────────────────────
@pytest.mark.needs_site
@pytest.mark.parametrize("tool", sorted(OPS))
def test_op_applies(tool, site):
    """execute() must not raise, and must actually change the design."""
    d = design_for(tool)
    out, msg = agent.execute(d, site, tool, OPS[tool], baseline(d, site))
    assert msg
    key = LANDS_IN.get(tool)
    if tool in TRANSFORMS:
        # covered in depth by tests/test_agent_arrangement.py (20 tests);
        # here we only assert it ran and changed something
        assert out != d
    elif tool == "place_plants":
        # ids are assigned by execute(), not supplied — a model-supplied id would
        # override the unique one and could collide with an existing plant
        added = [p for p in out["plants"] if p["id"] not in {"p1"}]
        assert len(added) == len(OPS[tool]["plants"])
        assert len({p["id"] for p in out["plants"]}) == len(out["plants"])
    elif key:
        assert [o for o in out[key] if o["id"] == OPS[tool]["id"]]
        assert len(out[key]) == len(d.get(key, [])) + 1
    else:                                        # remove_objects
        assert not [p for p in out["plants"] if p["id"] == "p1"]


@pytest.mark.needs_site
@pytest.mark.parametrize("tool", sorted(OPS))
def test_op_output_matches_the_design_schema(tool, site):
    """Checked with jsonschema DIRECTLY, not through agent.validate(): validate()
    degrades to a warning when jsonschema is absent, so asking it would let a
    malformed op through on exactly the machine where it matters. The schema is
    additionalProperties:false, so this catches an op writing the wrong key name."""
    jsonschema = pytest.importorskip("jsonschema")
    d = design_for(tool)
    out, _ = agent.execute(d, site, tool, OPS[tool], baseline(d, site))
    with open(agent.SCHEMA_PATH) as f:
        jsonschema.validate(out, json.load(f))


@pytest.mark.needs_site
@pytest.mark.parametrize("tool", sorted(OPS))
def test_op_does_not_mutate_its_input(tool, site):
    """execute() deepcopies; agent.run() relies on that to drop a rejected op."""
    d = design_for(tool)
    before = copy.deepcopy(d)
    agent.execute(d, site, tool, OPS[tool], baseline(d, site))
    assert d == before


@pytest.mark.needs_site
def test_all_ops_apply_in_sequence(site):
    """The real apply loop: one design, every op in turn, mirroring agent.run()."""
    d = base_design()
    base = baseline(d, site)
    for tool in ("set_patio", "set_edge", "upsert_bed", "set_path", "set_steps",
                 "place_object", "place_plants", "remove_objects"):
        d, _ = agent.execute(d, site, tool, OPS[tool], base)
    assert [p["id"] for p in d["patios"]] == ["terrace_test"]
    assert [e["id"] for e in d["edges"]] == ["wall_test"]
    assert {b["id"] for b in d["beds"]} == {"bed_seed", "bed_test"}
    assert {p["id"] for p in d["paths"]} == {"path_seed", "walk_test"}
    assert len(d["plants"]) == 3                 # 1 seeded + 3 planted - 1 removed
    errors, _ = agent.validate(d, site)
    assert not [e for e in errors if e not in base]


# ── the set_patio / area shadowing ────────────────────────────────────────
@pytest.mark.needs_site
def test_set_patio_reports_the_polygon_area(site):
    """The m2 figure is what a shadowing local would compute. 3.0 x 2.4 = 7.2."""
    d = base_design()
    out, msg = agent.execute(d, site, "set_patio", OPS["set_patio"], baseline(d, site))
    assert "usable area terrace_test set (7 m2, dining)" == msg.split(" | ")[0]
    assert out["patios"][0]["material"] == "decomposed_granite"


@pytest.mark.needs_site
def test_set_patio_with_an_area_restriction(site):
    """THE regression. `area` here is the RESTRICTION dict execute() forwards to
    validate(); a shadowing local replaces it with a float, and this then raises
    TypeError: 'float' object is not subscriptable on every single call."""
    d = {"version": 1, "units": "meters", "beds": [], "paths": [], "plants": []}
    restriction = {"name": "test_area",
                   "polygon": [[-18, -13], [-12, -13], [-12, -8], [-18, -8]]}
    out, msg = agent.execute(d, site, "set_patio", OPS["set_patio"],
                             baseline(d, site), area=restriction)
    assert out["patios"][0]["id"] == "terrace_test"
    assert "usable area" in msg


def fixture_bounds(pad=3.0):
    """A box containing every fixture coordinate, so a restriction can permit them all.

    Both sources: OPS for the object-creating ops, and planted_design() for the
    transforms, which operate on plants that OPS never mentions. Missing the
    second makes a transform fail for having nothing to change — the restriction
    excludes the only bed it has."""
    xs, ys = [], []
    def walk(v):
        if (isinstance(v, (list, tuple)) and len(v) == 2
                and all(isinstance(c, (int, float)) for c in v)):
            xs.append(v[0]); ys.append(v[1]); return
        if isinstance(v, dict): [walk(x) for x in v.values()]
        elif isinstance(v, (list, tuple)): [walk(x) for x in v]
    walk(OPS)
    walk(planted_design())     # the transforms work on THIS, not on OPS coordinates
    x0, x1 = min(xs) - pad, max(xs) + pad
    y0, y1 = min(ys) - pad, max(ys) + pad
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]


@pytest.mark.needs_site
@pytest.mark.parametrize("tool", sorted(OPS))
def test_every_op_accepts_an_area_restriction(tool, site):
    """No op may confuse the restriction for one of its own locals."""
    if tool in TRANSFORMS:
        # a transform needs something to transform; an empty design would fail
        # for having nothing to change and this test would be reporting that instead
        # of whether the restriction was confused for a local
        d = design_for(tool)
    else:
        d = {"version": 1, "units": "meters", "beds": [], "paths": [], "plants": [],
             "patios": [], "edges": []}
        d["plants"].append(base_design()["plants"][0])      # so remove_objects has a target
    # DERIVED from the fixtures, not typed: a hand-drawn box silently stops
    # containing them the moment a fixture moves, and then this test fails for a
    # reason that has nothing to do with what it is testing. That the restriction
    # really bites is proven by the next test, not by this box being tight.
    restriction = {"name": "test_area", "polygon": fixture_bounds()}
    out, _ = agent.execute(d, site, tool, OPS[tool], baseline(d, site), area=restriction)
    assert out != d                              # the op really ran, restriction and all


@pytest.mark.needs_site
def test_area_restriction_actually_rejects_work_outside_it(site):
    """Otherwise the test above passes because the restriction is inert."""
    d = {"version": 1, "units": "meters", "beds": [], "paths": [], "plants": []}
    elsewhere = {"name": "elsewhere",
                 "polygon": [[10, -14], [18, -14], [18, -8], [10, -8]]}
    with pytest.raises(ValueError, match="outside the area"):
        agent.execute(d, site, "set_patio", OPS["set_patio"], baseline(d, site),
                      area=elsewhere)


# ── level_m: the cut/fill branch every op with a bench goes through ───────
@pytest.mark.needs_site
def test_set_patio_with_a_buildable_level_applies(site):
    """Level read off the ground the validator itself reads, so this tracks the
    terrain instead of hard-coding an elevation that a re-scan invalidates."""
    poly = OPS["set_patio"]["polygon"]
    gs = [g for g in (agent.ground_at(x, y) for x, y in agent._walk_polygon(poly))
          if g is not None]
    level = round((min(gs) + max(gs)) / 2, 2)
    d = base_design()
    inp = dict(OPS["set_patio"], level_m=level)
    out, msg = agent.execute(d, site, "set_patio", inp, baseline(d, site))
    assert out["patios"][0]["level_m"] == level
    assert f"level {level} m" in msg


@pytest.mark.needs_site
def test_an_unbuildable_level_is_rejected(site):
    """The cut/fill bound has to bite, or the test above proves nothing."""
    d = base_design()
    inp = dict(OPS["set_patio"], level_m=agent.ground_at(-15, -11) + 5.0)
    with pytest.raises(ValueError, match="cut|fill"):
        agent.execute(d, site, "set_patio", inp, baseline(d, site))


# ── contract edges ────────────────────────────────────────────────────────
@pytest.mark.needs_site
def test_unknown_tool_raises(site):
    with pytest.raises(ValueError, match="unknown tool"):
        agent.execute(base_design(), site, "set_pergola", {}, frozenset())


@pytest.mark.parametrize("tool,missing", [
    ("set_path", "spline"), ("upsert_bed", "polygon"), ("set_patio", "polygon"),
    ("set_edge", "height_m"), ("remove_objects", "ids"), ("place_plants", "plants"),
])
@pytest.mark.needs_site
def test_missing_required_input_raises(tool, missing, site):
    inp = {k: v for k, v in OPS[tool].items() if k != missing}
    with pytest.raises(ValueError, match=missing):
        agent.execute(base_design(), site, tool, inp, frozenset())


@pytest.mark.needs_site
def test_house_footprint_is_still_enforced(site):
    """The other thing execute() delegates to validate(). A patio on the house."""
    fp = site["footprint"]
    cx = sum(p[0] for p in fp) / len(fp)
    cy = sum(p[1] for p in fp) / len(fp)
    inp = {"id": "on_the_house",
           "polygon": [[cx - 1, cy - 1], [cx + 1, cy - 1], [cx + 1, cy + 1], [cx - 1, cy + 1]]}
    with pytest.raises(ValueError, match="house footprint"):
        agent.execute(base_design(), site, "set_patio", inp, frozenset())
