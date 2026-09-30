# The library — what is made along the way, and whose it is

PEDON is three places (`schema/project_layout.json` says so, and `tools/project.py` /
`viewer/project_paths.js` are the only code that finds them):

| | where | what |
| --- | --- | --- |
| **the app** | this checkout | code, tools, validators, the viewer, the skills and docs — **no assets** |
| **the library** | `~/PEDON/library` (`PEDON_LIBRARY` moves it) | everything made or fetched along the way: plant and object models, their textures, reference photographs, the plant catalogue, species builders — **the user's**, shared by every site |
| **projects** | `~/PEDON/<site>/` (`PEDON_PROJECTS` moves them) | one site each: its scan, ground truth (`site.json`), designs, and its own policy (`project.json`) |

A path an agent or a design writes is **virtual**: `data/plant_palette.json`, `data/refphotos/…`
and `assets/…` are the library's; every other `data/…` name is the active site's. Never join the
checkout to `data` or `assets` — `tests/test_project.py` fails when anything does.

An empty library is a working one. With no catalogue the design agent states each plant's mature
height and spread itself; with no species builders every plant is drawn by the generic generator;
with no models a tree is drawn by code. A newcomer starts with `python3 tools/project.py demo --open`
(or **Open the demo garden** on the first screen): a small garden made by code (`tools/demo_site.py`).

## What is in it

| path | what | how it gets there |
| --- | --- | --- |
| `plant_palette.json` | the plant catalogue: per species, mature size with its evidence, water, sun, bloom, colours, cat safety with its sources | written as research is done — rows cite their sources; `tools/plant_catalog.py` is the one reader |
| `species/*.js` | species builders: code that draws ONE species from its photographs | written by a design session; `species/order.json` says which is asked first; `species/tests/` holds their tests. See `docs/plants.md` |
| `assets/plants/*.glb`, `manifest.json` | plant models (trees, and any species given its own model) | `tools/gen_trees.py` (Blender) makes the trees; `find_asset` / `fetch_asset` / `make_asset` any other |
| `assets/plants/botanical/` | the textures species builders draw leaves and petals with | made with the builder; each with its provenance beside it |
| `assets/objects/` | object models (a bench, a boulder, a sundial), a card beside each | `find_asset` / `fetch_asset` (Poly Haven) or `make_asset` (a sandboxed Blender script) |
| `refphotos/`, `index.json` | reference photographs, one per species | `tools/plant_photos.py` (Wikimedia Commons), `tools/owner_photo.py` (your own) |
| `cache/` | what a tool fetched and may fetch again | the tools |

## What every item carries

**Where it came from, and on what terms.** An item whose origin is not recorded is not
shareable, and nothing may guess one for it — an unknown source stays unknown.

| item | carries |
| --- | --- |
| object model | its card's `source`: `{from: "polyhaven", id, url, license, authors}` or `{from: "made", script, sha1}` |
| plant model | its manifest entry's `source`: the same two forms, or `{from: "generated", script: "tools/gen_trees.py", preset, seed}` for a tree the app's generator built. A model with no `source` has an unrecorded origin, and is treated as generated |
| reference photograph | `artist`, `licence`, `source` (the page it came from) in `refphotos/index.json`; your own photos `source: "owner"` |
| texture | a `.provenance.json` (and the prompt, if generated) beside it |
| species builder | a header naming the photographs it was modelled from |
| catalogue row | its evidence: `size_evidence`, `cat_safety.sources`; `cat_safe: null` means NOT ASSESSED, never safe |

A licence travels with the asset: CC0 needs nothing, CC BY and CC BY-SA need their credit kept.
The app ships none of these files, so it carries none of their licences.

## What is NOT in the library

A **site's** facts and choices are its project's: the scan, the ground truth, the designs — and
its policy. Whether cats have the run of a garden is `project.json`'s `"policy":
{"cats_have_access": true}`, which excludes plants known toxic to cats **on that site only**
(`project.policy()`, and the viewer's Add library). It belongs to the site, not the catalogue: in
the catalogue, one garden's cats would keep lavender out of every garden.

## Sharing it

A library is a folder: copy it, or keep it in its own version control (models are large — keep
them out of a plain git history). Everything in it says where it came from, which is what makes
handing it to someone else possible.
