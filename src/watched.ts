import { trendingMints } from "./dexscreen.js";
import { fetchSolDlmmByMints } from "./meteora.js";
import type { PoolCandidate } from "./types.js";

const FRESH_MS = 180_000;
const RETRY_MS = 60_000;

let cache: { until: number; pools: PoolCandidate[] } | null = null;
let nextTry = 0;

/**
 * SOL DLMM pools for the current DexScreener Solana trending list.
 * Cached for a few minutes. A failed read keeps the last list and never stops the scan.
 */
export async function watchedMemePools(): Promise<PoolCandidate[]> {
  const now = Date.now();
  if (cache && now < cache.until) return cache.pools;
  if (now < nextTry) return cache?.pools ?? [];
  try {
    const mints = await trendingMints();
    if (mints.length < 5) throw new Error("trending list was short");
    const pools = await fetchSolDlmmByMints(mints);
    cache = { until: now + FRESH_MS, pools };
    return pools;
  } catch {
    console.error("[dex] trending unread");
    nextTry = now + RETRY_MS;
    return cache?.pools ?? [];
  }
}

/**
 * Pin a trending mint's DLMM into the catalog.
 * A mint the fee pages already have is marked, not duplicated.
 * A mint they missed is added and still has to clear the same gates.
 */
export function mergeWatched(catalog: PoolCandidate[], extra: PoolCandidate[]): PoolCandidate[] {
  const out = catalog.map((pool) => ({ ...pool }));
  const byAddr = new Map(out.map((pool) => [pool.poolAddress, pool]));
  for (const pool of extra) {
    if (!pool.poolAddress || !pool.tokenMint || pool.venue !== "dlmm") continue;
    const same = byAddr.get(pool.poolAddress);
    if (same) {
      same.watched = true;
      continue;
    }
    const siblings = out.filter((row) => row.tokenMint === pool.tokenMint && row.venue === "dlmm");
    if (siblings.length) {
      siblings.sort((a, b) => b.fee30mUsd - a.fee30mUsd);
      siblings[0].watched = true;
      continue;
    }
    const row: PoolCandidate = { ...pool, watched: true };
    out.push(row);
    byAddr.set(row.poolAddress, row);
  }
  return out;
}
