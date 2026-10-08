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
 * A one-bin bid sits under the price. The fill is the slot that steps the
 * active bin onto that id or through it. Hearing it still takes the next slot.
 */
export function bidTouched(activeId: number, maxBinId: number): boolean {
  return Number.isInteger(activeId) && Number.isInteger(maxBinId) && activeId <= maxBinId;
}

export type BidCycle = "wait" | "hold" | "rest" | "leave" | "scratch";

/**
 * One-bin SOL bid.
 * Above the bin, still untouched: wait.
 * On the bin: hold. The pool's reverse swap turns the meme back into SOL.
 * One bin above after a fill: rest. The bid is SOL again and can fill again.
 * Two or more bins above: leave. The bid is no longer the next sell.
 * Below the bin: scratch. The reverse swap did not come.
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
  if (activeId > maxBinId) return seenFill ? "rest" : "wait";
  return "hold";
}

/** Price stand-in when the scan has no bin id. Past the bid, short of a clean two-bin break. */
export function dipThrough(price: number, entry: number, binStep: number): boolean {
  if (!(price > 0) || !(entry > 0)) return false;
  const step = Math.max(binStep, 1) / 10_000;
  return price <= entry * (1 - step * 1.5);
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
 * The bid is SOL and the price is only about two bins above it.
 * One step up puts it under the next sell. A runner, a dead chop, or meme still in the bin does not slide.
 */
export function slideInstead(binsUp: number, filled: boolean, slides: number, chopConfirmed: boolean): boolean {
  if (filled || !chopConfirmed || slides >= MAX_BID_SLIDES) return false;
  return binsUp >= 1.5 - 1e-6 && binsUp <= 2.5;
}

/** Chain id version. Rest is one bin above. The next bin can slide. Anything farther leaves. */
export function slideInsteadOfLeave(
  activeId: number,
  maxBinId: number,
  filled: boolean,
  slides: number,
  chopConfirmed: boolean,
): boolean {
  if (filled || !chopConfirmed || slides >= MAX_BID_SLIDES) return false;
  if (!Number.isInteger(activeId) || !Number.isInteger(maxBinId)) return false;
  return activeId === maxBinId + 2;
}
