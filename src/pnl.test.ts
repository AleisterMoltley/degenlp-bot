import assert from "node:assert/strict";
import { test } from "node:test";
import { accrueFees, halfWidthFromBins, markIlUsd, oneBinBidIl, priceBand } from "./pnl.js";

test("bin width stays inside a usable band", () => {
  const width = halfWidthFromBins(100, 13);
  assert.ok(width > 0.1 && width < 0.2);
});

test("fees accrue only while the position is in range", () => {
  const earned = accrueFees({
    fees30mUsd: 300,
    tvlUsd: 20_000,
    deployUsd: 6,
    elapsedMin: 30,
    inRange: true,
    side: "bid",
    rangeHalfWidth: 0.1,
  });
  assert.ok(earned > 0);
  const idle = accrueFees({
    fees30mUsd: 300,
    tvlUsd: 20_000,
    deployUsd: 6,
    elapsedMin: 30,
    inRange: false,
    side: "bid",
    rangeHalfWidth: 0.1,
  });
  assert.equal(idle, 0);
});

test("a bid that is still SOL has no divergence loss when price rises", () => {
  const band = priceBand(1, 0.1, "bid");
  const il = markIlUsd({
    deployUsd: 10,
    entryPrice: 1,
    price: band.upper + 0.05,
    lower: band.lower,
    upper: band.upper,
    side: "bid",
  });
  assert.equal(il, 0);
});

test("a one-bin bid books the fill drop and nothing while it is still SOL", () => {
  assert.equal(oneBinBidIl({ deployUsd: 24, entryPrice: 1, price: 0.9, filled: false }), 0);
  assert.equal(oneBinBidIl({ deployUsd: 24, entryPrice: 1, price: 1.04, filled: true }), 0);
  const oneBin = oneBinBidIl({ deployUsd: 24, entryPrice: 1, price: 0.98, filled: true });
  assert.ok(Math.abs(oneBin - 0.48) < 1e-9);
  const wide = markIlUsd({
    deployUsd: 24,
    entryPrice: 1,
    price: 0.98,
    lower: 0.99,
    upper: 1.002,
    side: "bid",
  });
  assert.ok(wide > 8);
  assert.ok(oneBin < 1);
});

test("a filled bid books a loss once price leaves the bottom", () => {
  const band = priceBand(1, 0.1, "bid");
  const il = markIlUsd({
    deployUsd: 10,
    entryPrice: 1,
    price: band.lower * 0.5,
    lower: band.lower,
    upper: band.upper,
    side: "bid",
  });
  assert.ok(il > 4);
});

test("a curve is flat at entry and loses ground once price leaves it", () => {
  const band = priceBand(1, 0.1, "curve");
  const flat = markIlUsd({
    deployUsd: 10,
    entryPrice: 1,
    price: 1,
    lower: band.lower,
    upper: band.upper,
    side: "curve",
  });
  const moved = markIlUsd({
    deployUsd: 10,
    entryPrice: 1,
    price: 1.1,
    lower: band.lower,
    upper: band.upper,
    side: "curve",
  });
  assert.equal(flat, 0);
  assert.ok(moved > 0);
});

test("full-range divergence grows when the meme runs", () => {
  const flat = markIlUsd({
    deployUsd: 10,
    entryPrice: 1,
    price: 1,
    lower: 0,
    upper: 100,
    side: "full",
  });
  const moved = markIlUsd({
    deployUsd: 10,
    entryPrice: 1,
    price: 4,
    lower: 0,
    upper: 100,
    side: "full",
  });
  assert.equal(flat, 0);
  assert.ok(moved > 1);
});
