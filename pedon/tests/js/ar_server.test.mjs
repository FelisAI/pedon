// node --test tests/js/ar_server.test.mjs
//
// THE PHONE'S DOOR IS READ-ONLY, AND IT OPENS ONTO ONE FOLDER.
//
// The goal is a phone that can view the design on the real site. The cheap way
// is `server: { host: true }`, which puts /api/ops,
// /api/delete and POST /api/site on the whole Wi-Fi. This server exists so that is
// never the answer — so what is tested is mostly what it REFUSES.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { arRequestHandler, arFiles, arInfo, arPage, lanUrls, startArServer, stopArServer, arServerSettled, AR_PORT } from "../../viewer/ar_server.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A folder shaped like data/ar, with a secret beside it that must never be served. */
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pedon-ar-"));
  const dir = path.join(base, "ar");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "yard.usdz"), Buffer.from("PK-usdz-bytes"));
  fs.writeFileSync(path.join(dir, "notes.txt"), "not a model");
  fs.writeFileSync(path.join(base, "site.json"), '{"secret":true}');
  fs.writeFileSync(path.join(base, "sneaky.usdz"), "outside the folder");
  // the file being made: half of a model, which must never reach a phone
  fs.mkdirSync(path.join(dir, ".making"));
  fs.writeFileSync(path.join(dir, ".making", "yard.usdz"), "half a model");
  return dir;
}
function ask(dir, method, url, status) {
  return new Promise(resolve => {
    const chunks = [];
    const res = { code: 0, headers: {},
      writeHead(c, h) { this.code = c; this.headers = h; },
      write(b) { chunks.push(Buffer.from(b)); return true; },
      end(b) { if (b) chunks.push(Buffer.from(b)); resolve({ code: this.code, headers: this.headers, body: Buffer.concat(chunks).toString() }); },
      on() { return this; }, once() { return this; }, emit() { return true; } };
    arRequestHandler(dir, status)({ method, url }, res);
  });
}

test("it serves the model, as the type that makes iOS open AR Quick Look", async () => {
  const got = await ask(fixture(), "GET", "/yard.usdz");
  assert.equal(got.code, 200);
  assert.equal(got.headers["Content-Type"], "model/vnd.usdz+zip");
  assert.equal(got.body, "PK-usdz-bytes");
});

test("it writes NOTHING: every method but GET and HEAD is refused", async () => {
  const dir = fixture();
  for (const m of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"])
    for (const url of ["/yard.usdz", "/", "/api/ops", "/api/delete", "/api/site"])
      assert.equal((await ask(dir, m, url)).code, 405, `${m} ${url} was not refused`);
});

test("nothing but a USDZ that is really in the folder — no paths, no APIs, no other files", async () => {
  const dir = fixture();
  for (const url of ["/../site.json", "/..%2Fsite.json", "/%2e%2e/site.json", "/../sneaky.usdz", "/..%2Fsneaky.usdz",
                     "/notes.txt", "/api/ops", "/api/site", "/data/site.json", "/data/design.json", "/src/main.js",
                     "/ar/yard.usdz", "/nope.usdz", "/.usdz", "/.making/yard.usdz", "/.making%2Fyard.usdz"]) {
    const got = await ask(dir, "GET", url);
    assert.equal(got.code, 404, `GET ${url} answered ${got.code}: ${got.body.slice(0, 40)}`);
    assert.ok(!got.body.includes("secret") && !got.body.includes("outside the folder"));
  }
  // a URL that NORMALISES to the root is the index page, and only that
  const root = await ask(dir, "GET", "/yard.usdz/..");
  assert.equal(root.code, 200);
  assert.match(root.headers["Content-Type"], /text\/html/);
  assert.ok(!root.body.includes("secret"));
});

test("the page hands the link to Quick Look at TRUE SIZE", async () => {
  const got = await ask(fixture(), "GET", "/");
  assert.equal(got.code, 200);
  assert.match(got.headers["Content-Type"], /text\/html/);
  // rel="ar" with an <img> child is what iOS requires to open the viewer rather than download
  assert.match(got.body, /<a class="ar" rel="ar" href="\/yard\.usdz#allowsContentScaling=0">\s*<img /);
  // 1:1 is the whole requirement: a pinch must not be able to rescale the garden
  assert.ok(got.body.includes("#allowsContentScaling=0"));
  assert.ok(!got.body.includes("notes.txt"), "the page lists a file that is not a model");
  assert.ok(!got.body.includes("half a model") && !got.body.includes(".making"), "the page offers a file still being made");
  assert.match(arPage([]), /Nothing to show yet[\s\S]*See it on site/, "an empty folder must say what to do, not show a blank page");
});

test("the page says WHICH design it is and where to stand — and nothing about a scan", async () => {
  // A page that offers "yard · 32 MB · made 5 hours ago" gives a file with no name,
  // made from an unknown design; the page must name the design it shows.
  const dir = fixture();
  const info = { design_source: "data/design.json", design_name: "huajing_J_sunroom", plants: 159,
                 origin: "side_yard_hedge_row", second: "south_fence_east_corner", apart_m: 15.7 };
  fs.writeFileSync(path.join(dir, "yard.json"), JSON.stringify(info));
  // an older file beside it: only the newest is the garden
  const older = path.join(dir, "old.usdz");
  fs.writeFileSync(older, "x");
  fs.utimesSync(older, new Date(0), new Date(0));
  assert.deepEqual(arInfo(dir, "yard.usdz"), info);
  assert.equal(arInfo(dir, "../site.json"), null, "the sidecar reader takes a path");
  const page = (await ask(dir, "GET", "/")).body;
  assert.match(page, /huajing_J_sunroom · 159 plants/);
  assert.match(page, /Stand at <b>side yard hedge row<\/b>/);
  assert.match(page, /<b>south fence east corner<\/b> post stands on the real south fence east corner \(15\.7 m away\)/);
  assert.match(page, /tap <b>AR<\/b> at the top/, "Quick Look opens as a small model first; the user must be told how to get to AR");
  assert.ok(!/scan|ghost|fence lies/i.test(page), "the page talks about the scan, which the AR file does not contain");
  assert.equal((page.match(/rel="ar"/g) ?? []).length, 1, "more than one file offered: which one is the garden?");
  // the phone app reads the same thing as JSON, landmarks and all
  const cur = JSON.parse((await ask(dir, "GET", "/current.json")).body);
  assert.equal(cur.name, "yard.usdz", "the app is pointed at an older file");
  assert.equal(cur.info.origin, "side_yard_hedge_row");
  assert.equal(JSON.parse((await ask(dir, "GET", "/current.json", () => ({ making: true }))).body).making, true);
  assert.equal((await ask(dir, "POST", "/current.json")).code, 405);
  // while a new one is being made, the page says so rather than passing the old one off as current
  assert.match((await ask(dir, "GET", "/", () => ({ making: true }))).body, /being made on the Mac/);
  assert.ok(!/being made/.test(page));
});

test("the newest file comes first, and the address the phone is given is a LAN one", () => {
  const dir = fixture();
  const later = path.join(dir, "newer.usdz");
  fs.writeFileSync(later, "x");
  fs.utimesSync(later, new Date(), new Date(Date.now() + 60000));
  assert.deepEqual(arFiles(dir).map(f => f.name), ["newer.usdz", "yard.usdz"]);
  const urls = lanUrls();
  assert.ok(urls.length >= 1 && urls.every(u => u.endsWith(`:${AR_PORT}/`)), `${urls}`);
  assert.ok(!urls.some(u => /localhost|127\.0\.0\.1|\[::1\]/.test(u)), "a loopback address is useless to a phone");
  assert.match(urls[0], /\.local:/, "the .local name goes first: it survives the router handing out a new IP");
});

test("the dev server itself is NOT opened to the network to make this work", () => {
  const cfg = fs.readFileSync(path.join(ROOT, "viewer", "vite.config.js"), "utf8");
  const code = cfg.split("\n").filter(l => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  assert.ok(!/host:\s*(true|"0\.0\.0\.0"|'0\.0\.0\.0')/.test(code),
    "vite is listening on the LAN — /api/ops, /api/delete and POST /api/site are now reachable from every device on the Wi-Fi");
});

test("a dev-server restart does not cost the phone its door", async () => {
  // Vite re-runs its config in the same process on every restart. Started afresh each
  // time, the new server hits EADDRINUSE while the old one is still closing, then the
  // old one shuts — and nothing is listening. It shows only when fetched over the LAN
  // address AFTER an unrelated config edit.
  const dir = fixture();
  const first = startArServer(dir, 0);
  await new Promise(r => first.once("listening", r));
  const port = first.address().port;
  assert.ok(port > 0);
  const again = startArServer(fixture(), 0);          // "restart": same process, same port key
  assert.ok(again === first, "a second start made a second server — the pair races for the port");
  assert.ok(first.listening, "the restart closed the door");
  const got = await fetch(`http://127.0.0.1:${port}/yard.usdz`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "model/vnd.usdz+zip");
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/ops`, { method: "POST" })).status, 405);
  await new Promise(r => first.close(r));
});

test("a restart puts the NEW code behind the door, not just the old server back", async () => {
  // The server outlives Vite's restarts, and so does its handler unless it is swapped:
  // a running server keeps calling the module that started it, so a changed page never
  // reaches the phone. Simulated here as an older module's server already listening
  // in the slot.
  const http = await import("node:http");
  const stale = http.createServer((req, res) => { res.writeHead(200); res.end("OLD PAGE: slide the ghost fence"); });
  await new Promise(r => stale.listen(0, "127.0.0.1", r));
  const port = stale.address().port;
  (globalThis.__pedonArServers ??= new Map()).set(port, { dir: fixture(), server: stale });
  try {
    const again = startArServer(fixture(), port, () => ({ making: true }));
    assert.ok(again === stale, "a second server was started to race the first for the port");
    const body = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.ok(!body.includes("OLD PAGE"), "the restarted server still runs the old module's code");
    assert.match(body, /being made on the Mac/, "the new status is not read");
  } finally {
    // closed whatever happened: a failure here must fail the suite, not hang it
    stale.closeAllConnections();
    await new Promise(r => stale.close(r));
    globalThis.__pedonArServers.delete(port);
  }
});

test("a door that cannot get its port SAYS so, and one closed while it waits stays closed", async () => {
  // the port taken by another program (a second PEDON viewer): the click that opens the door
  // must end in a reason, not a button that does nothing — and a door the user closed while it
  // was still retrying must not open by itself when the port comes free
  const http = await import("node:http");
  const holder = http.createServer();
  await new Promise(r => holder.listen(0, "0.0.0.0", r));
  const port = holder.address().port;
  let late = null;
  try {
    startArServer(fixture(), port);
    const { open, err } = await arServerSettled(port, 8000);
    assert.equal(open, false);
    assert.match(err ?? "", /already in use/, "a door that did not open gave no reason");
    stopArServer(port);
    late = startArServer(fixture(), port);
    await new Promise(r => setTimeout(r, 100));        // its first try failed; a retry is waiting
    stopArServer(port);
    await new Promise(r => holder.close(r));
    await new Promise(r => setTimeout(r, 900));        // past the retry
    const answered = await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false);
    assert.equal(answered, false, "a door closed while it waited for its port opened anyway");
  } finally {
    // closed whatever happened: a door that opened by mistake must fail the suite, not hang it
    if (holder.listening) await new Promise(r => holder.close(r));
    if (late?.listening) { late.closeAllConnections(); await new Promise(r => late.close(r)); }
  }
});

test("the original scan is a separate alignment reference, never the newest design", async () => {
  const dir = fixture();
  fs.writeFileSync(path.join(dir, "reference.scan.usdz"), "original capture");
  fs.writeFileSync(path.join(dir, "stale.scan.usdz"), "old capture");
  fs.writeFileSync(path.join(dir, "yard.json"), JSON.stringify({scan: {file: "reference.scan.usdz"}}));
  assert.deepEqual(arFiles(dir).map(f => f.name), ["yard.usdz"]);
  const cur = JSON.parse((await ask(dir, "GET", "/current.json")).body);
  assert.equal(cur.name, "yard.usdz");
  assert.equal((await ask(dir, "GET", "/reference.scan.usdz")).body, "original capture");
  assert.equal((await ask(dir, "GET", "/stale.scan.usdz")).code, 404);
});
