// WHAT THE BROWSER REMEMBERS, PER SITE.
//
// The design you were on, where the camera stood, and each design's hidden objects and
// folded groups belong to ONE site. Kept browser-wide, they are wrong the moment there
// are two: a new site opens labelled with another site's design name. The dev server
// stamps the active site into the page (<meta name="pedon-project">), and these keys
// carry it. Pure: main.js owns storage.

/** The active site's slug, as the dev server stamped it into the page ("" when none). */
export function siteOf(doc = globalThis.document) {
  return doc?.querySelector?.('meta[name="pedon-project"]')?.getAttribute("content") || "";
}

/** A storage key for this site: unchanged when no site is active, the single-site layout. */
export function siteKey(key, site) {
  return site ? `${key}@${site}` : key;
}

/** Carry a legacy browser-wide key over to the first site that opens — the one that owned
 *  it — and then retire it, so a NEW site cannot inherit another's state. */
export function adoptLegacy(storage, key, site) {
  if (!site) return;
  try {
    const own = siteKey(key, site);
    const old = storage.getItem(key);
    if (old !== null && storage.getItem(own) === null) storage.setItem(own, old);
    if (old !== null) storage.removeItem(key);
  } catch { /* storage blocked: nothing to carry */ }
}
