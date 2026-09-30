// "See it on site" — the way from the viewer to the phone.
//
// Opening this IS the ask. Nothing is generated before the user asks for it, and a file
// made hours earlier is never offered to the phone as if it were the garden. The sheet
// makes the file from the design on screen the moment it opens, unless the one on disk
// is already of that design and newer than it, and says which design it is, how many
// plants, and where to stand.

/** "just now" / "12 minutes ago" / "3 days ago" — and nothing finer, it is a label. */
export function madeAgo(mtimeMs, now = Date.now()) {
  const m = Math.round((now - mtimeMs) / 60000);
  if (m < 2) return "just now";
  if (m < 90) return `${m} minutes ago`;
  if (m < 2880) return `${Math.round(m / 60)} hours ago`;
  return `${Math.round(m / 1440)} days ago`;
}

const bare = p => String(p ?? "").replace(/^\//, "");

/**
 * Is the file on offer the design on screen, as it is now? Only if it was made FROM
 * that design, and after the design last changed. Not knowing is not current: a file
 * with no record of its design is made again.
 */
export function isCurrent(info) {
  const file = info?.files?.[0], ar = info?.ar;
  if (!file || !ar || !("scan" in ar)) return false;
  if (bare(ar.design_source) !== bare(info.source ?? "data/design.json")) return false;
  return !Number.isFinite(info.source_mtime_ms) || file.mtime_ms >= info.source_mtime_ms;
}

/** What the sheet says about the file on offer, in the user's words. */
export function readyLine(info, now = Date.now()) {
  const file = info?.files?.[0], ar = info?.ar;
  if (!file || !ar) return "";
  return `${ar.design_name ?? "this design"} · ${ar.plants} plants · ${(file.bytes / 1e6).toFixed(0)} MB · made ${madeAgo(file.mtime_ms, now)}`;
}

/** What makes a good pair of marks. The app lets the user pick them on the original scan. */
export function standLine(ar) {
  if (!ar?.scan) return "";
  // the user picks the marks, so the sheet only says what makes a good pair
  return "Pick two existing features far apart on the original scan — paving corners or fixed posts are easier to match on site.";
}

export function mountArSheet({ notify = () => {}, source = () => "data/design.json", name = () => "" } = {}) {
  const el = document.createElement("div");
  el.id = "pArSheet";
  el.hidden = true;
  // QUICK LOOK FIRST: any iPhone opens the file from Safari, no app needed. It lands wherever the
  // phone finds ground and is lined up by hand. The PEDON app, where it is installed, lines it up
  // from two marked points instead. Phones reach this Mac through the PHONE'S DOOR, which is shut
  // until the user opens it here, and remembered for this machine.
  el.innerHTML = `
    <header><b>See it on site</b><button class="x" title="close">✕</button></header>
    <p class="file"></p>
    <div class="door" hidden>
      <p>A phone on this Wi-Fi can view the design and its original scan from this Mac.
        It is off until you open it.</p>
      <button class="door-open">Let phones on this Wi-Fi see it</button>
      <p class="door-err"></p>
    </div>
    <div class="reach">
      <div class="qr" aria-label="QR code for the phone"></div>
      <p class="url"></p>
      <p>On the iPhone, same Wi-Fi as this Mac: scan the code with the camera. Safari opens the
        garden at true size wherever the phone finds ground; line it up by hand.</p>
      <details class="app"><summary>With the PEDON iPhone app</summary>
        <ol>
          <li>Open <b>PEDON</b>. In Settings, enter this Mac’s address shown above. It remembers your connection.</li>
          <li>On the original 3D scan, tap two existing features you can find on site — paving corners or fixed posts. Mark each on the real ground; the design locks in place at true size.</li>
          <li>Walk through it: every plant at full size, where it goes in the ground.</li>
        </ol>
        <p class="stand"></p>
      </details>
      <button class="door-close" title="phones on this Wi-Fi can no longer fetch it">Close the phone door</button>
    </div>`;
  document.body.appendChild(el);
  const $ = s => el.querySelector(s);
  const hide = () => { el.hidden = true; };
  $(".x").onclick = hide;
  addEventListener("keydown", ev => { if (!el.hidden && ev.key === "Escape") { ev.stopPropagation(); hide(); } }, true);
  let making = null;

  async function door(open) {
    const button = $(open ? ".door-open" : ".door-close");
    button.disabled = true;
    $(".door-err").textContent = "";
    let r = null;
    try {
      r = await (await fetch("/api/ar/door", { method: "POST", headers: { "Content-Type": "application/json" },
                                               body: JSON.stringify({ open }) })).json();
    } catch { /* dev server down: refresh says so */ }
    button.disabled = false;
    await refresh();
    // opening can fail — the port taken by another program — and a click that changes nothing
    // must say why
    if (open && r && !r.ok) $(".door-err").textContent = `It did not open: ${r.err ?? "no reason given"}`;
  }
  $(".door-open").onclick = () => door(true);
  $(".door-close").onclick = () => door(false);

  async function refresh() {
    let info = null;
    try { info = await (await fetch(`/api/ar?source=${encodeURIComponent(bare(source()))}`)).json(); }
    catch { /* dev server down */ }
    $(".door").hidden = !!info?.door;
    $(".reach").hidden = !info?.door;
    // our own dev server's SVG — the one place innerHTML takes markup here
    $(".qr").innerHTML = info?.qr_svg ?? "";
    $(".url").textContent = info?.urls?.[0]
      ? `or type ${info.urls[0].replace(/^http:\/\//, "").replace(/\/$/, "")} into Safari`
      : "this Mac has no address on the network — is Wi-Fi on?";
    if (!making) {
      $(".file").textContent = isCurrent(info) ? `Ready — ${readyLine(info)}` : "";
      $(".file").classList.toggle("stale", false);
    }
    $(".stand").textContent = standLine(info?.ar);
    return info;
  }

  function make() {
    if (making) return making;
    const started = Date.now();
    const tick = () => { $(".file").textContent = `Making it from ${name() || "the design on screen"}… ${Math.round((Date.now() - started) / 1000)} s (about 40)`; };
    tick();
    const timer = setInterval(tick, 1000);
    making = (async () => {
      let r = null;
      try {
        r = await (await fetch(`/api/ar/export?name=${encodeURIComponent(name() || "")}`, { method: "POST" })).json();
      } catch (e) { r = { ok: false, err: String(e) }; }
      clearInterval(timer);
      making = null;
      if (r?.ok) notify("ready — open it on your phone", "ok");
      else {
        const why = (r?.err || r?.out || "no reply").trim().split("\n").pop();
        $(".file").textContent = `It was not made: ${why}`;
        $(".file").classList.add("stale");
        notify(`the AR file was not made: ${why}`, "err");
        return r;
      }
      await refresh();
      return r;
    })();
    return making;
  }

  return { element: el, isOpen: () => !el.hidden, hide,
           async show() {
             el.hidden = false;
             const info = await refresh();
             // opening it is asking for it: make it now, unless what is on disk is
             // already this design as it stands
             if (!isCurrent(info)) make();
           } };
}
