import { entryCostUsd, feeShare, markIlUsd } from "./pnl.js";
import type { LpSide, PoolCandidate } from "./types.js";

export interface EdgeInput {
  holdMin: number;
  txCostUsd: number;
  swapBps: number;
  minEdgeUsd: number;
  deploySol: number;
  /** Bid inventory charged up front. Defaults to a 4% fill. A skim passes a one-bin touch. */
  fillFraction?: number;
}

export interface EdgeQuote {
  feePerMin: number;
  share: number;
  expectedFeesUsd: number;
  roundTripUsd: number;
  ilBudgetUsd: number;
  edgeUsd: number;
  profitable: boolean;
}

const FLAT: EdgeQuote = {
  feePerMin: 0,
  share: 0,
  expectedFeesUsd: 0,
  roundTripUsd: 0,
  ilBudgetUsd: 0,
  edgeUsd: 0,
  profitable: false,
};

/** Expected dollars left after the round trip and a small adverse move. */
export function quoteEdge(pool: PoolCandidate, input: EdgeInput): EdgeQuote {
  const deployUsd = input.deploySol * (pool.solPrice || 0);
  if (deployUsd <= 0 || pool.fee30mUsd <= 0 || pool.pairLiquidityUsd <= 0 || pool.priceUsd <= 0) {
    return FLAT;
  }

  const hour = pool.fee1hUsd > 0 ? pool.fee1hUsd : pool.fee30mUsd * 2;
  const prior30 = Math.max(0, hour - pool.fee30mUsd);
  let feePerMin = pool.fee30mUsd / 30;
  if (prior30 > 0 && pool.fee30mUsd < prior30 * 0.75) feePerMin *= 0.45;
  else if (prior30 > 0 && pool.fee30mUsd > prior30 * 1.25) feePerMin *= 1.12;

  const share = feeShare({
    tvlUsd: pool.pairLiquidityUsd,
    deployUsd,
    side: pool.side,
    rangeHalfWidth: pool.rangeHalfWidth,
  });
  // A tight bid does not sit in range for the whole hold. Scale fees by how
  // much room the band has versus a few minutes of memecoin noise.
  const expectedFeesUsd = feePerMin * input.holdMin * share * timeInRange(pool, input.holdMin);
  const roundTripUsd =
    entryCostUsd({
      side: pool.side,
      deployUsd,
      txCostUsd: input.txCostUsd,
      swapBps: input.swapBps,
    }) + input.txCostUsd;
  const ilBudgetUsd = adverseBudget(
    pool.side,
    deployUsd,
    pool.priceUsd,
    pool.rangeHalfWidth,
    input.fillFraction ?? 0.04,
  );
  const edgeUsd = expectedFeesUsd - roundTripUsd - ilBudgetUsd;
  return {
    feePerMin,
    share,
    expectedFeesUsd,
    roundTripUsd,
    ilBudgetUsd,
    edgeUsd,
    profitable: edgeUsd >= input.minEdgeUsd,
  };
}

function timeInRange(pool: PoolCandidate, holdMin: number): number {
  if (pool.side === "full") return 1;
  const half = Math.max(pool.rangeHalfWidth, 0.01);
  const room = pool.side === "bid" ? half * 0.2 : half;
  const noise = 0.025 * Math.sqrt(Math.max(holdMin, 0.25) / 4);
  return Math.min(1, Math.max(0.2, room / Math.max(noise, 1e-6)));
}

function adverseBudget(
  side: LpSide,
  deployUsd: number,
  price: number,
  half: number,
  fillFraction: number,
): number {
  // A filled bid owns the meme. The strict seat charges a 4% fill. A skim charges a one-bin touch.
  if (side === "bid") return deployUsd * fillFraction;
  if (side === "full") {
    return markIlUsd({
      deployUsd,
      entryPrice: price,
      price: price * 1.015,
      lower: price * 1e-6,
      upper: price * 1e6,
      side: "full",
    });
  }
  if (side === "curve") {
    const move = 0.1;
    const marked = markIlUsd({
      deployUsd,
      entryPrice: price,
      price: price * (1 - move),
      lower: price * (1 - half),
      upper: price * (1 + half),
      side: "curve",
    });
    return Math.max(marked, deployUsd * 0.1);
  }
  const move = Math.min(Math.max(half, 0.01), 0.04);
  return markIlUsd({
    deployUsd,
    entryPrice: price,
    price: price * (1 - move),
    lower: price * (1 - Math.max(half, move)),
    upper: price * (1 + Math.max(half, move)),
    side: "range",
  });
}

export type FeeHeat = "hot" | "flat" | "cool";

export function feeHeat(pool: { fee30mUsd: number; fee1hUsd: number }): FeeHeat {
  const hour = pool.fee1hUsd > 0 ? pool.fee1hUsd : pool.fee30mUsd * 2;
  const prior = Math.max(0, hour - pool.fee30mUsd);
  if (prior <= 0 || pool.fee30mUsd <= 0) return "flat";
  if (pool.fee30mUsd < prior * 0.75) return "cool";
  if (pool.fee30mUsd > prior * 1.25) return "hot";
  return "flat";
}

/** DLMM can sit as a SOL bid or a curve. The curve must clear the bid plus an inventory hurdle. */
export function chooseShape(pool: PoolCandidate, input: EdgeInput): LpSide {
  if (pool.venue !== "dlmm") return pool.side;
  const bid = quoteEdge({ ...pool, side: "bid" }, input);
  const curve = quoteEdge({ ...pool, side: "curve" }, input);
  const deployUsd = input.deploySol * (pool.solPrice || 0);
  return curve.edgeUsd > bid.edgeUsd + deployUsd * 0.1 ? "curve" : "bid";
}

export function bankableUsd(fees: number, il: number, costs: number, exitTx: number): number {
  return fees - il - costs - exitTx;
}
