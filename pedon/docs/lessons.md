# Engineering rules

These rules live here rather than in the entry doc so the entry doc stays short;
read them before changing something they explain.

The design-process guidance lives in one place: [DESIGNING.md](../DESIGNING.md).
Read its sections on the current source, visual judgement and drawing masses
before coordinates. Rendered and validated does not mean owner-approved.

## Core rules

- **A file URL is not the identity of a saved asset.** On iPhone, a path constructed under
  `/var/mobile` can be enumerated back under `/private/var/mobile`. Comparing those URLs as
  strings made the native cache delete its newest design and scan before RealityKit could
  load them. Compare the persisted asset UUID when pruning old versions. Test through a
  symbolic directory alias: ordinary Simulator paths hid this device failure.

- **ENU and world are different frames, and they are IDENTICAL at yaw 0.**
  Everything looks correct until someone presses "Set north" and the two frames
  separate by the yaw. Storing world coordinates as ENU breaks three paths:
  design/area groups attached to the scene lose alignment when the scan rotates
  (a bed 14 m from the origin is 5.8 m off its ground at 23°); landmark reprojection
  can write coordinates 8.8 m off into site.json, damaging stored data; and
  structure detection measures candidates against the wrong ground. The scene graph is:

      scene > geoGroup ("geo": north yaw + xz) > levelGroup ("level") > the scan
                                               > enuGroup ("enu")     > designs, areas, pins, footprint

  so north is a pure viewing transform and NO stored coordinate ever migrates.
  Rules: anything drawn from stored ENU goes under `enuGroup`; a raycast returns
  WORLD, so run it through `worldToEnu()` before storing; `heightAt`/`enuToWorld`
  are ENU-frame functions, and `enuToWorldPoint()` is the one that reaches world.
  **Test at a non-zero yaw or you have tested nothing** — `tools/frame_check.py`
  does exactly that, and it is verified to fail when the bug is reintroduced.
- **Height needs a measurement, so ASK instead of looking.** A filled height
  field can read a deck as ground, leaving beds on the deck; a fallback field
  built in the world frame can lift planting when north changes.
  `tools/float_check.py` asks about every object at once. It
  compares an object's lowest point against the HIGHEST ground under its whole
  footprint, so a terrace legitimately retained above its downhill slope does not
  register, and it samples the footprint rather than the centre — centre-ground
  marks beds on a 13° slope as buried by half a width times the slope.
- **Never hand-roll a lookup that already exists.** Reversing height-field rows
  produces a mirrored site and misleading measurements. Import `agent.ground_at`
  / `site_api.scan_at`. The shared primitives have homes and `tests/test_dry.py`
  fails if a second copy appears: **`tools/geom.py`** (point_in_polygon,
  polygon_area) and **`tools/broker.py`** (the one client for the viewer's render
  broker, including closed-viewer errors for onboarding through `analyze_site`).
  A tie rule counts as a lookup too: `scan_at` rounds half-UP because JS
  `Math.round` does, and python's `round()` is half-to-even — at an exact
  half-cell query the two can pick different cells.
- **Sample whole shapes, not vertices.** Sampling only a polygon's corners or a
  spline's points misses terrain between them — a wall declared 0.7 m can render
  2.59 m high where the ground dips between two points.
  Use `_walk_line` / `_walk_polygon`.
- **A landmark's NAME is a model's guess; a measured zone is a fact.** A south
  fence labelled "back_fence" does not establish which part of the site it bounds.
  Use `site.zones`, never the name.
- **Flat ground is the scarce resource.** On a hillside site only a few percent of
  the ground may be under 9°. Reserve flat ground for usable area (`set_patio`), put planting on the slope.
- **Physical facts and code are ENFORCED; taste is only ever REPORTED.** Every
  hard rejection in `validate()` is measured ground, building code or physically unplantable — none is
  about style, palette or ratio. Material and patio purpose are FREE TEXT: an
  unmodelled one renders as the nearest surface, warns, and lands on the owner's
  want list. The library must never cap the design.
- **Measure the artefact that reached disk.** `run()` prints `[final]` — the
  composition of the SAVED design — because the design agent verifies a scratch
  file BEFORE run()'s own last op. That op can change the plant count substantially,
  so a scratch-file report does not describe the saved result.
- **An arrangement pass may MOVE a plant; it may never DELETE one.** Deleting
  plants that do not knit can improve a grouping ratio while removing much of the
  intended planting. A grouping ratio is a
  DIAGNOSTIC, never a target: it can run backwards against the owner's judgement.
  The rule-based pass and its ratio are not part of the design loop.
- **Cat safety has three states, and null is not safe.** `plant_palette.json` carries `cat_safe`
  with THREE states: true (cited non-toxic evidence for the named taxon), false
  (cited toxicity exclusion), null (unverified). The separate
  `cat_safety` record states source, taxon and evidence scope; cultivar-specific
  evidence is never invented from a species listing. `list_assets cat_safe_only`
  returns only true. On a site whose `project.json` policy says cats have access,
  `plant_catalog.plant_issues` enforces the exclusions through the actual design validator.
- **Repetition makes a garden** — but this is a REASON, not a rule. Left alone a
  model picks nearly a different species for every plant, which is a nursery order
  rather than a planting; drifts of one species read as a garden. Give it that reason.
  Do NOT give it a species count as a target: a model treats the number as a cap and
  cuts a long shortlist down to meet it. A number in a brief is a restriction wherever
  it is written down, even when the brief calls it a reference.
- **RETAINING WALLS ARE DETECTED IN `site.walls_detected`.**
  `analyze_site.find_walls` reads them off the height field as near-vertical bands
  (grade over 0.65 with at least 0.45 m of rise, runs of 1 m or more, and a
  coherent fall direction so a boulder or a scan dropout is not mistaken for
  masonry). `validate()` WARNS when a
  bed or patio outline sits on one — a warning, because a retained bed legitimately
  abuts a wall and the 1 m scan is fragmentary near structures. A bed can have several
  outline points on a wall. Still profile with `site_api profile` before extending
  onto new ground: the detector reads a sparse scan and a wall it misses is still a wall.
- **"NOT INSIDE THE HOUSE" IS NOT "PLANTABLE GROUND".** Retaining walls can
  exist in the scan without appearing in detected structures, so a house-footprint
  check alone cannot establish plantable ground. A profile can show a **drop of
  nearly 2 m in a single step**, with the strip beyond it sitting up to a metre ABOVE
  the bank: extending a bed across the step covers a wall's crest and face with
  soil. Before extending any bed or patio onto ground you have not already built
  on, run `site_api profile` ACROSS it and look for a step: a metre of fall in a
  fifth of a metre is a wall, not a slope. Walking downhill along the profile until
  the grade drops under 35° identifies the base of the bank.
  `analyze_site.find_walls` detects walls, but a sparse scan still misses some,
  so profile before building on new ground.
- **A BED OUTLINE OFFSET FROM A PATH *CONTAINS* THE PATH, so "inside the bed" is
  not "on soil".** Offsetting a walk at exactly its own half-width closes a strip
  of bare scan beside the paving, but also makes the polygon swallow the walk:
  **nearly every centreline sample falls inside the bed**, so a placer that tests
  only the polygon puts plant centres on the paving, some a centimetre off the
  centreline. `validate()` warns (`stand ON path`), testing the CENTRE only —
  canopies may overhang paving — and it is a warning because a thyme between
  stepping stones is a real planting. `tests/test_plants_on_paving.py` checks this
  against faulty and corrected placements.
- **LEFT AND RIGHT ARE THE OWNER'S, FROM WHERE THEY STAND.** When the owner
  views a bank looking west, north is their RIGHT; adding grass to the north does
  not satisfy a request for grass on the left. Establish the viewing direction
  before acting on a left/right instruction — `site_api near` and the patio
  positions say where a person actually is. Align/distribute tools use COMPASS
  axes precisely because screen-left moves with the camera, but the owner's
  left/right instructions refer to their own viewpoint.
- **EVERYTHING LOOKS BARE AT THE DEFAULT GROWTH SCALE, AND THAT IS NOT A PLANTING
  FAULT.** "Plants at" defaults to ~5 years (0.70), and coverage goes as the SQUARE
  of it, so a bed at a healthy 1.83x mature canopy renders at 0.90x — exactly where
  ground starts showing between plants. Compute mature coverage before adding
  plants to fix an appearance; under 1.0 at maturity is thin, about 1.0-1.3 closes.
  Spacing a bed so ~5 years looks finished can leave mature coverage above 2x,
  which reads as crowded at full maturity.
  Design for full size; `composition` reports `mature_coverage_by_bed`.
- The project's standing constraint: **no Anthropic or OpenAI API keys.** Subscription
  CLIs only.
- **Validation exposes physical errors in saved designs.** A design saved before a
  rule applied to it can carry errors — retaining height, grade, wall setback, or a
  path steeper than the 20% a walk is limited to.
  Reporting an existing error is not a regression; `set_steps` provides a way to
  handle slopes that are too steep for a walk.

- **A MEMORY LIMIT IS NOT A DIAGNOSIS.** Record phase boundaries and physical
  footprint, then compare one changed representation on the same export. Geometry
  Nodes realization can exhaust memory before Cycles starts even when native
  import of the identical geometry fits. Also verify the clock: Blender and
  system Python can have different monotonic origins, so subtracting their times
  can produce plausible-looking but wrong phase durations.
- **Shared tools are checked by the active agent.** The current agent checks
  tools it can call directly. Provider-specific startup tests use that same
  provider; cross-provider comparison is separate work, done when asked for.
  See AGENTS.md.
- **A GUARD EVERYBODY OVERRIDES GUARDS NOTHING.** Overriding the suite's CPU
  budget can hide a real regression: validating once per warning can make
  `check-ops` take 15.5 s for an empty op list. When a tripwire fires every run,
  use `--durations` to find the cause before increasing the budget — and if the
  number does need to move, its written reasoning moves with it in the same change.
- **A CALL INSIDE A COMPREHENSION'S CONDITION RUNS ONCE PER ELEMENT.**
  `[w for w in warns if w not in set(validate(...)[1])]` runs validate 248 times
  for 248 warnings. Its cost grows with the warning count. Hoist anything that
  does not depend on the loop variable, and guard it by COUNTING calls
  — a timing assertion measures the machine.
- **A BROWSER NUMBER IS ONLY AS GOOD AS THE TAB IT CAME FROM.** Automation tabs here
  are hidden (`document.hidden`, `outerWidth` 0). CPU runs at node speed in them, but
  a page LOAD does not: the same build of ~240 plants can take 20 s during
  a background load and 3 s in the idle page. A slow preview measurement
  can describe the tab rather than the app. `editTimings` records `hidden`; read
  it before believing a duration, and never quote a frame rate from a hidden tab
  — it is zero by definition.
- **TIME THE SYNCHRONOUS PART.** Work started inside one `Promise.all` and timed
  across its `await` charges every item for every other item's turn: `plantTimings`
  can report 483 s of work inside a 33 s build.
- **WHAT READS THE GROUND, AND WHAT ONLY STANDS ON IT.** Beds, paths, edges and steps
  ARE the ground's shape and must rebuild when it changes. A plant or an object reads
  it for its height and nothing else, so it is re-seated, never rebuilt — that
  distinction accounts for 6-30 s of page-load work in measured designs.
- **AN ID IS NOT A LABEL, AND `indexOf` CAN RETURN -1.** Comparing dock IDS
  between two files does not detect drifting labels or icons. Slicing from a
  missing anchor can leave a guard checking an empty string. Share the list;
  do not compare copies.
- **A PROXY DRAWN WITH SOMEONE ELSE'S MATERIAL INHERITS ITS ASSUMPTIONS.** Garden
  detail stands lumps in for a swarm of leaves and draws them with the caller's
  material — `vertexColors: true`, with no `color` attribute on the lump: WebGL
  supplies (0,0,0) and the plant is black. Checking for `instanceColor` alone is
  insufficient; black is a colour. Assert the VALUE.
- **A TEST DRAG WRITES OWNER DATA.** Verifying a marker move means moving a marker.
  Copy `data/site.json` first, restore it byte-for-byte after, and check the hash —
  and do the same for the owner's browser `localStorage` if the test touches view state.
  Restore BEFORE the next edit triggers a reload, or the viewer caches the test state.
- **MUTATING PYTHON IN PLACE CAN LEAVE THE MUTANT'S BYTECODE BEHIND.** Changing
  `>= 3` to `>= 1` and back inside one second can preserve size and mtime, leaving
  the mutant's `.pyc` fresh even after the source is restored. Python can store its
  cache outside `__pycache__`: on macOS `sys.pycache_prefix` can be
  `~/Library/Caches/com.apple.python`, so `find . -name '*.pyc'` finds nothing and
  `PYTHONDONTWRITEBYTECODE` still READS it. `dis` shows which constants are in the
  compiled function. After a python mutation loop, delete `module.__cached__`.
- **A REPORT NAMES WHEN SOMEONE NOTICED, NOT NECESSARILY WHAT CAUSED IT.**
  A missing group noticed after switching designs can originate in an earlier drag.
  `data/history/` is a snapshot before every write and `data/site_api_calls.log`
  holds each write's ops. Find the first snapshot without the thing, take the log
  row for that write, and REPLAY it on the snapshot before.

- **A RESTORED MUTANT CAN KEEP RUNNING.** Apple's Python 3.9 caches bytecode in
  `~/Library/Caches/com.apple.python/…` and trusts a cache whose source has the same SIZE and
  the same whole-second mtime. A mutation that only MOVES a line keeps the size, and a
  restore in the same second keeps the mtime — so later runs can execute mutated
  `geodata.main` while the file on disk is correct. Check `main.__code__.co_names`
  for names the source uses to detect stale bytecode.
  After a mutation check: `touch` the file a second later, or delete its cached `.pyc`
  (`python3 -c "import importlib.util; print(importlib.util.cache_from_source('tools/X.py'))"`),
  before believing the green that follows.

- **A CLEANUP THAT THROWS BEFORE THE STATE CHANGES STRANDS THE STATE.** `setMode` clears the
  old tool, then records the new mode. If `clearMeasure` writes to a missing
  `#measureOut` element, it throws, `mode` stays "measure", and every exit fails at
  the same line: the button, Esc, and Select. Clicking the tool and reading the
  page's errors exposes this fault; source review alone cannot verify the behaviour.
  When a tool will not let go, look for an exception in its exit before building another exit.

- **THE INSTRUMENT THAT SAMPLES SEES THE SAMPLE.** Reading 24 vertices of each
  mesh and every n-th instance in `drawnSpread` can miss a manzanita's cards (14%
  width error), a Ceanothus's outer leaves (7%), and a blade's tip (6%), and lets a
  plant exceed its declared spread by 10-25% while the fit reports it inside. Rounding
  the agreement measurement to the centimetre can hide a 5.5% miss on deer grass.
  Before trusting a small difference, measure it with every vertex once.

- **A THREE.JS CLONE IS NOT THE SAME OBJECT.** `Material.clone()` drops `onBeforeCompile`
  (a translucent leaf's copy is opaque) and `Object3D.clone()` drops `customDepthMaterial`
  (Fast copies shadow their cards as solid quads). Carry them across by hand, and test the
  thing the app draws — the clone — not the object you built.

- **ALPHA-TO-COVERAGE CANNOT DRAW A SPARSE THING.** At 4x MSAA it has five steps; shrunk
  for distance a 12%-dense card averages below the first and draws nothing, so sparse foliage
  vanishes into a haze. Hashed alpha keeps any fraction. A single lightness number
  combines colour, density and shading without identifying which needs changing.
  Split them — close range, no mipmaps, no shadows — before changing more.

## Compare the same individual

Fast draws each plant as one of a few individuals of its kind, so a Fast/full comparison built
from the plant's own id compares two different plants of one species — measured 6-11% apart in
width and 5-28% in lightness, all of it seed. `tools/preview_agreement.mjs` and `compare.html`
build full detail from `fastModelKey(plant)`. And a colour-distance "cover" figure counts a darker
leaf as missing cover: read it beside the picture, never alone.

## A reduction keeps what the eye integrates

Keeping a part's SIZE does not preserve everything the eye adds up: area (a capped leaf shell,
a rhombus stand-in, thinned sub-pixel parts in aggregate), facing (crossed planes for a one-sided
leaf), or shading (old normals on a coarse leaf). Size checks can pass despite these faults.
When a Fast plant reads darker, measure area, facing and normals of its parts against full
detail's before touching colour.

## Park the headless page

A private headless Chrome left on the viewer keeps drawing the garden every frame — ~90% of a core,
on your machine, for nothing. A measured build takes 6.2 s with the page drawing during
the suite and 3.7 s with it parked on `about:blank`. Send the page to `about:blank` after every
measurement, and check `ps` before believing a timing.


## A module reached two ways is two modules

The species builders load from the user's library by dynamic import, and Vite adds `?import` to a
dynamic import of a path — while a builder that ANOTHER builder imports is fetched by its plain
path. This creates two copies of `flowering_shoots.js`: a leaf texture registered in one is absent
from the other, affecting 5-8% of a species' pixels. Import by FULL URL (`viewer/src/species.js`)
to keep one module instance. A whole-garden pixel diff at one viewpoint can read only 0.11%
while individual plants in `compare.html`, full detail and Fast, show the fault. Check a loader
change species by species, and list the page's module URLs for a name that appears twice.

## Compare two builds from clean stores, and find a server by its port

An A/B between two origins inherits each origin's browser store. Different stores (109 kept Fast
plants versus 68 in a measured comparison) can produce a persistent 0.11% difference even when
the two builds render pixel-identically after `forgetPlantStore()` on both. Clear both stores
before comparing code. A scratch server launched as `./node_modules/.bin/vite --port N` does not
match a `pkill -f` pattern naming its folder, so it can keep serving old or mutated code. Stop
scratch servers by port (`lsof -ti tcp:N -sTCP:LISTEN`) and check which folder serves a port before
measuring it.

## A rewrite of the words in a code file can change the code

A pattern that strips citations like `(P3)` from comments also turns `t3.map(P3)` into
`t3.map` — valid syntax, silently wrong, and caught only by the tests of whatever it breaks. When a
tool or a pattern edits PROSE in code files at scale, prove the code did not move: parse the file
before and after, ignore comments, blank every string's contents, and require the two trees to be
identical. A syntax check cannot see this class; a structural comparison cannot miss it.
