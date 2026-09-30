// THE FIRST SCREEN. Without it a fresh install opens on an empty grid, a red "design.json: 404"
// and nothing that says what to do. With no site, the page says what PEDON is and offers the two ways
// in: the demo garden (made by code, tools/demo_site.py) or a site of your own. The requests are
// the caller's — main.js owns /api/projects — so this only draws and reports the choice.

/** Whether a first screen is due: no site is active, and there is no design to draw. */
export function welcomeDue({ site, designMissing }) {
  return !site && !!designMissing;
}

/**
 * Show the first screen. `onDemo()` and `onNew(name)` do the work and resolve true when the page
 * is about to reload; false leaves the screen up to try again. Returns the element (for tests).
 */
export function showWelcome({ onDemo, onNew, doc = document }) {
  if (doc.getElementById("pWelcome")) return doc.getElementById("pWelcome");
  const el = doc.createElement("div");
  el.id = "pWelcome";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-labelledby", "welTitle");
  el.innerHTML = `
    <div class="wel-scrim"></div>
    <div class="wel-box">
      <div class="wel-mark pedon-mark" id="welTitle">PEDON</div>
      <p class="wel-lede">Design a garden on a scan of the real ground — measured in metres, checked
        against the slope, the house and the sun.</p>
      <button class="wel-choice" id="welDemo" type="button">
        <span class="wel-choice-title">Open the demo garden</span>
        <span class="wel-choice-hint">A made-up sloping garden with a house, a patio and a starter bed — ready to try.</span>
      </button>
      <div class="wel-choice wel-own">
        <span class="wel-choice-title">Start your own site</span>
        <span class="wel-choice-hint">Name it, then load a scan of your ground (a GLB or splat from a phone
          scanning app); the top bar lists what is left to set up — the ground's level, and north.</span>
        <span class="wel-row">
          <input id="welName" class="wel-input" placeholder="a name — your street, or “front garden”" maxlength="80" />
          <button id="welCreate" class="wel-go" type="button">Start</button>
        </span>
      </div>
      <p class="wel-foot">Your sites and everything you make for them — plant models, photos, the plant
        list — stay on this computer, in folders you own (~/PEDON).</p>
    </div>`;
  doc.body.appendChild(el);
  const busy = on => el.querySelectorAll("button, input").forEach(b => { b.disabled = on; });
  el.querySelector("#welDemo").addEventListener("click", async () => {
    busy(true);
    if (!await onDemo()) busy(false);
  });
  const create = async () => {
    const name = el.querySelector("#welName").value.trim();
    if (!name) { el.querySelector("#welName").focus(); return; }
    busy(true);
    if (!await onNew(name)) busy(false);
  };
  el.querySelector("#welCreate").addEventListener("click", create);
  el.querySelector("#welName").addEventListener("keydown", ev => { if (ev.key === "Enter") create(); });
  return el;
}
