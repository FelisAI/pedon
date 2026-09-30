// THE DEV SERVER'S TWO RULES FOR A REQUEST, one copy each: who may write, and how much it
// may send. vite.config.js's endpoints use them; tests import them to run a route's own source.

// A REQUEST'S BODY, at most `limit` bytes: the bytes, or null with a 413 already answered. One
// reader for every endpoint, so none can read a body without a limit.
export function readBody(req, res, limit, tooLarge = "body too large") {
  return new Promise(resolve => {
    const chunks = [];
    let size = 0, over = false;
    req.on("data", c => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true;
        res.statusCode = 413; res.end(JSON.stringify({ ok: false, error: tooLarge }));
        req.destroy();
        resolve(null);
      } else chunks.push(c);
    });
    req.on("end", () => { if (!over) resolve(Buffer.concat(chunks)); });
  });
}

// WHO MAY WRITE. A page on another site, open in the owner's browser, can POST here — a form
// or a fetch — and every endpoint that takes one writes, renders or runs a tool. So each refuses a request
// that does not come from this viewer's own page; the tools (broker.py) send its origin too. One
// copy of the rule, so no endpoint can go without it.
export const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
export function refuseForeign(req, res) {
  if (LOCAL_ORIGIN.test(req.headers.origin ?? "")) return false;
  res.statusCode = 403; res.end(JSON.stringify({ ok: false, error: "bad origin" }));
  return true;
}
