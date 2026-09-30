"""Fetch a REAL photograph of every species in the palette, to model against.

Why this exists
---------------
A plant drawn by a procedural generator whose parameters are chosen from memory —
"a rosemary is needle-like", "a sage is a mound" — gets its shape, colour and
leaves wrong. What makes it fixable is a real photograph of the mature plant for
reference, instead of imagining it.

So the reference is not a memory. It is a file on disk, with the photographer's
name and licence next to it, and a session tuning a plant is expected to open it
and look.

Source is Wikimedia Commons: freely licensed, botanically labelled, and reachable
with no API key — which matters, because the standing constraint on this project
is no Anthropic or OpenAI keys and no paid services. Nothing here is redistributed:
the images live in a gitignored cache and are used the way a photograph pinned
above a drawing board is used.

    python3 tools/plant_photos.py                 # every palette species, cached
    python3 tools/plant_photos.py --species "Muhlenbergia rigens"
    python3 tools/plant_photos.py --list          # what is cached, with licences
    python3 tools/plant_photos.py --missing       # species with no photo yet

A HABIT shot beats a flower macro for this purpose: the thing being modelled is
the silhouette of the whole plant, so the ranking below prefers titles that look
like whole-plant photographs and pushes seed, seedling and microscope shots down.
"""
from __future__ import annotations
import argparse
import json
import os
import project  # the active project's files — the ONE owner
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.environ.get("YARDTWIN_PHOTO_DIR") or project.data("refphotos")
INDEX = os.path.join(OUT, "index.json")
API = "https://commons.wikimedia.org/w/api.php"
# Commons asks for a descriptive agent naming the tool and its purpose.
UA = {"User-Agent": "PEDON/1.0 (local landscape-design tool; plant reference lookup)"}

# A whole-plant photograph is what a silhouette is modelled from. These words in a
# filename usually mean the opposite: a detail, a part, a lab shot or a drawing.
# Multilingual, because Commons is: without "zaaddo", a photo of Agastache
# "zaaddozen" (Dutch for seed pods) passes as a habit shot for the whole species.
BAD = re.compile(r"seed|seedling|keimling|samen|zaaddo|sprout|micro|herbarium"
                 r"|illustration|\billu\b|drawing|dessin|zeichnung|botanical.?plate|map"
                 r"|distribution|leaf\b|leaves|foliage|bl[uü]te|fleur|flor\b|kwiat"
                 r"|inflorescen|close.?up|closeup|macro|detail|dried|specimen|scan"
                 r"|fruit|\bberries\b|bark|stamen|petal|pollen", re.I)
# A GENUS NAME IS NOT ALWAYS A PLANT. `Thymus` is also the human thymus gland, and
# Commons' best match for the bare genus can be an anatomical diagram of it —
# "Illu thymus.jpg" names the genus, has it early in the title and passes every
# test above. A palette often has many rows that are a BARE GENUS, so this is
# not one unlucky species.
NOT_A_PLANT = re.compile(r"\bgland\b|anatomy|anatomical|corpuscle|cortex|medulla"
                         r"|\borgan\b|thorax|abdomen|human|\bmouse\b|\brat\b"
                         r"|histolog|\bcell\b|lymph|immune|diagram", re.I)
# and these usually mean the whole plant, in the ground
GOOD = re.compile(r"\bform\b|habit|plant|bush|shrub|clump|garden|arboretum|habitus"
                  r"|in\s?situ|whole", re.I)


# Genera get renamed and Commons files keep the old name. These are not aliases
# of convenience — each pair is one plant under two accepted botanical names, and
# without them the genus test below rejects the CORRECT photograph.
SYNONYMS = {
    "salvia rosmarinus": ["rosmarinus"],
    "oenothera lindheimeri": ["gaura"],
}


def genus_of(species):
    """The genus, lowercased."""
    m = re.match(r"([A-Za-z]+)", species.strip())
    return m.group(1).lower() if m else ""


def accepted_names(species, common=""):
    """Every name a photograph of THIS plant might legitimately be filed under.

    Commons search is relevance-ranked, not exact, so a species with few photos
    silently returns something else: a Castilleja for Penstemon, an Australian
    Eremophila for Fremontodendron, a photograph of a Spanish mountain range for
    Arctostaphylos, a beach for Gilia. A plant modelled from the wrong organism is
    worse than no reference at all, because nothing on disk says it is wrong.

    A bare genus test is too strict in the other direction: it would reject
    "Rosmarinus officinalis" for Salvia rosmarinus and "Strawberry bush" for
    Fragaria, both of which are the right plant. So the test is the genus, its
    synonyms, and the substantial words of the common name.
    """
    g = genus_of(species)
    names = {g} if g else set()
    names.update(SYNONYMS.get(species.strip().lower(), []))
    for w in re.findall(r"[a-z]{4,}", (common or "").lower()):
        names.add(w)
        if w.endswith("s"):
            names.add(w[:-1])          # "Goldfields" is filed as "Goldfield"
    return {n for n in names if n}


def rank_key(title, names, index, species=""):
    """Sort key for a candidate, most important test first.

    ORDER MATTERS: BAD is tested before GOOD. "Lomandra plant illustration.jpg"
    matches both, and with GOOD first it beats every clean title and a line
    drawing becomes the reference for Lomandra.

      1. does it name the plant at all           (else it is a different plant)
      2. does it name a DIFFERENT species of the right genus. A bare-genus
         palette entry means one particular species — GENUS_SPECIES says which —
         and Commons will happily answer "Arctostaphylos" with a prostrate
         uva-ursi mat when the entry means a 2.5 m sculptural shrub. accepted_names
         tests only the genus, on purpose, so this rank is the only thing standing
         between the hint and a photograph that contradicts it. A title naming
         just the genus is NOT demoted — it contradicts nothing.
      3. is it a detail, a part, or a drawing    (wrong SHAPE of picture)
      4. how early the name appears              ("Vanessa cardui on Lavandula
                                                  angustifolia" is a butterfly
                                                  photo; "Salvia apiana 4" is a
                                                  sage. The subject leads.)
      5. does it carry a habit word              (a bonus, never a veto)
      6. Commons' own relevance
    """
    t = re.sub(r"^File:", "", title).lower()
    hits = [t.find(n) for n in names if n in t]
    at = min(hits) if hits else -1
    # not-a-plant ranks with "different organism", because that is what it is
    if NOT_A_PLANT.search(title):
        at = -1
    return (0 if at >= 0 else 1,
            1 if names_other_species(title, species) else 0,
            1 if BAD.search(title) else 0,
            0 if 0 <= at <= 14 else 1,
            0 if GOOD.search(title) else 1,
            index)


# Commons is a donated service and answers 429 when leaned on: ~3 searches per
# species a quarter-second apart gets most of them refused — so the pacing below is
# part of the tool, not a workaround: one second
# between species, and a real exponential backoff that honours Retry-After.
MIN_GAP_S = 1.0
_last = [0.0]


def _get(url, timeout=45, tries=4):
    for attempt in range(tries):
        gap = MIN_GAP_S - (time.time() - _last[0])
        if gap > 0:
            time.sleep(gap)
        _last[0] = time.time()
        try:
            return urllib.request.urlopen(
                urllib.request.Request(url, headers=UA), timeout=timeout)
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == tries - 1:
                raise
            wait = float(e.headers.get("Retry-After") or 0) or (2 ** attempt) * 2.0
            print(f"    (429; waiting {wait:.0f}s)", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError("unreachable")


def search(term, limit=8, names=None, species=""):
    """Candidate Commons images for a species name, best-looking habit shot first."""
    q = urllib.parse.urlencode({
        "action": "query", "generator": "search",
        "gsrsearch": f"filetype:bitmap {term}", "gsrnamespace": "6",
        "gsrlimit": str(limit), "prop": "imageinfo",
        "iiprop": "url|size|extmetadata", "iiurlwidth": "1024", "format": "json"})
    d = json.loads(_get(f"{API}?{q}").read())
    rows = []
    for p in ((d.get("query") or {}).get("pages") or {}).values():
        ii = (p.get("imageinfo") or [{}])[0]
        meta = ii.get("extmetadata") or {}
        title = p.get("title") or ""
        rows.append({
            "title": title,
            "url": ii.get("thumburl"),
            "descurl": ii.get("descriptionurl"),
            "licence": (meta.get("LicenseShortName") or {}).get("value", "?"),
            "artist": re.sub(r"<[^>]+>", "", (meta.get("Artist") or {}).get("value", "") or "")[:120],
            "index": p.get("index", 99),
        })
    if names is None:
        names = accepted_names(term)
    rows = [r for r in rows if r["url"]]
    for r in rows:
        r["rank"] = rank_key(r["title"], names, r["index"], species or term)
    return sorted(rows, key=lambda r: r["rank"])


# A bare genus is an ambiguous query — it can return a human thymus gland for
# Thymus — so the SPECIES epithet is searched where the palette gives only a
# genus. These are the species the palette's bare genera actually mean.
#
# Module scope because rank_key needs it too: the hint says WHICH species, and a
# photograph of a different species of the same genus is not an answer to it.
# Without that, a bare-genus entry often caches another species — an
# Arctostaphylos uva-ursi, which is a prostrate mat, standing in for the 2.5 m
# sculptural shrub the palette means, and a Heuchera merriamii (an alpine cushion)
# for H. maxima. accepted_names tests only the GENUS, deliberately, so every one
# of them passes it. Tuning a model from those is modelling the wrong plant,
# confidently — the wrong-organism failure the audit exists to stop, one
# taxonomic rank down.
GENUS_SPECIES = {
    "thymus": "Thymus vulgaris", "penstemon": "Penstemon heterophyllus",
    "cistus": "Cistus purpureus", "teucrium": "Teucrium chamaedrys",
    "geranium": "Geranium sanguineum", "heuchera": "Heuchera maxima",
    "coreopsis": "Coreopsis lanceolata", "gaillardia": "Gaillardia aristata",
    "agastache": "Agastache rugosa", "osteospermum": "Osteospermum ecklonis",
    "sisyrinchium": "Sisyrinchium bellum", "phormium": "Phormium tenax",
    "lomandra": "Lomandra longifolia", "fragaria": "Fragaria vesca",
    "lasthenia": "Lasthenia californica", "clarkia": "Clarkia amoena",
    "gilia": "Gilia capitata", "phacelia": "Phacelia tanacetifolia",
    "lupinus": "Lupinus succulentus", "arctostaphylos": "Arctostaphylos densiflora",
    "ceanothus": "Ceanothus thyrsiflorus",
    "fremontodendron": "Fremontodendron californicum",
}

# words that stand where a species epithet would and name no species
GENERIC_EPITHET = {"spp", "sp", "cv", "var", "subsp", "ssp", "hybrid", "cultivar",
                   "and", "the", "with", "flowers", "flower", "plant", "shrub",
                   "tree", "leaves", "seedling", "garden", "grove"}


def wanted_species(species):
    """The binomial this palette entry MEANS, resolving a bare genus through the hint."""
    bare = re.sub(r"\s+spp\.?$", "", (species or "").strip()).strip().lower()
    if bare in GENUS_SPECIES:
        return GENUS_SPECIES[bare]
    m = re.match(r"([A-Z][a-z]+)\s+([a-z\-]{3,})", (species or "").strip())
    # "spp" is three lowercase letters and matches the epithet pattern perfectly,
    # so without this an unhinted bare genus resolves to "Nothingia spp" and every
    # real photograph of it is then rejected as "a different species"
    if not m or m.group(2).lower() in GENERIC_EPITHET:
        return ""
    return f"{m.group(1)} {m.group(2)}"


def names_other_species(title, species):
    """True when the title names a DIFFERENT species of the right genus.

    A title that names only the genus ("Ceanothus flowers in seattle") is fine —
    it does not contradict the hint, and for a genus whose garden forms all look
    alike it is often the best photograph available. What this catches is a title
    that positively asserts a different species.
    """
    want = wanted_species(species)
    if not want:
        return False
    genus, epithet = want.split()[0].lower(), want.split()[1].lower()
    t = re.sub(r"^File:", "", title or "").lower()
    for got in re.findall(rf"\b{re.escape(genus)}\s+([a-z\-]{{3,}})", t):
        if got in GENERIC_EPITHET or got == epithet:
            continue
        # an epithet is one word; "uva-ursi" is hyphenated, "heterophylla-i--br"
        # is Commons mangling a caption and must not count as a species
        if got.count("-") <= 1:
            return True
    return False


def search_terms(species, common=""):
    """The queries to try for one plant, best first.

    "Penstemon spp." searched literally can return a Castilleja: the
    placeholder appears in no filename, so it only dilutes the query. Same for a
    parenthetical like "Olea europaea (fruitless)", which is a nursery
    qualification rather than part of the name. The cultivar is dropped on the
    second try and the common name is the third, because a plant with few
    binomial photographs often has many under its garden name.
    """
    out = []
    bare = re.sub(r"\s+spp\.?$", "", (species or "").strip()).strip().lower()
    if bare in GENUS_SPECIES:
        out.append(GENUS_SPECIES[bare])
    for t in (species, re.sub(r"\s*'[^']*'", "", species or ""), common):
        t = re.sub(r"\s*\([^)]*\)", "", (t or "").strip())
        t = re.sub(r"\s+(spp\.?|sp\.|x|×)\s*$", "", t).strip()
        if t and t not in out:
            out.append(t)
    return out


def fetch(species, common="", force=False):
    """Cache one habit photo for a species. Returns the index row, or None."""
    os.makedirs(OUT, exist_ok=True)
    key = re.sub(r"[^a-z0-9]+", "_", species.lower()).strip("_")
    path = os.path.join(OUT, f"{key}.jpg")
    idx = load_index()
    if not force and key in idx and os.path.exists(path):
        assessment = reference_assessment(species, idx[key]['title'])
        idx[key].update(assessment)
        save_index(idx)
        if assessment['usable_for_modeling']:
            return idx[key]
    # the botanical name first; a cultivar in quotes confuses the search, and the
    # common name is the better second bet when the binomial finds nothing
    terms = search_terms(species, common)
    names = accepted_names(species, common)
    best = None
    for term in terms:
        try:
            rows = search(term, names=names, species=species)
        except Exception as e:
            print(f"  ! {species}: search failed ({e})", file=sys.stderr)
            return None
        if not rows:
            continue
        # A candidate naming neither genus nor common name is a DIFFERENT PLANT,
        # so try the next search term rather than caching it. Only if every term is exhausted
        # is the best near-miss used, and it is marked so --audit can show it.
        named = [r for r in rows if r["rank"][0] == 0
                 and reference_assessment(species, r['title'])['usable_for_modeling']]
        if named:
            r = named[0]
        else:
            best = best or rows[0]
            continue
        try:
            data = _get(r["url"]).read()
        except Exception as e:
            print(f"  ! {species}: download failed ({e})", file=sys.stderr)
            return None
        with open(path, "wb") as f:
            f.write(data)
        row = {"species": species, "file": os.path.relpath(path, ROOT),
               "title": r["title"], "licence": r["licence"], "artist": r["artist"],
               "source": r["descurl"], "matched_on": term, "kb": len(data) // 1024,
               "names_genus": r["rank"][0] == 0, "detail_shot": r["rank"][2] == 1,
               **reference_assessment(species, r['title'])}
        idx[key] = row
        save_index(idx)
        return row
    if best:
        print(f"  ? {species}: nothing on Commons names the plant; best was "
              f"{best['title'][:60]}", file=sys.stderr)
    return None


def reference_assessment(species, title):
    """A genus match is neither organism identification nor cultivar evidence.

    This is deliberately a title-based screening, NOT botanical verification.
    A species proxy is useful only when explicitly labelled; unidentified mixes
    cannot borrow a single species' photograph as their identity.
    """
    normalize = lambda s: re.sub(r'[^a-z0-9]+', ' ', s.lower()).strip()
    name, caption = normalize(species), normalize(title)
    genus = genus_of(species)
    if 'unconfirmed' in name:
        return dict(reference_scope='unresolved_identity', usable_for_modeling=False)
    if NOT_A_PLANT.search(title) or re.search(r'mucius|painting|fresco|portrait|sculpture|medizinal|illustration|drawing', caption):
        return dict(reference_scope='wrong_subject', usable_for_modeling=False)
    cultivar = re.search(r"'(.+)'", species.replace('’', "'"))
    compact = lambda s: normalize(s).replace(' ', '')
    if cultivar and compact(cultivar.group(1)) in compact(title) and genus in caption and not names_other_species(title, species):
        return dict(reference_scope='named_cultivar', usable_for_modeling=True)
    wanted = wanted_species(species)
    synonyms = {'salvia rosmarinus': ['Rosmarinus officinalis'],
                'oenothera lindheimeri': ['Gaura lindheimeri'],
                'nassella pulchra': ['Stipa pulchra'],
                'rosmarinus': ['Rosmarinus officinalis']}
    alternatives = [wanted, *synonyms.get(normalize(wanted or genus), [])]
    if any(s and compact(s) in compact(title) for s in alternatives) and not names_other_species(title, species):
        # A photo that explicitly names a DIFFERENT cultivar is not a neutral
        # species proxy (a search for Horizontalis can return variegated Diamond Heights).
        if cultivar and re.search(r"['‘’][^'‘’]+['‘’]", title):
            return dict(reference_scope='different_cultivar', usable_for_modeling=False)
        generic = species.strip().lower() in GENUS_SPECIES or 'spp' in name
        return dict(reference_scope='species_proxy' if cultivar or generic else 'named_species', usable_for_modeling=True)
    return dict(reference_scope='unverified_subject', usable_for_modeling=False)


def load_index():
    try:
        with open(INDEX) as f:
            return json.load(f)
    except Exception:
        return {}


def save_index(idx):
    os.makedirs(OUT, exist_ok=True)
    with open(INDEX, "w") as f:
        json.dump(idx, f, indent=1, sort_keys=True)


def palette():
    from plant_catalog import catalog          # the one reader of the user's catalogue
    return catalog()["plants"]


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--species", action="append", help="one species; repeatable")
    ap.add_argument("--list", action="store_true", help="what is cached, with licences")
    ap.add_argument("--missing", action="store_true", help="palette species with no photo")
    ap.add_argument("--force", action="store_true", help="re-fetch even if cached")
    ap.add_argument("--audit", action="store_true",
                    help="which cached photos look like the wrong plant or the wrong shot")
    ap.add_argument("--refetch-suspect", action="store_true",
                    help="re-fetch exactly what --audit flags")
    a = ap.parse_args()

    if a.list:
        idx = load_index()
        print(f"{len(idx)} reference photos in {os.path.relpath(OUT, ROOT)}")
        for k, r in sorted(idx.items()):
            print(f"  {r['species'][:34]:36s} {r['licence'][:14]:16s} {r['file']}")
        return 0

    rows = palette()
    if a.audit or a.refetch_suspect:
        idx, bad = load_index(), []
        for p in rows:
            k = re.sub(r"[^a-z0-9]+", "_", p["species"].lower()).strip("_")
            r = idx.get(k)
            if not r:
                continue
            key = rank_key(r["title"], accepted_names(p["species"], p.get("common", "")), 0,
                           p["species"])
            assessment = reference_assessment(p['species'], r['title'])
            why = (assessment['reference_scope'] if not assessment['usable_for_modeling'] else
                   'missing file' if not os.path.isfile(project.resolve(r['file'])) else
                   "is not " + genus_of(p["species"]).title() if key[0] else
                   "is " + (re.findall(r"\b" + genus_of(p["species"]).lower()
                                       + r"\s+([a-z\-]{3,})",
                                       r["title"].lower()) or ["another species"])[0]
                   + ", not " + wanted_species(p["species"]).split()[-1] if key[1] else
                   "a detail or a drawing" if key[2] else
                   "the plant is not the subject" if key[3] else None)
            if why:
                bad.append((p, r, why))
        print(f"{len(bad)} of {len(idx)} cached photos are suspect")
        for p, r, why in bad:
            print(f"  {p['species'][:30]:32s} {why[:30]:32s} {r['title'][:46]}")
        if not a.refetch_suspect:
            return 0
        rows = [p for p, _, _ in bad]
        a.force = True

    if a.missing:
        idx = load_index()
        miss = []
        for p in rows:
            r = idx.get(re.sub(r"[^a-z0-9]+", "_", p['species'].lower()).strip('_'))
            if not r or not os.path.isfile(project.resolve(r['file'])) or not reference_assessment(p['species'], r['title'])['usable_for_modeling']:
                miss.append(p)
        print(f"{len(miss)} of {len(rows)} species have no usable reference photo (title screening; visual review still required)")
        for p in miss:
            print(f"  {p['species']}")
        return 0

    targets = ([{"species": s, "common": ""} for s in a.species] if a.species else rows)
    ok = 0
    for i, p in enumerate(targets, 1):
        r = fetch(p["species"], p.get("common", ""), force=a.force)
        if r:
            ok += 1
            print(f"  [{i}/{len(targets)}] {p['species'][:32]:34s} {r['licence'][:12]:14s} "
                  f"{r['kb']:4d} KB  {r['title'][:44]}")
        else:
            print(f"  [{i}/{len(targets)}] {p['species'][:32]:34s} NO PHOTO FOUND")
        # pacing lives in _get(), so every request is spaced, not just every species
    print(f"\n{ok}/{len(targets)} species have a reference photo -> "
          f"{os.path.relpath(OUT, ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
