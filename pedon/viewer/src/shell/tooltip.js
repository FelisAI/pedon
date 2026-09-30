// Tooltips that actually appear.
//
// Every button in the top bar carries a `title`, and that is exactly the trap,
// because a `title` attribute is not a tooltip, it is a REQUEST for one. The
// browser decides: it waits a second or more, it draws an OS chrome that has
// nothing to do with the app, it gives up if the pointer moved at all on the way
// in, and over a canvas that is repainting every frame it is unreliable enough
// that a user hovering a row of icon-only buttons concludes there is nothing
// there.
//
// Icon-only buttons are the whole reason this matters. The rail carries a word
// under each glyph; the top bar and the dock do not, so a tooltip is the ONLY
// thing that says what the button is — and a label nobody can read is the same
// failure as no label at all.
//
// THE NATIVE ONE IS SUPPRESSED, not raced. Leaving `title` in place gives two
// tooltips for one button, ours immediately and the OS's a second later, in
// different places. So the attribute is moved to `data-tip` while the pointer is
// over the element and put back when it leaves — which also means the value
// stays exactly where the rest of the app writes it, and nothing else has to
// learn a new attribute.

const SHOW_MS = 220;          // long enough not to flicker across a toolbar
const GAP = 8;
const MARGIN = 6;

/**
 * Where the bubble goes: below the element, or above it when there is no room.
 *
 * Pure and separated for the same reason `placeCard` is — the placement is the
 * part worth testing and it needs no DOM to decide.
 */
export function placeTip(anchor, tip, viewport, gap = GAP, margin = MARGIN) {
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - tip.height;
  const top = below + tip.height + margin <= viewport.height || above < margin
    ? below : above;
  let left = anchor.left + anchor.width / 2 - tip.width / 2;
  left = Math.max(margin, Math.min(left, viewport.width - tip.width - margin));
  return { left: Math.round(left), top: Math.round(top) };
}

export function mountTooltips({ root = document, selector = "[title]" } = {}) {
  const tip = document.createElement("div");
  tip.id = "pTip";
  tip.hidden = true;
  tip.setAttribute("role", "tooltip");
  document.body.appendChild(tip);

  let timer = null, held = null;

  const hide = () => {
    clearTimeout(timer); timer = null;
    tip.hidden = true;
    // ALWAYS put it back, even if the element has since been re-rendered out of
    // the document — a row that loses its title because the list redrew while
    // the pointer was over it is a tooltip that never comes back.
    if (held && held.el.isConnected && !held.el.getAttribute("title"))
      held.el.setAttribute("title", held.text);
    held = null;
  };

  const show = el => {
    const text = (held?.text ?? "").trim();
    if (!text || !el.isConnected) return;
    tip.textContent = text;
    tip.hidden = false;
    const at = placeTip(el.getBoundingClientRect(), tip.getBoundingClientRect(),
                        { width: innerWidth, height: innerHeight });
    tip.style.left = `${at.left}px`;
    tip.style.top = `${at.top}px`;
  };

  root.addEventListener("pointerover", ev => {
    const el = ev.target?.closest?.(selector);
    if (!el || el === held?.el) return;
    hide();
    const text = el.getAttribute("title");
    if (!text) return;
    held = { el, text };
    el.removeAttribute("title");          // suppress the OS one
    timer = setTimeout(() => show(el), SHOW_MS);
  });
  root.addEventListener("pointerout", ev => {
    if (held && !ev.relatedTarget?.closest?.(selector)) hide();
    else if (held && ev.relatedTarget?.closest?.(selector) !== held.el) hide();
  });
  // a click means the user found out what it was; keeping the bubble up over the
  // result of pressing it is noise
  root.addEventListener("pointerdown", hide, true);
  addEventListener("blur", hide);
  addEventListener("scroll", hide, true);

  return { element: tip, hide };
}
