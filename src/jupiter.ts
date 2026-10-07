export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const LIVE_SLIPPAGE_BPS = 300;
export const MAX_PRICE_IMPACT = 0.03;

const JUPITER = "https://lite-api.jup.ag/swap/v1";

export interface SwapQuote {
  outAmount?: string;
  priceImpactPct?: string | number;
  [key: string]: unknown;
}

export function assertSwapQuote(quote: SwapQuote, maxImpact = MAX_PRICE_IMPACT): void {
  let out = 0n;
  try {
    out = BigInt(quote.outAmount || "0");
  } catch {
    out = 0n;
  }
  if (out <= 0n) throw new Error("swap quote was empty");
  const impact = Number(quote.priceImpactPct ?? 0);
  if (!Number.isFinite(impact) || impact < 0 || impact > maxImpact) {
    throw new Error("swap price impact too high");
  }
}

/** Full bag, then smaller slices. A transfer-fee mint and a thin route need the smaller ones. */
export function sellSlices(amount: bigint): bigint[] {
  if (amount <= 0n) return [];
  const slices: bigint[] = [];
  const push = (value: bigint) => {
    if (value > 0n && !slices.includes(value)) slices.push(value);
  };
  push(amount);
  push(amount - 1n);
  for (const pct of [99n, 90n, 50n, 25n, 10n]) push((amount * pct) / 100n);
  return slices;
}

export function quoteFailure(status: number, body: string): string {
  let detail = body.slice(0, 160).replace(/\s+/g, " ").trim();
  try {
    const parsed = JSON.parse(body) as { error?: string; errorCode?: string };
    if (parsed.error) detail = `${parsed.errorCode ?? ""} ${parsed.error}`.trim();
  } catch {
    /* The body was not JSON. Keep the raw snippet. */
  }
  return `swap quote was rejected ${status}${detail ? ` ${detail}` : ""}`;
}

export async function buildJupiterSwap(args: {
  inputMint: string;
  outputMint: string;
  amount: number | bigint;
  userPublicKey: string;
  slippageBps?: number;
  maxImpact?: number;
}): Promise<{ swapTransaction: string; lastValidBlockHeight: number; outAmount: string }> {
  const slippageBps = args.slippageBps ?? LIVE_SLIPPAGE_BPS;
  const quoteUrl = new URL(`${JUPITER}/quote`);
  quoteUrl.searchParams.set("inputMint", args.inputMint);
  quoteUrl.searchParams.set("outputMint", args.outputMint);
  const amount = typeof args.amount === "bigint" ? args.amount.toString() : String(Math.floor(args.amount));
  quoteUrl.searchParams.set("amount", amount);
  quoteUrl.searchParams.set("slippageBps", String(slippageBps));
  const quoteRes = await fetch(quoteUrl, { signal: AbortSignal.timeout(20_000) });
  if (!quoteRes.ok) throw new Error(quoteFailure(quoteRes.status, await quoteRes.text()));
  const quote = (await quoteRes.json()) as SwapQuote;
  assertSwapQuote(quote, args.maxImpact ?? MAX_PRICE_IMPACT);
  const swapRes = await fetch(`${JUPITER}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: args.userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!swapRes.ok) throw new Error("swap build was rejected");
  const built = (await swapRes.json()) as { swapTransaction?: string; lastValidBlockHeight?: number };
  if (!built.swapTransaction) throw new Error("swap build was empty");
  return {
    swapTransaction: built.swapTransaction,
    lastValidBlockHeight: built.lastValidBlockHeight ?? 0,
    outAmount: String(quote.outAmount),
  };
}
