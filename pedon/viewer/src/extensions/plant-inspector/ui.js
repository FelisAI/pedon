// The plant inspector — the first extension, and the slice that proves the contract.
//
// The core property inspector gates on `MOVE_AS[kind]` (main.js), and MOVE_AS has
// rows for path, edge, bed, patio, steps and object — but not for plant, so without
// this a selected plant shows NOTHING, though it can be dragged (moveOps has an
// explicit `kind === "plant"` branch). A panel vocabulary that is a hand-kept table
// is one a new kind gets forgotten from. That is the whole argument for registries.
//
// It IMPORTS NOTHING from the app. Everything arrives on `ctx`, which is what
// keeps the capability boundary real and lets this same file run inside a Worker
// later without being rewritten. See pedon/EXTENSIONS.md.

const num = v => (Number.isFinite(+v) ? +(+v).toFixed(2) : null);

/**
 * Moving a plant is set_plants on its own id.
 *
 * The whole record goes, with only the position changed: set_plants replaces the
 * record, so anything left out would be deleted. Not remove_objects +
 * place_plants: place_plants mints a fresh id, so a typed move would drop the
 * plant out of its group. The ops ARE the public API, so an extension expresses
 * the change exactly as a model would, without reaching into the viewer.
 */
function moveTo(raw, x, y) {
  return [{ tool: "set_plants", input: { plants: [{ ...raw, position: [x, y] }] } }];
}

function row(parent, label) {
  const r = document.createElement("div");
  r.className = "prow";
  const l = document.createElement("label");
  l.textContent = label;
  r.appendChild(l);
  parent.appendChild(r);
  return r;
}

function fact(parent, label, value) {
  const r = row(parent, label);
  const span = document.createElement("span");
  span.className = "factval";
  span.textContent = value;
  r.appendChild(span);
  return span;
}

export default {
  id: "dev.pedon.plant-inspector",
  name: "Plant inspector",
  version: "1.1.0",
  // the minimum that does the job: it moves plants, reads the document to know
  // what is selected, reads the palette to offer species, and talks to the user
  permissions: ["ops:write", "design:read", "assets:read", "ui:notify"],
  contributes: {
    inspectors: [{
      forKind: "plant",
      render(box, { raw }, ctx) {
        const current = () => ctx.design?.byId?.(raw.id)?.raw ?? raw;
        const head = document.createElement("div");
        head.className = "hint";
        head.textContent = raw.common ? `${raw.common} — ${raw.species}` : raw.species;
        head.title = raw.id;
        box.appendChild(head);

        // POSITION, TYPED. Dragging places a plant approximately; this project
        // stores to the centimetre and a designer wants to say where a thing
        // goes. Two fields, applied together, because a move is one gesture.
        const pos = raw.position ?? [];
        const xr = row(box, "x (m)");
        const x = document.createElement("input");
        x.type = "number"; x.step = "0.01"; x.value = pos[0] ?? "";
        xr.appendChild(x);
        const yr = row(box, "y (m)");
        const y = document.createElement("input");
        y.type = "number"; y.step = "0.01"; y.value = pos[1] ?? "";
        yr.appendChild(y);

        const apply = async () => {
          const nx = num(x.value), ny = num(y.value);
          if (nx === null || ny === null) { ctx.ui.log("x and y must be numbers", "warn"); return; }
          if (nx === num(pos[0]) && ny === num(pos[1])) return;   // nothing moved
          // the op goes through /api/ops like every other edit, so a plant typed
          // onto the house, off the scan or into another plant's hole comes back
          // REFUSED with the reason
          await ctx.ops.apply(moveTo(current(), nx, ny), `${raw.id} moved`);
        };
        for (const el of [x, y]) {
          el.onchange = apply;
          el.onkeydown = e => { if (e.key === "Enter") el.blur(); };
        }

        // A catalogue is a reference; this plant's planning size is a design
        // choice. Keep it on the same record that rendering and measurement read.
        const size = v => (v == null ? "?" : ctx.ui?.size ? ctx.ui.size(v) : `${v} m`);
        const pal = ctx.assets?.plant?.(raw.species);
        const fields = [
          ["mature_height_m", "Planning height"],
          ["mature_spread_m", "Planning width"],
        ].map(([key, label]) => {
          const r = row(box, label);
          const input = document.createElement("input");
          input.type = "text"; input.name = key; input.id = `${raw.id}-${key}`;
          r.children[0].htmlFor = input.id;
          input.value = ctx.ui.lenField(raw[key]);
          input.placeholder = ctx.ui.lengthUnit();
          r.appendChild(input);
          return { key, input, initial: input.value };
        });
        const note = document.createElement("div");
        note.className = "hint";
        note.textContent = (raw.size_override ? "Custom size. " : "")
          + "For this plant in this design. Width is the full spread.";
        if (pal?.flowering_height_range_m)
          note.textContent += " Height is foliage; flowers rise above it.";
        box.appendChild(note);
        if (pal) {
          fact(box, "Catalogue height", size(pal.mature_height_m));
          fact(box, "Catalogue width", size(pal.mature_spread_m));
          for (const [key, label] of [["mature_height_range_m", "Height range"],
                                       ["mature_spread_range_m", "Width range"]]) {
            if (pal[key]?.length === 2)
              fact(box, label, pal[key].map(size).join("–"));
          }
        }
        const actions = document.createElement("div");
        actions.className = "plant-size-actions";
        const save = document.createElement("button");
        save.type = "button"; save.className = "insp-act"; save.textContent = "Apply size";
        const reset = document.createElement("button");
        reset.type = "button"; reset.className = "insp-act"; reset.textContent = "Reset to catalogue size";
        const canReset = pal?.mature_height_m > 0 && pal?.mature_spread_m > 0;
        reset.disabled = !canReset || (!raw.size_override && fields.every(f => raw[f.key] === pal[f.key]));
        const commit = async (next, what) => {
          save.disabled = reset.disabled = true;
          try { await ctx.ops.apply([{tool:"set_plants", input:{plants:[next]}}], what); }
          finally { save.disabled = false; reset.disabled = !canReset; }
        };
        save.onclick = async () => {
          const next = { ...current() };
          let changed = false;
          for (const {key, input, initial} of fields) {
            // Do not round an untouched field through its display representation.
            if (input.value === initial) continue;
            const value = ctx.ui.parseLen(input.value);
            if (!Number.isFinite(value) || value <= 0) {
              ctx.ui.log("Enter a positive height and width, such as 3 ft or 0.9 m.", "warn");
              return;
            }
            changed ||= value !== next[key];
            next[key] = value;
          }
          if (!changed) return;
          next.size_override = true;
          await commit(next, `${raw.common ?? raw.species} size changed`);
        };
        reset.onclick = async () => {
          if (!canReset) return;
          const next = { ...current(), mature_height_m:pal.mature_height_m,
                         mature_spread_m:pal.mature_spread_m };
          delete next.size_override;
          await commit(next, `${raw.common ?? raw.species} reset to catalogue size`);
        };
        for (const {input} of fields)
          input.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); save.onclick(); } };
        actions.appendChild(save); actions.appendChild(reset); box.appendChild(actions);
        if (raw.form) fact(box, "form", raw.form);

        // CAT SAFETY IS THREE-STATE AND null IS NOT SAFE. Where cats have the run
        // of a garden, the palette records true / false / unverified and a
        // design tool guessing at toxicity is the worst answer available.
        if (pal) {
          const safe = pal.cat_safe;
          const el = fact(box, "cat safe",
            safe === true ? "yes" : safe === false ? "NO — toxic" : "not verified");
          el.className = "factval " + (safe === true ? "ok" : safe === false ? "bad" : "unsure");
          if (safe !== true) el.title = pal.cat_safety?.note
            ?? "not known toxic is not evidence of non-toxicity";
        }
        return true;
      },
    }],
  },
};
