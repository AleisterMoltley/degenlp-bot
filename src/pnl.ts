import type { LpSide } from "./types.js";

export function halfWidthFromBins(binStep: number, bins: number): number {
  const step = Math.max(binStep, 1) / 10_000;
  const width = (1 + step) ** Math.max(bins, 1) - 1;
  return Math.min(0.45, Math.max(0.01, width));
}

export function priceBand(
  entry: number,
  half: number,
  side: LpSide,
): { lower: number; upper: number } {
  const h = Math.min(0.45, Math.max(0.01, half));
  if (side === "bid") {
    return { lower: entry * (1 - h), upper: entry * (1 + h * 0.2) };
  }
  if (side === "range" || side === "curve") {
    return { lower: entry * (1 - h), upper: entry * (1 + h) };
  }
  return { lower: entry * 1e-9, upper: entry * 1e9 };
}

export function inBand(price: number, lower: number, upper: number): boolean {
  return price >= lower && price <= upper;
}

/**
 * Share of the pool's recent fees this deposit would have caught.
 * Concentrated sides get a capped boost because TVL includes idle liquidity.
 * Bids only earn on sells that trade into the range, so their capture is partial.
 */
export function feeShare(args: {
  tvlUsd: number;
  deployUsd: number;
  side: LpSide;
  rangeHalfWidth: number;
}): number {
  if (args.tvlUsd <= 0 || args.deployUsd <= 0) return 0;
  const width = Math.max(args.rangeHalfWidth, 0.01);
  const concentration = args.side === "full" ? 1 : Math.min(8, 1 / (2 * width));
  const capture = args.side === "full" ? 1 : args.side === "curve" ? 0.85 : args.side === "range" ? 0.7 : 0.45;
  return Math.min(0.15, (args.deployUsd / args.tvlUsd) * concentration * capture);
}

export function accrueFees(args: {
  fees30mUsd: number;
  tvlUsd: number;
  deployUsd: number;
  elapsedMin: number;
  inRange: boolean;
  side: LpSide;
  rangeHalfWidth: number;
}): number {
  if (!args.inRange || args.elapsedMin <= 0 || args.fees30mUsd <= 0) return 0;
  return (args.fees30mUsd / 30) * args.elapsedMin * feeShare(args);
}

/** Mark-to-market divergence versus the deposit. Not a cumulative sum. */
export function markIlUsd(args: {
  deployUsd: number;
  entryPrice: number;
  price: number;
  lower: number;
  upper: number;
  side: LpSide;
}): number {
  const { deployUsd, entryPrice, price, lower, upper, side } = args;
  if (deployUsd <= 0 || entryPrice <= 0 || price <= 0) return 0;

  if (side === "full") {
    const ratio = price / entryPrice;
    const il = 2 * Math.sqrt(ratio) / (1 + ratio) - 1;
    return deployUsd * Math.max(0, -il);
  }

  if (side === "curve") {
    const half = Math.max((upper - lower) / 2 / entryPrice, 0.01);
    const move = Math.abs(price - entryPrice) / entryPrice;
    const covered = Math.min(move, half);
    const outside = Math.max(0, move - half);
    const frac = Math.min(0.8, 0.5 * covered + 0.85 * Math.min(outside, 0.5));
    return deployUsd * frac;
  }

  // A bid placed under the entry print is still quote-token until price trades down through it.
  if (price >= entryPrice) return 0;
  if (price >= lower) {
    const span = Math.max(upper - lower, entryPrice * 1e-9);
    const through = (upper - price) / span;
    return deployUsd * 0.35 * Math.min(1, Math.max(0, through));
  }
  const extra = Math.min(0.8, (lower - price) / lower);
  return deployUsd * (0.45 + extra);
}

export function entryCostUsd(args: {
  side: LpSide;
  deployUsd: number;
  txCostUsd: number;
  swapBps: number;
}): number {
  const swap = args.side === "bid" ? 0 : args.deployUsd * (args.swapBps / 10_000);
  return args.txCostUsd + swap;
}
