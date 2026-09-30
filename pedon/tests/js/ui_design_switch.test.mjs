// node --test tests/js/ui_design_switch.test.mjs
//
// Switching to a saved design must LEAVE BEHIND the one you switched away from.
//
// Hardscape and objects must not stay on screen after switching to a different
// design. A writeDesignDocument that merges the variant onto a fresh read with a
// shallow spread INHERITS every top-level key the variant file does not carry
// rather than clearing it: switching to a design with no `objects` key at all
// keeps every object of the previous design, the moon gate and the screen among
// them, and writes the hybrid back to design.json. Across 45 saved designs, 29
// have no `objects` key, 27 no `steps`, 10 no `patios`.
//
// The merge is right for a PATCH caller and wrong for a whole document; the two
// cases are separated by design_doc.js, which this file tests directly rather
// than by scanning source, because a regex cannot tell you what the merge DID.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeDesignDocument, DESIGN_KINDS, REPLACED_KEYS } from
  "../../viewer/src/design_doc.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = fs.readFileSync(path.join(ROOT, "viewer", "src", "main.js"), "utf8");

// the design that is on screen: hardscape, a flight of steps, and the objects
const ON_SCREEN = {
  version: 1, units: "meters", style: "fusion", notes: "the fusion border",
  beds: [{ id: "b1" }], paths: [{ id: "p1" }], patios: [{ id: "t1" }, { id: "t2" }],
  edges: [{ id: "e1" }], steps: [{ id: "s1" }],
  objects: [{ id: "o1", kind: "moon gate" }, { id: "o2", kind: "screen" }],
  groups: [{ name: "tea court", ids: ["o1"] }],
};
// a real saved design, in the shape most of data/designs/ is actually in
const ZEN = { version: 1, units: "meters", beds: [{ id: "zb" }], paths: [{ id: "zp" }],
              edges: [{ id: "ze" }], plants: [{ id: "zpl" }] };

test("a patch still touches only the keys its caller owns", () => {
  // The reason the merge exists: a python tool can add flights of steps between
  // the last poll and the click, and the Group button must not delete them.
  const next = mergeDesignDocument(ON_SCREEN, { groups: [{ name: "new", ids: [] }] });
  assert.equal(next.steps.length, 1, "a patch dropped `steps` — this is the lost update");
  assert.equal(next.objects.length, 2, "a patch dropped `objects`");
  assert.equal(next.groups[0].name, "new", "the patch's own key did not win");
});

test("switching design clears a collection the new design does not carry", () => {
  const next = mergeDesignDocument(ON_SCREEN, ZEN, { replace: true });
  assert.deepEqual(next.objects ?? [], [],
    "the previous design's objects survived the switch — the moon gate and the "
    + "screen are still standing in a design that has neither");
  assert.deepEqual(next.steps ?? [], [], "the previous design's steps survived");
  assert.deepEqual(next.patios ?? [], [], "the previous design's patios survived");
  assert.deepEqual(next.groups ?? [], [],
    "groups from the previous design survived, and their ids no longer exist");
});

test("switching design keeps what the new design DOES carry", () => {
  // The complement, asserted separately: a replace that simply emptied the
  // document would pass the test above and be a worse bug than the one it fixes.
  const next = mergeDesignDocument(ON_SCREEN, ZEN, { replace: true });
  assert.equal(next.beds[0].id, "zb", "the new design's own beds are missing");
  assert.equal(next.paths[0].id, "zp");
  assert.equal(next.edges[0].id, "ze");
  assert.equal(next.plants[0].id, "zpl");
});

test("every collection the design vocabulary has is cleared, not a hand-typed few", () => {
  // A hand-typed list saying beds/paths/patios/plants/edges makes deleting a flight
  // of STEPS silently do nothing. A new element kind must not be able to reintroduce
  // that here.
  for (const [key] of DESIGN_KINDS) {
    assert.ok(REPLACED_KEYS.includes(key),
      `\`${key}\` is a design collection that a whole-document write would not clear`);
  }
  assert.ok(REPLACED_KEYS.includes("groups"), "groups outlive the ids they name");
});

test("what DESCRIBES a design does not outlive it; what describes the FILE does", () => {
  // Clearing `style` changes nothing about how the design you switched TO is
  // coloured: `design.style` is read by NOTHING (not colourFromPalette, not
  // design.js, not agent.py) and none of 65 saved designs set it.
  //
  // `notes` DESCRIBE a design, so carrying them across a switch labels the
  // garden you moved to with a description of the one you left — the inherited-
  // object fault told in prose, and a stale sentence is harder to notice than a
  // stale lantern.
  //
  // THE FIXTURE MATTERS HERE. ZEN carries `units` and `version` itself, so
  // asserting those come through proves nothing about what replace DELETES — such
  // a test stays green while a mutation adds them to the clear list.
  assert.ok(!("style" in ZEN) && !("notes" in ZEN),
    "fixture no longer exercises the case");
  assert.ok("style" in ON_SCREEN, "the outgoing document must carry one to lose");
  const next = mergeDesignDocument(ON_SCREEN, ZEN, { replace: true });
  assert.ok(!("style" in next), "a switch inherited the previous design's style");
  assert.ok(!("notes" in next),
    "a switch inherited the previous design's notes, so the garden you moved to "
    + "is now labelled with a description of the one you left");
  // the FILE FORMAT is a different question: a document arriving without
  // `version` or `units` is missing them, not declaring they do not apply.
  //
  // MEASURED ON A DOCUMENT THAT LACKS THEM. ZEN carries both itself, so
  // asserting them off `next` proves nothing: a mutation adding version and units
  // to the clear list would leave it green.
  const bare = { beds: [] };
  const kept = mergeDesignDocument(ON_SCREEN, bare, { replace: true });
  assert.equal(kept.version, 1, "a document with no version lost the file's");
  assert.equal(kept.units, "meters", "a document with no units lost the file's");
  // and a document that HAS notes keeps its own
  const withNotes = mergeDesignDocument(ON_SCREEN, { ...ZEN, notes: "the A border" },
                                        { replace: true });
  assert.equal(withNotes.notes, "the A border");
  // a PATCH still inherits everything it does not name
  assert.equal(mergeDesignDocument(ON_SCREEN, { beds: [] }).style, "fusion");
});

test("the three whole-document callers ask for a replacement", () => {
  // Behaviour above, wiring here — the merge can be perfect and still never be
  // reached with replace:true. Assert the samples before the property, or a scan
  // whose anchor moved passes by finding nothing.
  for (const [anchor, why] of [
    // `doc`, not `v`: the switch may hand over the incoming design
    // WITH the grouping carried across from the outgoing one. Still one whole
    // document, still replace:true — which is the property this test is about.
    ['writeDesignDocument(doc, "switch design"', "clicking a saved design's name"],
    ['writeDesignDocument(entry.design, "restore"', "undo/redo through the timeline"],
    ['writeDesignDocument(BLANK_DESIGN, "new design"', "starting an empty design"],
  ]) {
    const i = src.indexOf(anchor);
    assert.notStrictEqual(i, -1, `anchor for ${why} is gone — retarget this test`);
    assert.match(src.slice(i, i + 200), /replace:\s*true/,
      `${why} hands over a whole document but does not pass replace:true, so a key `
      + `the new document lacks is inherited from the old one`);
  }
});
