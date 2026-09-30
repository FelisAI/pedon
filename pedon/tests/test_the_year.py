"""The garden through the year, measured.

The method asks the designer to plan all four seasons — the step world-class planting
design never skips. Measured on two naturalism designs: NOTHING in flower in winter. This
is the instrument: per season, the share of the ground-layer canopy in flower
and its colours, from the catalogue, and the evergreen share. Reported, never a score.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools"))
import site_api  # noqa: E402


def p(species, spread=1.0, h=0.5):
    return {"id": species, "species": species, "position": [0, 0], "mature_height_m": h, "mature_spread_m": spread}


def test_a_bloom_range_runs_forward_through_the_year():
    assert site_api.seasons_of("summer_autumn") == ["summer", "autumn"]
    assert site_api.seasons_of("spring_autumn") == ["spring", "summer", "autumn"], "the summer between"
    assert site_api.seasons_of("winter_spring") == ["winter", "spring"]
    assert site_api.seasons_of("autumn_winter") == ["autumn", "winter"]
    assert site_api.seasons_of("late_spring") == ["spring"]
    assert site_api.seasons_of(None) == []


def test_flower_colours_are_named_as_a_designer_says_them():
    names = {h: site_api.colour_family(h) for h in
             ("#4a3a86", "#f0993a", "#efc82d", "#df4b33", "#d98cb0", "#5470b8", "#f2efe6", "#9a2f7d")}
    assert names == {"#4a3a86": "violet", "#f0993a": "orange", "#efc82d": "yellow", "#df4b33": "red",
                     "#d98cb0": "pink", "#5470b8": "blue", "#f2efe6": "white/cream", "#9a2f7d": "magenta"}, names


def test_the_year_reads_the_catalogue_by_canopy_and_leaves_trees_out():
    # Caradonna sage: spring_summer, violet, not evergreen; California poppy: spring, orange;
    # Muhly: autumn, pink, evergreen. The olive (a tree) is overhead and not counted.
    ps = [p("Salvia nemorosa 'Caradonna'", 1.0), p("Eschscholzia californica", 1.0),
          p("Muhlenbergia capillaris", 2.0), p("Olea europaea", 4.0, h=5.0)]
    y = site_api.the_year(ps)
    total = 1 + 1 + 4                                      # spread squared, pi cancels
    assert y["spring"]["in_flower"] == round(2 / total, 2), y["spring"]
    assert set(y["spring"]["colours"]) == {"violet", "orange"}, y["spring"]
    assert y["summer"]["colours"] == {"violet": round(1 / total, 2)}, y["summer"]
    assert y["autumn"]["colours"] == {"pink": round(4 / total, 2)}, y["autumn"]
    assert y["winter"]["in_flower"] == 0
    assert y["evergreen"] == round(4 / total, 2), y


def test_composition_carries_it():
    d = {"plants": [p("Salvia nemorosa 'Caradonna'")]}
    assert "the_year" in site_api.planting_character(d)
