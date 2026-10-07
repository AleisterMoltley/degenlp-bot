import "dotenv/config";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

export const config = {
  rpcUrl: process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com",
  walletPrivateKey: process.env.WALLET_PRIVATE_KEY ?? "",
  dryRun: bool("DRY_RUN", true),
  scanIntervalMs: num("SCAN_INTERVAL_MS", 4_000),
  /** Backup read of an open pool. The websocket is the slot signal. */
  fillPollMs: num("FILL_POLL_MS", 400),
  fleetSlots: num("FLEET_SLOTS", 8),
  fleetHoldMin: num("FLEET_HOLD_MIN", 4),
  fleetBankUsd: num("FLEET_BANK_USD", 0.02),
  fleetBankMinMs: num("FLEET_BANK_MIN_MS", 15_000),
  fleetMaxLifeMs: num("FLEET_MAX_LIFE_MS", 8 * 60_000),
  fleetFastExitMs: num("FLEET_FAST_EXIT_MS", 45_000),
  fleetMaxSeatShare: num("FLEET_MAX_SEAT_SHARE", 0.22),
  fleetTapeMs: num("FLEET_TAPE_MS", 60_000),
  fleetShockWindowMs: num("FLEET_SHOCK_WINDOW_MS", 10 * 60_000),
  fleetShockPauseMs: num("FLEET_SHOCK_PAUSE_MS", 3 * 60_000),
  fleetMaxBinStep: num("FLEET_MAX_BIN_STEP", 250),
  fleetCoreShare: num("FLEET_CORE_SHARE", 0.4),
  fleetMinSlot: num("FLEET_MIN_SLOT", 0.04),
  fleetOpensPerScan: num("FLEET_OPENS_PER_SCAN", 3),
  solDeploy: num("SOL_DEPLOY", 0.05),
  growthStartSol: num("GROWTH_START_SOL", 1),
  growthTargetSol: num("GROWTH_TARGET_SOL", 30),
  growthWeekMs: num("GROWTH_WEEK_MS", 7 * 24 * 60 * 60 * 1000),
  growthRisk: num("GROWTH_RISK", 0.72),
  growthLossCut: num("GROWTH_LOSS_CUT", 0.12),
  trailStartPct: num("TRAIL_START_PCT", 0.05),
  trailDropPct: num("TRAIL_DROP_PCT", 0.08),
  binRange: num("BIN_RANGE", 13),
  scalpBins: num("SCALP_BINS", 6),
  scalpHoldMin: num("SCALP_HOLD_MIN", 12),
  minEdgeUsd: num("MIN_EDGE_USD", 0.02),
  dipCut: num("DIP_CUT", 0.003),
  minOpportunityScore: num("MIN_OPPORTUNITY_SCORE", 1.0),
  minVolumeToTvl: num("MIN_VOLUME_TO_TVL", 0.55),
  minFeeToTvl: num("MIN_FEE_TO_TVL", 0.012),
  minJupiterScore: num("MIN_JUPITER_SCORE", 70),
  minPairLiquidityUsd: num("MIN_PAIR_LIQUIDITY_USD", 8_000),
  maxPairLiquidityUsd: num("MAX_PAIR_LIQUIDITY_USD", 800_000),
  minFeeScore: num("MIN_FEE_SCORE", 0.2),
  minFeeToTvl30m: num("MIN_FEE_TO_TVL_30M", 0.002),
  minFee30mUsd: num("MIN_FEE_30M_USD", 25),
  minVolume30mUsd: num("MIN_VOLUME_30M_USD", 2_000),
  minHolders: num("MIN_HOLDERS", 80),
  minPoolAgeMin: num("MIN_POOL_AGE_MIN", 20),
  minHoldMs: num("MIN_HOLD_MS", 300_000),
  handoffSettleMs: num("HANDOFF_SETTLE_MS", 60_000),
  adjustCooldownMs: num("ADJUST_COOLDOWN_MS", 20_000),
  switchEdge: num("SWITCH_EDGE", 1.45),
  txCostUsd: num("TX_COST_USD", 0.02),
  swapBps: num("SWAP_BPS", 40),
  venues: (process.env.VENUES ?? "dlmm,damm_v2,damm_v1")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean),
  scoreDivisor: num("SCORE_DIVISOR", 44),
  defaultBaseFeePct: num("DEFAULT_BASE_FEE_PCT", 0.001),
  topTokensLimit: num("TOP_TOKENS_LIMIT", 50),
  mirrorOriginal: bool("MIRROR_ORIGINAL", false),
  originalContract: process.env.ORIGINAL_CONTRACT ?? "0xdP4jw5rr0xg48XGP",
  proofnetworkTelemetry: bool("PROOFNETWORK_TELEMETRY", false),
  proofnetworkContract: process.env.PROOFNETWORK_CONTRACT ?? "",
  stateFile: process.env.STATE_FILE ?? ".degenlp-state.json",
  /** One-shot. The state file records the epoch so the next boot keeps new closes. */
  resetPnl: bool("RESET_PNL", false),
  port: num("PORT", 3000),
  dashboardPassword: process.env.DASHBOARD_PASSWORD ?? "",
  dashboardUser: process.env.DASHBOARD_USER ?? "admin",
};