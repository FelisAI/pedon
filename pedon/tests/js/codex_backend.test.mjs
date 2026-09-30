import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { designAgentArgs, codexImageArgs, DESIGN_TIMEOUT_MS } from "../../viewer/agent_cli.js";

test("both viewer backends measure, render and revise", () => {
  for (const backend of ["claude", "codex"]) {
    const args = designAgentArgs({ backend, prompt: "a garden", selection: ["bed1"] }, "agent.py", ["eye.jpg"]);
    assert.ok(args.includes("--explore"), `${backend} silently became one-shot`);
    assert.equal(args[args.indexOf("--rounds") + 1], "2");
    assert.equal(args.at(-1), "a garden");
    assert.equal(args[args.indexOf("--selection") + 1], "bed1");
    assert.equal(args[args.indexOf("--image") + 1], "eye.jpg");
    if (backend === "codex") assert.equal(args[args.indexOf("--backend") + 1], "codex");
  }
  assert.ok(DESIGN_TIMEOUT_MS > 2 * 3 * 2400 * 1000);
});

test("explicit one-shot requests remain possible", () => {
  assert.ok(!designAgentArgs({ backend: "codex", explore: false }, "agent.py").includes("--explore"));
});

test("Codex visual critique receives images with read-only shell access", () => {
  const args = codexImageArgs(["first.jpg", "second.jpg"], "judge these", "naming.schema.json");
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  assert.equal(args.filter(x => x === "--image").length, 2);
  assert.equal(args[args.indexOf("--output-schema") + 1], "naming.schema.json");
  assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
});

test("the HTTP handlers actually use these arguments and the selected reviewer", () => {
  const server = readFileSync(new URL("../../viewer/vite.config.js", import.meta.url), "utf8");
  const main = readFileSync(new URL("../../viewer/src/main.js", import.meta.url), "utf8");
  assert.match(server, /const args = designAgentArgs\(payload,/);
  assert.match(server, /function critiqueWalkthrough\(\{ frames, notes, backend \}/);
  const begin = server.indexOf("function critiqueWalkthrough");
  const end = server.indexOf("Render broker:", begin);
  assert.ok(begin >= 0 && end > begin);
  assert.match(server.slice(begin, end), /codexImageArgs\(paths, prompt\)/);
  const ask = main.indexOf('fetch("/api/walkthrough"');
  assert.ok(ask >= 0);
  assert.match(main.slice(ask, ask + 450), /backend: document.getElementById\("nameBackend"\).value/);
});
