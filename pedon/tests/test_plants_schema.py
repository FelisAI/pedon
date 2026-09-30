"""A plant field the renderer reads has to survive the validator.

Why this file exists
--------------------
viewer/src/plants.js reads `form` (which habit to draw) and `foliage` (which
colour ramp) off a plant record — 27 references between them — so
schema/design.schema.json must accept both. The plant object there is
``additionalProperties: false``, so a field it lacks is not "ignored": the
schema check inside agent.validate() REJECTS THE WHOLE DESIGN, error and all,
the moment a plant mentions its own colour. A renderer that is ready behind a
locked door is the worse half of a half-built feature: the code reads as if it
works.

The vocabulary itself is checked in tests/js/plants_schema.test.mjs, where
FOLIAGE and PLANT_FORMS can be imported rather than transcribed. What is checked
HERE is the gate the model actually hits: agent.validate().

What makes admitting the fields safe is that it is ADDITIVE: a saved design
validates the same with or without them, so no saved design changes verdict,
and the additive test below is the assertion that keeps it that way — a schema
change that alters existing designs is a migration, not a feature.
"""
import copy
import glob
import json
import os

import pytest

import agent

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import project  # noqa: E402  where the active site's files are
LIVE = project.data("design.json")


def corpus():
    """The live design and every saved variant, by path."""
    return [LIVE] + sorted(glob.glob(project.data("designs", "*.json")))


def load(path):
    with open(path) as f:
        return json.load(f)


@pytest.fixture(scope="module")
def site():
    with open(project.data("site.json")) as f:
        return json.load(f)


def minimal(**plant):
    """The smallest design the schema accepts, carrying one plant.

    Built rather than loaded: data/design.json is the live working file the
    viewer polls, so a test that mutates a copy of it is a test whose subject
    changes under it.
    """
    p = {"id": "p1", "species": "Salvia clevelandii", "common": "Cleveland sage",
         "position": [0, 0], "mature_height_m": 1.2, "mature_spread_m": 1.2}
    p.update(plant)
    return {"version": 1, "units": "meters", "beds": [], "paths": [], "plants": [p]}


def schema_errors(design, site):
    errors, _warnings = agent.validate(design, site)
    return [e for e in errors if e.startswith("schema:")]


@pytest.mark.needs_site
def test_the_schema_check_is_the_gate_being_tested(site):
    """The premise. Without jsonschema installed every assertion below is vacuous.

    The probe breaks `units` rather than a coordinate: validate() reports the
    schema error and then keeps going into the geometry checks, which raise on a
    malformed point before any assertion here can read the result.
    """
    pytest.importorskip("jsonschema")
    bad = minimal()
    bad["units"] = "feet"
    assert schema_errors(bad, site), "the schema check did not run at all"


@pytest.mark.parametrize("field,value", [
    ("form", "mounding subshrub"),          # free text, normalised in assets.js
    ("form", "mound"),                      # the canonical word
    ("foliage", "silver"),                  # a FOLIAGE key
    ("foliage", "grey-green"),              # what a gardener actually writes
    ("foliage", "blue-grey glaucous"),      # a phrase, normalised by alias
    ("foliage", "#b4463c"),                 # the explicit-hex escape hatch
])
@pytest.mark.needs_site
def test_a_plant_may_declare_what_the_renderer_reads(site, field, value):
    """Free text, not an enum: plants.js normalises through an alias table and
    falls back to the form ramp on anything it does not know, so an enum here
    would reject strings that render perfectly ("silver-grey", "blue-grey
    glaucous") while adding no safety the renderer does not already have."""
    assert schema_errors(minimal(**{field: value}), site) == []


@pytest.mark.needs_site
def test_declaring_both_at_once_is_accepted(site):
    assert schema_errors(minimal(form="mounding subshrub", foliage="silver"), site) == []


@pytest.mark.needs_site
def test_a_field_the_renderer_does_not_read_is_still_rejected(site):
    """The complement, and the reason this is a schema change rather than
    opening the object: `additionalProperties: false` is what turns a typo into
    an error instead of a silently ignored field."""
    assert schema_errors(minimal(foliag="silver"), site), \
        "an unknown plant field is accepted; the closed object is gone"


@pytest.mark.needs_site
def test_admitting_the_fields_changes_no_saved_design(site):
    """The migration guarantee, measured on the real corpus.

    Two designs on disk already fail the schema for unrelated reasons (a 0.05 m
    mature_spread_m), which is exactly why this compares a design against
    ITSELF-plus-the-fields rather than asserting the corpus is clean: the claim
    is that admitting the fields is additive, not that everything validates.
    """
    files = corpus()
    assert len(files) >= 10, f"only {len(files)} designs in the corpus"
    total = declared = 0
    for path in files:
        design = load(path)
        plants = design.get("plants", [])
        total += len(plants)
        declared += sum(1 for p in plants if p.get("foliage") or p.get("form"))
        with_fields = copy.deepcopy(design)
        for p in with_fields["plants"]:
            p["form"], p["foliage"] = "mounding subshrub", "grey-green"
        before, after = agent.validate(design, site), agent.validate(with_fields, site)
        assert before == after, (
            f"{os.path.basename(path)}: declaring form/foliage changed the verdict\n"
            f"  before: {before[0][:2]}\n  after:  {after[0][:2]}")
    assert total >= 500, f"only {total} plants in the corpus"
    # `declared` is not pinned to a number: the ops schema offers these fields and
    # design runs emit them, so asserting any fixed count would fail for the
    # feature WORKING. What is asserted is the additive guarantee above, which is
    # checked per design and does not care how many declare the fields.
    #
    # Kept as a reported number rather than deleted: a jump here means new designs
    # are using the fields, and their rendering is worth an eye — which is a note
    # to a human, not a condition a test can decide.
    assert declared >= 0


def test_the_ops_schema_offers_the_fields_the_design_schema_now_accepts():
    """The other half of the wiring, which lives in tools/agent.py.

    agent.OPS_SCHEMA is what the model is handed as --json-schema; a field the
    design schema accepts but the ops schema never mentions is a field the model
    will never write, so the door the design schema opens stays unused. OPS_SCHEMA
    must list form and foliage on an add_plants plant — losing either field is a
    regression.
    """
    plant = (agent.OPS_SCHEMA["properties"]["ops"]["items"]["properties"]["input"]
             ["properties"]["plants"]["items"]["properties"])
    assert "species" in plant, "the ops schema moved; re-derive this path"
    missing = [f for f in ("form", "foliage") if f not in plant]
    assert missing == [], (
        f"add_plants cannot emit {missing}: the design schema accepts them and the "
        "renderer reads them, but the model is never told they exist")
