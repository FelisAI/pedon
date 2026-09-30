// Does Fast preview draw the SAME plant as full detail?
//
// A designer works in Fast, so a site must not look different in full detail: Fast is
// meant to be a cheaper level of the same builder, never the generic form shape. This
// builds each species in a design once at each quality and reports which BUILDER
// drew it and how big it came out, so a mismatch is a measured row, not a guess.
//
//     node tools/preview_agreement.mjs                 # data/design.json
//     node tools/preview_agreement.mjs data/designs/variant_a.json --json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "../viewer/node_modules/three/build/three.module.js";
import { resolvePath } from "../viewer/project_paths.js";

globalThis.document ??= { createElement() { return { width: 1, height: 1, getContext: () =>
  new Proxy({ measureText: () => ({ width: 12 }) }, { get: (o, k) => o[k] ??
    (String(k).startsWith("create") ? () => ({ addColorStop() {} }) : () => {}) }) }; } };

const { buildPlant, fastModelKey } = await import("../viewer/src/plants.js");
const { MANIFEST_URL, registerAsset } = await import("../viewer/src/assets.js");

// THE LIBRARY MODELS, SO THE ROUTE IS THE VIEWER'S. Full detail draws a plant of 2 m or
// more that no builder claims from a stock library model — and Node cannot open one (a Draco
// GLB needs WebGL), so without this it would report "generic both ways" for a toyon, an olive
// or a 'Dr. Hurd' while the viewer draws a stock tree in one mode and a blob in the other. A box of
// each built model's recorded size stands in for it, as plants_base.test.mjs does, and the
// viewer's own routing and scaling run on it.
{
  const file = resolvePath(MANIFEST_URL);             // the user's library's, like every model
  const manifest = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  for (const [name, m] of Object.entries(manifest)) {
    if (!fs.existsSync(resolvePath(m.file))) continue;        // the viewer could not load it either
    const box = new THREE.Mesh(new THREE.BoxGeometry(m.spread_m, m.height_m, m.spread_m));
    box.position.y = m.height_m / 2;
    const proto = new THREE.Group(); proto.add(box);
    registerAsset(name, proto, m);
  }
}

/** Which builder drew it: the builders mark themselves with a `<name>Model` flag. */
export function builderOf(g) {
  const keys = Object.keys(g.userData ?? {}).filter(k => /Model$/.test(k) && g.userData[k]);
  if (keys[0]) return keys[0];
  let stock = null;
  g.traverse(o => { stock ??= o.userData?.assetName ?? null; });
  return stock ? `stock:${stock}` : "generic";
}

function measure(g) {
  // the PLANT's size, not which way it faces: Fast turns each copy of a species about
  // its own axis, and a turned square has a wider axis-aligned box
  g.rotation.set(0, 0, 0);
  g.updateWorldMatrix(true, true);
  const b = new THREE.Box3();
  let tris = 0;
  g.traverse(o => {
    if (!o.isMesh || o.name === "shadow") return;
    b.union(new THREE.Box3().setFromObject(o));
    tris += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3 * (o.isInstancedMesh ? o.count : 1);
  });
  const s = b.getSize(new THREE.Vector3());
  // to the millimetre: rounded to the centimetre, an 18 cm echeveria reads 6% short from
  // rounding alone (0.1764 m against 0.1749)
  return { h: +s.y.toFixed(3), w: +Math.max(s.x, s.z).toFixed(3), tris: Math.round(tris) };
}

export function agreement(design) {
  const bySpecies = new Map();
  for (const p of design.plants ?? []) {
    const k = `${p.species}|${p.form ?? ""}`;
    if (!bySpecies.has(k)) bySpecies.set(k, { plant: p, count: 0 });
    bySpecies.get(k).count++;
  }
  const rows = [];
  for (const { plant, count } of bySpecies.values()) {
    const p = { ...plant, position: [0, 0] };
    // THE SAME INDIVIDUAL in both: Fast draws a plant as one of a few individuals of its kind,
    // each generated from the kind's seed, so full detail is built from that seed too —
    // built from the plant's own id it would compare two different plants of one species, 9% apart.
    // And unturned, as full detail is: a turn changes an axis-aligned box, not the plant.
    const fast = buildPlant(p, { quality: "fast" });
    const full = buildPlant({ ...p, id: fastModelKey(p) }, { quality: "detailed" });
    fast.rotation.set(0, 0, 0);
    const f = measure(fast), d = measure(full);
    rows.push({ species: plant.species, count, fast_builder: builderOf(fast), full_builder: builderOf(full),
                fast: f, full: d,
                h_err: d.h ? +((f.h / d.h - 1) * 100).toFixed(0) : null,
                w_err: d.w ? +((f.w / d.w - 1) * 100).toFixed(0) : null });
  }
  return rows.sort((a, b) => b.count - a.count);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const file = process.argv.slice(2).find(a => !a.startsWith("--")) ?? "data/design.json";
  // data/… is the ACTIVE SITE's: joined to the checkout it would read a design.json that
  // does not live there (a site lives in its own project folder) and crash
  const rows = agreement(JSON.parse(fs.readFileSync(path.isAbsolute(file) ? file : resolvePath(file), "utf8")));
  if (process.argv.includes("--json")) { console.log(JSON.stringify(rows, null, 1)); process.exit(0); }
  let switching = 0, plants = 0;
  for (const r of rows) {
    const same = r.fast_builder === r.full_builder;
    plants += r.count; if (!same) switching += r.count;
    console.log(`${same ? "  " : "≠ "}${String(r.count).padStart(3)} ${r.species.padEnd(42)} ` +
      `${r.fast_builder.padEnd(22)} ${r.full_builder.padEnd(24)} h ${String(r.h_err).padStart(4)}%  w ${String(r.w_err).padStart(4)}%  ` +
      `tris ${r.fast.tris} / ${r.full.tris}`);
  }
  console.log(`\n${switching} of ${plants} plants change builder between Fast and full detail`);
}
