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
  /**
   * One-bin skim. Credit the fee on a single fill of the seat, and keep the
   * full scratch budget. Never a second fee, and never a zero scratch.
   */
  fillFee?: boolean;
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

/** Prior for the eight active-bin reads. Fee rate times how fast the pool turns over. */
export function depthReadRank(pool: {
  baseFeePct?: number;
  fee30mUsd: number;
  volume30mUsd: number;
  pairLiquidityUsd: number;
}): number {
  const tvl = pool.pairLiquidityUsd;
  if (!(tvl > 0)) return 0;
  return collectedFeePct(pool) * (pool.volume30mUsd / tvl);
}

/**
 * Fee rate a fill can actually collect. The lesser of the posted base fee and
 * the fees the pool collected per dollar of volume. A sticker with no flow pays nothing.
 */
export function collectedFeePct(pool: { baseFeePct?: number; fee30mUsd: number; volume30mUsd: number }): number {
  const posted = pool.baseFeePct ?? 0;
  if (!(posted > 0) || !(pool.volume30mUsd > 0) || !(pool.fee30mUsd > 0)) return 0;
  return Math.min(posted, pool.fee30mUsd / pool.volume30mUsd);
}

/**
 * Standard DLMM pools pay the LP 90% of the trading fee. Launch pools pay 80%.
 * The pool list does not say which, so the fill quote keeps the standard 90%.
 */
const LP_FEE_KEEP = 0.9;

/**
 * Dollars of this seat the next half hour can actually trade against.
 * A full conversion earns the fee on the deposit no matter how deep the bin is,
 * but only if that much volume reaches our liquidity. Our share of the active
 * bin is the deposit over the SOL already there plus the deposit. A missing
 * bin read keeps the old cap, which is the lesser of the seat and the pool volume.
 * This never credits a second flip.
 */
export function fillNotionalUsd(
  pool: { volume30mUsd: number; binSolUsd?: number },
  deployUsd: number,
): number {
  if (!(deployUsd > 0) || !(pool.volume30mUsd > 0)) return 0;
  const reached = Math.min(deployUsd, pool.volume30mUsd);
  const bin = pool.binSolUsd;
  if (!(bin != null && bin > 0)) return reached;
  const share = deployUsd / (bin + deployUsd);
  return Math.min(deployUsd, pool.volume30mUsd * share);
}

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
  // A one-bin fill is different: the fee is the rate on the notional that
  // trades into the bin, once. The scratch budget below is unchanged.
  let expectedFeesUsd = feePerMin * input.holdMin * share * timeInRange(pool, input.holdMin);
  if (input.fillFee && pool.side === "bid") {
    let feePct = collectedFeePct(pool);
    if (prior30 > 0 && pool.fee30mUsd < prior30 * 0.75) feePct *= 0.45;
    expectedFeesUsd = feePct * fillNotionalUsd(pool, deployUsd) * LP_FEE_KEEP;
  }
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

/**
 * Hunter trail: arm after the seat is ahead by startPct of its size, then
 * leave once it gives back dropPct of that size from the peak.
 */
export function trailGaveBack(args: {
  bankableUsd: number;
  peakNetUsd: number;
  deployUsd: number;
  startPct: number;
  dropPct: number;
}): boolean {
  if (!(args.deployUsd > 0) || !(args.startPct > 0) || !(args.dropPct > 0)) return false;
  if (args.peakNetUsd < args.deployUsd * args.startPct) return false;
  return args.bankableUsd <= args.peakNetUsd - args.deployUsd * args.dropPct;
}
