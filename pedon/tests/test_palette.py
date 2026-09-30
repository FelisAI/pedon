"""The owner's own plant list, as data the design can pull.

The designer should use existing assets where possible to save time and LLM
cost. The palette is a table to read instead of inventing sizes and colours
from memory, which is both cheaper and more correct, because a mature height
is a fact about a plant in this climate and not a thing to guess. Every species
on the owner's list needs a model.

Every entry has to RENDER. A palette listing a species the viewer cannot draw is
worse than no palette: it reads as availability and delivers a grey blob.
"""
import json
import os
import re
import sys

import pytest

# the user's OWN catalogue — what it holds and how complete it is — not the app
pytestmark = pytest.mark.real_library

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import project  # noqa: E402  where the active site's files are
sys.path.insert(0, os.path.join(ROOT, "tools"))

@pytest.fixture(scope="module")
def palette(real_library):
    return os.path.join(real_library, "plant_palette.json")


@pytest.fixture(scope="module")
def plants(palette):
    with open(palette) as f:
        return json.load(f)["plants"]


def js_forms():
    """PLANT_FORMS out of assets.js — read, never transcribed. A second copy of
    this list can drift from the viewer's supported forms."""
    src = open(os.path.join(ROOT, "viewer", "src", "assets.js")).read()
    block = re.search(r"export const PLANT_FORMS = \[(.*?)\];", src, re.S)
    assert block, "PLANT_FORMS moved; fix this parse rather than deleting the check"
    return set(re.findall(r'"(\w+)"', block.group(1)))


def test_the_whole_shortlist_is_here(plants):
    """The shortlist includes the owner's 52 species, five cat-safe selections
    and eight Mediterranean and Californian salvias. The count is pinned so a
    species cannot leave quietly; the required names must also be present,
    because a count alone would let one be swapped for another."""
    assert len(plants) >= 107, f"{len(plants)} species"
    assert len({p["species"] for p in plants}) == len(plants), "a species is listed twice"
    requirements = json.load(open(project.data("plant_requirements.json")))['requirements']
    assert len(requirements) == 70
    assert {r['species'] for r in requirements} <= {p['species'] for p in plants}


def test_every_form_is_one_the_viewer_can_actually_draw(plants):
    forms = js_forms()
    bad = sorted({p["form"] for p in plants} - forms)
    assert not bad, f"these forms render as nothing: {bad}; viewer knows {sorted(forms)}"


def test_every_colour_is_a_colour(plants):
    """Colours must be six-digit hex values: three.js parses an invalid value
    such as '#b municipal' as black, giving a plant the wrong flower colour."""
    bad = [(p["species"], k, p[k]) for p in plants for k in ("foliage", "flower")
           if not re.fullmatch(r"#[0-9a-fA-F]{6}", p[k])]
    assert not bad, f"not hex colours: {bad}"


def test_sizes_are_metres_and_plausible(plants):
    for p in plants:
        h, w = p["mature_height_m"], p["mature_spread_m"]
        assert 0.02 < h < 12, f"{p['species']}: {h} m tall is not a plant in metres"
        assert 0.05 < w < 12, f"{p['species']}: {w} m wide"
        # A plant much taller than wide is a column or a strap, not a mound.
        if p["form"] == "mound":
            assert h <= w * 2.2, f"{p['species']} is not mound-shaped at {h}x{w}"


def test_every_palette_size_is_one_the_design_schema_accepts(plants):
    """A 0.05 m Pink Chintz creeping thyme cannot be planted if
    schema/design.schema.json imposes a 0.1 m floor on `mature_height_m`.
    `place_plants` COPIES the palette's sizes into the design, so the palette's
    range has to sit inside the schema's. The bounds are read out of the schema,
    never restated: the plausibility test's 0.02 m floor alone does not establish
    that the schema accepts a size."""
    with open(os.path.join(ROOT, "schema", "design.schema.json")) as f:
        props = json.load(f)["properties"]["plants"]["items"]["properties"]
    checked = 0
    for p in plants:
        for field in ("mature_height_m", "mature_spread_m"):
            lo, hi = props[field]["minimum"], props[field]["maximum"]
            assert lo <= p[field] <= hi, (
                f"{p['common']} ({p['species']}): {field} {p[field]} is outside the "
                f"schema's {lo}..{hi}, so it cannot be planted at all")
            checked += 1
    assert checked == 2 * len(plants) and checked > 200, "the loop checked nothing"


def test_the_forms_are_spread_across_silhouettes(plants):
    """Representing 44 species as "mound" makes massed planting read as wallpaper.
    The list has real grasses, rushes, mats and meadow annuals in it and the
    palette has to say so."""
    from collections import Counter
    c = Counter(p["form"] for p in plants)
    assert len(c) >= 8, f"only {len(c)} silhouettes across 52 plants: {dict(c)}"
    # A FRACTION, not a count. A cap of 20 in a palette of 57 is 35%, but a fixed
    # count fails as the palette grows even if its proportions stay the same.
    # For example, 22 mounds out of 65 species is 33.8%, within the limit.
    top, n = c.most_common(1)[0]
    assert n <= len(plants) * 0.40, (
        f'"{top}" is {n} of {len(plants)} ({100 * n / len(plants):.1f}%) — one form '
        f"swallows the palette: {dict(c)}")


def test_the_owners_own_caution_survived(plants):
    """The owner's cat-toxicity concern about lavender is ground truth about
    their household, exactly like a landmark, and it must not be smoothed away
    into a tidy row of horticultural data."""
    lav = next(p for p in plants if "Lavandula" in p["species"])
    assert "CAT" in lav["note"].upper(), "the cat warning is gone from the lavender"


def test_natives_are_marked(plants):
    """The brief's first section is CALIFORNIA NATIVES; a design that wants a
    native palette has to be able to filter for one."""
    natives = [p for p in plants if p["ca_native"]]
    assert len(natives) >= 20
    assert not next(p for p in plants if p['species'] == "Verbena lilacina 'De La Mina'")['ca_native']
    assert any("Arctostaphylos" in p["species"] for p in natives)


def test_the_designer_can_pull_the_palette(tmp_path):
    """Use existing assets to save time and LLM cost.

    A file on disk is not a capability. The palette only saves anything if the
    design agent can discover and read it mid-design without knowing a filename.
    """
    import subprocess
    req = [{"jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                       "clientInfo": {"name": "t", "version": "1"}}},
           {"jsonrpc": "2.0", "method": "notifications/initialized"},
           {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": {"name": "list_assets",
                       "arguments": {"kind": "plants", "native_only": True,
                                     "form": "grass"}}}]
    out = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "view_mcp.py")],
                         input="\n".join(json.dumps(r) for r in req) + "\n",
                         capture_output=True, text=True, timeout=60, cwd=ROOT).stdout
    body = None
    for line in out.splitlines():
        try:
            m = json.loads(line)
        except ValueError:
            continue
        if m.get("id") == 2:
            body = json.loads("\n".join(c["text"] for c in m["result"]["content"]))
    assert body is not None, f"the tool returned nothing:\n{out[:800]}"
    pal = body["palette"]
    assert pal, "filtering to native grasses returned nothing; the filters are dead"
    assert any("Muhlenbergia" in r for r in pal), pal
    assert all("m |" in r for r in pal), "rows carry no mature size, which is the point"
    assert not any("Olea" in r for r in pal), "an olive is neither a grass nor native"


def test_the_cat_flag_never_claims_safety_it_was_not_told(plants):
    """Cats have access to the site: do not introduce plants known to be toxic
    to cats.

    The honest shape is three states, not two. TRUE means the species is on the
    owner's researched cat-safe shortlist, which is the authority here.
    FALSE means the owner flags a concern, as with lavender. NULL means NOT ASSESSED.

    A two-state flag requires a guess for unassessed species. Defaulting 42 such
    species to "safe" produces a confident wrong answer about an animal without
    a veterinary source. The tool must NOT claim knowledge it does not have.
    """
    states = {}
    for p in plants:
        assert "cat_safe" in p, f"{p['species']} has no cat_safe field at all"
        states[p["cat_safe"]] = states.get(p["cat_safe"], 0) + 1
    assert None in states and states[None] >= 20, (
        f"only {states.get(None, 0)} species are marked unassessed — a palette that "
        f"claims to know the cat toxicity of everything on it is lying: {states}")
    lav = next(p for p in plants if "Lavandula" in p["species"])
    assert lav["cat_safe"] is False, "the lavender the owner flagged is no longer flagged"
    for name in ("Salvia rosmarinus", "Thymus vulgaris"):
        p = next(x for x in plants if x["species"] == name)
        assert p["cat_safe"] is True and p['cat_safety']['sources'], f"{name} needs linked taxon evidence"
    for name in ("Arctostaphylos spp.", "Muhlenbergia rigens"):
        assert next(x for x in plants if x['species'] == name)['cat_safe'] is None


def test_the_file_says_out_loud_that_it_is_not_a_veterinary_source(palette):
    with open(palette) as f:
        doc = json.load(f)
    note = doc.get("cat_safe_note", "")
    assert "not" in note.lower() and "veterinary" in note.lower(), note
    assert "NULL" in note or "not assessed" in note.lower(), note


def test_the_five_new_species_arrived(plants):
    """The owner's five cat-safe selections must be present. The total belongs
    in test_the_whole_shortlist_is_here — repeating it here would require edits
    to this test whenever an unrelated species is added."""
    for sp in ("Festuca idahoensis 'Tomales Bay'", "Festuca 'Siskiyou Blue'",
               "Lomandra", "Salvia officinalis 'Berggarten'", "Origanum majorana"):
        assert any(p["species"] == sp for p in plants), f"{sp} was not added"


# ── the salvias ──────────────────────────────────────────────────────────────
#
# Mediterranean planting needs salvias with contrasting habits and leaf shapes:
# upright spikes for borders, shade-tolerant plants and carpeting forms. Nine
# mounds in eleven salvias make a narrow palette; rendering eight of eleven as
# the bit-identical mesh compounds that lack of variety (tests/js/salvia.test.mjs
# checks the renderer).

SALVIA = re.compile(r"salvia|rosmarinus|\bsage\b", re.I)


def salvias(plants):
    return [p for p in plants if SALVIA.search(f"{p['species']} {p['common']}")]


def test_the_salvias_are_a_range_not_one_plant_repeated(plants):
    """A Mediterranean scheme needs contrasting habits. `perennial` is the
    border shape — a basal clump under spikes — and `mat` runs over a slope top.
    The renderer supports both, and the salvia palette must include them."""
    sal = salvias(plants)
    forms = {p["form"] for p in sal}
    have = {f: [p["common"] for p in sal if p["form"] == f] for f in sorted(forms)}
    assert "perennial" in forms, f"no salvia stands up out of a clump: {have}"
    assert "mat" in forms, f"no salvia carpets: {have}"
    from collections import Counter
    c = Counter(p["form"] for p in sal)
    assert c.most_common(1)[0][1] <= len(sal) * 0.7, (
        f"one habit is {c.most_common(1)[0][1]} of {len(sal)} salvias: {dict(c)}")


def test_there_is_a_salvia_for_shade(plants):
    """The palette needs a shade-tolerant salvia for north-facing ground and
    beneath trees. Salvia spathacea suits these locations and is a California
    native."""
    shady = [p["common"] for p in salvias(plants) if p["sun"] != "sun"]
    assert shady, "every salvia in the palette demands full sun"


def test_the_mediterranean_salvias_arrived(plants):
    """The species a designer working Sunset 16 / USDA 10a actually reaches for.
    Named one by one rather than counted, so deleting one is a failure and not a
    silent shrink."""
    by_species = {p["species"] for p in plants}
    for sp in ("Salvia leucantha", "Salvia nemorosa 'Caradonna'", "Salvia spathacea",
               "Salvia 'Bee's Bliss'", "Salvia chamaedryoides", "Salvia mellifera",
               "Salvia argentea", "Salvia lavandulifolia"):
        assert sp in by_species, f"{sp} was not added"


def test_nothing_new_claims_to_know_a_cats_business(plants):
    """cat_safe has three states and NULL means NOT ASSESSED. TRUE is the owner's
    own shortlist and nothing else may set it — a design tool with no veterinary
    source behind it inventing a safety claim about an animal is this project's
    worst available failure. Species outside the owner's list remain null."""
    added = ("Salvia leucantha", "Salvia nemorosa 'Caradonna'", "Salvia spathacea",
             "Salvia 'Bee's Bliss'", "Salvia chamaedryoides", "Salvia mellifera",
             "Salvia argentea", "Salvia lavandulifolia")
    for sp in added:
        p = next((x for x in plants if x["species"] == sp), None)
        if p is None:
            continue
        assert p["cat_safe"] is None, f"{sp} claims cat_safe={p['cat_safe']!r}, which nobody told it"


def test_every_row_is_complete_and_in_the_vocabulary(plants):
    """A half-filled row is worse than a missing one: the design agent pulls
    these straight into a plant op."""
    # Required catalog contract; optional taxon-specific reference links,
    # dormancy and flowering heights must not become mandatory by row order.
    keys = set("species common form mature_height_m mature_spread_m foliage flower water sun evergreen ca_native bloom note cat_safe aliases requested_for_project establishment_irrigation cat_safety identity_status selection_status site_zone mature_height_range_m mature_spread_range_m size_evidence model_quality".split())
    for p in plants:
        assert keys <= set(p.keys()), f"{p['species']} is missing fields: {keys - set(p)}"
        assert p["water"] in ("very_low", "low", "moderate"), (p["species"], p["water"])
        assert p["sun"] in ("sun", "sun_part", "part_shade"), (p["species"], p["sun"])
        assert isinstance(p["evergreen"], bool) and isinstance(p["ca_native"], bool)
        assert re.fullmatch(r"[a-z_]+", p["bloom"]), (p["species"], p["bloom"])
        assert len(p["note"]) > 20, f"{p['species']}: the note says nothing worth reading"
