# Objects, paving, walls and steps

Reviewed by eye on `objects.html` and `surfaces.html` against a fixed camera
and a scale reference — the view that shows a screen that does not screen or
a lantern with no firebox.

**AN OBJECT CAN BE A FILE — `place_object` takes `model`.** A path under
`assets/objects/` to a `.glb` (scanned, fetched or made); it beats the builder for that
kind, the way `plant.asset` beats the species table, and the builder is the
fallback so a model that has not arrived draws a preset for one frame rather than
nothing. Three refusals, because the string arrives in a document a model writes
and reaches a loader: outside `assets/objects/` or carrying `..`, not a
`.glb`/`.gltf`, or not on disk. **Object models load in BOTH quality modes**, and
that is deliberate: Fast preview is about BOTANICAL detail, and a scanned object
has no simplified version — the alternative to your scanned stone is a preset of
something else. Inside the quality guard it would load nothing in Fast, the mode
you actually view in.
A whole-site scan of a few hundred square metres has a mean vertex spacing of
about 5 cm, so a 0.4 m stone in it is only a couple of hundred vertices — resolution
is a fact about camera distance, not about the subject.
**`Box3.setFromObject` REUSES a cached `geometry.boundingBox`** rather than walking
the vertices, so a builder that moves vertices after calling `computeBoundingBox()`
hands every consumer — frustum culling, selection, float_check — the bounds of a
shape that no longer exists: a stale box reads 0.776 m for a 0.600 m boulder. A debug
script that calls `computeBoundingBox()` before reading the box REPAIRS the stale
cache as a side effect and reports a perfect 0.600: the instrument fixes the fault
while measuring it.
**An object is the size it SAYS it is, and a comment is not a check.** Every
builder in objects.js scales its profile by `h / <the profile's own total>`, and
that total is a number in a comment, so a profile that grows without its divisor
draws too tall: a stack of 1.34 units divided by 1.28 draws a declared 1.4 m
lantern at 1.47 m. `objects.test.mjs` measures it, ABOVE GROUND (a boulder is
bedded: its box is 0.68 m and the 0.60 that shows is its declared height), and
per-kind rather than with one tolerance — that lantern error is 104.7% and a bench
legitimately draws 105.0%, so any band loose enough for the bench admits the bug.
**A stepping stone is the GAP, and a fresh canvas is already transparent.** A bond
pattern on an unbroken ribbon is a paved path with joints, not stepping stones. So:
skip the base fill so the gaps stay transparent, paint only the stones, and put
`alphaTest` (never `transparent` — a sorted surface lying on the ground z-fights
everything near it) on the material. `pathMesh` needs no change: the stones follow
the path because the UVs do. Note that speckle must be confined to
each stone: `fillStyle` is opaque, so a speck landing on a transparent pixel makes
it opaque and the gaps fill with confetti.
**grain.js may use `fillStyle` and `fillRect` and nothing else.** The canvas shim in
`tests/js/design.test.mjs` provides exactly those two, so a `beginPath`/`arc` would
crash every suite that imports design.js. It is also enough: crushed stone is
angular, a cut flag is rectangular, and a bark shred reads by its elongation rather
than its angle.
**A loose aggregate is STONES WITH SHADOW BETWEEN THEM.** gravel, decomposed
granite and the free-text mulches routing to `aggregate` are the most used surfaces
by a distance, and specks alone render them as sandpaper. The speck size is right (a 7 px chip on a 366 px/m
tile is 2 cm); what they need is the interstitial shadow, which is most of what
makes a surface read as loose rather than poured, and a tonal range wide enough for
a real crushed granite (near-white quartz to near-black mafic in one handful).
`groundTexture`'s `chips` mode does it in three grades, coarse to fine, each filling
the gaps the last left.
**One grain generator, in `viewer/src/grain.js`.** A flat colour is the most
obviously computer-generated thing in a frame, and it applies to a stone lantern
exactly as much as to a gravel path, so objects and ground share one generator
rather than objects drawing one unbroken hue. It is its own module because design.js already imports objects.js and the other direction would
be a cycle; `mat()` in objects.js takes `grain`, `coarse` and `tile_m` in the same
vocabulary, and `grain: 0` for what really is uniform.

## A model the library does not have — find it or make it

Assets are not baked in: the LLM agent must be able to create a 3D asset itself or find
one somewhere.

An object model is a FILE, not code: `assets/objects/<name>.glb` with a card beside it
(`<name>.json`: name, kind, size in metres, triangles, where it came from and its licence)
and a picture (`<name>.png`). `tools/asset_store.py` owns that format. A design uses one as
`place_object {kind, model: "assets/objects/<name>.glb", height_m}`; the viewer scales it
to `height_m` and stands it on its own base. The Add library shows every model in the folder
with its picture, beside the built-in kinds.

The design agent's tools (`view_mcp.py`), in the order to use them:

| tool | what it does |
| --- | --- |
| `list_assets` | what exists — built-in kinds AND `object_models` in the library |
| `find_asset {query}` | this library, the built-in kinds, and Poly Haven's CC0 models (no key; real sizes; pictures of the first four). Says outright when nothing IS the thing ("stone birdbath" finds stones) |
| `fetch_asset {id, kind}` | a Poly Haven model into the library, set on the ground, CC0 and authors on the card, with its picture |
| `make_asset {name, script, size_m, kind}` | the agent writes a Blender script (metres, Z up; `bpy`, `bmesh`, `mathutils`, `math` in scope); it runs headless in a macOS `sandbox-exec` with **no network and no writes outside its own folder**; the result is set on the ground, checked against `size_m` (±35%) and 300,000 triangles, and returned with its picture — a wrong one is refused WITH the picture, so it can be fixed |

The same verbs for a session: `python3 tools/asset_store.py list | find "…" | fetch <id> | make --name … --script f.py --size w,d,h`.
A fetch or a make takes seconds, and a fetched model arrives at its published size. A script
that builds at centimetre scale is refused on size, and inside the sandbox network access and
writes to the home folder are refused.

Code rather than a file: `gen_object.py` has a model write a procedural BUILDER
into `objects.js`. A builder is right for a kind every design uses and wants to vary
(size, seed); a file is right for one particular thing.

**Plants take the same three verbs**, with a `species`: `find_asset {plant: true}`
searches the plant library and Poly Haven's plants (categories plants, trees, flowers,
grass, ground cover, succulent); `fetch_asset` / `make_asset` with `species` put the model
into `assets/plants/` with an entry in its manifest (species, source, picture) and return
its `asset` name. A design then says `place_plants {..., "asset": <name>}` (or `set_plants`)
and the viewer draws that model at each plant's mature height and spread, in place of the
species' builder. `execute()` refuses an `asset` the manifest lacks — the viewer would draw
the generic shape without a word — and a generated model (`tools/gen_trees.py`: its `source` says
so, or it has no `source`) is never replaced by one. The open viewer re-reads the manifest once for a name it has not
seen, so a model made mid-session draws without a reload. `docs/plants.md`.
