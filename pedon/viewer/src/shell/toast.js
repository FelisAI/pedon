// Transient messages, instead of a console dangling across the bottom.
//
// A log is the wrong shape for most of what the viewer says. Almost every line is
// an acknowledgement of something the user has just done — a plant placed, a
// design saved — which they can see happened. Those should appear, say so, and
// go.
//
// What a log IS right for is the small minority that must not be missed: a
// refusal, an error, the reason an edit did not apply. Those stay until dismissed,
// and the whole history is still there behind a command, because the one write
// path's bargain is that a hand edit is REFUSED VISIBLY — losing a refusal would
// break it.

// WHAT IS NEWS. A design error stays until dismissed — and every edit returns
// the design's whole error list, so an error the design already carries would come
// back as a fresh sticky toast after EVERY edit: three identical ones stacked after
// two moves (a thyme in a sage's planting hole, say). An error is told once
// per design; it is told again only if it goes away and comes back, or grows (its
// number is how far over, so a worse one is a different line).
export function newSince(memory, key, items) {
  const before = memory.get(key) ?? new Set();
  memory.set(key, new Set(items));
  return items.filter(x => !before.has(x));
}

const LIFETIME = { ok: 2600, "": 3200, warn: 7000, err: 0 };   // 0 = until dismissed

export function mountToasts({ max = 4 } = {}) {
  const wrap = document.createElement("div");
  wrap.id = "pToasts";
  wrap.setAttribute("aria-live", "polite");
  document.body.appendChild(wrap);

  const history = [];
  const live = [];

  function dismiss(t) {
    const i = live.indexOf(t);
    if (i < 0) return;
    live.splice(i, 1);
    t.el.classList.add("going");
    // let the transition run, then remove. Timed rather than transitionend,
    // because prefers-reduced-motion makes that event never fire.
    setTimeout(() => t.el.remove(), 180);
  }

  return {
    element: wrap,
    history: () => history.slice(),
    push(msg, cls = "") {
      const at = new Date();
      history.push({ msg, cls, at });
      if (history.length > 500) history.shift();

      const el = document.createElement("div");
      el.className = `toast ${cls}`.trim();
      const text = document.createElement("span");
      text.textContent = msg;
      el.appendChild(text);
      const t = { el, cls };

      // an error is the one kind you must acknowledge, so it gets the only
      // affordance that says "this is still here": a close button
      if (!LIFETIME[cls]) {
        const x = document.createElement("button");
        x.type = "button"; x.className = "toast-x"; x.textContent = "✕";
        x.setAttribute("aria-label", "Dismiss");
        x.onclick = () => dismiss(t);
        el.appendChild(x);
      }

      wrap.appendChild(el);
      live.push(t);
      // OLDEST FIRST, and never an error: a stack that pushes a refusal off
      // screen to make room for "planted p42" is the failure this prevents
      while (live.length > max) {
        const victim = live.find(x => LIFETIME[x.cls]) ?? live[0];
        dismiss(victim);
      }
      const ms = LIFETIME[cls] ?? LIFETIME[""];
      if (ms) setTimeout(() => dismiss(t), ms);
      return t;
    },
    clear() { for (const t of live.slice()) dismiss(t); },
  };
}

/** The history as plain lines, newest last — what a "show me the log" command prints. */
export function formatHistory(rows, limit = 80) {
  return rows.slice(-limit).map(r => {
    const hh = String(r.at.getHours()).padStart(2, "0");
    const mm = String(r.at.getMinutes()).padStart(2, "0");
    const ss = String(r.at.getSeconds()).padStart(2, "0");
    const tag = r.cls === "err" ? "ERROR " : r.cls === "warn" ? "warn  "
              : r.cls === "ok" ? "ok    " : "      ";
    return `${hh}:${mm}:${ss} ${tag}${r.msg}`;
  }).join("\n");
}
