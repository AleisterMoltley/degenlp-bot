import assert from "node:assert/strict";
import { test } from "node:test";
import { activeIdFromPool, bidTouched, LBPAIR_ACTIVE_ID_OFFSET, LBPAIR_DISCRIMINATOR } from "./fillwatch.js";

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

test("a bid is touched only once price steps onto its bin", () => {
  assert.equal(bidTouched(-123, -124), false);
  assert.equal(bidTouched(-124, -124), true);
  assert.equal(bidTouched(-130, -124), true);
  assert.equal(bidTouched(Number.NaN, -124), false);
});
