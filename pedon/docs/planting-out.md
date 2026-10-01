# Planting out — from the design to a hole in the ground

Planting out requires placing plants at the design's measured locations. Two instruments
check each other: paper the user can hold a tape against, and the design standing on site
at true size on their phone.

## The drawings — ··· → **Planting drawings to print…**

Select the beds being planted first (a whole site does not fit a sheet at 1:50), then
the menu entry; the sheets open in a new tab, Letter landscape, ready to print at 100%.
`tools/planting_plan.py` makes them — the viewer calls it through `GET /api/plan`.

```bash
python3 tools/planting_plan.py --design data/design.json --beds bank_bed
#   the baseline is found from the beds; --from A,B names the two landmarks to tape from
```

They are the three things the trade builds from (UF/IFAS ENH1195; RHS and OCGD on
linear surveying):

| sheet | what it is |
| --- | --- |
| **L-1 Planting plan** | plan view at 1:50. Each plant is a circle at its MATURE spread with a cross where the hole goes, keyed by a code (`MUH CAP`); a mass of one small species is labelled once, `7 – THY PIN`. Scale bar, so a print can be checked with a ruler. |
| **L-2 Plant schedule** | code · botanical · common · quantity · size at planting · mature H × W · spacing on centre · notes. The shopping list. SIZE AT PLANTING is blank on purpose — container sizes are not recorded yet. Spacing is MEASURED from the design. `cat_safe: null` prints as "cat safety NOT verified". |
| **L-3 Setting out** | stake the baseline (the walk's centreline) by TWO TAPES from two of the site's landmarks, run a string, then plant down the table by STATION along the string and OFFSET square off it, left or right. Walking order, with a tick box. |

Three decisions in it that are not obvious:

- **Distances, never bearings.** North may not be set on a site, and GPS is good to
  3-5 m. A distance between two points is the same in any frame, so two tapes need neither.
- **Taut-tape distances, ground to ground.** On a slope of 20%, over 10 m a plan
  distance is 20 cm short, which is the width of a plant. Ground is `agent.ground_at`.
- **The nearest landmarks that still fix every stake** (tapes crossing between 35° and
  145°), not the best angle at any distance. The sheet warns when a stake is weak. If the
  only good landmarks are vague ("a hedge"), mark better ones — Places, and they can be
  moved there.

## The phone — ··· → **See it on site…**

Opening it makes the design's AR file from the design on screen (10-40 s) unless the one on disk
is already of that design and newer than it. A phone on the same Wi-Fi reaches it through a
read-only door on this Mac (`:5179`, `viewer/ar_server.js`) that serves the design and its alignment scan — SHUT until the user opens it in the sheet, and remembered for this machine
(`<projects>/.phone-door`) only once it has opened: when another program holds :5179 (a second
PEDON viewer, usually) the sheet says so and the door stays shut. Open the
[PEDON iPhone app](../ios/README.md) on the same Wi-Fi and enter the sheet's address in its
Settings. The app is built from source with Xcode; browser AR viewing is not supported.
The file also carries a plan of the design, the ground's height every 0.5 m and every landmark's
place in its frame (`yard.json`) — legacy metadata. For app alignment the export also includes a separate, textured original
capture (`scan.file` in `yard.json`, a `*.scan.usdz`). The user rotates and zooms that capture,
picks two existing ground features, then matches the same points on site. Proposed plants and
new bed edges are not alignment references. Surface hits retain measured height; the scan
keeps all triangles and calibration, in the same frame as the design, including nonzero north.
It is never carved to fit proposed terraces. In the aligned view it stays hidden unless
the user switches on **Original scan** for comparison.

The app's Settings stores the user's Mac address shown by this sheet; no connection address
is built into the app. A fresh installation opens those settings. Builds can be shared without
carrying the developer's network details. The original scan is served read-only alongside the
current design; it cannot become the design selected by `current.json`. Older exports are
regenerated once to add the scan metadata. Without a mesh capture the app asks for one instead
of substituting a plan. The native source, build instructions and tests are in `ios/`. Alignment and tracking
accuracy must still be checked against fixed references on site.

**The plants travel as PICTURES of themselves** (`viewer/src/ar_cards.js`). Each
species is built once at full detail and photographed from the side and from above; every
plant is three crossed cards of that picture at its mature size, plus a card across the
top for low spreading plants. A garden of ~160 plants is a few thousand triangles, where its
real foliage runs to gigabytes and even Fast preview to millions of triangles.

**The AR overlay omits the scan by default.** An opaque scan can cover the real site and
planting. The optional **Original scan** control loads the separately exported, textured
capture as a translucent alignment reference; it shares the design's transform and has an
opacity slider. The site's LANDMARKS go with the design: an orange
post and its name at each, so after lining up you can see whether the other posts stand on
their real spots. The file's origin is the landmark nearest the planting (a red post, "start
here") and `yard.json` carries every landmark's place in the file's frame — checked in
RealityKit to the millimetre — which is what lining it up from marks needs. A vague landmark ("a hedge
row") makes a vague mark; corners and stakes are better, and can be added in Places.

**Checking it without a phone — `tools/ar_render.swift`.** RealityKit, the native app’s renderer, renders the file offscreen on the Mac from any eye, so scan occlusion can
be checked directly. `qlmanage -t` is not a substitute: it can take over an hour without
producing an image. The native app also has a Simulator preview for UI checks; see `ios/README.md`.
Usage for the offscreen renderer is in its header.

**The phone has its own door** — `viewer/ar_server.js`, a second server on `:5179` that
is read-only and serves the design `.usdz` files, the current alignment scan in `data/ar`,
and current export metadata; it serves no browser viewer. The dev
server stays on localhost: `host: true` would put `/api/ops`, `/api/delete` and
`POST /api/site` on the whole Wi-Fi. It is a per-process singleton, because Vite re-runs
its config on every restart and a second server racing the first for the port can leave
nothing listening. A restart hands the running server the NEW module's handler because
the server outlives module edits and would otherwise serve stale content.

### Native phone controls

After alignment, **Planting guide** replaces the 3D planting and hardscape with small crosses
at the exported planting centers, with plant IDs. The cross is the stem location, not a hole
size or mature spread. Tap a target to select it, or use **Individual plants** to search by
name/ID, show/hide individuals, or isolate one. The selected plant's name and Hide/Show button
stay available when controls are collapsed. Guide mode preserves the 3D layer settings so
returning to **3D view** restores them. It also turns off real-world occlusion for the thin
markers so a soil-depth estimate cannot swallow them. Targets still depend on the user's
alignment and AR tracking; check a fixed reference before using them to set out plants.

**Hide controls** leaves a compact bar; **Controls** restores the panel. Move/turn/re-mark
controls live under **Adjust alignment**. Returning to **Change points / Other points** starts
a fresh scan camera, and **Show whole scan** recovers the full capture after panning or zooming.
Each picker owns its scene nodes (shared geometry/textures), so old cameras and badges cannot
alter the next picker's bounds. The export keeps one named node per plant while sharing the
species pictures, plus `plant_items` mapping IDs/names/nodes to exact, Y-up planting positions.

**Original scan** can be switched on/off in the aligned view or with the compact bar's scan
button. Its opacity starts at 35%; use **Adjust alignment** while comparing fixed features
with the camera. Scan and design move together, and the overlay does not intercept plant
selection taps. It loads only when needed. Real-world occlusion is disabled while the scan
reference is visible, then returns to the user's setting. This is a check after two-point
alignment or saved-location recognition, not an automatic registration algorithm.

Selecting a visible target in **Planting guide** shows that individual at **50% opacity**, at
its exported mature dimensions, while the other plant models stay hidden. Deselecting or hiding
it removes the preview; returning to 3D view restores ordinary opacity and visibility. The
selected bar shows its planned height/width. **Plant details** opens recorded botanical name,
dimensions (feet/inches and metres), sun, water, flowering, habit and notes from the catalogue,
when present. Design-specific sizes take priority over catalogue sizes. Unidentified plants
and unknown cat safety remain unverified; a genus toxicity match cannot supply cultivar facts.
Details come from the same export as the preview; opening the sheet makes no additional network request.

**Resume on the phone:** the app keeps a durable local copy of the loaded export and scan.
After alignment it saves an AR world map when mapping is ready (**Position saved on this
iPhone**); nudges are saved too. Reopening loads this saved design even without the Mac and
asks the camera to recognize the same location. Plants stay hidden until normal tracking
and the saved anchor agree. **Align again** recovers when the site cannot be recognized;
**↻** fetches design changes. A different scan or coordinate frame cannot reuse the old
alignment. See `ios/README.md` for the saved-map workflow and tests.

**App Store preparation:** `ios/appstore/README.md` records the first iPhone release's store
copy, privacy disclosures, compiled-archive checks and remaining account/review requirements.
An App Store listing is not live until Apple approves it and the publisher releases it.
