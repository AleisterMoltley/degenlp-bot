import { config } from "./config.js";
import { halfWidthFromBins } from "./pnl.js";
import type { LpSide, PoolCandidate, PoolVenue } from "./types.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const UA = "degenlp-bot/1.1";

const MAJOR_SYMBOLS = new Set([
  "SOL",
  "WSOL",
  "USDC",
  "USDT",
  "USD1",
  "PYUSD",
  "USDS",
  "USDH",
  "UXD",
  "JITOSOL",
  "MSOL",
  "BSOL",
  "JUPSOL",
  "INF",
  "JUP",
  "JTO",
  "RAY",
  "KMNO",
  "MET",
  "WBTC",
  "WETH",
  "ETH",
  "ZEC",
  "HYPE",
  "WNEAR",
  "NEAR",
  "PUMP",
  "BTC",
  "CBBTC",
  "TBTC",
]);

/** Quote assets and large caps. Memecoins are not in this set. */
export function isMajorSymbol(symbol: string): boolean {
  return MAJOR_SYMBOLS.has(symbol.trim().toUpperCase());
}

interface ApiToken {
  address: string;
  symbol: string;
  price?: number;
  market_cap?: number;
  holders?: number;
  freeze_authority_disabled?: boolean;
  is_verified?: boolean;
}

interface Window {
  "30m"?: number;
  "1h"?: number;
}

interface ApiPool {
  address?: string;
  name?: string;
  created_at?: number;
  tvl?: number;
  current_price?: number;
  is_blacklisted?: boolean;
  token_x?: ApiToken;
  token_y?: ApiToken;
  pool_config?: {
    bin_step?: number;
    base_fee_pct?: number;
    min_price?: number;
    max_price?: number;
    concentrated_liquidity?: boolean;
  };
  fees?: Window;
  volume?: Window;
}

interface DammV1Pool {
  pool_address?: string;
  pool_name?: string;
  pool_tvl?: string | number;
  trading_volume?: number;
  fee_volume?: number;
  pool_token_mints?: string[];
  pool_token_amounts?: string[];
  pool_token_usd_amounts?: string[];
  created_at?: number;
}

function enabled(venue: PoolVenue): boolean {
  return config.venues.includes(venue);
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return (await res.json()) as T;
}

function createdMs(raw: number | undefined): number {
  if (!raw || raw <= 0) return 0;
  return raw < 1e12 ? raw * 1000 : raw;
}

function fromApiPool(pool: ApiPool, venue: PoolVenue): PoolCandidate | null {
  if (!pool.address || pool.is_blacklisted) return null;
  const x = pool.token_x;
  const y = pool.token_y;
  if (!x?.address || !y?.address) return null;

  const solOnY = y.address === SOL_MINT;
  const solOnX = x.address === SOL_MINT;
  if (!solOnY && !solOnX) return null;

  const meme = solOnY ? x : y;
  const sol = solOnY ? y : x;
  const symbol = (meme.symbol || "").toUpperCase();
  if (!symbol || isMajorSymbol(symbol)) return null;
  const freezeDisabled = meme.freeze_authority_disabled !== false;
  if (!freezeDisabled) return null;

  const tvl = pool.tvl ?? 0;
  if (tvl <= 0) return null;

  const fee30m = pool.fees?.["30m"] ?? 0;
  const fee1h = pool.fees?.["1h"] ?? fee30m * 2;
  const volume30m = pool.volume?.["30m"] ?? 0;
  const binStep = pool.pool_config?.bin_step ?? 0;
  const priceUsd = meme.price ?? 0;
  if (priceUsd <= 0) return null;

  const current = pool.current_price ?? 0;
  const minPrice = pool.pool_config?.min_price ?? 0;
  const maxPrice = pool.pool_config?.max_price ?? 0;
  let side: LpSide = venue === "dlmm" ? "bid" : "full";
  let rangeHalfWidth = venue === "dlmm" ? halfWidthFromBins(binStep || 80, config.scalpBins) : 0.5;

  if (venue !== "dlmm" && current > 0 && minPrice > 0 && maxPrice > current) {
    const up = maxPrice / current - 1;
    const down = 1 - minPrice / current;
    if (up > 0 && up < 0.5 && down > 0 && down < 0.5) {
      side = "range";
      rangeHalfWidth = Math.min(0.45, Math.max(up, down));
    }
  }

  return {
    tokenMint: meme.address,
    tokenSymbol: meme.symbol,
    poolAddress: pool.address,
    poolName: pool.name || `${meme.symbol}-SOL`,
    pairLiquidityUsd: tvl,
    tokenLiquidityUsd: tvl,
    marketCap: meme.market_cap ?? 0,
    volume5m: volume30m / 6,
    priceUsd,
    binStep: binStep || undefined,
    baseFeePct: (pool.pool_config?.base_fee_pct ?? 0) / 100,
    jupiterScore: Math.min(92, Math.round((meme.holders ?? 0) / 40)),
    venue,
    side,
    fee30mUsd: fee30m,
    fee1hUsd: fee1h,
    volume30mUsd: volume30m,
    holders: meme.holders ?? 0,
    createdAtMs: createdMs(pool.created_at),
    freezeDisabled,
    solPrice: sol.price ?? 0,
    rangeHalfWidth,
  };
}

function fromDammV1(pool: DammV1Pool): PoolCandidate | null {
  const mints = pool.pool_token_mints ?? [];
  const solIdx = mints.indexOf(SOL_MINT);
  if (solIdx < 0 || mints.length < 2) return null;
  const memeIdx = solIdx === 0 ? 1 : 0;
  const name = pool.pool_name || "";
  const parts = name.split("-");
  const memeSymbol = (parts[memeIdx] || parts[0] || "MEME").toUpperCase();
  if (isMajorSymbol(memeSymbol)) return null;

  const tvl = Number(pool.pool_tvl ?? 0);
  const usd = Number(pool.pool_token_usd_amounts?.[memeIdx] ?? 0);
  const amt = Number(pool.pool_token_amounts?.[memeIdx] ?? 0);
  const solUsd = Number(pool.pool_token_usd_amounts?.[solIdx] ?? 0);
  const solAmt = Number(pool.pool_token_amounts?.[solIdx] ?? 0);
  const priceUsd = amt > 0 ? usd / amt : 0;
  const solPrice = solAmt > 0 ? solUsd / solAmt : 0;
  if (tvl <= 0 || priceUsd <= 0) return null;

  // DAMM v1 publishes day volume and day fees, not a 30m window.
  const fee30m = (pool.fee_volume ?? 0) / 48;
  const volume30m = (pool.trading_volume ?? 0) / 48;

  return {
    tokenMint: mints[memeIdx] ?? "",
    tokenSymbol: memeSymbol,
    poolAddress: pool.pool_address ?? "",
    poolName: name || `${memeSymbol}-SOL`,
    pairLiquidityUsd: tvl,
    tokenLiquidityUsd: tvl,
    marketCap: 0,
    volume5m: volume30m / 6,
    priceUsd,
    baseFeePct: volume30m > 0 ? fee30m / volume30m : undefined,
    jupiterScore: 60,
    venue: "damm_v1",
    side: "full",
    fee30mUsd: fee30m,
    fee1hUsd: fee30m * 2,
    volume30mUsd: volume30m,
    holders: 0,
    createdAtMs: createdMs(pool.created_at),
    freezeDisabled: true,
    solPrice,
    rangeHalfWidth: 0.5,
  };
}

function dedupe(rows: PoolCandidate[]): PoolCandidate[] {
  const seen = new Set<string>();
  const out: PoolCandidate[] = [];
  for (const row of rows) {
    if (!row.poolAddress || seen.has(row.poolAddress)) continue;
    seen.add(row.poolAddress);
    out.push(row);
  }
  return out;
}

async function fetchApiPages(
  venue: "dlmm" | "damm_v2",
  host: string,
): Promise<PoolCandidate[]> {
  const filter = `is_blacklisted=false && tvl>=${config.minPairLiquidityUsd} && tvl<=${config.maxPairLiquidityUsd}`;
  // Absolute fees surface large pools. Fee/TVL surfaces the dense pools a small seat actually earns.
  const queries = [1, 2].flatMap((page) =>
    ["fee_30m:desc", "fee_tvl_ratio_30m:desc"].map((sort) => ({ page, sort })),
  );
  const pages = await Promise.allSettled(
    queries.map(async ({ page, sort }) => {
      const url =
        `${host}/pools?` +
        new URLSearchParams({
          page: String(page),
          page_size: "100",
          sort_by: sort,
          filter_by: filter,
        });
      const body = await getJson<{ data?: ApiPool[] }>(url);
      return (body.data ?? []).map((pool) => fromApiPool(pool, venue)).filter((pool): pool is PoolCandidate => !!pool);
    }),
  );
  const rows = pages.flatMap((page) => (page.status === "fulfilled" ? page.value : []));
  if (!rows.length && pages.every((page) => page.status === "rejected")) {
    const failed = pages.find((page) => page.status === "rejected") as PromiseRejectedResult;
    throw failed.reason;
  }
  return dedupe(rows);
}

async function fetchDlmm(): Promise<PoolCandidate[]> {
  return fetchApiPages("dlmm", "https://dlmm.datapi.meteora.ag");
}

async function fetchDammV2(): Promise<PoolCandidate[]> {
  return fetchApiPages("damm_v2", "https://damm-v2.datapi.meteora.ag");
}

async function fetchDammV1(): Promise<PoolCandidate[]> {
  const pages = await Promise.allSettled(
    [0, 1, 2].map(async (page) => {
      const url =
        "https://damm-api.meteora.ag/pools/search?" +
        new URLSearchParams({
          page: String(page),
          size: "50",
          sort_key: "volume",
          order_by: "desc",
          hide_low_tvl: String(config.minPairLiquidityUsd),
        });
      const body = await getJson<{ data?: DammV1Pool[] }>(url);
      return (body.data ?? [])
        .map(fromDammV1)
        .filter((pool): pool is PoolCandidate => !!pool && pool.pairLiquidityUsd <= config.maxPairLiquidityUsd);
    }),
  );
  const rows = pages.flatMap((page) => (page.status === "fulfilled" ? page.value : []));
  if (!rows.length && pages.every((page) => page.status === "rejected")) {
    const failed = pages.find((page) => page.status === "rejected") as PromiseRejectedResult;
    throw failed.reason;
  }
  return dedupe(rows);
}

export async function fetchMeteoraCandidates(): Promise<PoolCandidate[]> {
  const jobs: Array<Promise<PoolCandidate[]>> = [];
  if (enabled("dlmm")) jobs.push(fetchDlmm());
  if (enabled("damm_v2")) jobs.push(fetchDammV2());
  if (enabled("damm_v1")) jobs.push(fetchDammV1());

  const settled = await Promise.allSettled(jobs);
  const out: PoolCandidate[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") out.push(...result.value);
    else console.error("[pools]", result.reason instanceof Error ? result.reason.message : result.reason);
  }
  if (!out.length && settled.every((r) => r.status === "rejected")) {
    throw new Error("all Meteora pool feeds failed");
  }
  return out;
}

/** Below this, a watched pool is an empty shell. The open gate stays higher. */
const WATCH_MIN_TVL_USD = 1_000;

/** Hottest SOL DLMM for one mint. Dust under $1,000 is left out. */
export function bestSolDlmm(pools: PoolCandidate[]): PoolCandidate | null {
  const fit = pools.filter((pool) => pool.venue === "dlmm" && pool.pairLiquidityUsd >= WATCH_MIN_TVL_USD);
  fit.sort((a, b) => b.fee30mUsd - a.fee30mUsd);
  return fit[0] ?? null;
}

/** SOL DLMM for mints the fee pages can miss. One pool per mint. A failed mint is skipped. */
export async function fetchSolDlmmByMints(mints: string[]): Promise<PoolCandidate[]> {
  const unique = [...new Set(mints.map((mint) => mint.trim()).filter(Boolean))];
  const out: PoolCandidate[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < unique.length) {
      const mint = unique[cursor];
      cursor += 1;
      try {
        const url =
          "https://dlmm.datapi.meteora.ag/pools?" +
          new URLSearchParams({ page: "1", page_size: "30", query: mint });
        const body = await getJson<{ data?: ApiPool[] }>(url);
        const rows = (body.data ?? [])
          .map((pool) => fromApiPool(pool, "dlmm"))
          .filter((pool): pool is PoolCandidate => !!pool && pool.tokenMint === mint);
        const best = bestSolDlmm(rows);
        if (best) out.push(best);
      } catch {
        // One mint missing does not drop the rest of the list.
      }
    }
  }
  const workers = Math.min(8, unique.length);
  if (workers > 0) await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}
