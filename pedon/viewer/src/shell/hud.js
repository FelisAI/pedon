// A readout that sits ON the canvas, next to the thing it describes.
//
// `describeRun` writes a measurement into `#measureOut`, a div inside a
// COLLAPSIBLE SECTION of a panel that is itself hidden. Without a readout on the
// canvas you click points, lines appear on the ground, and the answer lands
// somewhere you cannot see.
//
// That is the general failure this module exists to stop: a result that appears
// somewhere other than where the user is looking has not been reported. A HUD is
// pinned to the work.

export function mountHud(id, { className = "" } = {}) {
  const el = document.createElement("div");
  el.id = id;
  el.className = `p-hud ${className}`.trim();
  el.hidden = true;
  document.body.appendChild(el);

  return {
    element: el,
    /**
     * `lines` is an array of [label, value] pairs, or plain strings for a note.
     * `at` is a screen point; without one the HUD parks bottom-centre above the
     * dock, which is right for a readout with no single anchor.
     */
    show(lines, at) {
      el.innerHTML = "";
      for (const l of lines) {
        const row = document.createElement("div");
        if (Array.isArray(l)) {
          row.className = "hud-row";
          const k = document.createElement("span");
          k.className = "hud-k"; k.textContent = l[0];
          const v = document.createElement("span");
          v.className = "hud-v p-num"; v.textContent = l[1];
          row.append(k, v);
        } else {
          row.className = "hud-note";
          row.textContent = l;
        }
        el.appendChild(row);
      }
      el.hidden = false;
      if (at) {
        const r = el.getBoundingClientRect();
        // above and right of the point, kept on screen — the cursor is at the
        // point and a readout under it is a readout you cannot read
        const left = Math.min(Math.max(12, at.x + 16), innerWidth - r.width - 12);
        const top = Math.min(Math.max(12, at.y - r.height - 14), innerHeight - r.height - 12);
        el.style.left = `${Math.round(left)}px`;
        el.style.top = `${Math.round(top)}px`;
        el.style.transform = "none";
      } else {
        // NOT BOTTOM-CENTRE. Parked there it sits directly above the dock, at the
        // same width and the same weight, and reads as a SECOND TOOLBAR — two
        // bars on the screen where there should be one. A readout with no
        // anchor belongs out of the way, not in line with the controls.
        el.style.left = "";
        el.style.right = "var(--p-3)";
        el.style.top = "60px";
        el.style.bottom = "";
        el.style.transform = "none";
      }
    },
    hide() { el.hidden = true; },
    isOpen: () => !el.hidden,
  };
}
