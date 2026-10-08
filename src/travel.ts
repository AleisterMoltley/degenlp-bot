/** Active-bin steps before a deposit. Fee dollars are not a rank. */

export interface BinTapeRead {
  samples: number;
  spanMs: number;
  crossings: number;
  netBins: number;
  maxStep: number;
  /** 1 up, -1 down, 0 flat. The last completed step. Micro-chop shape does not read it. */
  lastStep?: number;
}

export function binTapeFromIds(
  rows: Array<{ at: number; id: number }>,
  now: number,
  windowMs: number,
): BinTapeRead {
  const inside = rows.filter((row) => now - row.at <= windowMs && Number.isInteger(row.id));
  if (inside.length < 2) {
    return { samples: inside.length, spanMs: 0, crossings: 0, netBins: 0, maxStep: 0, lastStep: 0 };
  }
  let crossings = 0;
  let prevSign = 0;
  let maxStep = 0;
  let lastStep = 0;
  for (let i = 1; i < inside.length; i += 1) {
    const delta = inside[i].id - inside[i - 1].id;
    if (delta === 0) continue;
    maxStep = Math.max(maxStep, Math.abs(delta));
    const sign = delta > 0 ? 1 : -1;
    if (prevSign !== 0 && sign !== prevSign) crossings += 1;
    prevSign = sign;
    lastStep = sign;
  }
  return {
    samples: inside.length,
    spanMs: inside[inside.length - 1].at - inside[0].at,
    crossings,
    netBins: Math.abs(inside[inside.length - 1].id - inside[0].id),
    maxStep,
    lastStep,
  };
}

/**
 * About a minute of steps no bigger than one bin, and no one-way run.
 * A flat active id is in-bin flow. That is where the fee is paid, so crossings may be zero.
 * A jump, a missing tape, or a net move of more than one bin is not a seat.
 */
export function microChopOk(read: BinTapeRead, minSpanMs = 45_000, minSamples = 8): boolean {
  if (read.samples < minSamples || read.spanMs < minSpanMs) return false;
  if (!(read.maxStep <= 1)) return false;
  if (read.netBins > 1) return false;
  return read.crossings >= read.netBins;
}

/** Base fee has to clear one bin of adverse move plus the unwind. */
export function feeRateClears(baseFeePct: number, binStep: number, unwindBps: number): boolean {
  if (!(baseFeePct > 0) || !(unwindBps >= 0)) return false;
  const toll = Math.max(binStep, 1) / 10_000 + unwindBps / 10_000;
  return baseFeePct > toll;
}

/** Paper stand-in for the chain active id. Live reads the account and does not use this. */
export function priceBinId(price: number, binStep: number): number | null {
  if (!(price > 0) || !(binStep > 0)) return null;
  const id = Math.round(Math.log(price) / Math.log(1 + binStep / 10_000));
  return Number.isFinite(id) ? id : null;
}

/** Higher base fee and less bin travel rank first. A big 30-minute fee print does not. */
export function feePerBin(pool: { baseFeePct?: number; binTapeNet?: number }): number {
  const fee = pool.baseFeePct ?? 0;
  if (!(fee > 0)) return 0;
  const net = pool.binTapeNet != null && pool.binTapeNet >= 0 ? pool.binTapeNet : Number.POSITIVE_INFINITY;
  return fee / Math.max(net, 0.25);
}

const THROUGH = /scratch|tape turned|divergence|risk budget|left the range|left the fee list|bid left behind|chop ended/;

/** Sleep the mint after a run-through. A dust atom still inside the bin can be checked again. */
export function mintShouldSleep(reason: string, activeId: number | undefined, minBinId: number): boolean {
  if (activeId != null && activeId < minBinId) return true;
  return THROUGH.test(reason);
}
