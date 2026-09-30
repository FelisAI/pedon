// node --test tests/js/server_children.test.mjs
//
// What the dev server starts — the AR export, a render, the design agent — talks back to a
// viewer through tools/broker.py, which defaults to :5178. Run on another port without passing
// its own address on, the server's own exports would be answered by whatever viewer holds
// :5178: another site's page.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const codeOnly = s => s.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

test("the dev server tells everything it starts which viewer it is", () => {
  const cfg = codeOnly(fs.readFileSync(path.join(ROOT, "viewer", "vite.config.js"), "utf8"));
  assert.match(cfg, /server\.httpServer\?\.once\("listening", \(\) => \{\s*const port = server\.httpServer\.address\(\)\?\.port;\s*if \(port\) process\.env\.YARDTWIN_VIEWER = `http:\/\/localhost:\$\{port\}`;/,
               "a tool this server starts asks :5178, whichever viewer that is");
  // and nothing it starts replaces its environment, which would drop the address
  assert.doesNotMatch(cfg, /execFile\([^)]*\benv:\s*\{(?!\s*\.\.\.process\.env)/, "a child started with an environment that is not this one");
});
