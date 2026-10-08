import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeIdFromPool,
  activeIdsFromAccounts,
  bidCycle,
  filledSellClears,
  filledShouldSell,
  bidLeftBehind,
  bidTouched,
  binsAboveEntry,
  dipThrough,
  slideInstead,
  slideIntoActive,
  LBPAIR_ACTIVE_ID_OFFSET,
  LBPAIR_DISCRIMINATOR,
} from "./fillwatch.js";

function pair(activeId: number): Uint8Array {
  const data = new Uint8Array(904);
  data.set(LBPAIR_DISCRIMINATOR, 0);
  new DataView(data.buffer).setInt32(LBPAIR_ACTIVE_ID_OFFSET, activeId, true);
  return data;
}

test("the pool account yields the active bin", () => {
  assert.equal(activeIdFromPool(pair(-124)), -124);
  assert.equal(activeIdFromPool(pair(40)), 40);
  assert.equal(activeIdFromPool(new Uint8Array(8)), null);
  const wrong = pair(7);
  wrong[0] = 0;
  assert.equal(activeIdFromPool(wrong), null);
});

test("a batched read keeps only real pair accounts", () => {
  const ids = activeIdsFromAccounts(
    ["a", "b", "c", "d"],
    [{ data: pair(12) }, null, { data: pair(4) }, { data: new Uint8Array(8) }],
  );
  assert.equal(ids.get("a"), 12);
  assert.equal(ids.has("b"), false);
  assert.equal(ids.get("c"), 4);
  assert.equal(ids.has("d"), false);
});

test("a SOL deposit earns in the active bin, chases one bin up, and scratches through it", () => {
  assert.equal(bidCycle(-124, -124, -124, false), "earn");
  assert.equal(bidCycle(-124, -124, -124, true), "hold");
  assert.equal(bidCycle(-123, -124, -124, false), "chase");
  assert.equal(bidCycle(-123, -124, -124, true), "rest");
  assert.equal(bidCycle(-122, -124, -124, true), "leave");
  assert.equal(bidCycle(-122, -124, -124, false), "leave");
  assert.equal(bidCycle(-125, -124, -124, true), "scratch");
  assert.equal(bidCycle(-125, -124, -124, false), "scratch");
  assert.equal(dipThrough(0.992, 1, 100), false);
  assert.equal(dipThrough(0.98, 1, 100), true);
  assert.equal(bidLeftBehind(1.01, 1, 100), false);
  assert.equal(bidLeftBehind(1.02, 1, 100), true);
  assert.equal(filledSellClears(2, 100, 300), false);
  assert.equal(filledSellClears(4, 100, 300), true);
  assert.equal(filledSellClears(2, 250, 300), true);
  // 4% up does not clear a 3% unwind plus 8% * 0.9. 12% does.
  assert.equal(filledSellClears(4, 100, 300, 0.08), false);
  assert.equal(filledSellClears(12, 100, 300, 0.08), true);
  assert.equal(filledShouldSell({ binsUp: 2, binStep: 100, unwindBps: 300, feePct: 0.08, chopAlive: false }), false);
  assert.equal(filledShouldSell({ binsUp: 4, binStep: 100, unwindBps: 300, feePct: 0.08, chopAlive: true }), false);
  assert.equal(filledShouldSell({ binsUp: 4, binStep: 100, unwindBps: 300, feePct: 0.08, chopAlive: false }), true);
  assert.equal(filledShouldSell({ binsUp: 12, binStep: 100, unwindBps: 300, feePct: 0.08, chopAlive: true }), true);
  assert.ok(Math.abs(binsAboveEntry(1.01, 1, 100) - 1) < 1e-9);
  assert.ok(Math.abs(binsAboveEntry(1.02, 1, 100) - 2) < 1e-9);
  assert.equal(slideInstead(1, false, 0, true), true);
  assert.equal(slideInstead(0.5, false, 0, true), false);
  assert.equal(slideInstead(2, false, 0, true), true);
  assert.equal(slideInstead(2, true, 0, true), false);
  assert.equal(slideInstead(2, false, 0, false), false);
  assert.equal(slideInstead(2, false, 3, true), false);
  assert.equal(slideInstead(4, false, 0, true), false);
  assert.equal(slideIntoActive(-123, -124, false, 0, true), true);
  assert.equal(slideIntoActive(-122, -124, false, 0, true), false);
  assert.equal(slideIntoActive(-123, -124, true, 0, true), false);
});

test("a bid is touched only once price steps onto its bin", () => {
  assert.equal(bidTouched(-123, -124), false);
  assert.equal(bidTouched(-124, -124), true);
  assert.equal(bidTouched(-130, -124), true);
  assert.equal(bidTouched(Number.NaN, -124), false);
});
