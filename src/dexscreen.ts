/**
 * DexScreener's public API has no trending route. This reads the Solana
 * trending page (6h), then the pair route for each mint. A miss returns nothing.
 */

const SOL_MINT = "So11111111111111111111111111111111111111112";
const PAGE = "https://dexscreener.com/?rankBy=trendingScoreH6&order=desc&chainIds=solana";
const PAGE_READER = "https://r.jina.ai/http://dexscreener.com/?rankBy=trendingScoreH6&order=desc&chainIds=solana";
const PAIR = "https://api.dexscreener.com/latest/dex/pairs/solana/";

interface DexToken {
  address?: string;
}

interface DexPair {
  baseToken?: DexToken;
  quoteToken?: DexToken;
}

/** Pair addresses in page order. The page lowercases them; the pair route still accepts that. */
export function parseDexPairAddresses(text: string, limit = 30): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /dexscreener\.com\/solana\/([a-zA-Z0-9]{32,50})/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) && out.length < limit) {
    const pair = match[1];
    if (seen.has(pair)) continue;
    seen.add(pair);
    out.push(pair);
  }
  return out;
}

async function readText(url: string, userAgent: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "text/plain,text/html", "User-Agent": userAgent },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function readTrendingText(): Promise<string> {
  const direct = await readText(PAGE, "Mozilla/5.0");
  if (direct && parseDexPairAddresses(direct, 30).length >= 5) return direct;
  const via = await readText(PAGE_READER, "degenlp-bot/1.1");
  if (!via) throw new Error("trending unread");
  return via;
}

/** Base mints of the Solana trending list, in rank order. SOL itself is skipped. */
export async function trendingMints(limit = 30): Promise<string[]> {
  const text = await readTrendingText();
  const pairs = parseDexPairAddresses(text, limit);
  if (pairs.length < 5) throw new Error("trending list was short");
  const found: Array<string | undefined> = new Array(pairs.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < pairs.length) {
      const index = cursor;
      cursor += 1;
      const pair = pairs[index];
      try {
        const res = await fetch(`${PAIR}${pair}`, {
          headers: { Accept: "application/json", "User-Agent": "degenlp-bot/1.1" },
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) continue;
        const body = (await res.json()) as { pairs?: DexPair[] };
        const row = body.pairs?.[0];
        let mint = row?.baseToken?.address || "";
        if (mint === SOL_MINT) mint = row?.quoteToken?.address || "";
        if (!mint || mint === SOL_MINT) continue;
        found[index] = mint;
      } catch {
        // One pair missing does not drop the list.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, pairs.length) }, () => worker()));
  const seen = new Set<string>();
  const mints: string[] = [];
  for (const mint of found) {
    if (!mint || seen.has(mint)) continue;
    seen.add(mint);
    mints.push(mint);
  }
  return mints;
}
