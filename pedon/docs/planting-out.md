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
PEDON viewer, usually) the sheet says so and the door stays shut. The sheet's QR code opens the file in Safari's AR Quick Look, which
sets the garden down at true size wherever the phone finds ground; the user lines it up by hand.
The file also carries a plan of the design, the ground's height every 0.5 m and every landmark's
place in its frame (`yard.json`) — legacy metadata. For app alignment the export also includes a separate, textured original
capture (`scan.file` in `yard.json`, a `*.scan.usdz`). The user rotates and zooms that capture,
picks two existing ground features, then matches the same points on site. Proposed plants and
new bed edges are not alignment references. Surface hits retain measured height; the scan
keeps all triangles and calibration, in the same frame as the design, including nonzero north.
It is never carved to fit proposed terraces or drawn over the AR planting.

The app's Settings stores the user's Mac address shown by this sheet; no connection address
is built into the app. A fresh installation opens those settings. Builds can be shared without
carrying the developer's network details. The original scan is served read-only alongside the
current design; it cannot become the design selected by `current.json`. Older exports are
regenerated once to add the scan metadata. Without a mesh capture the app asks for one instead
of substituting a plan. The native app remains local under `ios/`; physical camera alignment
must still be checked on site.

**The plants travel as PICTURES of themselves** (`viewer/src/ar_cards.js`). Each
species is built once at full detail and photographed from the side and from above; every
plant is three crossed cards of that picture at its mature size, plus a card across the
top for low spreading plants. A garden of ~160 plants is a few thousand triangles, where its
real foliage runs to gigabytes and even Fast preview to millions of triangles.

**The AR overlay omits the scan.** In RealityKit (the engine Quick Look runs on) the scan draws as a grey shell
over the whole site with the design underneath. The site's LANDMARKS go instead: an orange
post and its name at each, so after lining up you can see whether the other posts stand on
their real spots. The file's origin is the landmark nearest the planting (a red post, "start
here") and `yard.json` carries every landmark's place in the file's frame — checked in
RealityKit to the millimetre — which is what lining it up from marks needs. A vague landmark ("a hedge
row") makes a vague mark; corners and stakes are better, and can be added in Places.

**Checking it without a phone — `tools/ar_render.swift`.** RealityKit, the engine Quick
Look runs on, renders the file offscreen on the Mac from any eye, so scan occlusion can
be checked directly. `qlmanage -t` is not a substitute: it can take over an hour without
producing an image. The iOS Simulator opens the phone page but needs a tap to reach Quick
Look. Usage is in the file's header.

**The phone has its own door** — `viewer/ar_server.js`, a second server on `:5179` that
is read-only and serves the design `.usdz` files, the current alignment scan in `data/ar`,
current export metadata and one page. The dev
server stays on localhost: `host: true` would put `/api/ops`, `/api/delete` and
`POST /api/site` on the whole Wi-Fi. It is a per-process singleton, because Vite re-runs
its config on every restart and a second server racing the first for the port can leave
nothing listening. A restart hands the running server the NEW module's handler because
the server outlives module edits and would otherwise serve stale content.
