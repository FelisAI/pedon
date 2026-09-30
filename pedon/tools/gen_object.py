"""Turn a WANT into an asset: have the model write a procedural builder, then verify it.

    python3 tools/wants.py                       # what is missing
    python3 tools/gen_object.py --kind "tea house" --height 2.4 --width 2.6

`kind` is free text so the design can ask for anything, and wants.py makes
what is missing enumerable. Neither of those BUILDS anything, and hand-writing a
builder whenever someone notices an amber placeholder in a render does not scale
to the tea house, the koi pond and the pagoda the next design will want. A missing
asset should be found or generated; this is the generating half.

THE WHOLE RISK is writing something plausible and broken into viewer/src/objects.js,
which the viewer imports at module scope: one syntax error blanks the app. So the
shape is generate -> VERIFY BY RUNNING IT -> keep or revert, never generate-and-hope.
Verification runs node against a COPY, and the real file is only touched once a
candidate has actually rendered.

No API keys: `claude -p` is the backend, like everything else here.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import objects_index as oi   # noqa: E402

OBJECTS_JS = os.path.join(ROOT, "viewer", "src", "objects.js")
THREE_URL = "../../viewer/node_modules/three/build/three.module.js"


def _slug(kind):
    return re.sub(r"[^a-z0-9]+", "_", str(kind).strip().lower()).strip("_")


def _strip_fences(text):
    m = re.search(r"```(?:js|javascript)?\s*(.*?)```", text or "", re.S)
    return (m.group(1) if m else (text or "")).strip("\n")


def _insert(src, builder, kind):
    """Put the builder into BUILDERS and an alias in ALIASES. Returns new source."""
    name = _slug(kind)
    anchor = "  pergola: (h, w) => {"
    if anchor not in src:
        raise ValueError("objects.js has no pergola builder to anchor on; fix this insert")
    # NORMALISE THE INDENT. A builder returned at column 0 passes every other
    # check — it parses, it renders, resolveKind finds it through the alias —
    # while `known_kinds()` cannot see it at all, because that reads
    # `^\s{2}(\w+):` out of the BUILDERS block. The asset is HALF REGISTERED:
    # buildable by the viewer, invisible to wants.py and list_assets, so the
    # design agent never learns it exists. Verification checks for this too;
    # this makes it not happen in the first place.
    lines = [l for l in builder.splitlines() if l.strip()]
    pad = min((len(l) - len(l.lstrip()) for l in lines), default=0)
    body = "\n".join(("  " + l[pad:]) if l.strip() else l for l in builder.splitlines()) + "\n"
    src = src.replace(anchor, body + anchor, 1)
    words = [w for w in re.split(r"[^a-z0-9]+", str(kind).lower()) if w]
    alias = "|".join(re.escape(w) for w in words) if len(words) == 1 else \
        re.escape(" ".join(words)).replace(r"\ ", r" ?_?")
    rule = f'  [/{alias}/i, "{name}"],\n'
    marker = '  [/pergola|arbou?r|gazebo|ramada/i, "pergola"],'
    if marker not in src:
        raise ValueError("objects.js ALIASES moved; fix this insert")
    return src.replace(marker, rule + marker, 1)


def verify(path, kind, height_m=None, width_m=None):
    """Run node against this objects.js and see whether the kind really builds.

    Returns (ok, why). Every check here exists because the failure it catches
    would otherwise reach the viewer: a syntax error blanks the app, an empty
    group is a placeholder with extra steps, and a builder that ignores the size
    it was handed puts a twelve-metre tea house in a back garden.
    """
    name = _slug(kind)
    # ABSOLUTE. The probe is written into tests/js/ and imports this path, so a
    # relative one resolves against the wrong directory and comes back as
    # "syntax error" — a verification that fails for a reason having nothing to do
    # with the builder, which is the most misleading answer this function can give.
    path = os.path.abspath(path)
    h = float(height_m or 1.8)
    w = float(width_m or 0)
    probe = f"""
import * as THREE from "{THREE_URL}";
globalThis.document = {{ createElement() {{
  const c = {{ fillStyle:"#000", fillRect(){{}}, fillText(){{}}, measureText:()=>({{width:10}}),
             beginPath(){{}}, arc(){{}}, fill(){{}}, stroke(){{}},
             createLinearGradient:()=>({{addColorStop(){{}}}}) }};
  return {{ width:0, height:0, getContext:()=>c }}; }} }};
const o = await import({json.dumps(path)});
const resolved = o.resolveKind({json.dumps(kind)});
if (resolved !== {json.dumps(name)}) {{
  console.log(JSON.stringify({{ ok:false, why:`resolveKind gave ${{resolved}}` }})); process.exit(0);
}}
const g = o.objectMesh({{ id:"probe", kind:{json.dumps(kind)}, position:[0,0],
                         height_m:{h}, width_m:{w} }}, () => 0);
if (g.userData.placeholder) {{
  console.log(JSON.stringify({{ ok:false, why:"still resolves to the placeholder" }})); process.exit(0);
}}
g.updateMatrixWorld(true);
let n = 0; const box = new THREE.Box3();
g.traverse(x => {{ const p = x.geometry?.attributes?.position; if (!p) return;
                  n += p.count; box.expandByObject(x); }});
const size = box.isEmpty() ? {{x:0,y:0,z:0}} : box.getSize(new THREE.Vector3());
console.log(JSON.stringify({{ ok:true, verts:n, minY:box.isEmpty()?null:box.min.y,
                             height:size.y, width:Math.max(size.x,size.z) }}));
"""
    with tempfile.NamedTemporaryFile("w", suffix=".mjs", dir=os.path.join(ROOT, "tests", "js"),
                                     delete=False) as f:
        f.write(probe)
        probe_path = f.name
    try:
        out = subprocess.run(["node", probe_path], capture_output=True, text=True,
                             cwd=ROOT, timeout=90)
    finally:
        os.unlink(probe_path)
    if out.returncode != 0:
        err = (out.stderr or "").strip().splitlines()
        first = next((l for l in err if l.strip()), "node failed")
        return False, f"it does not even parse or run — syntax error: {first[:200]}"
    try:
        r = json.loads(out.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return False, f"the probe printed nothing usable: {out.stdout[-200:]}"
    if not r.get("ok"):
        return False, r.get("why", "rejected")
    if _slug(kind) not in oi.known_kinds(path=path):
        return False, ("it builds but the BUILDERS block does not list it at the right "
                       "indent, so wants.py and list_assets cannot see it — the asset "
                       "would be invisible to the design agent")
    if r["verts"] < 24:
        return False, f"it draws almost nothing ({r['verts']} vertices) — that is a placeholder"
    if r["minY"] is None or r["minY"] < -0.35:
        return False, f"its base sits at {r['minY']} m — it is buried, not standing on the ground"
    if r["minY"] > 0.35:
        return False, f"its base floats {r['minY']:.2f} m above the ground"
    if height_m and not (0.5 * h <= r["height"] <= 1.8 * h):
        return False, (f"asked for {h} m tall and it built {r['height']:.2f} m — "
                       f"it ignored the size it was given")
    return True, f"{r['verts']} vertices, {r['height']:.2f} m tall, base at {r['minY']:.2f} m"


def install(path, kind, builder, height_m=None, width_m=None):
    """Insert a candidate builder and keep it ONLY if it verifies. (ok, why)."""
    if oi.resolve_kind(kind, path=path):
        return False, f'"{kind}" already builds as {oi.resolve_kind(kind, path=path)}'
    with open(path) as f:
        before = f.read()
    try:
        after = _insert(before, builder, kind)
    except ValueError as e:
        return False, str(e)
    with open(path, "w") as f:
        f.write(after)
    ok, why = verify(path, kind, height_m, width_m)
    if not ok:
        with open(path, "w") as f:      # revert: a broken objects.js blanks the viewer
            f.write(before)
    return ok, why


HOUSE_STYLE = '''  screen: (h, w) => {                        // a slatted panel: bamboo, timber, reed
    const g = new THREE.Group(), L = w || 1.8, ht = h || 1.8;
    for (let i = 0; i <= 10; i++) {
      const s = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, ht, 6), mat(TIMBER));
      s.position.set(-L / 2 + (L * i) / 10, ht / 2, 0); g.add(s);
    }
    return g;
  },'''


# Which of ASSET_FIDELITY.md's sections apply to writing ONE object builder.
#
# Not the whole file, for two reasons. It is 11 k characters, which pushes
# `claude -p` past the 300 s timeout so the generation fails; and half of it is
# about PLANTS — leaf coverage bands, grass blade widths, when to
# re-derive a card count — which is not merely irrelevant to a tea house but
# actively misleading, because a number in a brief is a restriction wherever it is
# written down. "Coverage 1.0-2.4" means nothing for a garden object
# and a model trying to honour it will invent something.
#
# So the generator SELECTS; it does not restate. ASSET_FIDELITY.md stays the whole
# method for a session to read, and this list is the part a builder can act on.
# NOT the "Before you call an asset done" checklist: every item on it is something
# a SESSION does — open the photo, render one close, break the test and watch it go
# red, run selftest. Handed to a subprocess with tools those are not guidance, they
# are a work order, and it does them instead of answering.
WANTED_SECTIONS = ("3.", "6.", "7.", "8.")


def _sections(text, wanted):
    """The named `## ` sections of a markdown document, in file order."""
    out, keep = [], False
    for line in text.splitlines():
        if line.startswith("## "):
            title = line[3:].strip()
            keep = any(title.startswith(w) for w in wanted)
        if keep:
            out.append(line)
    return "\n".join(out).strip()


def _fidelity_brief():
    """The METHOD, read from ASSET_FIDELITY.md rather than restated here.

    The mechanics — return this shape, be this tall, sit on the ground — are all
    enforced by the verifier below. None of them tells the model what makes an
    object look REAL, and a builder briefed on mechanics alone repeats the familiar
    faults: a screen you can see through, a flat unbroken colour, a lantern with no
    opening, a defining feature present in the name and absent from the geometry.

    Read from the file, never inlined: a second copy of the method drifts from the
    first, like any duplicated lookup or client. If the file is missing the
    generator still runs — a builder briefed on mechanics alone is worse, not
    broken — but it says so, because silently dropping the half that matters is how
    a capability gets built and never used.
    """
    path = os.path.join(ROOT, "ASSET_FIDELITY.md")
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
        return _sections(text, WANTED_SECTIONS)
    except OSError as e:
        print(f"[gen_object] WARNING: no ASSET_FIDELITY.md ({e}) — the model is being "
              f"briefed on mechanics only, and will draw a mechanical object.",
              file=sys.stderr)
        return ""


def _prompt(kind, height_m, width_m, previous_error=None):
    fidelity = _fidelity_brief()
    p = f"""Write ONE procedural builder for viewer/src/objects.js.

The kind is: {kind}
It should stand about {height_m} m tall{f" and {width_m} m across" if width_m else ""}.

This is a landscape design viewer for a real garden. Objects are simple massing —
recognisable at ten metres, not a museum model. Match the house style exactly;
here is a real one from the file:

{HOUSE_STYLE}

RULES, all of them enforced by a verifier that runs your code:
* Return ONLY the builder, as `  {_slug(kind)}: (h, w) => {{ ... }},` — one entry of an
  object literal, two-space indented, with the trailing comma. No imports, no
  prose, no markdown outside one ```js fence.
* `THREE` is in scope. So are the helpers `mat(color, opts)`, and the colour
  constants STONE, DARK_STONE, TIMBER, WATER, METAL.
* It must RETURN a THREE.Group or Mesh, and it must draw real geometry — an empty
  group is rejected.
* Its base must sit ON y = 0, not floating and not buried.
* It must be about `h` tall and use `w` for its width when given. A builder that
  ignores the size it was handed is rejected.
* No textures, no external files, no async, no network.

The rules above are MECHANICS and a verifier checks every one of them. None of them
will make the object look like anything. What follows is the method this project
uses to make an asset read as real; it is not advisory, it is the difference between
an object and a placeholder that happens to be the right size. These are the parts of
pedon/ASSET_FIDELITY.md that apply to writing one builder — sections 6, 7 and 8
are the ones that decide whether yours is any good:

  6  the DEFINING PROPERTY must be in the geometry, not in the name
  7  a flat shape is a line edge-on, and a garden is looked ACROSS
  8  flat colour is the most obviously computer-generated thing in a frame

------------------------------------------------------------------------------
{fidelity}
------------------------------------------------------------------------------

Now write the builder for: {kind}
"""
    if previous_error:
        p += (f"\nThe previous attempt FAILED verification: {previous_error}\n"
              f"Fix that specifically. Do not change approach for its own sake.\n")
    return p


# `claude -p` HAS TOOLS, and this one must not use them.
#
# A prompt carrying ASSET_FIDELITY.md's process steps HANGS — 600 s and no answer,
# against 6 s for a trivial prompt. The brief says to open the reference
# photograph, render one close up and run the suite before and after — and a
# spawned Claude with Bash and Read does exactly that, because they are
# instructions and it can follow them: it runs selftest.py instead of writing a
# builder.
#
# Two fixes, and both are right independently. The process steps are left out of
# the brief (see WANTED_SECTIONS — a one-shot builder writer cannot act on "look at it
# afterwards"), and the subprocess is denied tools here, because what this wants is
# TEXT and not an agent. Without the second, any future rule phrased as an
# instruction re-opens the same hole silently.
NO_TOOLS = ["--allowedTools", "",
            "--disallowedTools", "Bash", "Read", "Write", "Edit", "Glob", "Grep",
            "Task", "WebFetch", "WebSearch", "NotebookEdit"]


def _ask_claude(prompt, timeout_s=900):
    out = subprocess.run(["claude", "-p", prompt, *NO_TOOLS], capture_output=True,
                         text=True, timeout=timeout_s, cwd=ROOT)
    if out.returncode != 0:
        raise RuntimeError(f"claude -p failed: {out.stderr[-300:]}")
    return out.stdout


def generate(kind, height_m=1.8, width_m=None, path=None, ask=None, attempts=3):
    """Ask for a builder, verify it, retry with the reason. (ok, why)."""
    target = path or OBJECTS_JS
    ask = ask or _ask_claude
    why = "no attempt made"
    for i in range(max(1, attempts)):
        try:
            raw = ask(_prompt(kind, height_m, width_m, None if i == 0 else why))
        except FileNotFoundError:
            return False, ("the `claude` CLI is not on PATH — this tool asks it to write "
                           "the builder. Install Claude Code, or write the builder by hand "
                           "into viewer/src/objects.js and check it with --verify-only")
        except Exception as e:
            # A model call that fails is an ordinary outcome, not a crash: a
            # traceback here buries the one line that says what to do about it.
            return False, f"asking the model failed: {type(e).__name__}: {str(e)[-200:]}"
        ok, why = install(target, kind, _strip_fences(raw), height_m, width_m)
        if ok:
            return True, why
    return False, why


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--kind", required=True, help='what to build, e.g. "tea house"')
    ap.add_argument("--height", type=float, default=1.8)
    ap.add_argument("--width", type=float, default=None)
    ap.add_argument("--attempts", type=int, default=3)
    ap.add_argument("--verify-only", action="store_true",
                    help="check a kind that is already in the file")
    a = ap.parse_args(argv)
    if a.verify_only:
        ok, why = verify(OBJECTS_JS, a.kind, a.height, a.width)
    else:
        ok, why = generate(a.kind, a.height, a.width, attempts=a.attempts)
    print(("built" if ok else "NOT built") + f": {a.kind} — {why}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
