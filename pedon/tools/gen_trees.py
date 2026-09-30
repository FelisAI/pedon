"""Generate real branching tree GLBs with Blender's Sapling generator.

No downloads, no licences, no API keys: Sapling Tree Gen ships with Blender and
runs headless, so a species library is a local build step rather than a
purchase. Output lands in assets/plants/ and is referenced from a design by
`asset`, exactly like a bought model would be.

    Blender -b -P tools/gen_trees.py -- --all
    Blender -b -P tools/gen_trees.py -- --species olive --seed 3

Presets are shaped from real growth habit. The parameters that actually decide
a silhouette are `shape` (crown envelope), `downAngle` (how far branches drop
from the parent), `baseSplits` (multi-trunk), `segSplits` (forkiness) and
`attractUp` (whether tips sweep up or droop) — everything else is detail.

Height is normalised on export so `mature_height_m` in the design stays the
single source of truth for scale in the viewer.

Every preset also declares the `form` (habit) it serves — tree, column, mound.
That is what a species outside the regex tables routes on, so a model added
here for another climate becomes reachable without touching assets.js.
"""
import argparse
import json
import os
import random
import sys

import addon_utils
import bpy

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# YARDTWIN_PLANT_OUT so a batch can be generated and INSPECTED before it replaces
# the library the viewer is serving. Writing straight into assets/plants churns
# Vite's watcher, and a design agent mid-run gets a reloading page under its own
# `look` calls — the render comes back blank and it reasons about that.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # Blender's python: find project.py
import project  # noqa: E402 — the user's library is where made models go
OUT = os.environ.get("YARDTWIN_PLANT_OUT") or project.resolve("assets/plants")
SAPLING = "bl_ext.blender_org.sapling_tree_gen"

SPECIES = {
    "olive": dict(
        # Olea europaea: multi-trunk from the base, gnarled forking, broad
        # low hemispherical crown, small grey-green leaves
        form="tree",
        shape="2", levels=3, baseSplits=3, baseSize=0.18,
        branches=(0, 34, 26, 12), length=(0.85, 0.4, 0.38, 0.34),
        downAngle=(90, 58, 50, 45), downAngleV=(0, 34, 26, 20),
        segSplits=(0.35, 0.28, 0.2, 0), splitAngle=(24, 20, 18, 0),
        curve=(6, -36, -34, 0), curveV=(50, 70, 70, 0), curveRes=(6, 5, 4, 1),
        ratio=0.021, scale=6.5, scaleV=1.0, taper=(1, 1, 1, 1),
        attractUp=(0.1, -0.3, -0.5, 0), ratioPower=1.25,
        leaves=560, leafSize_m=0.065, leafScaleX=0.24, leafShape="hex",
        leaf=(0.11, 0.135, 0.075), bark=(0.16, 0.14, 0.11),
    ),
    "cypress": dict(
        # Cupressus sempervirens 'Glauca': one stem, every branch swept hard
        # up against the trunk — the column comes from attractUp, not pruning
        form="column",
        shape="4", levels=2, baseSplits=0, baseSize=0.02,
        branches=(0, 60, 0, 0), length=(1.0, 0.3, 0, 0),
        downAngle=(90, 52, 45, 45), downAngleV=(0, 16, 0, 0),
        segSplits=(0, 0, 0, 0), splitAngle=(0, 0, 0, 0),
        curve=(0, -8, 0, 0), curveV=(14, 30, 0, 0), curveRes=(6, 4, 1, 1),
        ratio=0.011, scale=9.0, scaleV=1.2, taper=(1, 1, 1, 1),
        attractUp=(0, 1.7, 0, 0), ratioPower=1.4,
        leaves=70, leafSize_m=0.15, leafScaleX=0.45, leafShape="hex",
        leaf=(0.21, 0.32, 0.25), bark=(0.34, 0.29, 0.24),
    ),
    "maple": dict(
        # Acer palmatum: short trunk splitting low into a wide vase, tips
        # drooping — layered horizontal fans
        form="tree",
        shape="2", levels=3, baseSplits=2, baseSize=0.14,
        branches=(0, 22, 20, 10), length=(0.7, 0.55, 0.48, 0.4),
        downAngle=(90, 66, 58, 50), downAngleV=(0, 26, 24, 20),
        segSplits=(0.3, 0.35, 0.25, 0), splitAngle=(20, 26, 22, 0),
        curve=(4, -46, -40, 0), curveV=(40, 60, 60, 0), curveRes=(5, 5, 4, 1),
        ratio=0.017, scale=4.5, scaleV=0.7, taper=(1, 1, 1, 1),
        attractUp=(0, -0.9, -1.1, 0), ratioPower=1.2,
        leaves=52, leafSize_m=0.145, leafScaleX=0.95, leafShape="hex",
        leaf=(0.24, 0.36, 0.19), bark=(0.62, 0.29, 0.20),
    ),
    "pine": dict(
        # Pinus thunbergii: strong leader, branches held near horizontal in
        # open tiers, dark needles — the classic niwaki silhouette
        form="tree",
        shape="7", levels=3, baseSplits=0, baseSize=0.28,
        branches=(0, 20, 14, 8), length=(1.0, 0.42, 0.34, 0.28),
        downAngle=(90, 78, 70, 60), downAngleV=(0, 20, 18, 15),
        segSplits=(0.15, 0.3, 0.2, 0), splitAngle=(14, 40, 34, 0),
        curve=(10, -14, -10, 0), curveV=(60, 60, 50, 0), curveRes=(7, 4, 3, 1),
        ratio=0.019, scale=7.0, scaleV=1.2, taper=(1, 1, 1, 1),
        attractUp=(0, -1.4, -1.2, 0), ratioPower=1.3,
        leaves=75, leafSize_m=0.19, leafScaleX=0.3, leafShape="hex",
        leaf=(0.18, 0.28, 0.20), bark=(0.28, 0.23, 0.20),
    ),
    "citrus": dict(
        # Citrus: dense rounded evergreen head branching close to the ground
        form="tree",
        shape="1", levels=3, baseSplits=1, baseSize=0.12,
        branches=(0, 40, 30, 14), length=(0.55, 0.45, 0.4, 0.34),
        downAngle=(90, 60, 52, 45), downAngleV=(0, 30, 26, 20),
        segSplits=(0.25, 0.3, 0.2, 0), splitAngle=(22, 24, 20, 0),
        curve=(4, -30, -26, 0), curveV=(40, 50, 50, 0), curveRes=(5, 4, 3, 1),
        ratio=0.02, scale=3.8, scaleV=0.5, taper=(1, 1, 1, 1),
        attractUp=(0, -0.5, -0.7, 0), ratioPower=1.2,
        leaves=95, leafSize_m=0.115, leafScaleX=0.65, leafShape="hex",
        leaf=(0.16, 0.34, 0.18), bark=(0.38, 0.32, 0.27),
    ),
    "plum": dict(
        # Prunus mume: sparse, angular, upswept whippy shoots off a short
        # crooked trunk — reads as a winter-flowering plum even bare
        form="tree",
        shape="2", levels=3, baseSplits=2, baseSize=0.16,
        branches=(0, 22, 18, 8), length=(0.75, 0.55, 0.5, 0.4),
        downAngle=(90, 50, 40, 35), downAngleV=(0, 40, 34, 26),
        segSplits=(0.4, 0.2, 0.15, 0), splitAngle=(34, 30, 26, 0),
        curve=(14, -20, -14, 0), curveV=(90, 80, 70, 0), curveRes=(5, 4, 3, 1),
        ratio=0.016, scale=4.2, scaleV=0.6, taper=(1, 1, 1, 1),
        attractUp=(0.1, 0.6, 0.9, 0), ratioPower=1.3,
        leaves=200, leafSize_m=0.065, leafScaleX=0.55, leafShape="hex",
        leaf=(0.19, 0.28, 0.15), bark=(0.20, 0.16, 0.15),
    ),

    # ── California natives ────────────────────────────────────────────────
    "oak": dict(
        # Quercus agrifolia: broader than tall, dense dark evergreen, heavy
        # low limbs off a short thick trunk. Also serves Quercus ilex.
        form="tree",
        shape="2", levels=3, baseSplits=2, baseSize=0.22,
        branches=(0, 30, 26, 12), length=(0.75, 0.48, 0.42, 0.36),
        downAngle=(90, 64, 56, 48), downAngleV=(0, 38, 32, 24),
        segSplits=(0.35, 0.32, 0.22, 0), splitAngle=(26, 28, 24, 0),
        curve=(8, -32, -30, 0), curveV=(70, 80, 75, 0), curveRes=(6, 5, 4, 1),
        ratio=0.026, scale=8.0, scaleV=1.4, taper=(1, 1, 1, 1),
        attractUp=(0, -0.6, -0.8, 0), ratioPower=1.2,
        leaves=520, leafSize_m=0.045, leafScaleX=0.62, leafShape="hex",
        leaf=(0.13, 0.22, 0.12), bark=(0.22, 0.20, 0.18),
    ),
    "manzanita": dict(
        # Arctostaphylos: the signature California shrub — open and sculptural,
        # smooth MAHOGANY twisting limbs that are the whole point of the plant,
        # blue-green foliage held densely at the tips. Wide, low, gnarled.
        # High curveV is what makes the limbs writhe rather than arc cleanly.
        #
        # refphotos/arctostaphylos_spp.jpg — A. densiflora, not the prostrate
        # uva-ursi mat a genus-only fetch can return for a 2.5 m shrub — settles
        # two things. The bark is DARK: a deep chocolate-mahogany that reads red
        # only where the light catches it; a (0.30, 0.09, 0.05) near-vermilion
        # makes the shrub look like a bundle of copper pipe. And the foliage is
        # DENSE at every twig end; what is "sparse" is the LIMBS being visible
        # between the clumps, not the leaves — so many leaves at the real 2-3 cm,
        # never a few dozen at 11 cm.
        form="mound",
        shape="2", levels=3, baseSplits=3, baseSize=0.06,
        # WIDER THAN THE SPECIES, and the branch angles are not what does it:
        # pulling downAngle from 55 to 40 and shortening every branch level moves
        # the spread from 6.61 m to 6.58 m and costs a third of the canopy. The
        # footprint is set at the BASE — baseSplits=3 at splitAngle 42 with
        # baseSize 0.06 splays the trunk into three limbs an inch off the ground,
        # and everything above just follows them out. Narrowing it means touching
        # that split, and that split is also what makes the plant sculptural
        # rather than a bush on a stick. Left alone deliberately: the manzanita
        # model is wider than its species, and the viewer fits it to the plant's
        # declared spread.
        branches=(0, 14, 12, 6), length=(0.5, 0.62, 0.55, 0.45),
        downAngle=(90, 55, 48, 42), downAngleV=(0, 46, 40, 30),
        segSplits=(0.5, 0.4, 0.3, 0), splitAngle=(42, 38, 32, 0),
        curve=(20, -24, -18, 0), curveV=(130, 120, 105, 0), curveRes=(7, 6, 5, 1),
        ratio=0.022, scale=2.6, scaleV=0.5, taper=(1, 1, 1, 1),
        attractUp=(0.2, 0.35, 0.45, 0), ratioPower=1.15,
        leaves=2600, leafSize_m=0.035, leafScaleX=0.55, leafShape="hex",
        leaf=(0.19, 0.26, 0.20), bark=(0.115, 0.052, 0.040),
    ),
    "toyon": dict(
        # Heteromeles arbutifolia: dense upright evergreen large shrub, foliage
        # to the ground, taller than wide. Also serves Laurus nobilis,
        # Rhamnus/Frangula californica, Prunus ilicifolia, Pittosporum.
        #
        # A 0.85 trunk with 0.34 branches and attractUp pulling every one of them
        # skyward renders a narrow SPIRE — a christmas tree: long stem, short
        # upswept arms, no width anywhere — whatever `shape` says (it is already
        # spherical). A toyon is a rounded mass you cannot see through, so the
        # trunk gives up half its length to the branches and they are let out
        # sideways instead of up.
        form="mound",
        shape="1", levels=3, baseSplits=2, baseSize=0.05,
        branches=(0, 46, 38, 16), length=(0.58, 0.44, 0.38, 0.30),
        downAngle=(90, 56, 50, 44), downAngleV=(0, 30, 26, 20),
        segSplits=(0.3, 0.34, 0.24, 0), splitAngle=(24, 28, 24, 0),
        curve=(4, -26, -22, 0), curveV=(40, 50, 45, 0), curveRes=(5, 4, 3, 1),
        ratio=0.016, scale=4.2, scaleV=0.6, taper=(1, 1, 1, 1),
        attractUp=(0.1, 0.05, -0.2, 0), ratioPower=1.25,
        leaves=230, leafSize_m=0.080, leafScaleX=0.42, leafShape="hex",
        leaf=(0.12, 0.23, 0.13), bark=(0.26, 0.22, 0.19),
    ),
    "redbud": dict(
        # Cercis occidentalis: multi-stem vase, upright limbs arching out at
        # the top, round heart-shaped leaves. Deciduous, blooms on bare wood.
        form="tree",
        shape="2", levels=3, baseSplits=3, baseSize=0.08,
        branches=(0, 20, 18, 10), length=(0.6, 0.6, 0.5, 0.4),
        downAngle=(90, 44, 38, 34), downAngleV=(0, 32, 28, 22),
        segSplits=(0.35, 0.3, 0.2, 0), splitAngle=(28, 26, 22, 0),
        curve=(10, -34, -28, 0), curveV=(70, 75, 65, 0), curveRes=(5, 5, 4, 1),
        ratio=0.017, scale=4.0, scaleV=0.6, taper=(1, 1, 1, 1),
        attractUp=(0.35, 0.2, 0, 0), ratioPower=1.2,
        leaves=190, leafSize_m=0.075, leafScaleX=1.0, leafShape="hex",
        leaf=(0.22, 0.31, 0.16), bark=(0.24, 0.20, 0.19),
    ),
    "desert_willow": dict(
        # Chilopsis linearis: airy and open, thin whippy stems, narrow leaves —
        # reads as light and transparent where an oak reads as a solid mass.
        form="tree",
        shape="2", levels=3, baseSplits=2, baseSize=0.14,
        branches=(0, 18, 16, 8), length=(0.7, 0.62, 0.55, 0.45),
        downAngle=(90, 50, 44, 38), downAngleV=(0, 40, 34, 26),
        segSplits=(0.3, 0.25, 0.2, 0), splitAngle=(30, 28, 24, 0),
        curve=(12, -42, -36, 0), curveV=(85, 95, 85, 0), curveRes=(6, 5, 4, 1),
        ratio=0.013, scale=4.6, scaleV=0.8, taper=(1, 1, 1, 1),
        attractUp=(0.1, -0.35, -0.55, 0), ratioPower=1.3,
        leaves=40, leafSize_m=0.18, leafScaleX=0.22, leafShape="hex",
        leaf=(0.20, 0.30, 0.17), bark=(0.28, 0.24, 0.21),
    ),

    # ── Mediterranean basin ───────────────────────────────────────────────
    "stone_pine": dict(
        # Pinus pinea: the umbrella pine. A tall CLEAR trunk with the crown
        # only at the very top, flattened into a parasol — the single most
        # recognisable Mediterranean silhouette. baseSize 0.62 is what keeps
        # the trunk bare; strong negative attractUp is what flattens the crown.
        form="tree",
        shape="2", levels=3, baseSplits=0, baseSize=0.62,
        branches=(0, 20, 16, 8), length=(1.0, 0.34, 0.4, 0.3),
        downAngle=(90, 82, 76, 70), downAngleV=(0, 18, 16, 12),
        segSplits=(0.1, 0.3, 0.2, 0), splitAngle=(12, 34, 30, 0),
        curve=(4, -6, -4, 0), curveV=(40, 45, 40, 0), curveRes=(7, 4, 3, 1),
        ratio=0.023, scale=11.0, scaleV=1.6, taper=(1, 1, 1, 1),
        attractUp=(0, -2.0, -1.8, 0), ratioPower=1.35,
        leaves=52, leafSize_m=0.2, leafScaleX=0.28, leafShape="hex",
        leaf=(0.16, 0.26, 0.18), bark=(0.36, 0.26, 0.20),
    ),
    "ceanothus": dict(
        # Ceanothus 'Ray Hartman': the big tree-form California lilac — broad,
        # billowing, multi-stemmed from near the ground, arching outward, and
        # DENSE. Small dark glossy leaves, so many small leaf cards rather than
        # few large ones. Only reached at 3 m+; the prostrate cultivars are
        # filtered out upstream and render as mats.
        form="mound",
        shape="2", levels=3, baseSplits=3, baseSize=0.07,
        branches=(0, 36, 30, 14), length=(0.6, 0.5, 0.42, 0.34),
        downAngle=(90, 56, 50, 44), downAngleV=(0, 34, 28, 22),
        segSplits=(0.4, 0.32, 0.22, 0), splitAngle=(30, 28, 24, 0),
        curve=(10, -34, -30, 0), curveV=(65, 70, 65, 0), curveRes=(5, 5, 4, 1),
        ratio=0.018, scale=5.0, scaleV=0.8, taper=(1, 1, 1, 1),
        attractUp=(0.15, -0.3, -0.5, 0), ratioPower=1.25,
        leaves=520, leafSize_m=0.045, leafScaleX=0.50, leafShape="hex",
        leaf=(0.10, 0.20, 0.13), bark=(0.24, 0.21, 0.18),
    ),
    "fig": dict(
        # Ficus carica: very few, very THICK pale-grey limbs and big bold
        # leaves. ratioPower near 1 keeps the branches almost as fat as the
        # trunk, which is what makes a fig read as a fig.
        form="tree",
        shape="2", levels=3, baseSplits=2, baseSize=0.1,
        branches=(0, 10, 8, 4), length=(0.55, 0.62, 0.5, 0.4),
        downAngle=(90, 58, 50, 44), downAngleV=(0, 36, 30, 24),
        segSplits=(0.3, 0.2, 0.12, 0), splitAngle=(32, 28, 24, 0),
        curve=(10, -32, -26, 0), curveV=(75, 70, 60, 0), curveRes=(5, 5, 4, 1),
        ratio=0.045, scale=4.0, scaleV=0.6, taper=(1, 1, 1, 1),
        attractUp=(0.15, -0.2, -0.4, 0), ratioPower=1.02,
        leaves=62, leafSize_m=0.21, leafScaleX=0.95, leafShape="hex",
        leaf=(0.15, 0.27, 0.13), bark=(0.52, 0.50, 0.45),
    ),
    # ── FORMS BELOW TREE HEIGHT ────────────────────────────────────────────
    # Without these, most of a typical garden plant list collapses into the single
    # "mound" growth form and few plants reach a real model, because the presets
    # above are TREES and MIN_ASSET_HEIGHT_M gates them to 3 m while most garden
    # plants are under 1.5 m. A sage, a rush, a deer grass and a wildflower
    # drift would all draw as the same blob, and planting would read as
    # undifferentiated no matter how well it is arranged.
    #
    # These are archetypes, not species: dozens of plants map onto a dozen shapes,
    # and a species gets its identity from its SIZE and FOLIAGE COLOUR on top of the
    # right shape. Pretending to hand-tune a bespoke model per species would be a worse lie
    # than admitting a Salvia greggii and a Salvia clevelandii share a silhouette.

    "grass_fountain": dict(
        # Muhlenbergia rigens. A fountain: blades leave a tight crown and ARCH
        # outward, so the plant is wider at mid-height than at the tip. levels=2
        # with a strong negative curve is what bends them; attractUp negative
        # keeps the tips falling rather than reaching.
        form="grass",
        shape="2", levels=2, baseSplits=0, baseSize=0.02,
        branches=(0, 60, 0, 0), length=(0.30, 1.0, 0, 0),
        downAngle=(90, 46, 0, 0), downAngleV=(0, 30, 0, 0),
        segSplits=(0, 0, 0, 0), splitAngle=(0, 0, 0, 0),
        curve=(0, -78, 0, 0), curveV=(0, 34, 0, 0), curveRes=(1, 7, 1, 1),
        ratio=0.004, scale=1.25, scaleV=0.18, taper=(1, 1, 1, 1),
        attractUp=(0, -0.35, 0, 0), ratioPower=1.0,
        leaves=0, leafSize_m=0.0, leafScaleX=1.0, leafShape="hex",
        leaf=(0.34, 0.40, 0.24), bark=(0.36, 0.42, 0.26),
    ),
    "grass_tuft": dict(
        # Festuca californica, Carex. Shorter and stiffer than deer grass, blades
        # held nearer vertical — a tuft rather than a fountain.
        form="grass",
        shape="7", levels=2, baseSplits=0, baseSize=0.02,
        branches=(0, 48, 0, 0), length=(0.85, 0.8, 0, 0),
        downAngle=(90, 12, 0, 0), downAngleV=(0, 20, 0, 0),
        segSplits=(0, 0, 0, 0), splitAngle=(0, 0, 0, 0),
        curve=(0, -34, 0, 0), curveV=(0, 26, 0, 0), curveRes=(1, 5, 1, 1),
        ratio=0.005, scale=0.62, scaleV=0.12, taper=(1, 1, 1, 1),
        attractUp=(0, -0.25, 0, 0), ratioPower=1.0,
        leaves=0, leafSize_m=0.0, leafScaleX=1.0, leafShape="hex",
        leaf=(0.42, 0.48, 0.30), bark=(0.44, 0.50, 0.32),
    ),
    "rush_upright": dict(
        # Juncus patens. Stiff vertical cylinders, almost no arch and no taper —
        # the plant reads as a bundle of grey-green pencils. curve near zero is
        # the whole character; give it any and it stops being a rush.
        form="grass",
        shape="4", levels=2, baseSplits=0, baseSize=0.02,
        branches=(0, 44, 0, 0), length=(0.95, 0.92, 0, 0),
        downAngle=(90, 6, 0, 0), downAngleV=(0, 12, 0, 0),
        segSplits=(0, 0, 0, 0), splitAngle=(0, 0, 0, 0),
        curve=(0, -6, 0, 0), curveV=(0, 14, 0, 0), curveRes=(1, 3, 1, 1),
        ratio=0.006, scale=0.8, scaleV=0.1, taper=(1, 0.9, 1, 1),
        attractUp=(0, 0.5, 0, 0), ratioPower=1.0,
        leaves=0, leafSize_m=0.0, leafScaleX=1.0, leafShape="hex",
        leaf=(0.33, 0.44, 0.34), bark=(0.33, 0.44, 0.34),
    ),
    "sage_open": dict(
        # Salvia (apiana, leucophylla, clevelandii, greggii, microphylla). A woody
        # base with open branching and foliage held at the tips — you can see
        # through a sage, which is what separates it from a clipped mound.
        form="mound",
        shape="7", levels=3, baseSplits=5, baseSize=0.02,
        branches=(0, 26, 14, 0), length=(0.16, 0.9, 0.6, 0),
        downAngle=(90, 62, 48, 0), downAngleV=(0, 30, 30, 0),
        segSplits=(0.6, 0.35, 0.1, 0), splitAngle=(46, 34, 24, 0),
        curve=(0, -26, -18, 0), curveV=(70, 70, 60, 0), curveRes=(4, 4, 3, 1),
        ratio=0.012, scale=1.0, scaleV=0.22, taper=(1, 1, 1, 1),
        attractUp=(0.1, 0.2, 0.3, 0), ratioPower=1.2,
        leaves=22, leafSize_m=0.055, leafScaleX=0.45, leafShape="hex",
        leaf=(0.44, 0.49, 0.38), bark=(0.34, 0.30, 0.25),
    ),
    "subshrub_grey": dict(
        # Santolina, Lavandula, Teucrium. A DENSE low dome of fine grey foliage —
        # the opposite of the sage: you cannot see through it. Many short
        # branches, high leaf count, small leaves.
        form="mound",
        shape="2", levels=2, baseSplits=3, baseSize=0.04,
        branches=(0, 30, 0, 0), length=(0.35, 0.5, 0, 0),
        downAngle=(90, 55, 0, 0), downAngleV=(0, 40, 0, 0),
        segSplits=(0.4, 0.2, 0, 0), splitAngle=(40, 30, 0, 0),
        curve=(6, -30, 0, 0), curveV=(70, 60, 0, 0), curveRes=(4, 4, 1, 1),
        ratio=0.02, scale=0.55, scaleV=0.1, taper=(1, 1, 1, 1),
        attractUp=(0.1, 0.2, 0, 0), ratioPower=1.1,
        leaves=40, leafSize_m=0.032, leafScaleX=0.3, leafShape="hex",
        leaf=(0.62, 0.66, 0.55), bark=(0.42, 0.40, 0.34),
    ),
    "subshrub_fine": dict(
        # Eriogonum fasciculatum, Rosmarinus, Cistus. Finer and airier than the
        # grey dome, greener, slightly taller — a buckwheat is see-through at the
        # base and dense at the top.
        form="mound",
        shape="3", levels=2, baseSplits=2, baseSize=0.06,
        branches=(0, 24, 0, 0), length=(0.45, 0.58, 0, 0),
        downAngle=(90, 46, 0, 0), downAngleV=(0, 38, 0, 0),
        segSplits=(0.35, 0.2, 0, 0), splitAngle=(36, 28, 0, 0),
        curve=(8, -22, 0, 0), curveV=(75, 65, 0, 0), curveRes=(4, 4, 1, 1),
        ratio=0.018, scale=0.75, scaleV=0.15, taper=(1, 1, 1, 1),
        attractUp=(0.2, 0.3, 0, 0), ratioPower=1.1,
        leaves=30, leafSize_m=0.038, leafScaleX=0.35, leafShape="hex",
        leaf=(0.40, 0.47, 0.33), bark=(0.36, 0.33, 0.27),
    ),
    "mat_spreading": dict(
        # Baccharis 'Pigeon Point'/'Twin Peaks', prostrate rosemary, Thymus,
        # Arctostaphylos 'Emerald Carpet'. Horizontal: branches leave the crown at
        # nearly 90 deg and stay down. attractUp must be NEGATIVE or the plant
        # stands up and stops being a groundcover.
        form="mat",
        shape="2", levels=2, baseSplits=4, baseSize=0.02,
        branches=(0, 30, 0, 0), length=(0.06, 1.0, 0, 0),
        downAngle=(90, 89, 0, 0), downAngleV=(0, 8, 0, 0),
        segSplits=(0.5, 0.3, 0, 0), splitAngle=(50, 40, 0, 0),
        curve=(0, -10, 0, 0), curveV=(40, 50, 0, 0), curveRes=(2, 5, 1, 1),
        ratio=0.016, scale=0.28, scaleV=0.06, taper=(1, 1, 1, 1),
        attractUp=(0, -0.05, 0, 0), ratioPower=1.0,
        leaves=34, leafSize_m=0.03, leafScaleX=0.55, leafShape="hex",
        leaf=(0.33, 0.44, 0.28), bark=(0.34, 0.32, 0.26),
    ),
    "perennial_clump": dict(
        # Achillea, Erigeron, Penstemon, Heuchera, Coreopsis. Herbaceous: NO woody
        # trunk, soft stems rising from a basal clump, flowers held above the
        # foliage. Short levels and a pale bark colour read as stem, not wood.
        form="mound",
        shape="4", levels=2, baseSplits=5, baseSize=0.02,
        branches=(0, 22, 0, 0), length=(0.55, 0.7, 0, 0),
        downAngle=(90, 26, 0, 0), downAngleV=(0, 28, 0, 0),
        segSplits=(0.2, 0.1, 0, 0), splitAngle=(24, 20, 0, 0),
        curve=(4, -16, 0, 0), curveV=(50, 45, 0, 0), curveRes=(3, 4, 1, 1),
        ratio=0.01, scale=0.5, scaleV=0.12, taper=(1, 1, 1, 1),
        attractUp=(0.4, 0.5, 0, 0), ratioPower=1.0,
        leaves=26, leafSize_m=0.05, leafScaleX=0.6, leafShape="hex",
        leaf=(0.38, 0.50, 0.30), bark=(0.45, 0.52, 0.34),
    ),
    "meadow_annual": dict(
        # Eschscholzia, Layia, Nemophila, Lasthenia, Clarkia, Gilia, Lupinus. A
        # fall-seeded drift, not a specimen: low, fine, many thin stems. Placed in
        # numbers it should read as a wash of texture rather than as objects.
        form="mound",
        shape="4", levels=2, baseSplits=6, baseSize=0.01,
        branches=(0, 18, 0, 0), length=(0.6, 0.75, 0, 0),
        downAngle=(90, 30, 0, 0), downAngleV=(0, 34, 0, 0),
        segSplits=(0.15, 0.1, 0, 0), splitAngle=(22, 18, 0, 0),
        curve=(4, -20, 0, 0), curveV=(60, 55, 0, 0), curveRes=(3, 3, 1, 1),
        ratio=0.007, scale=0.32, scaleV=0.1, taper=(1, 1, 1, 1),
        attractUp=(0.3, 0.4, 0, 0), ratioPower=1.0,
        leaves=18, leafSize_m=0.04, leafScaleX=0.7, leafShape="hex",
        leaf=(0.46, 0.54, 0.28), bark=(0.48, 0.54, 0.32),
    ),
    "strap": dict(
        # Phormium, Sisyrinchium. Stiff straps fanning from a single base — a
        # rosette stretched vertically. Wider leaves than a grass and no arch at
        # all until the very tip.
        form="rosette",
        shape="4", levels=2, baseSplits=0, baseSize=0.02,
        branches=(0, 22, 0, 0), length=(0.95, 0.95, 0, 0),
        downAngle=(90, 22, 0, 0), downAngleV=(0, 24, 0, 0),
        segSplits=(0, 0, 0, 0), splitAngle=(0, 0, 0, 0),
        curve=(0, -20, 0, 0), curveV=(0, 20, 0, 0), curveRes=(1, 4, 1, 1),
        ratio=0.012, scale=1.3, scaleV=0.2, taper=(1, 0.6, 1, 1),
        attractUp=(0, 0.3, 0, 0), ratioPower=1.0,
        leaves=0, leafSize_m=0.0, leafScaleX=1.0, leafShape="hex",
        leaf=(0.30, 0.36, 0.26), bark=(0.30, 0.36, 0.26),
    ),

}

# preset keys that describe the model rather than drive Sapling; passing any of
# these to tree_add() is an unknown-kwarg error
# CORRECTING A LEAF SIZE HOLLOWS THE PLANT UNLESS THE COUNT MOVES WITH IT.
#
# leafSize_m is botanical — a manzanita leaf is 2-3 cm, not 11. Shrinking a leaf
# 2-4x cuts the canopy's total leaf area to 27-59% of what it was, because area
# goes as the SQUARE of the size, and raising the count only linearly does not
# make that up. Rendered, the manzanita then comes out as a bare mahogany
# skeleton with nothing on it, which looks less like the plant than oversized
# leaves do.
#
# So the manifest records `leaf_area_m2` — the total one-sided leaf area the model
# actually carries — and tests/js/plants_base.test.mjs holds every canopy above a
# floor. The number is not a target to tune; it is there so that the NEXT size
# correction cannot pass review by looking botanically right while emptying the
# canopy. Density is the thing the eye reads, and it is not visible in either
# leafSize_m or leaves alone.
BUILD_KEYS = {"leaf", "bark", "leafSize_m", "form"}


def new_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    addon_utils.enable(SAPLING, default_set=False)   # reset drops the add-on


def flat_material(name, rgb, rough=0.95):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = 0
    m.use_backface_culling = False          # -> doubleSided in glTF, leaves read from both faces
    return m


def bake_vertex_colours(ob, rand):
    """Vary the colour ACROSS the plant, and bake it into the mesh.

    With two flat materials and no COLOR_0, every leaf on every clone is the
    same green. Flat foliage is the single loudest tell that a
    render is not a photograph: real leaves are darker in the interior where they
    shade each other, lighter and yellower at the tips where the growth is new,
    and no two are quite the same.

    Baked here rather than shaded in the viewer because it is a property of the
    PLANT, not of the light — it should survive any lighting the scene grows, and
    it costs nothing at draw time.

    Values sit AROUND 1.0 and modulate the material's own colour, because glTF
    multiplies COLOR_0 by baseColorFactor.

    Two gradients and a jitter:
      * height    — tips lighter, interior darker (new growth, self-shading)
      * radius    — outer foliage lighter than the core, same reason
      * per-leaf  — a small random shift so no two leaves match exactly
    """
    me = ob.data
    if not me.vertices:
        return
    ys = [v.co.y for v in me.vertices]          # Blender Z-up: Y is depth, Z is up
    zs = [v.co.z for v in me.vertices]
    z0, z1 = min(zs), max(zs)
    span = (z1 - z0) or 1.0
    rmax = max((v.co.x ** 2 + v.co.y ** 2) ** 0.5 for v in me.vertices) or 1.0

    attr = me.color_attributes.new(name="Col", type="FLOAT_COLOR", domain="POINT")
    for i, v in enumerate(me.vertices):
        up = (v.co.z - z0) / span                       # 0 at the base, 1 at the top
        out = ((v.co.x ** 2 + v.co.y ** 2) ** 0.5) / rmax
        # 0.82 at the shaded core, ~1.12 at a sunlit tip
        k = 0.82 + 0.18 * up + 0.12 * out
        jitter = 1.0 + (rand.random() - 0.5) * 0.10     # +/-5% leaf to leaf
        k *= jitter
        # warm the tips slightly as well as lightening them: new growth is
        # yellower, and a purely value-based ramp still reads as one plastic green
        warm = 1.0 + 0.10 * up
        # A MODULATION, not a colour. glTF multiplies COLOR_0 by baseColorFactor,
        # and the material already carries the species hue — baking rgb*k here
        # would ship rgb squared and every plant would render near-black. Around
        # 1.0 means "this vertex, relative to its species".
        attr.data[i].color = (k * warm, k, k / warm, 1.0)


def build(name, spec, height_m, seed, leaf_span=None):
    new_scene()
    kwargs = {k: v for k, v in spec.items() if k not in BUILD_KEYS}
    # leafScale is in the generator's own units, so a tree that generates tall
    # and is then normalised down keeps full-size branches and shrunken leaves
    # -- the tree renders as bare twigs. Express leaf size in final metres and
    # pre-compensate by the normalisation factor the export is about to apply.
    #
    # THE FACTOR IS THE SPAN SAPLING PRODUCED, NOT THE SCALE IT WAS ASKED FOR —
    # the same trap as echoing a requested height_m into the manifest (see the
    # end of build()): `scale` is a request, and Sapling misses it by anything
    # from 8% to a factor of two — a manzanita asked for 2.6 generates 1.25. The
    # export normalises by height/span, so compensating by `scale` makes every
    # leaf scale/span too big: 1.16x on the olive and 2.08x on the manzanita, a
    # 3.5 cm manzanita leaf drawn at 7.3 cm.
    #
    # The span is only knowable by generating, so main() builds twice: once to
    # learn it, then again with the same seed — Sapling is deterministic — and the
    # measured span passed back in. Doubling the generation cost is worth having
    # leafSize_m mean centimetres.
    kwargs["leafScale"] = spec["leafSize_m"] * (leaf_span or spec["scale"]) / height_m
    # `bevel` is what gives the branches a cross-section. Without it Sapling
    # leaves the trunk as a curve with bevel_depth 0, which converts to a mesh
    # of vertices and NO polygons — measured on cypress: 1028 verts, 0 faces —
    # so the model is leaf cards with no wood in it at all. The joined mesh's
    # tri count matching the GLB's exactly is the proof: the bark faces are
    # never there to lose. Costs roughly double the triangles.
    kwargs.update(showLeaves=True, useArm=False, handleType="0", bevel=True,
                  seed=seed, do_update=True)
    bpy.ops.curve.tree_add(**kwargs)

    # Sapling emits a CURVE trunk plus a MESH of leaf cards; make it all mesh
    for ob in list(bpy.context.scene.objects):
        if ob.type == "CURVE":
            bpy.context.view_layer.objects.active = ob
            ob.select_set(True)
            bpy.ops.object.convert(target="MESH")

    leaf_mat = flat_material(f"{name}_leaf", spec["leaf"], 0.9)
    bark_mat = flat_material(f"{name}_bark", spec["bark"], 1.0)
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    rnd = random.Random(seed)
    for ob in meshes:
        leafy = "leaves" in ob.name.lower()
        ob.data.materials.clear()
        ob.data.materials.append(leaf_mat if leafy else bark_mat)
        # colour varies across the plant, baked into the mesh — see the docstring.
        # Bark gets it too, more gently: a trunk lit evenly top to bottom is the
        # other half of why these read as plastic.
        bake_vertex_colours(ob, rnd)

    # join into one object so the viewer instances a single mesh (2 primitives)
    bpy.ops.object.select_all(action="DESELECT")
    for ob in meshes:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    tree = bpy.context.view_layer.objects.active
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    # Normalise: base at z=0, height exactly height_m, centred on the trunk base
    # — measured over the geometry the EXPORTER will keep, which is not the same
    # as the geometry in the mesh. A vertex belonging to no triangle is invisible
    # here and absent from the GLB, but it still steers this transform: with a
    # bevel-less trunk, the faceless wire's base lands on z=0 and the leaf cloud,
    # all that survives export, starts above it. A model built that way floats,
    # base 0.000 (maple) to 1.044 (stone_pine) against a top pinned at exactly
    # 4.000, and nothing in the build log says so.
    me = tree.data
    me.calc_loop_triangles()
    used = {i for t in me.loop_triangles for i in t.vertices}
    if not used:
        raise SystemExit(f"[tree] {name}: joined mesh has no triangles to export")
    co = [me.vertices[i].co for i in sorted(used)]
    zs = [c.z for c in co]
    xs = [c.x for c in co]
    ys = [c.y for c in co]
    span = max(zs) - min(zs)
    k = height_m / span if span > 1e-6 else 1.0
    from mathutils import Matrix
    me.transform(Matrix.Diagonal((k, k, k, 1.0)) @ Matrix.Translation((0, 0, -min(zs))))
    me.update()
    loose = len(me.vertices) - len(used)

    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, f"{name}.glb")
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", use_selection=True,
        export_draco_mesh_compression_enable=True,
        export_draco_mesh_compression_level=6,
        export_apply=True, export_yup=True)

    tris = len(me.loop_triangles)
    kb = os.path.getsize(path) / 1024
    # Total ONE-SIDED leaf area, measured off the geometry rather than derived
    # from leafSize_m x leaves — the two disagree, because Sapling's count is per
    # leaf-bearing branch and the branch count depends on half the other
    # parameters. Measuring is also what makes it a check rather than a restatement
    # of the inputs. See the note by BUILD_KEYS: correcting leaf sizes to their
    # botanical values can quietly remove 41-73% of a canopy, and only the
    # render — a bare skeleton — would say so.
    # Recalculated AFTER the normalising transform, and with no k factor:
    # multiplying post-transform areas by k^2 a second time reports 260.8 m2 for
    # a manzanita carrying 12.2. A guard that is wrong is
    # worse than no guard, so this is checked against the browser's own
    # measurement of the loaded GLB (tests/js/plants_base.test.mjs).
    me.calc_loop_triangles()
    leaf_area = 0.0
    leaf_slots = {i for i, m in enumerate(me.materials or []) if m and "_leaf" in m.name}
    for t in me.loop_triangles:
        if t.material_index in leaf_slots:
            leaf_area += t.area
    # `base` is the number that can be silently wrong for the whole library, so
    # the build log states it rather than leaving it to be re-derived from the
    # GLB bytes later. It is 0.00 by construction; if it is not, the
    # face-vertex set above and the exporter have stopped agreeing.
    spread_x, spread_y = (max(xs) - min(xs)) * k, (max(ys) - min(ys)) * k
    print(f"[tree] {name}: {tris:,} tris, {kb:.0f} KB, "
          f"raw {span:.2f}m -> {height_m:.2f}m, base 0.00m, "
          f"{loose} loose verts, {leaf_area:.1f} m2 leaf, "
          f"spread {spread_x:.2f}x{spread_y:.2f}m -> {path}")
    # `form` is the habit this model SERVES, and it is the half of routing that
    # generalises: assets.js routes a species it has never seen by declared form,
    # so a model added here for another climate is reachable the moment it names
    # its habit. Carried into the manifest so the router and the built library
    # can be checked against each other (tests/js/plants.test.mjs).
    # height_m is MEASURED off the normalised face vertices, not echoed back
    # from the --height argument: an echoed target claims 4.0 for models whose
    # geometry spans 2.96, and a viewer scaling by h/4 stands a "6 m" stone pine
    # at 4.43 m. viewer/src/assets.js measures the model it loads and does not
    # trust this field, but a manifest that states something the geometry does
    # not have is a trap for the next reader.
    return dict(name=name, file=f"assets/plants/{name}.glb", tris=tris,
                form=spec["form"],
                kb=round(kb, 1), height_m=round(span * k, 3), base_m=0.0,
                leaf_area_m2=round(leaf_area, 3),
                raw_span_m=round(span, 4),
                spread_m=round(max(spread_x, spread_y), 3),
                # WHERE IT CAME FROM, as every model in the library says (docs/library.md):
                # GENERATED by the app's own tree generator, from this preset and seed — no one
                # else's work, no licence; "generated" is the word the viewer and asset_store
                # read to tell a library tree from a species' own model
                source={"from": "generated", "script": "tools/gen_trees.py", "preset": name, "seed": seed})


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--species", action="append")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--height", type=float, default=4.0,
                    help="normalised height in metres; the viewer rescales anyway")
    a = ap.parse_args(argv)
    names = list(SPECIES) if a.all or not a.species else a.species
    built = {}
    mpath = os.path.join(OUT, "manifest.json")
    if os.path.exists(mpath):
        with open(mpath) as f:
            built = json.load(f)
    for n in names:
        if n not in SPECIES:
            print(f"[tree] unknown species {n}; have {list(SPECIES)}")
            continue
        # TWO PASSES. The first learns the span Sapling actually generates, which
        # is the number leafScale has to be pre-compensated by and which nothing
        # can know in advance; the second rebuilds with it. Same seed, so the
        # skeleton is identical and only the leaves change size. See build().
        probe = build(n, SPECIES[n], a.height, a.seed)
        built[n] = build(n, SPECIES[n], a.height, a.seed,
                         leaf_span=probe["raw_span_m"])
    with open(mpath, "w") as f:
        json.dump(built, f, indent=2, sort_keys=True)
    print(f"[tree] manifest: {len(built)} models -> {mpath}")


main()
