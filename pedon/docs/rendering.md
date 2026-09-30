# Rendering — light, shadows, the GPU, and pictures that leave the browser

Rendering happens in the viewer, because that is the only place the scan and
the placed geometry exist. Everything that leaves — a look, a walkthrough, a
path-traced frame, a USDZ — comes through the render broker from that tab.

The yard starts in **Fast preview**, with simplified plants, reduced pixel ratio
and no dynamic shadows or botanical texture preload. **Full detail** restores
master builders; the preference stays local to the browser. Plant cards use fast
previews and link to one full-detail plant. Exporters and comparison pages retain
full detail. Fast preview is for viewing; it does not justify reducing botanical
masters or approving preview geometry.

**Fast draws the same plant as full detail — every species that has a builder**.
ONE list of builders (`speciesModel` in plants.js) serves both modes; Fast builds
the same model once per species and size and reduces it by builder: the shoot plants carry their
true-size leaves on leaf-cluster cards (`leafClusterCards`); a builder that declares
`reduce = "stand-ins"` (few, cheap parts) and the botanical model draw each part as a stand-in
where the builder put it (`previewPrototypes`); the library's photoreal builders go through
`preview_lod.reduceBuilt`, as do the shoot plants, to avoid checkered leaf cards on textured
leaves (Berggarten sage) and flower cards on bare twigs (westringia):
- what lies ON a part (hairs, wool, down) goes, and a leaf's underside when the leaves are carded;
  fine wood (twigs, the shoot plants' instanced `wood`) keeps its thickest 3,000;
- leaves, and compact flower parts past 5,000 — and past what the plant's budget can draw one by
  one at ~8 triangles each (a silver thyme draws its own 5,500 leaves) — become CARDS in cells of about four part-lengths —
  a flower's petals, centres and calyces one set — each card turned to the way its parts lie,
  its picture an atlas of the parts at four densities (it takes the one nearest its own physical
  coverage, 1 - e^(-n a / A), so shadows see the density too), lit as its parts face from both
  sides, drawn with HASHED alpha (4x MSAA alpha-to-coverage rounds sparse cards to nothing);
- the other parts keep every instance, each the most detailed reduction within the plant's
  budget (100 k triangles a metre of spread) that keeps the plant's reach and height within 5%
  and, for a part big on screen, 85% of its body: a blade's ribbon along its own midline, the
  part's shape simplified (meshoptimizer), or the box stand-in;
- the fit to the declared spread is the full model's, not the reduction's.
Fast loads the builders' textures too, at 256 px (`plant_texture_loader.js`) — their colour is
in them. Measured over 24 builders: every one within 3% of full detail's width and 2% of
its height, 16-560 k triangles against millions to billions; 20 within ~11% of its lightness. The
known differences: 'Ray Hartman' ceanothus, manzanita and 'Sunset Gold' read darker in Fast — partly full
detail's own artefact (its leaf textures sit on a pale background that bleeds in when shrunk; with
mipmaps off full-detail manzanita drops from 72 to 63), and echeveria rosettes come out spikier
and, with their hairs dropped, greener.
`node tools/preview_agreement.mjs [design]` lists, per species, which builder each mode used —
stock routes included — and how far the sizes differ, to the millimetre (Fast against full detail
of the SAME individual, below).

**A Fast plant is generated once per kind, in three individuals, and kept**. Without caching,
generation takes 3.8 s of a measured 4.4 s page load. A plant's model depends only on its fields
other than `id` and `position` (`fastModelKey`) — so each kind is generated as `FAST_VARIANTS` (3)
individuals, each from the kind's own seed, and every plant of the kind is one of them, chosen by
its id, turned about its axis and half of them mirrored: a drift is three plants, not one copied.
Full detail generates every plant from its own id. An individual SHARES its kind's geometry
and instance arrays (duplicating matrices costs 153 MB on a measured design) and OWNS its
materials — with shared materials, the highlight set on one copy is undone by the next,
so selecting a plant does not light it.
The kinds are kept in memory and in the browser's IndexedDB (`viewer/src/plant_store.js`):
`buildDesignGroup` reads the design's kinds back before building (building is synchronous), and
what it had to generate is stored when the page is idle. Stored is the object tree, every array,
each material as three's JSON plus every field that JSON loses (depth packing, `ior`, …;
a field it cannot store refuses the plant), translucency re-applied, and each
picture's pixels once. Only canvases are stored (a decoded image loses colour under transparent
pixels), and only a plant generated with every builder's texture in (`texturesReady`) — kept
early it would be drawn dark on every load. The store holds one version: `/api/plant-build`'s
`plants`, a hash of plants.js and everything it imports, three and meshoptimizer's versions and
the builders' textures (`viewer/plant_version.js`) — a change to a menu keeps it. Least recently
used models go past 1.5 GB. Measured on a 166-plant design (55 individuals, 275 MB
stored): generating 3.5 s build; read back 0.13 s, build 1.0 s, first frame 1.3-1.5 s against
4.2 s; the read-back plants render pixel-identical to the generated ones from their deck view.
`__pedon.plantStore()` says what was read back, stored and refused; `__pedon.forgetPlantStore()`
empties it; `__pedon.designMemory()` counts the design's arrays once however many plants share them.

**The frame is triangles, and the fewer parts go where a part is under a pixel**.
Measured waiting for the GPU (`__pedon.frameMs(n, true)` — without `true` it is only the CPU's
share, 4.5 ms of a 57 ms frame) and split by `__pedon.frameBreakdown(n, byKind)`: in a measured view
from the house, 51 of 57 ms are plants, the shadow pass 24, and half the pixels save only 14%. Three
things, each measured:
- a grass's standing structure keeps every piece at least `SUBVISIBLE_M` (0.5 mm) across and
  thins the rest like fine wood — a deer grass's 0.3 mm pedicels, batched with its culms, account for
  310 k of its 509 k triangles (preview_lod.js);
- Rosie Posie is reduced by the budget like the photoreal builders, not drawn part by part
  (129 k -> 69 k triangles);
- a layer of 256+ small parts has two coarser LEVELS (`viewer/src/plant_lod.js`): a quarter of
  its parts, each four times the area (a blade widened, a leaf grown in both in-plane axes), then
  a sixteenth — the same area, so the same coverage and colour — shown only where the enlarged
  part is still under a pixel at that plant's distance, chosen per camera every frame (the shadow
  pass draws the same). Only the design in the viewer carries them; buildPlant, tests and exports
  see the plant as generated. `__pedon.levels(on)` turns them off to compare.
Result, at three measured views: from the house 57 -> 38 ms, in the path 49 -> 40, from a deck
40 -> 33 (headless, on a Mac GPU);
the picture changes by 0.24-0.76 of 255 on average, brightness unchanged. Levels exclude MERGED
layers: a curved blade's second axis is its bend, not its width — 2.3x the picture change for
5 ms. An eighth of the plant budget does not reduce the costly kinds, which are not subject to it.
Still costly: Rosie Posie's 12 k flower parts (7.9 ms) and pink muhly's merged blades and plume (4.5 ms).

**Fast against full detail, per plant, the same individual**. `compare.html` builds
full detail from the Fast individual's seed (`fastModelKey`), so a Fast/full pair measures the
reduction, not two plants of one species. Close-up measurements over twenty kinds
show why the reduction rules matter:
- the generic leaf shell's Fast cap is 4,000 and keeps the plant's LEAF AREA (fewer leaves,
  each larger by the same share): common thyme -28% -> -2% compared with a 1,500-leaf cap,
  which leaves dark cores showing;
- keeping a simplified part's old vertex normals lights a third of each coarse catnip leaf
  near-black at its curled margins — normals are recomputed from the simplified shape
  (`shapeNormals`): catnip -12% -> -3%, Berggarten -14% -> -4%, Poquito -8% -> -1%;
- a rolled leaf's box is nearly as thick as it is wide, so crossed planes face sideways and
  down, and a leaf drawn as a ribbon appears blue-grey: a one-sided part (mean normal near
  1) is drawn flat, as a HEXAGON on its true box (three-quarters of it, where an oval leaf covers
  four-fifths), a reduction must keep a one-sided part's facing (`faces`), and a ribbon is only for
  a part longer than `BLADE_ASPECT` (8) times its THINNEST side — an arched deer grass blade's box is
  nearly square, and judging by its middle side selects plates instead of a ribbon: silver thyme
  -12% -> +8%, Cleveland sage -19% -> +4%.
Measurements rule out flipped triangles (none), undersides self-shadowing,
the one-texel colour (the leaf texture is white), and leaf area lost to simplification (7%). The
"cover" figure counts pixels far from the backdrop's colour, so a darker leaf reads as less cover —
read it with the picture. Remaining differences: Dr. Hurd -16% (partly full detail's own texture
bleed); deer grass in flower +12% (its panicles pale where full detail draws a grey-green haze).
These rules cost 2 ms a frame in the measured view from the house (38 -> 40 ms).

**Every catalogue species the same in both modes, model files included**. Over a 119-species
catalogue (`node tools/preview_agreement.mjs data/plant_palette.json`): 53 drawn by their
own code, 61 by the generic shape, 5 from a model file — each the same route in Fast as in full
detail, and within 4% of its height and width. A plant drawn from a MODEL FILE (a library tree for
a 2 m+ plant no builder claims — olive, toyon, oak and 20+ others — or a species' own `asset`)
is that model in Fast too, reduced by `preview_lod.reduceModel`: its branch tubes simplified,
its leaves (100 k+ separate pieces) THINNED keeping their area (`thinPieces`) — olive 767 k -> 193 k
triangles, within 7% of full detail's lightness. The viewer loads a model file only for plants
that will draw from it (`ensurePlantModels` in main.js, `drawnByCode` in plants.js asks the
builders themselves) — a manzanita its builder draws avoids fetching and decoding manzanita.glb (12.8 MB) — and
in Fast only for kinds not already kept. Every reduction reads real colour values, because
copying raw normalised integers draws branches white. A leaf card stays within its leaves'
reach and height to avoid distorting a prostrate plant (3.5 cm tall in the rosemary measurement);
Fast's capped leaf shell grows its leaves INWARD from their true tips and draws from its own random
stream, so its leaf count cannot move the flowers drawn after it.

**THE AGENT'S REVIEW PATH IS INDEPENDENT OF FAST PREVIEW**.
`viewer/src/review_scene.js` prepares full-detail, mature planting for `look`,
`walk_through` and `export_scene`, restoring the user's scene afterwards.
`look(render="photoreal")` exports that proposal and its actual viewer camera,
then returns a Cycles PNG inline when it fits the local render budget. A large
garden's whole planting can exceed it; a five-plant preview takes 12.7 s. The camera crosses the same Y-up to Z-up
boundary as the geometry, including a nonzero north yaw. The agent does not read
`design.json` to reconstruct the camera of a different scratch proposal.
See `docs/design-agent.md` for the invocation and limitations.
`tools/render_process.py` bounds the local render's memory, disk usage and time,
and kills the worker's children on cancellation. RSS alone is insufficient on
macOS because compressed memory disappears from that number.

**MEASURE THE PHASE THAT EXCEEDS MEMORY** (`tools/render_profile.py`).
`photoreal.py` saves `data/photoreal/last-render-profile.json` on success AND
failure; `--profile PATH` keeps a named experiment. The reply includes its path.
It records Blender's physical footprint every 50 ms, measured import/evaluation/
Cycles boundaries, the stop reason and the limit. This excludes browser and
other process memory. Cross-runtime timestamps use Unix time; the monitor keeps
monotonic time for its own durations and deadline.

The developer's geometry audit reads only the GLB JSON header, without loading
the binary buffers, Blender or an LLM:

```bash
python3 tools/render_profile.py data/photoreal/scene.glb --out /tmp/scene-cost.json
# Compare exact instance representations without starting Cycles:
python3 tools/render_profile.py data/photoreal/scene.glb --probe-import native --memory-out /tmp/native-memory.json
# --probe-import realized measures the other representation, with the same guard.
```

Counts distinguish unique mesh triangles from triangles after repeating
instances. They include all exported geometry before camera culling; they are
not the viewer's draw counter. The audit retains node ancestry (plant IDs and
species metadata), so a large count can be traced back to its exported object.
Use one fixed export for representation comparisons. Probes share the normal
render lock and cannot run beside a render. These are measurement
probes for a code-editing session, not a new design rule or reduced plant detail.

**GENERATED PHOTOGRAPHIC VIEWS FROM FAST PREVIEW**.
An active session can use built-in image generation with a screenshot of the real
Fast preview at mature size, plus the design's species, sizes and materials.
Two measured outputs take 39 and 47 seconds without a Blender export or API key.
The main path, steps, tree, bench and fire bowl remain recognizable; foliage and
surface texture look much more photographic. A stricter prompt can improve the
bed outline and remove invented foreground planting, but canopy size can still
change and an ambiguous scan fragment can become a small path light.

This is a single-view technique, available to an active session with
image-generation tools; it is not a viewer button or a render mode.
Keep the preview as the layout reference, add authoritative plant/material facts,
then compare the generated result with that preview before using it to judge the
design. Use existing measured tools and detailed views to check positions and
clearances. Multiple-view consistency has not been tested. Generated outputs are
labelled `generated_visualization` and kept with their prompts and metadata under
`review/`; an accompanying README records findings and input limits.

**COMPARING DESIGNS WITH GENERATED VIEWS.** Generate from full-detail mature views,
with one fixed owner camera for every design being compared, plus the saved species/material
facts, and keep the source/generated pairs and exact prompts together under `review/`.
The images clarify texture and visual weight, but also alter branches, botanical
details and ambiguous scanned ground. Targeted corrections can remove invented
foreground flower strips. The images support design critique, not clearance
measurements or proof that a redesign improves. Generation does not change design
geometry, and multiple-view consistency of a generated design remains untested.

**LOOK AT A DESIGN IN FULL DETAIL, NOT IN FAST PREVIEW.** Fast preview simplifies
plants and understates the detail a planting review judges: feathery bronze fennel
can read as dead straw. Fast preview is for viewing, not for reviewing planting.
**FULL DETAIL IS USABLE WITH THE CONTEXT CHECKED DIRECTLY.** Measured on a live
design: **1.6 ms a frame (619 fps) standing at eye level inside the planting,
5.7 ms framed out, `contextLost: false` throughout.** A `look` from inside the
border returns a real picture.
**Triangle counts must be per frame.** `renderer.info` ACCUMULATES unless you call
`reset()` yourself: an accumulated 31.7 B count can misrepresent a 76.6 M-triangle
frame by a factor of 400. Tessellating the rosemary needle for the distance it is
seen at reduces that full-detail design from 76.6 M to **30.2 M** triangles.

Two checks matter: a black frame after a lost context looks exactly like a
mis-aimed camera, so **check `isContextLost()` FIRST when a render comes back black**; and read
`renderer.info` only after `reset()`, or it reports a running total as if it were
one frame.
**So review at full detail.** `compare.html?plant=SPECIES` remains the right place
to judge ONE plant close up — it asks for the `specimen` mesh, which the
garden view deliberately does not build — and review the garden in full detail too.
**A BLACK FRAME IS NEVER SAVED — `viewer/src/framecheck.js`.** If the WebGL context
dies mid-walkthrough, `renderer.render()` returns in 0 ms without throwing and
the brightest pixel can be 0. `renderRefusal` tests the context BEFORE a render
and cannot see a loss during it; this reads the framebuffer back
after one. The threshold is EXACTLY zero — a garden at dusk is legitimately dark,
and a threshold picked by eye would start discarding real pictures. Both ends
check it: the browser at the point of drawing, the dev server at the one place a
frame reaches disk in `data/views`. `GET /api/views` lists what is really on disk, newest first,
so the panel shows saved frames rather than hard-coded names.
**THE SUN IS ON A SLIDER, AND SHADOWS ARE THEIR OWN SETTING.** Display → Sun
drags the hour from first light to last, and the season selector re-fetches the
day. The track comes from `GET /api/sun/day` (`sun.py day`) ONCE per date and is
interpolated locally to avoid a round trip to a Python subprocess for every
position — `viewer/src/shell/sunpath.js` must never grow astronomy of its own.
Shadows are independent of the plant-detail preset so they are available in Fast preview.
**TWO THINGS ABOUT SHADOWS THAT ARE INVISIBLE IN SOURCE.** three compiles
`USE_SHADOWMAP` into every program, so setting `renderer.shadowMap.enabled` after
the first frame does NOTHING until every material is rebuilt — use
`setShadows(renderer, scene, on)`, never the flag alone; `shadowMap.needsUpdate`
re-renders the map and does not recompile the shaders that sample it. And the
shadow camera must be FITTED to the design (`lighting.fitTo(box)`): over a whole
60 m site, 2048 texels are 2.9 cm each and the normal bias that stops a 13°
slope striping is 3 cm, so the sample goes clean through a 2 cm leaf and toggling
shadows can produce byte-identical renders. A bias is priced in TEXELS and
then converted — chosen as a length it grows when the box shrinks. Fitted: 30.3%
of an eye-level frame changes, at 12-18 ms against 2.8. **The measured limit: this
reaches BODY scale (boulder, lantern, bench, canopy) and cannot reach leaf scale
at yard scale.**
**SEEING IT IN THE SITE AT 1:1 — `tools/ar_export.py`.** The user needs a view
aligned to the site at full scale. This needs neither GPS (3–5 m accuracy) nor north
calibration. Scaniverse cannot do it itself — capture and export only, no import.

**The phone must show the planting at mature size.** In RealityKit (`tools/ar_render.swift`),
a scan shell can hide the design, and 3.5 cm plant markers do not show the planting.
So there is **no scan**, and **the plants are imposters**: each species built once at
full detail in the viewer and
photographed side-on and from above; every plant is three crossed cards of that picture at
mature size (+1 flat card for low spreaders), cut out by alpha with `opacityThreshold`.
A 159-plant design is 2,300 triangles; the file is 21 MB and made in 10-40 s. The site's landmarks are
posts, and the origin is kept near the planting. The native PEDON app aligns this frame
from two points picked on the original scan and matched on real ground (`ios/README.md`). Size limits rule out the alternatives: real
foliage 472 MB / 1.5 GB of GLB; Fast preview 3.9 M triangles; leaf cards decimate into
nothing. Two traps in the conversion, both measured: the viewer's drapes arrive in Blender
as unshared triangles, so decimating without welding keeps 1.02 M points for 160 k triangles;
and Blender does not write `opacityThreshold`, so every card is a pale box until it is added.
The geometry comes from the VIEWER through `export_scene`, because only the viewer has the
scan and placed geometry with their correct transforms and ground levels.
**The phone reaches it through its own READ-ONLY door** (`docs/planting-out.md`):
`viewer/ar_server.js` on `:5179` serves `data/ar` and nothing else. The dev server itself
stays on localhost.
**`window.__pedon` IS A READ-ONLY WINDOW ON THE RENDERER.** `renderer()`,
`shadows()`, `shadowCamera()`, `sun()`, `frameMs(n)`. Direct renderer access avoids
misleading measurements: `drawImage` on the canvas gives the same number at every hour
(no `preserveDrawingBuffer`),
counting `requestAnimationFrame` gives zero fps (a BACKGROUNDED tab is throttled),
and timing a shadow map alone does not establish that shaders sample it. It reports and
sets nothing — a debug handle that can change state is a second write path.
**A PATH-TRACED VIEW — `tools/photoreal.py`.**

```bash
python3 tools/photoreal.py --viewpoint "from the back door"
python3 tools/photoreal.py --subject sunny_bank --samples 24 --reuse-scene
```

This path traces the viewer's actual geometry, preserving the specified plant
positions and hardscape. Generated photographic views are a separate capability
(described above), saved separately so the two outputs can be compared. Measured: export
78-97 s / 648 MB, glTF import 18.6 s, render 8 s at 720x450/24 samples — so
minutes for the first frame and **~28 s for each one after, with
`--reuse-scene`**. These timings measure preview geometry; full-detail planting is subject
to the render budget described above. The geometry comes from the VIEWER (`export_scene`, a
broker op) because only the viewer knows the yaw, the ground under each object and which
GLB a species routes to; rebuilding that in Python duplicates those decisions. Blender imports the exported
plants with `tools/blender_plant_instances.py`, which keeps GPU instances as instances (Geometry
Nodes, exact transforms and per-instance colour) instead of expanding them into copies. It runs
inside Blender, which photoreal.py starts; it imports `bpy` and does not run under python3.

Three things it gets right that are easy to get wrong. It lights at the hour the
scan was PHOTOGRAPHED: using the current time can put the sun below the horizon
(−21.7° in a measured frame), producing a night view. The camera stands on ground the
scanner actually SAW, never the filled field. When north is unset, the shadow
DIRECTION is arbitrary, so the file is named `view_BEARING-UNVERIFIED.png` — an
artefact that does not carry its own caveat
gets read as if it had none.
**A BROKER CALL WITH MULTIPLE VIEWERS USES THE FIRST SUCCESS.** Every tab
answers, and an error can arrive before another tab's successful reply. An error
is HELD and the first SUCCESS wins; a call every subscriber refuses returns the
last refusal rather than a bare timeout.
**A LOST WEBGL CONTEXT REFUSES TO RENDER instead of returning black.**
`renderer.render()` on a dead context returns in 0 ms with 0 draw calls and does
not throw, so a completed render call alone cannot establish a successful `look`.
`looked_at_own_work` requires successful returned-image evidence, not just a call-log
entry, so black pictures cannot satisfy the requirement to review the design.
`viewport.renderRefusal(op, renderer)` is the decision; CPU ops (`scan_grid`,
`frame_check`, `float_check`) still answer, because refusing those would turn one
broken tab into a broken onboarding.
**The sun is on a clock** (`viewer/src/sunclock.js` + `GET /api/sun`). It defaults
to the hour the SCAN was photographed — read off the capture's own filename — because
the plate's shadows are baked in and lighting the design at a different hour is the
one error you cannot art-direct around. `setSunFromAzimuthAltitude` must receive
the capture's sun position: using 29.209° instead of an arbitrary 47.969° changes
52.1% of a measured eye-level frame. The astronomy is
`tools/sun.py` reached over HTTP, never a second model in JS, and with north unset
the AZIMUTH is refused and the panel says "bearing not known — set north" rather
than printing the fallback as fact. "lit at" in the panel moves it; "capture hour"
puts it back.
**Leaves are translucent** (`viewer/src/translucency.js`): a leaf is thin, so the
sun behind it comes THROUGH, and a `MeshStandardMaterial` alone gives a backlit leaf
exactly zero direct light. The amount is per LEAF CLASS — a rosemary needle is waxy
and nearly opaque, a broad thin blade is stained glass, a petal more than either —
and the transmitted colour is warmer and greener, because chlorophyll passes green
and yellow. Wood gets none. It is installed with `onBeforeCompile` (not
`MeshPhysicalMaterial.transmission`, which re-renders the scene per material and
would be a slideshow at 114 plants), so `ANCHORS` names the three.js chunks it
patches and a test asserts they still exist — a `String.replace` that does not match
is silent, and would leave every leaf opaque with the suite green. Backlighting is a
LOW-SUN effect: at the sun's 48 deg midday elevation the lobe runs at a fifth of its
peak, and four times stronger in the evening.
**Lighting** is a physical sky gradient (`viewer/src/lighting.js`), sampled into an
equirectangular texture used BOTH as `scene.background` and, through PMREM, as
`scene.environment` — so a leaf takes sky from above and bounce from below, which is
most of what separates a garden from a product shot. `skyDirection()` is the ONE
row-to-direction mapping (row 0 is the ZENITH) and `skyIrradiance` calls it rather
than re-deriving, so the convention cannot drift between copies. three.js wants
the opposite row order, so `skyTexture` reverses ON UPLOAD ONLY.

**THE CAPTURE CLOCK MUST CARRY ITS UTC OFFSET**. `sun.py position`
defaults to UTC. `photoreal.sun_position_args` passes the local offset for
the capture date, matching `sunclock.js` (including daylight saving). In a measured
capture, 17:17 local means −07:00 and 29.209° altitude; omitting the offset gives
42.727° while the result still claims to show the capture hour.

## Level surfaces are cut into the scan

A terrace, bench walk or terraced bed with `level_m` sits below the photographed ground on
its uphill side. `viewer/src/carve.js` discards the capture's fragments (and its shadow
catcher's) inside each level surface's footprint and above its level; `design.cutFaceMesh`
draws the face from the level to the ground at the edge; plants and objects on a level
surface stand on its level (`design.designedGround`). Raycasts are untouched — measured
heights are still the ground. The photoreal export is cut too: Blender reads
geometry, not the shader, so `export_scene` hands it a copy of the scan with the triangles
inside a level surface and above its level removed (`carve.carveForExport`, the shader's own
test; the one on screen is untouched). The AR file needs no cut — it carries no scan.
Tests: `tests/js/carve.test.mjs`.
