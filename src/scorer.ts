import { config } from "./config.js";
import { bankableUsd, chooseShape, feeHeat, quoteEdge, trailGaveBack } from "./edge.js";
import { inBand, markIlUsd } from "./pnl.js";
import type { ActivePosition, BotDecision, OpportunityCheck, PoolCandidate } from "./types.js";

export interface Metrics {
  volume5m: number;
  poolTvl: number;
  marketCap: number;
  jupiterScore: number;
  volumeToTvlRatio: number;
  volumeToMcapRatio: number;
  feeToTvlRatio: number;
  opportunityScore: number;
  edgeUsd: number;
  metThreshold: boolean;
}

export interface RankedPool {
  pool: PoolCandidate;
  metrics: Metrics;
}

export interface Plan {
  action: BotDecision;
  pool: PoolCandidate | null;
  metrics: Metrics | null;
  reason: string;
}

export function jupiterScoreFromOrganic(organicScore: number): number {
  return Math.min(92, Math.round(organicScore));
}

export interface QuoteOpts {
  holdMin?: number;
  fillFraction?: number;
  swapBps?: number;
  lockSide?: boolean;
  fillFee?: boolean;
}

export function computeMetrics(
  candidate: PoolCandidate,
  deploySol = config.solDeploy,
  growth = false,
  quote?: QuoteOpts,
): Metrics {
  if (candidate.fee30mUsd > 0) return computeFeeMetrics(candidate, deploySol, growth, quote);
  return computeLegacyMetrics(candidate);
}

function computeFeeMetrics(
  candidate: PoolCandidate,
  deploySol = config.solDeploy,
  growth = false,
  quote?: QuoteOpts,
): Metrics {
  const volume30m = candidate.volume30mUsd;
  const fee30m = candidate.fee30mUsd;
  const poolTvl = candidate.pairLiquidityUsd;
  const marketCap = Math.max(candidate.marketCap, 1);
  const ageMin = candidate.createdAtMs > 0 ? (Date.now() - candidate.createdAtMs) / 60_000 : 0;

  let quality = 1;
  if (candidate.createdAtMs > 0 && ageMin < 60) quality *= 0.8;
  else if (candidate.createdAtMs > 0 && ageMin < 180) quality *= 0.92;
  if (candidate.holders <= 0) quality *= 0.85;
  else if (candidate.holders < 300) quality *= 0.9;

  const feeToTvlRatio = fee30m / Math.max(poolTvl, 1);
  const volumeToTvlRatio = volume30m / Math.max(poolTvl, 1);
  const seatUsd = deploySol * (candidate.solPrice || 0);
  // A one-bin fill only needs enough volume to trade the seat. The 30-minute
  // dollar floor stays on every other quote.
  const volumeOk = quote?.fillFee ? volume30m >= seatUsd : volume30m >= config.minVolume30mUsd;
  const minEdgeUsd = growth
    ? Math.max(config.minEdgeUsd, deploySol * (candidate.solPrice || 0) * 0.003)
    : config.minEdgeUsd;
  const edgeInput = {
    holdMin: quote?.holdMin ?? config.scalpHoldMin,
    txCostUsd: config.txCostUsd,
    swapBps: quote?.swapBps ?? (config.dryRun ? config.swapBps : Math.max(config.swapBps, 300)),
    minEdgeUsd,
    deploySol,
    fillFraction: quote?.fillFraction,
    fillFee: quote?.fillFee,
  };
  if (candidate.venue === "dlmm" && !quote?.lockSide) {
    candidate.side = chooseShape(candidate, edgeInput);
  }
  const edge = quoteEdge(candidate, edgeInput);
  const opportunityScore = edge.edgeUsd * quality;
  const ageOk = candidate.createdAtMs <= 0 || ageMin >= config.minPoolAgeMin;
  const holdersOk = candidate.holders <= 0 || candidate.holders >= config.minHolders;

  const metThreshold =
    candidate.freezeDisabled &&
    ageOk &&
    holdersOk &&
    fee30m >= config.minFee30mUsd &&
    volumeOk &&
    poolTvl >= config.minPairLiquidityUsd &&
    poolTvl <= config.maxPairLiquidityUsd &&
    feeToTvlRatio >= config.minFeeToTvl30m &&
    edge.profitable;

  return {
    volume5m: candidate.volume5m,
    poolTvl,
    marketCap,
    jupiterScore: candidate.jupiterScore,
    volumeToTvlRatio,
    volumeToMcapRatio: volume30m / marketCap,
    feeToTvlRatio,
    opportunityScore,
    edgeUsd: edge.edgeUsd,
    metThreshold,
  };
}

function computeLegacyMetrics(candidate: PoolCandidate): Metrics {
  const volume5m = candidate.volume5m;
  const poolTvl = candidate.pairLiquidityUsd;
  const tokenLiquidity = Math.max(candidate.tokenLiquidityUsd, 1);
  const marketCap = Math.max(candidate.marketCap, 1);
  const jupiterScore = jupiterScoreFromOrganic(candidate.jupiterScore);
  const baseFee = candidate.baseFeePct ?? config.defaultBaseFeePct;

  const volumeToTvlRatio = volume5m / tokenLiquidity;
  const volumeToMcapRatio = volume5m / marketCap;
  const feeToTvlRatio = (volume5m * baseFee) / Math.max(poolTvl, 1);
  const opportunityScore = volumeToTvlRatio * (jupiterScore / config.scoreDivisor);

  const metThreshold =
    opportunityScore >= config.minOpportunityScore &&
    volumeToTvlRatio >= config.minVolumeToTvl &&
    feeToTvlRatio >= config.minFeeToTvl &&
    jupiterScore >= config.minJupiterScore &&
    poolTvl >= config.minPairLiquidityUsd &&
    poolTvl <= config.maxPairLiquidityUsd;

  return {
    volume5m,
    poolTvl,
    marketCap,
    jupiterScore,
    volumeToTvlRatio,
    volumeToMcapRatio,
    feeToTvlRatio,
    opportunityScore,
    edgeUsd: 0,
    metThreshold,
  };
}

export function pickBestCandidate(candidates: PoolCandidate[]): PoolCandidate | null {
  let best: { candidate: PoolCandidate; score: number } | null = null;

  for (const candidate of candidates) {
    const m = computeMetrics(candidate);
    if (!m.metThreshold) continue;
    if (!best || m.opportunityScore > best.score) {
      best = { candidate, score: m.opportunityScore };
    }
  }

  return best?.candidate ?? null;
}

export function decide(
  best: PoolCandidate | null,
  active: ActivePosition | null,
): OpportunityCheck {
  const now = Date.now();
  const currentPositionPool = active?.poolAddress ?? "";

  if (!best) {
    if (active) {
      return buildCheckFromActive(active, "exit", false, now);
    }
    return emptyCheck("wait", now);
  }

  const m = computeMetrics(best);

  if (!active) {
    return toCheck(best, m, m.metThreshold ? "enter" : "wait", currentPositionPool, now);
  }

  if (active.poolAddress === best.poolAddress && m.metThreshold) {
    return toCheck(best, m, "stay", currentPositionPool, now);
  }

  if (active.poolAddress === best.poolAddress && !m.metThreshold) {
    return toCheck(best, m, "exit", currentPositionPool, now);
  }

  if (m.metThreshold && m.opportunityScore > active.opportunityScoreAtEntry * 1.1) {
    return toCheck(best, m, "exit", currentPositionPool, now);
  }

  return toCheck(best, m, active ? "stay" : "wait", currentPositionPool, now);
}

function toCheck(
  candidate: PoolCandidate,
  m: ReturnType<typeof computeMetrics>,
  decision: BotDecision,
  currentPositionPool: string,
  checkedAt: number,
): OpportunityCheck {
  return {
    poolAddress: candidate.poolAddress,
    poolName: candidate.poolName,
    tokenSymbol: candidate.tokenSymbol,
    tokenMint: candidate.tokenMint,
    opportunityScore: m.opportunityScore,
    volumeToTvlRatio: m.volumeToTvlRatio,
    volumeToMcapRatio: m.volumeToMcapRatio,
    feeToTvlRatio: m.feeToTvlRatio,
    marketCap: m.marketCap,
    poolTvl: m.poolTvl,
    volume5m: m.volume5m,
    jupiterScore: m.jupiterScore,
    decision,
    currentPositionPool,
    metThreshold: m.metThreshold,
    binStep: candidate.binStep,
    checkedAt,
  };
}

function buildCheckFromActive(
  active: ActivePosition,
  decision: BotDecision,
  metThreshold: boolean,
  checkedAt: number,
): OpportunityCheck {
  return {
    poolAddress: active.poolAddress,
    poolName: active.poolName,
    tokenSymbol: active.baseTokenSymbol,
    tokenMint: active.tokenMint,
    opportunityScore: active.opportunityScoreAtEntry,
    volumeToTvlRatio: 0,
    volumeToMcapRatio: 0,
    feeToTvlRatio: 0,
    marketCap: active.marketCapAtEntry,
    poolTvl: active.liquidityAtEntry,
    volume5m: 0,
    jupiterScore: active.jupiterScoreAtEntry,
    decision,
    currentPositionPool: active.poolAddress,
    metThreshold,
    binStep: active.binStep,
    checkedAt,
  };
}

function emptyCheck(decision: BotDecision, checkedAt: number): OpportunityCheck {
  return {
    poolAddress: "none",
    poolName: "No opportunity found",
    tokenSymbol: "",
    tokenMint: "",
    opportunityScore: 0,
    volumeToTvlRatio: 0,
    volumeToMcapRatio: 0,
    feeToTvlRatio: 0,
    marketCap: 0,
    poolTvl: 0,
    volume5m: 0,
    jupiterScore: 0,
    decision,
    currentPositionPool: "",
    metThreshold: false,
    checkedAt,
  };
}

export function rankPools(
  candidates: PoolCandidate[],
  options?: { deploySol?: number; growth?: boolean },
): RankedPool[] {
  const deploySol = options?.deploySol ?? config.solDeploy;
  const growth = options?.growth ?? false;
  return candidates
    .map((pool) => ({ pool, metrics: computeMetrics(pool, deploySol, growth) }))
    .sort(
      (a, b) =>
        b.metrics.edgeUsd - a.metrics.edgeUsd ||
        b.metrics.feeToTvlRatio - a.metrics.feeToTvlRatio ||
        b.metrics.opportunityScore - a.metrics.opportunityScore,
    );
}

export function planPosition(args: {
  ranked: RankedPool[];
  active: ActivePosition | null;
  now: number;
  deploySol?: number;
  lossCut?: number;
}): Plan {
  const best = args.ranked.find((row) => row.metrics.metThreshold) ?? null;
  if (!args.active) {
    if (!best) return { action: "wait", pool: null, metrics: null, reason: "no pool clears costs" };
    return {
      action: "enter",
      pool: best.pool,
      metrics: best.metrics,
      reason: `scalp edge $${best.metrics.edgeUsd.toFixed(3)} after costs`,
    };
  }

  const active = args.active;
  const current = args.ranked.find((row) => row.pool.poolAddress === active.poolAddress) ?? null;
  const price = current?.pool.priceUsd || active.lastPrice || active.entryPrice;
  const held = args.now - active.enteredAt;
  const above = price > active.priceUpper;
  const below = price < active.priceLower;
  const inside = inBand(price, active.priceLower, active.priceUpper);
  const deployUsd = active.solDeployed * (current?.pool.solPrice || active.solPrice || 0);
  const liveIl =
    deployUsd > 0
      ? markIlUsd({
          deployUsd,
          entryPrice: active.entryPrice,
          price,
          lower: active.priceLower,
          upper: active.priceUpper,
          side: active.side,
        })
      : active.ilUsd;
  const bankable = bankableUsd(active.feesAccruedUsd, liveIl, active.costsUsd, config.txCostUsd);

  if (!current) {
    if ((active.scanMisses ?? 0) >= 4) {
      return { action: "exit", pool: null, metrics: null, reason: "pool left the fee list" };
    }
    return { action: "stay", pool: null, metrics: null, reason: "pool missed this scan; holding the seat" };
  }

  // A dump that already ate the fees is the only red leave. A bid still inside
  // its band is the seat working, so a small dip does not shake it out.
  const hurting = held > 60_000 && liveIl > active.feesAccruedUsd + config.minEdgeUsd;
  if (active.side !== "bid" && hurting) {
    return {
      action: "exit",
      pool: current.pool,
      metrics: current.metrics,
      reason: "divergence passed the fees",
    };
  }
  if (active.side === "bid" && below) {
    return {
      action: "exit",
      pool: current.pool,
      metrics: current.metrics,
      reason: "bid filled and price left the range",
    };
  }
  if (active.side === "range" && !inside) {
    return {
      action: "exit",
      pool: current.pool,
      metrics: current.metrics,
      reason: "price left the fixed pool range",
    };
  }

  const solPx = current.pool.solPrice || active.solPrice || 0;
  if (
    trailGaveBack({
      bankableUsd: bankable,
      peakNetUsd: active.peakNetUsd ?? bankable,
      deployUsd,
      startPct: config.trailStartPct,
      dropPct: config.trailDropPct,
    })
  ) {
    return {
      action: "exit",
      pool: current.pool,
      metrics: current.metrics,
      reason: "trail gave back the run",
    };
  }
  if (args.lossCut && args.lossCut > 0 && solPx > 0 && active.solDeployed > 0 && held > 20_000) {
    const openSol = (active.feesAccruedUsd - liveIl - active.costsUsd) / solPx;
    if (openSol <= -args.lossCut * active.solDeployed) {
      return {
        action: "exit",
        pool: current.pool,
        metrics: current.metrics,
        reason: "seat lost the risk budget",
      };
    }
  }
  if (args.deploySol && args.deploySol > active.solDeployed * 4 && held > 15_000 && current.metrics.metThreshold) {
    return {
      action: "exit",
      pool: current.pool,
      metrics: current.metrics,
      reason: "resizing the seat to the bankroll",
    };
  }

  const settled = held >= config.handoffSettleMs;
  const cool = feeHeat(current.pool) === "cool";
  const dead = !current.metrics.metThreshold;
  const out =
    (active.side === "bid" && above) ||
    (active.side === "curve" && !inside);

  // A cooling or dead tape overstates the last half hour. Once the close is
  // green, lock it into a pool that is still paying, or into cash if none is.
  if (bankable >= config.minEdgeUsd && settled && (cool || dead)) {
    const nextPaying = args.ranked.find(
      (row) =>
        row.metrics.metThreshold &&
        row.pool.poolAddress !== active.poolAddress &&
        feeHeat(row.pool) !== "cool",
    );
    if (nextPaying) {
      return {
        action: "rotate",
        pool: nextPaying.pool,
        metrics: nextPaying.metrics,
        reason: `banked $${bankable.toFixed(3)} as the spike cooled`,
      };
    }
    if (dead) {
      return {
        action: "exit",
        pool: current.pool,
        metrics: current.metrics,
        reason: `banked $${bankable.toFixed(3)}, pool no longer pays`,
      };
    }
  }

  // Leave only once the close is green, and only into another pool that is
  // better or equal. The same pool stays open so the handoff does not pay a
  // round trip to climb back into the seat it just left.
  const next =
    bankable >= config.minEdgeUsd
      ? args.ranked.find(
          (row) =>
            row.metrics.metThreshold &&
            row.pool.poolAddress !== active.poolAddress &&
            row.metrics.edgeUsd >= current.metrics.edgeUsd,
        )
      : null;
  const clearlyBetter = !!next && next.metrics.edgeUsd >= current.metrics.edgeUsd + config.minEdgeUsd;
  if (next && settled && (clearlyBetter || held >= config.minHoldMs)) {
    return {
      action: "rotate",
      pool: next.pool,
      metrics: next.metrics,
      reason: `banked $${bankable.toFixed(3)} into ${clearlyBetter ? "a better" : "an equal"} pool`,
    };
  }

  // Getting back under the fee flow is worth one recenter once the seat has
  // already paid for the close. Chasing before that just burns the round trip.
  if (out && bankable >= 0 && current.metrics.metThreshold && settled) {
    return {
      action: "adjust",
      pool: current.pool,
      metrics: current.metrics,
      reason: "recenter under the fee flow",
    };
  }

  if (bankable >= config.minEdgeUsd) {
    return {
      action: "stay",
      pool: current.pool,
      metrics: current.metrics,
      reason: next ? "green; holding for the handoff" : "green, and this pool is still the best",
    };
  }

  if (out && active.side === "bid") {
    return {
      action: "stay",
      pool: current.pool,
      metrics: current.metrics,
      reason: "price lifted; holding the quote",
    };
  }
  if (out && active.side === "curve") {
    return {
      action: "stay",
      pool: current.pool,
      metrics: current.metrics,
      reason: "out of range; holding until the seat pays for a recenter",
    };
  }
  if (!current.metrics.metThreshold && active.side !== "bid") {
    return {
      action: "exit",
      pool: current.pool,
      metrics: current.metrics,
      reason: "edge gone on the inventory seat",
    };
  }
  if (!current.metrics.metThreshold) {
    return {
      action: "stay",
      pool: current.pool,
      metrics: current.metrics,
      reason: "edge faded; holding until the seat is green",
    };
  }
  if (best && best.pool.poolAddress !== active.poolAddress) {
    return {
      action: "stay",
      pool: current.pool,
      metrics: current.metrics,
      reason: "holding until the seat is green",
    };
  }
  return { action: "stay", pool: current.pool, metrics: current.metrics, reason: "still the pool to hold" };
}

export function planToCheck(plan: Plan, active: ActivePosition | null, checkedAt: number): OpportunityCheck {
  if (!plan.pool || !plan.metrics) {
    if (active) return { ...buildCheckFromActive(active, plan.action, false, checkedAt), reason: plan.reason };
    return { ...emptyCheck(plan.action, checkedAt), reason: plan.reason };
  }
  return {
    ...toCheck(plan.pool, plan.metrics, plan.action, active?.poolAddress ?? "", checkedAt),
    venue: plan.pool.venue,
    fee30mUsd: plan.pool.fee30mUsd,
    reason: plan.reason,
  };
}