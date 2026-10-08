export type BotDecision = "wait" | "enter" | "stay" | "exit" | "adjust" | "rotate";

export type PoolVenue = "dlmm" | "damm_v2" | "damm_v1";

/** bid = SOL on the bid side, deposited in the active bin. curve = both tokens tight around the price. full = both tokens, whole curve. range = both tokens inside a fixed pool range. */
export type LpSide = "bid" | "curve" | "full" | "range";

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
  venue?: PoolVenue;
  fee30mUsd?: number;
  reason?: string;
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
  venue: PoolVenue;
  side: LpSide;
  /** skim = short SOL bid. core = the strict seat. Missing means core. */
  strategy?: "skim" | "core";
  feesAccruedUsd: number;
  ilUsd: number;
  costsUsd: number;
  /** Highest close-ready net seen on this seat. The trail reads it. */
  peakNetUsd?: number;
  lastMarkAt: number;
  lastPrice: number;
  rangeHalfWidth: number;
  priceLower: number;
  priceUpper: number;
  solPrice: number;
  scanMisses?: number;
  /** Meme is in the position right now. */
  filled?: boolean;
  /** This bid was filled at least once. Stays set after the meme converts back to SOL. */
  touched?: boolean;
  /** How many times this SOL bid has stepped up under a new price. */
  slides?: number;
  /** When the bid last stepped up. The unfilled window counts from here. */
  slidAt?: number;
  exitReason?: string;
  exitedAt?: number;
}

export interface Book {
  realizedUsd: number;
  feesUsd: number;
  ilUsd: number;
  costsUsd: number;
  entries: number;
  exits: number;
  adjusts: number;
  rotates: number;
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
  venue: PoolVenue;
  side: LpSide;
  fee30mUsd: number;
  fee1hUsd: number;
  volume30mUsd: number;
  holders: number;
  createdAtMs: number;
  freezeDisabled: boolean;
  solPrice: number;
  rangeHalfWidth: number;
  /** Set from the short price tape. Missing means the chop is unknown. */
  chopSamples?: number;
  chopCrossings?: number;
  chopNetBins?: number;
  /** USD value of SOL in the active bin. Missing means the depth was not read. */
  binSolUsd?: number;
  /** On the DexScreener Solana trending list. The same gates still apply. */
  watched?: boolean;
  /** Active-bin tape. Missing means the pool was not watched. */
  binTapeSamples?: number;
  binTapeSpanMs?: number;
  binTapeCrossings?: number;
  binTapeNet?: number;
  binTapeMaxStep?: number;
}