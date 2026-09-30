// Is this property actually set up, and if not, what is the next thing to do?
//
// `analyze_site.py` has a strict order — Fit ground, Set north, click a span to
// lock the scale, then analyse — and doing it out of order silently produces a
// wrong yard. Silently is the whole problem: every coordinate stays
// self-consistent, so nothing looks broken and no validator can object. When
// `site.frame.north_set` is FALSE, site.json carries its own warning saying so:
//
//   "North has NOT been set on this capture, so every bearing below is relative
//    to the scan's own arbitrary heading, not to true north... Bearings, contour
//    directions and the compass sense of zone names are UNVERIFIED."
//
// The shell has to say it too, and from a key that exists: a hint computed from
// a key site.json does not have (such as `siteCache.registration`) reads "not
// calibrated" on every property forever, calibrated or not. A warning that is
// always on is not a warning.
//
// `sun.py` is the model to follow: it REFUSES to report a bearing until north is
// set, rather than printing a fallback as fact.
//
// Pure — it takes the two state objects and returns a list. No DOM, no
// localStorage, no fetch.

/**
 * The setup path, in the order it must be done, with each step's state.
 *
 * `state` is "done", "next" (the first thing outstanding) or "todo". `blocking`
 * says whether getting it wrong makes the DESIGN wrong, as opposed to making
 * some feature unavailable: a missing address costs you the climate zone, while
 * a missing north silently rotates every bearing in the file.
 */
export function setupSteps({ calib, site } = {}) {
  const c = calib ?? {}, s = site ?? {};
  const steps = [
    { id: "capture", title: "Load the capture",
      why: "the scan of the real site — everything else is measured off it",
      done: !!(c.capture || s.landmarks_frame || s.frame?.capture),
      blocking: true, action: "captureSel" },
    { id: "ground", title: "Fit the ground",
      why: "levels the scan, so heights are heights and not a tilted plane",
      done: !!c.plane, blocking: true, action: "btnLevel" },
    { id: "north", title: "Set north",
      why: "until this is done every bearing is relative to the scanner's own "
         + "arbitrary heading — slopes stay right, directions do not",
      // the LIVE calibration first, then what site.json recorded: the browser
      // may have set north since the file was last written
      done: !!(c.northSet || s.frame?.north_set), blocking: true, action: "btnNorth" },
    // ACCEPTING THE CAPTURE'S OWN SCALE COUNTS. Measuring before locking the
    // scale is optional: the default is shown and the user may accept it. A
    // LiDAR capture arrives in metres, so a taped span does not create the
    // scale, it CHECKS it — and a step that cannot be completed without a tape
    // measure blocks the whole setup on an errand.
    //
    // The three states are kept apart, because they are different claims:
    // measured (a span was taken), accepted (the user took the capture's word),
    // and neither. `why` says which one the user is in rather than repeating the
    // instruction, so the path reports rather than nags.
    { id: "scale", title: "Lock the scale",
      why: (c.spans?.length)
        ? "measured against a distance you taped"
        : c.scaleAccepted
          ? "the capture's own scale, accepted — measure a taped span to check it"
          : "the capture arrives in metres; accept that, or click a distance you "
            + "have measured to check it",
      done: !!(c.spans?.length) || !!c.scaleAccepted || (Number(c.scale) || 1) !== 1,
      // NOT blocking. An unchecked scale is off by about a percent; an unset
      // north is off by whatever way the scanner was facing (often tens of
      // degrees). Treating them as the same urgency makes the real warning no
      // louder than the small one.
      blocking: false, action: "btnSpan" },
    { id: "analyse", title: "Survey the ground",
      why: "slope, the areas around the house and the gentle pockets, measured off the scan",
      done: !!(s.zones?.length && s.scan_coverage), blocking: false, action: "btnSurvey" },
    { id: "address", title: "Look up the address",
      why: "climate zone and the building outline, from public records (US addresses)",
      done: !!(s.address && s.usda_zone), blocking: false, action: "siteAddress" },
  ];
  let first = true;
  for (const st of steps) {
    st.state = st.done ? "done" : first ? (first = false, "next") : "todo";
  }
  return steps;
}

/**
 * The one sentence the shell shows, or null when there is nothing to say.
 *
 * Only BLOCKING steps raise it. A property with no climate zone is incomplete;
 * a property with no north is WRONG, and wrong in the specific way this whole
 * warning exists for — nothing downstream can detect it.
 */
export function calibrationWarning(steps) {
  const missing = (steps ?? []).filter(s => s.blocking && !s.done);
  if (!missing.length) return null;
  const names = missing.map(s => s.title.replace(/^(Set|Fit|Load|Lock) (the )?/i, "").toLowerCase());
  return {
    short: missing.length === 1 ? `no ${names[0]}` : `${missing.length} setup steps left`,
    long: `This site is not calibrated: ${names.join(", ")}. `
        + "Designs made on it are self-consistent and wrong — nothing downstream "
        + "can detect it, which is why this says so here.",
    steps: missing,
  };
}

/** How far along the path we are, for a progress line. */
export function setupProgress(steps) {
  const list = steps ?? [];
  return { done: list.filter(s => s.done).length, total: list.length };
}
