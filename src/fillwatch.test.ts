import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeIdFromPool,
  activeIdsFromAccounts,
  bidCycle,
  bidTouched,
  dipThrough,
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

test("a round trip holds the bin, banks above it, and scratches through it", () => {
  assert.equal(bidCycle(-123, -124, -124, false), "wait");
  assert.equal(bidCycle(-124, -124, -124, false), "hold");
  assert.equal(bidCycle(-123, -124, -124, true), "bank");
  assert.equal(bidCycle(-125, -124, -124, true), "scratch");
  assert.equal(bidCycle(-125, -124, -124, false), "scratch");
  assert.equal(dipThrough(0.992, 1, 100), false);
  assert.equal(dipThrough(0.98, 1, 100), true);
});

test("a bid is touched only once price steps onto its bin", () => {
  assert.equal(bidTouched(-123, -124), false);
  assert.equal(bidTouched(-124, -124), true);
  assert.equal(bidTouched(-130, -124), true);
  assert.equal(bidTouched(Number.NaN, -124), false);
});
