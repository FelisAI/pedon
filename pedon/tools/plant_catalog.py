"""Evidence-scoped plant lookup and this project's explicit cat constraint."""
import json
import re
from pathlib import Path
from functools import lru_cache

import project  # the catalogue is the user's library's, found through the one resolver
PALETTE = Path(project.data('plant_palette.json'))

def normalize(value):
    return re.sub(r'\s+', ' ', str(value or '').replace('’', "'").replace('×', 'x')).strip().lower()

EMPTY = {"plants": []}

def catalog():
    """The user's plant catalogue — EMPTY until they have one: a new library starts with none,
    and every plant is then drawn by the generic generator and judged without a catalogue row."""
    try:
        stat = PALETTE.stat()
    except FileNotFoundError:
        return EMPTY
    return _catalog(str(PALETTE), stat.st_mtime_ns, stat.st_size)

@lru_cache(maxsize=4)
def _catalog(path, modified, size):
    return json.loads(Path(path).read_text())

_indexed_doc = None
_names = {}
_toxic = []

def lookup(species, doc=None):
    global _indexed_doc, _names, _toxic
    doc = doc if doc is not None else catalog()
    name = normalize(species)
    if doc is not _indexed_doc:
        _names = {normalize(n): row for row in doc['plants']
                  for n in [row['species'], *row.get('aliases', [])]}
        _toxic = [(normalize(row['species']).split()[0]
                   if row.get('cat_safety', {}).get('evidence_scope') == 'genus'
                   else normalize(row['species']), normalize(row.get('common')), row)
                  for row in doc['plants'] if row.get('cat_safe') is False]
        _indexed_doc = doc
    if name in _names:
        return _names[name]
    # A species exclusion also covers cultivar suffixes. A genus exclusion is
    # broader ONLY when the cited evidence explicitly covers that genus.
    # Never use this fallback to certify safety from a related plant.
    for base, common, row in _toxic:
        if name.startswith(base + ' ') or name == common:
            return row
    return None

def plant_issues(design, policy=None):
    """Cat safety, where the SITE says cats have the run of it (project.policy())."""
    policy = project.policy() if policy is None else policy
    if not policy.get('cats_have_access'):
        return [], []
    doc = catalog()
    errors, pending = [], set()
    for plant in design.get('plants', []):
        row = lookup(plant.get('species'), doc)
        if row and row.get('cat_safe') is False:
            errors.append(f"plant {plant.get('id', '?')}: {plant['species']} is known toxic to cats; excluded by this garden's cat-access rule")
        elif not row or row.get('cat_safe') is not True or row.get('identity_status') == 'needs_identification':
            pending.add(plant.get('species', 'unidentified plant'))
    warnings = (["Cat safety / exact identity requires review before final selection: " + ', '.join(sorted(pending))] if pending else [])
    return errors, warnings
