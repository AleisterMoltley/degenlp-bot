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

/**
 * A one-bin bid sits under the price. The fill is the slot that steps the
 * active bin onto that id or through it. Hearing it still takes the next slot.
 */
export function bidTouched(activeId: number, maxBinId: number): boolean {
  return Number.isInteger(activeId) && Number.isInteger(maxBinId) && activeId <= maxBinId;
}
