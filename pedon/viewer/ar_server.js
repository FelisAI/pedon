// THE PHONE'S WAY IN — a read-only server for data/ar, and nothing else.
//
// The phone must show the design on the real site. The dev server listens on
// [::1] only, and changing it to listen on the network with
// `server: { host: true }` would put /api/ops, /api/delete and POST /api/site on the
// whole Wi-Fi: anyone could edit the design or overwrite the owner's markers.
//
// So the phone gets its OWN door: design USDZ files, the current alignment scan,
// current export metadata and one page that opens the design in AR Quick Look. GET and HEAD only; a name
// must be a bare `something.usdz` that exists in that folder; everything else is a
// 404. There is no write path to open, because there is no write path here at all.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const AR_PORT = 5179;
const USDZ = /^[\w][\w.-]*\.usdz$/;

/** The USDZ files on offer, newest first: [{ name, bytes, mtime_ms }]. */
export function arFiles(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter(n => USDZ.test(n) && !n.endsWith(".scan.usdz")).map(n => {
    const st = fs.statSync(path.join(dir, n));
    return { name: n, bytes: st.size, mtime_ms: st.mtimeMs };
  }).sort((a, b) => b.mtime_ms - a.mtime_ms);
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ago = ms => {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 2 ? "just now" : m < 90 ? `${m} minutes ago` : m < 2880 ? `${Math.round(m / 60)} hours ago` : `${Math.round(m / 1440)} days ago`;
};

/** What the export wrote about a file (tools/ar_export.py): its design, plants and
 *  landmarks. Beside it as `<name>.json`; null when the metadata is unavailable. */
export function arInfo(dir, name) {
  if (!USDZ.test(name ?? "")) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dir, name.replace(/\.usdz$/, ".json")), "utf8")); }
  catch { return null; }
}

const spoken = n => String(n ?? "").replace(/_/g, " ");

/** The page the phone opens. `rel="ar"` with an <img> inside is what makes iOS hand
 *  the link to AR Quick Look instead of downloading it, and
 *  `#allowsContentScaling=0` is the 1:1 requirement: without it a pinch rescales the
 *  garden, and a garden at 93% looks entirely plausible and is a different garden.
 *  ONE file is offered — the newest — named by its design, so the user knows what
 *  they are opening. Generate the export when the user opens the AR action. */
export function arPage(files, { info = null, making = false } = {}) {
  const f = files[0];
  const what = info ? `${esc(info.design_name ?? "this design")} · ${info.plants} plants` : esc(f?.name.replace(/\.usdz$/, "") ?? "");
  const row = f ? `
    <a class="ar" rel="ar" href="/${encodeURIComponent(f.name)}#allowsContentScaling=0">
      <img alt="${esc(f.name)}" width="1" height="1"
           src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==">
      <b>See it on site</b>
      <span>${what} · ${(f.bytes / 1e6).toFixed(0)} MB · made ${ago(f.mtime_ms)}</span>
    </a>` : "";
  const busy = making ? `<p class="busy">A new one is being made on the Mac — reload this page in half a minute.</p>` : "";
  const start = info?.origin ? `<b>${esc(spoken(info.origin))}</b>` : "the red post's spot";
  const turn = info?.second
    ? `<li>Turn it with two fingers until the <b>${esc(spoken(info.second))}</b> post stands on the real ${esc(spoken(info.second))}${info.apart_m ? ` (${esc(info.apart_m)} m away)` : ""}.</li>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PEDON — see it on site</title>
<style>
  body{margin:0;padding:28px 20px;background:#15130f;color:#e9e2d3;font:17px/1.45 -apple-system,system-ui,sans-serif}
  h1{font-size:15px;letter-spacing:.14em;margin:0 0 22px;color:#d98e5f}
  a.ar{display:block;padding:20px;margin:0 0 14px;border-radius:14px;background:#d98e5f;color:#15130f;text-decoration:none}
  a.ar b{display:block;font-size:22px} a.ar span{font-size:14px;opacity:.8} a.ar img{display:none}
  ol{padding-left:20px;color:#b9b09c} li{margin:0 0 10px} li b{color:#e9e2d3} p{color:#b9b09c} p.busy{color:#f0c27a}
</style></head><body>
<h1>◈ PEDON</h1>
${busy}${row || "<p>Nothing to show yet. On the Mac: ··· → See it on site. It is made from the design on screen when you open that.</p>"}
<ol>
  <li>Stand at ${start} and tap the button.</li>
  <li>If it opens small, on a plain background, tap <b>AR</b> at the top.</li>
  <li>Point at the ground and drag the garden until the red <b>start here</b> post stands on that spot.</li>
  ${turn}
  <li>Walk through it. Every plant is at its full-grown size, standing where it goes in the ground.</li>
</ol>
<p>iPhone or iPad, in Safari, on the same Wi-Fi as the Mac.</p>
</body></html>`;
}

/** (req, res) for the phone's server. Exported so it is tested without a socket. */
export function arRequestHandler(dir, status = () => ({})) {
  return (req, res) => {
    const send = (code, type, body) => {
      res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, "text/plain", "read-only");
    let name;
    try { name = decodeURIComponent(new URL(req.url, "http://x").pathname.slice(1)); }
    catch { return send(400, "text/plain", "bad request"); }
    // FOR THE PHONE APP: which file is current and what it says about itself —
    // design, plants, and every landmark's place in the file's frame, which is what the
    // app lines the garden up by. Read-only like everything else here.
    if (name === "current.json") {
      const f = arFiles(dir)[0] ?? null;
      return send(200, "application/json", JSON.stringify(f ? { ...f, info: arInfo(dir, f.name),
                                                                  making: !!status()?.making } : { making: !!status()?.making }));
    }
    if (name === "" || name === "index.html") {
      const files = arFiles(dir);
      return send(200, "text/html; charset=utf-8",
                  arPage(files, { info: arInfo(dir, files[0]?.name), making: !!status()?.making }));
    }
    // a BARE file name that is really in the folder — never a path, so there is no
    // traversal to get wrong
    const files = arFiles(dir);
    const scan = arInfo(dir, files[0]?.name)?.scan?.file;
    if (!USDZ.test(name) || (!files.some(f => f.name === name) && name !== scan)) return send(404, "text/plain", "not here");
    try { if (!fs.statSync(path.join(dir, name)).isFile()) return send(404, "text/plain", "not here"); }
    catch { return send(404, "text/plain", "not here"); }
    const file = path.join(dir, name);
    const size = fs.statSync(file).size;
    res.writeHead(200, { "Content-Type": "model/vnd.usdz+zip", "Content-Length": size,
                         "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  };
}

/** Where the phone should go: this Mac's LAN addresses, the `.local` name first
 *  because it survives the router handing out a new IP. */
export function lanUrls(port = AR_PORT) {
  const out = [];
  const host = os.hostname().replace(/\.local$/i, "");
  if (host) out.push(`http://${host.toLowerCase()}.local:${port}/`);
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list ?? [])
      if (a.family === "IPv4" && !a.internal) out.push(`http://${a.address}:${port}/`);
  return out;
}

/**
 * Start it — ONCE PER PROCESS. Never throws: a port in use costs the phone its door,
 * not the viewer.
 *
 * Vite re-runs its config on every restart (an edit to vite.config.js, a changed
 * lockfile) inside the same Node process. Starting a new server before the old one
 * releases the port causes EADDRINUSE; closing the old one then leaves no listener.
 * The server lives on `globalThis`, outlives Vite's restarts, and is handed back
 * so the phone keeps its connection point.
 */
/** Close the phone's door on `port`, if this process opened it — or is still trying to. */
export function stopArServer(port = AR_PORT) {
  const slot = globalThis.__pedonArServers;
  const had = slot?.get(port);
  if (!had) return false;
  had.stopped = true;   // a retry still waiting for the port must not open the door after this
  if (had.server.listening) had.server.close();
  slot.delete(port);
  return true;
}

/**
 * Wait until the door on `port` has opened or given up: { open, err }. Opening is not instant —
 * the port may still be held by a server that is closing — and a door that did not open says
 * why, instead of leaving a button that does nothing when clicked.
 */
export async function arServerSettled(port = AR_PORT, ms = 5000) {
  const e = globalThis.__pedonArServers?.get(port);
  for (const t0 = Date.now(); e?.trying && Date.now() - t0 < ms; ) await new Promise(r => setTimeout(r, 50));
  if (e?.server.listening) return { open: true, err: null };
  return { open: false, err: e?.error ?? (e ? "it did not start in time" : "it was not started") };
}

/** Whether the phone's door is listening on `port` in this process. */
export function arServerListening(port = AR_PORT) {
  return !!globalThis.__pedonArServers?.get(port)?.server.listening;
}

export function startArServer(dir, port = AR_PORT, status = () => ({})) {
  const slot = (globalThis.__pedonArServers ??= new Map());
  const had = slot.get(port);
  // `dir` may be a function: the active project's data/ar, looked up per request
  const serve = e => (req, res) => arRequestHandler(typeof e.dir === "function" ? e.dir() : e.dir, e.status)(req, res);
  if (had?.server.listening || had?.trying) {
    had.dir = dir; had.status = status;
    // Use THIS MODULE'S CODE. A restart loads this file afresh but finds the old
    // server still listening. Replace its request handler so module edits reach
    // the phone without a process restart.
    had.server.removeAllListeners("request");
    had.server.on("request", serve(had));
    return had.server;
  }
  const entry = { dir, status, server: null, trying: true, error: null, stopped: false };
  entry.server = http.createServer(serve(entry));
  let tries = 0;
  entry.server.on("error", e => {
    if (e.code === "EADDRINUSE" && ++tries <= 8 && !entry.stopped) {
      setTimeout(() => { if (!entry.stopped) entry.server.listen(port, "0.0.0.0"); }, 400);
      return;
    }
    entry.trying = false;
    entry.error = e.code === "EADDRINUSE"
      ? `port ${port} is already in use — is another PEDON viewer running on this Mac?`
      : String(e.code ?? e.message);
    console.warn(`[ar] the phone's server did not start on :${port} — ${entry.error}`);
  });
  entry.server.on("listening", () => {
    entry.trying = false;
    console.log(`  ➜  Phone (AR, read-only): ${lanUrls(entry.server.address().port)[0] ?? `http://<this mac>:${port}/`}`);
  });
  entry.server.listen(port, "0.0.0.0");
  slot.set(port, entry);
  return entry.server;
}
