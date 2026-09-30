// Procedural plants with species-appropriate GROWTH FORM.
//
// At the distance you actually judge a garden from (10-30 m) what identifies a
// plant is its silhouette, not its leaves: an agave is a ground-level rosette
// of stiff blades, a deergrass is an arching fountain, an olive is a leaning
// multi-stem with broken canopy masses, a cypress is a narrow column. A
// trunk-plus-sphere proxy erases exactly that information, so every plant
// reads the same.
//
// Everything here is merged into one geometry per plant (a few draw calls for
// a whole design) and seeded from the plant id so the same plant looks the
// same on every reload, and no two look identical.
//
// Trees are the exception: a canopy of blobs never reads as a tree, so when a
// real branching model exists in the library (assets.js) it is used instead
// and only the contact shadow below is kept. Everything smaller than a tree
// still looks better procedural — a rosette or a grass clump is silhouette,
// not branch structure.
//
// The species table below is finite and the model's botanical vocabulary is
// not, so a plant may also declare its `form` — one of nine habits — and an
// unknown species lands on the right SHAPE instead of a generic blob. That is
// the layer that lets this file follow a site to another climate.
//
// `foliage` is the same idea for COLOUR: without it a plant's colour comes from
// its form alone, so every shrub in the yard is the same green (see FOLIAGE).
// `leaf` is the same idea again for what the foliage is MADE OF (see LEAF): the
// woody forms here draw masses, and a mass clothed in leaf cards is the
// difference between a manzanita and a rosemary at the distance a bed is judged
// from — without it they are the same object at two scales, bit for bit.
import * as THREE from "three";
import { translucent, translucencyFor, BLOOM_TRANSLUCENCY,
         BLOOM_TRANSMIT_TINT } from "./translucency.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { buildAssetPlant, MIN_ASSET_HEIGHT_M, normalizeForm, instanceTint } from "./assets.js";
import { botanicalModel, botanicalHead, grassBladeWidth, grassInflorescence } from "./botanical.js";
import { SPECIES } from "./species.js";   // the library's species builders
import { polygonArea } from "./areas.js";
import { previewPrototypes, leafClusterCards, reduceBuilt, reduceModel, outermost } from "./preview_lod.js";
import { keptModel, keepModel } from "./plant_store.js";
import { texturesReady } from "./plant_texture_loader.js";

/**
 * The seeded stream every plant is drawn from.
 *
 * The hash must spread the FIRST output as well as later draws. With
 * `s = s*31 + c` feeding a bare LCG, fifteen sequential plant ids span 0.0136
 * of the unit interval on draw one, against 0.9459 on draw three. Colours use
 * the first draws so geometry changes cannot recolour the garden; a narrow
 * first-draw range makes a drift nearly uniform (0.5 RGB units out of 441).
 *
 * FNV-1a for the hash and mulberry32 for the stream both avalanche, so draw one
 * is as well spread as draw thirty. The stream is a pure function of the id,
 * so a garden is identical on every reload.
 */
export const rngFrom = seed => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let s = h >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// species keyword -> growth form. Order matters: first match wins. This is the
// SPECIFIC layer and it is finite; a species no line here names falls through to
// the habit the design DECLARED (`form`, vocabulary in assets.js) and only then
// to size. See growthForm().
const FORMS = [
  [/thymus\s+vulgaris|thymus.*(silver beauty|french thyme)/i, "mound"],
  [/eriogonum umbellatum|monardella macrantha|salvia leucophylla.*point sal|helichrysum petiolare|scaevola|bidens/i, "mat"],
  [/foeniculum|satureja hortensis|stachys byzantina/i, "perennial"],
  [/agave|aloe|yucca|dasylirion|hesperaloe|furcraea|dudleya|echeveria|puya|nolina/i, "rosette"],
  [/muhlenbergia|lomandra|festuca|carex|stipa|nassella|sporobolus|leymus|deergrass|pennisetum|miscanthus|calamagrostis/i, "grass"],
  [/cupressus|italian cypress|juniperus.*(sky|blue arrow)|podocarpus|thuja/i, "column"],
  [/olea|olive|quercus|acer|arbutus|cercis|lagerstroemia|prunus|citrus|ficus|maple/i, "tree"],
  [/phoenix|washingtonia|chamaerops|butia|syagrus|palm/i, "palm"],
  [/dymondia|senecio|delosperma|thymus|thyme|sedum|chalksticks|groundcover|ophiopogon|mondo|fragaria|strawberr|ceanothus gloriosus|vancouveria/i, "mat"],
  // prostrate/carpeting CULTIVARS of otherwise upright genera — the cultivar
  // is the only thing that distinguishes a 0.9 m carpet from a 5 m shrub
  [/(yankee point|carmel creeper|huntington carpet|pigeon point|twin peaks|emerald carpet|pacific mist|point reyes|carmel sur|warriner lytle|everett's choice|prostrat)/i, "mat"],
  // The same rule for Salvia, which is the greediest entry in this table: the
  // mound line below claims the whole genus, and 'Bee's Bliss' is a 2.4 m grey
  // CARPET while S. sonomensis and 'Terra Seca' hug the ground. Scoped to the
  // cultivar names rather than to /salvia/ so nothing else moves.
  [/salvia sonomensis|bee['\u2019]?s bliss|terra seca/i, "mat"],
  [/ribes viburnifolium|epilobium|zauschneria|arctostaphylos uva-ursi|kinnikinnick/i, "mat"],
  // These four forms precede the greedy mound rule, which claims every Salvia:
  // Salvia columbariae is a meadow annual, not a subshrub.
  // \brush\b, not rush\b: without the leading boundary "coyote brush" —
  // Baccharis pilularis — matches as a RUSH and draws as stiff vertical stems.
  [/juncus|\brush\b|schoenoplectus|equisetum|horsetail/i, "rush"],
  [/phormium|sisyrinchium|dianella|libertia|iris douglasiana|flax lily|new zealand flax/i, "strap"],
  [/eschscholzia|poppy|layia|nemophila|lasthenia|clarkia|gilia|collinsia|phacelia|lupinus|salvia columbariae|chia|tidy ?tips|baby ?blue ?eyes|goldfields/i, "meadow"],
  // Scope salvias to `salvia <epithet>`: bare /sylvestris/ also matches PINUS
  // sylvestris and would route a tree to a herbaceous clump. Similarly,
  // "lavender cotton" matches /lavender/ and "Lupinus" contains "pinus".
  // `hummingbird` catches S. spathacea by its common name, but the epithet is
  // also needed for designs that provide only the botanical name.
  [/achillea|yarrow|erigeron|penstemon|agastache|coreopsis|gaillardia|geranium|heuchera|osteospermum|aquilegia|columbine|monardella|epilobium canum|seaside daisy|hummingbird|salvia\s+(nemorosa|x\s*sylvestris|sylvestris|pratensis|verticillata|sclarea|argentea|spathacea)|caradonna|mystic spires|skyscraper|clary sage|silver sage/i, "perennial"],
  [/rosmarinus|rosemary|westringia|lavandula|lavender|salvia|teucrium|buxus|boxwood|rhaphiolepis|loropetalum|ceanothus|eriogonum|buckwheat|cistus|phlomis|santolina|baccharis|artemisia|encelia|mimulus|diplacus|galvezia|ribes|symphoricarpos/i, "mound"],
  [/bambusa|bamboo|phyllostachys/i, "cane"],
  [/bougainvillea|vitis|jasminum|clematis|wisteria/i, "vine"],
];

// A tree matched — genus or declared habit — but the plant is shrub-sized: a 2 m
// Cercis, a dwarf citrus, a "canopy tree" the model sized at 1.5 m. The
// procedural "tree" is the weakest form here and the asset library declines to
// serve anything under MIN_ASSET_HEIGHT_M, so send it to the shrub form instead
// of rendering a miniature tree. The gate is IMPORTED, not repeated: this and
// assets.js have to agree or a plant falls between them and gets no model AND
// the weakest form. Every path into `tree` goes through here for the same
// reason — the declared-habit path is a second door into the same hole.
const sized = (form, h) =>
  form === "tree" && h < MIN_ASSET_HEIGHT_M ? (h < 0.6 ? "mat" : "mound") : form;

export function growthForm(plant) {
  const name = `${plant.species ?? ""} ${plant.common ?? ""}`;
  const h = plant.mature_height_m ?? 1;
  // species first: it is the specific layer, and a prostrate cultivar that
  // mislabels its own habit must still render as the carpet it is
  for (const [re, form] of FORMS) if (re.test(name)) return sized(form, h);
  // then the declared habit — this is what stops an unknown species becoming a
  // generic blob, and it is the only layer that survives a change of climate
  const declared = normalizeForm(plant.form);
  if (declared) return sized(declared, h);
  return sized(h > 4 ? "tree" : h < 0.6 ? "mat" : "mound", h);
}

// exported so a test can measure how far apart two plants actually come out;
// the ramp's own length is the bar a declared foliage colour has to beat
export const GREENS = {
  rosette: [0x7d9b86, 0x8fae90], grass: [0x9a9a63, 0xb0a878],
  column: [0x3f5f43, 0x4d6b4a], tree: [0x5f7f55, 0x6d8a5c],
  palm: [0x5c7f4e, 0x6f9159], mat: [0x8fae90, 0x9dbb9a],
  mound: [0x5c7a52, 0x6b8a5e], cane: [0x7d9556, 0x8aa25f], vine: [0x5a7a4d, 0x688a58],
  // These ramps read APART at a distance: a rush is grey-green and cool, a
  // meadow is yellow-green and light, a perennial sits between, and a strap is
  // darker and bluer than any of them.
  rush: [0x6f8a72, 0x7d9a80], strap: [0x4a6b5c, 0x577a68],
  perennial: [0x6d8a52, 0x7d9a5f], meadow: [0x93a860, 0xa8bb72],
};

// ── foliage colour: the layer under the form ramp ────────────────────────────
//
// GREENS is keyed on the nine growth FORMS, so two species that share a form
// are drawn from one ramp and differ only by where the seeded rng landed on it.
// In a typical design about half the plants are `mound` — Heteromeles, Salvia,
// Lavandula, Eriogonum, Westringia, Olea — and that ramp (#5c7a52 -> #6b8a5e)
// is 25.0 RGB units long, 5.7% of the cube diagonal; those six species measure
// within 15.2 of each other. A silver lavender
// and a glossy dark toyon render as the same colour, and at the distance a
// garden is judged from, colour is most of what separates two shrubs of the
// same silhouette.
//
// So a plant may declare `foliage`, in the same shape as `form`: free text the
// model will actually write, normalised through an alias table, defaulting to
// the form ramp when it says nothing usable. Species is deliberately NOT the
// layer here — a species->colour table would be as long as the botanical
// vocabulary and would go stale the moment a site is in another climate, which
// is the same reason `form` exists.
//
// Each entry is a RAMP, not a colour, for the same reason GREENS is: without
// the per-plant lerp every lavender in a drift is pixel-identical.
//
// Only the PROCEDURAL path reads this. A plant big enough for a library model
// keeps that model's own baked leaf colour, which is already per-species —
// and the great majority of a design's plants are procedural, so that is where
// the flatness lives.
export const FOLIAGE = {
  silver:       [0xa8b4a2, 0xbcc6b2],   // artemisia, white sage, lavender
  grey_green:   [0x7e8d75, 0x91a08a],   // olive, westringia, salvia
  blue_green:   [0x6f9490, 0x82a5a0],   // glaucous: senecio, blue agave
  dark_green:   [0x2f4a2c, 0x3b5735],   // toyon, camellia, glossy evergreens
  bright_green: [0x6ba24b, 0x7cb35b],   // fresh apple green
  chartreuse:   [0x9fb84e, 0xaec463],   // santolina, golden cultivars
  purple:       [0x57344a, 0x6b4459],   // loropetalum, black phormium
  bronze:       [0x7d5a3c, 0x916d4c],   // bronze phormium, copper new growth
  variegated:   [0xc2d29a, 0xd5e2b4],   // reads as a pale cream mass at 20 m
};
export const FOLIAGE_WORDS = Object.keys(FOLIAGE);

// FIRST MATCH WINS and the order carries the decisions: "blue-grey" is glaucous
// before it is silver, "grey-green" is its own colour rather than the silver
// below it, and a bare "green" / "evergreen" / "mid green" matches NOTHING. A
// generic green says no more than the form already does, and accepting it would
// collapse all nine form ramps into one colour — worse than the flatness this
// exists to fix. Only a word with real colour content displaces the ramp.
const FOLIAGE_ALIAS = [
  [/variegat|cream|white[\s_-]?edge|margined/i, "variegated"],
  [/purple|burgundy|maroon|plum|wine|black/i, "purple"],
  [/bronze|copper|russet|rust|\bred\b/i, "bronze"],
  [/chartreuse|lime|gold|yellow[\s_-]?green|acid/i, "chartreuse"],
  [/blue|glauc/i, "blue_green"],
  [/gr[ea]y[\s_-]?green|\bsage\b|olive|dusty/i, "grey_green"],
  [/silver|gr[ea]y|hoary|wool|tomentose|white/i, "silver"],
  [/dark|deep|glossy|forest/i, "dark_green"],
  [/bright|light|apple|fresh|emerald/i, "bright_green"],
];

/** A declared foliage colour -> one of FOLIAGE_WORDS, or null if it says nothing. */
export function normalizeFoliage(foliage) {
  if (!foliage) return null;
  for (const [re, f] of FOLIAGE_ALIAS) if (re.test(foliage)) return f;
  return null;
}

// The # is REQUIRED. Without it "facade" and "beaded" are valid hex digits,
// so ordinary foliage words can become colours: "facade" parses as #facade.
const HEX = /^#([0-9a-f]{6})$/i;

/**
 * The ramp a plant declares, or null to fall back on its form's.
 * An explicit hex wins outright, exactly like `plant.asset` beats the species
 * table — it is a promise, so it is honoured without jitter. It is a promise
 * about the SPECIES, though: plant_palette.json carries one hex per species, and
 * the variation between individuals of it rides in the vertex colours instead
 * (`individual`, in buildPlant). This function's answer is exactly what the
 * material gets, and plants.test.mjs holds that.
 */
export function foliageRamp(plant) {
  const declared = plant?.foliage;
  if (!declared) return null;
  const hex = HEX.exec(String(declared).trim());
  if (hex) { const h = parseInt(hex[1], 16); return [h, h]; }
  const word = normalizeFoliage(declared);
  return word ? FOLIAGE[word] : null;
}

/**
 * The flower colour this plant DECLARES, or null.
 *
 * Null is load-bearing: a plant with no declared flower grows none. A garden
 * without blossom tells the user what is specified; inventing blossom on an
 * unflowered plant is as misleading as silently substituting a material.
 */
export function flowerColour(plant) {
  const hex = HEX.exec(String(plant?.flower ?? "").trim());
  return hex ? parseInt(hex[1], 16) : null;
}

// ── leaves: the layer that decides what the mass is MADE OF ──────────────────
//
// `form` says what shape a plant is and `foliage` says what colour. Neither says
// what it is made of. Smooth masses make a manzanita, a rosemary and a santolina
// the same object at three scales at the 2-4 m distance of a bed edge. With the
// same seed, a mass-only build measures 2000 triangles, 1983 pieces and a median
// piece size of 0.1544 m for all three.
//
// A leaf is the difference. A leaf card is two triangles, and clothing a shrub
// in eight hundred of them costs less than subdividing sixteen blobs to hide
// their facets. Subdivision alone makes a smoother rock.
//
// Same three layers as FORMS and FOLIAGE, in the same order and for the same
// reason — the species table is finite, the model's botanical vocabulary is not:
//   1. what the SPECIES is (LEAVES, below)
//   2. what the plant DECLARES  (`leaf`, free text, through normalizeLeaf)
//   3. what its FORM implies    (LEAF_BY_FORM)
//
// `density` is leaves per square metre of the shell they clothe, and it is the
// number that separates two fine-leaved shrubs: a santolina is a cushion of
// dissected 2 cm leaves and a rosemary is an open spray of linear 3 cm ones.
//
// Size alone cannot distinguish salvia leaves. White sage, Berggarten sage,
// Cleveland sage and autumn sage have a 7 cm white-felted lance, a 6 cm blunt
// grey paddle, a 2.5 cm crinkled oval and a 2 cm glossy oval — three shapes and
// three sizes. Routing all four to `medium` makes them bit-identical at one
// seed and size. `lance` and `round` separate LONG AND NARROW from SHORT AND
// BROAD. Neither is salvia-specific: willow, oleander and olive are lances;
// marjoram, bergenia and redbud are round.
export const LEAF = {
  //          length  width  tip/base  droop  per m2 of shell
  // `tiny` distinguishes Eriogonum fasciculatum (5-15 mm, fascicled), Baccharis
  // (1-2 cm) and Origanum majorana (1-2 cm) from manzanita and ceanothus. A 5 cm
  // leaf is 2-5x too big for these small leaves in data/refphotos/ and makes a
  // subshrub read as a distant large shrub.
  //
  // 1.4 cm — THE BOTANICAL SIZE. Smaller leaves need more cards to close the
  // same canopy: one buckwheat needs about 24,000 at 1.4 cm. A 6,500-card cap
  // leaves the core visible as a green blob with confetti around it.
  //
  // Fidelity takes priority over triangle savings. Fill rate drives render
  // cost; triangle count does not predict it. Eriogonum fasciculatum needs the
  // 5-15 mm fascicled leaf in data/refphotos/eriogonum_fasciculatum.jpg.
  // `density` is not read: leafCountFor uses TARGET_COVERAGE and the card's
  // own area, so shrinking a leaf automatically RAISES its count.
  tiny:     { len: 0.014, wide: 0.009, taper: 0.45, droop: 0.16, density: 2600 },
  scale:    { len: 0.026, wide: 0.015, taper: 0.60, droop: 0.05, density: 1200 },
  needle:   { len: 0.055, wide: 0.003, taper: 0.40, droop: 0.12, density: 1600 },
  filigree: { len: 0.038, wide: 0.022, taper: 0.50, droop: 0.18, density: 1450 },
  small:    { len: 0.030, wide: 0.017, taper: 0.35, droop: 0.30, density: 780 },
  round:    { len: 0.055, wide: 0.044, taper: 0.85, droop: 0.35, density: 520 },
  // NARROW sits between `small` and `lance`. Salvia lavandulifolia is 3-5 cm
  // by under 1 cm (see its reference photo); `lance` at 8.5 x 2.2 cm is twice
  // too long and nearly three times too wide. Penstemon heterophyllus
  // (2-6 cm x 2-8 mm), Oenothera lindheimeri and Salvia coahuilensis share this
  // shape: `small` is too SHORT for them.
  narrow:   { len: 0.042, wide: 0.013, taper: 0.45, droop: 0.34, density: 900 },
  lance:    { len: 0.085, wide: 0.022, taper: 0.30, droop: 0.50, density: 420 },
  medium:   { len: 0.090, wide: 0.048, taper: 0.42, droop: 0.42, density: 300 },
  large:    { len: 0.180, wide: 0.110, taper: 0.55, droop: 0.55, density: 110 },
};
export const LEAF_WORDS = Object.keys(LEAF);

// FIRST MATCH WINS, so the order carries the decisions. `rosmarinus` has to sit
// above the greedy /salvia/ rule — rosemary was moved into Salvia and the
// palette calls it "Salvia rosmarinus", so a table that reads salvia first draws
// the one unmistakably needle-leaved plant on the list with 9 cm sage leaves.
// Same shape of trap as "coyote brush" matching \brush\b in FORMS.
const LEAVES = [
  [/helichrysum petiolare|monardella villosa|scaevola/i, "round"],
  [/stachys byzantina/i, "lance"],
  [/monardella macrantha|satureja hortensis/i, "small"],
  [/verbena lilacina|bidens/i, "filigree"],
  // FILIGREE BEFORE NEEDLE, and \bpinus\b rather than pinus:
  //   Santolina's common name is LAVENDER cotton, so /lavender/ would claim
  //   the plant that defines the filigree class.
  //   Lupinus contains "pinus", but its leaves are palmate, not pine needles.
  //   \b does not match inside Lupinus and does match in "Pinus pinea".
  [/santolina|artemisia|achillea|yarrow|tanacetum|foeniculum|fennel|lomatium|eschscholzia|\bpoppy\b|layia|coreopsis|cosmos|dill|anthemis|centaurea|salvia\s+columbariae|\bchia\b/i, "filigree"],
  // NARROW-LEAVED, checked against data/refphotos/. The `lance` class at
  // 8.5 cm long and 2.2 cm wide is too large for these:
  //   Salvia lavandulifolia   3-5 cm x under 1 cm, grey-green, sprawling
  //   Salvia coahuilensis     2-4 cm x 3-5 mm, the narrowest sage in the palette
  //   Penstemon heterophyllus 2-6 cm x 2-8 mm
  //   Oenothera lindheimeri   3-8 cm x 5-15 mm
  [/salvia\s+(lavandulifolia|coahuilensis)|spanish sage|coahuila sage|penstemon|gaura|oenothera/i, "narrow"],
  // ── the salvias, ABOVE the needle rule and above the greedy /salvia/ medium ──
  //
  // These salvias need distinct leaf shapes; routing them all to `medium`
  // makes them bit-identical at one seed and size.
  //
  // These sit above the needle rule because `Salvia lavandulifolia` contains
  // "lavandul": that rule would draw its 3 cm narrow-oblong grey leaf as a
  // rosemary needle. Scope each line to `salvia <epithet>` or an unambiguous
  // common name; bare /sage/ swallows small-leaved species, and /officinalis/
  // reaches Rosmarinus officinalis, which must stay a needle.
  [/salvia\s+(apiana|leucophylla|leucantha|mellifera|lavandulifolia|coahuilensis|dorrii|pachyphylla|brandegeei)|salvia\s+['\u2019]?bee['\u2019]?s bliss|\bwhite sage\b|\bpurple sage\b|\bblack sage\b|mexican bush sage|spanish sage/i, "lance"],
  [/salvia\s+(spathacea|argentea|sclarea|canariensis)|hummingbird sage|silver sage|clary sage/i, "large"],
  [/salvia\s+(greggii|microphylla|clevelandii|chamaedryoides|jamensis|x\s*jamensis|muelleri)|autumn sage|mountain sage|hot lips|cleveland sage|germander sage/i, "small"],
  [/salvia\s+officinalis|berggarten|\bcommon sage\b|\bgarden sage\b/i, "round"],
  // THYME IS NOT A NEEDLE. Keep it out of this row so first-match-wins reaches
  // `tiny` below. data/refphotos/thymus_spp.jpg shows 4-8 mm OVAL leaves in
  // opposite pairs on wiry stems, not a 5.5 cm needle.
  // A bare genus is an ambiguous image search: Thymus can return the human
  // thymus gland. Verify the species in every reference photograph.
  [/rosmarinus|rosemary|lavandula|lavender|erica|calluna|adenostoma|chamise|westringia|coleonema|ericameria|helichrysum|\bpinus\b|\bpine\b|cedrus|picea|abies|casuarina/i, "needle"],
  [/cupressus|cypress|thuja|calocedrus|chamaecyparis|juniperus|tamarix|sequoia|podocarpus|casuarina/i, "scale"],
  [/ficus|\bfig\b|magnolia|hydrangea|catalpa|paulownia|musa|banana|fatsia|acanthus|canna|gunnera|eriobotrya|loquat|platanus|\bvitis\b|grape|bougainvillea|romneya|bergenia|hosta/i, "large"],
  // MEADOW annuals carry a cushion of foliage (see meadowTuft). Explicit
  // classes keep a 20 cm plant from falling through to the 9 cm `medium` leaf.
  // All but two are finely divided:
  //   Nemophila 2-4 cm pinnately lobed · Lasthenia linear · Gilia and Phacelia
  //   both ferny and dissected
  [/nemophila|baby blue eyes|lasthenia|goldfield|gilia|phacelia/i, "filigree"],
  //   Clarkia 2-5 cm linear-lanceolate · Collinsia 2-5 cm lanceolate
  [/clarkia|farewell|collinsia|chinese houses/i, "small"],
  // ── checked one by one against data/refphotos/, above the greedy row below ──
  //
  // The broad rule below includes many genera, and `medium` is a 9.0 x 4.8 cm
  // leaf. Use photographs to distinguish species that need a smaller class.
  // Toyon (5-10 cm leathery, serrated), Agastache, Osteospermum and Salvia
  // nemorosa 'Caradonna' have broad leaves and stay on `medium`; Caradonna's
  // reference photo shows broad, crinkled basal leaves.
  //
  // NARROW: `medium` is three to six times too wide for these:
  //   Penstemon heterophyllus  2-6 cm x 2-8 mm   (refphotos: linear, grey-green)
  //   Oenothera lindheimeri    3-8 cm x 5-15 mm
  //   Olea europaea            4-8 cm x 10-15 mm
  //   Cistus                   2-5 cm, narrow ovate-lanceolate
  //   Gaillardia               5-10 cm x 1-2 cm, lobed
  [/penstemon|gaura|oenothera|olea|\bolive\b|cistus|rockrose|rock rose|gaillardia|blanket flower/i, "lance"],
  // ROUNDED, and blunt — a spoon, a palmate lobe or a columbine leaflet, none of
  // which is the pointed 9 cm blade `medium` draws:
  //   Erigeron glaucus   2-6 cm spatulate, blunt-tipped
  //   Geranium           palmate, deeply lobed, round in outline
  //   Aquilegia          compound, each lobe 2-3 cm and rounded
  //   Heuchera           5-10 cm rounded and lobed, smaller than `large` at 18 cm
  //   Fremontodendron    2-6 cm, three-lobed, roughly round
  [/erigeron|seaside daisy|geranium|cranesbill|aquilegia|columbine|heuchera|coral bells|fremontodendron|flannel bush/i, "round"],
  // SMALL — a 9 cm leaf is too large for these:
  //   Teucrium chamaedrys  1-2 cm ovate, toothed
  //   Lupinus              palmate leaflets, each 2-5 cm and narrow
  [/teucrium|germander|lupinus|lupin/i, "small"],
  [/salvia|cistus|phlomis|teucrium|encelia|mimulus|diplacus|galvezia|ribes|rhamnus|frangula|prunus|quercus|\boak\b|acer|maple|cercis|redbud|arbutus|citrus|olea|olive|lagerstroemia|penstemon|agastache|monardella|origanum(?!\s+majorana)|nepeta|verbena|gaura|oenothera|osteospermum|erigeron|geranium|aquilegia|heteromeles|toyon|lupinus|lupin/i, "medium"],
  // TINY, above the small rule. Measured against data/refphotos/: Eriogonum
  // fasciculatum is 5-15 mm and fascicled, Baccharis and Origanum majorana are
  // 1-2 cm, and thyme is under 1 cm. A 5 cm leaf makes these knee-high
  // subshrubs read as distant large shrubs.
  [/eriogonum|buckwheat|baccharis|coyote brush|thymus|\bthyme\b|origanum|marjoram|oregano|dymondia|delosperma|erica\b|calluna|heather|muehlenbeckia|coprosma\s+petriei/i, "tiny"],
  [/arctostaphylos|manzanita|ceanothus|buxus|boxwood|myrtus|\bmyrtle\b|rhaphiolepis|eriogonum|buckwheat|baccharis|origanum|marjoram|oregano|dymondia|sedum|delosperma|escallonia|pittosporum|coprosma|loropetalum|symphoricarpos|fragaria|strawberr|vaccinium|grevillea|leptospermum|correa/i, "small"],
];

// What the model will actually write, not just the six canonical words. A bare
// "green leaves" or "leafy" matches NOTHING, for the same reason a bare "green"
// says nothing to normalizeFoliage: it carries no information the form did not
// already have, and accepting it would collapse the six classes into one.
const LEAF_ALIAS = [
  [/needle|acicular|linear leaf|linear[\s-]?leav|filiform/i, "needle"],
  [/filigree|feathery|ferny|dissect|finely[\s-]?cut|lacy|thread/i, "filigree"],
  [/scale[\s-]?like|scaly|awl|\bscale\b/i, "scale"],
  [/large|broad|bold|palmate|tropical|\bbig\b|huge|paddle/i, "large"],
  // ABOVE medium so "lanceolate" and "lance" keep their narrow shape.
  // \bround, not round: "groundcover" contains "round" but does not imply
  // broad leaves. Word boundaries also distinguish "coyote brush" from rush
  // and "Lupinus" from pinus.
  [/lanceolate|lance[\s-]?shaped|\blance\b|willow[\s-]?leav|narrow(ly)?[\s-]?oblong|strap[\s-]?leav/i, "lance"],
  [/\bround(ed)?\b|obovate|spatulate|\bblunt\b|kidney|orbicular/i, "round"],
  [/medium|ovate|oval|elliptic|toothed/i, "medium"],
  [/\btiny\b|minute|\bminiature\b/i, "tiny"],
  [/small|fine|narrow|little/i, "small"],
];

/** A declared leaf description -> one of LEAF_WORDS, or null if it says nothing. */
export function normalizeLeaf(leaf) {
  if (!leaf) return null;
  for (const [re, l] of LEAF_ALIAS) if (re.test(leaf)) return l;
  return null;
}

// The floor under the other two layers. Only forms that are DRAWN as masses need
// an entry — a grass, a rush, a strap and a rosette already draw their own
// leaves as blades, and giving them a leaf shell as well would clothe a blade in
// smaller blades.
const LEAF_BY_FORM = { mound: "small", mat: "small", tree: "medium", cane: "medium",
                       vine: "large", column: "scale", perennial: "medium" };

/** Which of LEAF_WORDS this plant's foliage is made of. */
export function leafClass(plant) {
  const name = `${plant?.species ?? ""} ${plant?.common ?? ""}`;
  for (const [re, l] of LEAVES) if (re.test(name)) return l;
  const declared = normalizeLeaf(plant?.leaf);
  if (declared) return declared;
  return LEAF_BY_FORM[normalizeForm(plant?.form) ?? growthForm(plant ?? {})] ?? "small";
}

/**
 * The leaf this plant actually grows, sized for THIS individual.
 *
 * A marjoram and a manzanita are both small-leaved, and the marjoram's leaves
 * are a third the size. Scaling the class by the plant keeps a 0.4 m subshrub
 * from being clothed in 5 cm leaves — measured, that alone is most of what makes
 * a small mound read as a small mound rather than as a distant big one.
 */
function leafOf(plant, spread, height) {
  const base = LEAF[leafClass(plant)] ?? LEAF.small;
  const k = THREE.MathUtils.clamp(0.6 + 0.25 * spread, 0.6, 1.15);
  return { ...base,
           len: Math.min(base.len * k, height * 0.4, spread * 0.12),
           wide: base.wide * k };
}

// One lerp for every foliage and bark ramp keeps their interpolation consistent.
const ramp = ([a, b], r) => new THREE.Color(a).lerp(new THREE.Color(b), r());

function tint(plant, form, r) {
  return ramp(foliageRamp(plant) ?? GREENS[form] ?? GREENS.mound, r);
}

// one tapered blade, curved by `arch`, pointing +Y then bent along +Z
//
// The base-to-tip shade is not decoration. A merged clump is ONE mesh in ONE
// colour, so without it a fountain of two hundred blades is a single flat
// silhouette; a real grass is dark and damp in the crown and bleached at the
// tips, and that gradient is most of what makes a clump read as a clump rather
// than as a green cone.
/**
 * The colour of a dead grass blade — bleached cellulose, and the SAME whatever
 * the living plant was, which is why it is absolute rather than derived from the
 * species tint.
 *
 * data/refphotos/festuca_idahoensis.jpg shows a mature Festuca 'Siskiyou Blue'
 * with roughly a third of its clump in straw-white blades among the blue ones.
 * The deergrass in muhlenbergia_rigens.jpg is green at the tips and tan through
 * the lower skirt. Uniform green makes grass read as extruded plastic.
 */
const STRAW = new THREE.Color(0xcdbb8e);

/**
 * The per-vertex multiplier that turns the species' own foliage colour into
 * `target`. vertexColors MULTIPLY the material colour, so this is a division —
 * do it channel by channel and a straw blade is straw on a blue fescue and on a
 * green deergrass alike, instead of being "the green one, but paler".
 */
function bladeTint(target, base) {
  const safe = v => (v > 1e-3 ? v : 1e-3);
  return new THREE.Color(target.r / safe(base.r),
                         target.g / safe(base.g),
                         target.b / safe(base.b));
}

function blade(len, wide, arch, segs = 5, base = 0.78, tip = 1.22, mul = null) {
  const g = new THREE.PlaneGeometry(wide, len, 1, segs);
  const p = g.attributes.position;
  const c = new Float32Array(p.count * 3);
  const mr = mul ? mul.r : 1, mg = mul ? mul.g : 1, mb = mul ? mul.b : 1;
  for (let i = 0; i < p.count; i++) {
    const t = (p.getY(i) + len / 2) / len;          // 0 at base, 1 at tip
    p.setX(i, p.getX(i) * (1 - t * 0.92));           // taper to a point
    p.setZ(i, arch * t * t * len);                   // arch over
    p.setY(i, p.getY(i) + len / 2);                  // sit on the ground
    const f = base + (tip - base) * t;
    // Greyscale only lightens or darkens the plant's hue; reference grasses
    // contain several hues. `mul` lets a blade be straw.
    c[i * 3] = f * mr; c[i * 3 + 1] = f * mg; c[i * 3 + 2] = f * mb;
  }
  g.setAttribute("color", new THREE.BufferAttribute(c, 3));
  g.computeVertexNormals();
  return g;
}

function rosette(h, spread, r) {
  const parts = [];
  const n = 9 + Math.floor(r() * 7);
  for (let i = 0; i < n; i++) {
    const g = blade(h * (0.75 + r() * 0.45), spread * 0.16, 0.25 + r() * 0.3, 4);
    g.rotateX(-(0.55 + r() * 0.5));                  // splay outward from vertical
    g.rotateY((i / n) * Math.PI * 2 + r() * 0.3);
    parts.push(g);
  }
  return parts;
}

/**
 * A grass clump: a fountain of blades, and there have to be MANY.
 *
 * A fixed count of 26-46 gives a 0.45 m fescue and a 1.2 m deergrass the same
 * number of leaves, making the deergrass a handful of straws. A mature
 * Muhlenbergia needs hundreds of fine blades, scaled with its footprint.
 * Five segments per blade keep this density affordable.
 */
// ── how a flower is SHAPED, not just where it is ─────────────────────────────
//
// A mixed border is read by the SHAPE of its flower heads as much as their
// colour: a salvia's whorls, a yarrow's flat plate and a buckwheat's dome are
// distinct shapes. Squashed spheres erase those differences.
//
// Each shape below is taken from a photograph in data/refphotos/, not from memory.
// data/refphotos/salvia_leucophylla.jpg is the clearest: distinct BALLS of flower
// stacked up a bare vertical stem with gaps between them, which is the classic
// verticillaster and is nothing like a sphere.
const BLOOMS = [
  [/satureja hortensis/i, "savory"],
  [/salvia pachyphylla/i, "bracted_whorl"],
  [/salvia microphylla.*hot lips/i, "hot_lips"],
  [/salvia (greggii|microphylla|coahuilensis)/i, "bilabiate"],
  [/heuchera/i, "bell"],
  [/scaevola/i, "fan"],
  [/monardella macrantha/i, "tube_cluster"],
  [/epilobium canum|zauschneria/i, "tube"],
  [/oenothera lindheimeri|gaura lindheimeri/i, "gaura"],
  [/monardella villosa|verbena lilacina/i, "umbel"],
  [/bidens/i, "daisy"],
  [/cistus|fragaria/i, "cup"],
  // stacked whorls up a bare stem — the big Californian sages
  [/salvia (apiana|leucophylla|clevelandii|mellifera|spathacea|columbariae)|white sage|purple sage|black sage|hummingbird sage/i, "whorl"],
  // ROSEMARY IS NOT A SPIRE, so this row precedes the generic salvia rule.
  // data/refphotos/salvia_rosmarinus.jpg shows small pale-blue clusters in the
  // LEAF AXILS along leafy stems: a blue haze THROUGH the green, with no bare
  // stalk. A spike would put blue beads on wire above the rosemary.
  [/rosmarinus|rosemary/i, "haze"],
  // SANTOLINA IS NOT A LAVENDER: its common name is "lavender cotton", so this
  // row precedes /lavender/ to keep its yellow-button habit out of the spire
  // class. The same ordering protects filigree leaves in LEAVES.
  //
  // A santolina flower is a tight button on a long bare stalk — one head at the
  // top of a stem, which is "daisy" in this vocabulary.
  [/santolina|lavender cotton/i, "daisy"],
  // Salvia officinalis carries verticillasters like its big Californian
  // relatives, not a lavender spire.
  [/salvia\s+officinalis|berggarten|\bgarden sage\b/i, "whorl"],
  // a dense narrow spire — lavender, and the small-leaved salvias
  [/salvia|lavandula|lavender|agastache|nepeta|catmint|stachys|salvia nemorosa|sage/i, "spike"],
  // a flat or domed plate of many tiny florets
  [/achillea|yarrow|eriogonum|buckwheat|sedum|allium|fennel|foeniculum|umbel/i, "umbel"],
  // one open disc with rays
  [/erigeron|aster|daisy|osteospermum|gazania|coreopsis|echinacea|helianthus|seaside daisy/i, "daisy"],
  // A spire, but a soft one: lupine and phacelia carry many small florets up a
  // stem. Phacelia's is a coiled cyme, which at the size it renders is a spike.
  [/lupinus|lupine|phacelia|penstemon|digitalis/i, "spike"],
  // Meadow annuals have one open FACE on a long stem. Name their shapes
  // explicitly so changes to the "haze" default cannot alter them.
  // CHINESE HOUSES ARE WHORLS, and the common name says so — Collinsia carries
  // tiered rings of two-lipped flowers up a stem, which is the same architecture
  // as a salvia's verticillaster and nothing like a disc. It precedes the daisy
  // row so a broader match cannot claim it.
  [/collinsia|chinese houses/i, "whorl"],
  // A CUP, not a disc: four or five broad petals standing up from a small centre.
  // A poppy, a baby blue eyes and a farewell-to-spring are bowls you look into,
  // and drawn flat they vanish edge-on — which is most of the time, because a
  // meadow is looked ACROSS.
  [/eschscholzia|poppy|nemophila|blue eyes|clarkia|farewell|aquilegia|columbine|geranium|cranesbill/i, "cup"],
  // GLOBE GILIA is named for its head: Gilia capitata carries a dense spherical
  // cluster of fifty-odd small blue flowers, the umbel family here rather than
  // a disc with rays. refphotos/gilia_spp.jpg shows G. capitata.
  [/gilia/i, "umbel"],
  [/layia|tidy tips|lasthenia|goldfield|gaillardia|blanket flower|heuchera|coral bells/i, "daisy"],
];

/** Which inflorescence a plant carries. Free text first, then species, then form. */
export function bloomForm(plant) {
  const declared = String(plant?.bloom_form ?? "").trim().toLowerCase();
  if (declared) return declared;
  const name = `${plant?.species ?? ""} ${plant?.common ?? ""}`;
  for (const [re, kind] of BLOOMS) if (re.test(name)) return kind;
  return "haze";                       // default for unclassified plants
}

/**
 * One flowering stem, built at `len` with its base at the origin, pointing +Y.
 *
 * The stem is REAL geometry rather than implied, because in every reference photo
 * the bare stem between the whorls is most of what makes the shape legible — a
 * salvia held above its foliage is a row of beads on a wire, and without the wire
 * it is back to being scattered dots.
 */
/**
 * Blossom scattered over a BOUGHT model's canopy.
 *
 * The procedural forms grow their flowers along with their geometry; a GLB
 * arrives finished, so its bloom has to be draped over the outside afterwards.
 * Placement follows the MODEL's own bounding box rather than the plant's
 * declared size, because the two differ — buildAssetPlant scales the model to
 * the design's height and the crown may sit anywhere inside that.
 *
 * The dome rule applies as on a shrub: drawing height and radius independently
 * puts flowers in the air beside the tree, especially visibly on a canopy.
 */
/**
 * How much of a shrub in flower IS flower, and what the visible unit of it is.
 *
 * Read off `data/refphotos/` one species at a time, because it is a fact about
 * the plant and nothing else can supply it. The five entries here are the five
 * species that route to a bought model.
 *
 * Flower coverage is a required species input. A shared formula of
 * `clamp(2600 + spread*3200, 2600, 13000)` heads with radius
 * `clamp(spread*0.007, .., .020)` hits both clamps for all five species,
 * giving each 50.7 m² of blossom. Against leaf area, that is 63% flower on
 * manzanita (18.4 m² of leaf) and 27% on olive (172.6 m²). The olive's reference
 * photograph has no visible flower, so shared counts and sizes are unsuitable.
 *
 * `cover` is a fraction of the CANOPY'S OUTER SURFACE, not of summed leaf area.
 * A ceanothus GLB carries 175 m² of double-sided leaf card inside a shell of
 * about 30 m², and the eye only meets the shell. Sizing against the leaf total
 * asks for a hundred times too many flowers.
 *
 * `unit` is the radius of one thing the eye picks out, and `florets` how many
 * beads make it. A flowering shrub presents CLUSTERS a few centimetres across,
 * not 9 cm blocks or isolated florets that read as snow. A panicle, a raceme
 * and a corymb are lumpy masses of tiny florets; drawing each as a cluster is
 * both the accurate shape and the cheap one.
 */
const BLOOM_UNITS = [
  // refphotos/ceanothus_spp.jpg: a solid sheet of blue, the leaves barely
  // showing through. Panicles 4-8 cm of hundreds of 3 mm florets.
  [/ceanothus|california lilac/i, { cover: 0.50, unit: 0.030, florets: 9, squash: 0.80 }],
  // refphotos/fremontodendron_spp.jpg: single OPEN 5-6 cm saucers, scattered
  // rather than clustered — one floret IS the unit, and it is a disc.
  [/fremontodendron|flannel/i,    { cover: 0.22, unit: 0.030, florets: 1, squash: 0.40 }],
  // refphotos/arctostaphylos_spp.jpg: glossy dark leaves dominate; small drooping
  // racemes of 6 mm white-pink urns at the shoot tips, well spaced.
  [/arctostaphylos|manzanita/i,   { cover: 0.11, unit: 0.018, florets: 5, squash: 0.90 }],
  // refphotos/heteromeles_arbutifolia.jpg is of the BERRIES, which is what a
  // toyon is grown for and what it is named for twice over. The cream summer
  // flower it carries here is the right colour for `bloom: "summer"`, and it
  // comes in the same dense 6-12 cm corymb the berries do.
  [/heteromeles|toyon/i,          { cover: 0.13, unit: 0.040, florets: 12, squash: 0.75 }],
  // refphotos/olea_europaea_fruitless.jpg: a grey-green tree with NO visible
  // flower at any distance you would stand from it. Nearly zero, not zero — the
  // panicles exist, they are 2 mm and cream and hidden in the leaf axils.
  [/olea|olive/i,                 { cover: 0.015, unit: 0.014, florets: 4, squash: 0.85 }],
];

const BLOOM_UNIT_DEFAULT = { cover: 0.16, unit: 0.022, florets: 6, squash: 0.85 };

/** What one flowering unit of this species looks like, and how much of it there is. */
export function bloomUnit(plant) {
  const name = `${plant?.species ?? ""} ${plant?.common ?? ""}`;
  for (const [re, spec] of BLOOM_UNITS) if (re.test(name)) return spec;
  return BLOOM_UNIT_DEFAULT;
}

/**
 * Blossom scattered over a BOUGHT model's canopy.
 *
 * The procedural forms grow their flowers along with their geometry; a GLB
 * arrives finished, so its bloom has to be draped over the outside afterwards.
 * Placement follows the MODEL's own bounding box rather than the plant's declared
 * size, because the two differ — buildAssetPlant scales the model to the declared
 * height and a random yaw then widens the box.
 *
 * The COUNT is derived, never chosen: it is whatever hits `spec.cover` of the
 * canopy shell, measured against one real unit's own triangulated area. So a
 * change to the segment count or the squash cannot silently change how flowery a
 * plant looks, and the number in the table is a claim about the plant that
 * tests/js/plant_bloom.test.mjs can check.
 */
export function assetBlooms(asset, spread, r, spec) {
  const box = new THREE.Box3().setFromObject(asset);
  if (box.isEmpty()) return null;
  const lo = box.min.y, hi = box.max.y;
  if (!(hi > lo)) return null;
  const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
  const rx = Math.max((box.max.x - box.min.x) / 2, 0.05);
  const rz = Math.max((box.max.z - box.min.z) / 2, 0.05);
  if (!(spec.cover > 0)) return null;

  // the canopy is the upper 55% of the model; nothing blooms on the bare trunk
  const ry = Math.max((hi - lo) * 0.5 * 0.55, 0.05);
  const shell = ellipsoidArea(rx, ry, rz);

  // one unit, built at the origin, so its cost is MEASURED rather than assumed
  const unit = () => {
    const gs = [];
    for (let i = 0; i < spec.florets; i++) {
      const fr = spec.florets === 1
        ? spec.unit
        : spec.unit * (0.34 + r() * 0.20);
      const g = new THREE.SphereGeometry(fr, 6, 4);
      g.scale(1, spec.squash, 1);
      if (spec.florets > 1) {
        // packed inside the unit's own envelope, which is what makes a panicle
        // lumpy instead of round
        const a = r() * Math.PI * 2, z = r() * 2 - 1, rad = Math.cbrt(r()) * (spec.unit - fr);
        const s2 = Math.sqrt(Math.max(0, 1 - z * z));
        g.translate(Math.cos(a) * s2 * rad, z * rad * 1.25, Math.sin(a) * s2 * rad);
      }
      gs.push(g);
    }
    return gs;
  };

  // A HANDFUL OF TEMPLATES, CLONED. Building the florets afresh at every
  // placement is the same picture and forty times the wall clock: a ceanothus at
  // 50% cover wants ~2,900 panicles, and nine SphereGeometry allocations each is
  // 26,000 constructions — measured at 1,580 ms to build ONE shrub, which would
  // stall every `look` the design agent takes. Sixteen variants is enough that no
  // two neighbouring clusters are visibly the same and the eye cannot find the
  // repeat in a mass of thousands.
  const variants = [];
  for (let v = 0; v < 16; v++) {
    const m = mergeGeometries(unit(), false);
    if (m) variants.push(m);
  }
  if (!variants.length) return null;
  // the area of the AVERAGE variant, so the derived count is not hostage to
  // whichever one happened to be built first
  const unitArea = variants.reduce((a, g) => a + geomTriangleArea(g), 0) / variants.length;
  if (!(unitArea > 0)) { for (const g of variants) g.dispose(); return null; }

  const want = (spec.cover / (1 - spec.cover)) * shell;
  const n = Math.max(1, Math.min(24000, Math.round(want / unitArea)));

  const parts = [];
  for (let i = 0; i < n; i++) {
    // out on the SHELL, where a shoot tip is: rad biased outward rather than the
    // uniform-in-volume sqrt(), because blossom on the inside of a canopy is
    // hidden by the canopy and is spend with nothing to show for it
    const t = 0.45 + r() * 0.53;
    const dome = Math.sqrt(Math.max(0, 1 - ((t - 0.45) / 0.55) ** 2));
    const a = r() * Math.PI * 2, rad = (0.72 + r() * 0.28) * Math.max(dome, 0.25);
    const x = cx + Math.cos(a) * rad * rx * 0.94;
    const y = lo + (hi - lo) * t;
    const z = cz + Math.sin(a) * rad * rz * 0.94;
    const g = variants[(r() * variants.length) | 0].clone();
    g.rotateY(r() * Math.PI * 2);      // so the repeat cannot read as an orientation
    g.translate(x, y, z);
    parts.push(g);
  }
  for (const g of variants) g.dispose();
  const merged = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  return merged ? new THREE.Mesh(merged) : null;
}

function bloomStem(kind, len, wide, r) {
  const botanical = botanicalHead(kind, len, wide, r);
  if (botanical) return botanical;
  // The stem comes back SEPARATELY from the heads because it has a different
  // colour. A stalk drawn in the bloom material looks like a cream stick
  // wherever leaves fail to hide it. A flower stalk is GREEN; only the head
  // is the flower.
  const out = [];
  // A FLOWER STEM IS 2 MM. Scaling it as `wide * 0.10` gives a poppy with a
  // 4.5 cm cup a 7 mm stalk; forty such stems read as rods with petals on top.
  // Herbaceous flower stalks run about 1.5-4 mm whatever the flower on the end,
  // so they read as wire and disappear into the planting.
  const sr = THREE.MathUtils.clamp(wide * 0.075, 0.0013, 0.0040);
  const stem = new THREE.CylinderGeometry(sr * 0.8, sr, len, 3, 1);
  // every primitive here is deliberately coarse: a flower head is 3-8 px at the
  // distance this garden is judged from, and the SHAPE is what has to read, not
  // the facets. The whole bloom must cost about what the haze it replaces did.
  stem.translate(0, len / 2, 0);
  if (kind === "whorl") {
    // 3-5 balls up the top two-thirds, with bare stem between: the verticillaster
    const n = 3 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      const t = 0.30 + (i / Math.max(n - 1, 1)) * 0.66;
      const rad = wide * (0.52 - 0.10 * (i / Math.max(n - 1, 1)));   // smaller upward
      const g = new THREE.SphereGeometry(rad, 5, 3);
      g.scale(1, 0.72, 1);
      g.translate(0, len * t, 0);
      out.push(g);
    }
  } else if (kind === "spike") {
    // A dense tapering spire. Five 1.6 cm beads at 4.8 cm spacing look like
    // berries on a wire; data/refphotos/salvia_nemorosa_caradonna.jpg shows a
    // CONTINUOUS column of florets with no gaps.
    //
    // A tapered rachis fills between florets; closing gaps with beads alone
    // costs twenty-three spheres per spike and twenty spikes per plant.
    // The FLORETS define the outline. A fat cone with small bumps reads as a
    // smooth purple traffic cone rather than individual flowers.
    const base = len * 0.52, top = len * 0.99, L = top - base;
    const body = new THREE.CylinderGeometry(wide * 0.05, wide * 0.20, L, 5, 1);
    body.translate(0, base + L / 2, 0);
    out.push(body);
    const n = 10 + Math.floor(r() * 5);
    for (let i = 0; i < n; i++) {
      const t = i / Math.max(n - 1, 1);
      const a = t * 9.4 + r() * 0.7;                 // spiralling up, as they do
      const rad = wide * (0.24 - 0.15 * t);
      // 4x2 segments: eight triangles. Fourteen of these per spike and twenty
      // spikes per plant is the budget this has to live inside.
      const g = new THREE.SphereGeometry(wide * (0.44 - 0.26 * t), 4, 2);
      g.translate(Math.cos(a) * rad, base + L * (0.03 + t * 0.95), Math.sin(a) * rad);
      out.push(g);
    }
  } else if (kind === "umbel") {
    // A flat plate of MANY tiny florets: a yarrow is a table, not a bead ring.
    // Sparse umbels and daisies cover only 2-6% of a plant's visible surface,
    // against 21-26% for spike flowers. A yarrow in flower is mostly flower:
    // its corymb packs florets into 5-10 cm, so pack them.
    const n = 26 + Math.floor(r() * 14);
    for (let i = 0; i < n; i++) {
      // sqrt so they spread evenly over the DISC rather than crowding the middle
      const a = r() * Math.PI * 2;
      const rad = wide * 0.72 * Math.sqrt(r());
      const g = new THREE.SphereGeometry(wide * 0.15 * (0.75 + r() * 0.5), 5, 3);
      g.scale(1, 0.55, 1);
      // the plate domes very slightly, which is what stops it reading as a decal
      g.translate(Math.cos(a) * rad, len * (0.96 + r() * 0.04) - (rad / wide) * wide * 0.06,
                  Math.sin(a) * rad);
      out.push(g);
    }
  } else if (kind === "cup") {
    /**
     * A CUP — a poppy, a baby blue eyes: four to five broad petals standing up
     * from a small centre to make a shallow bowl.
     *
     * A flat plate seen from anywhere but straight above is a LINE. At eye
     * level it reduces a California poppy to orange slivers over a green lump.
     *
     * The petals lean OUT rather than lying flat, so the flower keeps an outline
     * at eye level — which is the whole point, because a meadow is looked across
     * rather than down at.
     */
    const petals = 4 + Math.floor(r() * 2);
    for (let i = 0; i < petals; i++) {
      const a = (i / petals) * Math.PI * 2 + r() * 0.25;
      const pw = wide * (0.52 + r() * 0.16), pl = wide * (0.62 + r() * 0.18);
      const g = new THREE.SphereGeometry(1, 6, 4);
      g.scale(pw * 0.5, wide * 0.05, pl * 0.5);
      // tipped up out of the horizontal: this is what makes it a bowl
      g.rotateX(-(0.55 + r() * 0.25));
      g.rotateY(-a);
      g.translate(Math.cos(a) * pl * 0.42, len + pl * 0.20, Math.sin(a) * pl * 0.42);
      out.push(g);
    }
    const eye = new THREE.SphereGeometry(wide * 0.16, 6, 4);
    eye.scale(1, 0.6, 1);
    eye.translate(0, len + wide * 0.06, 0);
    out.push(eye);
  } else {
    /**
     * A DAISY has RAYS. A flat hexagonal plate `wide * 0.10` thick disappears
     * edge-on and otherwise reads as plastic. Tidy-tips, erigeron and coreopsis
     * have a small raised centre and a ring of narrow petals; that RING is
     * recognisable at four metres.
     */
    const rays = 9 + Math.floor(r() * 5);
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * Math.PI * 2 + r() * 0.12;
      const rl = wide * (0.56 + r() * 0.14);
      const g = new THREE.SphereGeometry(1, 5, 3);
      g.scale(wide * 0.11, wide * 0.035, rl * 0.5);
      g.rotateX(-(0.10 + r() * 0.16));            // rays lift a little from flat
      g.rotateY(-a);
      g.translate(Math.cos(a) * rl * 0.56, len, Math.sin(a) * rl * 0.56);
      out.push(g);
    }
    const disc = new THREE.SphereGeometry(wide * 0.24, 7, 4);
    disc.scale(1, 0.5, 1);
    disc.translate(0, len + wide * 0.03, 0);
    out.push(disc);
  }
  return { stem, heads: out };
}

/** How much of a mature clump is dead blades. Counted off the reference photos. */
const STRAW_FRACTION = 0.3;

/**
 * How much of a clump is BLEACHED, per species, read off data/refphotos/.
 *
 * A global 0.3 is wrong in both directions: muhlenbergia_rigens.jpg shows a
 * bright green fountain with straw deep in the crown; festuca_californica.jpg
 * is more bleached than living. Straw blades flop furthest and define the
 * OUTLINE, so their fraction sets the edge colour. At 0.3 the deergrass has an
 * incorrect yellow halo.
 *
 * An evergreen sedge or a Lomandra keeps its leaves, so it is nearly all living;
 * a summer-dormant Californian bunchgrass is half straw by August.
 */
const STRAW_BY_SPECIES = [
  [/muhlenbergia|deer ?grass/i, 0.10],       // solid green in the photo
  [/festuca californica/i,      0.50],       // more bleached than living
  [/festuca|fescue/i,           0.26],       // blue fescues carry some
  [/carex|sedge/i,              0.10],       // evergreen, variegated
  [/lomandra|mat rush/i,        0.08],       // evergreen strap
  [/juncus|rush/i,              0.12],
];

/** The bleached fraction for this plant. */
export function strawFraction(plant) {
  const name = `${plant?.species ?? ""} ${plant?.common ?? ""}`;
  for (const [re, f] of STRAW_BY_SPECIES) if (re.test(name)) return f;
  return STRAW_FRACTION;
}

/**
 * How wide a grass blade is, in METRES — a botanical fact, not a fraction of the
 * plant.
 *
 * `spread * 0.045` makes a 1.2 m deergrass from 54 mm blades. Muhlenbergia
 * rigens blades are 2-4 mm and Festuca idahoensis is finer still; at 54 mm the
 * clump looks like leeks regardless of colour. A grass is a HAZE of threads,
 * whose fine width gives the soft edge in data/refphotos/muhlenbergia_rigens.jpg.
 *
 * 6 mm rather than a botanical 3 mm, and that is a rendering decision rather than
 * a botanical one: below about a pixel a blade stops being anti-aliased into a
 * soft edge and starts flickering, and this garden is judged from 5-15 m.
 */
const BLADE_W_M = 0.006;

/**
 * How much blade a clump carries, as a multiple of its own silhouette.
 *
 * DERIVED, not clamped. Measured across the palette, forms that read correctly
 * sit at 1.0-2.4 (mats 1.12-1.46, perennials 1.43-1.85, rush 2.17). Coverage of
 * 0.16-0.23 is six times short: deergrass reads as straws rather than the solid
 * fountain in data/refphotos/muhlenbergia_rigens.jpg. Do not cap blade counts
 * to meet a triangle budget; preserve the density.
 *
 * 2.0 rather than the 2.1 the leaf forms use: a blade is opaque and a leaf card
 * is alpha-tested, so the same number covers slightly more.
 */
const BLADE_COVER = 2.0;

function grassClump(h, spread, r, foliage = null, strawF = STRAW_FRACTION, bladeWidth = BLADE_W_M) {
  // The count is whatever hits BLADE_COVER, measured against a real blade's own
  // area rather than assumed from len x width — blade() tapers, so a blade
  // presents about 47% of its bounding strip. Using the strip area instead
  // undercounts blades by about 2x.
  const probe = blade(h * 0.775, bladeWidth, -0.3, 5, 0.78, 1.22, null);
  const probeArea = geomTriangleArea(probe);
  probe.dispose();
  const shell = ellipsoidArea(spread / 2, h / 2, spread / 2);
  const n = probeArea > 0
    ? Math.max(40, Math.min(6000, Math.round((BLADE_COVER * shell) / probeArea)))
    : 240;

  // ── written straight into typed arrays, not built blade by blade ────────────
  //
  // A deergrass has ~2,900 blades: 49 grasses need about 142,000 geometries if
  // each blade is a THREE.PlaneGeometry followed by mergeGeometries. That costs
  // 2.6 s of a 2.9 s design build. Per blade: PlaneGeometry 5.27 us,
  // computeVertexNormals 3.19 us, vertex edits 0.37 us — 96% geometry overhead.
  //
  // Cloning does not help much here: 4.06 us against 5.27 to construct. A blade
  // is one small strip, while an assetBlooms cluster contains nine spheres and
  // benefits from cloning. Measure each bottleneck separately.
  //
  // The normal is analytic. The surface is
  //     P(x, t) = ( x*(1 - 0.92t), t*len, arch*t*t*len )
  // so dP/dx = (1 - 0.92t, 0, 0) and dP/dt = (-0.92x, len, 2*arch*t*len), and the
  // cross product is (0, -(1-0.92t)*2*arch*t*len, (1-0.92t)*len) — exact, and it
  // costs nothing next to walking the faces.
  const SEG = 5, VPB = (SEG + 1) * 2, TPB = SEG * 2;
  const pos = new Float32Array(n * VPB * 3);
  const nor = new Float32Array(n * VPB * 3);
  const col = new Float32Array(n * VPB * 3);
  const idx = new Uint32Array(n * TPB * 3);
  const straw = foliage ? bladeTint(STRAW, foliage) : null;
  const BASE = 0.78, TIP = 1.22;
  let vo = 0, io = 0;

  for (let i = 0; i < n; i++) {
    // sqrt(r) so the blades crowd the crown instead of ringing it
    const a = r() * Math.PI * 2, rad = Math.sqrt(r()) * spread * 0.16;
    const dead = straw !== null && r() < strawF;
    // The ranges must OVERLAP. Disjoint ranges (dead 29-57 deg, living 5-26 deg)
    // put low straw blades around an upright green dome in two separate bands.
    // muhlenbergia_rigens.jpg and festuca_californica.jpg show bleached blades
    // THROUGH the clump, some arching over the top. Dead blades flop further
    // but still overlap the living ones.
    const tilt = dead ? 0.28 + r() * 0.72 : 0.10 + r() * 0.62;
    const sinT = Math.max(Math.sin(tilt), 1e-3), cosT = Math.cos(tilt);
    const budget = Math.max(0.10, spread * 0.5 - rad);       // room left to the edge
    // A DEERGRASS IS A FOUNTAIN whose width comes from ARCH, not tilt. At 0.30,
    // a 0.93 m blade displaces only 0.21 m sideways, leaving near-straight living
    // rays inside a wide straw skirt. In muhlenbergia_rigens.jpg every blade
    // leaves the crown steeply, curves over and brings its tip down at the edge.
    let reach = budget * (dead ? 1.0 : 0.85) * (0.7 + r() * 0.6);
    // The budget solve below subtracts reach*cosT, so a reach big enough to eat
    // the whole budget drives lenMax negative and the h*0.25 floor takes over —
    // silently abandoning the spread guarantee. Without the arch cap grasses
    // measure 110-122% of their declared width. Cap the arch against the budget
    // FIRST so the solve keeps its meaning.
    reach = Math.min(reach, budget * 0.80 / Math.max(cosT, 1e-3));
    const lenMax = (budget - reach * cosT) / sinT;
    const len = Math.min(h * (0.55 + r() * 0.45), Math.max(lenMax, h * 0.25));
    reach = Math.min(reach, len * cosT / sinT * 0.85);       // keep the tip above 0
    const arch = -reach / len;
    const wide = bladeWidth * (0.75 + r() * 0.5);

    const mr = dead ? straw.r : 1, mg = dead ? straw.g : 1, mb = dead ? straw.b : 1;
    // rotateX(-tilt) then rotateY(a2), then out to the crown radius
    const a2 = a + (r() - 0.5) * 1.2;
    const cy = Math.cos(a2), sy = Math.sin(a2);
    const ox = Math.cos(a) * rad, oz = Math.sin(a) * rad;
    const v0 = vo / 3;

    for (let iy = 0; iy <= SEG; iy++) {
      const t = 1 - iy / SEG;                       // 1 at the tip, 0 at the base
      const half = (wide / 2) * (1 - t * 0.92);     // taper to a point
      const ly = t * len, lz = arch * t * t * len;
      // local normal, from the cross product above
      const k = 1 - 0.92 * t;
      let nx = 0, ny = -k * 2 * arch * t * len, nz = k * len;
      const nl = Math.hypot(ny, nz) || 1;
      ny /= nl; nz /= nl;
      const f = BASE + (TIP - BASE) * t;
      for (let ix = 0; ix < 2; ix++) {
        const lx = ix ? half : -half;
        // rotateX(-tilt): y' = y cos + z sin, z' = -y sin + z cos
        const y1 = ly * cosT + lz * sinT, z1 = -ly * sinT + lz * cosT;
        // rotateY(a2): x' = x cos + z sin, z' = -x sin + z cos
        pos[vo]     = lx * cy + z1 * sy + ox;
        pos[vo + 1] = y1;
        pos[vo + 2] = -lx * sy + z1 * cy + oz;
        const my1 = ny * cosT + nz * sinT, mz1 = -ny * sinT + nz * cosT;
        nor[vo]     = nx * cy + mz1 * sy;
        nor[vo + 1] = my1;
        nor[vo + 2] = -nx * sy + mz1 * cy;
        col[vo] = f * mr; col[vo + 1] = f * mg; col[vo + 2] = f * mb;
        vo += 3;
      }
    }
    for (let iy = 0; iy < SEG; iy++) {
      const p0 = v0 + iy * 2, p1 = p0 + 1, p2 = p0 + 2, p3 = p0 + 3;
      idx[io++] = p0; idx[io++] = p2; idx[io++] = p1;
      idx[io++] = p1; idx[io++] = p2; idx[io++] = p3;
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return [g];
}

function woodyTrunk(h, rad, lean, r) {
  const g = new THREE.CylinderGeometry(rad * 0.62, rad, h, 7, 3);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = (p.getY(i) + h / 2) / h;
    p.setX(i, p.getX(i) + lean * t * t * h * 0.35);
    p.setZ(i, p.getZ(i) + lean * t * t * h * 0.18);
  }
  g.computeVertexNormals();
  g.translate(0, h / 2, 0);
  return g;
}

// Per-vertex shade multiplier. Merged foliage is one mesh with one colour, so
// without this a shrub is a single flat silhouette; varying lightness per blob
// is what separates the lit outer foliage from the shaded interior and stops a
// mound reading as a boulder.
function shade(geo, f) {
  const n = geo.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = f; c[i * 3 + 1] = f; c[i * 3 + 2] = f; }
  geo.setAttribute("color", new THREE.BufferAttribute(c, 3));
  return geo;
}

/**
 * Subdivision for a foliage blob of this radius.
 *
 * Detail 1 gives 80 faces at every size: a 0.5 m mass has ~0.36 m facets and
 * reads at eye level as faceted rock rather than leaves.
 *
 * It scales with SIZE because that is where facets are visible, and it is capped
 * because tests/js/design.test.mjs holds the whole scene to a triangle budget:
 * detail 3 is 1280 faces per blob and a shrub carries up to 26 of them.
 *
 * The cores are CORE_R of their masses and the leaves carry the silhouette.
 * This mostly subdivides the interior, but a core visible through a thin
 * canopy must still not read as a plate; foliage_detail.test.mjs checks it.
 */
/**
 * How much of a foliage mass the solid core fills; the leaves fill the rest.
 *
 * At 0.86 the core defines the silhouette and the leaves form a fringe,
 * which renders as a smooth pillow with hairs. Everything the eye uses to read
 * foliage — the broken edge, the depth, the holes — lives in the outer half of
 * the mass, so the core keeps only the inner core of it and stops the plant
 * being see-through.
 */
const CORE_R = 0.44;

function blobDetail(r, clothed = false) {
  // A CLOTHED core has no silhouette to smooth. Subdivision buys one thing —
  // that the mass's own outline does not read as a polyhedron — and once the
  // leaf shell is the outline, every extra face is paid for and never seen.
  // Crossing the 0.22 m tier quadruples a core's vertex count. Measured build
  // cost with larger cores is 1085 ms against a 900 ms budget even with fewer
  // output triangles: unseen subdivision still costs generation time.
  if (clothed) return r > 1.5 ? 2 : 1;
  if (r > 1.5) return 3;      // a tree canopy mass — few of them, and huge
  if (r > 0.22) return 2;     // shrub-sized: 320 faces, ~0.13 m facets at 0.5 m
  return 1;                   // small enough that 80 faces already reads smooth
}

/**
 * Rough a foliage blob up, by POSITION rather than per vertex.
 *
 * Independent random displacement of each vertex in a NON-INDEXED icosahedron
 * moves the three copies of every shared corner to different places. A 2.5 m
 * manzanita then measures 3420 triangles in 3408 disconnected pieces, the
 * largest only TWO TRIANGLES. Each loose triangle has a hard lit edge;
 * subdivision cannot reconnect the surface.
 *
 * Sampling smooth functions of the vertex's own position makes neighbours move
 * together, so the surface stays whole however finely it is subdivided. Normals
 * are then taken RADIALLY instead of per face: a lumpy sphere shaded smooth
 * reads as a mass, and the same geometry shaded flat reads as cut stone.
 */
function lumpy(geo, radius, r, amp, squash = 1) {
  const p = geo.attributes.position;
  const f1 = 2.3 + r() * 2.2, f2 = 3.1 + r() * 2.4, f3 = 4.7 + r() * 2.6;
  const a = r() * 6.283, b = r() * 6.283, c = r() * 6.283;
  const n = new Float32Array(p.count * 3);
  const inv = 1 / (radius || 1);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) * inv, y = p.getY(i) * inv, z = p.getZ(i) * inv;
    const w = Math.sin(x * f1 + a) * Math.cos(y * f2 + b)
            + Math.sin(z * f3 + c) * Math.cos(x * f2 - a);
    const k = 1 + w * amp * 0.5;
    const nx = x * k, ny = y * k * squash, nz = z * k;
    p.setXYZ(i, nx * radius, ny * radius, nz * radius);
    const l = Math.hypot(nx, ny, nz) || 1;
    n[i * 3] = nx / l; n[i * 3 + 1] = ny / l; n[i * 3 + 2] = nz / l;
  }
  geo.setAttribute("normal", new THREE.BufferAttribute(n, 3));
  return geo;
}

/**
 * A shrub as many small foliage masses on a dome, not a few big ellipsoids.
 *
 * A ceanothus or a rosemary is read at distance by a lumpy, grainy outline. Four
 * large smooth blobs give a rock; sixteen small rough ones give a bush. The
 * masses are pushed toward the outer shell so the silhouette does the work.
 *
 * Return the MASSES with the geometry so the leaf shell can use the same
 * surfaces. `lift` keeps foliage off the ground to expose stems below it;
 * a manzanita's mahogany bark is a defining feature, so keep its base clear.
 */
/**
 * How coarse the foliage volume may be, from how fine the LEAF is.
 *
 * Sixteen 0.33-0.60 m blobs on a 1.5 m plant can hide under broad leaves, but a
 * 2.6 cm leaf needs several times as many cards to cover the same area. A card
 * cap makes the shell patchy and exposes smooth spheres as the silhouette.
 *
 * data/refphotos/ settles what the answer is. A buckwheat is WIRY: many thin
 * stems, tiny leaves in tight clusters, and you can see straight through it.
 * There is no solid volume in it at all. So a fine-leaved plant gets many small
 * masses instead of a few big ones — no single one large enough to read as a
 * ball — and a core small enough that a patchy shell does not expose a sphere.
 */
// `small` is NOT in here: manzanita and ceanothus can clothe normal masses.
// Applying fine grain to them adds 140,000 triangles across the design without
// improving their canopies.
// This is the WIRY set — the plants whose leaves are so fine that a normal mass
// cannot be clothed.
const FINE_LEAVES = new Set(["tiny", "needle", "filigree", "scale"]);
function massGrain(plant) {
  return FINE_LEAVES.has(leafClass(plant))
    ? { size: 0.85, count: 1.4, core: 1.0, shade: 0.55 }      // Many small masses, not a few big ones, and the core smaller again inside
      // them. Shrinking ONLY the core leaves the triangle count unchanged
      // (628,420 in the measured design), but exposes spheres through a patchy
      // fine-leaf shell. Changing mass count and size breaks up the spheres,
      // at about 55,000 extra triangles across that design. COVERAGE is
      // count * size^2 and must stay near 1: size 0.46 with count 2.1 gives
      // 0.44 and leaves detached clumps with gaps.
    : { size: 1.0, count: 1.0, core: 1.0, shade: 1.0 };
}

function shrubMasses(spread, height, r, squash = 1.0, count = 16, lift = 0,
                     grain = { size: 1, count: 1, core: 1, shade: 1 }, leaf = null) {
  const parts = [], masses = [];
  // half-ellipsoid rooted AT THE GROUND: a dome centred at height/2 would leave
  // the lower half empty and the shrub visibly floating
  const rx = spread * 0.5, ry = height * squash;
  // FEWER masses when each is bigger. Doubling the radius with the leaf-size
  // floor quadruples shell area if count stays fixed: measured cost is 654,168
  // triangles and 1246 ms to build against a 900 ms budget. Reduce count by
  // the square of the radius increase to keep shell area steady.
  const natural = Math.min(spread * 0.155 * grain.size, Math.max(0.03, ry * 0.9));
  const floorS = leaf ? Math.min((leaf.len * 1.6) / Math.max(CORE_R * grain.core, 0.05),
                                 spread * 0.32) : 0;
  const swell = Math.max(1, floorS / Math.max(natural, 1e-3));
  const n = Math.max(3, Math.round(count * grain.count / (swell * swell)));
  for (let i = 0; i < n; i++) {
    // Bound masses by the ellipsoid's SHORT axis as well as its long one.
    // Spread alone gives a 0.1 m x 0.5 m thyme carpet 0.1 m blobs and renders
    // it 0.25 m tall — 2.5x its height. Groundcovers need flat lumps.
    // A LEAF MUST BE SMALL RELATIVE TO ITS CLUMP. With a core at `s * CORE_R`,
    // a 0.7 m Berggarten sage can have 4.8 cm core radii under 5.5 cm leaves.
    // That ratio makes the shell bristle like a sea urchin, even when leaves
    // lean away from the surface normal.
    //
    // Leaf length over core radius measures this: Berggarten 1.15, white sage
    // 1.04 and rockrose 0.83 bristle, while California buckwheat at 0.25 reads
    // correctly. Lavender cotton also sits high in this comparison. Increase
    // mass size, not CORE_R: 0.86 makes smooth pillows with a fringe of leaves.
    //
    // 1.6 leaf-lengths of core radius makes the ball about three leaves across,
    // which is where foliage starts draping instead of bristling. Capped at a
    // third of the spread so a big-leaved plant becomes a few broad clumps rather
    // than one sphere.
    const wantCore = leaf ? (leaf.len * 1.6) / Math.max(CORE_R * grain.core, 0.05) : 0;
    // The HEIGHT CAP still wins: spread-sized 0.1 m blobs make a 0.1 m thyme
    // carpet 0.25 m tall. Letting the leaf floor override it makes a declared
    // 0.4 m Salvia 'Bee's Bliss' render at 0.84 m. A plant may not grow to suit
    // its leaves; the salvia suite checks its height.
    //
    // Where the cap bites, the leaf is simply too big for the plant and the fix
    // belongs in the ROUTING, not here — Bee's Bliss is a prostrate sage with
    // roughly 5 cm leaves wearing `lance`, which is 8.5 cm.
    const cap = Math.max(0.03, ry * 0.9);
    const s = Math.min(cap, Math.max(
      Math.min(wantCore, spread * 0.32),
      Math.min(spread * (0.11 + r() * 0.09) * grain.size, cap)));
    // The CORE is much smaller than the mass it stands for. `s` is the volume
    // the plant occupies there and the leaves fill it out to that radius; the
    // core is only what keeps it from being see-through, so at CORE_R it never
    // reaches the silhouette and never has to be smooth enough to be one.
    // At 0.86 the core makes a smooth pillow with a fringe of leaves. Leaves
    // must define the surface, not trim a solid silhouette.
    const cs = s * CORE_R * grain.core;
    const g = new THREE.IcosahedronGeometry(cs, blobDetail(cs, !!leaf));
    lumpy(g, cs, r, 0.34);
    // sqrt biases outward without abandoning the middle: a 0.6-1.0 range
    // leaves a hollow shell with stems visible straight through it.
    const shell = 0.42 + 0.58 * Math.sqrt(r());
    const th = r() * Math.PI * 2;
    const cy = r();                                // 0 at the ground, 1 at the top
    const ph = Math.acos(cy);
    // The declared spread is the plant's OUTSIDE, not where its mass centres go.
    // Placing a centre at rx and then drawing a mass of radius s around it puts
    // the edge at rx + s, and on a small plant with a big mass that is most of the
    // plant again: meadow annuals measure 164% of their radius and 139-155% of
    // their declared width with centres placed that far out. Reaching to rx - s
    // instead means the outermost point lands exactly on rx, whatever the sizes.
    const reach = Math.max(rx * 0.25, rx - s);
    const x = reach * shell * Math.sin(ph) * Math.cos(th);
    // NO mass reaches below `lift`: subtract its radius from the range first.
    // Placing the centre at lift puts half of a low mass underground; simply
    // lifting the centre can leave the whole shrub on stilts.
    const y = lift + s + Math.max(0, ry - lift - s * 1.4) * shell * cy;
    const z = reach * shell * Math.sin(ph) * Math.sin(th);
    g.translate(x, y, z);
    // The core is the shaded INTERIOR visible between leaves. At 0.74-1.10
    // it looks like a bright smooth pillow with leaves stuck on. Tie shading
    // to height because light falls on the top.
    const f = 0.42 + 0.28 * cy + (r() - 0.5) * 0.08;
    // A coreless mass (`grain.core` of 0) is still recorded for the leaf shell.
    // data/refphotos/eriogonum_fasciculatum shows thin stems and tiny clustered
    // leaves with gaps. A small core inside a full-sized mass still exposes a
    // sphere wherever the shell is patchy; omitting it is cheaper.
    // Most fine-leaved plants need a DARK core, however: rosemary, santolina
    // and lavender are dense and look like bare twigs without one. Their
    // interior must read as shadow glimpsed between leaves, not a bright
    // smooth object.
    parts.push(shade(g, f * grain.shade));
    // `r` is the radius the LEAF SHELL scatters over and `cs` is what is drawn:
    // the leaves fill the mass out to `s`, and the core only stops it being
    // see-through. Do NOT shrink `r` toward the core here — a shrub's masses
    // interpenetrate and the wide shell is what fills the gaps between them.
    masses.push({ x, y, z, r: s, shade: f, core: cs, area: geomArea(g) });
  }
  return { parts, masses };
}

/**
 * The surface area of a built geometry, in m2.
 *
 * Recorded on each mass at the moment it is made, because `masses[].r` does NOT
 * mean the same thing at the three places masses are pushed: shrubMasses and
 * canopyMasses store the OUTER radius the shell scatters over and draw a core of
 * `r * CORE_R` (0.44), while perennialClump stores the radius it actually draws.
 * Pricing leaf count off `r` alone over-clothes a mat 5x and a mound 8x while
 * leaving a perennial bare: the field describes different surfaces.
 *
 * Measuring the geometry is the fix that cannot drift: squash, lumpiness and
 * CORE_R are all already baked into it.
 */
function geomArea(g) {
  // O(1), from the geometry's bounding box rather than a triangle walk.
  // Subdivided masses make per-triangle sums expensive: measured build time
  // is 1275 ms against a 900 ms budget even with fewer output triangles.
  // The cost comes from triangles walked, not triangles drawn.
  //
  // Knud Thomsen's ellipsoid approximation is within about 1% and needs no
  // elliptic integral. The ACTUAL box includes squash, lumpiness and CORE_R.
  g.computeBoundingBox();
  const b = g.boundingBox;
  if (!b) return 0;
  return ellipsoidArea((b.max.x - b.min.x) / 2,
                       (b.max.y - b.min.y) / 2,
                       (b.max.z - b.min.z) / 2);
}

/**
 * Surface of an ellipsoid with the given semi-axes — Knud Thomsen, within ~1%.
 *
 * ONE copy for geomArea, leaf-count envelopes and assetBlooms canopy sizing.
 * Duplicating it risks drift; tests/test_dry.py guards against that.
 */
export function ellipsoidArea(a1, a2, a3) {
  const x = Math.max(a1, 1e-4), y = Math.max(a2, 1e-4), z = Math.max(a3, 1e-4);
  const P = 1.6075;
  return 4 * Math.PI * (((x ** P * y ** P + x ** P * z ** P + y ** P * z ** P) / 3)
                        ** (1 / P));
}

/**
 * The EXACT triangulated area of a geometry, by walking it.
 *
 * geomArea's ellipsoid approximation is right for a leaf mass and wrong for a
 * flower cluster, which is a handful of separated beads rather than one solid —
 * its bounding box would report the area of the envelope they sit in, several
 * times what the beads actually present. This is only ever called on ONE sample
 * unit, so the per-triangle cost stays bounded.
 */
export function geomTriangleArea(g) {
  const pos = g.getAttribute("position");
  if (!pos) return 0;
  const idx = g.getIndex();
  const n = idx ? idx.count / 3 : pos.count / 3;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let sum = 0;
  for (let t = 0; t < n; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    sum += b.sub(a).cross(c.sub(a)).length() / 2;
  }
  return sum;
}

// overlapping ellipsoids read as a broken canopy; one sphere reads as a ball
function canopyMasses(cx, cy, cz, spread, height, count, r, squash = 0.72) {
  const parts = [], masses = [];
  for (let i = 0; i < count; i++) {
    const s = spread * (0.34 + r() * 0.3);
    const cs = s * CORE_R;
    const g = new THREE.IcosahedronGeometry(cs, blobDetail(cs));
    lumpy(g, cs, r, 0.20, squash);
    // Same bound as shrubMasses: the centre may only reach out to where the mass
    // still fits inside the declared spread, or the canopy is its own radius
    // wider than the design says. A canopy mass is a THIRD of the crown here, so
    // this is the difference between a 4 m tree and a 5 m one.
    const reach = Math.max(spread * 0.10, spread * 0.5 - s);
    const x = cx + (r() - 0.5) * 2 * reach;
    const y = cy + (r() - 0.5) * height * 0.3;
    const z = cz + (r() - 0.5) * 2 * reach;
    g.translate(x, y, z);
    const f = 0.50 + (r() - 0.5) * 0.22;
    parts.push(shade(g, f));
    // `r` is the radius the LEAF SHELL scatters over and `cs` is what is drawn:
    // the leaves fill the mass out to `s`, and the core only stops it being
    // see-through. Do NOT shrink `r` toward the core here — a shrub's masses
    // interpenetrate and the wide shell is what fills the gaps between them.
    masses.push({ x, y, z, r: s, shade: f, core: cs, area: geomArea(g) });
  }
  return { parts, masses };
}


/**
 * How many leaf cards it takes to actually CLOTHE these masses.
 *
 * A plant's bounding ellipsoid is close to a single canopy but poorly
 * estimates a scattered clump. With counts based on that estimate, leaf-card
 * area over solid-mass surface measures:
 *
 *     thyme (mat)      2.02      seaside daisy   0.24
 *     white sage       1.99      yarrow          0.24
 *     poppy            1.47      caradonna       0.23
 *     buckwheat        1.08      penstemon       0.17
 *
 * Coverage at or above 1 reads as foliage; a fifth of that exposes bare
 * ellipsoids. The ellipsoid formula over-prices a mound by 2-5x and
 * under-prices a clump by 2x. Count from the masses instead, using coverage
 * as a ratio the user can check in the viewer.
 */
// Leaf area per unit of mass surface. Texture-mask area is measured separately
// for each leaf class in leafMaskMetrics, including its cropped UV margins.
const TARGET_COVERAGE = 2.1;

/**
 * How many leaf cards it takes to clothe these masses.
 *
 * `envelope` is the area of the canopy the plant must FILL, a FLOOR on what
 * gets clothed. visibleArea() discounts surface buried inside neighbours;
 * summing whole spheres over-prices a packed mound 2-5x. But small cores
 * spaced across a canopy have visible surface only 0.32-0.44 of the plant's
 * silhouette. Pricing on that alone leaves the gaps BETWEEN cores bare.
 *
 * Leaf area over the plant's outer ellipsoid makes this visible: mats measure
 * 1.12-1.46 and perennials 1.43-1.85, while mounds priced only on cores measure
 * 0.67-0.93. Close up, that exposes dark faceted cores with sparse leaf spikes.
 *
 * Clothe whichever area is larger. Packed mounds use their visible area
 * because touching blobs have no larger envelope; scattered mounds also pay
 * for the gaps they must fill.
 */
function leafCountFor(masses, leaf, envelope = 0, cls = "medium") {
  // Geometry area alone counts the transparent part of a card as foliage.
  // A needle mask covers only about 7% of its card; ignoring that makes
  // dense rosemary look like a smooth ball with a few hairs at full detail.
  const mask = leafMaskMetrics(cls);
  const card = Math.max(leaf.len * leaf.wide * mask.area / mask.width, 1e-6);
  const clothe = Math.max(visibleArea(masses), envelope);
  return Math.round(THREE.MathUtils.clamp(
    // 140,000 allows the largest mounds to reach the required coverage. A 2.5 m
    // coyote brush has a 13.4 m² canopy and a `small` leaf card of 0.00029 m²:
    // 40,000 cards cover only 11.6 m², or 0.87, below the 1.0-2.4 range that
    // reads correctly. A triangle cap must not defeat the envelope floor.
    TARGET_COVERAGE * clothe / card, 60, 140000));
}

/**
 * The area of these masses that is actually on the OUTSIDE, in m2.
 *
 * Summing whole spheres clothes surface that is buried inside a neighbour, and
 * the error is not uniform: a mound is 7-16 blobs packed into one canopy and
 * loses most of its total area to overlap, while a perennial's basal clump is
 * scattered over a disc and loses little. Priced on the raw sum, a 1.2 m
 * manzanita reaches a 6500-card cap and a 0.4 m one costs 1,548 cards — twice
 * the vertex budget tests/js/foliage_detail.test.mjs allows for a small plant,
 * with most of those leaves hidden inside the shrub.
 *
 * Each buried cap is exact rather than fudged: for two spheres at distance d the
 * cap of i inside j has area 2*pi*ri*(ri - (d^2 + ri^2 - rj^2) / 2d). Summing
 * caps double-counts where three masses meet, so the result is floored at a
 * quarter of the raw area — a sphere in a dense canopy still shows SOME face.
 */
function visibleArea(masses) {
  let total = 0;
  for (let i = 0; i < masses.length; i++) {
    const a = masses[i];
    // The DRAWN radius, never `r`: the shell radius is 1/CORE_R times larger.
    // Mixing them doubles the apparent overlap and collapses perennial leaf
    // counts onto the 60-card floor.
    const ra = a.core ?? a.r, full = a.area ?? (4 * Math.PI * ra * ra);
    let buried = 0;
    for (let j = 0; j < masses.length; j++) {
      if (i === j) continue;
      const b = masses[j], rb = b.core ?? b.r;
      const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      if (d >= ra + rb || d <= 1e-6) continue;
      if (d + ra <= rb) { buried = full; break; }         // a is swallowed whole
      const capH = ra - (d * d + ra * ra - rb * rb) / (2 * d);
      if (capH > 0) buried += full * (capH / (2 * ra));   // cap area / sphere area
    }
    total += Math.max(full - buried, full * 0.25);
  }
  return total;
}

/**
 * A shell of leaf cards scattered over foliage masses.
 *
 * At the distance a bed is judged from, a shrub reads as LEAVES: many small
 * flat things at many angles, with a ragged edge against the sky. Subdividing
 * smooth closed surfaces cannot supply that edge.
 *
 * Written straight into typed arrays rather than as N little PlaneGeometries
 * merged afterwards, because a mature manzanita carries about three thousand of
 * them and constructing three thousand BufferGeometry objects per plant is how
 * the asset window's thumbnails would stop being instant.
 *
 * Two triangles each. That is cheaper than the masses they clothe: on a 0.5 m
 * subshrub this whole layer costs about 200 triangles.
 */
/**
 * A leaf, drawn as an alpha mask.
 *
 * Photorealistic foliage needs leaf shapes, not flat rectangles of colour
 * that read as green lozenges. A leaf-shaped mask with a midrib and an uneven
 * edge supplies that detail without bought or downloaded assets, the standing
 * constraint here.
 *
 * One texture per CLASS, cached: a hundred plants times hundreds of cards means a
 * texture per card would melt the tab.
 *
 * Returns null when there is no usable 2D context — the node tests have none, and
 * so does a browser that refuses one. Flat leaves are a worse picture; a thrown
 * exception is a dead viewer.
 */
const LEAF_SHAPE = {
  // width as a fraction of length, how far up the widest point sits, and how
  // many teeth the margin has. These are what makes a rosemary needle not a
  // manzanita paddle.
  // a mask for `tiny` is not optional: leafTexture falls back to the `medium`
  // mask for any class with no entry here, SILENTLY, so a new size class without
  // a new shape renders as the very thing it was created to escape.
  tiny:     { w: 0.58, mid: 0.46, teeth: 0,  tip: 0.70 },
  needle:   { w: 0.13, mid: 0.50, teeth: 0,  tip: 0.95 },
  filigree: { w: 0.42, mid: 0.45, teeth: 9,  tip: 0.60 },
  scale:    { w: 0.55, mid: 0.45, teeth: 0,  tip: 0.45 },
  small:    { w: 0.52, mid: 0.42, teeth: 0,  tip: 0.72 },
  // leafTexture falls back to the `medium` mask for any class with no entry
  // here, silently — so a new LEAF class without a new mask is a class that
  // renders as the one it was added to escape.
  round:    { w: 0.88, mid: 0.52, teeth: 0,  tip: 1.00 },
  // 0.22 of its own length: a 4.2 cm leaf drawn 0.9 cm across, which is what the
  // photograph shows. A class with no entry here silently borrows the `medium`
  // mask and renders as the very thing it was created to escape.
  narrow:   { w: 0.22, mid: 0.42, teeth: 0,  tip: 0.62 },
  lance:    { w: 0.22, mid: 0.38, teeth: 0,  tip: 0.55 },
  medium:   { w: 0.60, mid: 0.45, teeth: 3,  tip: 0.78 },
  large:    { w: 0.72, mid: 0.48, teeth: 5,  tip: 0.82 },
};
let leafTex = new Map();

/** Area of the mask outline in UV space, independent of DOM/canvas availability. */
function leafMaskMetrics(cls) {
  const sh = LEAF_SHAPE[cls] || LEAF_SHAPE.medium, w=sh.w*.5;
  const points=[[.5,.02]];
  const curve=(a,b,c,d)=>{
    for(let i=1;i<=32;i++){
      const t=i/32,s=1-t;
      points.push([0,1].map(k=>s*s*s*a[k]+3*s*s*t*b[k]+3*s*t*t*c[k]+t*t*t*d[k]));
    }
  };
  curve([.5,.02],[.5+w*sh.tip,.16],[.5+w,.02+sh.mid],[.5+w*.55,.8]);
  curve([.5+w*.55,.8],[.5+w*.28,.93],[.5+w*.1,.97],[.5,.99]);
  const area = polygonArea(points) * 2;
  // Mirrored halves: twice one half's area. Teeth only remove a small margin.
  return {area:Math.max(.04,area*(1-sh.teeth*.008)),
          width:Math.max(...points.map(p=>(p[0]-.5)*2))};
}
export const leafMaskFraction = cls => leafMaskMetrics(cls).area;

export function leafTexture(cls) {
  const key = LEAF_SHAPE[cls] ? cls : "medium";
  if (leafTex.has(key)) return leafTex.get(key);
  let tex = null;
  try {
    const S = 128;
    const c = document.createElement("canvas");
    c.width = c.height = S;
    const g = c.getContext("2d");
    if (!g) { leafTex.set(key, null); return null; }
    const sh = LEAF_SHAPE[key];
    g.clearRect(0, 0, S, S);
    // the blade: a half-outline mirrored, so the two sides match as a real leaf's do
    const half = (sign) => {
      g.moveTo(S / 2, S * 0.02);
      const wide = S * sh.w * 0.5;
      const midY = S * (0.02 + sh.mid);
      g.bezierCurveTo(S / 2 + sign * wide * sh.tip, S * 0.16,
                      S / 2 + sign * wide, midY,
                      S / 2 + sign * wide * 0.55, S * 0.80);
      g.bezierCurveTo(S / 2 + sign * wide * 0.28, S * 0.93,
                      S / 2 + sign * wide * 0.10, S * 0.97,
                      S / 2, S * 0.99);
    };
    g.beginPath();
    half(1);
    half(-1);
    g.closePath();
    g.fillStyle = "#ffffff";
    g.fill();
    // teeth along the margin, cut OUT, so a serrated leaf is serrated
    if (sh.teeth) {
      g.globalCompositeOperation = "destination-out";
      for (let i = 0; i < sh.teeth; i++) {
        const t = 0.18 + (i / sh.teeth) * 0.66;
        const y = S * t;
        const x = S / 2 + S * sh.w * 0.5 * (1 - Math.abs(t - sh.mid) * 1.1);
        for (const sgn of [1, -1]) {
          g.beginPath();
          g.arc(S / 2 + sgn * (x - S / 2), y, S * 0.035, 0, Math.PI * 2);
          g.fill();
        }
      }
      g.globalCompositeOperation = "source-over";
    }
    // midrib: a leaf without one reads as a petal
    g.strokeStyle = "rgba(0,0,0,0.28)";
    g.lineWidth = Math.max(1, S * 0.012);
    g.beginPath();
    g.moveTo(S / 2, S * 0.06);
    g.lineTo(S / 2, S * 0.95);
    g.stroke();
    tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    // MEASURE the mask's coverage and keep it on the texture. A single
    // alphaTest threshold makes rosemary invisible: the `needle` mask averages
    // about 0.07 alpha, so mipping a 3 cm card toward that mean puts EVERY texel
    // below a 0.45 cut. The card vanishes, leaving bare stems and blobs. Derive
    // coverage so a new mask cannot disagree with a separately stored number.
    try {
      const px = g.getImageData(0, 0, S, S).data;
      let sum = 0;
      for (let i = 3; i < px.length; i += 4) sum += px[i];
      tex.userData.coverage = sum / (255 * S * S);
    } catch { tex.userData.coverage = null; }
  } catch (e) {
    console.warn("plants.js: no leaf texture —", e);
    tex = null;
  }
  leafTex.set(key, tex);
  return tex;
}

/** Drop caches so tests can exercise no-context fallbacks. A memoised texture
 *  bypasses that path and can hide an exception in contactShadowTexture. */
export function forgetLeafTextures() { leafTex = new Map(); }
export function forgetShadowTexture() { shadowTex = null; }


function leafShell(masses, leaf, r, count, cls = "medium", grow = 1) {
  if (!count || !masses.length) return null;
  // leaves go where the surface is: proportional to each mass's area
  const w = masses.map(m => m.r * m.r);
  const total = w.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  const cuts = w.map(x => (acc += x / total));

  const P = new Float32Array(count * 18), N = new Float32Array(count * 18);
  const U = new Float32Array(count * 12), C = new Float32Array(count * 18);
  const { len, wide, taper, droop } = leaf;
  const maskWidth = leafMaskMetrics(cls).width;
  const u0 = .5-maskWidth/2, u1 = .5+maskWidth/2;

  for (let i = 0; i < count; i++) {
    const pick = r();
    let mi = 0;
    while (mi < cuts.length - 1 && pick > cuts[mi]) mi++;
    const m = masses[mi];

    // Where on the mass, and which way is out. The radius is a BAND, not the
    // surface: leaves fill the shell the core no longer occupies (see CORE_R),
    // so the foliage has depth and the holes between leaves show more leaves
    // behind rather than a smooth pillow.
    const u = r() * 2 - 1, th = r() * Math.PI * 2;
    const s2 = Math.sqrt(Math.max(0, 1 - u * u));
    const nx = s2 * Math.cos(th), ny = u, nz = s2 * Math.sin(th);
    const band = m.r * (CORE_R * 0.85 + r() * (1.0 - CORE_R * 0.85));
    const px = m.x + nx * band, py = m.y + ny * band, pz = m.z + nz * band;

    // The leaf points outward, scattered, and tipped over by its own weight. The
    // scatter is wide on purpose: a leaf held on the surface normal is a spine,
    // and a mass of them is a sea urchin. Real foliage lies mostly ALONG the
    // canopy surface with a few leaves catching the light face-on.
    let ax = nx * 0.55 + (r() - 0.5) * 1.7;
    let ay = ny * 0.55 - droop * 0.8 + (r() - 0.5) * 1.1;
    let az = nz * 0.55 + (r() - 0.5) * 1.7;
    const L = len * (0.75 + r() * 0.5);
    // no leaf drives into the ground: on the lowest masses, point it back up
    if (py + ay * L < 0.004) ay = Math.abs(ay);
    const al = Math.hypot(ax, ay, az) || 1;
    ax /= al; ay /= al; az /= al;

    // the leaf's own plane, rolled at random about its axis — without this every
    // leaf on a mass presents the same face and the shell reads as a hedgehog
    const qx = r() - 0.5, qy = r() - 0.5, qz = r() - 0.5;
    let sx = ay * qz - az * qy, sy = az * qx - ax * qz, sz = ax * qy - ay * qx;
    let sl = Math.hypot(sx, sy, sz);
    if (sl < 1e-4) { sx = 1; sy = 0; sz = 0; sl = 1; }
    sx /= sl; sy /= sl; sz /= sl;

    // The mask supplies the outline. Tapering the card as well turns 2.2 cm
    // sage leaves into 3 mm needles. Crop transparent UV margins and keep the
    // physical width on the rectangular card.
    // A GROWN LEAF in Fast's capped shell keeps its TIP at the true leaf's tip
    // and grows inward. Outward growth makes lavender 8% wide and thyme 11% tall.
    const hw = wide * (0.8 + r() * 0.45) * 0.5 * grow, tw = hw;
    const tx = px + ax * L, ty = py + ay * L, tz = pz + az * L;
    const bx = tx - ax * L * grow, by = Math.max(0.002, ty - ay * L * grow), bz = tz - az * L * grow;
    const v = [
      bx - sx * hw, by - sy * hw, bz - sz * hw,     // 0 base left
      bx + sx * hw, by + sy * hw, bz + sz * hw,     // 1 base right
      tx + sx * tw, ty + sy * tw, tz + sz * tw,     // 2 tip right
      tx - sx * tw, ty - sy * tw, tz - sz * tw,     // 3 tip left
    ];
    const order = [0, 1, 2, 0, 2, 3];
    // one face normal for the whole card: a leaf IS flat
    const e1x = v[3] - v[0], e1y = v[4] - v[1], e1z = v[5] - v[2];
    const e2x = v[6] - v[0], e2y = v[7] - v[1], e2z = v[8] - v[2];
    let fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    // Leaves are the LIT surface, so their shade is their own. Inheriting the
    // core's interior-shadow value darkens the whole plant. `m.shade` still
    // tilts it so leaves low in the plant stay shaded.
    const lit = (0.72 + m.shade * 0.5) * (0.84 + r() * 0.34);
    const UVS = [u0, 0, u1, 0, u1, 1, u0, 0, u1, 1, u0, 1];

    for (let k = 0; k < 6; k++) {
      const o = order[k] * 3, d = (i * 6 + k) * 3;
      P[d] = v[o]; P[d + 1] = v[o + 1]; P[d + 2] = v[o + 2];
      N[d] = fx; N[d + 1] = fy; N[d + 2] = fz;
      // tips catch the light; the leaf base sits in the mass's own shade
      const f = lit * (order[k] >= 2 ? 1.1 : 0.94);
      C[d] = f; C[d + 1] = f; C[d + 2] = f;
      U[(i * 6 + k) * 2] = UVS[k * 2]; U[(i * 6 + k) * 2 + 1] = UVS[k * 2 + 1];
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(P, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(N, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(U, 2));
  g.setAttribute("color", new THREE.BufferAttribute(C, 3));
  return g;
}

/**
 * The woody frame of a shrub, from the ground up into the canopy.
 *
 * Foliage alone makes a 2.5 m manzanita look like a hedge clipping balanced on
 * the lawn, even with 10,260 foliage vertices. Its woody frame must be visible.
 * Small plants such as marjoram have no visible wood; do not invent stems.
 */
function shrubStems(h, spread, r, grain = { size: 1, count: 1 }) {
  const out = [];
  // 0.7 m, not 0.45: santolina shows only about 10 cm of woody base. Stems
  // reaching two thirds of its height make it look raised on stilts, so stop
  // stems well below the canopy top.
  if (h < 0.7) return out;
  // A wiry shrub has MANY THIN stems. data/refphotos/eriogonum_fasciculatum
  // shows dozens at 2-4 mm; 3-6 stems at 16 mm on a 0.9 m plant look like bare
  // sticks. Use the masses' grain so "fine-leaved" has one definition.
  const n = Math.round(THREE.MathUtils.clamp((2 + h * 1.5) * grain.count, 3, 14));
  const rad = Math.max(0.0025, h * 0.018 * grain.size);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + r() * 0.9;
    const len = h * (0.42 + r() * 0.24);
    const g = woodyTrunk(len, rad * (0.7 + r() * 0.5), 0.35 + r() * 0.5, r);
    g.rotateZ((r() - 0.5) * 0.3);
    g.rotateY(a);
    // splayed from a common root plate, the way a multi-stem shrub actually grows
    g.translate(Math.cos(a) * spread * 0.05, 0, Math.sin(a) * spread * 0.05);
    out.push(g);
  }
  return out;
}

// A plant with nothing under it looks pasted onto the ground, but a hard-rimmed
// disc reads as a floating mulch patch at eye level. A real contact shadow has
// no edge: radial falloff and low opacity make it present underfoot without
// appearing as a separate object.
let shadowTex = null;
function contactShadowTexture() {
  if (shadowTex) return shadowTex;                 // one texture for every plant
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx2 = c.getContext("2d");
  // A browser or headless run may have no usable 2D context. Omitting the
  // contact shadow is a smaller loss than throwing and stopping the viewer.
  if (!ctx2) return null;
  const g = ctx2.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(10,16,12,0.55)");
  g.addColorStop(0.55, "rgba(10,16,12,0.22)");
  g.addColorStop(1, "rgba(10,16,12,0)");
  const ctx = ctx2;
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  shadowTex = new THREE.CanvasTexture(c);
  return shadowTex;
}

function contactShadow(spread) {
  const tex = contactShadowTexture();
  if (!tex) return null;                 // nothing to draw it with
  const disc = new THREE.Mesh(
    new THREE.PlaneGeometry(spread * 0.9, spread * 0.9),
    new THREE.MeshBasicMaterial({ map: contactShadowTexture(), transparent: true,
      opacity: 0.55, depthWrite: false }));
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.015;
  disc.renderOrder = 1;
  // NAMED so plant measurements can exclude it: this quad spans the whole
  // spread and otherwise dominates bounds and facet sizes.
  // tests/js/palette_renders.test.mjs checks the plant's own height.
  disc.name = "shadow";
  return disc;
}


/**
 * A rush: stiff vertical cylinders from a tight base, almost no taper.
 *
 * Juncus reads as a bundle of grey-green pencils and nothing else — give it any
 * arch and it becomes a grass, which is the distinction the eye actually uses to
 * tell a wet corner from a dry one.
 */
function rushClump(h, spread, r) {
  const out = [];
  // Scale stems with size: a fixed 14-24 gives a 0.6 m plant only 224 triangles
  // against 1,650 for a same-sized Lomandra and looks like chopsticks. Juncus
  // patens must be dense enough to be opaque at the base.
  const n = Math.round(THREE.MathUtils.clamp(30 + spread * 95, 30, 130));
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2, rad = Math.sqrt(r()) * spread * 0.35;
    const bh = h * (0.7 + r() * 0.45);
    const g = new THREE.CylinderGeometry(0.006, 0.011, bh, 4, 1);
    g.translate(0, bh / 2, 0);
    // barely off vertical: 4-7 degrees, so the clump has life without arching
    const lean = (r() - 0.5) * 0.13;
    g.rotateX(lean); g.rotateZ((r() - 0.5) * 0.13);
    g.translate(Math.cos(a) * rad, 0, Math.sin(a) * rad);
    out.push(g);
  }
  return out;
}

/**
 * A strap-leaved clump: Phormium, Sisyrinchium. Wide stiff blades fanning from
 * one point, arching only near the tip.
 */
/**
 * How wide a STRAP leaf is, in metres — botanical, like BLADE_W_M.
 *
 * A proportional width such as `spread * 0.055` misses the botanical range:
 * Phormium leaves are 5-10 cm wide and Sisyrinchium leaves 2-4 mm, a twenty-fold
 * difference. It also makes a coverage-derived count scale-invariant because
 * canopy shell and blade area both grow as size^2. A 1.5 m flax and a 0.3 m
 * blue-eyed grass then get the SAME number of leaves; the palette test guards
 * against this.
 */
const STRAP_W_M = [
  [/phormium|flax/i,               0.055],
  [/sisyrinchium|blue-?eyed/i,     0.004],
];
function strapBladeWidth(name) {
  const n = String(name ?? "");
  for (const [re, w] of STRAP_W_M) if (re.test(n)) return w;
  return 0.02;
}

function strapClump(h, spread, r, blooms, kind, name = "") {
  const out = [];
  // A fixed 9-15 blades makes a 1.5 m Phormium a 100-triangle placeholder.
  // Only 40% of its footprint carries foliage, and a 0.3 m Sisyrinchium only
  // 27%. Even 74 blades instead of 16 gives flax silhouette coverage of 0.55
  // and blue-eyed grass 0.35, below the 1.0-2.4 range that reads correctly.
  // Derive from BLADE_COVER as for grasses: a fan must look dense, and triangle
  // savings must not determine its leaf count.
  const wProbe = strapBladeWidth(name);
  const shell = ellipsoidArea(spread / 2, h / 2, spread / 2);
  // a strap blade tapers to a point over its length, so it presents about half
  // its bounding rectangle; measured rather than assumed below by the same probe
  // trick the grasses use
  const probe = new THREE.PlaneGeometry(wProbe, h * 0.95, 1, 5);
  {
    const pos = probe.attributes.position;
    for (let v = 0; v < pos.count; v++) {
      const t = (pos.getY(v) + h * 0.95 / 2) / (h * 0.95);
      pos.setX(v, pos.getX(v) * (1 - 0.75 * t));
    }
  }
  const probeArea = geomTriangleArea(probe);
  probe.dispose();
  const n = probeArea > 0
    ? Math.max(16, Math.min(900, Math.round((BLADE_COVER * shell) / probeArea)))
    : 40;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + r() * 0.4;
    const bh = h * (0.75 + r() * 0.4);
    const w = wProbe;
    const g = new THREE.PlaneGeometry(w, bh, 1, 5);
    const pos = g.attributes.position;
    for (let v = 0; v < pos.count; v++) {
      const t = (pos.getY(v) + bh / 2) / bh;          // 0 base .. 1 tip
      // the arch is all in the last third, and the blade narrows to a point
      pos.setZ(v, t * t * t * bh * 0.42);
      pos.setX(v, pos.getX(v) * (1 - 0.75 * t));
    }
    g.computeVertexNormals();
    g.translate(0, bh / 2, 0);
    g.rotateY(a);
    // The base ring must HOLD the blades side by side. At spread*0.06 a 1.5 m
    // Phormium puts 41 blades 8 cm wide through a 9 cm circle, making an opaque
    // column. A mature flax clump is about half a metre across at the ground.
    // The arch must point OUTWARD: rotateY(a) carries local +Z, the tip's curve,
    // to (sin a, 0, cos a). Placing the base at (cos a, 0, sin a) misaligns it
    // and makes blades curve around the clump. A strap plant is a fountain.
    const dir = [Math.sin(a), Math.cos(a)];
    // and the base ring only has to be wide enough that the blades do not merge;
    // once they splay outward it can stay tight, which is what a fan looks like
    const ring = Math.min(Math.max(spread * 0.06, (n * w) / (2 * Math.PI) * 0.45),
                          spread * 0.16);
    g.translate(dir[0] * ring, 0, dir[1] * ring);
    out.push(g);
  }
  // Blue-eyed grass needs blue stars just above its narrow blade tips; without
  // bloom it is only a small green fan. Only SMALL straps use these flowers:
  // a Phormium's inflorescence is a 3 m panicle.
  if (blooms && h <= 0.6) {
    const stems = 3 + Math.floor(r() * 4);
    const wide = THREE.MathUtils.clamp(spread * 0.10, 0.014, 0.030);
    for (let i = 0; i < stems; i++) {
      const a = r() * Math.PI * 2, rad = Math.sqrt(r()) * spread * 0.22;
      const len = h * (0.85 + r() * 0.25);
      const { stem, heads } = bloomStem(kind ?? "daisy", len, wide, r);
      const tilt = (r() - 0.5) * 0.26;
      const place = (x) => {
        x.rotateZ(tilt);
        x.translate(Math.cos(a) * rad, 0, Math.sin(a) * rad);
      };
      place(stem); out.push(stem);
      for (const x of heads) { place(x); blooms.push(x); }
    }
  }
  return out;
}

/**
 * A herbaceous clump: soft basal foliage with flower stems held ABOVE it.
 *
 * That gap between leaf and flower is what makes a yarrow read as a perennial
 * rather than a small shrub, and it is the reason these cannot keep sharing
 * shrubMasses with the Salvias.
 *
 * The basal mound uses leaf cards over low masses, not bare squashed spheres.
 * This is the 花境 case — a mixed herbaceous border is read almost entirely at
 * the height of its own foliage, and a yarrow drawn as two sticks with a white
 * ball on each is not something a planting scheme can be judged from.
 */
function perennialClump(h, spread, r, blooms, kind, stemLeaf = null) {
  const out = [], masses = [];
  const leafH = h * 0.45;   // the basal foliage; the flowers stand well above it
  // DENSITY WITH AREA. A fixed 7-11 clumps covers a median 56% of the
  // perennial's footprint, against 84% for a mound and 93% for a mat. Yarrow
  // needs a solid cushion of ferny foliage, not tufts on bare soil. Its clump
  // is two-dimensional at this scale, so count follows spread SQUARED.
  const clumps = Math.round(THREE.MathUtils.clamp(10 + spread * spread * 9, 10, 34));
  for (let i = 0; i < clumps; i++) {
    const a = r() * Math.PI * 2, rad = Math.sqrt(r()) * spread * 0.42;
    const s = spread * (0.13 + r() * 0.09);
    // CORE_R, as in every mass builder. Drawing a core at the full shell
    // radius gives a perennial five times the surface of a mound with the
    // same shell, exposing smooth ellipsoids however many leaves cover them.
    // Keep core radius distinct from the leaf shell's `masses[].r`.
    const cs = s * CORE_R;
    // SphereGeometry + lumpy(), as for other masses. A smooth ellipsoid reads
    // as a solid wherever it shows; a jittered surface reads as more foliage.
    // Rough mounds tolerate a third of the coverage for this reason.
    const g = new THREE.SphereGeometry(cs, 7, 5);
    lumpy(g, cs, r, 0.26, 0.55);
    const x = Math.cos(a) * rad, y = leafH * (0.32 + r() * 0.3), z = Math.sin(a) * rad;
    g.translate(x, y, z);
    // DARK, as for other cores (shrubMasses uses ~0.50). At 0.72-0.92 the core
    // is lighter than its leaves and looks like a pale lump. Any visible core
    // should read as depth and shadow between leaves.
    const f = 0.52 + (r() - 0.5) * 0.18;
    out.push(shade(g, f));
    // The shell sits JUST OUTSIDE the core, not at 1/CORE_R times its radius.
    // Reporting full `s` puts cards 2.3x the core radius out, making a halo
    // around its waist while leaving the top bare. A mound's eight to sixteen
    // interpenetrating masses fill those gaps; seven scattered herbaceous
    // masses cannot.
    masses.push({ x, y, z, r: cs * 1.3, shade: f, core: cs, area: geomArea(g) });
  }
  // NO shell here: every leaf-clad form collects masses in buildPlant's
  // `clothe` and gets ONE shell at the end. A separate 900-card cap here
  // would make leaf count cease to be a property of the plant.
  // Use bloomStem() for the species' OWN inflorescence. Salvia nemorosa
  // 'Caradonna' needs the dense tapering spires, repeated fifteen or twenty
  // times, in data/refphotos/salvia_nemorosa_caradonna.jpg; squashed spheres
  // cannot express its "spike" form.
  // Flowering perennials need far more than twenty stems. A 6-22 cap makes
  // daisy and umbel flowers specks above foliage; do not save triangles at
  // the cost of the plant's density.
  const stems = Math.round(THREE.MathUtils.clamp(14 + spread * 46, 14, 68));
  // a botanical size: a salvia spire is 2-3 cm across and an erigeron disc 3-4,
  // whatever the clump it is standing on
  const wide = THREE.MathUtils.clamp(spread * 0.07, 0.015, 0.040);
  for (let i = 0; i < stems; i++) {
    const a = r() * Math.PI * 2, rad = Math.sqrt(r()) * spread * 0.42;
    // the stem carries the flower to the plant's DECLARED height — that gap over
    // the basal foliage is what makes a perennial read as a perennial
    const len = h * (0.80 + r() * 0.28);
    const { stem, heads } = bloomStem(kind, len, wide, r);
    const tilt = (r() - 0.5) * 0.22;
    const place = (g) => {
      g.rotateZ(tilt);                              // one tilt for the whole inflorescence
      g.translate(Math.cos(a) * rad, 0, Math.sin(a) * rad);
    };
    place(stem); out.push(stem);                     // GREEN, like a stalk
    for (const g of heads) { place(g); (blooms ?? out).push(g); }
    if (stemLeaf) for (let j = 1; j <= 3; j++) {
      const y = len * (0.16 + j * 0.15), rr = stemLeaf.len * .55;
      masses.push({x:Math.cos(a)*rad-Math.sin(tilt)*y,
        y:Math.cos(tilt)*y, z:Math.sin(a)*rad, r:rr, core:0,
        area:4*Math.PI*rr*rr, shade:.9});
    }
  }
  return { parts: out, masses };
}

/**
 * The flowers a meadow annual holds above its own foliage.
 *
 * An Eschscholzia on its own is nothing; a hundred of them are the reason people
 * sow them. So this stays deliberately sparse — but sparse in FLOWERS. The
 * cushion of dissected leaves under them is built by the caller from
 * shrubMasses, because every other leaf-clad form gets its cards from the one
 * shell at the end of buildPlant and a second private shell here is how this
 * file ends up with two of everything.
 */
function meadowTuft(h, spread, r, blooms, kind) {
  const out = [];
  // Two to five flowers is too few. data/refphotos/layia_platyglossa.jpg shows
  // a solid yellow carpet with no ground visible; nemophila_menziesii.jpg
  // shows a blue drift. A poppy opens one cup at a time on each stem, but the
  // named plant is a clump of a dozen stems.
  //
  // Scale count with footprint: a 0.2 m goldfield gets 9, a 0.6 m lupine 26.
  const n = Math.round(THREE.MathUtils.clamp(6 + spread * 34, 8, 40));
  const wide = THREE.MathUtils.clamp(spread * 0.15, 0.020, 0.050);
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2, rad = Math.sqrt(r()) * spread * 0.44;
    // ONE HEIGHT IS A TABLE. A narrow 0.82-1.08 height band makes forty flowers
    // a flat plate over bare stems. Meadow photographs show flowers at every
    // height between foliage and tallest bud: they open over weeks while the
    // stems keep growing.
    const len = h * (0.52 + r() * 0.56);
    const { stem, heads } = bloomStem(kind, len, wide, r);
    const tilt = (r() - 0.5) * 0.34;
    const place = (g) => {
      g.rotateZ(tilt);
      g.translate(Math.cos(a) * rad, 0, Math.sin(a) * rad);
    };
    place(stem); out.push(stem);
    for (const g of heads) { place(g); (blooms ?? out).push(g); }
  }
  return out;
}

/**
 * HOW BIG ONE BLOOM FLORET IS in the preview build, in metres of RADIUS.
 *
 * A preview with 129 spheres of 6 mm radius puts 12 mm opaque balls on
 * Westringia. Its flowers are FLAT five-lobed discs about 10 mm across
 * (9.7 mm in the detailed model), so it needs the fine-floret set.
 * "Westringia fruticosa" contains no "rosemary"; only its COMMON name does.
 *
 * Match BOTH names. Export the function so tests can measure the returned
 * size directly instead of scanning for a regex inside the builder.
 */
export function floretRadius(plant) {
  return /rosmarinus|rosemary|coleonema|westringia/i
    .test(`${plant?.species ?? ""} ${plant?.common ?? ""}`) ? .003 : .006;
}

/**
 * THE ONE LIST OF SPECIES BUILDERS, most specific first: the library's (species.js, in its
 * order), then the app's generic botanical model. Full detail draws what it returns; Fast draws
 * the reduction the builder requests. Separate lists risk generic previews for species with
 * their own models. `specimen`: one plant seen close (compare.html); `preview`: built to be reduced
 * for Fast. Returns { model, reduce }, or null.
 */
function speciesModel(plant, r, foliageTint, individual, { specimen = false, preview = false } = {}) {
  for (const b of SPECIES) {
    const model = b.build(plant, r, foliageTint, individual, { specimen });
    if (model) return { model, reduce: b.reduce };
  }
  const model = botanicalModel(plant, r, preview ? { preview: true } : undefined);
  return model && { model, reduce: "stand-ins" };
}

/**
 * WHETHER PLANT CODE DRAWS THIS PLANT, without building it. A 2 m+ plant routes to a model file
 * unless a builder claims it. Check before loading: Dr. Hurd's builder makes manzanita.glb
 * (12.8 MB decoded) unnecessary, and Ray Hartman's makes ceanothus.glb unnecessary.
 * Ask the builders themselves through ONE list. Each tests the species first and returns null
 * for plants it does not draw; a claiming builder stops here on its first random-stream access.
 */
const CLAIMED = Symbol("claimed");
const CLAIMS = new Map();
export function drawnByCode(plant) {
  const { id, position, ...kind } = plant ?? {};
  const key = stableJson(kind);
  if (!CLAIMS.has(key)) {
    let claimed;
    try { claimed = !!speciesModel(plant, () => { throw CLAIMED; }, null, 1); }
    catch (e) { claimed = true; }        // it began to build: it is this builder's plant
    if (CLAIMS.size > 2000) CLAIMS.clear();
    CLAIMS.set(key, claimed);
  }
  return CLAIMS.get(key);
}

/** Which builder made a plant: each marks itself with a `<name>Model` flag. */
export function builderName(g) {
  return Object.keys(g?.userData ?? {}).find(k => /Model$/.test(k) && g.userData[k]) ?? null;
}

function fastBotanical(plant, r, foliageTint, individual) {
  // THE SAME BUILDER AS FULL DETAIL, reduced — which reduction depends on the builder:
  // - shoot plants: leaves on leaf-cluster cards — per-leaf stand-ins make
  //   Berggarten's cupped leaves thin dark strips;
  // - builders of few or cheap parts: each part a stand-in where the builder put it;
  // - the photoreal builders (a Ceanothus is 5.1 M florets): reduceBuilt.
  // If none claims it, Fast follows full detail to a model file or generic shape. An extra
  // preview shoot model could claim plants full detail does not draw, and its random draws
  // would turn a library tree away from its full-detail orientation.
  const chosen = speciesModel(plant, r, foliageTint, individual, { preview: true });
  if (!chosen) return null;
  const full = chosen.model;
  // THE FIT IS THE PLANT'S, decided on the full model: Cistus's reduced cards measure 4% wider,
  // crossing FIT_TOLERANCE and squeezing Fast alone 11% narrower if fit uses the reduction.
  const fullSpread = drawnSpread(full);
  // builders of few or cheap parts draw each as a stand-in — the builder says so
  const built = chosen.reduce === "stand-ins" ? previewPrototypes(full) : reduceBuilt(full, plant.mature_spread_m);
  if (built) built.userData.drawnSpread = fullSpread;
  return built ?? full;
}

// FAST IS GENERATED ONCE PER KIND OF PLANT, IN A FEW INDIVIDUALS. Generation costs 3.8 s of a
// 4.4 s page load and depends only on plant fields other than id and position. Generate each
// kind as FAST_VARIANTS individuals from separate seeds and keep them for the session and
// in the browser (plant_store.js). Each plant uses one, rotated and, for half, mirrored.
// Real plants differ: sixteen rotated copies of one plant still look like clones.
// Full detail generates every plant from its own id.
export const FAST_VARIANTS = 3;

function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().filter(k => v[k] !== undefined)
    .map(k => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
// which individual a plant is, how it is turned and whether mirrored: a function of its id alone
const idHash = id => { const r = rngFrom(`individual|${id ?? ""}`); return [r(), r(), r()]; };

/** Which kept Fast model a plant is drawn as: its kind, and which of that kind's individuals. */
export function fastModelKey(plant) {
  const { id, position, ...kind } = plant ?? {};
  return `${stableJson(kind)}#${Math.floor(idHash(id)[0] * FAST_VARIANTS)}`;
}

/**
 * One plant from its kind's kept model: geometry and instance arrays SHARED, materials its OWN.
 * Copying instance matrices costs 153 MB across the measured design without changing geometry.
 * Shared materials let another copy undo the selected plant's highlight, so selection needs
 * separate materials.
 */
function individualOf(master, plant) {
  const [, turn, mirror] = idHash(plant.id);
  const own = new Map();
  const mine = m => {
    if (!m) return m;
    let c = own.get(m);
    if (!c) {
      c = m.clone();
      if (m.userData?.translucency) translucent(c, m.userData.translucency);
      own.set(m, c);
    }
    return c;
  };
  const copy = o => {
    let c;
    if (o.isInstancedMesh) {
      c = new THREE.InstancedMesh(o.geometry, null, 0);
      THREE.Mesh.prototype.copy.call(c, o, false);
      c.instanceMatrix = o.instanceMatrix;
      c.instanceColor = o.instanceColor;
      c.count = o.count;
      c.boundingSphere = o.boundingSphere;
      c.boundingBox = o.boundingBox;
    } else c = o.clone(false);
    if (o.isMesh) {
      c.material = Array.isArray(o.material) ? o.material.map(mine) : mine(o.material);
      // A copy needs the depth material so leaf-card shadows follow the mask instead of a solid quad.
      c.customDepthMaterial = o.customDepthMaterial;
      c.customDistanceMaterial = o.customDistanceMaterial;
    }
    for (const k of o.children) c.add(copy(k));
    return c;
  };
  const g = copy(master);
  g.rotation.y = turn * Math.PI * 2;
  if (mirror < 0.5) g.scale.x *= -1;
  return g;
}

function fastPlant(plant) {
  const key = fastModelKey(plant);
  let master = keptModel(key);
  if (master === undefined) {
    // generated from the KIND's seed, not this plant's: every plant drawn as this individual is
    // the same one, whichever of them was built first and in whatever design
    master = buildPlantUnfitted({ ...plant, id: key }, { quality: "fast", generate: true }) ?? null;
    if (master) {
      master.userData.drawnSpread ??= drawnSpread(master);
      // Not "...Model": builderName() treats any such key as the builder. A "fastModel" key
      // misidentifies generic plants and makes 61 catalogue species appear different in Fast.
      master.userData.fastIndividual = key.slice(key.lastIndexOf("#") + 1);
    }
    keepModel(key, master, texturesReady("fast"));
  }
  return master && individualOf(master, plant);
}

/**
 * How wide a built plant is DRAWN: twice its farthest foliage from the stem, sampled — the
 * measure that does not change as the plant is turned (an axis-aligned box of a turned plant
 * overstates it). Flowers, seed heads and the shadow are not the plant's spread.
 */
/** A part's vertices that can be its farthest after any turn: all of a small part, or the farthest in 26 directions. */
const EXTREMES = new WeakMap();
function extremeVertices(geo) {
  let out = EXTREMES.get(geo);
  if (out) return out;
  const p = geo.attributes.position;
  if (p.count <= 512) out = Array.from({ length: p.count }, (_, i) => i);
  else {
    const set = new Set();
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dy && !dz) continue;
      let best = -Infinity, at = 0;
      for (let i = 0; i < p.count; i++) { const d = p.getX(i) * dx + p.getY(i) * dy + p.getZ(i) * dz; if (d > best) { best = d; at = i; } }
      set.add(at);
    }
    out = [...set];
  }
  EXTREMES.set(geo, out);
  return out;
}

export function drawnSpread(g) {
  g.updateWorldMatrix(true, true);
  // in WORLD units about the plant's own position: measured in the group's own frame, its
  // scale divides out and a squeezed plant reads unsqueezed
  const at = new THREE.Vector3().setFromMatrixPosition(g.matrixWorld);
  const m = new THREE.Matrix4(), w = new THREE.Matrix4();
  let r2 = 0;
  g.traverse(o => {
    if (!o.isMesh || o.name === "shadow" || /bloom|flower|spike|stalk|culm|seed|calyces|umbel/i.test(o.name)) return;
    const pos = o.geometry.attributes.position, n = o.isInstancedMesh ? o.count : 1;
    // THE VERTICES THAT CAN BE FARTHEST, not a sample: 24 vertices of a merged mesh measure
    // manzanita's Fast cards 14% narrow and Margarita BOP at 0.589 m instead of 0.649 m.
    // Sampling 24 per part misses blade tips and measures Evergold 6% narrow. Check every
    // merged-mesh vertex; each repeated part supplies its farthest vertex in 26 directions.
    const verts = o.isInstancedMesh ? extremeVertices(o.geometry) : null;
    // THE OUTERMOST 400 INSTANCES: sampling every 543rd of a Ceanothus's 217 k leaves misses
    // edge instances and measures its full model 7% narrower than drawn.
    let which = null;
    if (n > 400) which = outermost(o.instanceMatrix.array, n, 400);
    // Only x and z matter: three matrix rows, squared distances and one square root at the end
    // find the same farthest vertex with a third of the arithmetic. The full calculation costs
    // 0.63 s of a cold load's 3.2 s of species generation.
    const a = pos.array, stride = pos.isInterleavedBufferAttribute ? pos.data.stride : pos.itemSize,
          off = pos.isInterleavedBufferAttribute ? pos.offset : 0, src = pos.isInterleavedBufferAttribute ? pos.data.array : a,
          raw = !pos.normalized;                        // a quantised position reads through getX
    for (const i of which ?? Array.from({ length: n }, (_, k) => k)) {
      if (o.isInstancedMesh) { o.getMatrixAt(i, m); w.multiplyMatrices(o.matrixWorld, m); } else w.copy(o.matrixWorld);
      const e = w.elements;
      const ex = e[12] - at.x, ez = e[14] - at.z;
      const far = k => {
        const j = k * stride + off;
        const x = raw ? src[j] : pos.getX(k), y = raw ? src[j + 1] : pos.getY(k), z = raw ? src[j + 2] : pos.getZ(k);
        const dx = e[0] * x + e[4] * y + e[8] * z + ex, dz = e[2] * x + e[6] * y + e[10] * z + ez;
        const d = dx * dx + dz * dz;
        if (d > r2) r2 = d;
      };
      if (verts) for (const k of verts) far(k);
      else for (let k = 0; k < pos.count; k++) far(k);
    }
  });
  return 2 * Math.sqrt(r2);
}

// A PROCEDURAL PLANT FITS ITS DECLARED SPREAD. The catalogue's mature spread determines
// validator spacing and planting distances; library models scale to it in buildAssetPlant.
// Fixed 27-43 cm blades on a 0.5 m Siskiyou blue fescue draw 76% too wide, and strap plants
// can exceed spread by 27-29%. Past FIT_TOLERANCE, squeeze horizontally to fit, never stretch:
// a slightly small plant is plausible, but an oversized plant overlaps neighbours that the
// numbers say are clear. Measure once per species and size.
export const FIT_TOLERANCE = 1.15;
const FIT_CACHE = new Map();

export function buildPlant(plant, opts = {}) {
  const g = buildPlantUnfitted(plant, opts);
  const want = plant.mature_spread_m;
  if (!g || !want || plant.asset) return g;
  let assetBuilt = false;
  g.traverse(o => { assetBuilt ||= !!o.userData?.assetName; });
  if (assetBuilt) return g;                         // a library model is already scaled to it
  const key = [plant.species, plant.form, plant.mature_height_m, want, opts.quality ?? "detailed",
               g.userData.growthScale ?? "", g.userData.fastIndividual ?? ""].join("|");
  let k = FIT_CACHE.get(key);
  if (k === undefined) {
    const d = (g.userData.drawnSpread ?? drawnSpread(g)) / (g.userData.growthScale ?? 1);
    k = d > want * FIT_TOLERANCE ? want * 1.05 / d : 1;
    if (FIT_CACHE.size > 600) FIT_CACHE.clear();
    FIT_CACHE.set(key, k);
  }
  if (k < 1) {
    // the group itself, so its children stay what the builders made (tests and the picker
    // read them); the name label the viewer hangs on it is a point on the plant's axis,
    // which a horizontal squeeze does not move
    g.scale.x *= k; g.scale.z *= k;
    g.userData.fitToSpread = +k.toFixed(3);
  }
  return g;
}

function buildPlantUnfitted(plant, { quality = 'detailed', specimen = false, generate = false } = {}) {
  // Skip dense construction entirely for the explicitly simplified preview.
  // Master builders and exporters keep their original detailed default.
  const fast = quality === 'fast';
  if (fast && !generate) return fastPlant(plant);
  const form = growthForm(plant);
  // Read before form dispatch because perennialClump and the later bloom block both need it.
  const kind = bloomForm(plant);
  const r = rngFrom(plant.id ?? plant.species ?? "p");
  const h = plant.mature_height_m ?? (form === "mat" ? 0.25 : 1.2);
  const spread = plant.mature_spread_m ?? Math.max(0.4, h * 0.7);

  // Draw the COLOURS before any geometry, from the same seeded stream.
  //
  // Geometry loops call r() per vertex. Drawing colours after them lets a
  // subdivision change shift the stream and silently recolour the garden.
  // Colour draws must stay independent of geometry detail.
  const foliageTint = tint(plant, form, r);
  const woodTint = ramp([0x6b5540, 0x8a7050], r);

  /**
   * How much lighter or darker THIS PLANT is than others of its species.
   *
   * Without individual variation, fifteen sequential Eriogonum ids span only
   * 0.5 RGB units out of 441 on a named ramp and exactly 0.0 on an explicit
   * palette hex. A hex is one colour, and a 25-unit ramp between neighbours
   * is nearly uniform too, so the drift reads flat.
   *
   * It rides in the VERTEX colours, not in material.color, and that is the whole
   * of the design. `foliage: "#7f9280"` is a promise about the SPECIES — it
   * lives one line per species in plant_palette.json — and the material still
   * carries it exactly, so "an explicit hex wins outright" stays literally true
   * and the pinned per-form colours in plants_schema.test.mjs do not move. What
   * varies is this individual's vigour, which is what varies in a real drift.
   *
   * Import instanceTint so procedural plants and library GLBs share one
   * variation band. A wider band makes a drift stop reading as one species.
   *
   * Drawn HERE, after the two ramps, so the ramp draws keep their positions in
   * the seeded stream and no pinned colour moves.
   */
  const individual = instanceTint(r);

  // FAST IS THE SAME PLANT, CHEAPER. Reducing a species' own model preserves
  // its silhouette and size; substituting generic leaf cards over blobs with
  // sphere flowers does not. One such comparison is 9,398 triangles against
  // full detail's 3,546,220, with a different silhouette and size.
  //
  // EVERY SPECIES WITH A BUILDER USES IT IN BOTH MODES. Constructing photoreal
  // geometry is costly — a ceanothus takes 1-2 s — so build once per species
  // and size, then reduce with reduceBuilt. Accurate shared models take
  // priority over generic substitutes. See fastBotanical();
  // tools/preview_agreement.mjs measures agreement.
  const chosen = !plant.asset && (fast ? fastBotanical(plant, r, foliageTint, individual)
    : speciesModel(plant, r, foliageTint, individual, { specimen })?.model);
  const botanical = chosen;
  if (botanical) {
    const shadow = contactShadow(spread);
    if (shadow) botanical.add(shadow);
    return botanical;
  }

  // A MODEL FILE IS THE PLANT IN BOTH MODES, whether a library tree or a species' own model.
  // Fast draws that model reduced with preview_lod.reduceModel, preserving its identity.
  const asset = buildAssetPlant(plant, r);
  if (asset) {
    const sh = contactShadow(spread);
    if (sh) asset.add(sh);
    // A BOUGHT MODEL STILL FLOWERS. The five GLB-routed species — manzanita,
    // ceanothus, toyon, olive and flannel bush — need their declared blossom.
    // Ceanothus supplies spring blue (#5470b8); Fremontodendron a sheet of
    // yellow (#f0b83a). Compare each render with its reference in compare.html:
    // a shelf of equally bare green bushes cannot reveal missing flowers.
    // A model fetched or made for the species already includes its flowers;
    // generic blossom would add an incorrect second set.
    const hex = asset.userData.wholeModel ? null : flowerColour(plant);
    if (hex !== null) {
      const bl = assetBlooms(asset, spread, r, bloomUnit(plant));
      if (bl) {
        bl.material = translucent(new THREE.MeshStandardMaterial({
          color: new THREE.Color(hex), roughness: 0.75, metalness: 0,
          side: THREE.DoubleSide }),
          { ...BLOOM_TRANSLUCENCY, tint: BLOOM_TRANSMIT_TINT });
        bl.name = "bloom";
        asset.add(bl);
      }
    }
    if (fast) reduceModel(asset, spread);
    return asset;
  }

  const grp = new THREE.Group();
  grp.userData.renderQuality = fast ? 'fast' : 'detailed';
  const foliage = [];
  const leaves = [];      // the alpha-masked cards, kept OUT of the solid masses
  const wood = [];
  const blooms = [];

  // What the foliage is MADE OF, sized for this individual. Drawn here rather
  // than inside each branch because the leaf shell and the masses under it have
  // to agree, and because a form that has its own leaves (a blade, a frond)
  // simply never asks for it.
  const leaf = leafOf(plant, spread, h);
  // The height the leaves clothe: a mat is built at 0.55 of its stated height
  // (see shrubMasses below). Pricing at full height costs 9,236 triangles,
  // more than a 2.5 m manzanita, for foliage outside the actual canopy.
  let clotheH = h;
  // Every leaf-clad form collects its masses here and gets ONE shell at the end:
  // a cane with seven canes and a tree with five canopy lumps would otherwise
  // each build their own, and the count would stop being a property of the plant.
  const clothe = [];

  if (form === "rosette") {
    foliage.push(...rosette(h, spread, r));
  } else if (form === "rush") {
    foliage.push(...rushClump(h, spread, r));
  } else if (form === "strap") {
    foliage.push(...strapClump(h, spread, r, blooms, kind,
                               `${plant?.species ?? ""} ${plant?.common ?? ""}`));
  } else if (form === "perennial") {
    const stemLeaf = /agastache|satureja|monardella villosa|penstemon|oenothera|gaura/i.test(plant.species ?? "") ? leaf : null;
    const m = perennialClump(h, spread, r, blooms, kind, stemLeaf);
    foliage.push(...m.parts); clothe.push(...m.masses);
    clotheH = h * 0.45;
  } else if (form === "meadow") {
    // A meadow annual is mostly FOLIAGE. data/refphotos/eschscholzia_californica.jpg
    // shows a dense blue-green cushion of finely dissected leaves with ONE
    // flower on a long stem — about ninety per cent leaf. Sparse flowering
    // means few FLOWERS over that cushion, not bare sticks without foliage.
    const m = shrubMasses(spread, h, r, 0.60, 5, 0, undefined, leaf);
    foliage.push(...m.parts); clothe.push(...m.masses);
    clotheH = h * 0.60;
    foliage.push(...meadowTuft(h, spread, r, blooms, kind));
  } else if (form === "grass") {
    // A BLADE IS A BLADE AT EVERY QUALITY. Fourfold width quarters the
    // coverage-derived count and turns Muhlenbergia's 3 mm haze into a 12 mm
    // tuft. For a site with 65 grasses, Fast measures 1,796 ms / 7.5 M triangles
    // at x4 width and 2,202 ms / 10.2 M at x1, both within the 6,000 ms guard.
    // A reference Fast build measures 5,568 ms.
    // At a saved garden view, the median of 12 frames is 51 ms at x4 and
    // 57 ms at x1: use true blade width to preserve the plant's character.
    foliage.push(...grassClump(h, spread, r, foliageTint, strawFraction(plant), grassBladeWidth(plant)));
    const seedheads = grassInflorescence(plant, r);
    if (seedheads) grp.add(seedheads);
  } else if (form === "mat") {
    // A MAT keeps its cores whatever its leaves are like: a groundcover without
    // solid mass is 2-triangle confetti because at 0.15 m it has no depth for a
    // shell. Thyme is a dense carpet; wiry-shrub grain belongs to MOUND only.
    // COUNT WITH AREA. Twelve masses give a 0.5 m thyme and a 2.5 m dwarf coyote
    // brush the same number of lumps, yet height caps prevent those lumps
    // growing to close gaps. Footprint coverage is then 48-61%, against 86-96%
    // for shrubs. A groundcover must be a continuous CARPET, so count follows
    // spread SQUARED.
    // Derive count GEOMETRICALLY: shrubMasses bounds `s` by the short axis,
    // otherwise 0.1 m blobs make a 0.1 m thyme 2.5x too tall. Its lumps stay
    // about 5 cm across regardless of spread; closing a 0.5 m carpet requires
    // footprint area divided by mass area, not a size-linear count.
    const lump = Math.max(0.03, h * 0.55 * 0.9);
    const m = shrubMasses(spread, h, r, 0.55, Math.round(THREE.MathUtils.clamp(
      1.5 * (spread * 0.5) ** 2 / (lump * lump), 12, 34)), 0, undefined, leaf);
    foliage.push(...m.parts); clothe.push(...m.masses);
    clotheH = h * 0.55;
  } else if (form === "mound") {
    // Count scales with size: a 0.6 m santolina and a 3.5 m ceanothus need
    // different mass counts. Leaves carry the silhouette; masses supply volume.
    // Subdividing twenty-six masses at detail 2 pays twice for the same edge.
    // The lift is what lets the stems show — see shrubStems.
    const m = shrubMasses(spread, h, r, 1.0,
      Math.round(THREE.MathUtils.clamp(7 + spread * 2.6, 7, 16)), h * 0.06,
      massGrain(plant), leaf);
    foliage.push(...m.parts); clothe.push(...m.masses);
    wood.push(...shrubStems(h, spread, r, massGrain(plant)));
  } else if (form === "column") {
    const g = new THREE.CylinderGeometry(spread * 0.16, spread * 0.42, h * 0.94, 9, 4);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const k = 1 + (r() - 0.5) * 0.13;
      p.setXYZ(i, p.getX(i) * k, p.getY(i), p.getZ(i) * k);
    }
    g.computeVertexNormals();
    g.translate(0, h * 0.5, 0);
    foliage.push(g);
    // a cypress is a cone of scale foliage, not a cone. Stations up the axis,
    // narrowing the way the cone does, give the shell something to sit on.
    for (let i = 0; i < 9; i++) {
      const t = (i + 0.5) / 9;
      clothe.push({ x: 0, y: h * 0.94 * t, z: 0,
                    r: spread * (0.42 - 0.26 * t), shade: 0.72 + 0.4 * t });
    }
  } else if (form === "cane") {
    for (let i = 0; i < 7 + Math.floor(r() * 6); i++) {
      const ch = h * (0.6 + r() * 0.45), lean = (r() - 0.5) * 0.5;
      const c = woodyTrunk(ch, spread * 0.022, lean, r);
      c.translate((r() - 0.5) * spread * 0.5, 0, (r() - 0.5) * spread * 0.5);
      wood.push(c);
      const m = canopyMasses((r() - 0.5) * spread * 0.5, ch * 0.85,
        (r() - 0.5) * spread * 0.5, spread * 0.5, ch, 2, r, 0.8);
      foliage.push(...m.parts); clothe.push(...m.masses);
    }
  } else if (form === "palm") {
    const th = h * 0.66;
    wood.push(woodyTrunk(th, Math.max(0.06, spread * 0.07), (r() - 0.5) * 0.25, r));
    const n = 9 + Math.floor(r() * 5);
    for (let i = 0; i < n; i++) {
      const g = blade(spread * 0.62, spread * 0.15, 0.8 + r() * 0.4, 6);
      g.rotateX(-(1.05 + r() * 0.4));
      g.rotateY((i / n) * Math.PI * 2 + r() * 0.25);
      g.translate(0, th, 0);
      foliage.push(g);
    }
  } else if (form === "vine") {
    for (let i = 0; i < 6; i++) {
      const s = spread * (0.2 + r() * 0.16);
      const g = new THREE.IcosahedronGeometry(s, 1);
      g.scale(1, 0.6, 0.45);
      const x = (r() - 0.5) * spread * 0.8, y = h * (0.25 + r() * 0.7),
            z = (r() - 0.5) * spread * 0.3;
      g.translate(x, y, z);
      foliage.push(shade(g, 0.8));
      clothe.push({ x, y, z, r: s * 0.7, shade: 0.8 });
    }
  } else {                                            // tree
    const th = h * (0.34 + r() * 0.12);
    const lean = (r() - 0.5) * 0.34;
    wood.push(woodyTrunk(th, Math.max(0.05, h * 0.045), lean, r));
    for (let i = 0; i < 3; i++) {                     // a few visible limbs
      const b = woodyTrunk(th * 0.55, h * 0.022, (r() - 0.5) * 1.4, r);
      b.rotateZ((r() - 0.5) * 1.2);
      b.rotateY(r() * Math.PI * 2);
      b.translate(lean * th * 0.35, th * 0.82, 0);
      wood.push(b);
    }
    const m = canopyMasses(lean * th * 0.5, th + (h - th) * 0.45, 0,
      spread, h - th, 5, r, 0.66);
    foliage.push(...m.parts); clothe.push(...m.masses);
  }

  // the leaves, over whatever masses this form put up
  if (clothe.length) {
    // The canopy this plant is meant to fill, from the masses' own extent rather
    // than from the declared size — a mat is wide and flat and a mound is not, and
    // the declared box includes flower stalks that carry no leaves.
    let lo = Infinity, hi = -Infinity, wx = Infinity, wX = -Infinity, wz = Infinity, wZ = -Infinity;
    for (const m of clothe) {
      const rr = m.core ?? m.r;
      lo = Math.min(lo, m.y - rr); hi = Math.max(hi, m.y + rr);
      wx = Math.min(wx, m.x - rr); wX = Math.max(wX, m.x + rr);
      wz = Math.min(wz, m.z - rr); wZ = Math.max(wZ, m.z + rr);
    }
    const envelope = Number.isFinite(lo)
      ? ellipsoidArea((wX - wx) / 2, (hi - lo) / 2, (wZ - wz) / 2) : 0;
    // Explicit preview LOD only: masters keep every botanically sized organ.
    const leafCount = leafCountFor(clothe, leaf, envelope, leafClass(plant));
    // KEEP LEAF AREA IN FAST. A 1,500-leaf cap without resizing saves 92 ms and
    // 1.2 M triangles out of ~1,900 ms and ~11 M, but visibly thins large shrubs.
    // A thyme requiring 13,000 leaves has 44% less cover and is 28% darker
    // close up at 1,500 true-size leaves, exposing its cores.
    // Merged leaves cannot be thinned by distance levels (plant_lod.js), and
    // 29 uncapped thymes cost ~5 ms a frame. Use fewer, proportionally larger
    // leaves to keep full-detail cover and colour with coarser grain.
    // The store pays generation cost once, so allow 4,000 leaves (~8 k
    // triangles): the same thymes cost ~1 ms a frame.
    const shown = fast ? Math.min(4000, leafCount) : leafCount;
    // ITS OWN RANDOM STREAM, seeded by one plant-stream draw: Fast uses fewer
    // leaf draws. Sharing the plant stream shifts later flowers, making gaura
    // 7% narrow and lavender's flowers 9% narrow.
    const shell = leafShell(clothe, leaf, rngFrom(`shell|${r()}`), shown, leafClass(plant),
                            Math.sqrt(leafCount / Math.max(1, shown)));
    if (shell) leaves.push(shell);
  }

  // A flowering subshrub or groundcover — a salvia, a rockrose, a thyme carpet —
  // reads as colour laid OVER the mass rather than as heads on stems. Only when
  // the plant declares a flower: see flowerColour().
  const bloomHex = flowerColour(plant);
  if (bloomHex !== null && (form === "mound" || form === "mat")) {
    // MANY small heads make a haze over foliage. Six large heads look like
    // yellow marbles on a bush; use more, smaller pieces of solid geometry.
    if (kind === "haze") {
      const n = Math.round(THREE.MathUtils.clamp(30 + spread * 55, 30, 150));
      const cards = leaves.find(g => g?.attributes?.position)?.attributes.position;
      for (let i = 0; i < n; i++) {
        const a = r() * Math.PI * 2, rad = Math.sqrt(r()) * spread * 0.48;
        // BOTANICAL, not proportional: a subshrub's florets are millimetres.
        // Scaling to the plant gives a 2.5 m Baccharis 13 cm flowers that look
        // like cream blocks. Many small florets make the bloom visible.
        // Match COMMON and botanical names for the small-floret set:
        // "Westringia fruticosa" has no "rosemary", but Coast Rosemary does.
        // It belongs with rosemary and coleonema. Using 129 spheres at 12 mm
        // gives 4,644 bloom triangles that look too heavy: a Westringia flower
        // is FLAT and five-lobed, about 10 mm across (9.7 mm in full detail).
        // ASSET_FIDELITY.md explains why shape matters as much as size.
        const g = new THREE.SphereGeometry(floretRadius(plant), 6, 4);
        g.scale(1, 0.7, 1);
        // Independent height and radius can place florets at the full extent
        // of both, outside a domed canopy. A height limit of h * 1.05 is above
        // the plant itself; a third of rosemary bloom can float beside it.
        // The aggregate bloom box still fits inside the foliage box, so check
        // the LOCAL canopy radius at each height.
        const t = 0.55 + r() * 0.43;                   // how far up, 0..1 of h
        const dome = Math.sqrt(Math.max(0, 1 - ((t - 0.5) / 0.5) ** 2));
        if (cards?.count >= 6) {
          const q = Math.floor(r() * (cards.count / 6)) * 6;
          g.translate((cards.getX(q)+cards.getX(q+1))/2,
                      (cards.getY(q)+cards.getY(q+1))/2,
                      (cards.getZ(q)+cards.getZ(q+1))/2);
        } else g.translate(Math.cos(a) * rad * Math.max(dome, 0.22), h * t,
                           Math.sin(a) * rad * Math.max(dome, 0.22));
        blooms.push(g);
      }
    } else {
      // Held ABOVE the foliage on their own stems, which is where every reference
      // photo puts them and is why a salvia in flower has a silhouette at all.
      // Buckwheat's reference shows dozens of 5-8 cm umbels covering the plant;
      // fourteen is too few even at the correct botanical head size.
      const n = Math.round(THREE.MathUtils.clamp(22 + spread * 40, 22, 120));
      // A flower head has a BOTANICAL size. At spread * 0.075 a 2.5 m Baccharis
      // gets 10 cm beads that read as blueberries on sticks; a salvia whorl
      // is 2-4 cm across regardless of plant size.
      const wide = THREE.MathUtils.clamp(spread * 0.05, 0.016, 0.042);
      for (let i = 0; i < n; i++) {
        const a = r() * Math.PI * 2, rad = Math.sqrt(r()) * spread * 0.40;
        // bloomStem() returns stems separately into `foliage`, keeping them
        // green rather than the cream of the bloom material. They can extend
        // above the canopy without looking like bare cream wires.
        // Length depends on inflorescence: Lavandula holds spikes 20-30 cm
        // over a 40 cm mound; Eriogonum umbels sit barely above the foliage,
        // as data/refphotos/eriogonum_fasciculatum.jpg shows.
        const len = h * (kind === "spike" ? 0.26 + r() * 0.20
                       : kind === "whorl" ? 0.28 + r() * 0.25
                       : kind === "daisy" ? 0.12 + r() * 0.10
                       :                    0.09 + r() * 0.10);
        const { stem, heads } = bloomStem(kind, len, wide, r);
        // the base sits INSIDE the canopy, so the stalk is mostly hidden and only
        // the head shows
        // One transform for the stem AND all its florets. Drawing a new random
        // transform per part detaches every flower from the stem supporting it.
        const tilt = (r() - 0.5) * 0.30, y = h * (0.52 + r() * 0.22);
        const place = (g) => {
          g.rotateZ(tilt);
          g.translate(Math.cos(a) * rad, y, Math.sin(a) * rad);
        };
        place(stem); foliage.push(stem);              // GREEN, like a stalk
        for (const g of heads) { place(g); blooms.push(g); }
      }
    }
  }

  /**
   * Merge one set of parts into a named mesh.
   *
   * Names let callers distinguish foliage, wood, bloom and shadow without
   * guessing from material colour. Exclude contact shadows from plant height
   * and facet measurements; identify wood to check stems under foliage.
   * tests/js/plant_fidelity.test.mjs holds these names.
   *
   * mergeGeometries REFUSES a mix of indexed and non-indexed geometry: it logs
   * and returns null, which here would be a plant that silently does not draw.
   * A cylinder is indexed and a leaf shell is not. Normalise here at the shared
   * merge point rather than in each of the thirteen forms.
   */
  const push = (parts, mat, name, vigour = 1) => {
    if (!parts.length) return;
    for (const g of parts) if (!g.attributes.color) shade(g, 1);
    const flat = parts.map(g => (g.index ? g.toNonIndexed() : g));
    const merged = mergeGeometries(flat, false);
    for (const g of flat) g.dispose();
    for (const g of parts) g.dispose();
    if (!merged) return;
    if (vigour !== 1) {
      const c = merged.attributes.color;
      for (let i = 0; i < c.array.length; i++) c.array[i] *= vigour;
    }
    const mesh = new THREE.Mesh(merged, mat);
    mesh.name = name;
    grp.add(mesh);
  };
  // Split the cards out of whatever the form builders returned, so the mask only
  // ever reaches CARDS. Merging them with the solid masses and masking the lot
  // would cut leaf-shaped holes through the core, because an icosahedron's UVs
  // are spherical and would sample the mask arbitrarily.
  for (let i = foliage.length - 1; i >= 0; i--) {
    if (foliage[i]?.userData?.leafShell) leaves.push(foliage.splice(i, 1)[0]);
  }
  const plain = {
    color: foliageTint, roughness: 0.86, metalness: 0, vertexColors: true,
    side: THREE.DoubleSide, flatShading: form === "rosette" || form === "grass",
  };
  // How much sun comes THROUGH this plant's leaves — a physical property of the
  // leaf, so it is read off the same class that decides the leaf's shape. A
  // rosemary needle is waxy and nearly opaque; a big thin blade is stained glass.
  const cls = leafClass(plant);
  const trans = translucencyFor(cls);
  push(foliage, translucent(new THREE.MeshStandardMaterial(plain), trans),
       "foliage", individual);

  // alphaTest rather than blending: a shrub is thousands of overlapping cards and
  // sorting them every frame is what makes a foliage-heavy scene crawl, while an
  // alpha TEST needs no sorting at all.
  const leafMask = leafTexture(cls);
  // The cut is derived from THIS mask's own coverage, not fixed at 0.45. A mask
  // whose mean alpha is 0.07 cannot survive a 0.45 cut once mipping averages a
  // small card toward that mean, and the card vanishes entirely rather than
  // fading — alpha TEST has no in-between. Roughly half the mask's own mean keeps
  // the leaf's shape (the faint half of the shape is what gets cut) while leaving
  // a fine-leaved plant with leaves at all. Clamped at the bottom so a mask that
  // failed to measure cannot turn every card into an opaque square.
  const cover = leafMask?.userData?.coverage;
  const cut = Number.isFinite(cover)
    ? THREE.MathUtils.clamp(cover * 0.45, 0.03, 0.30)
    : 0.20;
  push(leaves, translucent(new THREE.MeshStandardMaterial(
    leafMask ? { ...plain, alphaMap: leafMask, alphaTest: cut } : plain), trans),
    "foliage", individual);
  // Wood gets NONE: a branch is not thin, and a glowing stem would undo the cue.
  push(wood, new THREE.MeshStandardMaterial({
    color: woodTint, roughness: 1, vertexColors: true }), "wood");
  const bloomTrans = { ...BLOOM_TRANSLUCENCY, tint: BLOOM_TRANSMIT_TINT };
  if (bloomHex !== null) {
    push(blooms, translucent(new THREE.MeshStandardMaterial({
      color: new THREE.Color(["hot_lips", "bracted_whorl"].includes(kind) ? 0xffffff : bloomHex), roughness: 0.75, metalness: 0,
      side: THREE.DoubleSide, vertexColors: true }), bloomTrans), "bloom");
  } else {
    // Nothing declared: the heads stay leaf-coloured.
    push(blooms, translucent(new THREE.MeshStandardMaterial({
      color: foliageTint, roughness: 0.92, metalness: 0,
      side: THREE.DoubleSide, vertexColors: true }), bloomTrans), "bloom");
  }

  const shadow = contactShadow(spread);
  if (shadow) grp.add(shadow);
  return grp;
}
