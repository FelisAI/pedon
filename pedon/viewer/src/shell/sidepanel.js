// The persistent side panel, and the activity rail that switches it.
//
// The objects list is one of the most used features, so it needs a persistent
// entry in the UI.
//
// A SUMMONED panel — open it, use it, Esc closes it — is right for something you
// consult and wrong for something you work in, and the objects list is the second
// kind: you keep it open, select from it, hide things in it, and come back to it
// constantly. A surface like that has to still be there when you look up.
//
// So: a rail of SURFACES pinned to the edge, always visible, and a panel beside
// it that remembers what was open across reloads.
//
// This is not a rail of TOOLS — buttons that call .click() on panel buttons, a
// surface whose only content is a reference to another surface. This rail's
// entries are the surfaces themselves, and it exists because a dock button is
// transient when the thing it opens is not.
//
// It still ADOPTS: `renderObjectList` already draws a tree with fold, hide, lock,
// rename and hover-highlight, all tested, and re-authoring it would mean
// re-earning every one. Nodes go home when the surface changes or the panel
// closes, so the markup they came from is never left with a hole.

import { icon } from "./icons.js";

const KEY = "pedon.side";

export function mountSidePanel({ surfaces, onChange, onAction } = {}) {
  const wrap = document.createElement("div");
  wrap.id = "pSideWrap";

  const rail = document.createElement("nav");
  rail.id = "pRail";
  rail.setAttribute("aria-label", "Panels");

  const panel = document.createElement("aside");
  panel.id = "pSide";
  panel.hidden = true;

  const head = document.createElement("header");
  const title = document.createElement("span");
  title.className = "side-title";
  // ACTIONS BELONG TO THE SURFACE THEY ACT ON. "Save this design as…" and "New
  // design" are not only in ⌘K: the place a person looks for them is the header
  // of the list of designs, so that is where they are.
  // ...but in a ROW OF THEIR OWN, not squeezed in beside the title. Views has
  // three — "Save this view", "Retake photos", "What's wrong?" — and at a 296 px
  // panel they wrap to three lines of two words each inside the header bar,
  // which is unreadable and is not something source review can show you.
  const acts = document.createElement("div");
  acts.className = "side-acts";

  const collapse = document.createElement("button");
  collapse.type = "button"; collapse.className = "side-x";
  collapse.innerHTML = icon("chevronL", { size: 16 }); collapse.title = "Collapse (the rail stays)";
  head.append(title, collapse);

  const body = document.createElement("div");
  body.className = "side-body";
  panel.append(head, acts, body);
  wrap.append(rail, panel);
  document.body.appendChild(wrap);

  const homes = new Map();
  const buttons = new Map();
  let current = null;

  function giveBack() {
    for (const [node, home] of homes) home?.appendChild(node);
    homes.clear();
    body.innerHTML = "";
  }

  function remember() {
    try { localStorage.setItem(KEY, current ?? ""); } catch { /* private mode */ }
  }

  function paint() {
    for (const [id, b] of buttons) {
      const on = id === current;
      b.classList.toggle("on", on);
      b.setAttribute("aria-expanded", String(on));
    }
    panel.hidden = !current;
  }

  function show(id) {
    const spec = surfaces?.[id];
    if (!spec) return false;
    giveBack();
    current = id;
    title.textContent = spec.label;
    acts.innerHTML = "";
    acts.hidden = !(spec.actions ?? []).length;   // no empty strip above a list
    for (const a of spec.actions ?? []) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "side-act";
      b.textContent = a.title;
      if (a.hint) b.title = a.hint;
      b.onclick = () => onAction?.(a.id);
      acts.appendChild(b);
    }
    for (const nid of spec.ids) {
      const n = document.getElementById(nid);
      if (!n) continue;
      homes.set(n, n.parentElement);
      body.appendChild(n);
    }
    paint(); remember(); onChange?.(id);
    return true;
  }

  function hide() {
    giveBack();
    current = null;
    // clear the heading too: a collapsed panel that reappears still naming the
    // surface it does not hold reads as "Display is broken" rather than "the
    // panel did not hide"
    title.textContent = "";
    paint(); remember(); onChange?.(null);
  }

  for (const [id, spec] of Object.entries(surfaces ?? {})) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "rail-btn";
    b.dataset.surface = id;
    b.title = spec.hint ? `${spec.label} — ${spec.hint}` : spec.label;
    b.setAttribute("aria-label", spec.label);
    const glyph = document.createElement("span");
    glyph.className = "rail-icon";
    glyph.innerHTML = icon(spec.icon);
    const label = document.createElement("span");
    label.className = "rail-label";
    label.textContent = spec.short ?? spec.label;
    b.append(glyph, label);
    // clicking the OPEN one collapses: a toggle, because pressing the same
    // control twice to get back to the yard is what anyone expects
    b.onclick = () => (current === id ? hide() : show(id));
    rail.appendChild(b);
    buttons.set(id, b);
  }
  collapse.onclick = hide;

  return {
    element: panel, rail, body,
    isOpen: () => !!current,
    current: () => current,
    show, hide,
    toggle: id => (current === id ? hide() : show(id)),
    /** Reopen whatever was open last time. Called once the lists can render. */
    restore() {
      let want = null;
      try { want = localStorage.getItem(KEY); } catch { /* private mode */ }
      if (want && surfaces?.[want]) show(want);
      else paint();
    },
  };
}
