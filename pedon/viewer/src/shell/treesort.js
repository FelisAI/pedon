// How the objects tree is ordered.
//
// This is what "reorder" actually wants to be in a 3D app. A 2D editor's layer
// order is a RENDER decision — what covers what — and there is no such thing in
// a scene where geometry sits in space and is drawn by kind. Dragging a row up
// here would change nothing you could see, which is the worst kind of control.
//
// What is genuinely useful is finding a row among hundreds of them, so this sorts.
// It is VIEW state: which order you like says nothing about the garden, and
// writing it into design.json would put a preference in the file the design
// agent reads.

export const ORDERS = [
  { id: "kind", label: "by kind" },
  { id: "name", label: "by name" },
  { id: "recent", label: "newest first" },
];

// The order kinds are BUILT in, which is also roughly the order they are
// discussed: the ground and its edges, then what is on it, then the planting.
const KIND_RANK = ["patio", "bed", "path", "steps", "edge", "object", "plant"];

/** `p12` -> 12, so "newest" means what the id says rather than array position. */
function serial(id) {
  const m = /(\d+)\s*$/.exec(id ?? "");
  return m ? +m[1] : -1;
}

/**
 * Sort a flat list of {id, kind, meta} rows. Pure, and a stable sort, so two
 * objects that tie keep the order the design gave them rather than shuffling
 * every time the tree redraws — a list that reorders under the cursor is
 * unusable even when every row is in a defensible place.
 */
export function sortRows(rows, order) {
  const list = [...(rows ?? [])];
  if (order === "name") {
    // by the label the row SHOWS, not by `meta`, which holds the plant's size —
    // sorting on that, "by name" would order the list by height without a word
    // on screen changing.
    const key = r => String(r.name ?? r.id);
    return list.sort((a, b) => key(a).localeCompare(key(b),
                                           undefined, { numeric: true, sensitivity: "base" }));
  }
  if (order === "recent") return list.sort((a, b) => serial(b.id) - serial(a.id));
  // "kind", the default: grouped by what a thing IS, then by id within a kind so
  // p2 comes before p10 — a plain string sort puts p10 first and reads as random
  return list.sort((a, b) => {
    const ra = KIND_RANK.indexOf(a.kind), rb = KIND_RANK.indexOf(b.kind);
    const pa = ra < 0 ? KIND_RANK.length : ra, pb = rb < 0 ? KIND_RANK.length : rb;
    if (pa !== pb) return pa - pb;
    return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
  });
}

/**
 * A heading for each run of one kind, so "by kind" reads as sections.
 *
 * Each heading carries its own COUNT, because "how many plants are in this
 * design" is a question the list is already standing in front of, and counting
 * hundreds of rows by scrolling is not an answer. The count is of what is SHOWN, so it
 * follows the filter rather than contradicting it.
 */
export function withKindHeadings(rows, order) {
  if (order !== "kind") return rows.map(r => ({ type: "row", row: r }));
  const out = [];
  let head = null;
  for (const r of rows) {
    if (!head || r.kind !== head.kind) {
      head = { type: "heading", kind: r.kind, count: 0 };
      out.push(head);
    }
    head.count++;
    out.push({ type: "row", row: r });
  }
  return out;
}


/**
 * The ids between two rows, inclusive, in the order the list is SHOWING.
 *
 * Holding shift to select a range is basic. ⌘ and shift both toggling ONE row
 * would be a different gesture wearing the same key: every list in every
 * application reserves shift for a range, and a person who tries it and gets a
 * single toggle concludes the list cannot do ranges at all.
 *
 * VISUAL ORDER, not the design's. The list sorts by kind, name or recency and
 * the range a person means is what their eye ran over, so this takes the rendered
 * order as its argument rather than deriving one — a second idea of "the order"
 * would disagree with the screen exactly when the sort is not the default.
 *
 * Direction-agnostic: dragging a selection upwards is the same gesture.
 */
export function rangeBetween(order, anchor, id) {
  const rows = order ?? [];
  const a = rows.indexOf(anchor), b = rows.indexOf(id);
  if (b < 0) return [];
  if (a < 0) return [id];          // the anchor has been filtered away or deleted
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return rows.slice(lo, hi + 1);
}
