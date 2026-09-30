// node --test tests/js/extension_host.test.mjs
//
// The extension host's two jobs are both REFUSALS, and both come straight from
// rules this project already paid for (pedon/EXTENSIONS.md):
//
//   - an extension gets capabilities, never the app. `ctx` is built from the
//     declared permissions and contains nothing else, which is what makes
//     "trusted now, sandboxed later" additive instead of a rewrite.
//   - a bad manifest is REPORTED, not thrown. A third-party extension that
//     cannot load must not take the viewer down with it — objects.js already
//     reverts a generated builder that will not render, for the same reason.
import test from "node:test";
import assert from "node:assert/strict";
import { checkManifest, capabilities, createRegistry, PERMISSIONS, POINTS }
  from "../../viewer/src/extensions.js";

const GOOD = {
  id: "dev.pedon.plant-inspector", version: "1.0.0",
  permissions: ["ops:write", "design:read"],
  contributes: { inspectors: [{ forKind: "plant" }] },
};
// a host whose slices are identifiable, so a leak is visible rather than plausible
const HOST = {
  ops: () => "OPS", design: () => "DESIGN", site: () => "SITE",
  assets: () => "ASSETS", selection: p => `SELECTION:${p}`, view: () => "VIEW",
  ui: () => "UI", storage: () => "STORAGE",
};

test("a well-formed manifest has no problems", () => {
  assert.deepEqual(checkManifest(GOOD), []);
});

test("every kind of malformed manifest is named, not thrown", () => {
  const bad = checkManifest({ id: "X", version: "1", permissions: ["fs:write"],
                              contributes: { evil: [] } });
  assert.equal(bad.length, 4, `expected all four faults, got ${JSON.stringify(bad)}`);
  assert.ok(bad.some(b => /fs:write/.test(b)), "an undeclared permission passed");
  assert.ok(bad.some(b => /evil/.test(b)), "an unknown extension point passed");
});

test("an inspector that does not say what kind it is for is refused", () => {
  // otherwise it silently never matches anything: a case such as `plant` would
  // be present in spirit and absent in effect
  const bad = checkManifest({ ...GOOD, contributes: { inspectors: [{}] } });
  assert.ok(bad.some(b => /what kind/.test(b)));
});

test("ctx carries ONLY the declared permissions", () => {
  const ctx = capabilities(GOOD, HOST);
  assert.equal(ctx.ops, "OPS");
  assert.equal(ctx.design, "DESIGN");
  for (const slice of ["site", "assets", "view", "ui", "storage", "selection"])
    assert.equal(ctx[slice], undefined,
      `${slice} was handed over without being declared — the capability boundary leaks`);
});

test("an extension can never receive a filesystem or a raw document", () => {
  // the invariant EXTENSIONS.md is built on: there is one write path, and it is
  // ctx.ops.apply. If a permission ever appears that maps to anything else, this
  // fails and the reviewer has to justify it.
  assert.ok(!Object.keys(PERMISSIONS).some(p => /^(fs|file|disk|net|eval)/.test(p)),
    "a filesystem-shaped permission was added to PERMISSIONS");
  const ctx = capabilities({ ...GOOD, permissions: Object.keys(PERMISSIONS) }, HOST);
  assert.ok(!("fs" in ctx) && !("document" in ctx) && !("fetch" in ctx));
});

test("a permission the host does not implement is skipped, not crashed on", () => {
  const ctx = capabilities({ ...GOOD, permissions: ["ops:write", "view:control"] },
                           { ops: () => "OPS" });      // host has no `view`
  assert.equal(ctx.ops, "OPS");
  assert.equal(ctx.view, undefined);
});

test("loading registers the contribution and runs activate with the ctx", () => {
  const reg = createRegistry();
  let got = null;
  assert.equal(reg.load({ ...GOOD, activate: c => { got = c; } }, HOST), true);
  assert.equal(reg.get("inspectors").length, 1);
  assert.equal(reg.get("inspectors")[0].forKind, "plant");
  assert.equal(reg.get("inspectors")[0]._from, GOOD.id);
  assert.equal(got.ops, "OPS", "activate did not receive the capability object");
});

test("a duplicate id is refused rather than contributing twice", () => {
  // two copies both adding a dock tool is a vocabulary listed in two places —
  // the class that can leave an element such as a flight of steps undeletable
  const reg = createRegistry();
  reg.load(GOOD, HOST);
  assert.equal(reg.load(GOOD, HOST), false);
  assert.equal(reg.get("inspectors").length, 1);
  assert.ok(reg.problems().some(p => /already loaded/.test(p)));
});

test("a bad manifest contributes NOTHING and is recorded", () => {
  const reg = createRegistry();
  assert.equal(reg.load({ id: "nope", version: "x" }, HOST), false);
  for (const p of POINTS) assert.equal(reg.get(p).length, 0);
  assert.equal(reg.problems().length, 1);
});

test("an activate that throws does not stop the app", () => {
  const reg = createRegistry();
  assert.equal(reg.load({ ...GOOD, activate: () => { throw new Error("boom"); } }, HOST), true);
  assert.ok(reg.problems().some(p => /activate threw/.test(p)));
  assert.equal(reg.get("inspectors").length, 1, "the contribution was lost with the throw");
});

test("a later inspector overrides an earlier one for the same kind", () => {
  // deliberate: core loads first, so someone can replace a built-in panel
  const reg = createRegistry();
  reg.load(GOOD, HOST);
  reg.load({ ...GOOD, id: "dev.pedon.better-plants",
             contributes: { inspectors: [{ forKind: "plant", tag: "mine" }] } }, HOST);
  assert.equal(reg.inspectorFor("plant").tag, "mine");
  assert.equal(reg.inspectorFor("bed"), null);
});
