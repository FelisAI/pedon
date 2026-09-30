"""Grouping must not make a design schema-invalid.

The viewer's grouping feature persists a top-level `groups` key into
data/design.json. schema/design.schema.json sets "additionalProperties": false,
so the first time the owner folds two objects into a group, their design stops
validating — and validate() is what every op is judged against, so from then on
every op carries a pre-existing schema error into its baseline.

This is a common shape of bug: a feature that works, a persistence format
nobody checked, and the damage landing on disk.
"""
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import project  # noqa: E402  where the active site's files are
sys.path.insert(0, os.path.join(ROOT, "tools"))
import agent  # noqa: E402


@pytest.fixture
def site():
    with open(project.data("site.json")) as f:
        return json.load(f)


# The shape the VIEWER actually writes, not one assumed from reading saveGroups'
# name. A schema written to match an assumed shape (say {"ids": [...]}) passes a
# test built on the same assumption while every real group fails validation. A
# fixture invented alongside the thing it tests checks nothing.
GROUPS = [{"id": "grp_test", "name": "the fire pit and its walls",
           "members": ["firepit_terrace", "wall_firepit_uphill", "wall_firepit_downhill"]}]


def _live():
    with open(project.data("design.json")) as f:
        return json.load(f)


def test_the_schema_declares_groups():
    with open(os.path.join(ROOT, "schema", "design.schema.json")) as f:
        schema = json.load(f)
    assert schema.get("additionalProperties") is False, (
        "this test exists because the schema is closed; if it were open there "
        "would be nothing to check")
    assert "groups" in schema["properties"], "the viewer writes `groups`; the schema must know it"
    req = schema["properties"]["groups"]["items"]["required"]
    assert "members" in req, (
        f"the schema requires {req}, but saveGroups writes `members` — check the "
        f"code, not your memory of it")


@pytest.mark.needs_site
def test_grouping_adds_no_validation_error(site):
    """The live design, plus a group, must be no worse than the live design."""
    d = _live()
    before = agent.validate(d, site)[0]
    after = agent.validate({**d, "groups": GROUPS}, site)[0]
    new = [e for e in after if e not in before]
    assert not new, f"grouping introduced {len(new)} error(s): {new}"


@pytest.mark.needs_site
def test_a_malformed_group_is_still_caught(site):
    """Otherwise the fix is 'stop checking', which is not a fix."""
    d = _live()
    before = set(agent.validate(d, site)[0])
    bad = agent.validate({**d, "groups": [{"name": "no id, no ids"}]}, site)[0]
    assert [e for e in bad if e not in before], (
        "a group missing its required fields should still fail the schema")


def test_the_fixture_matches_what_the_viewer_writes():
    """Read the key out of main.js rather than trusting this file.

    Without it, schema, fixture and test can all agree with each other and
    disagree with the program.
    """
    with open(os.path.join(ROOT, "viewer", "src", "main.js")) as f:
        src = f.read()
    # Anchored on the function that BUILDS the object, not on the first mention
    # of saveGroups: "saveGroups" can appear first inside a doc comment, and a
    # +/-2000 char window around a comment proves nothing about what is written
    # — the failure would be this test's aim, not the program.
    i = src.index("async function groupSelection")
    window = src[i:i + 1200]
    assert "members:" in window, (
        "groupSelection no longer writes `members` — this fixture and the schema "
        "are now guessing again")
    assert set(GROUPS[0]) <= {"id", "name", "members", "locked", "hidden"}


@pytest.mark.needs_site
def test_a_real_group_on_disk_validates(site):
    """If the live design has been grouped, that exact object must validate."""
    d = _live()
    if not d.get("groups"):
        pytest.skip("nothing grouped in the live design right now")
    errs = [e for e in agent.validate(d, site)[0] if e.startswith("schema")]
    assert not errs, f"the group the viewer actually wrote fails the schema: {errs}"
