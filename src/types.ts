export type BotDecision = "wait" | "enter" | "stay" | "exit";

export interface OpportunityCheck {
  poolAddress: string;
  poolName: string;
  tokenSymbol: string;
  tokenMint: string;
  opportunityScore: number;
  volumeToTvlRatio: number;
  volumeToMcapRatio: number;
  feeToTvlRatio: number;
  marketCap: number;
  poolTvl: number;
  volume5m: number;
  jupiterScore: number;
  decision: BotDecision;
  currentPositionPool: string;
  metThreshold: boolean;
  binStep?: number;
  checkedAt: number;
}

export interface ActivePosition {
  id: string;
  poolAddress: string;
  poolName: string;
  baseTokenSymbol: string;
  quoteTokenSymbol: string;
  binStep: number;
  positionAddress: string;
  minBinId: number;
  maxBinId: number;
  solDeployed: number;
  entryPrice: number;
  feeTvlRatioAtEntry: number;
  liquidityAtEntry: number;
  opportunityScoreAtEntry: number;
  marketCapAtEntry: number;
  jupiterScoreAtEntry: number;
  entrySignature: string;
  tokenMint: string;
  status: "active" | "closed";
  enteredAt: number;
}

export interface PoolCandidate {
  tokenMint: string;
  tokenSymbol: string;
  poolAddress: string;
  poolName: string;
  pairLiquidityUsd: number;
  tokenLiquidityUsd: number;
  marketCap: number;
  volume5m: number;
  priceUsd: number;
  binStep?: number;
  baseFeePct?: number;
  jupiterScore: number;
}