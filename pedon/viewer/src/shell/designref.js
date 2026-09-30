// WHICH DOCUMENT A ROW POINTS AT.
//
// There are two kinds of design row: one the user SAVES under a name, and one the
// app ARCHIVES for them on a switch. They live in different directories and are
// named by different conventions — `back_yard_v2` against
// `design-20260912-091016.json` — and three separate places need to resolve one
// to a URL: the ghost in the scene, the numbers table beside it, and restore.
//
// Separate resolvers can drift: a compare table that assumes a saved-design URL
// cannot load an archived snapshot, even when its ghost is visible in the scene.
// Resolution lives here, once, and a history key carries its own prefix rather
// than being guessed at from the shape of the name — a saved design called
// `design-20260912-091016` is a legal thing for the user to type.

const HISTORY = "history:";

/** Key for an archived snapshot, from its filename. */
export const historyKey = name => HISTORY + name;

/** Is this row an archived snapshot rather than a design the user named? */
export const isHistory = key => String(key ?? "").startsWith(HISTORY);

/** Where the document for a row actually lives. */
export function docUrlFor(key) {
  const k = String(key ?? "");
  return isHistory(k)
    ? `/data/history/${k.slice(HISTORY.length)}`
    : `/data/designs/${k}.json`;
}

/**
 * "20260912-091016" as something a person reads.
 *
 * An undated snapshot says so. A file's mtime can reflect a checkout rather than
 * the edit, so it cannot supply a reliable date when the name lacks a timestamp.
 * Print no date rather than an incorrect one.
 */
export function readStamp(stamp, now = new Date()) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(String(stamp ?? ""));
  if (!m) return "undated";
  const [, y, mo, d, h, mi] = m;
  const day = new Date(`${y}-${mo}-${d}T${h}:${mi}:00`);
  if (Number.isNaN(day.getTime())) return "undated";
  const today = day.toDateString() === now.toDateString();
  return `${today ? "today" : day.toLocaleDateString(undefined,
    { month: "short", day: "numeric" })} ${h}:${mi}`;
}

/** What a compared column is CALLED — the user chooses saved names; the app
 *  generates archive filenames such as `design-20260912-091016.json`. */
export function compareLabel(key) {
  if (!isHistory(key)) return key;
  const st = (/(\d{8})-(\d{6})/.exec(key) ?? []).slice(1).join("-");
  return readStamp(st);
}
