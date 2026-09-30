// Viewpoints the owner placed: "the view from the kitchen window", "the one that
// matters" — cameras anywhere in the space, so a person or a model can look from
// the places the owner says matter.
//
// THE WHOLE DESIGN DECISION IS THE FRAME. A saved viewpoint is stored in `look`'s
// own convention — x, y, and a height ABOVE THE GROUND at that point — which
// means a viewpoint IS a stored look() call. No new resolution logic anywhere: a
// headless session reads site.viewpoints and passes the numbers straight to the
// tool it already has.
//
// Height above ground rather than an absolute also survives the terrain being
// re-derived: the camera follows the ground, which is what a garden viewpoint
// should do. And it round-trips exactly, because the same heightAt answers at
// capture and at replay.

/** A camera, as the numbers `look` wants. Pure so the conversion is testable. */
export function viewpointFrom({ eye, target, ground, name, note }) {
  const h = eye.y - (Number.isFinite(ground) ? ground : 0);
  return {
    name: String(name ?? "").trim(),
    eye: [round2(eye.x), round2(eye.z), round2(h)],
    look_at: [round2(target.x), round2(target.z), round2(target.h ?? 1.2)],
    ...(note ? { note: String(note) } : {}),
  };
}

const round2 = v => Math.round((Number(v) || 0) * 100) / 100;

/**
 * Is this a viewpoint a later session can actually use?
 *
 * Checked on the way IN, not on the way out: a malformed entry written once sits
 * in owner ground truth forever, and site.json is the file no tool can
 * regenerate. Refuses rather than repairs, for the reason save-owner does.
 */
export function viewpointProblems(v) {
  const bad = [];
  if (!v || typeof v !== "object") return ["not an object"];
  if (!v.name) bad.push("a viewpoint needs a name — it is how it is asked for");
  for (const k of ["eye", "look_at"]) {
    const a = v[k];
    if (!Array.isArray(a) || a.length < 2) { bad.push(`${k} must be [x, y] or [x, y, height]`); continue; }
    if (!a.every(n => Number.isFinite(n))) bad.push(`${k} has a value that is not a number`);
  }
  // an eye BELOW the ground it was measured from is a sign the capture used the
  // wrong frame, which is this project's nastiest bug class (ENU vs world)
  if (Array.isArray(v.eye) && v.eye.length > 2 && v.eye[2] < -0.5)
    bad.push(`eye height ${v.eye[2]} m is below the ground — captured in the wrong frame?`);
  return bad;
}

/** Newest last, and names are unique: saving one twice replaces it. */
export function upsertViewpoint(list, v) {
  const out = (list ?? []).filter(x => x?.name !== v.name);
  out.push(v);
  return out;
}

/**
 * The saved view one step from the one you are looking from — `]` forward, `[` back.
 *
 * Wraps at both ends. From no view,
 * or one that has since been deleted, `]` starts at the first and `[` at the last.
 */
export function stepViewpoint(list, currentName, dir) {
  const views = (list ?? []).filter(v => v?.name);
  if (!views.length) return null;
  const i = views.findIndex(v => v.name === currentName);
  if (i < 0) return dir < 0 ? views[views.length - 1] : views[0];
  return views[(i + (dir < 0 ? -1 : 1) + views.length) % views.length];
}
