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

const input = { holdMin: 4, txCostUsd: 0.02, swapBps: 40, minEdgeUsd: 0.02, deploySol: 0.05 };

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

test("a hot DLMM pool takes the curve when it nets more than the bid", () => {
  const sample = pool(2500);
  const side = chooseShape(sample, input);
  const bid = quoteEdge({ ...sample, side: "bid" }, input);
  const curve = quoteEdge({ ...sample, side: "curve" }, input);
  assert.ok(curve.expectedFeesUsd > bid.expectedFeesUsd);
  assert.equal(side, curve.edgeUsd > bid.edgeUsd ? "curve" : "bid");
  assert.equal(side, "curve");
});

test("a tight bid keeps less of the printed fees than a wide one", () => {
  const wide = quoteEdge(pool(2500, { rangeHalfWidth: 0.1 }), input);
  const tight = quoteEdge(pool(2500, { rangeHalfWidth: 0.01 }), input);
  assert.ok(tight.expectedFeesUsd < wide.expectedFeesUsd);
  assert.equal(tight.profitable, false);
});

test("a cooling pool is haircut below the gate", () => {
  const hot = quoteEdge(pool(1200), input);
  const cooling = quoteEdge(pool(1200, { fee1hUsd: 1200 * 4 }), input);
  assert.equal(hot.profitable, true);
  assert.ok(cooling.expectedFeesUsd < hot.expectedFeesUsd);
  assert.equal(cooling.profitable, false);
});

test("bankable profit subtracts the unpaid exit", () => {
  assert.ok(bankableUsd(0.1, 0.01, 0.02, 0.02) > 0.04);
  assert.ok(bankableUsd(0, 0.2, 0.02, 0.02) < 0);
});
