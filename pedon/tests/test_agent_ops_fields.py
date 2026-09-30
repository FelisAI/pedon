"""The model has to be OFFERED the fields the renderer already reads.

Why this file exists
--------------------
Three of the four links in this chain accept the fields on their own:

  design schema  schema/design.schema.json accepts `form` and `foliage` on a
                 plant (its plant object is `additionalProperties: false`, so
                 that acceptance is deliberate).
  renderer       viewer/src/plants.js reads both — `growthForm()` falls to the
                 declared habit, `foliageRamp()` displaces the form's colour ramp.
  execute()      agent.execute's place_plants branch writes `{**pl, "id": pid}`,
                 so anything on the record survives into the design.

The fourth link is the one the model actually sees: `agent.OPS_SCHEMA` is what
`--json-schema` hands the CLI. A field the model is never told about is a field
the model never writes, so without it the renderer's colour layer is reachable
only by hand-editing JSON.

What that costs, re-derived here rather than quoted (node, against the real
files — see the docstring of tests/js/plants_schema.test.mjs for the same
figures from the JS side):

    growthForm() over data/design.json's 58 plants -> mound 28 (48.3%),
    mat 15, grass 15. The `mound` ramp is #5c7a52 -> #6b8a5e = 25.0 RGB units,
    5.7% of the 441.7 cube diagonal, and it carries Heteromeles, Salvia,
    Lavandula, Eriogonum, Westringia and Olea — six species, one colour.

So this is a colour vocabulary the yard needs and the model cannot spell.

What is asserted, and what is NOT
---------------------------------
`OPS_SCHEMA`'s plant object has no `additionalProperties: false`, so jsonschema
would ALREADY have accepted a plant carrying form/foliage. A test that only
validates such a plant against the schema is therefore green with the bug in
place, and is marked below as the well-formedness check it really is. The
assertions that can only pass once the fields are declared are the ones about
the schema's own PROPERTIES, the JSON the CLI is handed, and the prompt.

    python3 -m pytest tests/test_agent_ops_fields.py -q
"""
import json
import os

import pytest

import agent

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import project  # noqa: E402  where the active site's files are
NEW = ("form", "foliage", "flower")
# the five core plant fields; form/foliage are additive to exactly these
SHIPPED = ("species", "common", "position", "mature_spread_m", "mature_height_m")
# which plant a set_plants entry changes; place_plants ignores it and mints one,
# so it is declared but never required
IDENTIFIES = ("id",)
# a plant MODEL to draw it with, from the plant library; optional like NEW, but a
# name the library must have — execute() refuses one it does not
MODEL = ("asset",)
SIZE = ("size_override",)


def ops_plant(schema=None):
    """The plant object inside place_plants' input, from the live OPS_SCHEMA."""
    schema = schema if schema is not None else agent.OPS_SCHEMA
    return (schema["properties"]["ops"]["items"]["properties"]["input"]
            ["properties"]["plants"]["items"])


def design_plant():
    """The plant object in schema/design.schema.json — the downstream gate."""
    with open(agent.SCHEMA_PATH) as f:
        return json.load(f)["properties"]["plants"]["items"]


@pytest.fixture(scope="module")
def site():
    with open(project.data("site.json")) as f:
        return json.load(f)


def a_plant(**extra):
    p = {"species": "Salvia clevelandii", "common": "Cleveland sage",
         "position": [0.0, 0.0], "mature_height_m": 1.2, "mature_spread_m": 1.2}
    p.update(extra)
    return p


@pytest.fixture(scope="module")
def free_ground(site):
    """A position agent.execute() accepts, SEARCHED for rather than guessed.

    [0, 0] is the origin near the house and lands inside the footprint — the
    validator rejects it — so a hardcoded coordinate here would make every
    execute() assertion below fail for a reason that has nothing to do with
    foliage. Scanning is also what keeps this file alive if the scan is
    re-registered.
    """
    empty = {"version": 1, "units": "meters", "beds": [], "paths": [], "plants": []}
    for x in range(-20, 21, 2):
        for y in range(-20, 21, 2):
            try:
                agent.execute(empty, site, "place_plants",
                              {"plants": [a_plant(position=[float(x), float(y)])]})
            except Exception:
                continue
            return [float(x), float(y)]
    pytest.fail("no position in the searched grid validates; every test below "
                "would be asserting about a rejected op")


# ------------------------------------------------------------------ the schema
def test_the_ops_schema_declares_the_fields_the_renderer_reads():
    """Presence and COUNT, not just presence: the five shipped fields must still
    be there. A rename that dropped `common` while adding `foliage` would pass a
    bare `"foliage" in props` check."""
    props = ops_plant()["properties"]
    for f in SHIPPED:
        assert f in props, f"the ops schema lost {f}; this is not an additive change"
    assert len(props) == len(SHIPPED) + len(NEW) + len(IDENTIFIES) + len(MODEL) + len(SIZE), (
        f"the ops plant object has {len(props)} fields {sorted(props)}, "
        f"expected the {len(SHIPPED)} shipped plus {list(NEW)}, {list(IDENTIFIES)}, {list(MODEL)} and {list(SIZE)}")
    missing = [f for f in NEW if f not in props]
    assert missing == [], (
        f"place_plants cannot emit {missing}: the design schema accepts them and "
        "viewer/src/plants.js reads them, but the model is never told they exist")


def test_the_new_fields_are_optional():
    """A schema change that alters existing designs is a migration, not a
    feature — and `required` is where that would happen first: the model would
    be forced to invent a colour for every plant."""
    required = ops_plant().get("required", [])
    assert sorted(required) == sorted(SHIPPED), (
        f"required is {sorted(required)}; the five shipped fields and nothing else")


def test_each_new_field_is_a_string_with_a_description():
    """The description IS the prompt — `--json-schema` is the only place the
    model is told what a field means — so an undescribed field is a field it
    will not use."""
    props = ops_plant()["properties"]
    for f in NEW:
        assert props[f].get("type") == "string", f"{f} is not a free-text string"
        desc = props[f].get("description", "")
        assert len(desc) > 60, f"{f} has no usable description: {desc!r}"


def test_the_ops_and_design_schemas_tell_the_model_the_same_vocabulary():
    """One home for the vocabulary, because there are two schemas and only one
    renderer. The nine growth forms and nine foliage words live in
    schema/design.schema.json (where tests/js/plants_schema.test.mjs already
    holds them against viewer/src/assets.js PLANT_FORMS and plants.js
    FOLIAGE_WORDS); the ops schema must quote that text, not a second copy of
    it that can drift a word at a time."""
    ops, design = ops_plant()["properties"], design_plant()["properties"]
    for f in NEW:
        theirs = design[f]["description"]
        assert len(theirs) > 100, f"the design schema's {f} description shrank; re-derive"
        assert theirs in ops[f]["description"], (
            f"the ops schema's {f} description is a second copy, not the design "
            f"schema's own words:\n  ops:    {ops[f]['description'][:120]}\n"
            f"  design: {theirs[:120]}")


def test_every_field_the_ops_schema_offers_is_one_the_design_schema_accepts():
    """The gate the whole feature turns on: the design plant object is
    `additionalProperties: false`, so an ops field it has never heard of is not
    ignored — agent.validate() rejects the WHOLE design the moment the model
    writes it. This is the invariant that makes offering a field safe."""
    offered = set(ops_plant()["properties"])
    accepted = design_plant()
    assert accepted.get("additionalProperties") is False, (
        "the design plant object is open; this test guards nothing")
    assert len(offered) >= len(SHIPPED) + len(NEW), (
        f"only {len(offered)} fields offered — the new ones are not there yet, "
        "so this check would pass over the old five and prove nothing")
    unknown = sorted(offered - set(accepted["properties"]))
    assert unknown == [], (
        f"the ops schema offers {unknown}, which agent.validate() would reject")


def test_the_json_the_cli_is_handed_carries_them():
    """OPS_SCHEMA is a dict; what the model sees is ops_schema_json(), after
    with_limits() has substituted this site's numbers into every description.
    Parse it back rather than trusting the dict — a description containing an
    unbalanced brace or a stray <token> would break here and nowhere else."""
    text = agent.ops_schema_json(agent.constraints(None))
    props = ops_plant(json.loads(text))["properties"]
    assert set(props) == set(SHIPPED) | set(NEW) | set(IDENTIFIES) | set(MODEL) | set(SIZE)
    assert "<" not in json.dumps({f: props[f] for f in NEW}), \
        "an unsubstituted <token> is being handed to the model as documentation"


def test_a_plants_op_declaring_them_still_validates():
    """Well-formedness only, and deliberately labelled as such: the ops plant
    object has no `additionalProperties: false`, so jsonschema would accept this
    payload even with the fields undeclared. It is here to catch a malformed
    edit to the schema, not to prove the feature."""
    jsonschema = pytest.importorskip("jsonschema")
    payload = {"ops": [{"tool": "place_plants",
                        "input": {"plants": [a_plant(form="mounding subshrub",
                                                     foliage="silver")]}}],
               "summary": "s", "confidence": "high", "cautions": "c"}
    jsonschema.validate(payload, json.loads(agent.ops_schema_json(agent.constraints(None))))


# ----------------------------------------------------------------- the wiring
@pytest.mark.needs_site
def test_execute_carries_a_declared_colour_into_the_design(site, free_ground):
    """End to end on the half that ships: the model writes it, execute() stores
    it, validate() accepts it. Without the last of those, offering the field
    would hand the model a way to get its whole design rejected."""
    empty = {"version": 1, "units": "meters", "beds": [], "paths": [], "plants": []}
    out, _msg = agent.execute(empty, site, "place_plants", {"plants": [
        a_plant(position=free_ground, form="mounding subshrub", foliage="silver")]})
    assert len(out["plants"]) == 1, "the op placed nothing; nothing below is tested"
    p = out["plants"][0]
    assert (p.get("form"), p.get("foliage")) == ("mounding subshrub", "silver"), \
        f"execute() dropped the declared fields: {p}"
    errors, _warnings = agent.validate(out, site)
    assert [e for e in errors if e.startswith("schema:")] == [], \
        f"the design carrying the fields does not validate: {errors}"


@pytest.mark.needs_site
def test_a_plant_that_declares_nothing_is_untouched(site, free_ground):
    """The migration guarantee on this side of the wire. Offering a field must
    not make execute() invent one — a defaulted `foliage` would repaint every
    plant in every design generated from now on, silently."""
    empty = {"version": 1, "units": "meters", "beds": [], "paths": [], "plants": []}
    plain = a_plant(position=free_ground)
    out, _msg = agent.execute(empty, site, "place_plants", {"plants": [plain]})
    assert len(out["plants"]) == 1
    got = out["plants"][0]
    assert set(got) == set(plain) | {"id"}, (
        f"place_plants added {sorted(set(got) - set(plain) - {'id'})} to a plant "
        "that declared nothing")


# ------------------------------------------------------------------ the prompt
def test_the_prompt_gives_the_fields_a_SHAPE_not_only_prose():
    """The tool list is where the model reads an op's signature, and shape beats
    prose. A bare `place_plants {plants:[...]}` says nothing about a plant's
    fields at all, so the ellipsis would be the whole documentation."""
    bullets = agent.SYSTEM.split("\n- ")
    assert len(bullets) >= 10, (
        f"SYSTEM parsed into {len(bullets)} bullets; the Rules list moved and "
        "this test is measuring the wrong thing")
    tools = [b for b in bullets if b.startswith("Tools:")]
    assert len(tools) == 1, f"{len(tools)} bullets open with 'Tools:'; expected one"
    sig = tools[0]
    for f in SHIPPED + NEW:
        assert f in sig, f"the place_plants signature does not name {f}"
    for f in NEW:
        assert f"{f}?" in sig, f"{f} is not marked optional in the signature"


def test_the_prompt_says_when_to_use_them():
    """The affordance has to be reachable from the brief as well as the schema.
    Asserted structurally — a Rules bullet that is NOT the tool list, naming
    both fields — because "somewhere in 5 kB of prose" is a claim a bare `in`
    check cannot make."""
    bullets = agent.SYSTEM.split("\n- ")
    naming = [b for b in bullets
              if not b.startswith("Tools:") and "foliage" in b and "form" in b.lower()]
    assert len(naming) == 1, (
        f"{len(naming)} rules bullets besides the tool list name both `form` and "
        "`foliage`; expected exactly one that says when to declare them")
    rule = naming[0]
    assert "place_plants" in rule, \
        "the rule never says which op the fields go on"
    assert "optional" in rule.lower() or "omit" in rule.lower(), \
        "the rule does not say the fields may be left out"
