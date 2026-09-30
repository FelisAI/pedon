# How to make an asset look real

One viewing exception: **Fast preview** may use simplified geometry, coarser grass
ribbons and fewer leaf cards to keep the viewer responsive. The rules below still
govern full-detail masters, exports and visual acceptance. A preview is labelled as
simplified and cannot serve as fidelity QA.

The method for plant species, garden objects and every paving, wall and step
material. Every rule here guards against a defect that can survive a review.

**This file is the source.** `tools/gen_object.py` reads it into the prompt it gives
`claude -p`, so a generated builder is briefed with it automatically. Do not
paraphrase it into a second copy — that is the mistake `tests/test_dry.py` exists to
catch, one directory up.

This file exists to prevent the defects a person notices first: shape, colour and
leaves that are all off; plants drawn as large balls that do not look like a plant;
a garden that feels mechanical.

---

## 1. Get the reference before you model anything

**Model from a photograph, never from memory.** A parameter chosen from memory
draws a plausible plant nobody recognises.

- `python3 tools/plant_photos.py --audit` before you trust the cache. An unaudited
  fetch can leave a large share of the photographs unusable, and some of a different
  organism entirely.
- **A genus hint names a SPECIES, and another species is not an answer.** A
  bare-genus entry is easily cached from the wrong species — an *Arctostaphylos
  uva-ursi*, a prostrate mat, standing in for the 2.5 m sculptural shrub the palette
  means — and a preset written from that photograph gets "sparse foliage" wrong.
  Modelling from the wrong species is modelling the wrong plant, confidently.
- For an object with no photograph, the reference is the thing's PURPOSE and its
  relation to the body: an ishidoro is chest-high, a tsukubai is stooped to, a bench
  seat is knee-high, a moon gate is walked through.

## 2. Look at ONE of it, close, before and after

This is the highest-value rule in the file.

The three review sheets — `compare.html` (plants beside their photographs),
`objects.html` (objects beside a 1.7 m figure), `surfaces.html` (paving, walls and
steps at walking, standing and plan distance) — are for BREADTH: which things exist
and which are obviously wrong.

**They cannot show an under-clothed or hollow form.** Distance is a low-pass filter:
it averages a sparse shell and a dense one to the same grey blob. A mound form can
pass review after review at distance, including reviews that measure, while one
plant rendered at half a metre is plainly bare faceted cores with leaf spikes round
them.

So: render one, filling the frame, before you conclude a family is fine. Do it
BEFORE the measurement — the close render tells you which number to compute.

## 3. Sizes are botanical and ABSOLUTE, never a fraction of the thing

A dimension expressed as a fraction of its parent is wrong twice: it misses the real
range, and it makes any count derived from coverage scale-invariant.

| | wrong | right | why |
| --- | --- | --- | --- |
| grass blade width | `spread * 0.045` (54 mm) | `BLADE_W_M` 6 mm | a Muhlenbergia blade is 2-4 mm |
| strap leaf width | `spread * 0.055` | `STRAP_W_M` per species | a Phormium is 5-10 cm, a Sisyrinchium 2-4 mm — twenty-fold |
| flower stem | `wide * 0.10` (7 mm) | 1.5-4 mm, clamped | herbaceous stalks are ~2 mm whatever is on the end |
| leaf size | up to 4x over | botanical, in metres | a manzanita leaf is 2-3 cm, not 11 cm |

The scale-invariance trap is worth stating plainly: if width scales with the plant
AND the count is derived from coverage, the canopy shell and the leaf both grow as
size², so **every size gets the same number of leaves.** A 1.5 m flax and a 0.3 m
blue-eyed grass come out identical.

## 4. Counts are DERIVED from coverage — never flat, never clamped

A flat count ignores the size of the thing. A clamp is a budget in disguise, and a
full-detail master has no triangle budget: rendering slower is acceptable, saving
triangles at the cost of fidelity is not.

Derive the count against a real sample's own measured area, not against an assumed
one — a grass blade tapers to 47% of its bounding strip, so `len × width` misses by
half. Build one, measure it, divide.

**Coverage is leaf/blade area over the thing's own silhouette.** Measured across the
palette, the forms that read correctly sit at **1.0-2.4**. It is a DIAGNOSTIC to
check a family against, never a target to tune and never a number to put in a design
brief (a number in a brief is a restriction wherever it is written).

Forms that read wrong measure outside that band: perennials 0.17-0.24, grasses
0.16-0.23, straps 0.35-0.55, mounds 0.67-0.93.

**Price against the right denominator.** `visibleArea(masses)` correctly discounts
surface buried inside a neighbour — but a mound is small cores SPACED across a
canopy, so the blobs are only 0.32-0.44 of the silhouette, and pricing on them
clothes the spheres and leaves the gaps bare. Clothe `max(visibleArea, envelope)`,
with the envelope from the masses' own extent (never the declared size, which
includes flower stalks carrying no leaves).

## 5. Correcting a size means moving the count with it

Area goes as the SQUARE. Correcting over-sized leaf presets while raising their
counts only linearly cuts each canopy to 27-59% of its foliage and can leave a
manzanita with **less leaf than bark** — a bare skeleton, which looks less like the
plant than the oversized leaves do. Neither the size nor the count shows that alone;
only the render, or a recorded measure of the total.

## 6. The defining property must actually be present

The worst defects are not coarse, they are CATEGORY ERRORS — the one feature that
makes the thing what it is, missing:

- a **screen** covering 24% of its own width is a picket fence; the thing exists to
  block a view
- a **lantern** with a solid firebox is a mushroom on a post; a lantern has
  somewhere for the light
- a **stepping stone** path drawn as an unbroken ribbon is a paved path; the whole
  point is the GAP
- a **fire pit** with nothing in it is a planter; every raised bed has masonry, so
  masonry is not what says fire
- a **moon gate** as tall as it is wide is a panel; it is a segment of WALL

Ask, before anything else: what is the one thing that makes this recognisable? Then
check it is in the geometry, not in the name.

## 6b. A feature finer than the mesh DOES NOT EXIST

Rule 6 says the defining property must be in the geometry. This is the trap one
level down: it can be in the geometry and still be invisible, because the mesh
cannot resolve it.

A lava rock is vesicular — riddled with gas cavities, and at arm's length that
pitting is the entire difference between scoria and any other dark rock. Built
with the boulder's 0.035 m target edge, the vertex spacing is ~3 cm while the
bubbles are ~1.5 cm across, so nearly every one lands BETWEEN vertices and
displaces nothing. It renders as a smooth brown pyramid, while triangle count and
declared height both pass. Only rendering one close shows it.

Worse, a version can LOOK right and still have the fault. Rebuilt with the vesicle
displacement switched off, such a rock's cavity count changes by only 3% — the
bubbles decorate a shape the fracture planes have already made, and the improvement
between renders comes from subdivision, not from pits. **Build the thing with
the defining feature DISABLED and measure the difference.** If the number barely
moves, the feature is not doing the work its name claims.

Two corollaries:

- **Size the feature against the vertex spacing before you model it.** Target edge
  0.007 m for a 0.4 m rock, because the cavities are 2-3 cm.
- **Measure FEATURES, not roughness.** "Rougher than a boulder" is unsound: the
  boulder's fracture planes give as much radius spread as vesicles do (cv 0.181
  against 0.174), and its mesh has 1,500 vertices to the lava's 61,440, so any
  neighbour comparison measures tessellation. Counting distinct cavities survives
  that — 200 with the vesicles, 138 without.

## 6c. Two darkening passes is one too many

Two colour corrections in a row can overshoot from milk-chocolate brown to black.
A black silhouette has NO SURFACE: the pits
stop reading because nothing catches light inside them, so the geometry you just
paid for disappears. Scoria in sun is a warm dark grey-brown. Correct colour
against a render in the scene's own light, not against the swatch.

## 7. A flat shape is a line edge-on

A garden is looked ACROSS, not down at. A meadow annual drawn as a flat plate on a
wire vanishes at eye level. A daisy needs rays (the ring is what the eye reads
at four metres); a poppy is a cup whose petals lean out; a cluster is a lump of many
florets, not one bead and not one block.

Give a thing depth in the axis it will be seen along.

## 8. Flat colour is the most obviously computer-generated thing in a frame

- Use the ONE grain generator, `viewer/src/grain.js`, via `mat(color, opts)`. Pass
  `grain: 0` only for what really is uniform — water, painted metal. (Water drawn
  with grain makes a koi pond read as grey concrete.)
- **Interstitial shadow is what makes a loose surface read as loose.** Gravel is
  stones with dark between them; without that it is sandpaper however fine the
  speck. Same for shredded bark.
- **Tonal RANGE, not just noise.** A real crushed granite runs near-white quartz to
  near-black mafic in one handful; ±25% mottle averages back to the flat colour it
  started as.
- Every unit its own tone. Uniform stones and even joints read as concrete block.
- A bundle of identical cylinders is the same fault in another form: vary the canes,
  the stones, the shreds.

## 9. Verify by mutation, and check the cost by measuring

**A green test proves nothing until you have seen it go red.** Break the thing the
test targets and watch it fail. Each of these tests passes WITH the bug present:

- "the five bloom areas differ from one another" — true however the count is set
- one 12% height tolerance — a lantern bug at 104.7% sits below a bench that
  legitimately draws 105.0%, so any band loose enough for the bench admits the bug
- a strap scaling test whose fixture uses a name the species table does not match

**Cost is fill rate, not triangle count.** Measure a frame, do not reason about it.
A design of 6.7 M triangles can render at eye level inside the planting in 3.9 ms —
about 250 fps. Build TIME is the thing worth guarding (the ceiling is
6000 ms); the triangle line in `plant_fidelity` is a runaway tripwire.

---

## Before you call an asset done

1. Did you open the reference, and is it the right species / the right thing?
2. Have you rendered ONE of it close enough to see its surface?
3. Is every dimension in metres and botanical, rather than a fraction?
4. Is the count derived from coverage, and does the coverage land in 1.0-2.4?
5. Is the defining property in the geometry?
6. Does it have depth seen edge-on, grain, tonal range, and shadow between its parts?
7. Does it draw the size it declares? (`objects.test.mjs` measures this above ground.)
8. Did you break the test and watch it go red?
9. `python3 tools/selftest.py` green, before and after.
