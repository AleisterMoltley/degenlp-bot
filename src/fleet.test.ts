import assert from "node:assert/strict";
import { test } from "node:test";
import { quoteEdge } from "./edge.js";
import { downwardMove, planFleet, skimFillFraction } from "./fleet.js";
import { halfWidthFromBins } from "./pnl.js";
import type { ActivePosition, PoolCandidate } from "./types.js";

function pool(over: Partial<PoolCandidate> = {}): PoolCandidate {
  const binStep = over.binStep ?? 200;
  return {
    tokenMint: "mint",
    tokenSymbol: "MEME",
    poolAddress: "pool-a",
    poolName: "MEME-SOL",
    pairLiquidityUsd: 16_000,
    tokenLiquidityUsd: 16_000,
    marketCap: 100_000,
    volume5m: 4_000,
    priceUsd: 0.001,
    binStep,
    jupiterScore: 40,
    venue: "dlmm",
    side: "bid",
    fee30mUsd: 900,
    fee1hUsd: 1_800,
    volume30mUsd: 20_000,
    holders: 500,
    createdAtMs: Date.now() - 86_400_000,
    freezeDisabled: true,
    solPrice: 100,
    rangeHalfWidth: halfWidthFromBins(binStep, 6),
    chopSamples: 8,
    chopCrossings: 4,
    chopNetBins: 0.5,
    binSolUsd: 100_000,
    baseFeePct: 0.08,
    binTapeSamples: 12,
    binTapeSpanMs: 60_000,
    binTapeCrossings: 4,
    binTapeNet: 0.4,
    binTapeMaxStep: 1,
    ...over,
  };
}

/** Fees hot enough that a one-bin SOL bid still clears the 4% touch. */
function paying(over: Partial<PoolCandidate> = {}): PoolCandidate {
  return pool({
    fee30mUsd: 12_000,
    fee1hUsd: 24_000,
    volume30mUsd: 40_000,
    ...over,
  });
}

function seat(over: Partial<ActivePosition> = {}): ActivePosition {
  const now = Date.now();
  return {
    id: "s1",
    poolAddress: "pool-a",
    poolName: "MEME-SOL",
    baseTokenSymbol: "MEME",
    quoteTokenSymbol: "SOL",
    binStep: 100,
    positionAddress: "pos",
    minBinId: 0,
    maxBinId: 0,
    solDeployed: 0.12,
    entryPrice: 1,
    feeTvlRatioAtEntry: 0.05,
    liquidityAtEntry: 16_000,
    opportunityScoreAtEntry: 1,
    marketCapAtEntry: 100_000,
    jupiterScoreAtEntry: 40,
    entrySignature: "dry",
    tokenMint: "mint",
    status: "active",
    enteredAt: now,
    venue: "dlmm",
    side: "bid",
    strategy: "skim",
    feesAccruedUsd: 0,
    ilUsd: 0,
    costsUsd: 0.02,
    lastMarkAt: now,
    lastPrice: 1,
    rangeHalfWidth: 0.06,
    priceLower: 0.9,
    priceUpper: 1.02,
    solPrice: 100,
    scanMisses: 0,
    ...over,
  };
}

const now = Date.now();

test("a touch budget stays under the strict 4% fill", () => {
  const step100 = skimFillFraction(100, 6, 300);
  const step200 = skimFillFraction(200, 6, 300);
  assert.ok(step100 >= 0.003 && step100 <= 0.015);
  assert.ok(step200 > step100 && step200 <= 0.015);
  const sample = pool();
  const strict = quoteEdge(sample, {
    holdMin: 12,
    txCostUsd: 0.02,
    swapBps: 40,
    minEdgeUsd: 0.02,
    deploySol: 0.72,
  });
  assert.ok(Math.abs(strict.ilBudgetUsd - 0.72 * 100 * 0.04) < 1e-9);
});

test("several skim seats open when each quote clears, and a red pool stays out", () => {
  const quiet = pool({ poolAddress: "quiet", poolName: "QUIET-SOL", tokenSymbol: "QUIET", fee30mUsd: 40, fee1hUsd: 80 });
  const a = paying();
  const b = paying({ poolAddress: "pool-b", poolName: "NEXT-SOL", tokenSymbol: "NEXT", tokenMint: "mint-b" });
  const plan = planFleet({ pools: [quiet, a, b], seats: [], deploySol: 0.72, now, dlmmOnly: true });
  const again = planFleet({ pools: [quiet, a, b], seats: [], deploySol: 0.72, now, dlmmOnly: true });
  const sol = plan.opens.reduce((sum, row) => sum + row.solDeploy, 0);
  assert.equal(plan.opens.length, 2, plan.summary);
  assert.ok(plan.opens.every((row) => row.strategy === "skim" && row.pool.side === "bid"));
  assert.ok(plan.opens.every((row) => row.metrics.metThreshold && row.metrics.edgeUsd >= 0.02));
  assert.ok(sol <= 0.72 + 1e-9);
  assert.ok(plan.opens.every((row) => row.solDeploy >= 0.04));
  assert.ok(plan.opens.every((row) => row.solDeploy <= 0.72 * 0.22 + 1e-6));
  assert.equal(new Set(plan.opens.map((row) => row.pool.poolAddress)).size, 2);
  assert.ok(!plan.opens.some((row) => row.pool.poolAddress === "quiet"));
  assert.equal(again.opens.reduce((sum, row) => sum + row.solDeploy, 0), sol);
});

test("a negative book opens nothing", () => {
  const quiet = pool({ fee30mUsd: 40, fee1hUsd: 80 });
  const plan = planFleet({ pools: [quiet], seats: [], deploySol: 0.72, now, dlmmOnly: true });
  assert.equal(plan.opens.length, 0);
  assert.match(plan.summary, /no pool clears costs/);
});

test("a dust bankroll does not open a seat", () => {
  const plan = planFleet({ pools: [pool()], seats: [], deploySol: 0.03, now, dlmmOnly: true });
  assert.equal(plan.opens.length, 0);
});

test("live mode does not open a DAMM seat", () => {
  const damm = pool({ venue: "damm_v2", side: "full", poolAddress: "damm" });
  const plan = planFleet({ pools: [damm], seats: [], deploySol: 0.72, now, dlmmOnly: true });
  assert.equal(plan.opens.length, 0);
});

test("a one-bin fill is scratched and a smaller dip is not", () => {
  const touched = pool({ priceUsd: 0.98 });
  const scratch = planFleet({
    pools: [touched],
    seats: [seat({ enteredAt: now - 10_000 })],
    deploySol: 0.72,
    now,
  });
  assert.equal(scratch.closes.length, 1);
  assert.match(scratch.closes[0].reason, /scratched the fill/);

  const dip = planFleet({
    pools: [pool({ priceUsd: 0.995 })],
    seats: [seat({ enteredAt: now - 10_000, feesAccruedUsd: 0 })],
    deploySol: 0.72,
    now,
  });
  assert.equal(dip.closes.length, 0, dip.closes.map((row) => row.reason).join(","));
});

test("a skim that gave back a 5% run takes the trail", () => {
  const plan = planFleet({
    pools: [pool({ priceUsd: 1 })],
    seats: [
      seat({
        feesAccruedUsd: 0.16,
        costsUsd: 0.02,
        peakNetUsd: 1.2,
        solDeployed: 0.12,
        solPrice: 100,
        enteredAt: now - 30_000,
        entryPrice: 1,
        lastPrice: 1,
      }),
    ],
    deploySol: 0.72,
    now,
  });
  assert.equal(plan.closes.length, 1);
  assert.match(plan.closes[0].reason, /trail gave back/);
});

test("a green skim banks and does not reopen in the same pass", () => {
  const plan = planFleet({
    pools: [pool({ priceUsd: 1 })],
    seats: [seat({ feesAccruedUsd: 0.1, enteredAt: now - 30_000, entryPrice: 1, lastPrice: 1 })],
    deploySol: 0.72,
    now,
  });
  assert.equal(plan.closes.length, 1);
  assert.match(plan.closes[0].reason, /banked/);
  assert.equal(plan.opens.length, 0);
});

test("a skim that never pays is closed when the window ends", () => {
  const plan = planFleet({
    pools: [pool({ priceUsd: 1 })],
    seats: [seat({ feesAccruedUsd: 0, enteredAt: now - 9 * 60_000 })],
    deploySol: 0.72,
    now,
  });
  assert.equal(plan.closes.length, 1);
  assert.match(plan.closes[0].reason, /skim window closed/);
});

test("a dip that stays inside the bid waits for the round trip", () => {
  const plan = planFleet({
    pools: [pool({ priceUsd: 0.9905 })],
    seats: [
      seat({
        binStep: 100,
        entryPrice: 1,
        lastPrice: 0.9905,
        priceLower: 0.99,
        priceUpper: 1.002,
        solDeployed: 0.2,
        feesAccruedUsd: 0,
        costsUsd: 0.02,
        enteredAt: now - 30_000,
      }),
    ],
    deploySol: 0.72,
    now,
    lossCut: 0.12,
  });
  assert.equal(plan.closes.length, 0, plan.closes.map((row) => row.reason).join(","));
  assert.match(plan.holds[0]?.reason ?? "", /round trip/);
});

test("a core bid is not scratched on the first bin", () => {
  const plan = planFleet({
    pools: [pool({ priceUsd: 0.98, fee30mUsd: 40, fee1hUsd: 80 })],
    seats: [
      seat({
        strategy: "core",
        entryPrice: 1,
        lastPrice: 0.98,
        priceLower: 0.9,
        priceUpper: 1.1,
        binStep: 100,
        enteredAt: now - 10_000,
        solDeployed: 0.2,
      }),
    ],
    deploySol: 0.72,
    now,
  });
  assert.equal(plan.closes.length, 0, plan.closes.map((row) => row.reason).join(","));
});

test("one pool cannot take the whole book", () => {
  const plan = planFleet({ pools: [paying()], seats: [], deploySol: 0.72, now, dlmmOnly: true });
  assert.equal(plan.opens.length, 1, plan.summary);
  assert.equal(plan.opens[0].pool.side, "bid");
  assert.ok(plan.opens[0].solDeploy <= 0.72 * 0.22 + 1e-6);
  assert.ok(plan.opens[0].solDeploy >= 0.04);
});

test("a one-bin snipe stays inside the seat cap", () => {
  const dense = paying({
    poolAddress: "dense",
    poolName: "DENSE-SOL",
    tokenSymbol: "DENSE",
    fee30mUsd: 40_000,
    fee1hUsd: 80_000,
    volume30mUsd: 80_000,
  });
  const plan = planFleet({ pools: [dense, paying()], seats: [], deploySol: 0.72, now, dlmmOnly: true });
  const big = plan.opens.find((row) => row.pool.poolAddress === "dense");
  assert.ok(big, plan.summary);
  assert.equal(big.strategy, "skim");
  assert.equal(big.pool.side, "bid");
  assert.doesNotMatch(big.reason, /aggressive|curve/);
  assert.ok(big.solDeploy <= 0.72 * 0.22 + 1e-6);
  const sol = plan.opens.reduce((sum, row) => sum + row.solDeploy, 0);
  assert.ok(sol <= 0.72 + 1e-9);
});

test("a collected 5% fee opens a one-bin bid the drip would refuse", () => {
  const payer = pool({
    poolAddress: "payer",
    tokenMint: "payer",
    tokenSymbol: "PAY",
    poolName: "PAY-SOL",
    baseFeePct: 0.05,
    binStep: 100,
    fee30mUsd: 400,
    fee1hUsd: 800,
    volume30mUsd: 8_000,
  });
  const plan = planFleet({ pools: [payer], seats: [], deploySol: 0.72, now, dlmmOnly: true });
  assert.equal(plan.opens.length, 1, plan.summary);
  assert.equal(plan.opens[0]?.pool.poolAddress, "payer");
  assert.ok(plan.opens[0].metrics.edgeUsd > 0);

  const sticker = pool({
    ...payer,
    poolAddress: "sticker",
    fee30mUsd: 400,
    fee1hUsd: 800,
    volume30mUsd: 80_000,
  });
  const dead = planFleet({ pools: [sticker], seats: [], deploySol: 0.72, now, dlmmOnly: true });
  assert.equal(dead.opens.length, 0, dead.summary);
});

test("a seat-sized print can open under the 30-minute volume floor", () => {
  const small = pool({
    poolAddress: "small",
    tokenMint: "small",
    tokenSymbol: "SMALL",
    poolName: "SMALL-SOL",
    baseFeePct: 0.05,
    binStep: 100,
    fee30mUsd: 40,
    fee1hUsd: 80,
    volume30mUsd: 800,
    pairLiquidityUsd: 8_000,
    tokenLiquidityUsd: 8_000,
  });
  const plan = planFleet({ pools: [small], seats: [], deploySol: 0.72, now, dlmmOnly: true });
  assert.equal(plan.opens.length, 1, plan.summary);

  const dust = pool({
    ...small,
    poolAddress: "dust",
    volume30mUsd: 10,
  });
  const no = planFleet({ pools: [dust], seats: [], deploySol: 0.72, now, dlmmOnly: true });
  assert.equal(no.opens.length, 0, no.summary);
});

test("a pool the fill quote accepts leads a hotter pool the geometry gate refuses", () => {
  const loud = pool({
    poolAddress: "loud",
    tokenMint: "loud",
    tokenSymbol: "LOUD",
    poolName: "LOUD-SOL",
    baseFeePct: 0.02,
    fee30mUsd: 4_000,
    fee1hUsd: 8_000,
    pairLiquidityUsd: 20_000,
    tokenLiquidityUsd: 20_000,
  });
  const payer = pool({
    poolAddress: "payer-rank",
    tokenMint: "payer-rank",
    tokenSymbol: "PAY",
    poolName: "PAY-SOL",
    baseFeePct: 0.05,
    binStep: 100,
    fee30mUsd: 400,
    fee1hUsd: 800,
    volume30mUsd: 8_000,
  });
  const plan = planFleet({ pools: [loud, payer], seats: [], deploySol: 0.72, now, dlmmOnly: true });
  assert.equal(plan.preview[0]?.poolAddress, "payer-rank");
  assert.equal(plan.preview[0]?.metThreshold, true);
  assert.equal(plan.opens[0]?.pool.poolAddress, "payer-rank");
});

test("a thin base fee does not open", () => {
  const thin = paying({
    baseFeePct: 0.02,
    fee30mUsd: 80_000,
    fee1hUsd: 160_000,
  });
  const plan = planFleet({ pools: [thin], seats: [], deploySol: 0.72, now, dlmmOnly: true });
  assert.equal(plan.opens.length, 0);
  assert.match(plan.summary, /fee rate too thin/);
  assert.equal(plan.preview[0]?.strategy, "geometry");
});

test("a bin that jumps is not a seat", () => {
  const jumped = paying({ binTapeMaxStep: 3, binTapeNet: 3, fee30mUsd: 80_000, fee1hUsd: 160_000 });
  const plan = planFleet({ pools: [jumped], seats: [], deploySol: 0.72, now, dlmmOnly: true });
  assert.equal(plan.opens.length, 0);
  assert.match(plan.summary, /no travel/);
});

test("a flat fee rate outranks a larger traveling print", () => {
  const traveler = paying({
    poolAddress: "travel",
    tokenMint: "travel",
    poolName: "TRAVEL-SOL",
    tokenSymbol: "TRAVEL",
    fee30mUsd: 80_000,
    fee1hUsd: 160_000,
    baseFeePct: 0.06,
    binTapeNet: 1,
  });
  const flat = paying({
    poolAddress: "flat",
    tokenMint: "flat",
    poolName: "FLAT-SOL",
    tokenSymbol: "FLAT",
    baseFeePct: 0.12,
    binTapeNet: 0.2,
  });
  const plan = planFleet({ pools: [traveler, flat], seats: [], deploySol: 0.72, now, dlmmOnly: true });
  assert.ok(plan.opens.length >= 1, plan.summary);
  assert.equal(plan.opens[0].pool.poolAddress, "flat");
});

test("a one-way print is not a seat", () => {
  const dump = paying({
    fee30mUsd: 80_000,
    fee1hUsd: 160_000,
    chopSamples: 8,
    chopCrossings: 0,
    chopNetBins: 6,
  });
  const plan = planFleet({ pools: [dump], seats: [], deploySol: 0.72, now, dlmmOnly: true });
  assert.equal(plan.opens.length, 0);
  assert.match(plan.summary, /no chop/);
  assert.equal(plan.preview[0]?.strategy, "chop");
});

test("missing bin depth does not open", () => {
  const blind = paying({ binSolUsd: undefined });
  const plan = planFleet({ pools: [blind], seats: [], deploySol: 0.72, now, dlmmOnly: true });
  assert.equal(plan.opens.length, 0);
  assert.match(plan.summary, /no chop/);
});

test("a falling board opens nothing and still scratches a fill", () => {
  const paused = planFleet({
    pools: [paying()],
    seats: [],
    deploySol: 0.72,
    now,
    dlmmOnly: true,
    boardDown: true,
  });
  assert.equal(paused.opens.length, 0);
  assert.match(paused.summary, /board falling/);

  const scratch = planFleet({
    pools: [pool({ priceUsd: 0.98 })],
    seats: [seat({ enteredAt: now - 10_000 })],
    deploySol: 0.72,
    now,
    boardDown: true,
  });
  assert.equal(scratch.opens.length, 0);
  assert.equal(scratch.closes.length, 1);
  assert.match(scratch.closes[0].reason, /scratched the fill/);
});

test("a fill inside the bid waits, and the way back to SOL banks", () => {
  const inside = planFleet({
    pools: [pool({ priceUsd: 0.992 })],
    seats: [
      seat({
        filled: true,
        touched: true,
        enteredAt: now - 10_000,
        entryPrice: 1,
        lastPrice: 0.992,
        binStep: 100,
      }),
    ],
    deploySol: 0.72,
    now,
  });
  assert.equal(inside.closes.length, 0, inside.closes.map((row) => row.reason).join(","));
  assert.match(inside.holds[0]?.reason ?? "", /round trip/);

  const back = planFleet({
    pools: [pool({ priceUsd: 1 })],
    seats: [
      seat({
        filled: false,
        touched: true,
        enteredAt: now - 10_000,
        entryPrice: 1,
        lastPrice: 1,
        binStep: 100,
      }),
    ],
    deploySol: 0.72,
    now,
  });
  assert.equal(back.closes.length, 1);
  assert.equal(back.closes[0].reason, "round trip back to SOL");
});

test("a watched meme stays on the scanner and does not skip the gate", () => {
  const others = Array.from({ length: 9 }, (_, i) =>
    paying({
      poolAddress: `pay-${i}`,
      tokenMint: `pay-${i}`,
      tokenSymbol: `P${i}`,
      poolName: `P${i}-SOL`,
      fee30mUsd: 40_000 - i,
    }),
  );
  const giant = paying({
    poolAddress: "giant",
    tokenMint: "stonk",
    tokenSymbol: "STONK",
    poolName: "STONK-SOL",
    pairLiquidityUsd: 2_200_000,
    tokenLiquidityUsd: 2_200_000,
    baseFeePct: 0.08,
    fee30mUsd: 600,
    watched: true,
  });
  const plan = planFleet({ pools: [...others, giant], seats: [], deploySol: 0.72, now, dlmmOnly: true });
  assert.equal(plan.opens.some((row) => row.pool.poolAddress === "giant"), false);
  assert.equal(plan.preview[0]?.tokenSymbol, "STONK");
  assert.equal(plan.preview[0]?.metThreshold, false);
  assert.ok(plan.preview.some((row) => row.tokenSymbol === "STONK"));
  assert.ok(plan.opens.length >= 1);
});

test("a falling tape and a wide bin block the entry", () => {
  const falling = planFleet({
    pools: [pool()],
    seats: [],
    deploySol: 0.72,
    now,
    dlmmOnly: true,
    moves: { "pool-a": 0.04 },
  });
  assert.equal(falling.opens.length, 0);
  assert.match(falling.summary, /tape falling/);
  assert.equal(falling.preview[0]?.strategy, "tape");
  assert.equal(falling.preview[0]?.metThreshold, false);

  const wide = planFleet({
    pools: [pool({ binStep: 400, fee30mUsd: 8_000, fee1hUsd: 16_000 })],
    seats: [],
    deploySol: 0.72,
    now,
    dlmmOnly: true,
  });
  assert.equal(wide.opens.length, 0);
  assert.equal(wide.preview[0]?.strategy, "tape");
});

test("a fast tape that only reaches the bid waits for the round trip", () => {
  const fast = planFleet({
    pools: [pool({ priceUsd: 0.994 })],
    seats: [seat({ enteredAt: now - 10_000, binStep: 100 })],
    deploySol: 0.72,
    now,
    moves: { "pool-a": 0.025 },
  });
  assert.equal(fast.closes.length, 0, fast.closes.map((row) => row.reason).join(","));
  assert.match(fast.holds[0]?.reason ?? "", /round trip/);

  const calm = planFleet({
    pools: [pool({ priceUsd: 0.994 })],
    seats: [seat({ enteredAt: now - 10_000, binStep: 100 })],
    deploySol: 0.72,
    now,
  });
  assert.equal(calm.closes.length, 0, calm.closes.map((row) => row.reason).join(","));
});

test("a shock pause opens nothing and still scratches a fill", () => {
  const paused = planFleet({
    pools: [pool()],
    seats: [],
    deploySol: 0.72,
    now,
    dlmmOnly: true,
    freezeOpens: true,
  });
  assert.equal(paused.opens.length, 0);
  assert.match(paused.summary, /shock pause/);

  const scratch = planFleet({
    pools: [pool({ priceUsd: 0.98 })],
    seats: [seat({ enteredAt: now - 10_000 })],
    deploySol: 0.72,
    now,
    freezeOpens: true,
  });
  assert.equal(scratch.opens.length, 0);
  assert.equal(scratch.closes.length, 1);
  assert.match(scratch.closes[0].reason, /scratched the fill/);
});

test("the gate ranks collected fee/TVL and keeps one pool per coin", () => {
  const hot = pool({
    poolAddress: "hot",
    tokenMint: "hot",
    tokenSymbol: "HOT",
    poolName: "HOT-SOL",
    pairLiquidityUsd: 20_000,
    tokenLiquidityUsd: 20_000,
    fee30mUsd: 4_000,
    fee1hUsd: 8_000,
    baseFeePct: 0.02,
  });
  const twin = pool({
    poolAddress: "hot-b",
    tokenMint: "hot",
    tokenSymbol: "HOT",
    poolName: "HOT-B",
    pairLiquidityUsd: 40_000,
    tokenLiquidityUsd: 40_000,
    fee30mUsd: 1_000,
    fee1hUsd: 2_000,
    baseFeePct: 0.02,
  });
  const cold = pool({
    poolAddress: "cold",
    tokenMint: "cold",
    tokenSymbol: "COLD",
    poolName: "COLD-SOL",
    pairLiquidityUsd: 20_000,
    tokenLiquidityUsd: 20_000,
    fee30mUsd: 400,
    fee1hUsd: 800,
    baseFeePct: 0.02,
    binStep: 4,
  });
  const plan = planFleet({ pools: [cold, twin, hot], seats: [], deploySol: 0.72, now, dlmmOnly: true });
  assert.equal(plan.preview.filter((row) => row.tokenSymbol === "HOT").length, 1);
  assert.equal(plan.preview[0]?.poolAddress, "hot");
  assert.ok((plan.preview[0]?.feeToTvl ?? 0) > (plan.preview[1]?.feeToTvl ?? 0));
  assert.equal(plan.preview[0]?.binStep, 200);
  assert.equal(plan.preview[0]?.baseFeePct, 0.02);
  assert.ok((plan.preview[0]?.ageMin ?? 0) > 60);
  assert.equal(plan.opens.length, 0);
});

test("one coin opens once, on the sibling the cost quote accepts", () => {
  const noisy = paying({
    poolAddress: "noisy",
    tokenMint: "same",
    tokenSymbol: "SAME",
    poolName: "NOISY-SOL",
    fee30mUsd: 14_000,
    fee1hUsd: 40_000,
    binStep: 200,
    binTapeNet: 1,
    baseFeePct: 0.06,
  });
  const quiet = paying({
    poolAddress: "quiet-same",
    tokenMint: "same",
    tokenSymbol: "SAME",
    poolName: "QUIET-SAME",
    fee30mUsd: 12_000,
    fee1hUsd: 24_000,
    binStep: 100,
    binTapeNet: 0.2,
    baseFeePct: 0.12,
  });
  const plan = planFleet({ pools: [noisy, quiet], seats: [], deploySol: 0.72, now, dlmmOnly: true });
  assert.equal(plan.opens.length, 1, plan.summary);
  assert.equal(plan.opens[0]?.pool.poolAddress, "quiet-same");
  assert.equal(plan.preview.filter((row) => row.tokenSymbol === "SAME").length, 1);
  assert.equal(plan.preview.find((row) => row.tokenSymbol === "SAME")?.poolAddress, "quiet-same");
  assert.equal(plan.preview.find((row) => row.tokenSymbol === "SAME")?.metThreshold, true);
});

test("a realized drop raises the touch budget inside the 4% cap", () => {
  const calm = skimFillFraction(100, 6, 300);
  const hit = skimFillFraction(100, 6, 300, 0.2);
  assert.ok(hit > calm);
  assert.ok(hit <= 0.04);
});

test("downwardMove is the drop from the window peak", () => {
  const at = 1_000_000;
  const drop = downwardMove(
    [
      { at: at - 50_000, price: 1 },
      { at: at - 20_000, price: 1.02 },
      { at: at - 5_000, price: 0.9792 },
    ],
    at,
    60_000,
  );
  assert.ok(Math.abs(drop - 0.04) < 1e-9);
  assert.equal(downwardMove([{ at, price: 1 }], at, 60_000), 0);
  assert.equal(downwardMove([{ at: at - 120_000, price: 2 }, { at: at - 90_000, price: 1 }], at, 60_000), 0);
});

test("an open pool is not entered twice", () => {
  const other = paying({ poolAddress: "pool-b", poolName: "NEXT-SOL", tokenSymbol: "NEXT" });
  const plan = planFleet({
    pools: [pool(), other],
    seats: [seat({ poolAddress: "pool-a" })],
    deploySol: 0.72,
    now,
    dlmmOnly: true,
  });
  assert.ok(!plan.opens.some((row) => row.pool.poolAddress === "pool-a"));
  assert.ok(plan.opens.some((row) => row.pool.poolAddress === "pool-b"), plan.summary);
});
