// A wall-clock guard stretches on a slow machine and never tightens on a fast one (lib/timing.mjs):
// tools/selftest.py passes the machine's price per unit of work as PEDON_TIMING_SCALE.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const LIB = fileURLToPath(new URL("./lib/timing.mjs", import.meta.url));
const within = scale => Number(execFileSync(process.execPath, ["--input-type=module", "-e",
  `const { within } = await import(${JSON.stringify(LIB)}); console.log(within(100));`],
  { env: { ...process.env, PEDON_TIMING_SCALE: String(scale) }, encoding: "utf8" }));

test("a guard is its quiet limit times what the machine charges, and never less", () => {
  assert.equal(within(2.5), 250);
  assert.equal(within(1), 100);
  assert.equal(within(0.4), 100, "a fast machine tightened the guard");
  assert.equal(within("nonsense"), 100);
});
