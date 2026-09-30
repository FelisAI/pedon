// The floating tool dock.
//
// It is built from the extension registry's `tools` rather than from markup —
// so a tool contributed by an extension sits beside a built-in one and is
// reached the same way. A hardcoded surface ends up as buttons that call
// `.click()` on other buttons in the panel.
//
// Bottom-centre, floating, one row. A dock that grows a second row has stopped
// being a dock, so the overflow goes to the palette — which is exactly the
// surface whose cost does not grow with the app.

import { icon } from "./icons.js";

export function mountDock(tools, { onPick, onMenu, activeId = () => null } = {}) {
  const dock = document.createElement("nav");
  dock.id = "pDock";
  dock.setAttribute("aria-label", "Tools");
  document.body.appendChild(dock);

  const buttons = new Map();
  for (const t of tools) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dock-btn";
    b.dataset.tool = t.id;
    b.title = t.hint ? `${t.title} — ${t.hint}` : t.title;
    b.setAttribute("aria-label", t.title);
    const glyph = document.createElement("span");
    glyph.className = "dock-icon";
    glyph.innerHTML = icon(t.icon);
    b.appendChild(glyph);
    const label = document.createElement("span");
    label.className = "dock-label";
    label.textContent = t.title;
    b.appendChild(label);
    // A BUTTON WITH VARIANTS OPENS A MENU. Four standard views behind one
    // "cycle" button means pressing it until the one you want comes round, and
    // a workflow with no button — eye-level shots, ask what's wrong — lives only
    // in ⌘K. A search box is not an interface: every capability
    // needs a PLACE, and a menu on the button it belongs to is that place.
    // a `dynamicMenu` is built when it opens, from what exists then (the saved views)
    if (t.menu?.length || t.dynamicMenu) {
      b.classList.add("has-menu");
      b.onclick = ev => {
        const r = b.getBoundingClientRect();
        onMenu?.(t, { x: r.left, y: r.top - 8 });
      };
    } else {
      b.onclick = () => onPick?.(t);
    }
    dock.appendChild(b);
    buttons.set(t.id, b);
  }

  const sync = () => {
    const on = activeId();
    for (const [id, b] of buttons) b.classList.toggle("on", id === on);
  };
  sync();

  return { element: dock, sync,
           /** a mode entered from the palette must light its dock button too */
           setActive(id) { for (const [k, b] of buttons) b.classList.toggle("on", k === id); } };
}
