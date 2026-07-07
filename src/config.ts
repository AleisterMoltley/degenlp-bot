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
  scanIntervalMs: num("SCAN_INTERVAL_MS", 60_000),
  solDeploy: num("SOL_DEPLOY", 0.05),
  binRange: num("BIN_RANGE", 13),
  minOpportunityScore: num("MIN_OPPORTUNITY_SCORE", 1.0),
  minVolumeToTvl: num("MIN_VOLUME_TO_TVL", 0.55),
  minFeeToTvl: num("MIN_FEE_TO_TVL", 0.012),
  minJupiterScore: num("MIN_JUPITER_SCORE", 70),
  minPairLiquidityUsd: num("MIN_PAIR_LIQUIDITY_USD", 5_000),
  maxPairLiquidityUsd: num("MAX_PAIR_LIQUIDITY_USD", 500_000),
  scoreDivisor: num("SCORE_DIVISOR", 44),
  defaultBaseFeePct: num("DEFAULT_BASE_FEE_PCT", 0.001),
  topTokensLimit: num("TOP_TOKENS_LIMIT", 50),
  mirrorOriginal: bool("MIRROR_ORIGINAL", false),
  originalContract: process.env.ORIGINAL_CONTRACT ?? "0xdP4jw5rr0xg48XGP",
  proofnetworkTelemetry: bool("PROOFNETWORK_TELEMETRY", false),
  proofnetworkContract: process.env.PROOFNETWORK_CONTRACT ?? "",
  stateFile: process.env.STATE_FILE ?? ".degenlp-state.json",
  port: num("PORT", 3000),
  dashboardPassword: process.env.DASHBOARD_PASSWORD ?? "",
  dashboardUser: process.env.DASHBOARD_USER ?? "admin",
};