"""The want list identifies assets that need to be found or generated.

The asset library must not limit the design agent: missing assets need to be
found or generated. An unmodelled kind renders as a marked placeholder in the
viewer; the want list makes those gaps readable by tools as well as the user.

The vocabulary lives in JavaScript: objects.js owns BUILDERS and ALIASES.
There is ONE reader shared by the tools, so their interpretations cannot drift.
Its answers are cross-checked against node running the real objects.js because
a Python transcription of a JS regex can look correct and still disagree.
"""
import json
import os
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import project  # noqa: E402  where the active site's files are
sys.path.insert(0, os.path.join(ROOT, "tools"))
import objects_index as oi   # noqa: E402


def node_resolve(names):
    """What objects.js ITSELF says, via node. The only source of truth."""
    src = (
        'globalThis.document={createElement(){const c={fillStyle:"#000",fillRect(){},'
        'fillText(){},measureText:()=>({width:10}),beginPath(){},arc(){},fill(){},'
        'stroke(){},createLinearGradient:()=>({addColorStop(){}})};'
        'return{width:0,height:0,getContext:()=>c}}};'
        'const o=await import("./viewer/src/objects.js");'
        f'const names={json.dumps(names)};'
        'console.log(JSON.stringify(Object.fromEntries('
        'names.map(n=>[n, o.resolveKind(n) ?? null]))));'
    )
    out = subprocess.run([_node(), "--input-type=module"], input=src,
                         capture_output=True, text=True, cwd=ROOT)
    assert out.returncode == 0, out.stderr[-600:]
    return json.loads(out.stdout.strip().splitlines()[-1])


def _node():
    return "node"


PROBES = ["moon gate", "moongate", "lantern", "stone lantern", "water basin",
          "tsukubai", "boulder", "rock", "bench", "fire pit", "bamboo screen",
          "pergola", "tea house", "pagoda", "pagoda", "", "urn"]


def test_python_and_javascript_agree_on_every_probe():
    """The whole reason this module exists rather than a regex in wants.py."""
    js = node_resolve(PROBES)
    mine = {n: oi.resolve_kind(n) for n in PROBES}
    diff = {n: (mine[n], js[n]) for n in PROBES if mine[n] != js[n]}
    assert not diff, f"python disagrees with objects.js (python, js): {diff}"


def test_it_reads_the_real_builders():
    kinds = oi.known_kinds()
    assert {"lantern", "boulder", "bench", "moon_gate"} <= set(kinds), sorted(kinds)
    assert len(kinds) >= 8


def test_the_parse_fails_loudly_if_objects_js_moves(tmp_path):
    """A scraper that silently returns nothing would report every kind as a want
    and send someone off to build eight things that already exist."""
    empty = tmp_path / "objects.js"
    empty.write_text("// nothing here\n")
    with pytest.raises(Exception):
        oi.known_kinds(path=str(empty))


# ── the work queue ────────────────────────────────────────────────────────
def design(objs):
    return {"version": 1, "units": "meters", "beds": [], "plants": [], "patios": [],
            "paths": [], "edges": [], "steps": [], "objects": objs}


def test_it_lists_what_cannot_be_built_with_the_size_that_was_asked_for():
    d = design([
        {"id": "a", "kind": "lantern", "position": [1, 1], "height_m": 1.4},
        {"id": "b", "kind": "tea house", "position": [2, 2], "height_m": 2.8, "width_m": 3.2},
        {"id": "c", "kind": "tea house", "position": [3, 3], "height_m": 2.6},
        {"id": "d", "kind": "pagoda", "position": [4, 4], "width_m": 2.0},
    ])
    rows = oi.wants(d)
    by = {r["kind"]: r for r in rows}
    assert set(by) == {"tea house", "pagoda"}, sorted(by)
    assert by["tea house"]["count"] == 2
    assert by["tea house"]["ids"] == ["b", "c"]
    # the SIZE is what a builder needs and what a bare kind name loses
    assert by["tea house"]["height_m"] == pytest.approx(2.7, abs=0.01), by["tea house"]
    assert by["tea house"]["width_m"] == pytest.approx(3.2, abs=0.01)


def test_a_design_with_nothing_missing_reports_nothing():
    assert oi.wants(design([{"id": "a", "kind": "bench", "position": [0, 0]}])) == []
    assert oi.wants(design([])) == []
    assert oi.wants({}) == []


def test_it_sweeps_every_saved_design_not_just_one():
    """A want in a variant the user has not opened is still a want."""
    rows = oi.wants_across(project.data())
    assert isinstance(rows, list)
    for r in rows:
        assert r["kind"] and r["count"] >= 1
        assert r["designs"], f"{r['kind']} says nothing about where it was asked for"


def test_the_cli_prints_json_and_exits_zero():
    out = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "wants.py"), "--json"],
                         capture_output=True, text=True, cwd=ROOT)
    assert out.returncode == 0, out.stderr[-500:]
    body = json.loads(out.stdout)
    assert "wants" in body and isinstance(body["wants"], list)
