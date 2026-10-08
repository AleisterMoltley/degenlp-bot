import assert from "node:assert/strict";
import { test } from "node:test";
import { bankableUsd, chooseShape, quoteEdge } from "./edge.js";
import type { PoolCandidate } from "./types.js";

function pool(fee30mUsd: number, over: Partial<PoolCandidate> = {}): PoolCandidate {
  return {
    tokenMint: "mint",
    tokenSymbol: "MEME",
    poolAddress: "pool",
    poolName: "MEME-SOL",
    pairLiquidityUsd: 20_000,
    tokenLiquidityUsd: 20_000,
    marketCap: 100_000,
    volume5m: 1_000,
    priceUsd: 0.001,
    jupiterScore: 40,
    venue: "dlmm",
    side: "bid",
    fee30mUsd,
    fee1hUsd: fee30mUsd * 2,
    volume30mUsd: 20_000,
    holders: 500,
    createdAtMs: Date.now() - 86_400_000,
    freezeDisabled: true,
    solPrice: 100,
    rangeHalfWidth: 0.1,
    ...over,
  };
}

const input = { holdMin: 12, txCostUsd: 0.02, swapBps: 40, minEdgeUsd: 0.02, deploySol: 0.72 };

test("a hot bid clears the round trip", () => {
  const quote = quoteEdge(pool(2500), input);
  assert.ok(quote.expectedFeesUsd > quote.roundTripUsd + quote.ilBudgetUsd);
  assert.equal(quote.profitable, true);
});

test("a quiet pool is refused after costs", () => {
  const quote = quoteEdge(pool(40), input);
  assert.equal(quote.profitable, false);
  assert.ok(quote.edgeUsd < 0);
});

test("a heating tape is worth more than a flat one with the same fees", () => {
  const flat = quoteEdge(pool(2500), input);
  const hot = quoteEdge(pool(2500, { fee1hUsd: 2700 }), input);
  assert.ok(hot.expectedFeesUsd > flat.expectedFeesUsd);
});

test("a hot DLMM pool keeps the bid unless the curve clears the inventory hurdle", () => {
  const sample = pool(2500);
  const bid = quoteEdge({ ...sample, side: "bid" }, input);
  const curve = quoteEdge({ ...sample, side: "curve" }, input);
  const deployUsd = input.deploySol * sample.solPrice;
  assert.ok(curve.ilBudgetUsd >= deployUsd * 0.1 - 1e-9);
  assert.ok(Math.abs(bid.ilBudgetUsd - deployUsd * 0.04) < 1e-9);
  assert.equal(chooseShape(sample, input), "bid");

  const monster = pool(20_000, { pairLiquidityUsd: 20_000 });
  assert.equal(chooseShape(monster, input), "curve");
});

test("a tight bid keeps less of the printed fees than a wide one", () => {
  const wide = quoteEdge(pool(2500, { rangeHalfWidth: 0.1 }), input);
  const tight = quoteEdge(pool(2500, { rangeHalfWidth: 0.01 }), input);
  assert.ok(tight.expectedFeesUsd < wide.expectedFeesUsd);
  assert.equal(tight.profitable, false);
});

test("a cooling pool is haircut below the gate", () => {
  const hot = quoteEdge(pool(2500), input);
  const cooling = quoteEdge(pool(2500, { fee1hUsd: 10_000 }), input);
  assert.equal(hot.profitable, true);
  assert.ok(cooling.expectedFeesUsd < hot.expectedFeesUsd);
  assert.equal(cooling.profitable, false);
});

test("a one-bin fill credits the collected fee and still pays the scratch", () => {
  const hot = pool(2_000, {
    baseFeePct: 0.05,
    volume30mUsd: 40_000,
    binStep: 100,
    rangeHalfWidth: 0.01,
  });
  const skim = { ...input, deploySol: 0.16, fillFraction: 0.035, swapBps: 0 };
  const drip = quoteEdge(hot, skim);
  const fill = quoteEdge(hot, { ...skim, fillFee: true });
  assert.equal(drip.profitable, false);
  assert.equal(fill.profitable, true);
  assert.ok(Math.abs(fill.ilBudgetUsd - 0.16 * 100 * 0.035) < 1e-9);
  assert.ok(fill.expectedFeesUsd <= 0.05 * 16 + 1e-9);
  assert.ok(fill.expectedFeesUsd > 0.04 * 16);
});

test("a sticker fee the pool did not collect stays red", () => {
  const sticker = pool(40, { baseFeePct: 0.08, volume30mUsd: 40_000 });
  const quote = quoteEdge(sticker, {
    ...input,
    deploySol: 0.16,
    fillFraction: 0.035,
    swapBps: 0,
    fillFee: true,
  });
  assert.equal(quote.profitable, false);
});

test("a collected fee under the scratch stays red", () => {
  const thin = pool(800, { baseFeePct: 0.02, volume30mUsd: 40_000 });
  const quote = quoteEdge(thin, {
    ...input,
    deploySol: 0.16,
    fillFraction: 0.035,
    swapBps: 0,
    fillFee: true,
  });
  assert.equal(quote.profitable, false);
});

test("bankable profit subtracts the unpaid exit", () => {
  assert.ok(bankableUsd(0.1, 0.01, 0.02, 0.02) > 0.04);
  assert.ok(bankableUsd(0, 0.2, 0.02, 0.02) < 0);
});
