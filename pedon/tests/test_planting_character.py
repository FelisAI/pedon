"""A "sea of plants" — planting that reads as one undifferentiated, weird mass — made measurable.

Measured across the saved designs: the one the owner approved
(huajing_naturalism_lower) has 21 species, no touching mass of one species bigger than 7,
and 36% of its plants upright (>= 0.9 m); rounds that read as a sea have 9-14
species, touching masses of 10-15 (28-35 in the fresh designs) and 13-20% upright. So
`composition` REPORTS those numbers — it never refuses them: taste is reported, and the
designer decides (AGENTS.md).
"""
import pytest
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import site_api  # noqa: E402


def _p(i, sp, x, y, h=0.4, s=0.6, form="mat"):
    return {"id": f"p{i}", "species": sp, "position": [x, y], "mature_height_m": h,
            "mature_spread_m": s, "form": form}


def test_a_chain_of_touching_plants_is_one_mass_and_a_gap_breaks_it():
    # six buckwheat touching in a row, then a gap, then three more: the mass is 6, not 9
    plants = [_p(i, "Eriogonum umbellatum", i * 0.55, 0) for i in range(6)] + \
             [_p(10 + i, "Eriogonum umbellatum", 8 + i * 0.55, 0) for i in range(3)]
    c = site_api.planting_character({"plants": plants})
    assert c["largest_mass"] == {"plants": 6, "species": "Eriogonum umbellatum"}


def test_species_forms_and_the_upright_share():
    plants = [_p(0, "A a", 0, 0, form="mat"), _p(1, "B b", 5, 0, h=1.2, form="perennial"),
              _p(2, "C c", 9, 0, h=0.95, form="grass"), _p(3, "A a", 14, 0, form="mat")]
    c = site_api.planting_character({"plants": plants})
    assert c["species"] == 3
    assert c["forms"] == {"mat": 0.5, "perennial": 0.25, "grass": 0.25}
    assert c["upright_share"] == 0.5
    assert c["largest_mass"]["plants"] == 1           # nothing touches anything here


@pytest.mark.needs_site
def test_it_is_in_the_composition_report_and_points_at_the_reference(tmp_path):
    import json
    import subprocess
    # a design of our own, not the owner's saved file: a test built on owner data breaks when they edit it
    design = {"version": 1, "units": "meters", "beds": [], "paths": [], "patios": [],
              "plants": [_p(i, "Eriogonum umbellatum", 12 + i * 0.55, -8) for i in range(5)]
                        + [_p(9, "Salvia apiana", 16, -6, h=1.0, s=1.4, form="mound")]}
    f = tmp_path / "d.json"
    f.write_text(json.dumps(design))
    r = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "site_api.py"), "composition",
                        "--design", str(f)], capture_output=True, text=True, cwd=ROOT)
    c = json.loads(r.stdout)["character"]
    assert c["species"] == 2 and c["largest_mass"]["plants"] == 5 and c["upright_share"] == 0.17
    assert "DESIGNING.md" in c["note"]
