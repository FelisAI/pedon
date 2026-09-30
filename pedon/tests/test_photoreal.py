"""Path-tracing one view, and the three ways that lies if you let it.

Photorealistic rendering can mean two different things. TRUTHFUL path-traces the
geometry that is really there. GENERATIVE conditions a diffusion model on the
frame — prettier and faster, but it can change species, invent windows and move
stones. These tests require truthful rendering and guard against ways even a
truthful renderer can mislead.
"""
import pytest
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import photoreal  # noqa: E402

SRC = open(os.path.join(ROOT, "tools", "photoreal.py")).read()


def _code_only(src):
    """Source with comments AND DOCSTRINGS removed.

    Absence assertions must ignore prose that names the thing they forbid.
    Comments and docstrings can explain why a generative model is excluded
    without using one. Stripping `#` lines is not enough when a module explains
    itself in triple quotes.
    """
    import ast
    tree = ast.parse(src)
    drop = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            d = ast.get_docstring(node, clean=False)
            if d is not None and node.body:
                first = node.body[0]
                drop.update(range(first.lineno, (first.end_lineno or first.lineno) + 1))
    lines = src.split("\n")
    return "\n".join("" if i + 1 in drop else l
                     for i, l in enumerate(lines) if not l.strip().startswith("#"))


CODE = _code_only(SRC)


@pytest.mark.needs_site
def test_it_lights_the_scan_at_the_hour_the_scan_was_PHOTOGRAPHED():
    """The plate's own shadows are baked in, and lighting it at another hour puts
    two suns in one frame — the one error you cannot art-direct around.

    Defaulting to the current time can put the sun below the horizon (a measured
    altitude of -21.7 degrees), yielding a truthful night view of a daytime scan.
    """
    got = photoreal.capture_hour()
    assert got, "the capture's own hour is no longer readable from site.json"
    date, hhmm = got
    assert date == "2026-08-24" and hhmm == "17:17", got
    assert "args.when or capture_hour()" in CODE, "the default is not the capture's hour"


def test_the_frame_says_when_its_shadows_are_ARBITRARY():
    """`sun.py position` gives a TRUE compass bearing and is deliberately not
    gated — a bearing of the sky needs only a latitude and a clock. What needs
    north is putting that bearing into THIS SCENE. An uncalibrated capture can
    be 23.3 degrees off, as measured in a reference capture.

    The FILE NAME carries the unverified-bearing warning so a saved render
    cannot lose that caveat and be mistaken for a photograph of the site.
    """
    assert "sun.py" in CODE and '"north"' in CODE, "nothing asks whether north is set"
    assert "BEARING-UNVERIFIED" in CODE, \
        "the filename does not carry the caveat, so the image does not either"
    assert "WARNING" in CODE
    # and it is conditional — a calibrated property must not be labelled a liar
    assert 'stem = "view_BEARING-UNVERIFIED" if refused else "view"' in CODE


def test_it_never_invents_anything():
    """Truthful rendering uses the scene's geometry, never a generative model."""
    for banned in ("diffusion", "stable-diffusion", "img2img", "openai", "anthropic",
                   "api_key", "API_KEY", "replicate", "comfy"):
        assert banned not in CODE, f"photoreal.py reaches for a generative model: {banned}"
    assert "TRUTHFUL, not generative" in SRC


def test_the_geometry_comes_from_the_VIEWER_and_is_not_rebuilt():
    """The viewer is the only place that knows the ENU-to-world yaw, the ground
    under every object, which GLB each species routes to and what growth scale is
    applied. Rebuilding any of it here risks storing world coordinates as ENU,
    an error that is invisible until north is set to a non-zero yaw.
    """
    assert "export_scene" in CODE, "nothing asks the viewer for the placed geometry"
    assert "broker" in CODE, "it does not go through the ONE render-broker client"
    # it must not be reading the design and placing things itself
    for banned in ("enuToWorld", "heightAt(", "buildPlant", "assetName"):
        assert banned not in CODE, f"photoreal.py is rebuilding the scene: {banned}"


def test_the_camera_stands_on_ground_that_was_actually_SCANNED():
    """`data/terrain.json` invents flat ground past the scan edge, and a camera
    on invented ground renders the inside of a hill. `scan_at` returns None off
    the scan; the fallback must not quietly become the filled field.
    """
    assert "def _scan(" in CODE
    body = CODE[CODE.index("def _scan("):CODE.index("def _ground(")]
    assert "scan_at" in body, "the standing point does not come from the raycast"
    assert "terrain.json" not in body and "filled_at" not in body, \
        "the standing point falls back to the INVENTED height field"
    assert "is on scanned ground" in SRC, "nothing reports where it chose to stand"
    # AND THE CALL SITE, not only the function. Using `_ground` instead of `_scan`
    # in camera_for can pass the assertions above while standing on unscanned
    # ground — a pure function is only half a guard.
    cam = CODE[CODE.index("def camera_for("):CODE.index("def main(")]
    assert "_scan(" in cam, "camera_for does not ask whether the ground was scanned"
    assert "g is None" in cam, "an unscanned standing point is not skipped"


def test_up_is_MEASURED_not_assumed():
    """The glTF importer's Y-up to Z-up conversion is a default that can be off,
    and the two conventions differ by a 90-degree rotation about X — which renders
    as a garden hanging from the top of the frame. Measured on this capture:
    extent [41.14, 34.77, 14.77], so up is already axis 2."""
    assert "up is axis" in SRC, "nothing measures which axis is up"
    assert "extent.index(min(extent))" in SRC, \
        "the up axis is asserted rather than read off the geometry"


def test_blenders_own_names_are_not_hardcoded_where_they_have_moved():
    """"NISHITA" names the physical sky in Blender 4.x but is absent in 5.2.
    Names differ between versions, so select by available behaviour rather than
    requiring one spelling."""
    assert "enum_items" in SRC, "the sky model is picked from a hardcoded name"
    assert "MULTIPLE_SCATTERING" in SRC and "NISHITA" in SRC, \
        "the fallback ladder no longer covers both Blender generations"
    # and --python-exit-code must PRECEDE -P, or a script that raised exits 0
    i, j = CODE.index('"--python-exit-code"'), CODE.index('"-P"')
    assert i < j, "--python-exit-code comes after -P, so a failed render reports success"


def test_blender_is_found_the_one_way_every_tool_finds_it():
    """On macOS it is a .app, not on the PATH. One setting says where it is
    (tools/project.py), and a missing executable is reported explicitly."""
    import project
    assert photoreal.BLENDER == project.BLENDER
    assert "no_blender" in CODE, "a missing Blender fails without saying where it looked"


def test_one_setting_says_where_blender_is(monkeypatch):
    import project
    monkeypatch.setenv("PEDON_BLENDER", "/opt/b/blender")
    assert project._blender() == "/opt/b/blender"
    monkeypatch.delenv("PEDON_BLENDER")
    monkeypatch.setenv("YARDTWIN_BLENDER", "/old/name/blender")
    assert project._blender() == "/old/name/blender", "the older setting stopped working"
    monkeypatch.delenv("YARDTWIN_BLENDER")
    monkeypatch.setenv("PATH", "")
    assert project._blender().endswith("Blender.app/Contents/MacOS/Blender")


def test_a_saved_VIEWPOINT_is_preferred_over_a_guess():
    """A saved view is a place the owner decided matters — judging a
    change from one is judging it where they will see it."""
    body = CODE[CODE.index("def camera_for("):CODE.index("def main(")]
    assert body.index("args.viewpoint") < body.index("args.subject"), \
        "a subject guess is tried before the view the owner saved"
    assert "viewpoints" in body


def test_it_is_reachable_by_CLICKING_and_not_only_by_typing():
    """The user works in the viewer, so this capability needs a visible control.

    Decide WHO the tool is for before deciding its shape: the design agent
    needs a callable tool, and the user needs a control in the viewer.
    """
    html = open(os.path.join(ROOT, "viewer", "index.html")).read()
    assert 'id="btnPhotoreal"' in html, "there is no button"
    surfaces = open(os.path.join(ROOT, "viewer", "src", "shell", "surfaces.js")).read()
    assert '"prRow"' in surfaces, "the control is in the retired panel and nothing adopts it"
    cfg = open(os.path.join(ROOT, "viewer", "vite.config.js")).read()
    assert 'url === "/api/photoreal"' in cfg, "the button has nothing to call"
    # and the server SHELLS OUT rather than reimplementing any of it: the sun,
    # the standing point, the up-axis measurement and the UNVERIFIED naming all
    # live in one file so the endpoint cannot drift from the shared renderer
    at = cfg.index('url === "/api/photoreal"')
    body = cfg[at:cfg.index("if (req.method ===", at + 40)]
    assert "photoreal.py" in body
    for banned in ("sun.py", "BEARING-UNVERIFIED", "scan_at"):
        assert banned not in body, f"the endpoint reimplements {banned}"


def test_the_button_says_what_it_costs():
    """Minutes for the first frame of a session. A button that looks stuck is
    indistinguishable from one that is."""
    main = open(os.path.join(ROOT, "viewer", "src", "main.js")).read()
    at = main.index('getElementById("btnPhotoreal")')
    body = main[at:at + 3000]
    assert "slow on purpose" in body or "minute" in body, \
        "nothing tells the user a path-trace takes minutes"
    assert "prReused" in body, "it re-exports 648 MB on every render"
