# Plants — modelling them, and where the collection stands

**A LEAF IS TESSELLATED FOR THE DISTANCE IT IS SEEN AT.** `shootLeaf` takes
`specimen`: `compare.html` and `preview.html` ask for the fine mesh — these
shoots, curved laminae, undersides and corollas are judged with ONE plant
at half a metre, where every triangle shows — and the garden view gets 4×2
needles and 10×4 sage. Same length, same width, same downward-rolled margin.

It matters because ONE species can be 90% of a design: `Salvia rosmarinus` at
the fine mesh is **5,757,762 triangles** per plant over 106,701 instances, against
109,508 for thyme and 36,882 for muhly grass. A 2 cm needle at 5 m is FOUR PIXELS
tall and the fine mesh spends 80 triangles on it. In a measured design with twelve
rosemaries, coarser garden-view leaves reduce the geometry
**76,628,974 → 30,244,846 triangles**.

Model from the PHOTOGRAPH, never from memory. `ASSET_FIDELITY.md` is the
method for any new asset; this file is what is true about the plants.

**A species builder is the user's, in their library** (`<library>/species/`, `docs/library.md`):
code that draws one species from its photographs — made along the way, like a model file. The app
keeps the generic generator (`plants.js`, whose genus tables draw any species passably) and the
KIT builders are made of, which a species module imports as `@pedon/<file>`: `woody_geometry.js`,
`translucency.js`, `grain.js`, `surface_hairs.js`, `plant_texture_loader.js`, `shoots.js` (the
shoot builder, drawn to a profile; the profiles themselves are the library's
`species/shoot_profiles.js`). The contract (`viewer/src/species.js`) — a module exports:

- `build(plant, r, foliageTint, individual, { specimen })` → a `THREE.Group`, or `null` for a plant
  it does not draw. Test the species FIRST, before drawing from `r`: `drawnByCode` asks with an `r`
  that throws, to learn which plants code draws without building them.
- `prepare()` → a promise of `true` once its textures are in, at the size `textureDetail()` says —
  or of `false` without them (then the plant draws in its no-texture colour; Fast keeps nothing).
- `reduce = "stand-ins"` for a builder of few, cheap parts; otherwise Fast reduces the built plant.

`species/order.json` lists modules most specific first (a builder for one cultivar before the one
for its species); a module not listed is asked after, by name; a module with no `build` is a
helper of others. Its tests go in `species/tests/`, importing the app as `@pedon/…`, and
`tools/selftest.py` runs them with the app's. The Fast plants kept in the browser are versioned by
the library's code too, so an edited builder is redrawn. Import a sibling module by the same
relative path everywhere — the page loads a species module ONCE per URL, and a second URL is a
second copy with none of the first one's textures (`docs/lessons.md`).

**The catalogue** (`data/plant_palette.json`, the user's library) is read in Python through
`tools/plant_catalog.py`: `catalog()` and `lookup(species)`, which matches aliases and cultivars
and applies a cat-toxicity exclusion only as far as its cited evidence reaches — a species
exclusion covers its cultivars, a genus one only when the evidence is about the genus.
`cat_safe: null` stays unknown.

**A FLAT SHAPE IS A LINE EDGE-ON, and a garden is looked ACROSS.** A single
hexagonal plate makes a meadow annual read as orange or yellow slivers floating
over a green lump. A daisy needs RAYS (the ring is what the eye recognises at four
metres) and a poppy is not a daisy at all but a `cup` whose petals lean out. The
same reasoning routes Collinsia to `whorl` and globe gilia to `umbel` — the common
name says what the head is in both cases.
**A flower stem is 1.5-4 mm WHATEVER is on the end of it.** Sizing it from the
flower head gives a poppy's 4.5 cm cup a 7 mm stalk, and forty of those is a bundle
of rods with petals balanced on top. Botanical stems read as wire and disappear into
the planting, which is what lets the flowers be the plant.
**A flower has a SHAPE.** `bloomForm()` in plants.js routes a plant to `whorl`
(a salvia's stacked verticillasters), `spike`, `umbel` (a yarrow is a flat table,
not a ball), `daisy`, or `haze` — scattered dots, the default for an
unclassified plant. Every shape is based on a photo in
`data/refphotos/`. Rosemary needs its own row routed to `haze`: the genus
rule gives it a bare blue spire, while its photo shows flowers in the leaf axils
with no bare stalk anywhere. Head
sizes are botanical (2-4 cm), never a fraction of the bush.
**A leaf count is priced on the VISIBLE AREA of the masses it covers**, not on the
plant's bounding ellipsoid — `leafCountFor` / `visibleArea` in plants.js, discounting
surface buried inside neighbouring masses. The ellipsoid over-prices a packed mound
2-5x and under-prices a scattered clump 2x; tuning `density` around that
error leaves herbaceous plants as bare ellipsoids. Two invariants
hold it up: **`masses[].r` is the radius the leaf SHELL
scatters over and `masses[].core` is what is actually drawn** — mixing them can
give a perennial five times a mound's surface — and **a shell must sit just
outside the core it clothes**, or the cards halo the waist and leave the top bare,
which a mound survives (its masses interpenetrate) and a seven-mass clump does not.
Coverage — leaf area over solid area — is the number to check, and 1.0-2.4 is where
the forms that read correctly sit.
**A GENUS HINT NAMES A SPECIES, and another species is not an answer.** A
palette entry can name only a genus (`Arctostaphylos spp.`), and `plant_photos.py`'s
`GENUS_SPECIES` says which species each one means. `accepted_names` tests only the
GENUS on purpose — a stricter test would reject "Rosmarinus officinalis" for
Salvia rosmarinus, the right plant under an old name. The answer must also match
the species hint: *Arctostaphylos uva-ursi*, a prostrate mat, cannot stand
in for the 2.5 m sculptural shrub the palette means, or its photograph would
give the manzanita preset the wrong foliage. `rank_key` tests the hint
(a title naming only the genus is NOT demoted — it contradicts nothing), and
`--audit --refetch-suspect` fixes it.
**A SHELF AT JUDGING DISTANCE CANNOT SHOW AN UNDER-CLOTHED MASS.** ONE plant
rendered at half a metre reveals bare faceted cores with leaf spikes round them
that a distant shelf hides. When a form is suspected, render one of it close
before anything else.
**`visibleArea(masses)` is the area of the BLOBS, not of the plant.** Summing
whole spheres over-prices a packed mound 2-5x — but a mound is small
cores SPACED across a canopy, so the blobs are only 0.32-0.44 of the silhouette, and
pricing leaves on them alone clothes the spheres and leaves the gaps between them
bare. `leafCountFor` clothes `max(visibleArea, envelope)`, the envelope taken from
the masses' own extent (never the declared size — a white sage's box includes flower
stalks that carry no leaves).
**COVERAGE — leaf or blade area over the plant's own silhouette — is the number
that says whether a form reads.** 1.0-2.4 is where the forms that look right sit,
and it is a diagnostic to check a family against, never a target to tune.
Triangle-budget caps can leave GRASSES at 0.16-0.23 and straps at 0.35-0.55.
Counts must not be capped by a triangle budget. Both are derived from
`BLADE_COVER`, measured against
a real blade's own area — a blade tapers to 47% of its bounding strip, so deriving
from length x width misses by half. A blade's WIDTH is botanical in metres,
for grasses (`BLADE_W_M`) and straps (`STRAP_W_M`) alike: a proportional width both
misses a twenty-fold range between a Phormium and a Sisyrinchium AND makes a
coverage-derived count scale-invariant, so every size gets the same number of
leaves.
**A grass clump writes straight into typed arrays.** Measured per blade,
`PlaneGeometry` costs 5.27 us and `computeVertexNormals` 3.19 while the vertex
maths is 0.37 — the geometry OBJECT is 96% of the bill, at 142,000 of them for one
design. Building the buffers by hand with an analytic normal reduces the grasses from
2575 ms to 165 ms with byte-identical geometry. Note that CLONING a template,
which makes `assetBlooms` affordable, does NOT help here: a clone is 4.06 us
against 5.27 to construct, because a blade is one strip and a flower cluster is
nine spheres. Same symptom, different bottleneck — measure each one.
**A model's leaf SIZE is botanical; its leaf COUNT is what keeps the canopy.**
Leaf area goes as the square of the size, so correcting over-sized leaves without
enough increase in count can reduce canopies to 27-59% of their foliage.
A manzanita leaf is 2-3 cm; shrinking an 11 cm leaf can leave less leaf than bark. Neither
`leafSize_m` nor `leaves` shows that alone. The manifest carries `leaf_area_m2`
measured off the exported geometry and `plants_base.test.mjs` holds every canopy
above cover 0.5 — a floor, never a target: one measured library runs 0.61 to 4.85,
and that spread is the plants being different from each other. `gen_trees` also builds
each model TWICE, because `leafScale` must be pre-compensated by the span Sapling
actually produces and not by the `scale` it is asked for — Sapling misses that by
up to 2x, making every leaf too big without compensation.
**How much of a plant is FLOWER is a fact about the species.** `BLOOM_UNITS` in
plants.js carries it for the five bought models, read off `data/refphotos/`, with
the count DERIVED from the canopy shell so the table means something a test can
check. Giving all five the same 50.7 m² of blossom makes a manzanita 63%
flower and an olive tree 27%.
**HOW TO MAKE A NEW ASSET LOOK REAL: `pedon/ASSET_FIDELITY.md`.** That file is
the METHOD — get the right reference, render ONE close before believing a shelf,
sizes botanical and absolute, counts derived from coverage, the defining property in
the geometry rather than the name, depth edge-on, grain and tonal range and
interstitial shadow, verify by mutation. Read it before designing a plant preset, an
object builder or a surface, and add to it when a new class of defect is found.
`tools/gen_object.py` READS IT INTO THE PROMPT it gives `claude -p`, so a generated
builder is briefed with it automatically: mechanics alone do not establish
asset fidelity. `tests/test_gen_object.py` fails if the wiring is cut or the method is
inlined into a second copy.
**A PHOTOGRAPH OF THE OWNER'S PLANT BEATS A PHOTOGRAPH OF THE SPECIES.** Every
plant card in the asset window carries **Add your photo…**; a card they have
photographed says "◆ your photo". `tools/owner_photo.py add --photo … --species …
--height-m … --spread-m …` is the same path (the dev server shells out to it, so
the rules below cannot be bypassed through the browser). An owner row OUTRANKS a
fetched one for the same taxon — `viewer/src/shell/refphotos.js` and
`owner_photo.photo_for()` state the same ladder and a test runs cases through
both, because resolving it with `byKey[row.species] = row` lets file order
override precedence. Three rules it enforces: the size comes from the owner and is
never inferred from the image (and `measured_*` is what the plant is NOW, never
`mature_*`, which is a fact about the species); an owner row carries NO
cat-safety claim under any flag, because a photograph says what a plant looks
like and not what it is toxicologically; and the file is COPIED into
`data/refphotos/owner/` rather than referenced at its original location.
**Model from the PHOTOGRAPH, never from memory.** `python3 tools/plant_photos.py`
caches a real habit photograph of every palette species in `data/refphotos/` from
Wikimedia Commons (freely licensed, no key, licence and photographer recorded per
file); `--list` shows what is cached, `--missing` what is not, and **`--audit`
which cached photos are of the WRONG PLANT** (`--refetch-suspect` replaces exactly
those). Audit before you trust the cache: search results can show a different
organism or even a landscape instead of the requested plant, and an unchecked
reference produces the wrong model. Shape, colour and leaves must match the
plant. Open the photo before tuning a plant: a real grass blade is 2-4 mm wide,
not 54 mm, and a third of a real fescue clump is straw-coloured, so the generator
must be able to draw straw-coloured blades. Commons is a
donated service — the tool paces itself and honours Retry-After; do not remove that.
**The library loads what the DESIGN needs, not all of it** — `assetsNeededBy(design)`
names the models the opening design routes to, those are awaited before the first
build (buildPlant is synchronous, so a late model is a silently procedural plant),
and `ensureAssets(names)` fetches the rest on demand; opening the asset window is
what pulls the whole library. For a design that routes to three models, loading on
demand reduces boot from 24 GLB requests to 3, plant-model bytes 16.0 MB to 3.0 MB,
DOMContentLoaded 873 ms to 485 ms.
**The plant library is 24 Blender models** (`assets/plants/`), built by
`tools/gen_trees.py` through Blender's Sapling generator — no downloads, no
licences, no keys. Two things about it are load-bearing:

- **Sapling always builds a TRUNK**, so it is right for woody plants over about
  2 m and wrong under it: measured side by side at 0.5 m, a `sage_open` Salvia is a
  miniature tree with a bare stem while the PROCEDURAL plant is the broad low mass a
  subshrub actually is. At 2.5 m the comparison inverts — `manzanita.glb` is a
  gnarled red multi-trunk against procedural dark balls on sticks. That is why
  `MIN_ASSET_HEIGHT_M` is 2.0 and why the ten sub-3 m models are hand-placeable but
  NOT in `FORM_ASSET`.
- **A model with only a `_leaf` material has no trunk** — it is leaves floating in
  the air. Build the library through `bevel=True` to include the trunk.
  `plants_base.test.mjs` fails if any
  model is leaf-only, and if the geometry disagrees with the height the manifest
  claims.
**Look at one plant in 3D:** `compare.html?plant=EXACT_SPECIES` loads one full-size model
beside its reference photograph, with orbit and zoom.

# The owner's plants have their own models

Every plant on the site's own list (`data/owned_plants.json`, ☆ mine in the Add library) should
have its own species model in full detail and Fast preview. Each reaches a species builder in
both modes, from the reference photograph in `data/refphotos` (compare.html shows them side by
side). The ways a library's builders do it:
- **`shootProfile` (shoots.js)** for upright or trailing shoot plants — perennial salvias, catnip,
  marjoram, thyme, penstemon, Scaevola.
  Profile fields: `crown` (the share of the sourced height that is foliage — a grower's height
  for a perennial salvia includes the spikes, which rise to all of it), `spike.each` (flowers per
  level: a lupine-like column of five is wrong for penstemon and many sages), `alongShoots` +
  `bloomScale` (flowers along the stems for a broad-leaved trailer — Scaevola's fans).
- **A sibling cultivar's builder**, its flowers shifted to the plant's own colour against the
  flower geometry's own mean.
- **A shrub builder drawn as a TREE** for a cultivar that grows as one: a few thick trunks bare
  to a third of its height, and leaves at that cultivar's own size.
- **The grass path** draws each grass's own blades and airy heads; a coloured cloud such as pink
  muhly's needs many hair-thin (open-prism) branches to read as its colour.
References that are proxies — say so before trusting them: a cultivar with no photograph on
Commons borrowing its sibling's builder, a photograph on file of a different cultivar, an old
botanical plate of the parent species. The owner's own photographs (**Add your photo…** on each
card) settle all three.

# A plant the viewer draws wrong is a model to GET

The design agent — or anyone — can give a species its own model, just as for objects:
`find_asset {query, plant: true}` (the plant library and Poly Haven's CC0
plants, with pictures), then `fetch_asset {id, species}` or `make_asset {name, script,
size_m, species}` (a sandboxed Blender script, built at the species' mature size). Each
returns the model's PICTURE — look at it — and an `asset` name; plants then carry
`"asset": <name>` in `place_plants` or `set_plants`, and the viewer draws that model at each
plant's mature height and spread instead of the species' builder (`assets.js assetName`:
an explicit asset wins, at any height). The model lives in the user's library, `assets/plants/`, with an entry in
`manifest.json`: species, source (Poly Haven id and licence, or the script and its sha1)
and picture. It improves no builder, and
it runs only when a design asks for a model.

The tools and records for species-model photorealism (a plant-by-plant review
queue, review renderers, evidence audits) are the LIBRARY's, not the app's:
they travel with the models, in the library's `workshop/`.
