import type { PoolCandidate } from "./types.js";
import { jupiterScoreFromOrganic } from "./scorer.js";

const UA = "degenlp-bot/1.0";

interface JupiterToken {
  id: string;
  symbol: string;
  name?: string;
  mcap?: number;
  liquidity?: number;
  organicScore?: number;
  launchpad?: string;
  stats5m?: {
    buyVolume?: number;
    sellVolume?: number;
  };
}

interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  labels?: string[];
  baseToken: { address: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  liquidity?: { usd?: number };
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
}

export async function fetchTopPumpTokens(limit: number): Promise<JupiterToken[]> {
  const url = `https://lite-api.jup.ag/tokens/v2/toptraded/5m?limit=${limit}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Jupiter toptraded failed: ${res.status}`);
  const data = (await res.json()) as JupiterToken[];
  return data.filter((t) => t.launchpad === "pump.fun");
}

export async function fetchDexPair(poolAddress: string): Promise<DexPair | null> {
  const url = `https://api.dexscreener.com/latest/dex/pairs/solana/${poolAddress}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const data = (await res.json()) as { pairs?: DexPair[] };
  const pair = data.pairs?.[0];
  if (!pair || pair.dexId !== "meteora") return null;
  if (!pair.labels?.includes("DLMM")) return null;
  return pair;
}

export async function fetchTokenPools(tokenMint: string): Promise<DexPair[]> {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return [];
  const data = (await res.json()) as { pairs?: DexPair[] };
  return (data.pairs ?? []).filter(
    (p) =>
      p.chainId === "solana" &&
      p.dexId === "meteora" &&
      p.labels?.includes("DLMM") &&
      p.quoteToken.symbol === "SOL",
  );
}

export function tokenVolume5m(token: JupiterToken): number {
  const s = token.stats5m;
  return (s?.buyVolume ?? 0) + (s?.sellVolume ?? 0);
}

export async function buildCandidates(tokens: JupiterToken[]): Promise<PoolCandidate[]> {
  const out: PoolCandidate[] = [];

  for (const token of tokens) {
    const pools = await fetchTokenPools(token.id);
    if (!pools.length) continue;

    const best = pools.sort(
      (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
    )[0];
    const liq = best.liquidity?.usd ?? 0;
    if (liq <= 0) continue;

    out.push({
      tokenMint: token.id,
      tokenSymbol: token.symbol,
      poolAddress: best.pairAddress,
      poolName: `${best.baseToken.symbol}-SOL`,
      pairLiquidityUsd: liq,
      tokenLiquidityUsd: token.liquidity ?? liq,
      marketCap: token.mcap ?? best.marketCap ?? best.fdv ?? 0,
      volume5m: tokenVolume5m(token),
      priceUsd: Number(best.priceUsd ?? 0),
      jupiterScore: jupiterScoreFromOrganic(token.organicScore ?? 0),
      venue: "dlmm",
      side: "bid",
      fee30mUsd: 0,
      fee1hUsd: 0,
      volume30mUsd: tokenVolume5m(token) * 6,
      holders: 0,
      createdAtMs: 0,
      freezeDisabled: true,
      solPrice: 0,
      rangeHalfWidth: 0.1,
    });
  }

  return out;
}

export async function fetchOriginalOpportunityChecks(limit = 5) {
  const body = {
    contractAddress: process.env.ORIGINAL_CONTRACT ?? "0xdP4jw5rr0xg48XGP",
    functionName: "getOpportunityChecks",
    inputs: { limit },
    from: "viewer",
  };
  const res = await fetch("https://proofnetwork.lol/api/blockchain/contracts/call", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": UA,
      Referer: "https://proofnetwork.lol/",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ProofNetwork call failed: ${res.status}`);
  const data = (await res.json()) as {
    transaction?: { outputs?: { checks?: Array<Record<string, unknown>> } };
  };
  return data.transaction?.outputs?.checks ?? [];
}