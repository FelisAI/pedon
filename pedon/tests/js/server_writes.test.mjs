// WHO MAY WRITE. Every endpoint the dev server takes a POST on writes a file, runs a tool or
// queues a render — and any page on another site, open in the owner's browser, can POST to
// localhost. So each refuses a request that does not come from the viewer's own page, FIRST,
// through the one rule (refuseForeign in viewer/vite.config.js) — not a copy of the check per
// endpoint, where copies drift and an endpoint can be left with none.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CFG = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "viewer", "vite.config.js"), "utf8");

/** Each POST handler: its url(s), and its first statements with comments dropped. */
function postHandlers(src) {
  const out = [];
  for (const m of src.matchAll(/if \(([^\n]*url === "\/api\/[^\n]*)\) \{\n/g)) {
    if (!/POST/.test(m[1])) continue;
    const body = src.slice(m.index + m[0].length, m.index + m[0].length + 1500)
      .split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("//"));
    out.push({ urls: [...m[1].matchAll(/"(\/api\/[^"]+)"/g)].map(u => u[1]), body });
  }
  return out;
}

test("the handler reader finds the POST endpoints, and one that skips the check", () => {
  const found = postHandlers(CFG).flatMap(h => h.urls);
  for (const u of ["/api/ops", "/api/save", "/api/view/request", "/api/view/result", "/api/projects"])
    assert.ok(found.includes(u), `${u} not read — the reader is broken`);
  const doctored = 'if (req.method === "POST" && url === "/api/x") {\n  run(req);\n}';
  assert.equal(postHandlers(doctored)[0].body[0], "run(req);");
});

test("every POST endpoint refuses a foreign page before it reads or runs anything", () => {
  for (const h of postHandlers(CFG)) {
    const first = h.body.findIndex(l => /refuseForeign\(req, res\)/.test(l));
    assert.equal(first, 0, `${h.urls}: ${h.body.slice(0, 3).join(" ⏎ ")}`);
    assert.ok(!h.body.slice(0, first).some(l => /req\.on\(|execFile|writeFile/.test(l)), `${h.urls} acts before the check`);
  }
});

test("the rule is written once, and it refuses what it must", async () => {
  const { refuseForeign, readBody } = await import("../../viewer/server_http.js");
  assert.equal((CFG.match(/bad origin|req\.headers\.origin|req\.on\("data"/g) ?? []).length, 0,
    "vite.config.js spells out a check or a body reader of its own again");
  const answer = () => ({ statusCode: 200, body: null, end(b) { this.body = b; } });
  for (const [origin, refused] of [["http://localhost:5178", false], ["http://127.0.0.1:5199", false],
                                   ["http://evil.example", true], [undefined, true],
                                   ["http://localhost.evil.example", true]]) {
    const res = answer();
    assert.equal(refuseForeign({ headers: origin ? { origin } : {} }, res), refused, String(origin));
    if (refused) assert.equal(res.statusCode, 403);
  }
  const { EventEmitter } = await import("node:events");
  const big = new EventEmitter(); big.destroy = () => {};
  const res = answer();
  const got = readBody(big, res, 10);
  big.emit("data", Buffer.alloc(11));
  assert.equal(await got, null);
  assert.equal(res.statusCode, 413);
});
