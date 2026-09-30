// Real branching-tree models, loaded once and cloned per plant.
//
// The library is built locally by tools/gen_trees.py (Blender's Sapling
// generator) into assets/plants/*.glb with a manifest. It is small enough
// (~500 KB total) to preload before the first design renders, which is what
// lets buildPlant() stay synchronous: by the time a design is built, either
// the asset is in the cache or it never arrived and we fall back to the
// procedural form in plants.js.
//
// Nothing here is required for the app to work. If the manifest is missing,
// every plant simply renders procedurally.
import * as THREE from "three";
import { getLoader } from "./loader.js";

// exported so a test can read the same file off disk: the routing table naming a
// model the library does not contain is silent — assetName() returns it, the
// cache misses, and every plant matching that regex quietly goes procedural.
export const MANIFEST_URL = "/assets/plants/manifest.json";

// species keyword -> model name. FIRST MATCH WINS, so the order is the whole
// contract: a specific genus must sit above any broader pattern that would
// otherwise swallow it. Cercis before Acer, Pinus pinea before Pinus,
// Prunus ilicifolia before Prunus, Quercus before the generic evergreen.
const ASSET_MATCH = [
  // — most specific first —
  [/pinus\s+pinea|stone pine|umbrella pine|parasol pine/i, "stone_pine"],
  [/arctostaphylos|manzanita/i, "manzanita"],
  [/cercis|redbud/i, "redbud"],
  [/chilopsis|desert[\s-]?willow/i, "desert_willow"],
  [/ficus|\bfig\b/i, "fig"],
  // dense upright evergreen shrub-to-small-tree
  [/heteromeles|toyon|laurus|bay laurel|rhamnus|frangula|coffeeberry|prunus\s+ilicifolia|hollyleaf cherry|pittosporum|myrtus|\bmyrtle\b|umbellularia/i, "toyon"],
  [/quercus|\boak\b/i, "oak"],
  // Ceanothus only reaches here at 3 m+, which is 'Ray Hartman' / 'Snow Flurry'
  // territory — a broad multi-stemmed arching evergreen. The prostrate
  // cultivars are filtered out by MIN_ASSET_HEIGHT_M before this line is read.
  [/ceanothus|california lilac/i, "ceanothus"],
  // — broader genera —
  [/prunus|plum|mume|cherry|malus|apple|pear|pyrus/i, "plum"],
  [/olea|olive/i, "olive"],
  // podocarpus sits here, ABOVE the pine rule, because its common names ("yew
  // pine", "Buddhist pine") match \bpine\b: below it, a 4 m Podocarpus 'Maki'
  // routes to the spreading Japanese black pine model while plants.js has
  // already classified it as a column. The asset wins over the growth form, so
  // that disagreement is visible only in the yard.
  [/cupressus|italian cypress|juniperus|thuja|calocedrus|sequoia|podocarpus/i, "cypress"],
  [/pinus|\bpine\b|cedrus|picea|abies/i, "pine"],
  [/acer|maple|lagerstroemia|crape myrtle/i, "maple"],
  [/citrus|lemon|orange|lime|mandarin|kumquat|arbutus|jacaranda|magnolia|aesculus|buckeye/i, "citrus"],
];

// A genus match is not enough on its own: Ceanothus runs from a 5 m tree
// ('Ray Hartman') to a 0.9 m prostrate carpet ('Yankee Point'), and Arctostaphylos
// from a 6 m 'Dr. Hurd' to a 20 cm 'Emerald Carpet'. Handing a knee-high cultivar
// a full branching-tree model is worse than having no model at all, so the size
// class decides first and the genus only decides which model.
//
// 2.0, not 3.0, and that metre is MEASURED rather than argued.
// At 3.0 a 2.5 m Arctostaphylos is refused the manzanita GLB that exists and
// that, rendered side by side at 2.5 m, is a gnarled red multi-trunk against the
// procedural version's dark balls on straight sticks. Every route the metre from
// 3.0 to 2.0 admits is genus-true: Arctostaphylos ->
// manzanita, Olea 'Montra'/'Little Ollie' -> olive, Ceanothus 'Concha' ->
// ceanothus, Frangula/Rhamnus 'Eve Case' -> toyon (all four are Californian
// broadleaf evergreens of the same silhouette family).
//
// It does NOT go lower, and that is the same measurement. At 0.5 m the comparison
// inverts: Sapling always builds a TRUNK, so a Salvia officinalis rendered from
// sage_open is a miniature tree with a bare stem while the procedural one is the
// broad low mass a subshrub actually is. Below about 2 m the generator is the
// wrong tool, which is why the sub-3 m models in the library are placeable by
// hand and deliberately NOT in FORM_ASSET.
//
// Everything herbaceous is still refused by construction, not by this number:
// ASSET_MATCH names only woody genera and FORM_ASSET maps only tree/column/mound,
// so a 2 m Stipa, Phormium or Fatsia routes to null at any threshold.
export const MIN_ASSET_HEIGHT_M = 2.0;

// ── form: the fallback layer under the species tables ────────────────────────
//
// ASSET_MATCH above and FORMS in plants.js are specific-first and finite; the
// model's botanical vocabulary is not. A species neither table names would
// fall straight to a size heuristic and render as a generic mass, so a
// small species library would not follow a site to another climate.
// A plant may therefore declare a `form` — its habit — and both routers read
// it: species stays the specific layer, form is what catches everything else.
//
// The vocabulary lives HERE rather than in plants.js because plants.js already
// imports this file (MIN_ASSET_HEIGHT_M, for exactly the same reason: the two
// routers have to agree or a plant falls between them). A second copy of this
// map in the other file would drift from this one.
export const PLANT_FORMS = ["rosette", "grass", "column", "tree", "palm", "mat",
                            "mound", "cane", "vine",
                            // a rush, a strap-leaved clump, a herbaceous
                            // perennial and a fall-seeded annual are four
                            // different silhouettes; drawn as one "mound",
                            // massed planting reads as wallpaper
                            "rush", "strap", "perennial", "meadow"];

// What the model will actually write, not just the nine canonical words. FIRST
// MATCH WINS and the order carries real decisions: "spreading groundcover" is a
// mat before it is anything else, and "multi-trunk shrub" is a mound — the big
// arching multi-stem shrub — not a canopy tree, so /shrub/ sits above /tree/.
const FORM_ALIAS = [
  [/ground\s?cover|carpet|creeping|prostrate|trailing|\bmat\b/i, "mat"],
  // before the greedy shrub/perennial words below: a model writing "upright rush"
  // or "strappy clump" means something specific and should get it
  [/\brush\b|reed|sedge-like|equisetum/i, "rush"],
  [/strap|flax|sword|iris-like|linear leaves/i, "strap"],
  [/annual|wildflower|meadow|reseeding|self-?sow/i, "meadow"],
  [/perennial|herbaceous|clump-forming|basal rosette with flower/i, "perennial"],
  [/grass|sedge|tussock|tuft/i, "grass"],
  [/rosette|succulent|agave|spiky/i, "rosette"],
  [/palm|frond/i, "palm"],
  [/cane|bamboo/i, "cane"],
  [/vine|climb|liana/i, "vine"],
  [/column|fastigiate|conical|pencil|narrow upright|spire/i, "column"],
  [/mound|shrub|bush|hedge/i, "mound"],
  [/tree|canopy|multi-?trunk|standard/i, "tree"],
];

/** A declared habit -> one of PLANT_FORMS, or null if it says nothing usable. */
export function normalizeForm(form) {
  if (!form) return null;
  for (const [re, f] of FORM_ALIAS) if (re.test(form)) return f;
  return null;
}

// One representative model per habit, for a species no regex names. Only the
// woody branching forms appear: the library is Sapling output, so a grass, a
// rosette or a palm has no honest model here and stays procedural — a missing
// entry is a decision, not a gap. gen_trees.py declares which habit each model
// was built for and the test holds the two sides together.
export const FORM_ASSET = { tree: "oak", column: "cypress", mound: "ceanothus" };

/**
 * Every model name the routing tables can emit. Not derivable from outside
 * otherwise — ASSET_MATCH is private — so without it nothing could check the
 * tables against the built library, and a model renamed in gen_trees.py would
 * degrade silently.
 */
export const routableAssetNames = () =>
  [...new Set([...ASSET_MATCH.map(([, model]) => model), ...Object.values(FORM_ASSET)])];

/** Model name for a plant, or null if nothing in the library suits it. */
export function assetName(plant) {
  if (plant.asset) return plant.asset;              // explicit wins
  // `declared_height_m` when the caller has scaled the row for display — see
  // buildDesignGroup. The gate must not move with the "Plants at" slider.
  if ((plant.declared_height_m ?? plant.mature_height_m ?? 0) < MIN_ASSET_HEIGHT_M)
    return null;
  const name = `${plant.species ?? ""} ${plant.common ?? ""}`;
  for (const [re, model] of ASSET_MATCH) if (re.test(name)) return model;
  // nothing named it, so fall back on what it says it IS
  return FORM_ASSET[normalizeForm(plant.form)] ?? null;
}

const cache = new Map();      // name -> { proto, base_m, height_m, spread_m }
let loaded = null;            // the in-flight/settled preload promise

/**
 * Put a loaded model in the cache with its size taken from the GEOMETRY.
 *
 * The manifest is a record of what gen_trees.py MEANT to build, and on the
 * shipped library it is wrong about both things that matter. Every model was
 * normalised to 4 m with its base on the origin; measured off the GLBs, the
 * top is pinned at exactly 4.000 and the base runs 0.000 (maple) to 1.044
 * (stone_pine), because Sapling's trunk is a bevel-less curve that converts to
 * a faceless wire — it steers the normalisation and then never reaches the
 * file, leaving the leaf cloud hanging above an origin the trunk had claimed.
 * Trusting it, a plant set on the ground floats by its own base offset (0.258 m
 * for a Heteromeles) and a "6 m" stone pine renders 4.43 m.
 *
 * Measuring instead of trusting fixes both and cannot be lied to: rebuild the
 * library with a real trunk and base is 0 and span is 4 already, so this
 * measures the same numbers and the correction becomes a no-op.
 *
 * Split out of loadPlantLibrary() so it can be driven without a browser: a
 * Draco-compressed GLB needs WebGL to open, but everything deciding where a
 * plant sits is this function plus buildAssetPlant(), and both are pure.
 * tests/js/plants_base.test.mjs drives them with a probe box carrying each real
 * GLB's declared bounds.
 */
export function registerAsset(name, proto, meta = {}) {
  const box = new THREE.Box3().setFromObject(proto);
  const size = box.getSize(new THREE.Vector3());
  // an empty or unmeasurable model falls back to what the manifest claims —
  // being wrong about the size beats refusing to draw the plant at all
  const ok = Number.isFinite(size.y) && size.y > 1e-6;
  const entry = {
    proto,
    // where the geometry starts, in the model's own units. buildAssetPlant()
    // subtracts it AFTER scaling, so it stays a property of the model rather
    // than of any one planting of it.
    base_m: ok ? box.min.y : 0,
    height_m: ok ? size.y : (meta.height_m ?? 4),
    // horizontal is NOT recentred: Sapling puts the trunk base at x=z=0 and the
    // crown is not symmetric about it, so centring the box would slide the
    // whole plant off the point the design placed it on — a visible float
    // traded for an invisible offset.
    spread_m: ok ? Math.max(size.x, size.z) : (meta.spread_m ?? 3),
    // A SPECIES' OWN MODEL: fetched or made for it by asset_store, which is
    // what `source` records. Its flowers are part of it, so it gets no generic blossom. A
    // library TREE says it was "generated" (tools/gen_trees.py) — or, older, says nothing.
    whole: !!meta.source && meta.source.from !== "generated",
  };
  cache.set(name, entry);
  return entry;
}

/** Preload every model in the manifest. Safe to call repeatedly. */
let manifestCache = null;

/** The manifest, fetched once. Cheap — it is what says a model EXISTS.
 *  `fresh` re-reads it; a failed re-read keeps what was already known. */
async function manifestOnce({ fresh = false } = {}) {
  if (manifestCache && !fresh) return manifestCache;
  try {
    const res = await fetch(MANIFEST_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifestCache = await res.json();
  } catch (e) {
    console.info("[assets] no plant library, using procedural plants:", e.message);
    manifestCache ??= {};
  }
  return manifestCache;
}

// Names already looked for in a re-read manifest, so a name the library truly lacks
// costs one request per page, not one per rebuild.
const rechecked = new Set();

/**
 * Load ONLY these models, and only if they are not already cached.
 *
 * The library is dozens of models and megabytes of Draco, and fetching and
 * decoding every one on every page load costs over a second — for a design that
 * uses a handful of them. buildPlant() is
 * synchronous and asks the cache for a model, so the models a design NAMES still
 * have to arrive before it builds; everything else can wait until something
 * actually asks to draw it.
 */
export async function ensureAssets(names) {
  let manifest = await manifestOnce();
  // A MODEL NEWER THAN THIS PAGE. fetch_asset / make_asset add plant models to
  // the manifest while the viewer is open, and a manifest read only once at boot
  // would draw the new model as the generic shape until a reload.
  const unseen = [...new Set(names)].filter(n => n && !manifest[n] && !rechecked.has(n));
  if (unseen.length) {
    unseen.forEach(n => rechecked.add(n));
    manifest = await manifestOnce({ fresh: true });
  }
  const want = [...new Set(names)].filter(n => n && manifest[n] && !cache.has(n));
  if (!want.length) return cache;
  const loader = getLoader();
  await Promise.all(want.map(async (name) => {
    const meta = manifest[name];
    try {
      const gltf = await loader.loadAsync(`/${meta.file}`);
      const proto = gltf.scene;
      proto.traverse(o => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.receiveShadow = true;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) if (m) { m.side = THREE.DoubleSide; m.metalness = 0; }
      });
      registerAsset(name, proto, meta);
    } catch (e) {
      console.warn(`[assets] ${name} failed to load:`, e.message);
    }
  }));
  return cache;
}

/** Every model name the manifest knows, whether or not it is loaded yet. */
export async function catalogNames() { return Object.keys(await manifestOnce()); }

/** The model names a design actually routes to — what must be loaded before it builds. */
export function assetsNeededBy(design) {
  return [...new Set((design?.plants ?? []).map(assetName).filter(Boolean))];
}

// ── OBJECTS THAT ARE A FILE, not a builder ───────────────────────────────────
//
// The owner needs to capture things they have — plants, stones — and add them
// to the assets at their real size, with a scanner they may already own.
//
// Measured: a whole-site capture has a mean vertex spacing of about 5 cm, so a
// 0.4 m stone AS IT APPEARS IN THE SITE SCAN gets a couple of hundred vertices,
// which is a silhouette and no surface. But resolution here is a function of how
// close the camera got and how many frames, not of how big the subject is, so
// the same scanner pointed at one stone from half a metre is a different
// measurement entirely — and the site capture proves the FORMAT works, because
// the viewer already loads it.
//
// The gap is structural: a plant can be a file (`plant.asset` beats the
// species table), and without this an OBJECT cannot — `objectMesh` is
// `BUILDERS[name](h, w, seed)` or a placeholder, full stop, so a scanned stone
// has nowhere to go.
//
// PATH-RESTRICTED, deliberately. This string arrives in a design document, which
// a model writes, and it reaches a loader. `assets/objects/` and nothing else —
// no absolute paths, no `..`, no other directory. A free-text path from a
// document to a fetch is a shape worth refusing even when nothing is trying.
const OBJECT_MODEL_DIR = "assets/objects/";

/** Is this a model path a design is allowed to name? */
export function safeObjectModel(path) {
  const p = String(path ?? "").trim();
  if (!p || !p.startsWith(OBJECT_MODEL_DIR)) return null;
  if (p.includes("..") || p.includes("//") || p.includes("\\")) return null;
  if (!/\.(glb|gltf)$/i.test(p)) return null;
  return p;
}

/** The object models a design names, ready to be awaited before the first build. */
export function objectModelsNeededBy(design) {
  return [...new Set((design?.objects ?? [])
    .map(o => safeObjectModel(o?.model)).filter(Boolean))];
}

/**
 * Load object models by PATH, into the same cache plants use.
 *
 * Keyed by the path itself: there is no manifest for these, because the whole
 * point is that the owner can scan a stone this afternoon and place it — a
 * registry they have to edit first is a step nobody takes.
 */
export async function ensureObjectModels(paths) {
  const want = [...new Set((paths ?? []).map(safeObjectModel).filter(Boolean))]
    .filter(p => !cache.has(p));
  if (!want.length) return cache;
  const loader = getLoader();
  await Promise.all(want.map(async (path) => {
    try {
      const gltf = await loader.loadAsync(`/${path}`);
      const proto = gltf.scene;
      proto.traverse(o => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.receiveShadow = true;
        // NOT DoubleSide, unlike a leaf card: a scanned solid has a real inside
        // and drawing its back faces reads as a hole punched through the front
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) if (m) m.metalness = 0;
      });
      registerAsset(path, proto, {});
    } catch (e) {
      console.warn(`[assets] object model ${path} failed to load:`, e.message);
    }
  }));
  return cache;
}

/** Would `buildAssetObject` draw this object's file right now, rather than a preset? */
export function objectModelReady(obj) {
  const path = safeObjectModel(obj?.model);
  return !path || cache.has(path);
}

/**
 * One instance of a file-backed object, scaled to the size the DESIGN says.
 *
 * The declared `height_m` wins over the model's own, exactly as a plant's
 * `mature_height_m` does — an object is the size it SAYS it is, and a
 * scan's units are whatever the scanner felt like.
 */
export function buildAssetObject(obj) {
  const path = safeObjectModel(obj?.model);
  const entry = path && cache.get(path);
  if (!entry) return null;
  const inst = entry.proto.clone(true);
  inst.traverse(o => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    o.material = Array.isArray(o.material) ? mats.map(m => m?.clone()) : mats[0]?.clone();
  });
  const h = Number(obj?.height_m) > 0 ? Number(obj.height_m) : entry.height_m;
  const k = entry.height_m > 1e-6 ? h / entry.height_m : 1;
  inst.scale.setScalar(k);
  // sit it on its own base, AFTER scaling, so the number is a property of the
  // model rather than of any one placing of it
  inst.position.y = -entry.base_m * k;
  const g = new THREE.Group();
  g.add(inst);
  return g;
}

export function loadPlantLibrary() {
  if (loaded) return loaded;
  loaded = (async () => {
    const manifest = await manifestOnce();
    const loader = getLoader();
    await Promise.all(Object.entries(manifest).map(async ([name, meta]) => {
      try {
        const gltf = await loader.loadAsync(`/${meta.file}`);
        const proto = gltf.scene;
        proto.traverse(o => {
          if (!o.isMesh) return;
          o.castShadow = true;
          o.receiveShadow = true;
          // leaf cards are single quads seen from both sides
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) if (m) { m.side = THREE.DoubleSide; m.metalness = 0; }
        });
        registerAsset(name, proto, meta);
      } catch (e) {
        console.warn(`[assets] ${name} failed to load:`, e.message);
      }
    }));
    console.info(`[assets] plant library: ${cache.size} models`);
    return cache;
  })();
  return loaded;
}

export const libraryNames = () => [...cache.keys()];
export const hasAsset = name => cache.has(name);

/**
 * A scaled, randomly-rotated instance of a library model, or null.
 * Geometry and materials are shared with the prototype — a clone costs a
 * draw call, not a copy of the mesh.
 */
/**
 * How much lighter or darker THIS individual is than its species.
 *
 * A library model carries two flat materials and no per-vertex colour, so without
 * this the only thing separating two manzanitas is their Y rotation — five in a
 * bed read as one silhouette repeated, however well they are massed.
 *
 * The band is deliberately narrow. Real variation between individuals of a
 * species is a shade, not a hue: go wider and the drift stops reading as one
 * species, which is the thing the repetition rule exists to protect.
 */
export const instanceTint = rand => 0.86 + rand() * 0.28;      // 0.86 .. 1.14

/**
 * How much bigger or smaller this individual is. Same reasoning: a plant that is
 * 15% off its species' size is an individual, one that is 40% off is a different
 * plant and makes a drift look like a mistake.
 */
/**
 * How much bigger or smaller this individual is — FOR THE PLACER, not the renderer.
 *
 * Applied at draw time it is a bug (tests/js/plants_base.test.mjs): a ceanothus
 * asked for 6 m renders 5.280 m, which is exactly the 0.88 lower bound. A design
 * DECLARES mature_height_m and the renderer must honour it —
 * a viewer that quietly renders something other than what the file says makes
 * every measurement in the project unfalsifiable.
 *
 * Variation between individuals is real and worth having, but it belongs in the
 * DATA: replant should vary the sizes it writes, and then the number on disk is
 * the number on screen. Exported for that caller.
 */
export const instanceScale = rand => 0.88 + rand() * 0.24;     // 0.88 .. 1.12

export function buildAssetPlant(plant, rand) {
  const name = assetName(plant);
  const entry = name && cache.get(name);
  if (!entry) return null;

  const h = plant.mature_height_m ?? entry.height_m;
  const grp = new THREE.Group();
  const inst = entry.proto.clone(true);

  // Object3D.clone() shares MATERIALS with the prototype. Selection highlighting
  // works by mutating material.emissive, so shared materials make it incoherent:
  // every unselected instance restores the shared material and wipes the
  // selected one's highlight — a selected oak shows no highlight at all. Geometry stays shared (that is the expensive part); materials are
  // cheap, so give each instance its own.
  inst.traverse(o => {
    if (!o.isMesh || !o.material) return;
    o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone();
  });

  const k = h / entry.height_m;
  // Match the design's spread too, but only within a believable range: a real
  // tree that is asked to be half as wide as it grows should read as a
  // narrower specimen, not as a squashed one.
  // The lower bound has to go well below 1: a fastigiate cultivar like
  // Cupressus 'Tiny Tower' is 7.6 m tall by 0.9 m wide (aspect 8.4), and a
  // 0.7 floor would render it half again too fat — the one proportion that
  // actually defines the plant.
  const wantSpread = plant.mature_spread_m;
  const kx = wantSpread
    ? THREE.MathUtils.clamp(wantSpread / (entry.spread_m * k), 0.45, 1.5)
    : 1;
  inst.scale.set(k * kx, k, k * kx);
  // Object3D composes its matrix as T·R·S, so a translation set here is NOT
  // scaled — which is exactly what is wanted only if it is pre-multiplied by
  // the scale by hand. The model's base sits base_m up in its own units, so
  // after scaling by k it sits base_m*k up, and that is what has to come off.
  inst.position.y = -entry.base_m * k;
  inst.rotation.y = rand() * Math.PI * 2;     // no two clones face the same way

  // ...nor are they the same green. The materials were already cloned above for
  // selection highlighting, so this costs nothing extra.
  const tint = instanceTint(rand);
  inst.traverse(o => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material])
      m.color?.multiplyScalar(tint);
  });
  grp.add(inst);
  grp.userData.assetName = name;
  grp.userData.wholeModel = !!entry.whole;
  return grp;
}
