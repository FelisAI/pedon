// ⌘K — the command palette.
//
// The problem is not a missing control; it is finding one among dozens in a
// scrolling column. A palette inverts that: you say what you want instead of
// locating where it lives. It is also the only surface whose cost does not grow
// as the app does, which is what makes it the right answer for a tool that
// gains extensions.
import { rankCommands, prettyKeys } from "./commands.js";

export function mountPalette(commands, { onRun } = {}) {
  const root = document.createElement("div");
  root.id = "pPalette";
  root.hidden = true;
  root.innerHTML = `
    <div class="pal-scrim"></div>
    <div class="pal-box" role="dialog" aria-modal="true" aria-label="Commands">
      <input class="pal-input" type="text" placeholder="Search commands…"
             autocomplete="off" spellcheck="false" aria-controls="pPaletteList" />
      <div class="pal-list" id="pPaletteList" role="listbox"></div>
      <div class="pal-foot"><span>↑↓ move</span><span>↵ run</span><span>esc close</span></div>
    </div>`;
  document.body.appendChild(root);

  const input = root.querySelector(".pal-input");
  const list = root.querySelector(".pal-list");
  let rows = [], active = 0;

  const draw = () => {
    rows = rankCommands(commands.available(), input.value);
    list.innerHTML = "";
    if (!rows.length) {
      const e = document.createElement("div");
      e.className = "pal-empty";
      e.textContent = `Nothing matches “${input.value}”`;
      list.appendChild(e);
      return;
    }
    active = Math.min(active, rows.length - 1);
    let group = null;
    rows.forEach((c, i) => {
      if (c.group !== group) {
        group = c.group;
        const g = document.createElement("div");
        g.className = "pal-group p-label";
        g.textContent = group;
        list.appendChild(g);
      }
      const el = document.createElement("div");
      el.className = "pal-row" + (i === active ? " on" : "");
      el.setAttribute("role", "option");
      el.setAttribute("aria-selected", String(i === active));
      const t = document.createElement("span");
      t.className = "pal-title";
      t.textContent = c.title;
      el.appendChild(t);
      if (c.hint) {
        const h = document.createElement("span");
        h.className = "pal-hint";
        h.textContent = c.hint;
        el.appendChild(h);
      }
      if (c.keys) {
        const k = document.createElement("kbd");
        k.textContent = prettyKeys(c.keys);
        el.appendChild(k);
      }
      // pointerdown, not click: the input is focused, and a click would blur it
      // first and close the palette out from under the row being clicked
      el.onpointerdown = ev => { ev.preventDefault(); run(i); };
      el.onpointermove = () => { if (active !== i) { active = i; draw(); } };
      list.appendChild(el);
    });
    list.querySelector(".pal-row.on")?.scrollIntoView({ block: "nearest" });
  };

  const open = () => {
    root.hidden = false;
    input.value = ""; active = 0;
    draw();
    input.focus();
  };
  const close = () => { root.hidden = true; input.blur(); };
  const run = i => {
    const c = rows[i];
    close();
    if (!c) return;
    // AFTER closing, and in a task of its own: a command that opens another
    // surface should not race the palette's own teardown, and one that throws
    // must not leave the palette half-open over the yard
    setTimeout(() => { try { c.run(); onRun?.(c); } catch (e) { onRun?.(c, e); } }, 0);
  };

  input.oninput = () => { active = 0; draw(); };
  input.onkeydown = ev => {
    if (ev.key === "Escape") { ev.preventDefault(); close(); }
    else if (ev.key === "ArrowDown") { ev.preventDefault(); active = Math.min(active + 1, rows.length - 1); draw(); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); active = Math.max(active - 1, 0); draw(); }
    else if (ev.key === "Enter") { ev.preventDefault(); run(active); }
  };
  root.querySelector(".pal-scrim").onpointerdown = close;

  return { open, close, toggle: () => (root.hidden ? open() : close()),
           isOpen: () => !root.hidden, element: root };
}

/**
 * Should this keystroke open the palette?
 *
 * Pure so it can be tested without a document, and it exists as its own function
 * because the guard is the whole subtlety: ⌘K must NOT fire while the user is
 * typing a landmark name or an area name into a field. The same guard applies in
 * the other direction — W A S D would move the camera while the user types into
 * an input, which is why flycam's keydown checks the active element.
 */
export function opensPalette(ev, activeTag) {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(activeTag ?? "")) return false;
  return !!(ev.metaKey || ev.ctrlKey) && !ev.altKey && (ev.key === "k" || ev.key === "K");
}
