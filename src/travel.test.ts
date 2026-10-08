import assert from "node:assert/strict";
import { test } from "node:test";
import { binTapeFromIds, feePerBin, feeRateClears, microChopOk, mintShouldSleep, priceBinId } from "./travel.js";

test("a reversing bin tape is a seat and a jump is not", () => {
  const now = 1_000_000;
  const ids = [0, 1, 0, 1, 0, 1, 0, 1].map((id, i) => ({ at: now - 50_000 + i * 7_000, id }));
  const chop = binTapeFromIds(ids, now, 60_000);
  assert.equal(microChopOk(chop), true);
  const jump = binTapeFromIds(
    [0, 1, 4, 3, 2, 1, 0, 1].map((id, i) => ({ at: now - 50_000 + i * 7_000, id })),
    now,
    60_000,
  );
  assert.ok(jump.maxStep > 1);
  assert.equal(microChopOk(jump), false);
  assert.equal(microChopOk(binTapeFromIds(ids.slice(0, 3), now, 60_000)), false);
  const flat = binTapeFromIds(
    Array.from({ length: 8 }, (_, i) => ({ at: now - 50_000 + i * 7_000, id: 4 })),
    now,
    60_000,
  );
  assert.equal(flat.crossings, 0);
  assert.equal(flat.maxStep, 0);
  assert.equal(flat.netBins, 0);
  assert.equal(microChopOk(flat), true);
  const oneWay = binTapeFromIds(
    [0, 0, 0, 0, 1, 1, 1, 1].map((id, i) => ({ at: now - 50_000 + i * 7_000, id })),
    now,
    60_000,
  );
  assert.equal(oneWay.netBins, 1);
  assert.equal(oneWay.crossings, 0);
  assert.equal(microChopOk(oneWay), false);
});

test("the base fee has to clear the bin step and the unwind", () => {
  assert.equal(feeRateClears(0.05, 100, 300), true);
  assert.equal(feeRateClears(0.02, 100, 300), false);
  assert.equal(feeRateClears(0, 20, 300), false);
});

test("fee per bin prefers a flat high rate over a traveling print", () => {
  const flat = feePerBin({ baseFeePct: 0.12, binTapeNet: 0.2 });
  const traveler = feePerBin({ baseFeePct: 0.06, binTapeNet: 1 });
  assert.ok(flat > traveler);
});

test("a dust atom inside the bin does not sleep the mint", () => {
  assert.equal(mintShouldSleep("first meme atom", -124, -125), false);
  assert.equal(mintShouldSleep("first meme atom", -126, -125), true);
  assert.equal(mintShouldSleep("first meme atom", undefined, -125), false);
  assert.equal(mintShouldSleep("scratched the fill", -124, -125), true);
  assert.equal(mintShouldSleep("bid left behind", -122, -124), true);
  assert.equal(mintShouldSleep("chop ended", -124, -124), true);
  assert.equal(mintShouldSleep("banked $0.020 on the skim", -124, -125), false);
  assert.equal(mintShouldSleep("round trip back to SOL", -123, -124), false);
  assert.equal(mintShouldSleep("risk budget", undefined, -125), true);
});

test("a paper price maps onto bin steps", () => {
  assert.equal(priceBinId(1, 100), 0);
  assert.equal(priceBinId(1.01 ** 3, 100), 3);
  assert.equal(priceBinId(0, 100), null);
  assert.equal(priceBinId(1, 0), null);
});
