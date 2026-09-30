"""The duplication NO SINGLE FILE CAN SEE — across the boundaries between files.

Why this file exists, and why it is separate from test_dry.py
------------------------------------------------------------
tests/test_dry.py holds the line on duplication found by reading the whole tree
at once: the scan-grid lookup, the ray-crossing test, the shoelace, the broker
client, the limits.

This file guards the other kind. Work that sees only its own set of files
cannot notice that the module it just wrote is imported by nobody, that the
endpoint it posts to lives in a file it never reads, or that the constant it
exported as "the one home" is still typed as a literal on the other side of a
boundary. That is the exact blind spot a file partition creates, and it is what
this file watches.

What it checks, and why
-----------------------
  * every viewer/src module is reachable from a page the browser loads. A
    module can be correct and fully tested in node and still be imported by
    NOTHING, and then the feature does not exist for the owner.
  * the world-bearing convention (`worldBearingOf` in lighting.js) is written
    once, and the viewer's inline form agrees with it while it exists.
  * tools/sun.py derives `true_bearing = stored - degrees(yaw)` from the
    viewer's Set-north code in prose, and its own test locks the convention but
    cannot prove it against the viewer. This file runs main.js's actual
    terrainFacts() in node and proves it, at the real 23.3 deg yaw. This is the
    nastiest bug class in the project; a sign error here is 2 x 23 deg on every
    stored bearing.
  * every endpoint the viewer posts to is one viewer/vite.config.js serves —
    above all POST /api/ops, the one write path, which must not bypass
    agent.execute(). Without the route, postOps() takes its own 404 branch and
    no hand edit applies. The render broker's op names are checked the same way.
  * schema/design.schema.json types four of agent.DEFAULT_CONSTRAINTS's numbers
    as its own bounds. That is deliberate — the schema has to validate a design
    on its own — but four JS test files plus every standalone schema check
    enforce the shipped copy while agent.validate() enforces the live one, so
    the two must agree.

Two shapes, and the difference is the same one test_dry.py draws:
  * where two copies still AGREE, the test sweeps both and asserts they answer
    identically, so the drift is caught the day it starts;
  * where the second copy simply should not exist, or a wire must be present,
    the assertion states what SHOULD hold.

Nothing here touches the network or the viewer. The one node subprocess runs
main.js's own extracted source against the viewer's own copy of three, the same
trick test_dry.py and tests/js/clean_scene.test.mjs use on a file that cannot be
imported (main.js builds a WebGLRenderer at module scope).

DRY applies to a test file too: the JS extractor, the node runner and the
comparison harness are IMPORTED from test_dry, not transcribed. A second copy of
js_slice() here would be this project's own bug with a new name.
"""
import json
import os
import re

import pytest

import agent

# The harness, not a second copy of it. test_dry.js_slice asserts rather than
# returning nothing when a declaration is gone, which is what stops this whole
# file from quietly guarding an empty set.
from test_dry import HAVE_NODE, ROOT, VIEWER_SRC, agree, js_slice, js_source, node_json

VIEWER = os.path.join(ROOT, "viewer")
SCHEMA_PATH = os.path.join(ROOT, "schema", "design.schema.json")
THREE_PATH = os.path.join(VIEWER, "node_modules", "three", "build", "three.module.js")
MAIN_JS = os.path.join(VIEWER, "src", "main.js")
LIGHTING_PATH = os.path.join(VIEWER, "src", "lighting.js")

# 23.3 deg — the yaw Set north stores for calibration.json's PLY capture. Any
# non-zero yaw would prove the convention; using the real one keeps the failure
# message honest about the size of the error at stake.
REAL_YAW = 0.4069


# ── reading the two sides of a boundary ───────────────────────────────────
def fetched_api_paths():
    """Every /api/… path the viewer's own JavaScript posts to."""
    out = {}
    for name in sorted(os.listdir(VIEWER_SRC)):
        if not name.endswith(".js"):
            continue
        with open(os.path.join(VIEWER_SRC, name)) as f:
            text = f.read()
        for m in re.finditer(r"""fetch\(\s*["'`](/api/[^"'`?]+)""", text):
            out.setdefault(m.group(1), set()).add(name)
    return out


def served_api_paths(cfg_src=None):
    """Every /api/… path the dev server actually answers."""
    if cfg_src is None:
        with open(os.path.join(VIEWER, "vite.config.js")) as f:
            cfg_src = f.read()
    return set(re.findall(r"""url\s*===\s*["'](/api/[^"']+)["']""", cfg_src))


def js_imports(text):
    r"""The relative module specifiers one JS/HTML source pulls in.

    SUBDIRECTORIES COUNT. A pattern matching `[\w.]+\.js` only makes every
    `./shell/*.js` invisible to the import walk — the whole PEDON shell could be
    orphaned and this would say the viewer was clean.
    """
    # `import "./x.js"` too: a side-effect import is an import (species.js loads the builders'
    # kit that way), and a reader blind to it calls the kit dead
    return set(re.findall(r"""(?:from|\bimport)\s+["'](?:\.{1,2}|/src)/([\w./]+\.js)["']""", text)) | \
        set(re.findall(r"""src=["']/src/([\w./]+\.js)["']""", text))


def reachable_modules(entries=None):
    """viewer/src modules reachable from the pages the browser actually loads.

    Transitive, and from the HTML rather than from a module list: "something
    imports it" is not the question — `preview.html` and `routing-test.html` are
    real entry points too, and a module only another orphan imports is still
    dead. What matters is whether a browser can ever reach the file.
    """
    if entries is None:
        # EVERY page in viewer/, not a hand-typed list. A page missing from the
        # list is not an entry point as far as this check knows, so a module only
        # that page loads (shell_preview.js from shell.html) reads as dead code.
        # A hand-maintained list of the pages is the same class of copy as a
        # hand-maintained list of the design's keys.
        entries = set()
        for page in sorted(p for p in os.listdir(VIEWER) if p.endswith(".html")):
            with open(os.path.join(VIEWER, page)) as f:
                entries |= js_imports(f.read())
    seen, queue = set(), list(entries)
    while queue:
        mod = queue.pop()
        if mod in seen:
            continue
        path = os.path.join(VIEWER_SRC, mod)
        if not os.path.exists(path):
            continue
        seen.add(mod)
        with open(path) as f:
            queue += list(js_imports(f.read()))
    return seen


# The world-frame compass bearing, as an expression: atan2(east, -z). Written
# narrowly enough that detect.js's `atan2(2 * vxz, vxx - vzz)` and fit.js's
# `atan2(szx - sxz, sxx + szz)` — both real, both something else entirely — do
# not read as copies of it.
BEARING_EXPR = re.compile(r"Math\.atan2\(\s*[\w.]+\s*,\s*-\s*[\w.]+\s*\)")


def bearing_sites():
    """file -> the lines where the world-bearing convention is written out."""
    hits = {}
    for name in sorted(os.listdir(VIEWER_SRC)):
        if not name.endswith(".js"):
            continue
        with open(os.path.join(VIEWER_SRC, name)) as f:
            for i, line in enumerate(f.read().splitlines(), 1):
                if BEARING_EXPR.search(line):
                    hits.setdefault(name, []).append(i)
    return hits


# ── running the viewer's own code ─────────────────────────────────────────
def viewer_frame_probe(main_src=None, lighting_path=None):
    """Run main.js's REAL terrainFacts() and lighting.js's exports in node.

    terrainFacts() is the viewer's only writer of a true compass bearing: it
    takes the stored ground normal, rotates it by the calibration yaw and reads
    the bearing off. It is sliced out of main.js rather than retyped here —
    retyping it would test this file's idea of the convention instead of the
    viewer's, which is precisely the failure this convention is prone to.

    levelGroup is stubbed with an identity quaternion: the level rotation is a
    separate transform and not part of the north convention under test.

    Both sources are parameters so the comparison can be shown failing against a
    doctored copy in a scratch directory, without mutating the real viewer/src.
    """
    fn = js_slice(main_src if main_src is not None else js_source("main.js"),
                  "function terrainFacts")
    assert "applyAxisAngle" in fn and "calib.yaw" in fn, \
        "terrainFacts no longer applies the yaw — this test is comparing something else"

    cases = [{"slope": s, "bearing": b, "yaw": y}
             for s in (5.0, 13.0, 27.0)
             for b in range(0, 360, 37)
             for y in (0.0, REAL_YAW, -REAL_YAW, 1.2)]

    script = (
        'import * as THREE from ' + json.dumps(THREE_PATH) + ';\n'
        'import { worldBearingOf, sunDirectionWorld, SUN_COLOR, SKY_COLOR, GROUND_COLOR,\n'
        '         SUN_INTENSITY, SKY_INTENSITY, UNTRUSTED_AZIMUTH_DEG,\n'
        '         UNTRUSTED_ALTITUDE_DEG } from '
        + json.dumps(lighting_path or LIGHTING_PATH) + ';\n'
        'const levelGroup = { quaternion: new THREE.Quaternion() };\n'
        'let calib = {};\n'
        + fn + '\n'
        'const cases = ' + json.dumps(cases) + ';\n'
        'const rows = cases.map(c => {\n'
        '  const t = THREE.MathUtils.degToRad(c.slope), b = THREE.MathUtils.degToRad(c.bearing);\n'
        '  const n = new THREE.Vector3(Math.sin(t) * Math.sin(b), Math.cos(t),\n'
        '                              -Math.sin(t) * Math.cos(b));\n'
        '  calib = { groundNormal: { x: n.x, y: n.y, z: n.z }, slopeDeg: c.slope,\n'
        '            northSet: true, yaw: c.yaw };\n'
        '  const f = terrainFacts();\n'
        '  return { stored: worldBearingOf(n), viewer: f && f.downhill_azimuth_deg };\n'
        '});\n'
        'const legacy = sunDirectionWorld(UNTRUSTED_AZIMUTH_DEG, UNTRUSTED_ALTITUDE_DEG);\n'
        'console.log(JSON.stringify({ rows, legacy: [legacy.x, legacy.y, legacy.z],\n'
        '  consts: { SUN_COLOR, SKY_COLOR, GROUND_COLOR, SUN_INTENSITY, SKY_INTENSITY } }));\n')
    out = node_json(script)
    out["cases"] = cases
    return out


@pytest.fixture(scope="module")
def frame_probe():
    """One node subprocess for the whole file. tools/selftest.py holds the suite
    to a CPU budget and a spawn per test is exactly the step change it watches
    for."""
    if not HAVE_NODE:
        pytest.skip("node is needed to run the viewer's own copy of the convention")
    return viewer_frame_probe()


# ── 0. the guards on the guards ───────────────────────────────────────────
# A test whose extractor silently matches nothing is GREEN against a live bug,
# even with the duplicate it forbids sitting in the file. So every reader above
# is shown finding something real, and shown failing on a doctored input,
# before anything is concluded.
def test_the_route_readers_find_both_sides_and_can_disagree():
    fetched, served = fetched_api_paths(), served_api_paths()
    assert len(fetched) >= 5, f"the fetch reader found almost nothing: {fetched}"
    assert len(served) >= 5, f"the route reader found almost nothing: {served}"
    assert "/api/save" in fetched and "/api/save" in served, \
        "the readers no longer agree on a route both sides certainly have"
    assert served_api_paths('if (url === "/api/only-one") {}') == {"/api/only-one"}
    assert served_api_paths("nothing here") == set(), \
        "the route reader invents routes that are not there"


def test_the_module_graph_reader_follows_imports_and_can_lose_a_module():
    mods = reachable_modules()
    assert "main.js" in mods, "the entry point itself is not reachable — the reader is broken"
    assert "plants.js" in mods, ("plants.js is only reachable through design.js; a reader "
                                 "that misses it is not following imports transitively")
    assert reachable_modules(entries={"nothing-real.js"}) == set()
    assert js_imports('import "./kit.js";\nimport { a } from "./b.js";') == {"kit.js", "b.js"}


def test_the_bearing_reader_matches_the_convention_and_not_its_neighbours():
    hits = bearing_sites()
    assert "lighting.js" in hits, ("the world-bearing expression was not found in the file "
                                   "that declares itself its home — the pattern has gone stale")
    assert "detect.js" not in hits and "fit.js" not in hits, \
        f"the pattern is matching unrelated atan2 calls: {hits}"


# ── 1. a module the browser can never reach ───────────────────────────────
def test_every_viewer_module_is_reachable_from_a_page_the_browser_loads():
    """A capability nobody invokes is not a capability.

    A module that ships passing node tests but that no page loads is the worst
    case: the suite is green, the module is correct, and the feature — a whole
    sun-and-shadow model, say — does not exist in the viewer.

    Reachability rather than "is it imported": a module imported only by another
    orphan is just as dead.
    """
    on_disk = {n for n in os.listdir(VIEWER_SRC) if n.endswith(".js")}
    for sub in sorted(d for d in os.listdir(VIEWER_SRC)
                      if os.path.isdir(os.path.join(VIEWER_SRC, d))):
        on_disk |= {f"{sub}/{n}" for n in os.listdir(os.path.join(VIEWER_SRC, sub))
                    if n.endswith(".js")}
    orphans = sorted(on_disk - reachable_modules())
    assert orphans == [], (
        f"viewer/src modules no page can reach: {orphans}. Either import them from "
        f"the app or delete them — a module that only the tests load is a feature "
        f"the owner does not have.")


# ── 2. the sun, the lights and the compass ────────────────────────────────
def test_the_viewer_writes_one_bearing_whether_it_imports_it_or_not(frame_probe):
    """worldBearingOf and terrainFacts's inline atan2 must answer the same.

    At yaw 0 they are the same question asked twice, in two files. This is the
    equivalence half of the duplicate lighting.js's docstring names; the
    written-once half is the test below.
    """
    rows = [(r, c) for r, c in zip(frame_probe["rows"], frame_probe["cases"]) if c["yaw"] == 0.0]
    assert len(rows) >= 10, f"the yaw-0 sweep is too small to mean anything: {len(rows)}"
    agree("world bearing at yaw 0", rows,
          ("lighting.js worldBearingOf", lambda c: round(c[0]["stored"])),
          ("main.js terrainFacts inline atan2", lambda c: c[0]["viewer"]), tol=0.51)


def test_the_world_bearing_convention_is_written_once_in_the_viewer():
    """Copies of an axis convention go wrong together: three copies of a
    height-field lookup can each index the rows the wrong way round. This is the
    same kind of expression on the same axis convention, and lighting.js declares
    itself its home for the call sites that should import it."""
    hits = bearing_sites()
    strays = {f: lines for f, lines in hits.items() if f != "lighting.js"}
    assert strays == {}, (
        f"the world-bearing convention is written outside its home: {strays}. "
        f"lighting.js exports worldBearingOf for these call sites.")


@pytest.mark.skipif(not HAVE_NODE, reason="node is needed to run the viewer's own convention")
def test_sun_py_and_the_viewer_turn_a_stored_bearing_true_the_same_way(frame_probe):
    """The nastiest bug class in the project, measured across the boundary.

    tools/sun.py derives `true = stored - degrees(yaw)` from the viewer's Set
    north code in prose, and its own
    test_true_bearing_applies_the_yaw_in_the_viewer_s_direction locks the
    convention but cannot prove it against the viewer.

    So: main.js's own terrainFacts() is run in node over a sweep of stored
    normals and yaws, and sun.true_bearing is asked the same question. A sign
    error here is 2 x 23.3 deg on this property, which is the difference between
    a south-facing slope and a south-east one — and it would be invisible at yaw
    0, so the sweep is mostly non-zero yaws including the real 23.3 deg.
    """
    import sun

    rows = list(zip(frame_probe["rows"], frame_probe["cases"]))
    turned = [r for r in rows if r[1]["yaw"] != 0.0]
    assert len(turned) >= 30, (f"only {len(turned)} non-zero-yaw cases — at yaw 0 the two "
                               f"frames are IDENTICAL and this test would prove nothing")
    assert all(r[0]["viewer"] is not None for r in rows), \
        "terrainFacts returned no bearing — it refused before the comparison could run"

    bad = []
    for row, case in turned:
        want = sun.true_bearing(row["stored"], case["yaw"])
        got = row["viewer"]                      # terrainFacts rounds to whole degrees
        # compared round the circle: 359.7 and 0.1 differ by 0.4 deg, not 359.6,
        # and a wrap read as a 359 deg error would make this test cry wolf on
        # every north-facing slope
        d = abs(((want - got + 180) % 360) - 180)
        if d > 0.51:
            bad.append(f"stored={row['stored']:.2f} yaw={case['yaw']}: "
                       f"sun.true_bearing={want:.2f} viewer={got}")
    assert not bad, (
        f"{len(bad)} of {len(turned)} cases disagree — tools/sun.py and the viewer no longer "
        f"turn a stored bearing true the same way, which is a whole-yaw error on every "
        f"bearing in site.json\n  " + "\n  ".join(bad[:8]))


# ── 3. what the viewer asks for, and what the server answers ──────────────
def test_every_endpoint_the_viewer_posts_to_is_one_the_dev_server_answers():
    """The emitter and the server live in different files, and neither can see
    the other half of the contract.

    main.js's postOps() has a 404 branch — "this dev server has no op
    endpoint ... Restart the viewer" — so a missing route reads to the owner as
    a stale server rather than a missing feature, and every hand-placed plant
    takes that branch. A hand edit must go through agent.execute(); without the
    route it goes through nothing at all.
    """
    fetched, served = fetched_api_paths(), served_api_paths()
    missing = {p: sorted(who) for p, who in fetched.items() if p not in served}
    assert missing == {}, (
        f"the viewer posts to endpoints viewer/vite.config.js does not serve: {missing}. "
        f"Served: {sorted(served)}")


def test_every_render_broker_op_python_sends_is_one_the_viewer_executes():
    """The same contract on the other side of the same broker — which is what
    makes a missing route above a finding rather than a quirk of how this is
    measured.

    tools/*.py posts {"op": …} to the render broker and viewer/src/viewport.js
    dispatches on cmd.op. A name added on one side only fails at run time, in
    the browser, as a silent refusal — and analyze_site.py's scan_grid is the
    FIRST command run when onboarding a property.
    """
    sent = {}
    tools = os.path.join(ROOT, "tools")
    for name in sorted(os.listdir(tools)):
        if not name.endswith(".py"):
            continue
        with open(os.path.join(tools, name)) as f:
            for op in re.findall(r"""["']op["']\s*:\s*["']([a-z_]+)["']""", f.read()):
                sent.setdefault(op, set()).add(name)
    with open(os.path.join(VIEWER_SRC, "viewport.js")) as f:
        handled = set(re.findall(r"""cmd\.op\s*===\s*["']([a-z_]+)["']""", f.read()))
    assert len(sent) >= 3 and len(handled) >= 3, \
        f"one side of the broker contract read as almost empty: sent={sent} handled={handled}"
    missing = {op: sorted(who) for op, who in sent.items() if op not in handled}
    assert missing == {}, (f"python posts broker ops viewport.js does not execute: {missing}. "
                           f"Executed: {sorted(handled)}")


# ── 4. the limits, on the other side of the schema ────────────────────────
# Numbers that schema/design.schema.json types as its own bounds and describes,
# in the file, as "the SHIPPED DEFAULTS", against the key each one is a copy of.
SHIPPED_BOUNDS = [
    (("edges", "height_m", "minimum"), "edge_min_height_m"),
    (("edges", "height_m", "maximum"), "retain_limit_m"),
    (("steps", "riser_m", "maximum"), "step_riser_max_m"),
    (("steps", "going_m", "minimum"), "step_going_min_m"),
]


def test_the_schema_s_shipped_bounds_are_the_limits_agent_ships_with():
    """agent.validate() overwrites these three bounds with site.constraints
    before validating, so on the design path the schema's own numbers never
    decide anything. Everywhere ELSE they do: tests/js/steps.test.mjs,
    design.test.mjs, ui_place.test.mjs and ui_groups.test.mjs all validate
    against the file on disk with no site to overwrite it, and so does anyone
    running the schema standalone.

    So a limit changed in agent.py and not in the schema means the JS side keeps
    enforcing the old one — an edge legal to the validator and rejected by the
    file, or worse the reverse. Name AND value, per key, so a coincidence
    between two unrelated numbers cannot make this look green.
    """
    with open(SCHEMA_PATH) as f:
        schema = json.load(f)
    props = schema["properties"]
    found = {}
    for (section, field, bound), key in SHIPPED_BOUNDS:
        node = props[section]["items"]["properties"][field]
        assert bound in node, (f"schema {section}.{field} no longer states a {bound} — "
                               f"the bound this compares against is gone")
        found[key] = node[bound]
    assert len(found) == len(SHIPPED_BOUNDS), "a bound was read twice; the table is wrong"
    agree("shipped limit", sorted(found),
          ("schema/design.schema.json", lambda k: found[k]),
          ("agent.DEFAULT_CONSTRAINTS", lambda k: agent.DEFAULT_CONSTRAINTS[k]), tol=1e-9)


def test_main_js_does_not_build_its_own_lights():
    """main.js calls initLighting() and constructs no light of its own.

    Comparing a hand-built HemisphereLight/DirectionalLight in main.js against
    lighting.js's exported constants would be a duplicate-agrees check, the
    weakest useful form. With no second light there is nothing to agree WITH,
    and what is worth guarding is that it stays that way.

    initLighting refuses to run without geoGroup, so a light rebuilt here would
    also be a light in the wrong frame: correct at yaw 0 and 23.3 deg wrong the
    moment north is set.
    """
    src = open(MAIN_JS).read()
    assert "initLighting" in src, "main.js no longer initialises lighting at all"
    for ctor in ("new THREE.HemisphereLight", "new THREE.DirectionalLight"):
        assert ctor not in src, (
            f"main.js constructs {ctor} again — lighting.js owns the lights, and a "
            f"second one here is a light outside the geo frame")
