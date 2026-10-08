export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const LIVE_SLIPPAGE_BPS = 300;
export const MAX_PRICE_IMPACT = 0.03;

/**
 * Unwind attempts, tight first. A route that needs more than 8% impact is not
 * a salvage: filling it locks a loss the bin price did not have.
 */
export const UNWIND_ATTEMPTS = [
  { slippageBps: 300, maxImpact: 0.03 },
  { slippageBps: 800, maxImpact: 0.08 },
] as const;

/**
 * Worst SOL the route can return after its slippage. The quote's outAmount is
 * the ideal fill. The transaction may land this far under it.
 */
export function minOutLamports(outAmount: bigint, slippageBps: number): bigint {
  if (outAmount <= 0n) return 0n;
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.floor(slippageBps))));
  return (outAmount * (10_000n - bps)) / 10_000n;
}

/**
 * SOL that was converted to meme and has to come back before a swap is sent.
 * A missing fraction on a fill is the whole seat. An unfilled bid has no floor.
 * Clearing the floor is not a profit: the transactions are still paid, and a
 * quote that never clears can leave the meme to go to zero.
 */
export function depositFloorLamports(solDeployed: number, filled: boolean, fillFraction?: number): bigint {
  if (!filled || !(solDeployed > 0) || !Number.isFinite(solDeployed)) return 0n;
  const frac = fillFraction == null || !Number.isFinite(fillFraction) ? 1 : Math.min(1, Math.max(0, fillFraction));
  if (!(frac > 0)) return 0n;
  return BigInt(Math.floor(solDeployed * frac * 1e9));
}

/** True when the worst fill still returns the converted SOL. No floor means an unknown bag. */
export function outClearsDeposit(minOut: bigint, deployedLamports: bigint): boolean {
  if (deployedLamports <= 0n) return true;
  return minOut >= deployedLamports;
}

/**
 * A filled withdraw whose unwind is under the converted SOL pulls the meme
 * into the wallet, where the next buy pays someone else. Stay in the bin when
 * the bag is real and the best worst-case is missing or short of that SOL.
 * Dust is SOL again, and an unfilled bid has no floor. Clearing the floor is
 * not a profit: the transactions are still paid.
 */
export function filledLpStays(
  memeRaw: bigint,
  worstOut: bigint | null,
  floorLamports: bigint,
  dustRaw = 10_000n,
): boolean {
  if (floorLamports <= 0n) return false;
  if (memeRaw <= dustRaw) return false;
  if (worstOut == null) return true;
  return !outClearsDeposit(worstOut, floorLamports);
}

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

/** Ideal SOL out for a meme bag. Does not build a swap. */
export async function quoteJupiterOut(args: {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
  maxImpact: number;
}): Promise<bigint> {
  if (args.amount <= 0n) throw new Error("swap quote was empty");
  const quoteUrl = new URL(`${JUPITER}/quote`);
  quoteUrl.searchParams.set("inputMint", args.inputMint);
  quoteUrl.searchParams.set("outputMint", args.outputMint);
  quoteUrl.searchParams.set("amount", args.amount.toString());
  quoteUrl.searchParams.set("slippageBps", String(args.slippageBps));
  const quoteRes = await fetch(quoteUrl, { signal: AbortSignal.timeout(8_000) });
  if (!quoteRes.ok) throw new Error(quoteFailure(quoteRes.status, await quoteRes.text()));
  const quote = (await quoteRes.json()) as SwapQuote;
  assertSwapQuote(quote, args.maxImpact);
  const out = BigInt(quote.outAmount || "0");
  if (out <= 0n) throw new Error("swap quote was empty");
  return out;
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
