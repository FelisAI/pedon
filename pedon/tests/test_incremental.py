"""An op that IMPROVES an existing problem must not be rejected for it.

execute() compares the new error list against a baseline to decide whether an op
made things worse. String equality on the whole message cannot do that, because
the messages carry measurements: adding a flight of steps across a too-steep walk,
which is precisely what the validator's own message tells the model to do, moves
"1.7 m of it is over the limit" to "0.5 m of it is over the limit", and by string
equality that is a NEW error — the op rejected for improving the thing it was
asked to improve.

The consequence is worse than one bad rejection: on any design that already
carries an error (16 of 28 saved designs, measured), ANY op that shifts a number
in an existing message would be unappliable, so the escape hatch could not be
used on the designs that need it.
"""
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import project  # noqa: E402  where the active site's files are
sys.path.insert(0, os.path.join(ROOT, "tools"))
import agent  # noqa: E402

# about a REAL site — skipped without the reference site (tests/conftest.py)
pytestmark = pytest.mark.needs_site


@pytest.fixture
def site():
    with open(project.data("site.json")) as f:
        return json.load(f)


STEEP = {"id": "walk_steep", "width_m": 1.1, "material": "flagstone",
         "spline": [[10.6, -11.2], [12, -10.4], [13, -8.6], [13.4, -6.6],
                    [14.2, -5], [14.9, -4.2]]}


def _with_steep_path(site):
    """A design that already fails, the way 16 of 28 saved designs do."""
    d = {"version": 1, "units": "meters", "beds": [], "paths": [STEEP],
         "patios": [], "edges": [], "plants": [], "steps": []}
    errs, _ = agent.validate(d, site)
    assert errs, "fixture is meant to start in an error state"
    return d, frozenset(errs)


def test_the_fixture_really_is_the_case_we_care_about(site):
    """Otherwise the test below could pass on a design with nothing wrong."""
    d, base = _with_steep_path(site)
    assert any("over the 20%" in e for e in base), base


def test_steps_across_the_steep_stretch_are_accepted(site):
    """The validator's own message says to do this. It must be possible."""
    d, base = _with_steep_path(site)
    out, msg = agent.execute(d, site, "set_steps",
                             {"id": "flight", "spline": [[10.6, -11.2], [12, -10.4]],
                              "width_m": 1.1, "material": "stone"}, base)
    assert out["steps"][0]["id"] == "flight"


def test_an_op_that_makes_it_WORSE_is_still_rejected(site):
    """Otherwise accepting the op above is just 'stop checking', which is not a fix."""
    d, base = _with_steep_path(site)
    with pytest.raises(ValueError):
        agent.execute(d, site, "set_path",
                      {"id": "walk_worse", "width_m": 1.1, "material": "flagstone",
                       "spline": [[9, -10], [17, -10]]}, base)   # 28.0%, measured


def test_a_brand_new_error_of_the_same_kind_is_still_rejected(site):
    """The key must identify the OBJECT, not just the rule — otherwise one
    pre-existing steep path would license every future steep path."""
    d, base = _with_steep_path(site)
    with pytest.raises(ValueError):
        agent.execute(d, site, "set_path",
                      {"id": "walk_second_offender", "width_m": 1.1,
                       "material": "flagstone",
                       "spline": [[10, -2], [16, -6]]}, base)    # 22.9%, a SECOND offender
