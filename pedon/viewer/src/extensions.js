// The extension host: registries, the manifest check, and the capability object.
//
// See pedon/EXTENSIONS.md for the contract. Two things this file exists to
// make impossible, both from the project's own rules:
//
//   - an extension cannot write a file. It gets `ctx.ops.apply(...)`, which is
//     POST /api/ops -> agent.execute() + validate(), the one write path every
//     hand drag and model op already takes.
//   - an extension cannot add a hard rejection, only a warning. Every rejection
//     is measured ground or building code, because the library must never cap
//     the design.
//
// THE CAPABILITY OBJECT IS THE SANDBOX BOUNDARY. Extensions load as trusted
// modules today; `ctx` is built per extension from its declared permissions and
// hands over nothing else. Every capability is therefore already a message-shaped
// call on an object the host owns, so moving it across a Worker port later
// changes this file and not one extension.

/** Every extension point. A contribution to anything not named here is refused. */
export const POINTS = ["tools", "commands", "inspectors", "overlays", "objects"];

/** Every capability an extension may ask for, and what it unlocks on `ctx`. */
export const PERMISSIONS = {
  "ops:write": "ops",          // ctx.ops.apply — the ONLY way to change a design
  "design:read": "design",     // a read-only snapshot of the current document
  "site:read": "site",         // measured ground: zones, areas, landmarks
  "assets:read": "assets",     // the plant palette and object catalog
  "selection:read": "selection",
  "selection:write": "selection",
  "view:control": "view",      // camera, modes, look
  "ui:notify": "ui",           // log lines and toasts
  "storage": "storage",        // namespaced localStorage, VIEW state only
};

const ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;

/**
 * Check a manifest before anything is loaded from it.
 *
 * Returns a list of problems; empty means it is loadable. It REPORTS rather than
 * throwing because a bad third-party manifest must not take the app down with it
 * — the same reason objects.js reverts a generated builder that will not render.
 */
export function checkManifest(m) {
  const bad = [];
  if (!m || typeof m !== "object") return ["not an object"];
  if (!ID_RE.test(m.id ?? "")) bad.push(`id ${JSON.stringify(m.id)} must look like dev.pedon.thing`);
  if (!/^\d+\.\d+\.\d+$/.test(m.version ?? "")) bad.push("version must be semver, e.g. 1.0.0");
  for (const p of m.permissions ?? [])
    if (!(p in PERMISSIONS)) bad.push(`unknown permission ${JSON.stringify(p)}`);
  for (const k of Object.keys(m.contributes ?? {}))
    if (!POINTS.includes(k)) bad.push(`unknown extension point ${JSON.stringify(k)}`);
  for (const ins of m.contributes?.inspectors ?? [])
    if (!ins.forKind) bad.push("an inspector must say what kind it is for");
  for (const t of m.contributes?.tools ?? [])
    if (!t.id) bad.push("a dock tool needs an id");
  if (typeof m.activate !== "undefined" && typeof m.activate !== "function")
    bad.push("activate must be a function");
  return bad;
}

/**
 * Build the capability object for ONE extension from its declared permissions.
 *
 * `host` is the app's full set of capabilities; this hands back only the slices
 * the manifest asked for. An over-broad manifest is then visible in review rather
 * than being the silent default, and an extension that reaches for something it
 * did not declare gets `undefined` rather than the app's internals.
 */
export function capabilities(manifest, host) {
  const ctx = { id: manifest.id, version: manifest.version };
  for (const p of manifest.permissions ?? []) {
    const slice = PERMISSIONS[p];
    if (!slice || !(slice in host)) continue;
    // two permissions can map to one slice (selection:read / selection:write);
    // the host decides what each contains, this only decides whether it is handed over
    ctx[slice] = host[slice](p);
  }
  return ctx;
}

/** The live registries. One array per extension point, in load order. */
export function createRegistry() {
  const reg = Object.fromEntries(POINTS.map(p => [p, []]));
  const loaded = new Map();
  const problems = [];

  return {
    get: point => reg[point] ?? [],
    /** every extension that loaded, for an about-screen and for support */
    list: () => [...loaded.values()].map(({ manifest }) =>
      ({ id: manifest.id, version: manifest.version, name: manifest.name ?? manifest.id })),
    problems: () => problems.slice(),

    /**
     * Register one extension. Refuses rather than throws, and refuses a DUPLICATE
     * id — two copies of a plugin silently both contributing a dock tool is a
     * second copy of a vocabulary, the class of bug that leaves an element
     * undeletable.
     */
    load(manifest, host) {
      const bad = checkManifest(manifest);
      if (bad.length) { problems.push(`${manifest?.id ?? "?"}: ${bad.join("; ")}`); return false; }
      if (loaded.has(manifest.id)) {
        problems.push(`${manifest.id}: already loaded — a duplicate is refused`);
        return false;
      }
      const ctx = capabilities(manifest, host);
      for (const [point, items] of Object.entries(manifest.contributes ?? {}))
        for (const item of items)
          reg[point].push({ ...item, _from: manifest.id, _ctx: ctx });
      loaded.set(manifest.id, { manifest, ctx });
      try { manifest.activate?.(ctx); }
      catch (e) { problems.push(`${manifest.id}: activate threw — ${e.message}`); }
      return true;
    },

    /**
     * The inspector for a kind. LAST writer wins so a later extension can
     * deliberately override a built-in one; core loads first for that reason.
     */
    inspectorFor(kind) {
      const all = reg.inspectors.filter(i => i.forKind === kind);
      return all.length ? all[all.length - 1] : null;
    },
  };
}
