// The inspector — a card in ONE fixed place, showing what you selected.
//
// The user must be able to change what they selected: selecting a plant in the
// yard and then hunting for its fields in a sidebar is two separate acts of
// searching (a plant's fields: see extensions/plant-inspector).
//
// It docks in one fixed place rather than beside the selection (see placeCard).
// This module stays free of three.js: it is given a point and it is testable
// without a renderer.

/** Where the card sits. Pure, so the maths is testable. */
import { icon } from "./icons.js";

/**
 * ONE PLACE, ALWAYS THE SAME PLACE.
 *
 * The item detail does not pop up beside the item; it shows in a fixed place on
 * the page. A card that follows the selection around the screen covers the thing
 * next to what you picked, moves under your cursor as the camera turns, and is
 * somewhere new on every click. It docks to the top right — the corner the rail,
 * the panel and the dock all leave free.
 *
 * `anchor` is still accepted and ignored: callers project a point for it, and a
 * signature change would be a second edit in a file that does not need one.
 */
export function placeCard({ card, viewport, margin = 12, topBar = 46 }) {
  const { w, h } = card;
  const { width, height } = viewport;
  const left = Math.max(margin, width - margin - w);
  const top = Math.min(Math.max(margin, topBar), Math.max(margin, height - margin - h));
  return { left: Math.round(left), top: Math.round(top), side: "docked" };
}

export function mountInspector({ onDismiss, occludedLeft = () => 0 } = {}) {
  const card = document.createElement("aside");
  card.id = "pInspector";
  card.hidden = true;
  card.setAttribute("aria-label", "Selection");
  const head = document.createElement("header");
  const body = document.createElement("div");
  body.className = "insp-body";
  const actions = document.createElement("footer");
  actions.className = "insp-actions";

  const close = document.createElement("button");
  close.type = "button"; close.className = "insp-x"; close.innerHTML = icon("close", { size: 14 });
  close.title = "Clear selection (Esc)";
  close.onclick = () => onDismiss?.();
  head.appendChild(close);
  card.append(head, body, actions);
  document.body.appendChild(card);

  let anchor = null;

  const reposition = () => {
    if (card.hidden || !anchor) return;
    const r = card.getBoundingClientRect();
    const p = placeCard({
      anchor, card: { w: r.width || 260, h: r.height || 160 },
      viewport: { width: innerWidth, height: innerHeight },
      occludeLeft: occludedLeft(),
    });
    card.style.left = `${p.left}px`;
    card.style.top = `${p.top}px`;
    card.dataset.side = p.side;
  };

  return {
    element: card, body,
    /**
     * The things you can DO to what is selected, in the card beside it.
     *
     * They delegate — each one clicks the control that already exists — for the
     * same reason the dock and the palette do: a button whose only content is a
     * reference to another button must not copy it, and a third copy of
     * "delete the selection" is how two of them drift apart. They are rebuilt
     * per showing rather than adopted, because this card re-renders as the
     * camera moves and moving live DOM on every frame would thrash it.
     */
    setActions(list) {
      actions.innerHTML = "";
      actions.hidden = !list?.length;
      for (const a of list ?? []) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "insp-act" + (a.danger ? " danger" : "");
        b.textContent = a.title;
        if (a.hint) b.title = a.hint;
        b.disabled = !!a.disabled;
        b.onclick = () => a.run();
        actions.appendChild(b);
      }
    },
    /** `title` names what is selected; `at` is a screen point, or null to hide */
    show(title, at) {
      if (!at) { this.hide(); return; }
      anchor = at;
      card.hidden = false;
      // the heading is rebuilt rather than appended to: an inspector that
      // accumulates headings is how a panel becomes a log
      head.querySelectorAll(".insp-title").forEach(n => n.remove());
      const t = document.createElement("span");
      t.className = "insp-title";
      t.textContent = title;
      head.prepend(t);
      reposition();
    },
    hide() { card.hidden = true; anchor = null; body.innerHTML = ""; },
    isOpen: () => !card.hidden,
    reposition,
  };
}
