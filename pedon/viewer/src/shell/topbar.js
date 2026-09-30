// The top bar: the wordmark, what you are looking at, and the way in to everything.
//
// It is thin on purpose. The yard is the product; the chrome's job is to say
// where you are and get out of the way. Three things earn a place here — the
// identity, the design you are editing (to prevent silent edits to the wrong
// design), and the palette, which is how you reach anything
// that is not on the dock.
import { prettyKeys } from "./commands.js";
import { icon } from "./icons.js";

export function mountTopBar({ onPalette, onDesignMenu, onOverflow,
                              onUndo, onRedo, onCamera, onSite } = {}) {
  const bar = document.createElement("header");
  bar.id = "pTopBar";
  // ONE camera control, not two. Framing the whole site belongs with Top and
  // Isometric in the camera menu, as its first entry; F also frames it. A separate
  // button with the same glyph as the dock's photography action makes the two
  // actions hard to distinguish.
  //
  // (This comment lives OUT here on purpose: inside the template literal below,
  // a backtick around a word is a string terminator.)
  bar.innerHTML = `
    <div class="pedon-mark" title="pedon, n. the smallest volume that can be called a soil">
      PEDON<span class="meta"></span>
    </div>
    <button class="tb-site" type="button" title="the site — its capture, ground and projects" hidden>
      <span class="tb-site-name"></span><span class="tb-sep">/</span>
    </button>
    <button class="tb-design" type="button" aria-haspopup="menu">
      <span class="tb-name">—</span><span class="tb-caret">⌄</span>
    </button>
    <button class="tb-warn" type="button" hidden></button>
    <div class="tb-spacer"></div>
    <div class="tb-view">
      <button class="tb-cam" type="button" title="Camera — where you are looking from (F fits everything)" aria-label="Camera">
        ${icon("cube", { size: 15 })}<span class="tb-caret">⌄</span>
      </button>
    </div>
    <div class="tb-history">
      <button class="tb-undo" type="button" title="Undo (⌘Z)" aria-label="Undo">${icon("undo", { size: 15 })}</button>
      <span class="tb-pos p-num"></span>
      <button class="tb-redo" type="button" title="Redo (⇧⌘Z)" aria-label="Redo">${icon("redo", { size: 15 })}</button>
    </div>
    <button class="tb-k" type="button" title="Search commands">
      ${icon("search", { size: 14 })}<span>Search</span><kbd>${prettyKeys("mod")}K</kbd>
    </button>
    <button class="tb-more" type="button" aria-label="More" title="More">${icon("more", { size: 16 })}</button>`;
  document.body.appendChild(bar);

  const nameEl = bar.querySelector(".tb-name");
  const metaEl = bar.querySelector(".pedon-mark .meta");
  const designBtn = bar.querySelector(".tb-design");
  const siteBtn = bar.querySelector(".tb-site");
  siteBtn.onclick = ev => onSite?.(ev);

  // VIEWPORT CONTROLS, not actions. They change how you are looking rather than
  // what exists, so by the dock/panel rule (docktools.js) they belong neither on
  // the action dock nor in the management panel — they sit with the other chrome
  // that is about the view itself.
  bar.querySelector(".tb-cam").onclick = ev => onCamera?.(ev);
  bar.querySelector(".tb-undo").onclick = () => onUndo?.();
  bar.querySelector(".tb-redo").onclick = () => onRedo?.();
  bar.querySelector(".tb-k").onclick = () => onPalette?.();
  bar.querySelector(".tb-more").onclick = ev => onOverflow?.(ev);
  const warnEl = bar.querySelector(".tb-warn");
  designBtn.onclick = ev => onDesignMenu?.(ev);

  return {
    element: bar,
    /**
     * Say out loud that this property is not calibrated.
     *
     * BESIDE THE DESIGN NAME, not inside a menu. An uncalibrated capture makes
     * every design on it wrong in the one way nothing downstream can detect —
     * the coordinates are all self-consistent and all rotated — so it has to be
     * where the user is already looking rather than somewhere they have to ask.
     * `sun.py` refuses a bearing for the same reason; this is that refusal made
     * visible.
     */
    setWarning(w) {
      warnEl.hidden = !w;
      if (!w) return;
      warnEl.textContent = w.text;
      warnEl.title = w.title ?? "";
      warnEl.onclick = () => w.onClick?.();
    },
    /**
     * `previewing` is not cosmetic. While an agent has the viewer on its own
     * scratch file every hand edit is refused, and the one thing that must never
     * happen is the owner editing confidently into a file that is not theirs. So it
     * is stated here, in the one place they are always looking.
     */
    setDesign({ name, previewing, dirty } = {}) {
      nameEl.textContent = name || "untitled";
      designBtn.classList.toggle("previewing", !!previewing);
      designBtn.classList.toggle("dirty", !!dirty);
      designBtn.title = previewing
        ? `previewing ${name} — this is NOT your working design and edits are held`
        : `editing ${name}`;
    },
    /**
     * WHICH SITE. Name the active site in the one place the user is always looking
     * to prevent editing a design on the wrong site. Hidden until there is a name.
     */
    setSite(name) {
      siteBtn.hidden = !name;
      siteBtn.querySelector(".tb-site-name").textContent = name ?? "";
    },
    /** where you are in the edit history, so undo is not a leap of faith */
    setHistory(text) { bar.querySelector(".tb-pos").textContent = text ?? ""; },
    /** the metric readout beside the mark: an instrument, not a logo */
    setMeta(text) { metaEl.textContent = text ?? ""; },
  };
}
