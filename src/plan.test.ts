import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPosition } from "./position.js";
import { planPosition, rankPools, type RankedPool } from "./scorer.js";
import type { PoolCandidate } from "./types.js";

function pool(over: Partial<PoolCandidate> = {}): PoolCandidate {
  return {
    tokenMint: "mint",
    tokenSymbol: "MEME",
    poolAddress: "pool-a",
    poolName: "MEME-SOL",
    pairLiquidityUsd: 20_000,
    tokenLiquidityUsd: 20_000,
    marketCap: 500_000,
    volume5m: 2_000,
    priceUsd: 0.001,
    jupiterScore: 40,
    venue: "dlmm",
    side: "bid",
    fee30mUsd: 2500,
    fee1hUsd: 5000,
    volume30mUsd: 40_000,
    holders: 400,
    createdAtMs: Date.now() - 24 * 3600_000,
    freezeDisabled: true,
    solPrice: 100,
    rangeHalfWidth: 0.1,
    ...over,
  };
}

test("the hottest qualifying pool is entered", () => {
  const ranked = rankAtDesk([
    pool(),
    pool({ poolAddress: "pool-b", poolName: "QUIET-SOL", fee30mUsd: 40, fee1hUsd: 80 }),
  ]);
  const plan = planPosition({ ranked, active: null, now: Date.now() });
  assert.equal(plan.action, "enter");
  assert.equal(plan.pool?.poolAddress, "pool-a");
});

test("a young pool does not clear the bar", () => {
  const ranked = rankAtDesk([pool({ createdAtMs: Date.now() - 5 * 60_000 })]);
  assert.equal(ranked[0]?.metrics.metThreshold, false);
  const plan = planPosition({ ranked, active: null, now: Date.now() });
  assert.equal(plan.action, "wait");
});

function rankAtDesk(pools: PoolCandidate[]): RankedPool[] {
  return rankPools(pools, { deploySol: 0.72 });
}

function seat(current: PoolCandidate, heldMs: number, fees = 0): ReturnType<typeof buildPosition> {
  const active = buildPosition({
    pool: current,
    solDeployed: 0.05,
    feeToTvl: 0.004,
    opportunityScore: 0.4,
  });
  active.enteredAt = Date.now() - heldMs;
  active.costsUsd = 0.02;
  active.feesAccruedUsd = fees;
  return active;
}

test("a seat stays until it is green, then hands off only to an equal or better pool", () => {
  const current = pool();
  const hotter = pool({
    poolAddress: "pool-b",
    poolName: "HOT-SOL",
    fee30mUsd: 9000,
    fee1hUsd: 18000,
    tokenSymbol: "HOT",
  });
  const red = seat(current, 11 * 60_000, 0);
  const stillRed = planPosition({
    ranked: rankAtDesk([hotter, current]),
    active: red,
    now: Date.now(),
  });
  assert.equal(stillRed.action, "stay");
  assert.match(stillRed.reason, /green/);

  const green = seat(current, 90_000, 0.08);
  const handoff = planPosition({
    ranked: rankAtDesk([hotter, current]),
    active: green,
    now: Date.now(),
  });
  assert.equal(handoff.action, "rotate");
  assert.equal(handoff.pool?.poolAddress, "pool-b");
  assert.match(handoff.reason, /better/);

  const worse = pool({
    poolAddress: "pool-c",
    poolName: "OK-SOL",
    fee30mUsd: 1800,
    fee1hUsd: 3600,
    tokenSymbol: "OK",
  });
  const keep = planPosition({
    ranked: rankAtDesk([current, worse]),
    active: seat(current, 11 * 60_000, 0.08),
    now: Date.now(),
  });
  assert.equal(keep.action, "stay");
  assert.match(keep.reason, /still the best/);

  const equal = pool({ poolAddress: "pool-d", poolName: "TWIN-SOL", tokenSymbol: "TWIN" });
  const tooSoon = planPosition({
    ranked: rankAtDesk([equal, current]),
    active: seat(current, 90_000, 0.08),
    now: Date.now(),
  });
  assert.equal(tooSoon.action, "stay");
  const later = planPosition({
    ranked: rankAtDesk([equal, current]),
    active: seat(current, 6 * 60_000, 0.08),
    now: Date.now(),
  });
  assert.equal(later.action, "rotate");
  assert.match(later.reason, /equal/);
});

test("a bid holds through a lift and a small dip, and leaves once price exits the band", () => {
  const current = pool();
  const active = seat(current, 4 * 60_000, 0);
  const lifted = pool({ priceUsd: active.priceUpper * 1.05 });
  const hold = planPosition({ ranked: rankAtDesk([lifted]), active, now: Date.now() });
  assert.equal(hold.action, "stay");
  assert.match(hold.reason, /lifted/);

  const dipped = pool({ priceUsd: active.entryPrice * 0.99 });
  const inside = planPosition({ ranked: rankAtDesk([dipped]), active, now: Date.now() });
  assert.equal(inside.action, "stay");

  const filled = pool({ priceUsd: active.priceLower * 0.97 });
  const exit = planPosition({ ranked: rankAtDesk([filled]), active, now: Date.now() });
  assert.equal(exit.action, "exit");
  assert.match(exit.reason, /left the range/);
});

test("a green seat banks a cooling spike even into a pool with a smaller edge", () => {
  const cooling = pool({ fee30mUsd: 8000, fee1hUsd: 20_000 });
  const steady = pool({
    poolAddress: "pool-b",
    poolName: "STEADY-SOL",
    fee30mUsd: 2500,
    fee1hUsd: 5000,
    tokenSymbol: "STEADY",
  });
  const ranked = rankAtDesk([cooling, steady]);
  const coolEdge = ranked.find((row) => row.pool.poolAddress === "pool-a")!.metrics.edgeUsd;
  const steadyEdge = ranked.find((row) => row.pool.poolAddress === "pool-b")!.metrics.edgeUsd;
  assert.ok(steadyEdge < coolEdge);
  const plan = planPosition({
    ranked,
    active: seat(cooling, 90_000, 0.12),
    now: Date.now(),
  });
  assert.equal(plan.action, "rotate");
  assert.equal(plan.pool?.poolAddress, "pool-b");
  assert.match(plan.reason, /cooled/);
});

test("a green seat leaves to cash when nothing else still pays", () => {
  const dying = pool({ fee30mUsd: 40, fee1hUsd: 80 });
  const plan = planPosition({
    ranked: rankAtDesk([dying]),
    active: seat(dying, 90_000, 0.12),
    now: Date.now(),
  });
  assert.equal(plan.action, "exit");
  assert.match(plan.reason, /no longer pays/);
});

test("an out-of-range seat recenters once the close is paid for", () => {
  const current = pool();
  const active = seat(current, 90_000, 0.05);
  const lifted = pool({ priceUsd: active.priceUpper * 1.05 });
  const plan = planPosition({ ranked: rankAtDesk([lifted]), active, now: Date.now() });
  assert.equal(plan.action, "adjust");
  assert.match(plan.reason, /recenter/);
});

test("a large seat is cut on its own size", () => {
  const current = pool({ venue: "damm_v2", side: "bid" });
  const active = seat(current, 90_000, 0);
  active.solDeployed = 0.72;
  const dipped = pool({ venue: "damm_v2", side: "bid", priceUsd: active.entryPrice * 0.95 });
  const cut = planPosition({
    ranked: rankAtDesk([dipped]),
    active,
    now: Date.now(),
    lossCut: 0.12,
  });
  assert.equal(cut.action, "exit");
  assert.match(cut.reason, /risk budget/);
});

test("a seat that gives back its risk budget is cut", () => {
  const current = pool({ venue: "damm_v2", side: "bid" });
  const active = seat(current, 90_000, 0);
  const calm = planPosition({
    ranked: rankAtDesk([current]),
    active,
    now: Date.now(),
    lossCut: 0.12,
  });
  const dipped = pool({ venue: "damm_v2", side: "bid", priceUsd: active.entryPrice * 0.95 });
  const cut = planPosition({
    ranked: rankAtDesk([dipped]),
    active,
    now: Date.now(),
    lossCut: 0.12,
  });
  assert.equal(calm.action, "stay");
  assert.equal(cut.action, "exit");
  assert.match(cut.reason, /risk budget/);
});

test("a tiny seat is resized once the bankroll deploy is much larger", () => {
  const current = pool();
  const active = seat(current, 90_000, 0);
  const plan = planPosition({
    ranked: rankAtDesk([current]),
    active,
    now: Date.now(),
    deploySol: 0.72,
  });
  assert.equal(plan.action, "exit");
  assert.match(plan.reason, /resizing/);
});

test("a dead inventory seat is dropped instead of held at a loss", () => {
  const dying = pool({
    venue: "damm_v2",
    side: "full",
    rangeHalfWidth: 0.5,
    fee30mUsd: 40,
    fee1hUsd: 80,
  });
  const plan = planPosition({
    ranked: rankAtDesk([dying]),
    active: seat(dying, 90_000, 0),
    now: Date.now(),
  });
  assert.equal(plan.action, "exit");
  assert.match(plan.reason, /edge gone/);
});

test("a missing pool is held until it has been gone for several scans", () => {
  const active = seat(pool(), 60_000, 0);
  active.poolAddress = "gone";
  active.scanMisses = 1;
  const hold = planPosition({ ranked: rankAtDesk([pool()]), active, now: Date.now() });
  assert.equal(hold.action, "stay");
  active.scanMisses = 4;
  const exit = planPosition({ ranked: rankAtDesk([pool()]), active, now: Date.now() });
  assert.equal(exit.action, "exit");
  assert.match(exit.reason, /left the fee list/);
});

test("a full-range pool cuts once divergence passes the fees", () => {
  const current = pool({ venue: "damm_v2", side: "full", rangeHalfWidth: 0.5, fee30mUsd: 2500, fee1hUsd: 5000 });
  const active = buildPosition({
    pool: current,
    solDeployed: 0.05,
    feeToTvl: 0.004,
    opportunityScore: 0.4,
  });
  active.enteredAt = Date.now() - 4 * 60_000;
  const moved = pool({
    venue: "damm_v2",
    side: "full",
    rangeHalfWidth: 0.5,
    fee30mUsd: 2500,
    fee1hUsd: 5000,
    priceUsd: current.priceUsd * 3,
  });
  const plan = planPosition({ ranked: rankAtDesk([moved]), active, now: Date.now() });
  assert.equal(plan.action, "exit");
});
