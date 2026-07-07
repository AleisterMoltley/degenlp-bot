import { config } from "./config.js";
import type { ActivePosition, BotDecision, OpportunityCheck, PoolCandidate } from "./types.js";

export function jupiterScoreFromOrganic(organicScore: number): number {
  return Math.min(92, Math.round(organicScore));
}

export function computeMetrics(candidate: PoolCandidate) {
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