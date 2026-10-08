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

export type BidCycle = "wait" | "hold" | "bank" | "scratch";

/**
 * One-bin SOL bid.
 * Above the bin, still untouched: wait.
 * On the bin: hold. The pool's reverse swap is the exit.
 * Back above after a fill: bank. The position is SOL again.
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
  if (activeId > maxBinId) return seenFill ? "bank" : "wait";
  return "hold";
}

/** Price stand-in when the scan has no bin id. Past the bid, short of a clean two-bin break. */
export function dipThrough(price: number, entry: number, binStep: number): boolean {
  if (!(price > 0) || !(entry > 0)) return false;
  const step = Math.max(binStep, 1) / 10_000;
  return price <= entry * (1 - step * 1.5);
}
