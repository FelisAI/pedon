"""An edit reports what IT caused, not every warning in the garden.

execute() filters ERRORS against a baseline -- so an op is never blamed for a
fault it did not cause -- and it must do the same for warnings, or every hand edit
comes back carrying every warning in the design. Measured on a real garden without
it, dragging one corten edge returns a 10,576-character result with 132 warnings
about plants nowhere near the edge, and the viewer logs the result verbatim.

Success that prints a wall of unrelated complaints is indistinguishable from
failure: the user reads it as a hard rule blocking the edit and asks for the rules
to be disabled. Disabling them would be the wrong fix to a real complaint.
"""
import pytest
import copy
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))
import agent
import project  # noqa: E402  where the active site's files are


def _site():
    with open(project.data("site.json")) as f:
        return json.load(f)


def _thyme(pid, x, y):
    return {"id": pid, "species": "Thymus vulgaris", "position": [x, y],
            "mature_height_m": 0.3, "mature_spread_m": 0.6}


def _crowded():
    """A design that already carries a warning, before we touch it: a 1 m2 bed with twelve
    thymes, crowded at full maturity. (Which warning it is does not matter; the behaviour
    under test is what an edit recites.)"""
    return {
        "version": 1, "units": "meters", "paths": [], "patios": [],
        "edges": [], "steps": [], "objects": [],
        "beds": [{"id": "b", "polygon": [[11.5, -6.5], [12.5, -6.5], [12.5, -5.5], [11.5, -5.5]]},
                 {"id": "c", "polygon": [[14.5, -6.5], [15.5, -6.5], [15.5, -5.5], [14.5, -5.5]]}],
        "plants": [_thyme(f"p{k}", 11.65 + 0.23 * (k % 4), -6.35 + 0.23 * (k // 4)) for k in range(12)],
    }


@pytest.mark.needs_site
def test_an_unrelated_edit_does_not_recite_the_whole_design():
    d = _crowded()
    before = agent.validate(d, _site())[1]
    assert before, "fixture no longer has pre-existing warnings — it tests nothing"
    _, msg = agent.execute(d, _site(), "place_object",
                           {"id": "rock", "kind": "boulder", "position": [17.0, -6.0],
                            "height_m": 0.5, "width_m": 0.6})
    for w in before:
        assert w not in msg, (
            "an edit far from the fault is still reciting a pre-existing warning; "
            "this makes a successful drag look like a rejection")
    assert "pre-existing" in msg, "the carried warnings must still be COUNTED, not hidden"


@pytest.mark.needs_site
def test_a_warning_the_edit_CAUSES_is_still_reported():
    # the complement, and the half that matters: silence would be worse than noise
    d = _crowded()
    _, msg = agent.execute(d, _site(), "place_plants",
                           {"plants": [dict(_thyme(None, 14.65 + 0.23 * (k % 4), -6.35 + 0.23 * (k // 4)),
                                            common="Thyme") for k in range(12)]})
    assert "bed c: at full maturity" in msg, "an op that crowds a bed does not say so"


def test_errors_are_still_filtered_against_the_baseline():
    # the behaviour warnings were modelled on must not regress
    src = __import__("inspect").getsource(agent.execute)
    assert "_is_new_or_worse" in src
    assert "baseline_errors" in src
