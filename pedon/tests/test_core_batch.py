"""One round trip per QUESTION, not per point.

Why this exists
---------------
Measured from data/site_api_calls.log, 411 logged calls: slope 95, ground 81,
profile 65, near 64 — 305 single-point queries, 74% of all traffic — against 46
calls (11%) to the batch-shaped tools (check-pad, check-route, best-bench,
check-ops). EXPLORE_BRIEF tells the model "LET THE SEARCH DO THE SEARCHING" in
prose; the log shows what prose is worth against tool shape. If the only
affordance is one point per process, the model spends its turns on `ground X Y`
in a loop.

So `ground-many` / `slope-many` exist. The contract these tests pin is the one
that makes them safe to prefer:

  * a batch of N points is EXACTLY the N single answers, byte for byte through
    the CLI — same argparse float coercion, same json.dumps. If they can drift
    the model has to know which one to trust, and two height lookups on a real
    site can disagree by 0.99 m.
  * it costs one logged invocation instead of N, which is the entire point;
  * and the model is TOLD, in EXPLORE_BRIEF, because a capability nobody can see
    does not exist: a tool the brief does not name is one a cold-start session
    never calls.

Everything runs through main(), not the cmd_ functions, with the call log
redirected into tmp: data/site_api_calls.log is the evidence the traffic figures
above are measured from, and a test suite must not write into its own dataset.
"""
from __future__ import annotations
import ast
import contextlib
import io
import json
import os
import sys

import pytest

# conftest.py does this too. Repeated deliberately, same reason test_ops.py
# gives: several people are adding files under tests/ at once.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))
import agent                                                    # noqa: E402
import site_api                                                 # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import project  # noqa: E402  where the active site's files are

# East of the house on ground the 1 m raycast actually covers. `[13, 6]` is
# written with INTEGER literals on purpose: that is how a model writes a
# coordinate, JSON hands it back as an int, and the single-point CLI coerces to
# float through argparse. A batch that skipped the coercion answers {"x": 13}
# where `ground 13 6` answers {"x": 13.0} — equal in Python, different JSON, and
# the whole reason to trust the cheaper call is that they are the same bytes.
SCANNED = [[9.0, 2.0], [10.0, 3.0], [11.0, 4.0], [12.0, 5.0], [13, 6],
           [9.5, 5.5], [12.5, 2.5]]
# Two kinds of "not measured", and they are NOT the same kind. FILLED_ONLY is
# past the scan edge where the 2 m BFS grid still invents a height, so ground_at
# answers and scan_at does not — 720 cells on this site do that, and a bench
# solver run against the filled field can bless a pad where only 12 of 35
# raycasts hit anything. NOWHERE is off both, where cmd_slope returns an {"error": ...}
# row: a batch that handled only the happy path would be useless at the scan
# edge, which is exactly where the model needs to ask.
FILLED_ONLY = [-18.5, -16.5]
NOWHERE = [200.0, 200.0]
MIXED = SCANNED + [FILLED_ONLY, NOWHERE]


def _cli(argv, tmp_path, monkeypatch):
    """Run the real CLI entry point; return (stdout, exit code, log lines).

    Through main() rather than the cmd_ function because the equivalence that
    matters is the one the model actually sees: argparse's float coercion and
    json.dumps are part of the answer.
    """
    (tmp_path / "data").mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(site_api, "ROOT", str(tmp_path))
    # Patching ROOT is not enough to redirect the call log: the log path is
    # YARDTWIN_CALL_LOG first (so the whole suite can be
    # kept out of the real evidence file — see tests/test_call_log.py), and
    # conftest sets it. Point it at THIS test's tmp log or the counts below
    # measure conftest's sink instead.
    monkeypatch.setenv("YARDTWIN_CALL_LOG", str(tmp_path / "data" / "site_api_calls.log"))
    monkeypatch.setattr(sys, "argv", ["site_api.py"] + argv)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), pytest.raises(SystemExit) as e:
        site_api.main()
    log = tmp_path / "data" / "site_api_calls.log"
    return buf.getvalue(), e.value.code, (log.read_text().splitlines() if log.exists() else [])


def _same(batch_rows, single_rows, why=""):
    """Equal as JSON TEXT, not merely as Python objects.

    `13 == 13.0` is True and so is the dict comparison containing them, so an
    equality assertion on the parsed rows cannot see the exact difference this
    contract is about: a model writes `[[13,6]]`, JSON hands back an int, and a
    batch that skipped argparse's float coercion prints {"x": 13} where the
    single call prints {"x": 13.0}. Re-serialising is what makes that visible.
    """
    assert batch_rows == single_rows, f"rows differ {why}"
    assert ([json.dumps(r, sort_keys=True) for r in batch_rows]
            == [json.dumps(r, sort_keys=True) for r in single_rows]), (
        f"rows are equal as objects but not as JSON {why} — int/float drift")


@pytest.mark.needs_site
def test_fixture_ground_is_real():
    """If SCANNED drifts off the mesh every equivalence below compares None to
    None and proves nothing."""
    hit = [p for p in SCANNED if site_api.scan_at(p[0], p[1]) is not None]
    assert len(hit) == len(SCANNED), f"only {len(hit)}/{len(SCANNED)} fixture points are on the scan"
    assert site_api.scan_at(*FILLED_ONLY) is None and agent.filled_at(*FILLED_ONLY) is not None, \
        "FILLED_ONLY is not off-scan-but-filled — on_scan and with_ground are not separated"
    assert site_api.scan_at(*NOWHERE) is None and agent.filled_at(*NOWHERE) is None, \
        "NOWHERE has ground — the no-answer path is untested"
    assert any(isinstance(c, int) for p in MIXED for c in p), \
        "no integer-literal coordinate left in the fixture — float coercion is untested"


@pytest.mark.needs_site
def test_ground_many_is_exactly_n_ground_calls(tmp_path, monkeypatch):
    singles = []
    for x, y in MIXED:
        out, code, _ = _cli(["ground", str(x), str(y)], tmp_path / "one", monkeypatch)
        assert code == 0
        singles.append(json.loads(out))
    batch, code, _ = _cli(["ground-many", json.dumps(MIXED)], tmp_path / "many", monkeypatch)
    assert code == 0
    _same(json.loads(batch)["points"], singles)


@pytest.mark.needs_site
def test_slope_many_is_exactly_n_slope_calls(tmp_path, monkeypatch):
    for radius in ("2.0", "1.0"):
        singles = []
        for x, y in MIXED:
            out, _, _ = _cli(["slope", str(x), str(y), "--radius", radius],
                             tmp_path / f"one{radius}", monkeypatch)
            singles.append(json.loads(out))
        batch, code, _ = _cli(["slope-many", json.dumps(MIXED), "--radius", radius],
                              tmp_path / f"many{radius}", monkeypatch)
        assert code == 0, f"slope-many exited {code} because one point was off the scan"
        _same(json.loads(batch)["points"], singles, f"--radius {radius}")


def test_a_batch_is_one_logged_call_not_n(tmp_path, monkeypatch):
    """The traffic claim, measured rather than asserted in a docstring."""
    for x, y in MIXED:
        _cli(["ground", str(x), str(y)], tmp_path / "one", monkeypatch)
    _, _, singly = _cli(["ground", "9", "2"], tmp_path / "one", monkeypatch)
    _, _, batched = _cli(["ground-many", json.dumps(MIXED)], tmp_path / "many", monkeypatch)
    assert len(singly) == len(MIXED) + 1
    assert len(batched) == 1
    assert json.loads(batched[0])["cmd"] == "ground-many"


@pytest.mark.needs_site
def test_batch_summarises_what_the_singles_cannot(tmp_path, monkeypatch):
    """A batch that only concatenated rows would still leave the model doing the
    reduction it came here to avoid: which of these is flattest, how far does the
    ground fall, how much of this was actually measured."""
    g, _, _ = _cli(["ground-many", json.dumps(MIXED)], tmp_path / "g", monkeypatch)
    g = json.loads(g)
    hs = [r["ground_m"] for r in g["points"] if r["ground_m"] is not None]
    assert g["count"] == len(MIXED)
    assert g["with_ground"] == len(SCANNED) + 1        # + the filled-only point
    assert g["ground_m"] == {"min": min(hs), "max": max(hs), "fall": round(max(hs) - min(hs), 2)}
    # on_scan is the raycast, not "a height came back" — the filled field answers
    # past the scan edge and the two numbers are allowed to differ. Reporting only
    # the second lets a bench solver bless invented ground.
    assert g["on_scan"] == len(SCANNED)
    assert g["scan_coverage"] == round(len(SCANNED) / len(MIXED), 2)

    s, _, _ = _cli(["slope-many", json.dumps(MIXED)], tmp_path / "s", monkeypatch)
    s = json.loads(s)
    graded = [r for r in s["points"] if r.get("slope_deg") is not None]
    assert s["measured"] == len(graded)
    assert s["flattest"] == min(graded, key=lambda r: r["slope_deg"])
    assert s["steepest"] == max(graded, key=lambda r: r["slope_deg"])
    assert sum(s["bands"].values()) == len(graded)


@pytest.mark.needs_site
def test_a_batch_warns_when_the_ground_under_it_is_interpolated(tmp_path, monkeypatch):
    """check-pad, check-route and area all warn below 0.8 coverage; a batch
    answering for a list of points is no different, and the summary is the only
    place a model reading 40 rows will see it."""
    for cmd in ("ground-many", "slope-many"):
        thin, _, _ = _cli([cmd, json.dumps([FILLED_ONLY, NOWHERE] + SCANNED[:1])],
                          tmp_path / f"thin{cmd}", monkeypatch)
        assert "warning" in json.loads(thin), f"{cmd} blessed 33% coverage silently"
        full, _, _ = _cli([cmd, json.dumps(SCANNED)], tmp_path / f"full{cmd}", monkeypatch)
        assert "warning" not in json.loads(full), f"{cmd} warns on fully scanned ground"


@pytest.mark.needs_site
def test_an_empty_or_malformed_point_list_is_an_error_not_a_traceback(tmp_path, monkeypatch):
    for bad in ("[]", "[[1]]", "not json", '[[1,2],"x"]'):
        out, code, _ = _cli(["ground-many", bad], tmp_path / "bad", monkeypatch)
        assert code == 1, f"{bad!r} exited {code}"
        assert "error" in json.loads(out)
        assert "Traceback" not in out


@pytest.mark.needs_site
def test_ground_does_not_claim_unscanned_ground_was_scanned(tmp_path, monkeypatch):
    """The rows must agree with the summary: a ground-many reporting on_scan 3 of
    4 while every row says "scanned": true contradicts itself.

    "scanned" must not mean "a height came back", because ground_at falls back to
    the 2 m BFS-filled grid past the scan edge. Measured on the 1 m lattice: of
    1308 cells where `ground X Y` answers, 720 — 55% — are never raycast, and
    none of them may be reported as scanned. EXPLORE_BRIEF sells that field as
    "whether it was actually scanned", and telling measurement from
    interpolation is the reason this file exists.
    """
    out, code, _ = _cli(["ground", str(FILLED_ONLY[0]), str(FILLED_ONLY[1])], tmp_path, monkeypatch)
    r = json.loads(out)
    assert code == 0 and r["ground_m"] is not None, "the filled grid should still answer here"
    assert r["scanned"] is False
    assert r["source"] == "filled"

    out, _, _ = _cli(["ground", str(SCANNED[0][0]), str(SCANNED[0][1])], tmp_path, monkeypatch)
    r = json.loads(out)
    assert r["scanned"] is True and r["source"] == "raycast"

    out, _, _ = _cli(["ground", str(NOWHERE[0]), str(NOWHERE[1])], tmp_path, monkeypatch)
    r = json.loads(out)
    assert r["ground_m"] is None and r["scanned"] is False and r["source"] is None


def test_the_brief_names_the_batch_commands():
    """A tool the model is not told about is a tool that does not exist — a
    cold-start session never calls a tool the brief does not name. The traffic
    above shows the single-point SHAPE beating the brief's prose, so the batch
    shape has to be advertised at least as loudly."""
    for cmd in ("ground-many", "slope-many"):
        assert cmd in agent.EXPLORE_BRIEF, f"{cmd} is not in EXPLORE_BRIEF"


def _sources():
    """EVERY tool, not two of them.

    Scanning only agent.py and site_api.py would read as a global guarantee
    while more transcriptions of the same ray-crossing test could sit in
    replant.py or geodata.py. A DRY guard whose scope is narrower than its name is
    how duplication survives a DRY audit."""
    import glob
    out = {}
    for f in sorted(glob.glob(os.path.join(ROOT, "tools", "*.py"))):
        name = os.path.basename(f)
        if name.startswith("_"):
            continue
        out[name] = open(f).read()
    return out


def test_there_is_exactly_one_point_in_polygon(tmp_path, monkeypatch):
    """A retyped height-field lookup is easy to get wrong — indexing the rows the
    wrong way round in every copy — and point-in-polygon carries the same risk:
    each transcription of the ray-crossing test (in agent, in site_api) is one more
    place for it. geom.point_in_polygon is the only one."""
    impls = []
    for path, src in _sources().items():
        for node in ast.walk(ast.parse(src)):
            if isinstance(node, ast.FunctionDef) and "!= (y2 >" in ast.unparse(node).replace("  ", " "):
                impls.append(f"{path}:{node.name}")
    assert impls == ["geom.py:point_in_polygon"], f"ray-crossing test written {len(impls)} times: {impls}"


def test_there_is_exactly_one_polygon_area(tmp_path, monkeypatch):
    """Same class: the shoelace sum has one home, geom.polygon_area — not
    open-coded in agent.execute()'s set_patio branch, in site_api.cmd_check_pad,
    or in a private helper."""
    impls = []
    for path, src in _sources().items():
        for node in ast.walk(ast.parse(src)):
            if isinstance(node, ast.FunctionDef) and "x1 * y2 - x2 * y1" in ast.unparse(node):
                impls.append(f"{path}:{node.name}")
    assert impls == ["geom.py:polygon_area"], f"shoelace written {len(impls)} times: {impls}"


@pytest.mark.needs_site
def test_the_collapsed_helpers_still_answer_the_same(tmp_path, monkeypatch):
    """Collapsing is only safe if the survivor agrees with what it replaced. The
    house footprint is a real, non-convex polygon on this site."""
    with open(project.data("site.json")) as f:
        fp = json.load(f)["footprint"]
    probes = [(x + 0.5, y + 0.5) for x in range(-24, 24) for y in range(-24, 24)]
    # Half-integer probes never land on a vertex, and a ray-crossing test that
    # used >= instead of > would agree with this one everywhere on that lattice.
    # The degenerate cases are the whole reason not to retype this function: sweep
    # x along each vertex's own y, and hit the vertices themselves.
    ys = sorted({v[1] for v in fp})
    xs = [v[0] for v in fp]
    probes += [(x, y) for y in ys
               for x in [min(xs) - 1, max(xs) + 1] + [round(min(xs) + i * (max(xs) - min(xs)) / 20, 4)
                                                      for i in range(21)]]
    probes += [tuple(v) for v in fp]
    # Measured: on this 6-vertex footprint > and >= agree on all 2448 probes
    # above, because at a vertex both incident edges flip and the effect cancels.
    # An axis-aligned box with a HORIZONTAL edge is where the two conventions
    # actually part, so the collapse is checked somewhere the check can fail.
    box = [[0.0, 0.0], [4.0, 0.0], [4.0, 3.0], [0.0, 3.0]]
    for px in [-1.0, 0.0, 2.0, 4.0, 5.0]:
        for py in [-1.0, 0.0, 1.5, 3.0, 4.0]:
            assert agent.point_in_poly((px, py), box) == _ray_reference(px, py, box), \
                f"point_in_poly parts from the reference on a horizontal edge at ({px}, {py})"
    checked = 0
    for px, py in probes:
        assert agent.point_in_poly((px, py), fp) == _ray_reference(px, py, fp), \
            f"point_in_poly disagrees with an independent transcription at ({px}, {py})"
        checked += 1
    assert checked > 2000
    assert round(agent.poly_area([[0, 0], [4, 0], [4, 3], [0, 3]]), 6) == 12.0
    assert round(agent.poly_area([[0, 0], [0, 3], [4, 3], [4, 0]]), 6) == 12.0   # winding-independent


def _ray_reference(px, py, poly):
    """An independent transcription, kept HERE so the collapse above is checked
    against something rather than against itself."""
    c = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > py) != (y2 > py) and px < (x2 - x1) * (py - y1) / (y2 - y1) + x1:
            c = not c
    return c
