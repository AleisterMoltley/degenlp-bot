import { Keypair } from "@solana/web3.js";
import { priceBand } from "./pnl.js";
import type { ActivePosition, PoolCandidate } from "./types.js";

export function buildPosition(args: {
  pool: PoolCandidate;
  solDeployed: number;
  feeToTvl: number;
  opportunityScore: number;
  positionAddress?: string;
  minBinId?: number;
  maxBinId?: number;
  entrySignature?: string;
  strategy?: ActivePosition["strategy"];
}): ActivePosition {
  const band = priceBand(args.pool.priceUsd, args.pool.rangeHalfWidth, args.pool.side);
  const now = Date.now();
  return {
    id: "",
    poolAddress: args.pool.poolAddress,
    poolName: args.pool.poolName,
    baseTokenSymbol: args.pool.tokenSymbol,
    quoteTokenSymbol: "SOL",
    binStep: args.pool.binStep ?? 0,
    positionAddress: args.positionAddress ?? Keypair.generate().publicKey.toBase58(),
    minBinId: args.minBinId ?? 0,
    maxBinId: args.maxBinId ?? 0,
    solDeployed: args.solDeployed,
    entryPrice: args.pool.priceUsd,
    feeTvlRatioAtEntry: args.feeToTvl,
    liquidityAtEntry: args.pool.pairLiquidityUsd,
    opportunityScoreAtEntry: args.opportunityScore,
    marketCapAtEntry: args.pool.marketCap,
    jupiterScoreAtEntry: args.pool.jupiterScore,
    entrySignature: args.entrySignature ?? "dry_run",
    tokenMint: args.pool.tokenMint,
    status: "active",
    enteredAt: now,
    venue: args.pool.venue,
    side: args.pool.side,
    strategy: args.strategy ?? "core",
    feesAccruedUsd: 0,
    ilUsd: 0,
    costsUsd: 0,
    lastMarkAt: now,
    lastPrice: args.pool.priceUsd,
    rangeHalfWidth: args.pool.rangeHalfWidth,
    priceLower: band.lower,
    priceUpper: band.upper,
    solPrice: args.pool.solPrice,
  };
}

export function hydratePosition(pos: ActivePosition): ActivePosition {
  const side = pos.side ?? "bid";
  const half = pos.rangeHalfWidth || (side === "full" ? 0.5 : 0.1);
  const entry = pos.entryPrice || pos.lastPrice || 0;
  const band =
    pos.priceLower > 0 && pos.priceUpper > 0
      ? { lower: pos.priceLower, upper: pos.priceUpper }
      : priceBand(entry || 1, half, side);
  return {
    ...pos,
    venue: pos.venue ?? "dlmm",
    side,
    strategy: pos.strategy === "skim" ? "skim" : "core",
    feesAccruedUsd: pos.feesAccruedUsd ?? 0,
    ilUsd: pos.ilUsd ?? 0,
    costsUsd: pos.costsUsd ?? 0,
    lastMarkAt: pos.lastMarkAt || pos.enteredAt || Date.now(),
    lastPrice: pos.lastPrice || entry,
    rangeHalfWidth: half,
    priceLower: band.lower,
    priceUpper: band.upper,
    solPrice: pos.solPrice || 0,
    scanMisses: pos.scanMisses ?? 0,
  };
}
