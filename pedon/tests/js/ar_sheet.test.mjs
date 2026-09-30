// node --test tests/js/ar_sheet.test.mjs
//
// The viewer provides a way to the user's phone: it must make and serve the
// export and say where to point the phone, without requiring a CLI command.
import { resolvePath } from "../../viewer/project_paths.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isCurrent, readyLine, standLine, madeAgo, mountArSheet } from "../../viewer/src/shell/arsheet.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = p => fs.readFileSync(resolvePath(p), "utf8");   // data/… is the active site's
const codeOnly = s => s.split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const NOW = 1_800_000_000_000, MIN = 60000;

const FILE = { name: "yard.usdz", bytes: 21_464_496, mtime_ms: NOW - 3 * MIN };
const AR = { design_source: "data/design.json", design_name: "huajing_J_sunroom", plants: 159,
             plant_items: [], scan: {file: "reference.scan.usdz"}, origin: "side_yard_hedge_row", second: "south_fence_east_corner" };

test("the file on offer is current only if it was made FROM the design on screen, AFTER it last changed", () => {
  const info = { files: [FILE], ar: AR, source: "data/design.json", source_mtime_ms: NOW - 5 * MIN };
  assert.equal(isCurrent(info), true);
  assert.equal(isCurrent({ ...info, source: "/data/design.json" }), true, "a leading slash made the same file a different design");
  assert.equal(isCurrent({ ...info, source_mtime_ms: NOW - MIN }), false, "the design changed after the file was made");
  assert.equal(isCurrent({ ...info, source: "data/designs/huajing_E.json" }), false, "a file of ANOTHER design passed as current");
  // a file with no record of its design is made again
  assert.equal(isCurrent({ ...info, ar: null }), false);
  assert.equal(isCurrent({ ...info, files: [] }), false);
  assert.equal(isCurrent(null), false);
  const batched = {...AR}; delete batched.plant_items;
  assert.equal(isCurrent({...info, ar: batched}), false, "species batches need individual plant nodes");
  const legacy = {...AR}; delete legacy.scan;
  assert.equal(isCurrent({...info, ar: legacy}), false, "old plan-only exports need regeneration");
});

test("it says which design, how many plants, and where to stand — in the user's words", () => {
  assert.equal(readyLine({ files: [FILE], ar: AR }, NOW), "huajing_J_sunroom · 159 plants · 21 MB · made 3 minutes ago");
  // the user picks the marks on a plan, so nothing names two for them
  assert.match(standLine({ ...AR, plan: { beds: [] } }), /Pick two existing features far apart on the original scan/);
  assert.ok(!/hedge row|fence east/.test(standLine({ ...AR, plan: { beds: [] } })), "the sheet still dictates the marks");
  assert.equal(standLine({}), "");
});

/** Just enough DOM for the sheet: elements that remember text, classes and markup. */
function fakeDom() {
  const made = new Map();
  const el = () => ({ textContent: "", innerHTML: "", hidden: false, onclick: null,
    classList: { set: new Set(), toggle(c, on) { on ? this.set.add(c) : this.set.delete(c); }, add(c) { this.set.add(c); } },
    querySelector(sel) { if (!made.has(sel)) made.set(sel, el()); return made.get(sel); } });
  globalThis.document = { createElement: () => el(), body: { appendChild() {} } };
  globalThis.addEventListener = () => {};
  return made;
}

test("OPENING the sheet makes the file when the one on disk is not this design as it stands — and not otherwise", async () => {
  // Generate the current design's file when the user opens the sheet if needed;
  // a stale export must not appear current or require a second button to replace.
  for (const [current, expectMake] of [[false, true], [true, false]]) {
    fakeDom();
    const asked = [];
    globalThis.fetch = async (url, opts) => {
      asked.push(`${opts?.method ?? "GET"} ${url}`);
      if (url.startsWith("/api/ar/export")) return { json: async () => ({ ok: true }) };
      return { json: async () => ({ urls: ["http://mac.local:5179/"], files: [FILE], ar: AR,
                                    source: "data/design.json",
                                    source_mtime_ms: current ? NOW - 5 * MIN : NOW - MIN }) };
    };
    const sheet = mountArSheet({ source: () => "/data/design.json", name: () => "huajing_J_sunroom" });
    await sheet.show();
    await new Promise(r => setTimeout(r, 0));
    const posted = asked.filter(a => a.startsWith("POST /api/ar/export"));
    assert.equal(posted.length, expectMake ? 1 : 0, `current=${current}: ${asked.join(", ")}`);
    if (expectMake) assert.equal(posted[0], "POST /api/ar/export?name=huajing_J_sunroom", "the phone would not know which design it is");
    assert.ok(asked[0].startsWith("GET /api/ar?source=data%2Fdesign.json"), "the sheet did not say which design is on screen");
  }
  delete globalThis.fetch; delete globalThis.document; delete globalThis.addEventListener;
});

test("the phone's door is SHUT until the user opens it, and the sheet offers to open it", async () => {
  // a fresh install listens on nothing but localhost: the sheet shows no address and no code
  // while the door is shut, and one click opens it — remembered for this machine
  const made = fakeDom();
  let open = false;
  const asked = [];
  globalThis.fetch = async (url, opts) => {
    asked.push(`${opts?.method ?? "GET"} ${url} ${opts?.body ?? ""}`.trim());
    if (url === "/api/ar/door") { open = JSON.parse(opts.body).open; return { json: async () => ({ ok: true }) }; }
    if (url.startsWith("/api/ar/export")) return { json: async () => ({ ok: true }) };
    return { json: async () => ({ door: open, urls: open ? ["http://mac.local:5179/"] : [],
                                  files: [FILE], ar: AR, source: "data/design.json", source_mtime_ms: NOW - 5 * MIN }) };
  };
  const sheet = mountArSheet({ source: () => "data/design.json", name: () => "x" });
  await sheet.show();
  assert.equal(made.get(".door").hidden, false, "the door is shut and the sheet does not say so");
  assert.equal(made.get(".reach").hidden, true, "an address shown for a door that is shut");
  await made.get(".door-open").onclick();
  assert.ok(asked.includes('POST /api/ar/door {"open":true}'), asked.join(" | "));
  assert.equal(made.get(".door").hidden, true);
  assert.equal(made.get(".reach").hidden, false, "the door opened and the code did not appear");
  assert.equal(made.get(".url").textContent, "http://mac.local:5179/");
  assert.match(sheet.element.innerHTML, /PEDON iPhone app/);
  assert.doesNotMatch(sheet.element.innerHTML, /Safari|class="qr"|<details/);
  await made.get(".door-close").onclick();
  assert.ok(asked.includes('POST /api/ar/door {"open":false}'));
  assert.equal(made.get(".reach").hidden, true);
  delete globalThis.fetch; delete globalThis.document; delete globalThis.addEventListener;
});

test("a door that did not open says why, and is still offered", async () => {
  const made = fakeDom();
  globalThis.fetch = async (url, opts) => {
    if (url === "/api/ar/door") return { json: async () => ({ ok: false, door: false,
      err: "port 5179 is already in use — is another PEDON viewer running on this Mac?" }) };
    if (url.startsWith("/api/ar/export")) return { json: async () => ({ ok: true }) };
    return { json: async () => ({ door: false, urls: [], files: [FILE], ar: AR,
                                  source: "data/design.json", source_mtime_ms: NOW - 5 * MIN }) };
  };
  const sheet = mountArSheet({ source: () => "data/design.json", name: () => "x" });
  await sheet.show();
  await made.get(".door-open").onclick();
  assert.equal(made.get(".door").hidden, false, "a door that failed to open is shown as open");
  assert.match(made.get(".door-err").textContent, /did not open: port 5179 is already in use/,
               "the click changed nothing and said nothing");
  assert.equal(made.get(".door-open").disabled, false, "the button stays dead after a failed open");
  delete globalThis.fetch; delete globalThis.document; delete globalThis.addEventListener;
});

test("the dev server opens the door only if this machine has opened it", async () => {
  const cfg = codeOnly(read("viewer/vite.config.js"));
  assert.match(cfg, /if \(phoneDoorOpen\(\)\) openDoor\(\);/, "the door opens on every start again");
  assert.doesNotMatch(cfg, /^\s*startArServer\(/m, "a bare startArServer call opens the door unasked");
  assert.match(cfg, /url === "\/api\/ar\/door"\) \{\s*if \(refuseForeign\(req, res\)\) return;/, "a foreign page could open the door");
  assert.match(cfg, /\(\{ open: on, err \} = await arServerSettled\(AR_PORT\)\);\s*if \(on\) \{ fs\.mkdirSync\(path\.dirname\(phoneDoorFile\(\)\)/,
               "a door is remembered as open before it has opened — or when it failed to");
  const { execFileSync } = await import("node:child_process");
  const os = await import("node:os"), fs = await import("node:fs"), path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pedon-door-"));
  const probe = f => execFileSync(process.execPath, ["--input-type=module", "-e",
    `const p = await import(${JSON.stringify(new URL("../../viewer/project_paths.js", import.meta.url).href)}); console.log(p.phoneDoorOpen())`],
    { env: { ...process.env, PEDON_PROJECTS: dir }, encoding: "utf8" }).trim();
  try {
    assert.equal(probe(), "false", "a fresh machine's door is open");
    fs.writeFileSync(path.join(dir, ".phone-door"), "open\n");
    assert.equal(probe(), "true");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("ages read as a person would say them", () => {
  assert.equal(madeAgo(NOW - 30_000, NOW), "just now");
  assert.equal(madeAgo(NOW - 45 * MIN, NOW), "45 minutes ago");
  assert.equal(madeAgo(NOW - 5 * 60 * MIN, NOW), "5 hours ago");
  assert.equal(madeAgo(NOW - 3 * 1440 * MIN, NOW), "3 days ago");
});

test("the seams: a command with a clickable home, the sheet mounted, the dev server carrying what it needs", () => {
  const main = codeOnly(read("viewer/src/main.js"));
  assert.match(main, /\{ id: "view\.ar", title: "See it on site — on your phone"[\s\S]{0,200}run: \(\) => arSheet\?\.show\(\) \}/);
  assert.match(main, /\{ id: "view\.ar", title: "See it on site…"/, "the command has no home in the ··· menu — hotkey-only is not a home");
  assert.match(main, /arSheet = mountArSheet\(/, "the sheet is never mounted, so the command opens nothing");
  assert.ok(main.indexOf("let arSheet = null;") < main.indexOf("arSheet = mountArSheet("), "assigned before it is declared");
  const cfg = codeOnly(read("viewer/vite.config.js"));
  assert.match(cfg, /startArServer\(arDir, AR_PORT, \(\) => \(\{ making: !!arExport \}\)\)/, "the phone's server is never started, or is not told when a file is being made");
  assert.match(cfg, /url === "\/api\/ar"\)[\s\S]{0,1200}source_mtime_ms/, "the sheet cannot tell a stale file without the design's own date");
  assert.match(main, /mountArSheet\(\{[^}]*source: \(\) => designSource\(\)[\s\S]{0,160}name: \(\) => shownDesignName\(\)/,
    "the sheet is not told which design is on screen, so it cannot tell a stale file");
  assert.match(cfg, /url === "\/api\/ar\/export"\) \{\s*if \(refuseForeign\(req, res\)\) return;/, "anyone who can reach the dev server can start a fifteen-minute Blender job");
  assert.match(cfg, /"tools", "ar_export\.py"/);
});

test("the planting drawings have a clickable home and are made for the beds the user selected", () => {
  // tools/planting_plan.py is a CLI; the user works in the viewer, so a menu entry
  // must make the trade's drawings available to print (AGENTS.md).
  const main = codeOnly(read("viewer/src/main.js"));
  assert.match(main, /\{ id: "design\.plan", title: "Planting drawings to print"[\s\S]{0,260}run: \(\) => openPlantingPlan\(\) \}/);
  assert.match(main, /\{ id: "design\.plan", title: "Planting drawings to print…"/, "no home in the ··· menu");
  assert.match(main, /function openPlantingPlan\(\) \{[\s\S]{0,400}\[\.\.\.selection\]\.filter\(id => \(currentDesign\?\.beds \?\? \[\]\)\.some\(b => b\.id === id\)\)/,
    "the drawings ignore what they have selected — a whole site does not fit a sheet at 1:50");
  const cfg = codeOnly(read("viewer/vite.config.js"));
  assert.match(cfg, /url === "\/api\/plan"\)[\s\S]{0,900}"planting_plan\.py"/);
  assert.match(cfg, /const safe = v => \/\^\[\\w,-\]\*\$\/\.test\(v \?\? ""\) \? v : "";/, "query text reaches the command line unchecked");
  assert.match(cfg, /res\.statusCode = 422;[\s\S]{0,300}could not be made/, "a failure must be SAID in the tab they are looking at, not served as a blank page");
});
