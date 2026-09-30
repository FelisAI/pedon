// Right-click on the world.
//
// A right-click on the world should do something to it. It is the other half of
// mode-free navigation: right-DRAG looks around, right-CLICK opens this. Unity
// and Unreal resolve the same collision the same way, which is the argument for
// it — users already know the gesture.
//
// Items come from the same command registry the palette uses, filtered by what
// is under the cursor. So a context menu cannot drift from the palette, and an
// extension that contributes a command gets a place here for free.

export function mountContextMenu({ onPick } = {}) {
  const menu = document.createElement("div");
  menu.id = "pContext";
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  document.body.appendChild(menu);

  const close = () => { menu.hidden = true; };

  // close on anything that is not a click inside it. `pointerdown` on the window
  // in CAPTURE, so it beats the canvas's own handlers — otherwise the click that
  // dismisses the menu also selects whatever was behind it.
  addEventListener("pointerdown", ev => {
    if (!menu.hidden && !menu.contains(ev.target)) close();
  }, true);
  addEventListener("keydown", ev => { if (ev.key === "Escape") close(); });
  addEventListener("blur", close);

  return {
    element: menu,
    close,
    isOpen: () => !menu.hidden,
    /**
     * `items` is [{id, title, hint?, danger?}] or the string "-" for a divider.
     * `at` is where the pointer was.
     */
    open(items, at) {
      menu.innerHTML = "";
      if (!items?.length) return;
      for (const it of items) {
        if (it === "-") {
          const hr = document.createElement("div");
          hr.className = "ctx-sep";
          menu.appendChild(hr);
          continue;
        }
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ctx-item" + (it.danger ? " danger" : "");
        b.setAttribute("role", "menuitem");
        const t = document.createElement("span");
        t.textContent = it.title;
        b.appendChild(t);
        if (it.hint) {
          const h = document.createElement("span");
          h.className = "ctx-hint";
          h.textContent = it.hint;
          b.appendChild(h);
        }
        b.onclick = () => { close(); onPick?.(it); };
        menu.appendChild(b);
      }
      menu.hidden = false;
      const r = menu.getBoundingClientRect();
      const left = Math.min(at.x, innerWidth - r.width - 8);
      const top = Math.min(at.y, innerHeight - r.height - 8);
      menu.style.left = `${Math.max(8, Math.round(left))}px`;
      menu.style.top = `${Math.max(8, Math.round(top))}px`;
    },
  };
}

/**
 * What to offer for what was right-clicked. Pure, so the decision is testable
 * without a scene: this is the part that would otherwise be twelve `if`s inside
 * an event handler and impossible to check.
 *
 * `subject` is { kind, id } for an object, or null for bare ground.
 */
export function contextItemsFor(subject, { hasSelection = false, multi = false,
                                           group = null, extras = [] } = {}) {
  if (!subject) {
    return [
      { id: "place.here", title: "Place here", hint: "the current pick" },
      { id: "tool.area", title: "Draw an area from here" },
      { id: "tool.measure", title: "Measure from here" },
      "-",
      { id: "view.frameAll", title: "See the whole site" },
      { id: "edit.showAll", title: "Show everything hidden" },
      ...extras,
    ];
  }
  const items = [
    { id: "sel.frame", title: "Zoom to it" },
    { id: "sel.hide", title: "Hide this" },
    { id: "edit.solo", title: "Solo", hint: "⇧S" },
  ];
  // substitution is a plant-only verb, and offering it for a bed is an action
  // that can only log a refusal — the same reason btnSubstitute is disabled
  if (subject.kind === "plant")
    items.push({ id: "sel.substitute", title: "Change species…" });
  items.push("-",
    { id: "edit.duplicate", title: "Duplicate" },
    { id: "edit.delete", title: "Delete", danger: true });
  // grouping only makes sense for more than one thing, and offering it for one
  // is an action that can only refuse — the same rule the substitute button follows
  if (multi) items.push({ id: "edit.group", title: "Group these", hint: "⌘G" });
  // A PROPOSAL, not a folder. Offered for a multi-selection for the same
  // reason grouping is: one object is not an alternative to anything, and an
  // action that can only refuse should not be offered.
  if (multi) items.push({ id: "edit.alternative", title: "Make this a proposal…" });
  // A GROUP IS A THING YOU ACT ON, not only a folder in a list. Right-clicking a
  // stone in a triad and being offered only that stone is the same mistake solo
  // would have made by dropping the other two: the group is what was composed.
  if (group) items.push("-",
    { id: "group.select", title: `Select all in “${group.name || group.id}”` },
    { id: "group.hide", title: "Hide the whole group" },
    { id: "group.solo", title: "Solo the group" },
    { id: "group.ungroup", title: "Ungroup", danger: false });
  if (hasSelection) items.push("-", { id: "edit.clear", title: "Clear selection" });
  return [...items, ...extras];
}
