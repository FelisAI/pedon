import { defineConfig, searchForWorkspaceRoot } from "vite";
import { plantCodeVersion } from "./plant_version.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto, { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { designAgentArgs, codexImageArgs, DESIGN_TIMEOUT_MS } from "./agent_cli.js";
import { startArServer, stopArServer, arServerListening, arServerSettled, arFiles, arInfo, lanUrls, AR_PORT } from "./ar_server.js";
import { dataPath, resolvePath, dataBase, activeProject, projectFolder, phoneDoorFile, phoneDoorOpen, libraryRoot, libraryRealRoot, speciesDir, speciesFiles } from "./project_paths.js";
import { refuseForeign, readBody } from "./server_http.js";

const repoRoot = path.resolve(__dirname, "..");

const NAME_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    landmarks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "integer", description: "the candidate number from the images" },
          name: { type: "string", description: "short snake_case name, e.g. stairs_bottom, wooden_planter, back_fence" },
          confident: { type: "boolean", description: "false if you cannot actually tell what it is" },
          note: { type: "string", description: "what you saw that made you say this" },
        },
        required: ["id", "name", "confident", "note"],
      },
    },
  },
  required: ["landmarks"],
};

/** Ask the logged-in CLI to name detected structures from rendered views. */
function nameLandmarks({ images, candidates, backend }, cb) {
  const dir = dataPath("detect");
  fs.mkdirSync(dir, { recursive: true });
  const paths = images.map((dataUrl, i) => {
    const m = /^data:image\/(\w+);base64,/.exec(dataUrl);
    const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
    const p = path.join(dir, `view${i + 1}.${m?.[1] === "png" ? "png" : "jpg"}`);
    fs.writeFileSync(p, Buffer.from(b64, "base64"));
    return p;
  });
  const table = candidates.map(c =>
    `#${c.id}: shape=${c.kind}, height=${c.height_m} m, footprint=${c.area_m2} m2, ` +
    `elongation=${c.elongation}${c.span_m ? `, runs ${c.span_m} m long` : ""}` +
    `${c.part && c.part !== "centre" ? `, marker is at ${c.part} of that run` : ""}` +
    `${c.levels ? `, ${c.levels} even horizontal levels` : ""}`).join("\n");
  const prompt = [
    "You are looking at renders of a 3D scan of a residential yard.",
    `Read these images: ${paths.join(" , ")}`,
    "",
    "Numbered markers in the images mark structures a geometry detector found.",
    "Its shape statistics (it cannot recognise objects, only measure them):",
    table,
    "",
    "For each numbered marker you can actually identify, give a short snake_case name",
    "a homeowner would use for that thing (stairs_bottom, wooden_planter, back_fence,",
    "patio, retaining_wall, shed, tree_large, driveway...).",
    "Rules:",
    "- Name ONLY what you can see. If a marker is unclear, still return it with confident=false.",
    "- Do not invent structures that are not at the marked spot.",
    "- Prefer the specific thing over a generic one (wooden_planter beats object).",
    "- Two markers on the same long structure are its two ENDS: name them so the",
    "  ends are distinguishable and useful to walk to (stairs_bottom / stairs_top,",
    "  back_fence_west / back_fence_east). Use up/down or compass sense from the images.",
    "- Names must be unique.",
    "Reply with ONLY the JSON object.",
  ].join("\n");

  if (backend === "codex") {
    // read-only sandbox: naming looks at pictures, it never needs to touch the
    // machine, so this must not run with approvals bypassed
    const schemaPath = path.join(dir, "naming.schema.json");
    fs.writeFileSync(schemaPath, JSON.stringify(NAME_SCHEMA));
    const args = codexImageArgs(paths, prompt, schemaPath);
    execFile("codex", args, { cwd: repoRoot, timeout: 600000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) =>
      cb(err, stdout));
    return;
  }
  // --effort low is load-bearing: without it the spawned CLI inherits the
  // session's effort level and this 3-image naming task runs >5 min instead of
  // ~15 s, with no better answers (measured on the real capture).
  const child = execFile("claude",
    ["-p", "-", "--model", "claude-opus-5", "--effort", "low",
     "--json-schema", JSON.stringify(NAME_SCHEMA)],
    { timeout: 600000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => cb(err, stdout));
  // if the CLI dies before draining stdin, the EPIPE lands here rather than
  // as an unhandled error that takes the dev server with it
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);
}

/**
 * Show the model its own design from eye level and ask what is wrong.
 *
 * A garden is experienced from within, not from outside the scene. These frames
 * are taken standing on the design's own paths at 1.65 m, which is where the
 * failures actually show: a bed edge that is a straight line, a walk that aims
 * at nothing, a shrub planted where your face goes.
 */
function critiqueWalkthrough({ frames, notes, backend }, cb) {
  const dir = dataPath("walkthrough");
  fs.mkdirSync(dir, { recursive: true });
  // clear the previous run so the model is never handed a stale frame
  for (const f of fs.readdirSync(dir)) {
    if (/^frame\d+\.jpg$/.test(f)) fs.unlinkSync(path.join(dir, f));
  }
  const paths = frames.map((fr, i) => {
    const b64 = String(fr.dataUrl).replace(/^data:image\/\w+;base64,/, "");
    const p = path.join(dir, `frame${i + 1}.jpg`);
    fs.writeFileSync(p, Buffer.from(b64, "base64"));
    return p;
  });
  const where = frames.map((fr, i) =>
    `frame${i + 1}.jpg — ${fr.name}; standing at x=${fr.eye[0].toFixed(1)}, ` +
    `y=${fr.eye[1].toFixed(1)} m, ground ${fr.ground_m} m, looking toward ` +
    `x=${fr.look[0].toFixed(1)}, y=${fr.look[1].toFixed(1)}`).join("\n");

  const prompt = [
    "These are eye-level renders of a landscape design on a 3D scan of a real",
    "back yard. Each was taken standing ON the design's own path at 1.65 m,",
    "walking through it — this is what the owner would actually see.",
    `Read these images: ${paths.join(" , ")}`,
    "",
    "Where each frame was taken from:",
    where,
    "",
    notes ? `Design notes: ${notes}` : "",
    "",
    "The scan is real photogrammetry, so the existing fence, paving and house",
    "are captured reality; the flat-shaded plants, coloured beds and walks are",
    "the proposed design. Judge the DESIGN, not the scan quality.",
    "",
    "Answer plainly, worst problem first:",
    "1. What does the owner actually see walking this? Is it pleasant?",
    "2. What is broken or nonsensical at eye level that would not show in plan?",
    "3. Do the beds and walks read as designed shapes or as machine-made boxes?",
    "4. What single change would most improve the experience of walking it?",
    "Be concrete and specific to what is in frame. Say which frame you mean.",
    "If a frame shows nothing useful (inside a shrub, off the edge), say so —",
    "that is itself a finding about where the design puts a person.",
  ].filter(Boolean).join("\n");

  if (backend === "codex") {
    execFile("codex", codexImageArgs(paths, prompt),
      { cwd: repoRoot, timeout: 900000, maxBuffer: 32 * 1024 * 1024 }, cb);
    return;
  }
  const child = execFile("claude",
    ["-p", "-", "--model", "claude-opus-5", "--effort", "low"],
    { timeout: 900000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => cb(err, stdout));
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);
}

/**
 * Render broker: lets a headless model ask the OPEN BROWSER for a picture.
 *
 * Rendering needs WebGL, so it can only happen in the viewer. The model runs as
 * a `claude -p` subprocess with no display. This is the meeting point: the
 * viewer holds an SSE subscription, a caller POSTs a render request, the viewer
 * executes it against the LIVE scene and posts the frame back, and the caller's
 * held request resolves with the file path and metadata.
 *
 * Why the live scene rather than headless Playwright: the browser already holds
 * the loaded scan, the current design variant, the calibration and the growth
 * scale. Re-creating that offscreen means re-loading 319k triangles and keeping
 * two copies of viewer state in sync. The browser must be open, so the live
 * scene IS the asset.
 */
const designCounts = new Map();   // name -> counts, keyed on mtime+size
// name -> {_stamp, over:[{bed, coverage, reading}]}. WHICH BEDS ARE CROWDED AT FULL
// MATURITY, reported in the Saved list. Measured by python
// (`site_api.py crowding` -> agent.bed_mature_coverage), never here: coverage needs
// the bed's own ground with paving taken out, and that has one home per language.
const designCrowding = new Map();

const viewBroker = {
  subscribers: new Set(),          // live SSE responses, one per open viewer
  pending: new Map(),              // id -> {resolve, timer}
};

function brokerRequest(cmd, cb) {
  if (!viewBroker.subscribers.size) {
    cb({ ok: false, error: "no_viewer",
         detail: "no viewer is connected — open http://localhost:5178 and leave the tab visible" });
    return;
  }
  // Restarting Vite must not overwrite a previous session's visual evidence.
  const id = `v_${randomUUID()}`;
  // A cold full-detail review builds botanical geometry before drawing.
  // Measured on a 219-plant design: 30.8 s, before the first GPU frame.
  const slow = !cmd?.op || ["look", "walkthrough", "scan_grid", "export_scene"].includes(cmd.op);
  const timer = setTimeout(() => {
    const p = viewBroker.pending.get(id);
    viewBroker.pending.delete(id);
    // an error already seen beats a bare timeout: it says WHY
    cb(p?.lastError ?? { ok: false, error: "timeout",
         detail: `the viewer did not answer in ${slow ? 180 : 30} s. A BACKGROUNDED tab is throttled — ` +
                 "bring the viewer window to the front and retry." });
  }, slow ? 180000 : 30000);
  // A SUCCESS BEATS AN ERROR.
  //
  // Every open viewer tab is a subscriber and every one of them answers. The
  // first reply may be an error from an older tab that lacks `export_scene`
  // and falls through to the subject renderer with "cannot find 'undefined'".
  // Such a failure can arrive in 0.069 s while a capable tab is still working,
  // so accepting the first reply would let a fast failure beat a success.
  //
  // So an error is HELD rather than returned, and the first success wins
  // outright. A call every subscriber refuses still comes back with the last
  // refusal, at the timeout, rather than a bare "timeout" that says nothing.
  viewBroker.pending.set(id, { cb, timer, replies: 0,
                               expect: viewBroker.subscribers.size, lastError: null });
  const payload = `event: render\ndata: ${JSON.stringify({ id, cmd })}\n\n`;
  for (const res of viewBroker.subscribers) { try { res.write(payload); } catch {} }
}

const ICON = `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M8 .8 15.2 8 8 15.2.8 8z" fill="none" stroke="#d98e5f" stroke-width="1.4"/><path d="M8 4.6 11.4 8 8 11.4 4.6 8z" fill="#d98e5f"/></svg>')}">`;

/** Serve ../data and ../assets, and accept POST /api/save for calibration/design. */
function pedonPlugin() {
  return {
    name: "pedon-data",
    // WHICH SITE THIS PAGE IS FOR: stamped in per request, so what the browser
    // remembers (the design you were on, the camera) is kept per site — viewer/src/shell/sitekey.js
    transformIndexHtml(html) {
      const site = String(activeProject() ?? "").replace(/[^\w./-]/g, "");
      // and the mark (◈, clay) as every page's icon — no page asks for a /favicon.ico that is not there
      return html.replace("</head>", `  <meta name="pedon-project" content="${site}">\n  ${ICON}\n</head>`);
    },
    configureServer(server) {
      // Everything this server starts — the AR export, a render, the design agent's eyes — asks
      // THIS server, on whatever port it got. The tools' default (:5178) would reach another
      // viewer, and another site, whenever this one runs elsewhere.
      server.httpServer?.once("listening", () => {
        const port = server.httpServer.address()?.port;
        if (port) process.env.YARDTWIN_VIEWER = `http://localhost:${port}`;
      });
      // THE PHONE'S DOOR: a second, READ-ONLY server on the LAN that serves
      // data/ar and nothing else. This dev server stays on localhost — `host: true`
      // would put /api/ops, /api/delete and POST /api/site on the whole Wi-Fi.
      const arDir = () => dataPath("ar");      // the ACTIVE project's, per request
      let arExport = null;          // the one export in flight, so two clicks are one job
      // once per process; it outlives Vite's own restarts. It is told when a new file is
      // being made, so the phone can say so rather than offer the old one as if current.
      // OFF until the user opens it (the "See it on site" sheet), and remembered per machine:
      // a fresh install listens on nothing but localhost.
      const openDoor = () => startArServer(arDir, AR_PORT, () => ({ making: !!arExport }));
      if (phoneDoorOpen()) openDoor();
      // THE DRACO DECODER is three's own, served as the bytes three ships — not through Vite's
      // module pipeline, which rewrites a .js file it serves — so it always matches the
      // DRACOLoader of the three that is installed (src/loader.js)
      const DRACO = path.join(__dirname, "node_modules", "three", "examples", "jsm", "libs", "draco", "gltf");
      server.middlewares.use("/draco/", (req, res, next) => {
        const name = (req.url ?? "").split("?")[0].replace(/^\//, "");
        const file = path.join(DRACO, name);
        if (!/^draco_[\w]+\.(js|wasm)$/.test(name) || !fs.existsSync(file)) return next();
        res.setHeader("Content-Type", name.endsWith(".wasm") ? "application/wasm" : "text/javascript");
        fs.createReadStream(file).pipe(res);
      });
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];
        if (req.method === "GET" && (url.startsWith("/data/") || url.startsWith("/assets/"))) {
          // /data/… is the ACTIVE project's (or a shared name) — project_paths.js
          const rel = path.posix.normalize(decodeURIComponent(url));
          if (!/^\/(data|assets)\//.test(rel)) { res.statusCode = 404; res.end("not found"); return; }
          const file = resolvePath(rel), base = dataBase(rel);
          // base + separator: bare startsWith would also admit sibling
          // directories like <base>-secrets, and ".." would climb out of it
          if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.statusCode = 404; res.end("not found"); return;
          }
          const types = { ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
            ".glb": "model/gltf-binary", ".ply": "application/octet-stream", ".spz": "application/octet-stream" };
          res.setHeader("Content-Type", types[path.extname(file)] ?? "application/octet-stream");
          res.setHeader("Cache-Control", "no-store");
          fs.createReadStream(file).pipe(res);
          return;
        }
        if (req.method === "GET" && url === "/api/plan") {
          // THE TRADE'S DRAWINGS: planting plan, schedule and setting-out, made
          // by tools/planting_plan.py from the design on disk and handed straight to a
          // new tab to be printed. Read-only: it writes one file under review/.
          const q = new URL(req.url, "http://localhost").searchParams;
          const safe = v => /^[\w,-]*$/.test(v ?? "") ? v : "";
          const args = [path.join(repoRoot, "tools", "planting_plan.py"),
                        "--beds", safe(q.get("beds")) || "auto", "--baseline", safe(q.get("baseline")) || "auto",
                        "--out", resolvePath("review/planting-plan.html")];
          execFile("python3", args, { cwd: repoRoot, timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (e, out, err) => {
            res.setHeader("Cache-Control", "no-store");
            if (e) {
              res.statusCode = 422; res.setHeader("Content-Type", "text/plain; charset=utf-8");
              res.end(`The planting drawings could not be made:\n\n${String(err || e.message).trim().split("\n").pop()}`);
              return;
            }
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            fs.createReadStream(resolvePath("review/planting-plan.html")).pipe(res);
          });
          return;
        }
        if (req.method === "GET" && url === "/api/objects/library") {
          // THE OBJECT LIBRARY: models found, made or scanned, as files in
          // assets/objects with a card beside each. Read by tools/asset_store.py, the one
          // owner of the card format, so the viewer and the agent see the same shelf.
          execFile("python3", [path.join(repoRoot, "tools", "asset_store.py"), "list"],
            { cwd: repoRoot, timeout: 20000, maxBuffer: 4 * 1024 * 1024 }, (e, out) => {
              res.setHeader("Content-Type", "application/json");
              res.setHeader("Cache-Control", "no-store");
              res.end(e ? "[]" : out);
            });
          return;
        }
        if (req.method === "POST" && url === "/api/ar/door") {
          if (refuseForeign(req, res)) return;
          // open or close the phone's door, and remember it for this machine
          readBody(req, res, 1024).then(async buf => {
            if (!buf) return;
            let on = false, err = null;
            try { on = JSON.parse(buf.toString("utf8") || "{}").open === true; } catch { /* closed */ }
            if (on) {
              // remembered only once it HAS opened: a door that could not get its port stays
              // shut, and the answer says why
              openDoor();
              ({ open: on, err } = await arServerSettled(AR_PORT));
              if (on) { fs.mkdirSync(path.dirname(phoneDoorFile()), { recursive: true }); fs.writeFileSync(phoneDoorFile(), "open\n"); }
            } else { fs.rmSync(phoneDoorFile(), { force: true }); stopArServer(AR_PORT); }
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: !err, door: on, err }));
          });
          return;
        }
        if (req.method === "GET" && url === "/api/ar") {
          // what the user needs on their phone: the connection address and current export — the address only while
          // the door is open
          const door = phoneDoorOpen() && arServerListening(AR_PORT);
          const urls = door ? lanUrls(AR_PORT) : [];
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          // the design ON SCREEN, which may be a saved one — a file made from it is
          // current only if it is newer than that file
          const source = String(new URL(req.url, "http://x").searchParams.get("source") ?? "data/design.json").replace(/^\//, "");
          let sourceMtime = null;
          if (/^data\/(design\.json|designs\/[\w-]+\.json)$/.test(source))
            try { sourceMtime = fs.statSync(resolvePath(source)).mtimeMs; } catch { /* not there */ }
          const files = arFiles(arDir());
          res.end(JSON.stringify({ door, urls, files, ar: arInfo(arDir(), files[0]?.name), exporting: !!arExport,
                                   source, source_mtime_ms: sourceMtime }));
          return;
        }
        if (req.method === "POST" && url === "/api/ar/export") {
          if (refuseForeign(req, res)) return;
          // ar_export.py asks THIS viewer for the geometry (export_scene) and hands it
          // to Blender, so it is the design on screen, draped on the real ground.
          // the name they see in the top bar, so the phone says which design it is; a
          // name, never a flag or a path, before it reaches the command line
          const shown = String(new URL(req.url, "http://x").searchParams.get("name") ?? "").slice(0, 80);
          const named = /^[\w .'()-]+$/.test(shown) ? ["--name", shown] : [];
          arExport ??= new Promise(resolve => {
            execFile("python3", [path.join(repoRoot, "tools", "ar_export.py"), ...named],
              { cwd: repoRoot, timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 },
              (e, out, err) => { arExport = null; resolve({ ok: !e, out: String(out).slice(-1200), err: String(err).slice(-600) }); });
          });
          arExport.then(r => {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ...r, files: arFiles(arDir()) }));
          });
          return;
        }
        if (req.method === "POST" && url === "/api/delete") {
          if (refuseForeign(req, res)) return;
          readBody(req, res, 1024 * 1024).then(buf => {
            if (!buf) return;
            const body = buf.toString("utf8");
            try {
              const { file } = JSON.parse(body);
              // deliberately narrow: only saved design variants may be removed
              if (!/^data\/designs\/[\w-]+\.json$/.test(file)) throw new Error("only data/designs/*.json");
              fs.unlinkSync(resolvePath(file));
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: true }));
            } catch (e) {
              if (!res.writableEnded) {
                res.statusCode = 400;
                res.end(JSON.stringify({ ok: false, error: String(e.message ?? e) }));
              }
            }
          });
          return;
        }
        // THE OWNER'S PHOTOGRAPH OF THEIR OWN PLANT.
        //
        // The owner needs to add photos of their plants, stones and other
        // assets to the library with measured sizes.
        //
        // Genus-only library entries can show a DIFFERENT SPECIES (10 of 22 in
        // a measured audit), so their photos cannot reliably establish foliage
        // density for a species preset. `--audit` checks this; the owner supplies
        // the species identity for their own plant.
        //
        // The tool does the work: this hands the bytes to a file and shells out
        // to `owner_photo.py add`, so the rules it enforces — a size the owner
        // MEASURES rather than one inferred from the image, and no cat-safety claim of
        // any kind — cannot be bypassed by going through the browser instead.
        if (req.method === "POST" && url === "/api/owner-photo") {
          if (refuseForeign(req, res)) return;
          readBody(req, res, 24 * 1024 * 1024, "photo too large").then(buf => {
            if (!buf) return;
            res.setHeader("Content-Type", "application/json");
            let tmp = null;
            try {
              const b = JSON.parse(buf.toString("utf8"));
              const m = /^data:image\/(jpeg|jpg|png|webp);base64,/.exec(String(b.dataUrl ?? ""));
              if (!m) throw new Error("a jpeg, png or webp photo is required");
              if (!b.species) throw new Error("which plant is it? species is required");
              const ext = m[1] === "jpeg" ? "jpg" : m[1];
              tmp = path.join(os.tmpdir(),
                `pedon_owner_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
              fs.writeFileSync(tmp, Buffer.from(String(b.dataUrl).slice(m[0].length), "base64"));
              const args = [path.join(repoRoot, "tools", "owner_photo.py"), "add",
                            "--photo", tmp, "--species", String(b.species)];
              // whitelisted and shape-checked: these reach a subprocess argv
              if (b.common) args.push("--common", String(b.common).slice(0, 80));
              if (Number.isFinite(+b.height_m)) args.push("--height-m", String(+b.height_m));
              if (Number.isFinite(+b.spread_m)) args.push("--spread-m", String(+b.spread_m));
              if (b.where) args.push("--where", String(b.where).slice(0, 120));
              if (b.note) args.push("--note", String(b.note).slice(0, 400));
              if (b.replace) args.push("--replace");
              execFile("python3", args, { cwd: repoRoot, timeout: 20000 }, (e, out, err) => {
                try { fs.unlinkSync(tmp); } catch { /* already gone */ }
                try {
                  const parsed = JSON.parse(out || "{}");
                  if (parsed.error) { res.statusCode = 400; res.end(JSON.stringify(parsed)); return; }
                  res.end(out);
                } catch {
                  res.statusCode = 500;
                  res.end(JSON.stringify({ error: String(err || e?.message || "failed").slice(0, 300) }));
                }
              });
            } catch (e) {
              try { if (tmp) fs.unlinkSync(tmp); } catch { /* never wrote it */ }
              res.statusCode = 400;
              res.end(JSON.stringify({ error: String(e.message ?? e) }));
            }
          });
          return;
        }

        if (req.method === "GET" && url === "/api/designs") {
          const dir = dataPath("designs");
          let files = [];
          try {
            files = fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort();
          } catch { /* no variants saved yet */ }
          // `designs` stays a plain list of names: identifyLoadedDesign and the
          // list both read it that way, and a shape change here would be a silent
          // break in two places. `meta` rides alongside so the panel can sort by
          // something other than the alphabet. Sort keys use stat() only, never
          // reading the files: this runs on every design change and parsing 47
          // documents per poll is a request storm for a sort key.
          // A FILENAME IS NOT SOMETHING YOU CAN COMPARE. Counts distinguish
          // versions of the same border so the owner can choose between them.
          //
          // COUNTS only, here. Geometry (bed area, path length, mature coverage)
          // needs the shoelace, and that has ONE home per language, because
          // duplicate geometry implementations can disagree. The browser
          // measures the two or three designs actually being compared, with the
          // module that owns it.
          //
          // Cached on mtime+size: 65 files parse in ~25 ms, which is nothing
          // once and a request storm on every poll.
          const meta = {};
          for (const f of files) {
            try {
              const st = fs.statSync(path.join(dir, f));
              const name = f.replace(/\.json$/, "");
              const stamp = `${st.mtimeMs}:${st.size}`;
              let counts = designCounts.get(name);
              if (!counts || counts._stamp !== stamp) {
                counts = { _stamp: stamp };
                try {
                  const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
                  for (const k of ["plants", "beds", "paths", "patios", "objects", "steps", "edges"])
                    counts[k] = Array.isArray(d[k]) ? d[k].length : 0;
                  // Species count distinguishes planting diversity: 27 species
                  // for 32 plants reads as a nursery order rather than a planting.
                  counts.species = new Set((d.plants ?? [])
                    .map(p => String(p.species ?? "").trim().toLowerCase())
                    .filter(Boolean)).size;
                  counts.style = typeof d.style === "string" ? d.style.slice(0, 40) : "";
                  // WHERE IT CAME FROM. Design lineage is recorded as a field
                  // the list can read, rather than encoded in filenames.
                  // It rides on the same mtime cache as the counts: this is a
                  // label, and re-parsing 65 documents per poll for one is the
                  // storm the cache exists for.
                  counts.from = typeof d.from === "string" ? d.from.slice(0, 80) : "";
                } catch { /* an unreadable variant still gets a row */ }
                designCounts.set(name, counts);
              }
              const { _stamp, ...clean } = counts;
              meta[name] = { mtime_ms: st.mtimeMs, size: st.size, ...clean };
            } catch { /* vanished between readdir and stat */ }
          }
          const reply = () => {
            for (const name of Object.keys(meta)) {
              const c = designCrowding.get(name);
              if (c && c._stamp === `${meta[name].mtime_ms}:${meta[name].size}`) meta[name].crowded = c.over;
            }
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(JSON.stringify({ designs: files.map(f => f.replace(/\.json$/, "")), meta }));
          };
          // Only the designs whose file changed are re-measured — usually one, on a
          // save. A failure here costs a label and never the list: an exception
          // while decorating rows must not prevent them from being returned.
          const stale = Object.keys(meta).filter(name =>
            designCrowding.get(name)?._stamp !== `${meta[name].mtime_ms}:${meta[name].size}`);
          if (!stale.length) { reply(); return; }
          execFile("python3", [path.join(repoRoot, "tools", "site_api.py"), "crowding", "--names", stale.join(",")],
            { cwd: repoRoot, timeout: 20000, maxBuffer: 8 * 1024 * 1024 }, (e, out) => {
              try {
                const got = e ? {} : (JSON.parse(out).designs ?? {});
                for (const name of stale) {
                  if (got[name]) designCrowding.set(name, {
                    _stamp: `${meta[name].mtime_ms}:${meta[name].size}`, over: got[name].over ?? [] });
                }
              } catch { /* unparseable: the rows go out without the label */ }
              reply();
            });
          return;
        }
        if (req.method === "POST" && url === "/api/captures") {
          // KEEP A PICKED CAPTURE: a file chosen in the browser is copied into the
          // ACTIVE site's captures/, so a new site's scan reopens next session. Streamed —
          // a capture is hundreds of megabytes — to a temporary name, renamed when whole.
          if (refuseForeign(req, res)) return;
          const name = String(new URL(req.url, "http://x").searchParams.get("name") ?? "");
          res.setHeader("Content-Type", "application/json");
          if (!/^[\w .()-]{1,120}\.(ply|spz|splat|ksplat|sog|glb)$/i.test(name) || name.startsWith(".")) {
            res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: "a capture is a .ply, .spz, .splat, .ksplat, .sog or .glb file" })); return;
          }
          const dir = dataPath("captures");
          fs.mkdirSync(dir, { recursive: true });
          const part = path.join(dir, `.${name}.${randomUUID()}.part`);
          const out = fs.createWriteStream(part);
          req.pipe(out);
          out.on("finish", () => {
            fs.renameSync(part, path.join(dir, name));
            res.end(JSON.stringify({ ok: true, url: `/data/captures/${encodeURIComponent(name)}`,
                                     bytes: fs.statSync(path.join(dir, name)).size }));
          });
          const fail = e => { try { fs.unlinkSync(part); } catch {} if (!res.writableEnded) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(e.message ?? e) })); } };
          out.on("error", fail); req.on("error", fail);
          return;
        }
        if (req.method === "GET" && url === "/api/captures") {
          // so the viewer can re-open the capture it was last calibrated
          // against instead of making you pick the file every session
          const dir = dataPath("captures");
          let files = [];
          try {
            files = fs.readdirSync(dir)
              .filter(f => /\.(ply|spz|splat|ksplat|sog|glb)$/i.test(f))
              .sort();
          } catch { /* no captures yet */ }
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify({ captures: files }));
          return;
        }
        // The hand-edit path: the viewer emits an OP rather than
        // mutating the design, so a placement or a drag goes through the same
        // agent.execute() + validate() a model op does. A hand edit that wrote
        // design.json directly would reintroduce exactly the floating and
        // off-scan geometry the validators catch, except authored by the owner,
        // who will trust it more. This endpoint is the only thing that makes that
        // constraint real — without it postOps() takes its 404 branch and the
        // whole feature applies nothing.
        // The viewer's half of site.json, and ONLY its half. The file is split
        // by writer; merge_section enforces that for geodata and analyze_site.
        // The generic /api/save checks nothing, so it must not receive the whole
        // file: owner data cannot be regenerated (landmarks, hand-drawn areas
        // that designs scope to BY NAME). Enforcement stays in python: this
        // hands the patch to site_api save-owner rather than re-stating the rule.
        if (req.method === "POST" && url === "/api/site") {
          if (refuseForeign(req, res)) return;
          readBody(req, res, 8 * 1024 * 1024).then(buf => {
            if (!buf) return;
            const body = buf.toString("utf8");
            const child = execFile("python3",
              [path.join(repoRoot, "tools", "site_api.py"), "save-owner"],
              { cwd: repoRoot, timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
              (e, out, err) => {
                res.setHeader("Content-Type", "application/json");
                try {
                  const parsed = JSON.parse(out);
                  if (!parsed.ok) res.statusCode = 400;
                  res.end(JSON.stringify(parsed));
                } catch {
                  res.statusCode = 500;
                  res.end(JSON.stringify({ ok: false,
                    error: String(err || (e && e.message) || out || "save-owner produced no JSON").slice(0, 400) }));
                }
              });
            child.stdin.end(body);       // the patch goes on stdin: an area polygon
          });                            // must never have to survive a shell quote
          return;
        }

        // The sun, from the ONE solar model. tools/sun.py computes it and
        // refuses a bearing when north is unset; a second implementation in JS
        // could disagree with it.
        // THE PHOTOGRAPHS THAT EXIST, newest first.
        //
        // List the actual files rather than a hard-coded set of filenames.
        // Broker ids use `v_<uuid>` so a Vite restart cannot overwrite a
        // previous session's evidence.
        //
        // It also reports staleness, because the server is the only
        // thing that knows both mtimes, and a photograph older than the design
        // it claims to show is worse than no photograph.
        if (req.method === "GET" && url === "/api/views") {
          res.setHeader("Content-Type", "application/json");
          try {
            const dir = dataPath("views");
            const want = Math.max(1, Math.min(24, Number(
              new URL(req.url, "http://localhost").searchParams.get("n")) || 8));
            const rows = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
              .filter(n => n.endsWith(".jpg"))
              .map(n => { const st = fs.statSync(path.join(dir, n));
                          return { name: n, url: `/data/views/${n}`,
                                   bytes: st.size, mtime: st.mtimeMs }; })
              .sort((a, b) => b.mtime - a.mtime)
              .slice(0, want);
            let design = null;
            try { design = fs.statSync(dataPath("design.json")).mtimeMs; }
            catch { /* no design yet is not an error here */ }
            res.end(JSON.stringify({ ok: true, views: rows, design_mtime: design }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: String(e.message ?? e) }));
          }
          return;
        }

        // ACCESS TO THE DESIGN ARCHIVE.
        //
        // `snapshotWorking()` writes data/history/design-<stamp>.json on every
        // design switch. The owner needs access to these snapshots to return to
        // a previous design.
        //
        // WHAT IS REALLY ON DISK, newest first — the /api/views shape above, for
        // the same reason: a list pinned to what OUGHT to be there stops
        // describing what is.
        //
        // CONSECUTIVE DUPLICATES ARE COLLAPSED. In a measured archive, 100 of 182
        // snapshots (54%) are distinct; repeated rows list the same design eight
        // times — a history of when the file was COPIED rather than of when it
        // CHANGED. The kept row is the OLDEST of each run, because that is when
        // the design actually became what it is; `repeats` says how many times
        // it was archived unchanged afterwards.
        if (req.method === "GET" && url === "/api/history") {
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          try {
            const dir = dataPath("history");
            const q = new URL(req.url, "http://localhost").searchParams;
            const want = Math.max(1, Math.min(400, Number(q.get("n")) || 80));
            // CHRONOLOGICAL BEFORE ANYTHING ELSE — collapsing "consecutive
            // duplicates" is meaningless in alphabetical order, and readdirSync
            // is alphabetical.
            //
            // The stamp in the NAME is the only honest clock here. mtime is not:
            // a checkout touches every file, so a legacy snapshot without a name
            // stamp can have a recent mtime despite being months old. An undated
            // snapshot sorts OLDEST and reports stamp null so the row can say
            // "undated" instead of a date nobody measured. An artefact must carry
            // its own caveat so the user knows which dates are unverified.
            const stampOf = n => (/(\d{8})-(\d{6})/.exec(n) ?? []).slice(1).join("");
            const files = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
              .filter(n => n.endsWith(".json"))
              .sort((a, b) => (stampOf(a) || "0").localeCompare(stampOf(b) || "0"));
            const rows = [];
            for (const name of files) {
              const full = path.join(dir, name);
              let st, doc = null;
              try { st = fs.statSync(full); } catch { continue; }
              if (!st.isFile()) continue;
              let hash = null, counts = null;
              try {
                const raw = fs.readFileSync(full);
                hash = crypto.createHash("md5").update(raw).digest("hex");
                doc = JSON.parse(raw);
              } catch { /* an unreadable snapshot is listed, not fatal */ }
              if (doc) {
                counts = {};
                for (const k of ["beds", "paths", "edges", "patios",
                                 "plants", "steps", "objects"]) {
                  const n = (doc[k] ?? []).length;
                  if (n) counts[k] = n;
                }
              }
              const prev = rows[rows.length - 1];
              if (prev && hash && prev.hash === hash) { prev.repeats++; continue; }
              rows.push({
                name, hash, repeats: 0,
                url: `/data/history/${name}`,
                // the stamp is the only date that means anything: mtime moves
                // when a checkout touches the file, the NAME records when the
                // design was archived
                stamp: (/(\d{8})-(\d{6})/.exec(name) ?? []).slice(1).join("-") || null,
                bytes: st.size, mtime: st.mtimeMs,
                counts, total: counts
                  ? Object.values(counts).reduce((a, b) => a + b, 0) : null,
              });
            }
            rows.reverse();                  // newest first, like /api/views
            res.end(JSON.stringify({ ok: true, total: rows.length,
                                     archived: files.length,
                                     history: rows.slice(0, want) }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: String(e.message ?? e) }));
          }
          return;
        }

        // THE WHOLE DAY AT ONCE, so the hour can be DRAGGED.
        //
        // `/api/sun` shells out to sun.py for one instant, which is right for a
        // typed time and hopeless for a slider: dragging dawn to dusk would fire
        // a hundred subprocesses. sun.py already computes a whole day's track in
        // one call (`sun.py day`), so the viewer fetches it once per date and
        // interpolates between samples while the handle moves — the astronomy
        // stays in the one place that owns it and never becomes a second model
        // in JS.
        if (req.method === "GET" && url === "/api/sun/day") {
          const q = new URL(req.url, "http://localhost").searchParams;
          const args = [path.join(repoRoot, "tools", "sun.py"), "day"];
          const date = q.get("date"), step = q.get("step");
          if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) args.push("--date", date);
          if (step && /^\d{1,3}$/.test(step)) args.push("--step", step);
          execFile("python3", args,
            { cwd: repoRoot, timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
            (e, out, err) => {
              res.setHeader("Content-Type", "application/json");
              try {
                if (e && !out) throw new Error(String(err || e.message).slice(0, 300));
                res.end(out);
              } catch (x) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: String(x.message ?? x) }));
              }
            });
          return;
        }

        if (req.method === "GET" && url === "/api/sun") {
          const q = new URL(req.url, "http://localhost").searchParams;
          const args = [path.join(repoRoot, "tools", "sun.py"), "position"];
          // whitelisted and shape-checked: these reach a subprocess argv
          const date = q.get("date"), time = q.get("time"), off = q.get("utc_offset");
          if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) args.push("--date", date);
          if (time && /^\d{2}:\d{2}(:\d{2})?$/.test(time)) args.push("--time", time.slice(0, 5));
          if (off && /^-?\d{1,2}(\.\d+)?$/.test(off)) args.push("--utc-offset", off);
          execFile("python3", args,
            { cwd: repoRoot, timeout: 20000, maxBuffer: 1024 * 1024 },
            (e, out, err) => {
              res.setHeader("Content-Type", "application/json");
              try {
                res.end(JSON.stringify(JSON.parse(out)));
              } catch {
                // sun.py exits 2 and prints a refusal object when the property is
                // not set up far enough to ask; anything else is a real failure
                res.statusCode = 500;
                res.end(JSON.stringify({ error: String(err || (e && e.message) || out ||
                                        "sun.py produced no JSON").slice(0, 400) }));
              }
            });
          return;
        }

        if (req.method === "POST" && url === "/api/ops") {
          if (refuseForeign(req, res)) return;
          readBody(req, res, 2 * 1024 * 1024).then(buf => {
            if (!buf) return;
            let ops;
            try {
              const payload = JSON.parse(buf.toString("utf8"));
              ops = Array.isArray(payload) ? payload : payload.ops;
              if (!Array.isArray(ops) || !ops.length) throw new Error("ops[] required");
            } catch (e) {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, error: String(e.message ?? e) })); return;
            }
            // through site_api, not a second apply loop written in JS: one
            // execute() avoids disagreement between implementations (measured
            // differences reach 0.99 m)
            execFile("python3",
              [path.join(repoRoot, "tools", "site_api.py"), "apply-ops", JSON.stringify(ops)],
              { cwd: repoRoot, timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
              (e, out, err) => {
                res.setHeader("Content-Type", "application/json");
                try {
                  res.end(JSON.stringify(JSON.parse(out)));
                } catch {
                  res.statusCode = 500;
                  res.end(JSON.stringify({ ok: false, applied: [], rejected: [],
                    error: String(err || (e && e.message) || out ||
                                  "apply-ops produced no JSON").slice(0, 400) }));
                }
              });
          });
          return;
        }

        if (req.method === "POST" && url === "/api/design") {
          if (refuseForeign(req, res)) return;
          readBody(req, res, 24 * 1024 * 1024).then(buf => {
            if (!buf) return;
            try {
              let payload;
              try {
                payload = JSON.parse(buf.toString("utf8"));
                if (typeof payload.prompt !== "string" || !payload.prompt.trim())
                  throw new Error("prompt required");
                if (payload.images && !Array.isArray(payload.images)) throw new Error("images must be an array");
              } catch (e) {
                res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: String(e.message ?? e) })); return;
              }
              const dir = dataPath("detect");
              fs.mkdirSync(dir, { recursive: true });
              const imgPaths = (payload.images ?? [])
                .filter(s => typeof s === "string" && s.startsWith("data:image/"))
                .map((dataUrl, i) => {
                  const p = path.join(dir, `design_view${i + 1}.jpg`);
                  fs.writeFileSync(p, Buffer.from(dataUrl.replace(/^data:image\/\w+;base64,/, ""), "base64"));
                  return p;
                });
              const py = fs.existsSync(path.join(repoRoot, ".venv", "bin", "python"))
                ? path.join(repoRoot, ".venv", "bin", "python") : "python3";
              // --explore by default: measured on one site, one-shot averages
              // 3+ rejected ops per run and leaves walls retaining nothing, while
              // explore mode makes 119 site queries and produces zero rejections.
              // Both subscriptions measure, preview, look and revise.
              const args = designAgentArgs(payload, path.join(repoRoot, "tools", "agent.py"), imgPaths);
              execFile(py, args, { cwd: repoRoot, timeout: DESIGN_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
                (err, stdout, stderr) => {
                  try {
                    res.setHeader("Content-Type", "application/json");
                    const m = String(stdout).match(/\{[\s\S]*\}$/m);
                    if (!m) {
                      res.statusCode = 500;
                      res.end(JSON.stringify({ ok: false,
                        error: String(err?.message ?? stderr ?? "agent produced no result").slice(0, 400) }));
                      return;
                    }
                    res.end(JSON.stringify({ ok: true, ...JSON.parse(m[0]) }));
                  } catch (e) {
                    if (!res.writableEnded) {
                      res.statusCode = 500;
                      res.end(JSON.stringify({ ok: false, error: String(e.message ?? e).slice(0, 300) }));
                    }
                  }
                });
            } catch (e) {
              if (!res.writableEnded) {
                res.statusCode = 500;
                res.end(JSON.stringify({ ok: false, error: String(e.message ?? e).slice(0, 300) }));
              }
            }
          });
          return;
        }
        if (req.method === "POST" && url === "/api/name-landmarks") {
          // this endpoint spends subscription quota, so the Origin must be
          // present AND ours — a missing Origin is not a free pass
          if (refuseForeign(req, res)) return;
          readBody(req, res, 24 * 1024 * 1024).then(buf => {
            if (!buf) return;
            // everything below runs inside the 'end' handler, where an
            // uncaught throw takes the whole dev server down with it
            try {
              let payload;
              try {
                payload = JSON.parse(buf.toString("utf8"));
                if (!Array.isArray(payload.images) || !payload.images.length
                    || !payload.images.every(s => typeof s === "string" && s.startsWith("data:image/"))
                    || !Array.isArray(payload.candidates))
                  throw new Error("images (data URLs) and candidates required");
                payload.backend = payload.backend === "codex" ? "codex" : "claude";
              } catch (e) {
                res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: String(e.message ?? e) })); return;
              }
              nameLandmarks(payload, (err, stdout) => {
                try {
                  res.setHeader("Content-Type", "application/json");
                  if (err) {
                    res.statusCode = 500;
                    res.end(JSON.stringify({ ok: false, error: String(err.message ?? err).slice(0, 400) }));
                    return;
                  }
                  // the CLI may wrap JSON in prose or code fences
                  const m = String(stdout).match(/\{[\s\S]*\}/);
                  if (!m) { res.statusCode = 502; res.end(JSON.stringify({ ok: false, error: "no JSON in model reply" })); return; }
                  res.end(JSON.stringify({ ok: true, ...JSON.parse(m[0]) }));
                } catch (e) {
                  if (!res.writableEnded) {
                    res.statusCode = 502;
                    res.end(JSON.stringify({ ok: false, error: "unparseable model reply" }));
                  }
                }
              });
            } catch (e) {
              if (!res.writableEnded) {
                res.statusCode = 500;
                res.end(JSON.stringify({ ok: false, error: String(e.message ?? e).slice(0, 300) }));
              }
            }
          });
          return;
        }
        if (req.method === "GET" && url === "/api/view/subscribe") {
          res.writeHead(200, { "Content-Type": "text/event-stream",
                               "Cache-Control": "no-cache", "Connection": "keep-alive" });
          res.write("retry: 2000\n\n");
          viewBroker.subscribers.add(res);
          const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 15000);
          req.on("close", () => { clearInterval(ping); viewBroker.subscribers.delete(res); });
          return;
        }

        if (req.method === "POST" && url === "/api/view/request") {
          if (refuseForeign(req, res)) return;       // the broker too: a foreign page cannot queue renders
          readBody(req, res, 1024 * 1024).then(buf => {
            if (!buf) return;
            res.setHeader("Content-Type", "application/json");
            let cmd;
            try { cmd = JSON.parse(buf.toString("utf8")); }
            catch (e) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: String(e.message) })); return; }
            brokerRequest(cmd, out => { if (!res.writableEnded) res.end(JSON.stringify(out)); });
          });
          return;
        }

        // THE GEOMETRY ITSELF, as bytes rather than as base64 in a JSON reply.
        //
        // A .glb encoded as base64 can exceed the JS string limit and throw
        // "Invalid string length". The broker's reply is for small answers;
        // large meshes must be transferred as bytes.
        if (req.method === "POST" && url === "/api/view/export") {
          if (refuseForeign(req, res)) return;
          readBody(req, res, 2 * 1024 * 1024 * 1024, "scene too large").then(buf => {
            if (!buf) return;
            res.setHeader("Content-Type", "application/json");
            try {
              const dir = dataPath("photoreal");
              fs.mkdirSync(dir, { recursive: true });
              // Each caller imports its own snapshot, even if another viewer or
              // design run exports before Blender has finished reading it.
              const name = `scene_${randomUUID()}.glb`;
              const file = path.join(dir, name);
              fs.writeFileSync(file, buf);
              // Agent snapshots belong to their caller and are deleted after
              // review. Manual exports retain the single --reuse-scene cache.
              const snapshot = req.headers["x-yardtwin-snapshot"] === "1";
              if (!snapshot) fs.renameSync(file, path.join(dir, "scene.glb"));
              res.end(JSON.stringify({ ok: true, path: `data/photoreal/${snapshot ? name : "scene.glb"}`,
                                       bytes: buf.length }));
            } catch (e) {
              res.statusCode = 500;
              res.end(JSON.stringify({ ok: false, error: String(e.message ?? e) }));
            }
          });
          return;
        }

        if (req.method === "POST" && url === "/api/view/result") {
          if (refuseForeign(req, res)) return;       // the broker too: a foreign page cannot queue renders
          readBody(req, res, 32 * 1024 * 1024).then(buf => {
            if (!buf) return;
            res.setHeader("Content-Type", "application/json");
            try {
              const { id, dataUrl, meta, error } = JSON.parse(buf.toString("utf8"));
              const p = viewBroker.pending.get(id);
              if (!p) { res.end(JSON.stringify({ ok: false, error: "unknown or expired id" })); return; }
              p.replies++;
              if (error) {
                // HELD, not returned — another subscriber may be able to do this
                p.lastError = { ok: false, error };
                if (p.replies < p.expect) { res.end(JSON.stringify({ ok: true })); return; }
                clearTimeout(p.timer);
                viewBroker.pending.delete(id);
                p.cb(p.lastError);
                res.end(JSON.stringify({ ok: true })); return;
              }
              clearTimeout(p.timer);
              viewBroker.pending.delete(id);
              // a non-image result (e.g. a scan grid) comes back as plain data
              const data = JSON.parse(buf.toString("utf8")).data;
              if (data) { p.cb({ ok: true, id, data });
                          res.end(JSON.stringify({ ok: true })); return; }
              if (!dataUrl) { p.cb({ ok: false, error: "viewer returned nothing" });
                              res.end(JSON.stringify({ ok: true })); return; }
              // THE BACKSTOP. The browser refuses a black frame at the point it
              // is drawn (src/framecheck.js), and this is the ONE place a frame
              // reaches disk, so it refuses one too: black files must not be
              // presented as photographs of the garden. `brightest_pixel` is
              // the browser's own measurement of what it draws; absent means an
              // older client that does not measure, and absence is not evidence
              // of a fault.
              if (meta && meta.brightest_pixel === 0) {
                p.cb({ ok: false, error:
                  "refused to save a completely black frame — nothing was drawn. "
                  + "The WebGL context is most likely dead; reload the viewer tab "
                  + "in Fast preview and try again." });
                res.end(JSON.stringify({ ok: true })); return;
              }
              const dir = dataPath("views");
              fs.mkdirSync(dir, { recursive: true });
              const file = path.join(dir, `${id}.jpg`);
              fs.writeFileSync(file, Buffer.from(String(dataUrl).replace(/^data:image\/\w+;base64,/, ""), "base64"));
              p.cb({ ok: true, id, path: file, meta: meta ?? {} });
              res.end(JSON.stringify({ ok: true }));
            } catch (e) {
              if (!res.writableEnded) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: String(e.message) })); }
            }
          });
          return;
        }

        // PATH-TRACE ONE VIEW. Minutes for the first frame of a session,
        // ~28 s for each one after — so it is a deliberate act with a button,
        // not something that happens while you look around.
        //
        // It shells out to tools/photoreal.py rather than reimplementing any of
        // it: the sun, the standing point, the which-way-is-up measurement and
        // the BEARING-UNVERIFIED naming all live there, so sharing that code
        // prevents duplicate implementations from disagreeing.
        if (req.method === "POST" && url === "/api/photoreal") {
          if (refuseForeign(req, res)) return;
          readBody(req, res, 1024 * 1024).then(buf => {
            if (!buf) return;
            res.setHeader("Content-Type", "application/json");
            let b = {};
            try { b = JSON.parse(buf.toString("utf8") || "{}"); }
            catch { res.statusCode = 400; res.end(JSON.stringify({ error: "bad json" })); return; }
            const args = [path.join(repoRoot, "tools", "photoreal.py")];
            // whitelisted and shape-checked: these reach a subprocess argv
            if (typeof b.viewpoint === "string" && b.viewpoint)
              args.push("--viewpoint", b.viewpoint.slice(0, 80));
            else if (typeof b.subject === "string" && b.subject)
              args.push("--subject", b.subject.slice(0, 80));
            for (const [k, flag, lo, hi] of [["samples", "--samples", 4, 512],
                                             ["width", "--width", 160, 3840],
                                             ["height", "--height", 120, 2160]]) {
              const v = Math.round(Number(b[k]));
              if (Number.isFinite(v) && v >= lo && v <= hi) args.push(flag, String(v));
            }
            if (b.reuse) args.push("--reuse-scene");
            execFile("python3", args, { cwd: repoRoot, timeout: 40 * 60 * 1000,
                                        maxBuffer: 8 * 1024 * 1024 },
              (e, out, err) => {
                try {
                  const parsed = JSON.parse(out || "{}");
                  if (!parsed.ok) { res.statusCode = 400; res.end(JSON.stringify(parsed)); return; }
                  // hand back a URL the page can show, not a filesystem path
                  const rel = path.relative(repoRoot, parsed.image).split(path.sep).join("/");
                  res.end(JSON.stringify({ ...parsed, url: "/" + rel }));
                } catch {
                  res.statusCode = 500;
                  res.end(JSON.stringify({ error: String(err || e?.message || "failed").slice(0, 400) }));
                }
              });
          });
          return;
        }

        if (req.method === "POST" && url === "/api/walkthrough") {
          if (refuseForeign(req, res)) return;
          readBody(req, res, 48 * 1024 * 1024).then(buf => {
            if (!buf) return;
            try {
              let payload;
              try {
                payload = JSON.parse(buf.toString("utf8"));
                if (!Array.isArray(payload.frames) || !payload.frames.length
                    || !payload.frames.every(f => typeof f?.dataUrl === "string"
                         && f.dataUrl.startsWith("data:image/") && Array.isArray(f.eye)))
                  throw new Error("frames [{dataUrl, name, eye, look, ground_m}] required");
              } catch (e) {
                res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: String(e.message ?? e) })); return;
              }
              critiqueWalkthrough(payload, (err, stdout) => {
                res.setHeader("Content-Type", "application/json");
                if (err) {
                  res.statusCode = 500;
                  res.end(JSON.stringify({ ok: false, error: String(err.message ?? err).slice(0, 400) }));
                  return;
                }
                res.end(JSON.stringify({ ok: true, critique: String(stdout).trim() }));
              });
            } catch (e) {
              if (!res.writableEnded) {
                res.statusCode = 500;
                res.end(JSON.stringify({ ok: false, error: String(e.message ?? e).slice(0, 300) }));
              }
            }
          });
          return;
        }
        // WHAT A PROJECT IS.
        //
        // A project here is the `data/` directory of ONE property: the capture,
        // the calibration that makes its coordinates mean something, the owner's
        // ground truth, the designs, and the derived measurements. There is no
        // "save" because every one of those is written the moment it changes —
        // so the answer is an INVENTORY rather than a button, and the browser
        // cannot stat files.
        // PROJECTS: list, start a new one, switch. tools/project.py owns what a
        // project is; this only carries the request. A switch takes effect on the next
        // request everywhere — this server, the python tools, the MCP server — because
        // every one of them resolves the active project per call.
        if (url === "/api/projects" && (req.method === "GET" || req.method === "POST")) {
          if (req.method === "POST" && refuseForeign(req, res)) return;    // the list is read-only
          const run = (args, status = 200) => execFile("python3", [path.join(repoRoot, "tools", "project.py"), ...args],
            { cwd: repoRoot, timeout: 20000 }, (e, out, err) => {
              res.setHeader("Content-Type", "application/json");
              res.setHeader("Cache-Control", "no-store");
              if (e) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: String(err || e.message).trim().split("\n").pop() })); return; }
              res.statusCode = status;
              res.end(JSON.stringify({ ok: true, ...JSON.parse(out) }));
            });
          if (req.method === "GET") { run(["list"]); return; }
          readBody(req, res, 4096).then(buf => {
            if (!buf) return;
            const body = buf.toString("utf8");
            let q = {};
            try { q = JSON.parse(body || "{}"); } catch { /* answered below */ }
            const name = String(q.name ?? "").trim().slice(0, 80);
            if (q.action === "new" && name && !name.startsWith("-")) run(["new", name, "--open"], 201);
            else if (q.action === "open" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(q.slug ?? "")) run(["open", q.slug]);
            else if (q.action === "demo") run(["demo", "--open"], 201);         // made once, then opened
            else { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: "want {action:'new', name}, {action:'open', slug} or {action:'demo'}" })); }
          });
          return;
        }
        // THE LAST TWO SETUP STEPS: the survey (tools/analyze_site.py, which asks
        // THIS viewer to raycast the scan, so the page must be open) and the address
        // lookup (tools/geodata.py). Run here, for the ACTIVE site, so a new site can be
        // set up without a command line. The tools own the work; this only starts them.
        if (req.method === "POST" && (url === "/api/setup/survey" || url === "/api/setup/address")) {
          if (refuseForeign(req, res)) return;
          readBody(req, res, 4096).then(buf => {
            if (!buf) return;
            const body = buf.toString("utf8");
            res.setHeader("Content-Type", "application/json");
            let args;
            if (url === "/api/setup/survey") args = [path.join(repoRoot, "tools", "analyze_site.py")];
            else {
              let address = "";
              try { address = String(JSON.parse(body || "{}").address ?? "").trim(); } catch { /* answered below */ }
              if (!address || address.length > 160 || address.startsWith("-")) {
                res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: "give a street address" })); return;
              }
              args = [path.join(repoRoot, "tools", "geodata.py"), "--address", address];
            }
            execFile("python3", args, { cwd: repoRoot, timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 },
              (e, out, err) => {
                const tail = s => String(s ?? "").trim().split("\n").slice(-3).join("\n");
                if (e) { res.statusCode = 422; res.end(JSON.stringify({ ok: false, error: tail(err || e.message) })); return; }
                res.end(JSON.stringify({ ok: true, said: tail(out) }));
              });
          });
          return;
        }
        // THE PLANT CODE'S VERSION: a hash of the viewer's source. The asset window keeps
        // the pictures it draws under it in the browser, so an edited builder is never shown
        // from a stale picture; hashed on each ask, so an edit mid-session counts.
        if (req.method === "GET" && url === "/api/plant-build") {
          const h = crypto.createHash("sha1"), src = path.join(repoRoot, "viewer", "src");
          const walk = d => fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name < y.name ? -1 : 1)
            .forEach(e => e.isDirectory() ? walk(path.join(d, e.name))
              : e.name.endsWith(".js") && h.update(e.name).update(fs.readFileSync(path.join(d, e.name))));
          walk(src);
          for (const f of speciesFiles()) h.update(path.basename(f)).update(fs.readFileSync(f));   // the library's
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify({ build: h.digest("hex").slice(0, 16), plants: plantCodeVersion(repoRoot) }));
          return;
        }
        if (req.method === "GET" && url === "/api/project") {
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          const stat = rel => {
            const abs = resolvePath(rel);
            try {
              const st = fs.statSync(abs);
              if (st.isDirectory()) {
                const f = fs.readdirSync(abs).filter(n => !n.startsWith("."));
                let bytes = 0;
                for (const n of f) {
                  try { bytes += fs.statSync(path.join(abs, n)).size; } catch {}
                }
                return { path: rel, exists: true, items: f.length, bytes,
                         mtime: st.mtimeMs };
              }
              return { path: rel, exists: true, bytes: st.size, mtime: st.mtimeMs };
            } catch { return { path: rel, exists: false }; }
          };
          let project = {};
          try { project = JSON.parse(fs.readFileSync(dataPath("project.json"), "utf8")); }
          catch { /* not named yet */ }
          let address = null;
          try {
            address = JSON.parse(fs.readFileSync(dataPath("site.json"), "utf8")).address ?? null;
          } catch { /* no site yet */ }
          res.end(JSON.stringify({
            ok: true,
            project: activeProject(),
            // shown as a person writes it: ~/PEDON/home, or data when no site is open
            folder: activeProject() ? projectFolder().replace(os.homedir(), "~") : "data",
            name: project.name || address || "this site",
            named: !!project.name,
            address,
            // THE ORDER IS THE ARGUMENT: what the property IS, then what makes
            // its numbers mean something, then what the owner decides, then the work.
            parts: [
              { what: "the capture", why: "the scan everything is measured off",
                ...stat("data/captures") },
              { what: "calibration", why: "level, north and scale — without it every coordinate is arbitrary",
                ...stat("data/calibration.json") },
              { what: "your ground truth", why: "landmarks, drawn areas, saved views, the address",
                ...stat("data/site.json") },
              { what: "the working design", why: "what the viewer is showing",
                ...stat("data/design.json") },
              { what: "saved designs", why: "every version you kept",
                ...stat("data/designs") },
              { what: "measured ground", why: "the 1 m raycast the site queries read",
                ...stat("data/terrain_scan.json") },
              { what: "photographs", why: "what the garden looked like, and your own plant photos",
                ...stat("data/views") },
            ],
          }));
          return;
        }

        if (req.method === "POST" && url === "/api/save") {
          if (refuseForeign(req, res)) return;
          readBody(req, res, 24 * 1024 * 1024).then(buf => {
            if (!buf) return;
            const body = buf.toString("utf8");
            try {
              const { file, json } = JSON.parse(body);
              if (!/^data\/[\w./-]+\.json$/.test(file) || file.includes("..")) throw new Error("bad path");
              const target = resolvePath(file);
              fs.mkdirSync(path.dirname(target), { recursive: true });
              fs.writeFileSync(target, JSON.stringify(json, null, 2));
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: true }));
            } catch (e) {
              res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: String(e) }));
            }
          });
          return;
        }
        next();
      });
    },
  };
}

/**
 * THE LIBRARY'S PLANT CODE, SERVED AS THE APP'S OWN. A species module lives in the user's
 * library, outside this app, and imports `@pedon/<file>` (viewer/src) and bare packages ("three");
 * both resolve exactly as the app's own code would, so the page has one three.js and one texture
 * loader — a bare "three/addons/…" from outside the root does not resolve directly. The
 * page asks /api/species for the modules, in order (viewer/src/species.js). The Node twin is
 * species_hooks.mjs.
 */
function speciesPlugin() {
  const src = path.join(__dirname, "src");
  const asApp = path.join(src, "plants.js");             // a bare import resolves as from here
  const library = libraryRoot(), real = libraryRealRoot();
  const inLibrary = id => !!id && (id.startsWith(real + path.sep) || id.startsWith(library + path.sep));
  return {
    name: "pedon-species",
    enforce: "pre",
    async resolveId(source, importer, opts) {
      if (source.startsWith("@pedon/"))
        return this.resolve(path.join(src, source.slice(7)), asApp, { ...opts, skipSelf: true });
      if (!inLibrary(importer) || /^(\.|\/|\0|[a-z][a-z0-9+.-]*:)/i.test(source)) return null;
      return this.resolve(source, asApp, { ...opts, skipSelf: true });
    },
    configureServer(server) {
      // a species added, removed or edited in the library redraws the page with it
      const dir = speciesDir(library);
      server.watcher.add(dir);
      const reload = f => { if (f.startsWith(dir + path.sep)) server.ws.send({ type: "full-reload" }); };
      server.watcher.on("add", reload).on("unlink", reload).on("change", reload);
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];
        if (req.method === "GET" && url === "/api/species") {
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify(speciesFiles().map(f => "/@fs" + f.split(path.sep).join("/"))));
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [speciesPlugin(), pedonPlugin()],
  // the library is outside the app; the page loads its species modules from there
  server: { port: 5178, fs: { allow: [searchForWorkspaceRoot(process.cwd()), libraryRoot(), libraryRealRoot()] } },
  build: { target: "es2022" },       // species.js waits for the library at the top level
});
