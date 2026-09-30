"""The reference photograph must be of the right plant, and of the whole plant.

A model is built from a real photograph of the mature plant, never imagined:
every leaf size, habit and colour in plants.js is checked against
data/refphotos/ rather than recalled.

So the failure this file guards is not "the fetch broke". It is a photograph that
is quietly of something else. In one measured cached set, 27 of 65 were unusable
and four were a DIFFERENT ORGANISM — a Castilleja filed as Penstemon, an
Australian Eremophila as Fremontodendron, a photograph of a Spanish mountain
range as Arctostaphylos, and a beach as Gilia. Nothing on disk says so, and a
session tuning those four would model the wrong plant with full confidence.

The sort key must test BAD before GOOD: the other way round, a title matching
both — "Lomandra plant illustration.jpg" — beats every clean candidate.
"""
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import plant_photos as pp  # noqa: E402


def best(titles, species, common=""):
    """Which of these titles the ranker would pick for this plant."""
    names = pp.accepted_names(species, common)
    return min(titles, key=lambda t: pp.rank_key(t, names, titles.index(t)))


# ── the bug itself ────────────────────────────────────────────────────────

def test_a_drawing_loses_to_a_photo_even_when_it_says_plant():
    # the exact pair that makes a naive ranker cache a line drawing for Lomandra
    assert best(["File:Lomandra plant illustration .jpg",
                 "File:Lomandra filiformis0.jpg"], "Lomandra") \
        == "File:Lomandra filiformis0.jpg"


def test_the_wrong_genus_loses_to_the_right_one_however_it_is_titled():
    # Commons is relevance-ranked, so a thin species returns a neighbour. Each of
    # these four pairs is a real result that a naive ranker caches.
    for titles, species in [
        (["File:Castilleja christii 3.jpg", "File:Penstemon gairdneri.jpg"], "Penstemon spp."),
        (["File:Eremophila bowmanii.jpg", "File:Fremontodendron californicum.jpg"],
         "Fremontodendron spp."),
        (["File:Sierra de Ayllon 1979 03.jpg", "File:Arctostaphylos uva-ursi 4 RF.jpg"],
         "Arctostaphylos spp."),
        (["File:Morro Strand State Beach (1).jpg", "File:Gilia achilleifolia NPS.jpg"],
         "Gilia spp."),
    ]:
        assert best(titles, species) == titles[1], species


def test_naming_the_plant_beats_a_habit_word():
    # a candidate that does not name the plant must lose even to a plain title
    # that carries no habit word at all — being the right organism outranks
    # being a good photograph of the wrong one
    assert best(["File:Beautiful garden shrub habit whole plant.jpg",
                 "File:Salvia apiana 4.jpg"], "Salvia apiana") == "File:Salvia apiana 4.jpg"


def test_the_plant_must_be_the_subject_not_a_bystander():
    # a spider on a santolina and a butterfly on a lavender both come back as
    # habit references; both name the plant, so only word ORDER separates them
    assert best(["File:(MHNT) Oxyopes lineatus sur Santolina chamaecyparissus.jpg",
                 "File:Santolina chamaecyparissus MG 5715 01.jpg"],
                "Santolina chamaecyparissus") == "File:Santolina chamaecyparissus MG 5715 01.jpg"
    assert best(["File:Vanessa cardui on Lavandula angustifolia-2459.jpg",
                 "File:Lavandula angustifolia - lavender.jpg"],
                "Lavandula angustifolia") == "File:Lavandula angustifolia - lavender.jpg"


# ── the other direction: it must not reject the RIGHT photograph ──────────

def test_a_renamed_genus_is_still_the_same_plant():
    # Salvia rosmarinus IS Rosmarinus officinalis and Oenothera lindheimeri IS
    # Gaura lindheimeri. A bare genus test rejects both correct photographs.
    assert "rosmarinus" in pp.accepted_names("Salvia rosmarinus", "Rosemary")
    assert "gaura" in pp.accepted_names("Oenothera lindheimeri", "Gaura")
    assert pp.rank_key("File:Rosmarinus officinalis133095382.jpg",
                       pp.accepted_names("Salvia rosmarinus", "Rosemary"), 0)[0] == 0


def test_the_common_name_counts_as_naming_the_plant():
    for title, sp, common in [
        ("File:Strawberry bush.jpg", "Fragaria spp.", "Wild strawberry"),
        ("File:Baby Blue Eyes o.jpg", "Nemophila menziesii", "Baby blue eyes"),
        ("File:Hummingbird sage.jpg", "Salvia spathacea", "Hummingbird sage"),
        # filed singular, listed plural
        ("File:Goldfield Flowers.jpg", "Lasthenia spp.", "Goldfields"),
    ]:
        assert pp.rank_key(title, pp.accepted_names(sp, common), 0)[0] == 0, title


def test_the_spp_placeholder_never_reaches_the_query():
    # "Penstemon spp." searched literally is what returns the Castilleja: the
    # placeholder appears in no filename, so it only dilutes the search
    for sp in ["Penstemon spp.", "Gilia spp.", "Olea europaea (fruitless)"]:
        for t in pp.search_terms(sp, ""):
            assert "spp" not in t.lower(), t
            assert "(" not in t, t


# ── the corpus on disk ────────────────────────────────────────────────────

@pytest.mark.real_library
def test_the_cached_reference_set_is_overwhelmingly_usable(real_library, monkeypatch):
    # the user's own photographs and catalogue: the tool read their paths at import, from
    # the fixture library every other test reads
    monkeypatch.setattr(pp, "OUT", os.path.join(real_library, "refphotos"))
    monkeypatch.setattr(pp, "INDEX", os.path.join(real_library, "refphotos", "index.json"))
    idx = pp.load_index()
    if not idx:
        pytest.skip("no reference photos cached")
    pal = {p["species"]: p for p in pp.palette()}
    bad = []
    for r in idx.values():
        # AN OWNER PHOTO HAS NO TITLE TO RANK. This whole check reads a Commons
        # title to ask "is this a photograph of a different plant" — and it has
        # to, because a genus-only entry is often of another species. An owner row
        # is the one case where that question cannot be asked and does not need
        # to be: the owner was standing in front of the plant.
        if r.get("source") == "owner":
            assert r.get("species"), f"an owner photo of nothing in particular: {r}"
            continue
        p = pal.get(r["species"])
        if not p:
            continue
        names = pp.accepted_names(p["species"], p.get("common", ""))
        if pp.rank_key(r["title"], names, 0)[0]:
            bad.append(r["species"])
    assert not bad, f"cached photos of a different plant: {bad}"


# ── a genus hint names a SPECIES, and another species is not an answer ──
#
# `accepted_names` tests the GENUS on purpose — a bare-genus test in the other
# direction would reject "Rosmarinus officinalis" for Salvia rosmarinus, which is
# the right plant under an old name. But that leaves the rank blind one rank down:
# measured across one cache, TEN of the twenty-two bare-genus entries were filled
# from a different species of the right genus, and every one passes a genus audit.
#
# The worst of them is not subtle: the palette's "Arctostaphylos spp." is a 2.5 m
# sculptural shrub with mahogany limbs, and the cached photograph can be
# A. uva-ursi — a prostrate mat that never leaves the ground. A session tuning a
# manzanita model from it would be modelling the wrong plant, confidently,
# which is exactly the failure the audit is built for.

def test_a_different_species_of_the_right_genus_is_demoted():
    from plant_photos import rank_key, accepted_names
    names = accepted_names("Arctostaphylos spp.", "Manzanita")
    hinted = rank_key("File:Arctostaphylos densiflora Howard McMinn.jpg", names, 0,
                      "Arctostaphylos spp.")
    other = rank_key("File:Arctostaphylos uva-ursi 4 RF.jpg", names, 0,
                     "Arctostaphylos spp.")
    assert hinted < other, (
        "a photo of the species the hint names must beat one of a different "
        "species of the same genus")
    assert other[1] == 1 and hinted[1] == 0


def test_a_title_naming_only_the_genus_is_NOT_demoted():
    # the other half, and the one that keeps this from being too strict: for a
    # genus whose garden forms all look alike, a title that names no species is
    # often the best photograph available and contradicts nothing.
    from plant_photos import rank_key, accepted_names, names_other_species
    names = accepted_names("Ceanothus spp.", "California lilac")
    assert not names_other_species("File:Ceanothus flowers in seattle.JPG", "Ceanothus spp.")
    assert not names_other_species("File:Cistus spp., or Rock Rose.jpg", "Cistus spp.")
    genus_only = rank_key("File:Ceanothus flowers in seattle.JPG", names, 0, "Ceanothus spp.")
    assert genus_only[1] == 0


def test_the_hint_resolves_a_bare_genus_and_a_binomial_alike():
    from plant_photos import wanted_species
    assert wanted_species("Arctostaphylos spp.") == "Arctostaphylos densiflora"
    assert wanted_species("Salvia apiana") == "Salvia apiana"
    assert wanted_species("Olea europaea (fruitless)") == "Olea europaea"
    # an unhinted bare genus resolves to nothing rather than guessing an epithet
    assert wanted_species("Nothingia spp.") == ""


def test_a_named_binomial_also_rejects_a_sibling_species():
    # not only the hinted genera: the palette has eighteen Salvias, and Commons
    # will answer any of them with any other.
    from plant_photos import rank_key, accepted_names, names_other_species
    assert names_other_species("File:Salvia mellifera flowers.jpg", "Salvia apiana")
    assert not names_other_species("File:Salvia apiana 4.jpg", "Salvia apiana")
    names = accepted_names("Salvia apiana", "White sage")
    right = rank_key("File:Salvia apiana 4.jpg", names, 0, "Salvia apiana")
    wrong = rank_key("File:Salvia mellifera flowers.jpg", names, 0, "Salvia apiana")
    assert right < wrong


def test_every_bare_genus_entry_now_has_the_species_the_hint_names():
    # the ratchet: the measurement that finds the problem, kept as an
    # assertion so the cache cannot drift back
    import json, os, re
    from plant_photos import names_other_species, OUT
    path = os.path.join(OUT, "index.json")
    if not os.path.exists(path):
        return                                   # nothing cached; nothing to check
    idx = json.load(open(path))
    pal = json.load(open(os.path.join(os.path.dirname(OUT), "plant_palette.json")))
    bad = []
    for p in pal["plants"]:
        key = re.sub(r"[^a-z0-9]+", "_", p["species"].lower()).strip("_")
        row = idx.get(key)
        if row and names_other_species(row.get("title", ""), p["species"]):
            bad.append(f"{p['species']} -> {row['title']}")
    assert not bad, (
        "cached photographs of the wrong species (run "
        "`python3 tools/plant_photos.py --audit --refetch-suspect`):\n  "
        + "\n  ".join(bad))
