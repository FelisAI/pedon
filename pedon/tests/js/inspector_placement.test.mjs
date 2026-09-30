// node --test tests/js/inspector_placement.test.mjs
//
// The inspector shows what you selected, in one fixed place on the page rather
// than popping up BESIDE the selection — beside, it covers the neighbouring
// plant, moves under the cursor as the camera turns, and is somewhere new on
// every click.
//
// The placement maths is pure and lives on its own because every failure here is
// invisible until it happens at an edge: a card that runs off the right of the
// window, or sits under the object it describes, is unusable and a screenshot in
// the middle of the screen will never show it.
import test from "node:test";
import assert from "node:assert/strict";
import { placeCard } from "../../viewer/src/shell/inspector.js";

const VP = { width: 1000, height: 700 };
const CARD = { w: 268, h: 200 };
const place = (x, y, vp = VP, card = CARD) =>
  placeCard({ anchor: { x, y }, card, viewport: vp });

test("it docks to the same corner whatever is selected", () => {
  const a = place(400, 350), b = place(90, 640), c = place(980, 20);
  assert.deepEqual([a.left, a.top], [b.left, b.top]);
  assert.deepEqual([a.left, a.top], [c.left, c.top]);
  assert.equal(a.side, "docked");
});

test("the corner is the top right, clear of the top bar", () => {
  const p = place(400, 350);
  assert.equal(p.left + CARD.w, VP.width - 12, "the card is not against the right edge");
  assert.ok(p.top >= 46, `the card starts at ${p.top}, under the top bar`);
});

test("it never leaves the window, however small the window or large the card", () => {
  for (const vp of [VP, { width: 300, height: 700 }, { width: 1000, height: 260 }])
    for (const card of [CARD, { w: 268, h: 900 }, { w: 900, h: 200 }]) {
      const p = placeCard({ anchor: { x: 400, y: 350 }, card, viewport: vp });
      assert.ok(p.left >= 0 && p.top >= 0, `card at ${p.left},${p.top} in ${vp.width}x${vp.height}`);
      assert.ok(p.left + card.w <= vp.width || card.w + 24 > vp.width,
        `card ends at ${p.left + card.w}, past ${vp.width}`);
    }
});

test("it does not read the anchor at all — that is what 'fixed' means", () => {
  const withAnchor = placeCard({ anchor: { x: 10, y: 10 }, card: CARD, viewport: VP });
  const without = placeCard({ card: CARD, viewport: VP });
  assert.deepEqual(withAnchor, without);
});
