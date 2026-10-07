/** Direction changes against net drift. A one-way print has crossings near zero. */

export interface ChopRead {
  samples: number;
  crossings: number;
  netBins: number;
}

export function chopFromPrices(prices: number[], binStep: number): ChopRead {
  const rows = prices.filter((price) => price > 0);
  if (rows.length < 2) return { samples: rows.length, crossings: 0, netBins: 0 };
  let crossings = 0;
  let prevSign = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const delta = rows[i] - rows[i - 1];
    if (delta === 0) continue;
    const sign = delta > 0 ? 1 : -1;
    if (prevSign !== 0 && sign !== prevSign) crossings += 1;
    prevSign = sign;
  }
  const step = Math.max(binStep, 1) / 10_000;
  const net = Math.abs(rows[rows.length - 1] - rows[0]) / rows[0];
  const netBins = step > 0 ? net / step : 0;
  return { samples: rows.length, crossings, netBins };
}

/** Chop dominates the drift. Unknown or one-way tapes are not a seat. */
export function chopShapeOk(read: ChopRead, minSamples = 4, minCrossings = 2): boolean {
  if (read.samples < minSamples || read.crossings < minCrossings) return false;
  return read.crossings >= read.netBins;
}

/** The next minute of flow is smaller than the SOL sitting in the active bin. */
export function depthOk(flowPerMinUsd: number, binSolUsd: number | undefined): boolean {
  if (!(binSolUsd != null && binSolUsd > 0)) return false;
  if (!(flowPerMinUsd >= 0)) return false;
  return flowPerMinUsd < binSolUsd;
}
