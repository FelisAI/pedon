// The command registry — what ⌘K can do, and the single source for it.
//
// A command is a NAME, a place it belongs, and a function. The palette, the dock
// and any keyboard shortcut all read this one list, which is the point: a panel
// of dozens of controls has no way to ask "what can this app do?", because the
// answer is distributed across its event handlers and a reader's memory.
//
// Core commands are declared here; extensions contribute more through
// `contributes.commands` (see pedon/EXTENSIONS.md). Both end up in the same
// list, so an extension's feature is as reachable as a built-in one — which is
// the difference between a plugin system and a plugin menu.

/** @typedef {{id:string, title:string, group:string, hint?:string, keys?:string,
 *             when?:() => boolean, run:() => any}} Command */

export function createCommands() {
  /** @type {Command[]} */
  const list = [];
  return {
    add(cmd) {
      if (!cmd?.id || !cmd.title || typeof cmd.run !== "function") return false;
      if (list.some(c => c.id === cmd.id)) return false;   // first writer wins
      list.push({ group: "General", ...cmd });
      return true;
    },
    all: () => list.slice(),
    /** only what is applicable right now — a palette full of dead rows is a list */
    available: () => list.filter(c => { try { return c.when ? c.when() : true; }
                                       catch { return false; } }),
    get: id => list.find(c => c.id === id) ?? null,
    run(id, ...args) {
      const c = list.find(x => x.id === id);
      if (!c) throw new Error(`no command ${id}`);
      return c.run(...args);
    },
  };
}

/**
 * Rank commands for a query.
 *
 * Subsequence matching, not substring: "wtg" should find "Walk the garden",
 * because that is how a palette is actually typed once you know the app. A
 * prefix match on a word still outranks a scattered one, so short exact-ish
 * queries behave the way a menu would.
 *
 * Pure, and exported on its own so it can be tested without a DOM — the same
 * reason orderDesigns lives outside main.js's module scope.
 */
export function rankCommands(cmds, query) {
  const q = (query ?? "").trim().toLowerCase();
  if (!q) return cmds.slice();
  const scored = [];
  for (const c of cmds) {
    const hay = `${c.title} ${c.group} ${c.hint ?? ""}`.toLowerCase();
    let score = null;
    const at = hay.indexOf(q);
    if (at === 0) score = 1000;                       // starts the title
    else if (at > 0 && /\s/.test(hay[at - 1])) score = 900 - at;   // starts a word
    else if (at > 0) score = 700 - at;                // somewhere inside
    else {
      // SUBSEQUENCE, BUT ON WORD INITIALS FIRST.
      //
      // A plain subsequence makes "wtg" return four rows — "Walk the garden", but
      // also "Show everything", "View settings" and "Ask what's wrong", because w, t
      // and g appear in that order somewhere inside all of them. A three-letter
      // query returning three pieces of junk is worse than returning nothing:
      // you stop trusting the first result, which is the only one you wanted.
      //
      // So initials are matched first and scored high — that is how a palette is
      // actually typed once you know an app — and a loose mid-word subsequence
      // only counts for queries long enough (4+) for the coincidence to be
      // unlikely.
      const initials = hay.split(/[^a-z0-9]+/).filter(Boolean).map(w => w[0]).join("");
      const at2 = initials.indexOf(q);
      if (at2 === 0) score = 620;
      else if (at2 > 0) score = 560 - at2;
      else if (q.length >= 4) {
        let i = 0, runs = 0, last = -2, first = -1;
        for (let j = 0; j < hay.length && i < q.length; j++) {
          if (hay[j] === q[i]) {
            if (first < 0) first = j;
            if (j !== last + 1) runs++;
            last = j; i++;
          }
        }
        if (i === q.length) score = 420 - runs * 20 - first;
      }
    }
    if (score !== null) scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score || a.c.title.localeCompare(b.c.title));
  return scored.map(s => s.c);
}

/** "⌘K" on a Mac, "Ctrl K" elsewhere — shown, never guessed at by the reader. */
export const isMac = () =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");
export const prettyKeys = keys =>
  (keys ?? "").replace(/\bmod\b/g, isMac() ? "⌘" : "Ctrl")
              .replace(/\bshift\b/g, "⇧").replace(/\balt\b/g, isMac() ? "⌥" : "Alt");
