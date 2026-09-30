"""Turn a WANT into an asset.

The asset library must not limit what the model can design: missing assets must
be found or generated. An open vocabulary and an inventory of missing assets do
not build them. Hand-writing each missing builder does not scale across requests
for a moon gate, a tea house, a koi pond or a pagoda.

The whole risk here is a generator that writes something plausible and broken into
`objects.js`, because that file is imported by the viewer at module scope: a
syntax error blanks the app. So the shape is generate -> VERIFY BY RUNNING -> keep
or revert, and the verification is what this file mostly tests. The model call is
injected so these tests never spend one.
"""
import io
import json
import os
import shutil
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import gen_object as go     # noqa: E402
import objects_index as oi  # noqa: E402


@pytest.fixture
def sandbox():
    """A copy of the real objects.js, so a test can never damage the viewer.

    It lives IN viewer/src rather than in tmp_path: objects.js does
    `import * as THREE from "three"`, a bare specifier that node only resolves
    inside the viewer package, so a copy anywhere else cannot be imported at all
    and every verification would report a syntax error even for working code.
    """
    src = os.path.join(ROOT, "viewer", "src", "objects.js")
    dst = os.path.join(ROOT, "viewer", "src", f"_sandbox_objects_{os.getpid()}.js")
    shutil.copy(src, dst)
    try:
        yield dst
    finally:
        if os.path.exists(dst):
            os.unlink(dst)


GOOD = '''  tea_house: (h, w) => {
    const g = new THREE.Group(), L = w || 2.6, ht = h || 2.4;
    const floor = new THREE.Mesh(new THREE.BoxGeometry(L, 0.12, L * 0.8), mat(TIMBER));
    floor.position.y = 0.06; g.add(floor);
    for (const dx of [-L / 2 + 0.15, L / 2 - 0.15]) {
      for (const dz of [-L * 0.4 + 0.15, L * 0.4 - 0.15]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, ht * 0.7, 8), mat(TIMBER));
        post.position.set(dx, ht * 0.35, dz); g.add(post);
      }
    }
    const roof = new THREE.Mesh(new THREE.ConeGeometry(L * 0.75, ht * 0.3, 4), mat(DARK_STONE));
    roof.position.y = ht * 0.85; roof.rotation.y = Math.PI / 4; g.add(roof);
    return g;
  },
'''
BROKEN_SYNTAX = "  tea_house: (h, w) => { const g = new THREE.Group(  ; return g; },\n"
EMPTY = "  tea_house: (h, w) => new THREE.Group(),\n"
WRONG_HEIGHT = '''  tea_house: (h, w) => {
    const g = new THREE.Group();
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 12, 1), mat(TIMBER));
    m.position.y = 6; g.add(m); return g;
  },
'''


def test_a_good_builder_is_accepted_and_lands_in_the_file(sandbox):
    ok, why = go.install(sandbox, "tea house", GOOD, height_m=2.4, width_m=2.6)
    assert ok, why
    src = io.open(sandbox).read()
    assert "tea_house:" in src
    assert oi.resolve_kind("tea house", path=sandbox) == "tea_house", \
        "installed, and still not reachable from a design"


def test_a_syntax_error_never_reaches_the_file(sandbox):
    """objects.js is imported at module scope by the viewer: a broken one blanks
    the whole app, so this is the failure that matters most."""
    before = io.open(sandbox).read()
    ok, why = go.install(sandbox, "tea house", BROKEN_SYNTAX, height_m=2.4)
    assert not ok
    assert "syntax" in why.lower() or "parse" in why.lower(), why
    assert io.open(sandbox).read() == before, "a broken builder was left in the file"


def test_a_builder_that_draws_nothing_is_rejected(sandbox):
    before = io.open(sandbox).read()
    ok, why = go.install(sandbox, "tea house", EMPTY, height_m=2.4)
    assert not ok, "an empty group passed — that is a placeholder with extra steps"
    assert io.open(sandbox).read() == before


def test_a_builder_that_ignores_the_asked_for_size_is_rejected(sandbox):
    before = io.open(sandbox).read()
    ok, why = go.install(sandbox, "tea house", WRONG_HEIGHT, height_m=2.4)
    assert not ok, "a 12 m tea house passed"
    assert "height" in why.lower() or "tall" in why.lower(), why
    assert io.open(sandbox).read() == before


def test_it_refuses_to_overwrite_something_that_already_builds(sandbox):
    ok, why = go.install(sandbox, "lantern", GOOD, height_m=1.4)
    assert not ok
    assert "already" in why.lower(), why


def test_the_generator_asks_the_model_and_verifies_what_comes_back(sandbox, monkeypatch):
    """The model is INJECTED, so this test costs no subscription call. What is
    being checked is the loop: ask, verify, and only then keep."""
    calls = []

    def fake(prompt, **kw):
        calls.append(prompt)
        return "```js\n" + GOOD + "```"

    ok, why = go.generate("tea house", height_m=2.4, width_m=2.6,
                          path=sandbox, ask=fake)
    assert ok, why
    assert len(calls) == 1
    p = calls[0]
    # the prompt has to carry what a builder actually needs
    for want in ("THREE", "tea house", "2.4"):
        assert want in p, f"the prompt never mentions {want!r}"
    assert "mat(" in p or "BUILDERS" in p, "the prompt shows no example of the house style"


def test_a_bad_answer_is_retried_then_given_up_on_cleanly(sandbox, monkeypatch):
    before = io.open(sandbox).read()
    tries = []

    def fake(prompt, **kw):
        tries.append(prompt)
        return "```js\n" + BROKEN_SYNTAX + "```"

    ok, why = go.generate("tea house", height_m=2.4, path=sandbox, ask=fake, attempts=3)
    assert not ok
    assert len(tries) == 3, f"gave up after {len(tries)} attempts"
    assert "the previous attempt" in tries[-1].lower() or "failed" in tries[-1].lower(), \
        "a retry does not tell the model what was wrong with the last try"
    assert io.open(sandbox).read() == before


def test_the_cli_is_reachable_and_refuses_without_a_kind():
    out = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "gen_object.py")],
                         capture_output=True, text=True, cwd=ROOT)
    assert out.returncode != 0
    assert "kind" in (out.stderr + out.stdout).lower()


# ── the generator is briefed on the METHOD, not only the mechanics ──────
#
# The verifier enforces mechanical rules — return this shape, be this tall,
# sit on y=0 — but those alone allow a screen you can see through, an unbroken
# flat colour, or a lantern with no opening. The generator also needs the method
# for producing visually faithful assets.
#
# ASSET_FIDELITY.md is the single copy and gen_object.py reads it at prompt time.
# These tests check that the method reaches the generator; a document alone
# cannot guide a model that never receives it.

def _root():
    import os
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def test_the_method_document_exists_and_says_something():
    import os
    path = os.path.join(_root(), "ASSET_FIDELITY.md")
    assert os.path.exists(path), "ASSET_FIDELITY.md is gone — gen_object.py reads it"
    text = open(path, encoding="utf-8").read()
    assert len(text) > 3000, f"only {len(text)} chars — that is not the method"
    # the three sections that decide whether a generated builder is any good
    for phrase in ["defining property", "flat shape is a line edge-on",
                   "Flat colour", "Coverage is leaf/blade area",
                   "Before you call an asset done"]:
        assert phrase.lower() in text.lower(), f"ASSET_FIDELITY.md no longer covers: {phrase}"


def test_the_generation_prompt_actually_carries_it():
    # The SECTIONS that apply to one builder, not the whole file. Injecting all of
    # it makes an 11 k-character prompt that risks a `claude -p` timeout, and half
    # of it is plant work that a garden object cannot act on. A number in a brief
    # is a restriction wherever it is written, so "coverage 1.0-2.4" in an object
    # prompt is worse than absent.
    import gen_object as g
    p = g._prompt("tea house", 2.4, 2.6)
    for must in ["The defining property must actually be present",
                 "A flat shape is a line edge-on",
                 "Flat colour is the most obviously computer-generated",
                 ]:
        assert must in p, f"the prompt no longer briefs the model on: {must}"
    # ...and NOT the process checklist. `claude -p` has tools, so an instruction to
    # "run selftest.py" or "open the photograph" is a work order it will carry out —
    # and can consume the full 600 s generation timeout.
    assert "Before you call an asset done" not in p
    assert "selftest.py" not in p, (
        "the brief tells a tool-enabled subprocess to run the test suite; it will")
    # The risk is a numeric TARGET the model will chase, not a worked example. "A
    # grass blade is 2-4 mm" illustrates the absolute-sizes rule and is plainly
    # about grass; "coverage 1.0-2.4" is a number with no meaning for a tea house
    # and a model trying to honour it will invent something to measure.
    for must_not in ["Coverage is leaf/blade area", "plant_photos.py --audit",
                     "visibleArea(masses)"]:
        assert must_not not in p, (
            f"the prompt carries plant-only guidance ({must_not!r}) into an object "
            "builder — that is noise the model will try to honour")
    assert len(p) < 9000, f"{len(p)} chars — a long prompt risks a generation timeout"
    # and the ask comes AFTER the brief, or the brief reads as the task
    assert p.rstrip().endswith("Now write the builder for: tea house")


def test_it_is_READ_not_inlined():
    # The DRY rule this project enforces with tests/test_dry.py, one directory up:
    # a second copy of the method would drift from the first the moment either is
    # edited. Proven by changing the file and watching the prompt change with it,
    # rather than by grepping for a phrase that a copy would also contain.
    import os, gen_object as g
    path = os.path.join(_root(), "ASSET_FIDELITY.md")
    original = open(path, encoding="utf-8").read()
    try:
        # inserted INSIDE a section the generator selects; appending to the end of
        # the file puts it under the process checklist, which is deliberately not
        # sent to a tool-enabled subprocess
        marker = "## 8. Flat colour"
        assert marker in original, "ASSET_FIDELITY.md lost the section this test uses"
        with open(path, "w", encoding="utf-8") as f:
            f.write(original.replace(
                marker, marker + "\n\nSENTINEL-c0ffee: a rule added by the test.\n", 1))
        # The sentinel is in a selected section, so its absence means the file is
        # not being read, rather than the section not being selected.
        assert "SENTINEL-c0ffee" in g._prompt("tea house", 2.4, None), (
            "editing ASSET_FIDELITY.md did not change the prompt — the method has "
            "been inlined into gen_object.py and there are now two copies")
    finally:
        with open(path, "w", encoding="utf-8") as f:
            f.write(original)
    assert open(path, encoding="utf-8").read() == original


def test_a_missing_document_warns_rather_than_silently_dropping_it():
    # Failing loudly matters more than failing safe here: a builder briefed on
    # mechanics alone still verifies, still renders, and is still a placeholder —
    # so the one thing that must not happen is losing the brief quietly.
    import os, gen_object as g
    path = os.path.join(_root(), "ASSET_FIDELITY.md")
    original = open(path, encoding="utf-8").read()
    try:
        os.rename(path, path + ".hidden")
        assert g._fidelity_brief() == ""
    finally:
        os.rename(path + ".hidden", path)
    assert open(path, encoding="utf-8").read() == original
