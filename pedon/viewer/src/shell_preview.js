// Mounts the REAL shell against fixture data. See shell.html for why.
//
// Everything here is the shipped component; only the data is invented. If a
// control looks wrong on this page it is wrong in the app.
import { createCommands } from "./shell/commands.js";
import { mountPalette, opensPalette } from "./shell/palette.js";
import { mountTopBar } from "./shell/topbar.js";
import { mountDock } from "./shell/dock.js";
import { mountInspector } from "./shell/inspector.js";
import { mountSidePanel } from "./shell/sidepanel.js";
import { mountContextMenu, contextItemsFor } from "./shell/contextmenu.js";
import { mountToasts } from "./shell/toast.js";
import { mountHud } from "./shell/hud.js";
import { icon } from "./shell/icons.js";
import { SURFACES } from "./shell/surfaces.js";
import { DOCK_TOOLS } from "./shell/docktools.js";
import { polygonArea } from "./areas.js";
import { rowOf, kindPlural } from "./shell/rowtext.js";
import { sortRows, withKindHeadings, ORDERS } from "./shell/treesort.js";
import plantInspector from "./extensions/plant-inspector/ui.js";
import { setUnits, size, pair, parseLen, lenField, lengthUnit } from "./shell/units.js";

// ── REAL DATA, not a flattering fixture ─────────────────────────────────
//
// A fixture of short tidy names and a neat group FLATTERS ITSELF: a real design
// can have zero groups and hundreds of flat rows, with labels up to 18 characters and
// landmark names up to 27. Every one of those truncates in a 296 px panel, which
// is exactly what the user sees and a tidy fixture hides.
//
// A review sheet that invents its own data reviews the data, not the app. It
// reads the real files — the scan is what is slow, not the JSON.
// THE REAL PANEL MARKUP, fetched from index.html. Everything the side panel
// adopts is defined there; a copy in this sheet drifts the moment that file
// changes, and a sheet reviewing a stale copy is worse than no sheet.
// CACHE-BUSTED. The point of fetching index.html is that the sheet cannot drift
// from it; a cached copy drifts exactly the same way a hand-written one does, and
// silently — a Display panel missing four of its six sections, say.
const indexHtml = await fetch(`/index.html?t=${Date.now()}`, { cache: "no-store" })
  .then(r => r.text());
const doc = new DOMParser().parseFromString(indexHtml, "text/html");
// `#shellStore`. If this id matches nothing, a quiet `if` would skip, `#objList`
// would never arrive, and the sheet would throw on its next line and render BLANK —
// unnoticed, because a sheet nobody can see is a sheet nobody opens. So missing
// markup is said out loud.
const STORE_ID = "shellStore";
const realPanel = doc.getElementById(STORE_ID);
if (realPanel) {
  realPanel.hidden = true;
  document.getElementById("adopted").replaceWith(realPanel);
} else {
  document.body.insertAdjacentHTML("afterbegin",
    `<p style="position:fixed;inset:40% 10% auto;z-index:99;padding:16px;background:#7a1f1f;color:#fff;font:16px system-ui">`
    + `This review sheet is broken: index.html has no #${STORE_ID}, which is where the panels it adopts live. `
    + `Fix STORE_ID in shell_preview.js.</p>`);
  throw new Error(`shell.html: index.html has no #${STORE_ID}`);
}

const [design, site, catalog, project] = await Promise.all([
  fetch("/data/design.json").then(r => r.json()).catch(() => ({})),
  fetch("/data/site.json").then(r => r.json()).catch(() => ({})),
  fetch("/data/plant_palette.json").then(r => r.json()).catch(() => ({})),
  fetch("/data/project.json").then(r => r.json()).catch(() => ({})),
]);
setUnits(project.units);

// THE SAME row vocabulary and the SAME sort the app uses. Rows of its own
// (`id  name` with an empty meta for everything that is not a plant) would show
// bare ids for every bed and path while the app shows areas and lengths —
// reviewing the mirror.
const KIND_OF = [["beds", "bed"], ["paths", "path"], ["patios", "patio"],
                 ["edges", "edge"], ["steps", "steps"], ["objects", "object"],
                 ["plants", "plant"]];
const rows = [];
const records = new Map();
for (const [key, kind] of KIND_OF)
  for (const o of design[key] ?? []) {
    rows.push(rowOf(o, kind));
    records.set(o.id, { kind, raw:o });
  }

const objList = document.getElementById("objList");
let order = "kind";
function paintObjects(q = "") {
  objList.innerHTML = "";
  objList.dataset.order = order;
  const hit = r => !q || `${r.id} ${r.kind} ${r.name} ${r.meta}`.toLowerCase().includes(q);
  const shown = sortRows(rows, order).filter(hit);
  document.getElementById("objShown").textContent = q
    ? `${shown.length} of ${rows.length}`
    : `${rows.length} objects`;
  if (q && !shown.length) {
    const e = document.createElement("div");
    e.className = "hint"; e.textContent = `nothing matches \u201c${q}\u201d`;
    objList.appendChild(e);
    return;
  }
  for (const item of withKindHeadings(shown, order)) {
    if (item.type === "heading") {
      const h = document.createElement("div");
      h.className = "p-label tree-heading";
      h.textContent = kindPlural(item.kind);
      const c = document.createElement("span");
      c.className = "hint"; c.textContent = item.count;
      h.appendChild(c);
      objList.appendChild(h);
      continue;
    }
    const r = item.row;
    const el = document.createElement("div");
    el.className = "orow";
    const k = document.createElement("span"); k.className = "kind"; k.textContent = r.kind;
    const n = document.createElement("span");
    n.className = "nm";
    n.textContent = r.name || r.id;
    n.title = `${r.name || r.id}${r.meta ? ` \u2014 ${r.meta}` : ""}`;
    const m = document.createElement("span"); m.className = "meta"; m.textContent = r.meta;
    const eye = document.createElement("button"); eye.className = "eye"; eye.innerHTML = icon("eye", { size: 14 });
    const lock = document.createElement("button"); lock.className = "eye"; lock.innerHTML = icon("lock", { size: 14 });
    el.append(k, n, m, eye, lock);
    el.onclick = () => { objList.querySelectorAll(".orow").forEach(x => x.classList.remove("sel"));
                         el.classList.add("sel"); showInspector(r.id); };
    objList.appendChild(el);
  }
}
paintObjects();
document.getElementById("objCount").textContent = `(${rows.length})`;
document.getElementById("objRow")?.classList.add("bare");

// the sort control is built by main.js at render time, so a sheet that only
// adopts the markup shows an EMPTY header where the app shows a control
{
  const host = document.getElementById("objRow");
  const sel = document.createElement("select");
  sel.className = "tree-sort";
  sel.title = "how to order the list — a view preference, not a change to the design";
  for (const o of ORDERS) {
    const opt = document.createElement("option");
    opt.value = o.id; opt.textContent = o.label;
    sel.appendChild(opt);
  }
  sel.onchange = () => { order = sel.value; paintObjects(objFilter?.value.trim().toLowerCase() ?? ""); };
  host.appendChild(sel);
}

// the filter, through the SAME paint — narrowing hundreds of rows is the thing this
// surface is FOR, so a sheet that cannot narrow reviews half of it
const objFilter = document.getElementById("objFilter");
if (objFilter) objFilter.oninput = () => paintObjects(objFilter.value.trim().toLowerCase());

for (const [name, when] of [["bank_study", "2 min ago"], ["variant_a", "1 h ago"],
                            ["meadow_edge", "yesterday"], ["starter", "3 days ago"]]) {
  const r = document.createElement("div");
  r.className = "drow";
  r.className = "drow" + (name === "bank_study" ? " cur" : "");
  r.innerHTML = `<span class="nm">${name}</span><span class="meta">${when}</span>`;
  const e = document.createElement("button"); e.className = "eye"; e.innerHTML = icon("eye", { size: 14 });
  r.appendChild(e);
  document.getElementById("designList").appendChild(r);
}
// THE REAL ROW SHAPES, not just the real names.
//
// Simplified rows of its own would exercise the CHROME and not the row renderers
// — Places would look flat here while the app's own `.lrow` (an editable name,
// show, delete) and `.r` (name, size, show, make, delete) are what actually ship.
// A sheet that mirrors the app loosely reviews the mirror. `tests/js/chrome.test.mjs`
// asserts these class names match what main.js builds, so the mirroring cannot
// drift silently.
function lrow(name, title) {                       // renderLandmarkList's shape
  const row = document.createElement("div");
  row.className = "lrow";
  const label = document.createElement("input");
  label.type = "text"; label.className = "nm"; label.value = name; label.title = title;
  const go = document.createElement("button"); go.textContent = "show";
  const del = document.createElement("button"); del.textContent = "✕";
  row.append(label, go, del);
  return row;
}
function arow(name, m2) {                          // renderAreaList's shape
  const row = document.createElement("div");
  row.className = "r";
  const n = document.createElement("input");
  n.type = "text"; n.className = "nm"; n.value = name; n.title = `${m2} m² — edit to rename`;
  const size = document.createElement("span");
  size.className = "meta"; size.textContent = `${m2} m²`;
  const go = document.createElement("button"); go.className = "eye"; go.textContent = "show";
  const bed = document.createElement("button"); bed.textContent = "bed";
  const del = document.createElement("button"); del.textContent = "✕";
  row.append(n, size, go, bed, del);
  return row;
}
const lmBox = document.getElementById("lmList");
for (const l of site.landmarks ?? []) lmBox.appendChild(lrow(l.name, `${l.x}, ${l.y} m`));
document.getElementById("lmCount").textContent = `(${(site.landmarks ?? []).length})`;
const areaBox = document.getElementById("areaList");
// areas.js's polygonArea, not a second shoelace. Geometry has one home; a review
// sheet is not exempt, and a sheet computing sizes its own way would show sizes
// the app does not.
for (const a of site.areas ?? [])
  areaBox.appendChild(arow(a.name, polygonArea(a.polygon ?? []).toFixed(0)));
if (!(site.areas ?? []).length) areaBox.innerHTML = '<div class="hint">none yet</div>';
const vpBox = document.getElementById("vpList");
for (const v of site.viewpoints ?? []) vpBox.appendChild(lrow(v.name, "saved camera"));
if (!(site.viewpoints ?? []).length) vpBox.innerHTML = '<div class="hint">none yet</div>';

// ── the real shell ──
const toasts = mountToasts();
const commands = createCommands();
const say = t => () => toasts.push(t, "ok");
for (const c of [
  ["view.walk", "Walk the garden", "View"], ["tool.measure", "Measure", "Tools"],
  ["tool.area", "Draw an area", "Tools"], ["tool.assets", "Add", "Tools"],
  ["view.top", "Top", "View"], ["view.front", "Front", "View"], ["view.side", "Side", "View"],
  ["view.iso", "Isometric", "View"], ["view.frameAll", "Frame everything", "View"],
  ["view.shots", "Photograph the garden", "View"], ["design.ask", "Ask what's wrong", "Design"],
  ["view.saveViewpoint", "Save this view as…", "View"], ["view.bookmark", "Remember this view", "View"],
  ["view.shot", "Save a screenshot", "View"],
  ["design.new", "New design", "Design"], ["design.saveAs", "Save this design as…", "Design"],
  ["edit.showAll", "Show everything", "Edit"], ["edit.solo", "Solo", "Edit"],
  ["app.objects", "Objects", "App"], ["app.versions", "Designs", "App"],
  ["app.places", "Places", "App"], ["app.views", "Views", "App"], ["app.view", "Display settings", "App"],
  ["app.settings", "Project settings", "App"], ["app.keys", "Keyboard and mouse", "App"],
  ["app.log", "Recent messages", "App"], ["site.detect", "Detect structures", "App"],
]) commands.add({ id: c[0], title: c[1], group: c[2], run: say(c[1]) });

const cmdPalette = mountPalette(commands);
const ctxMenu = mountContextMenu({ onPick: it => toasts.push(it.title, "ok") });
const sidePanel = mountSidePanel({ surfaces: SURFACES, onAction: id => commands.run(id) });
const inspector = mountInspector({
  onDismiss: () => inspector.hide(),
  occludedLeft: () => document.getElementById("pSideWrap")?.getBoundingClientRect().width ?? 0,
});
const hud = mountHud("pMeasureHud");
const topBar = mountTopBar({
  onPalette: () => cmdPalette.toggle(),
  onDesignMenu: () => sidePanel.toggle("design"),
  onOverflow: ev => ctxMenu.open([
    { id: "app.settings", title: "Project settings…", hint: "not calibrated" },
    { id: "site.detect", title: "Detect structures…", hint: "once per property" },
    { id: "view.shot", title: "Save a screenshot", hint: "the frame you are looking at" },
    { id: "app.keys", title: "Keyboard and mouse", hint: "?" }, "-",
    { id: "app.log", title: "Recent messages" }], { x: ev.clientX - 180, y: 46 }),
  onCamera: ev => { const r = ev.currentTarget.getBoundingClientRect();
    ctxMenu.open([{ id: "view.top", title: "Top" }, { id: "view.front", title: "Front" },
                  { id: "view.side", title: "Side" }, { id: "view.iso", title: "Isometric" }],
                 { x: r.left - 60, y: r.bottom + 6 }); },
  onFrame: say("Frame everything"),
  onUndo: say("Undo"), onRedo: say("Redo"),
});
const dock = mountDock(DOCK_TOOLS, { onPick: t => commands.run(t.id), onMenu: (t, at) => ctxMenu.open(t.menu, at),
     activeId: () => null });

topBar.setDesign({ name: "bank_study" });
topBar.setMeta("240 plants");
topBar.setHistory("12/18");
sidePanel.restore();
if (!sidePanel.isOpen()) sidePanel.show("objects");

function showInspector(id) {
  const record = records.get(id);
  if (!record) { inspector.hide(); return; }
  inspector.show(record.raw.common ?? record.raw.id, { x: innerWidth * 0.62, y: innerHeight * 0.44 });
  inspector.body.innerHTML = "";
  if (record.kind === "plant") {
    plantInspector.contributes.inspectors[0].render(inspector.body, record, {
      design: { byId: key => records.get(key) },
      assets: { plant: species => catalog.plants?.find(p => p.species === species) },
      ui: { log: (m,l) => toasts.push(m,l), size, pair, parseLen, lenField, lengthUnit },
      // This review sheet is read-only. Exercise the real inspector's callbacks
      // against a local copy; the actual viewer verifies the validated write.
      ops: { apply: async ops => {
        for (const op of ops) for (const plant of op.input.plants)
          records.set(plant.id, { kind:"plant", raw:structuredClone(plant) });
        showInspector(id);
        toasts.push("Preview only — your design was not changed", "ok");
      } },
    });
  }
  inspector.setActions([
    { title: "Frame", run: say("Frame") }, { title: "Duplicate", run: say("Duplicate") },
    { title: "Change species", run: say("Change species") }, { title: "Hide", run: say("Hide") },
    { title: "Delete", danger: true, run: say("Delete") },
  ]);
}
showInspector(design.plants?.[0]?.id);
hud.show([["across", "6.4 m"], ["along the ground", "6.6 m"], ["fall", "0.9 m · 14%"],
          "3 points · ⌫ undoes one · Esc stops"]);

addEventListener("keydown", ev => {
  if (opensPalette(ev, document.activeElement?.tagName)) { ev.preventDefault(); cmdPalette.toggle(); }
});
addEventListener("contextmenu", ev => {
  ev.preventDefault();
  ctxMenu.open(contextItemsFor({ kind: "plant", id: "p12" },
    { hasSelection: true, group: { id: "grp_1", name: "Stone triad", members: ["a"] } }),
    { x: ev.clientX, y: ev.clientY });
});
const shots = document.getElementById("shotsList");
for (let i = 1; i <= 8; i++) {
  const b = document.createElement("button"); b.className = "shot";
  const im = document.createElement("img");
  im.src = `/data/views/v_${String(i).padStart(4, "0")}.jpg`; im.loading = "lazy";
  im.onerror = () => b.remove();
  b.appendChild(im); shots.appendChild(b);
}
toasts.push("PEDON shell review sheet — fixture data, real components", "ok");
