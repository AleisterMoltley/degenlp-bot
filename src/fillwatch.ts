/** LbPair discriminator, then StaticParameters, VariableParameters, and the pair seeds. */
export const LBPAIR_DISCRIMINATOR = [33, 11, 49, 98, 181, 101, 177, 13] as const;
export const LBPAIR_ACTIVE_ID_OFFSET = 76;

/** Active bin id from a raw LbPair account. Null when the account is not a pair. */
export function activeIdFromPool(data: Uint8Array): number | null {
  if (data.byteLength < LBPAIR_ACTIVE_ID_OFFSET + 4) return null;
  for (let i = 0; i < LBPAIR_DISCRIMINATOR.length; i += 1) {
    if (data[i] !== LBPAIR_DISCRIMINATOR[i]) return null;
  }
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getInt32(LBPAIR_ACTIVE_ID_OFFSET, true);
}

/** One batched account read, in the same order as `addresses`. A null account stays unset. */
export function activeIdsFromAccounts(
  addresses: string[],
  infos: Array<{ data: Uint8Array } | null>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < addresses.length; i += 1) {
    const info = infos[i];
    if (!info) continue;
    const id = activeIdFromPool(info.data);
    if (id == null || !Number.isInteger(id)) continue;
    out.set(addresses[i], id);
  }
  return out;
}

/**
 * The active id has reached this bid. For a deposit that already sits in the
 * active bin, that is the open, not the fill. The fill is meme in the position.
 */
export function bidTouched(activeId: number, maxBinId: number): boolean {
  return Number.isInteger(activeId) && Number.isInteger(maxBinId) && activeId <= maxBinId;
}

export type BidCycle = "wait" | "earn" | "hold" | "rest" | "chase" | "leave" | "scratch";

/**
 * One-bin SOL deposit in the active bin. Fees are paid by the bin a swap uses.
 * On our bin, still SOL: earn. Do not mark that as a fill.
 * On our bin, meme in the position: hold. The reverse swap turns it back into SOL.
 * One bin above, still SOL: chase. The deposit is stale and the next sell misses it.
 * One bin above, meme still in: rest. Do not slide the meme up.
 * Two or more bins above: leave. That is a runner, not a one-bin step.
 * Below the bin: scratch.
 */
export function bidCycle(
  activeId: number,
  minBinId: number,
  maxBinId: number,
  seenFill: boolean,
): BidCycle {
  if (!Number.isInteger(activeId) || !Number.isInteger(minBinId) || !Number.isInteger(maxBinId)) {
    return "wait";
  }
  if (activeId < minBinId) return "scratch";
  if (activeId > maxBinId + 1) return "leave";
  if (activeId > maxBinId) return seenFill ? "rest" : "chase";
  return seenFill ? "hold" : "earn";
}

/** Price stand-in when the scan has no bin id. Past the bid, short of a clean two-bin break. */
export function dipThrough(price: number, entry: number, binStep: number): boolean {
  if (!(price > 0) || !(entry > 0)) return false;
  const step = Math.max(binStep, 1) / 10_000;
  return price <= entry * (1 - step * 1.5);
}

/**
 * A filled bin is worth a market sell only once the move beats the unwind
 * plus the fee the reverse swap would pay in the same bin. Standard DLMM
 * pays the LP 90% of a fee that itself caps at 10%. Inside the unwind,
 * the sell locks slippage and skips that fee.
 */
export function filledSellClears(
  binsUp: number,
  binStep: number,
  unwindBps = 300,
  feePct = 0,
): boolean {
  if (!(binsUp > 1) || !(binStep > 0) || !(unwindBps > 0)) return false;
  const step = Math.max(binStep, 1) / 10_000;
  const keep = Math.min(0.1, Math.max(0, feePct)) * 0.9;
  return binsUp * step > unwindBps / 10_000 + keep;
}

/**
 * Never sell inside the unwind. Past it, sell when the move also clears the
 * fee, or when the chop that was supposed to come back has died.
 */
export function filledShouldSell(args: {
  binsUp: number;
  binStep: number;
  unwindBps?: number;
  feePct?: number;
  chopAlive: boolean;
}): boolean {
  const unwind = args.unwindBps ?? 300;
  const pastUnwind = filledSellClears(args.binsUp, args.binStep, unwind, 0);
  if (!pastUnwind) return false;
  if (filledSellClears(args.binsUp, args.binStep, unwind, args.feePct ?? 0)) return true;
  return !args.chopAlive;
}

/** The price ran more than one bin above the entry, so this bid is no longer the next sell. */
export function bidLeftBehind(price: number, entry: number, binStep: number): boolean {
  if (!(price > 0) || !(entry > 0)) return false;
  const step = Math.max(binStep, 1) / 10_000;
  return price >= entry * (1 + step * 1.5);
}

/** How many bins the price has risen above the entry. Negative means it fell. */
export function binsAboveEntry(price: number, entry: number, binStep: number): number {
  if (!(price > 0) || !(entry > 0)) return 0;
  const step = Math.max(binStep, 1) / 10_000;
  return (price / entry - 1) / step;
}

/** A SOL bid may step up a few times. After that it is chasing. */
export const MAX_BID_SLIDES = 3;

/**
 * The bid is still SOL and the price has left its bin, short of a runner.
 * One step can land back in the active bin. Meme in the position does not slide.
 */
export function slideInstead(binsUp: number, filled: boolean, slides: number, chopConfirmed: boolean): boolean {
  if (filled || !chopConfirmed || slides >= MAX_BID_SLIDES) return false;
  return binsUp >= 1 - 1e-6 && binsUp <= 2.5;
}

/**
 * The chain active bin is exactly one above a SOL bid.
 * The next deposit is that active bin. Two bins above is a runner and does not slide.
 */
export function slideIntoActive(
  activeId: number,
  maxBinId: number,
  filled: boolean,
  slides: number,
  chopConfirmed: boolean,
): boolean {
  if (filled || !chopConfirmed || slides >= MAX_BID_SLIDES) return false;
  if (!Number.isInteger(activeId) || !Number.isInteger(maxBinId)) return false;
  return activeId === maxBinId + 1;
}
