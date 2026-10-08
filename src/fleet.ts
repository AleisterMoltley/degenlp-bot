import { chopShapeOk, depthOk } from "./chop.js";
import { config } from "./config.js";
import { bankableUsd, trailGaveBack } from "./edge.js";
import { halfWidthFromBins, markIlUsd } from "./pnl.js";
import { bidLeftBehind, binsAboveEntry, dipThrough, MAX_BID_SLIDES, slideInstead } from "./fillwatch.js";
import { feePerBin, feeRateClears, microChopOk } from "./travel.js";
import { computeMetrics, planPosition, rankPools, type Metrics } from "./scorer.js";
import type { ActivePosition, BotDecision, PoolCandidate } from "./types.js";

export type SeatStrategy = "skim" | "core";

export interface FleetOpen {
  pool: PoolCandidate;
  metrics: Metrics;
  solDeploy: number;
  strategy: SeatStrategy;
  reason: string;
}

export interface FleetClose {
  id: string;
  action: BotDecision;
  reason: string;
}

export interface FleetHold {
  id: string;
  reason: string;
}

export interface FleetSlide {
  id: string;
  reason: string;
}

export interface FleetPreview {
  poolAddress: string;
  poolName: string;
  tokenSymbol: string;
  venue: string;
  side: string;
  strategy: string;
  opportunityScore: number;
  edgeUsd: number;
  fee30m: number;
  /** Collected 30-minute fees divided by pool TVL. */
  feeToTvl: number;
  binStep: number;
  baseFeePct: number;
  /** Minutes since the pool was created. 0 when the feed has no age. */
  ageMin: number;
  metThreshold: boolean;
  watched?: boolean;
}

export interface FleetPlan {
  closes: FleetClose[];
  opens: FleetOpen[];
  holds: FleetHold[];
  slides: FleetSlide[];
  preview: FleetPreview[];
  summary: string;
}

const COOL_RE = /divergence|edge gone|left the range|left the fee list|risk budget|scratch|skim window closed|tape turned/;

export function coolsOff(reason: string): boolean {
  return COOL_RE.test(reason);
}

/** One bin of a bid, then the unwind back to SOL. A recent drop is charged again so a stale fee print cannot ignore it. */
export function skimFillFraction(
  binStep: number | undefined,
  bins = config.scalpBins,
  unwindBps = Math.max(config.swapBps, 300),
  realizedDrop = 0,
): number {
  const step = Math.max(binStep ?? 80, 1) / 10_000;
  const slice = 1 / Math.max(bins, 1);
  const touch = 0.5 * step * slice + (unwindBps / 10_000) * slice;
  const repeat = Math.max(0, realizedDrop) * slice;
  return Math.min(0.04, Math.max(0.003, touch, repeat));
}

/** How far price fell from its peak inside the window. 0.05 means 5%. */
export function downwardMove(
  samples: Array<{ at: number; price: number }> | undefined,
  now: number,
  windowMs: number,
): number {
  if (!samples || samples.length < 2) return 0;
  const rows = samples.filter((row) => now - row.at <= windowMs && row.price > 0);
  if (rows.length < 2) return 0;
  const peak = Math.max(...rows.map((row) => row.price));
  const last = rows[rows.length - 1].price;
  if (peak <= 0 || last <= 0 || last >= peak) return 0;
  return (peak - last) / peak;
}

function dropOf(pool: PoolCandidate, moves?: Record<string, number>): number {
  const raw = moves?.[pool.poolAddress] ?? 0;
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function tapeBlocksEntry(pool: PoolCandidate, moves?: Record<string, number>): boolean {
  if ((pool.binStep ?? 0) > config.fleetMaxBinStep) return true;
  const step = Math.max(pool.binStep ?? 80, 1) / 10_000;
  return dropOf(pool, moves) >= Math.max(step * 1.5, 0.015);
}

function floorSol(value: number): number {
  return Math.floor(Math.max(value, 0) * 1e6) / 1e6;
}

function isSkim(seat: ActivePosition): boolean {
  return seat.strategy === "skim";
}

const SNIPE_BINS = 1;

const UNWIND_BPS = Math.max(config.swapBps, 300);

function chopBlocks(pool: PoolCandidate): boolean {
  if (pool.venue !== "dlmm") return false;
  const shape = chopShapeOk({
    samples: pool.chopSamples ?? 0,
    crossings: pool.chopCrossings ?? 0,
    netBins: pool.chopNetBins ?? Number.POSITIVE_INFINITY,
  });
  const depth = depthOk(pool.volume30mUsd / 30, pool.binSolUsd);
  return !shape || !depth;
}

function geometryBlocks(pool: PoolCandidate): boolean {
  if (pool.venue !== "dlmm") return false;
  return !feeRateClears(pool.baseFeePct ?? 0, pool.binStep ?? 80, UNWIND_BPS);
}

function travelBlocks(pool: PoolCandidate): boolean {
  if (pool.venue !== "dlmm") return false;
  return !microChopOk({
    samples: pool.binTapeSamples ?? 0,
    spanMs: pool.binTapeSpanMs ?? 0,
    crossings: pool.binTapeCrossings ?? 0,
    netBins: pool.binTapeNet ?? Number.POSITIVE_INFINITY,
    maxStep: pool.binTapeMaxStep ?? Number.POSITIVE_INFINITY,
  });
}

function entryBlocked(pool: PoolCandidate): boolean {
  return geometryBlocks(pool) || travelBlocks(pool) || chopBlocks(pool);
}

function skimQuote(
  pool: PoolCandidate,
  sol: number,
  moves?: Record<string, number>,
): { pool: PoolCandidate; metrics: Metrics } {
  const copy: PoolCandidate = {
    ...pool,
    side: "bid",
    rangeHalfWidth: halfWidthFromBins(pool.binStep ?? 80, SNIPE_BINS),
  };
  const metrics = computeMetrics(copy, sol, true, {
    holdMin: config.fleetHoldMin,
    fillFraction: skimFillFraction(pool.binStep, SNIPE_BINS, UNWIND_BPS, dropOf(pool, moves)),
    swapBps: 0,
    lockSide: true,
    fillFee: true,
  });
  return { pool: copy, metrics };
}

function feeToTvl(pool: PoolCandidate): number {
  return pool.fee30mUsd / Math.max(pool.pairLiquidityUsd, 1);
}

/** One DLMM per coin. The hotter fee/TVL sibling stays, and a watched flag survives. */
function onePoolPerMint(pools: PoolCandidate[]): PoolCandidate[] {
  const best = new Map<string, PoolCandidate>();
  for (const pool of pools) {
    const key = pool.tokenMint || pool.poolAddress;
    const have = best.get(key);
    if (!have || feeToTvl(pool) > feeToTvl(have)) {
      best.set(key, pool.watched || have?.watched ? { ...pool, watched: true } : pool);
    } else if (pool.watched && !have.watched) {
      best.set(key, { ...have, watched: true });
    }
  }
  return [...best.values()];
}

function pickSkims(
  pools: PoolCandidate[],
  budget: number,
  blocked: Set<string>,
  moves: Record<string, number> | undefined,
  seatCap: number,
  seatedMints: Set<string>,
): FleetOpen[] {
  // Quote every sibling. Fee/TVL picks the row on the gate. It must not drop
  // a thinner pool of the same coin that is the one the cost quote accepts.
  const ranked = pools.filter(
    (pool) =>
      pool.venue === "dlmm" &&
      !blocked.has(pool.poolAddress) &&
      !seatedMints.has(pool.tokenMint) &&
      !tapeBlocksEntry(pool, moves) &&
      !entryBlocked(pool),
  );
  if (budget < config.fleetMinSlot || seatCap < config.fleetMinSlot || !ranked.length) return [];
  const maxSeats = Math.max(1, Math.floor(config.fleetSlots));
  for (let n = maxSeats; n >= 1; n -= 1) {
    const slot = Math.min(floorSol(budget / n), seatCap);
    if (slot < config.fleetMinSlot) continue;
    const byMint = new Map<string, { pool: PoolCandidate; metrics: Metrics }>();
    for (const pool of ranked) {
      const quoted = skimQuote(pool, slot, moves);
      if (!quoted.metrics.metThreshold || quoted.metrics.edgeUsd <= 0) continue;
      const key = pool.tokenMint || pool.poolAddress;
      const have = byMint.get(key);
      const better =
        !have ||
        feePerBin(quoted.pool) > feePerBin(have.pool) ||
        (feePerBin(quoted.pool) === feePerBin(have.pool) && quoted.metrics.edgeUsd > have.metrics.edgeUsd);
      if (better) byMint.set(key, quoted);
    }
    const pass = [...byMint.values()].sort(
      (a, b) => feePerBin(b.pool) - feePerBin(a.pool) || b.metrics.edgeUsd - a.metrics.edgeUsd,
    );
    if (pass.length < n) continue;
    return pass.slice(0, n).map((row) => ({
      pool: row.pool,
      metrics: row.metrics,
      solDeploy: slot,
      strategy: "skim" as const,
      reason: `skim edge $${row.metrics.edgeUsd.toFixed(3)} after costs`,
    }));
  }
  return [];
}

function seatIl(seat: ActivePosition, pool: PoolCandidate | undefined, price: number): number {
  const sol = pool?.solPrice || seat.solPrice || 0;
  const deployUsd = seat.solDeployed * sol;
  if (deployUsd <= 0) return seat.ilUsd;
  return markIlUsd({
    deployUsd,
    entryPrice: seat.entryPrice,
    price,
    lower: seat.priceLower,
    upper: seat.priceUpper,
    side: seat.side,
  });
}

/** A mature tape that stopped reversing is a dead chop. A short tape is not. */
function chopStillPays(pool: PoolCandidate): boolean {
  const priceReady = (pool.chopSamples ?? 0) >= 4;
  const priceOk =
    !priceReady ||
    chopShapeOk({
      samples: pool.chopSamples ?? 0,
      crossings: pool.chopCrossings ?? 0,
      netBins: pool.chopNetBins ?? 0,
    });
  const binReady = (pool.binTapeSamples ?? 0) >= 8 && (pool.binTapeSpanMs ?? 0) >= 45_000;
  const binOk =
    !binReady ||
    microChopOk({
      samples: pool.binTapeSamples ?? 0,
      spanMs: pool.binTapeSpanMs ?? 0,
      crossings: pool.binTapeCrossings ?? 0,
      netBins: pool.binTapeNet ?? 0,
      maxStep: pool.binTapeMaxStep ?? 0,
    });
  if (!priceReady && !binReady) return true;
  return priceOk && binOk;
}

/** A slide spends two transactions, so it needs a tape that is still reversing. A missing tape does not. */
export function chopConfirmed(pool: PoolCandidate): boolean {
  const priceReady = (pool.chopSamples ?? 0) >= 4;
  const binReady = (pool.binTapeSamples ?? 0) >= 8 && (pool.binTapeSpanMs ?? 0) >= 45_000;
  if (!priceReady && !binReady) return false;
  return chopStillPays(pool);
}

export function planFleet(args: {
  pools: PoolCandidate[];
  seats: ActivePosition[];
  deploySol: number;
  now: number;
  lossCut?: number;
  dlmmOnly?: boolean;
  moves?: Record<string, number>;
  freezeOpens?: boolean;
  /** Most watched pools printed down together. New opens wait. */
  boardDown?: boolean;
}): FleetPlan {
  const lossCut = args.lossCut ?? config.growthLossCut;
  const closes: FleetClose[] = [];
  const holds: FleetHold[] = [];
  const slides: FleetSlide[] = [];
  let coreReopen: FleetOpen | null = null;

  for (const seat of args.seats) {
    const pool = args.pools.find((row) => row.poolAddress === seat.poolAddress);
    if (!pool) {
      if ((seat.scanMisses ?? 0) >= 4) {
        closes.push({ id: seat.id, action: "exit", reason: "pool left the fee list" });
      } else {
        holds.push({ id: seat.id, reason: "pool missed this scan; holding the seat" });
      }
      continue;
    }

    const price = pool.priceUsd || seat.lastPrice || seat.entryPrice;
    const step = Math.max(seat.binStep || pool.binStep || 80, 1) / 10_000;
    const drop = dropOf(pool, args.moves);
    const fast = drop >= Math.max(step, 0.01);
    const oneBinSkim = isSkim(seat) && seat.minBinId === seat.maxBinId && seat.entryPrice > 0;
    // Fees are paid in the active bin. The seat stays there while it is SOL.
    // A one-bin step up slides back into the new active bin. A runner, a dead
    // chop, or a break through the bid still leaves. Closing on the first
    // return to SOL would miss the next sell.
    const binStep = seat.binStep || pool.binStep || 80;
    if (oneBinSkim && dipThrough(price, seat.entryPrice, binStep)) {
      closes.push({ id: seat.id, action: "exit", reason: "scratched the fill" });
      continue;
    }
    // A filled seat that runs does not slide. The meme stays until the price
    // comes back, and a runner still leaves.
    if (oneBinSkim && seat.filled === true && bidLeftBehind(price, seat.entryPrice, binStep)) {
      closes.push({ id: seat.id, action: "exit", reason: "bid left behind" });
      continue;
    }
    // Still SOL, and the price has left the bin we are in. One step lands in
    // the active bin, which is the bin that pays. A missing tape does not slide
    // and does not evict. A dead chop, a third slide, or a runner does.
    if (oneBinSkim && seat.filled !== true) {
      const binsUp = binsAboveEntry(price, seat.entryPrice, binStep);
      if (binsUp >= 1 - 1e-6) {
        const slidesUsed = seat.slides ?? 0;
        if (slideInstead(binsUp, false, slidesUsed, chopConfirmed(pool))) {
          slides.push({ id: seat.id, reason: "slide the bid into the active bin" });
          continue;
        }
        if (binsUp > 2.5 || slidesUsed >= MAX_BID_SLIDES || !chopStillPays(pool)) {
          closes.push({ id: seat.id, action: "exit", reason: "bid left behind" });
          continue;
        }
        holds.push({ id: seat.id, reason: "waiting for the bin" });
        continue;
      }
    }
    // Inside the fee bin and still SOL. The 8-minute clock does not evict it.
    // Modeled drip fees are not a fill, so this does not bank. A dead chop does.
    if (oneBinSkim && !seat.filled && price >= seat.entryPrice) {
      const priceReady = (pool.chopSamples ?? 0) >= 4;
      const binReady = (pool.binTapeSamples ?? 0) >= 8 && (pool.binTapeSpanMs ?? 0) >= 45_000;
      const since = seat.slidAt ?? seat.enteredAt;
      const tapeGone = !priceReady && !binReady && args.now - since >= 3 * 60_000;
      if (tapeGone || !chopStillPays(pool)) {
        closes.push({ id: seat.id, action: "exit", reason: "chop ended" });
        continue;
      }
      holds.push({ id: seat.id, reason: seat.touched ? "bid is SOL again" : "earning the bin" });
      continue;
    }
    if (oneBinSkim && (seat.filled || price < seat.entryPrice)) {
      const held = args.now - seat.enteredAt;
      if (price < seat.entryPrice && held >= config.fleetMaxLifeMs) {
        const liveIl = seatIl(seat, pool, price);
        const bankable = bankableUsd(seat.feesAccruedUsd, liveIl, seat.costsUsd, config.txCostUsd);
        closes.push({
          id: seat.id,
          action: "exit",
          reason: bankable >= 0 ? "skim window banked" : "skim window closed",
        });
        continue;
      }
      holds.push({ id: seat.id, reason: "waiting for the round trip" });
      continue;
    }
    if (seat.side === "bid" && seat.entryPrice > 0) {
      if (isSkim(seat) && price <= seat.entryPrice * (1 - step)) {
        closes.push({ id: seat.id, action: "exit", reason: "scratched the fill" });
        continue;
      }
      if (fast && price <= seat.entryPrice * (1 - step * 0.5)) {
        closes.push({ id: seat.id, action: "exit", reason: "tape turned on the bid" });
        continue;
      }
    }

    if (isSkim(seat)) {
      const held = args.now - seat.enteredAt;
      const liveIl = seatIl(seat, pool, price);
      const bankable = bankableUsd(seat.feesAccruedUsd, liveIl, seat.costsUsd, config.txCostUsd);
      const solPx = pool.solPrice || seat.solPrice || 0;
      const deployUsd = seat.solDeployed * solPx;
      if (fast && held >= config.fleetFastExitMs && bankable < config.fleetBankUsd) {
        closes.push({ id: seat.id, action: "exit", reason: "tape turned on the bid" });
        continue;
      }
      if (lossCut > 0 && solPx > 0 && seat.solDeployed > 0 && held > 20_000) {
        const openSol = (seat.feesAccruedUsd - liveIl - seat.costsUsd) / solPx;
        if (openSol <= -lossCut * seat.solDeployed) {
          closes.push({ id: seat.id, action: "exit", reason: "seat lost the risk budget" });
          continue;
        }
      }
      if (
        trailGaveBack({
          bankableUsd: bankable,
          peakNetUsd: seat.peakNetUsd ?? bankable,
          deployUsd,
          startPct: config.trailStartPct,
          dropPct: config.trailDropPct,
        })
      ) {
        closes.push({ id: seat.id, action: "exit", reason: "trail gave back the run" });
        continue;
      }
      if (held >= config.fleetBankMinMs && bankable >= config.fleetBankUsd) {
        closes.push({ id: seat.id, action: "exit", reason: `banked $${bankable.toFixed(3)} on the skim` });
        continue;
      }
      if (held >= config.fleetMaxLifeMs) {
        closes.push({
          id: seat.id,
          action: "exit",
          reason: bankable >= 0 ? "skim window banked" : "skim window closed",
        });
        continue;
      }
      holds.push({ id: seat.id, reason: "skim working" });
      continue;
    }

    const ranked = rankPools(
      args.pools.map((row) => ({ ...row })),
      { deploySol: seat.solDeployed, growth: true },
    );
    const decision = planPosition({
      ranked,
      active: seat,
      now: args.now,
      deploySol: seat.solDeployed,
      lossCut,
    });
    if (decision.action === "exit" || decision.action === "rotate" || decision.action === "adjust") {
      closes.push({ id: seat.id, action: decision.action, reason: decision.reason });
      if ((decision.action === "rotate" || decision.action === "adjust") && decision.pool && decision.metrics) {
        coreReopen = {
          pool: decision.pool,
          metrics: decision.metrics,
          solDeploy: seat.solDeployed,
          strategy: "core",
          reason: decision.reason,
        };
      }
    } else {
      holds.push({ id: seat.id, reason: decision.reason });
    }
  }

  const closingIds = new Set(closes.map((row) => row.id));
  const kept = args.seats.filter((seat) => !closingIds.has(seat.id));
  let free = floorSol(args.deploySol - kept.reduce((sum, seat) => sum + seat.solDeployed, 0));
  const opens: FleetOpen[] = [];
  const blocked = new Set<string>([
    ...kept.map((seat) => seat.poolAddress),
    ...args.seats.filter((seat) => closingIds.has(seat.id)).map((seat) => seat.poolAddress),
  ]);

  const allow = (pool: PoolCandidate) => !args.dlmmOnly || pool.venue === "dlmm";
  const seatCap = floorSol(args.deploySol * Math.min(0.5, Math.max(0.05, config.fleetMaxSeatShare)));
  const quiet = args.freezeOpens || args.boardDown;

  if (
    coreReopen &&
    !quiet &&
    allow(coreReopen.pool) &&
    !tapeBlocksEntry(coreReopen.pool, args.moves) &&
    coreReopen.solDeploy <= free + 1e-9 &&
    coreReopen.solDeploy <= seatCap + 1e-9
  ) {
    opens.push(coreReopen);
    free = floorSol(free - coreReopen.solDeploy);
    blocked.add(coreReopen.pool.poolAddress);
  }

  const coreKept = kept.some((seat) => !isSkim(seat));
  if (!coreKept && !coreReopen && !quiet) {
    const coreBudget = Math.min(
      floorSol(args.deploySol * Math.min(0.5, Math.max(0, config.fleetCoreShare))),
      seatCap,
    );
    if (coreBudget >= config.fleetMinSlot && coreBudget <= free + 1e-9) {
      const ranked = rankPools(
        args.pools
          .filter((pool) => !blocked.has(pool.poolAddress) && !tapeBlocksEntry(pool, args.moves))
          .map((pool) => ({ ...pool })),
        { deploySol: coreBudget, growth: true },
      );
      const best = ranked
        .filter(
          (row) => row.metrics.metThreshold && allow(row.pool) && row.pool.side !== "curve" && !entryBlocked(row.pool),
        )
        .sort((a, b) => feePerBin(b.pool) - feePerBin(a.pool) || b.metrics.edgeUsd - a.metrics.edgeUsd)[0];
      if (best) {
        best.pool.side = "bid";
        opens.push({
          pool: best.pool,
          metrics: best.metrics,
          solDeploy: coreBudget,
          strategy: "core",
          reason: `core edge $${best.metrics.edgeUsd.toFixed(3)} after costs`,
        });
        free = floorSol(free - coreBudget);
        blocked.add(best.pool.poolAddress);
      }
    }
  }

  const seatedMints = new Set(kept.map((seat) => seat.tokenMint).filter(Boolean));
  for (const open of opens) {
    if (open.pool.tokenMint) seatedMints.add(open.pool.tokenMint);
  }
  const skims = quiet
    ? []
    : pickSkims(args.pools, free, blocked, args.moves, seatCap, seatedMints).filter((row) => allow(row.pool));
  opens.push(...skims);
  if (args.freezeOpens) opens.length = 0;

  const previewSlot =
    skims[0]?.solDeploy ?? (free >= config.fleetMinSlot ? Math.min(seatCap, free) : seatCap);
  const previewPools = onePoolPerMint(args.pools.filter((pool) => pool.venue === "dlmm"));
  const previewSeen = new Set(previewPools.map((pool) => pool.poolAddress));
  for (const open of opens) {
    if (open.pool.venue !== "dlmm" || previewSeen.has(open.pool.poolAddress)) continue;
    const key = open.pool.tokenMint || open.pool.poolAddress;
    const idx = previewPools.findIndex((pool) => (pool.tokenMint || pool.poolAddress) === key);
    if (idx >= 0) previewPools[idx] = open.pool;
    else previewPools.push(open.pool);
    previewSeen.add(open.pool.poolAddress);
  }
  const preview: FleetPreview[] = previewPools
    .map((pool) => {
      const quoted = skimQuote(pool, previewSlot, args.moves);
      const blockedByTape = tapeBlocksEntry(pool, args.moves);
      const blockedByGeometry = !blockedByTape && geometryBlocks(pool);
      const blockedByTravel = !blockedByTape && !blockedByGeometry && travelBlocks(pool);
      const blockedByChop = !blockedByTape && !blockedByGeometry && !blockedByTravel && chopBlocks(pool);
      const blockedByGate = blockedByTape || blockedByGeometry || blockedByTravel || blockedByChop;
      const strategy = blockedByTape
        ? "tape"
        : blockedByGeometry
          ? "geometry"
          : blockedByTravel
            ? "travel"
            : blockedByChop
              ? "chop"
              : "skim";
      return {
        poolAddress: pool.poolAddress,
        poolName: pool.poolName,
        tokenSymbol: pool.tokenSymbol,
        venue: pool.venue,
        side: quoted.pool.side,
        strategy,
        opportunityScore: quoted.metrics.opportunityScore,
        edgeUsd: quoted.metrics.edgeUsd,
        fee30m: pool.fee30mUsd,
        feeToTvl: feeToTvl(pool),
        binStep: pool.binStep ?? 0,
        baseFeePct: pool.baseFeePct ?? 0,
        ageMin: pool.createdAtMs > 0 ? Math.max(0, Math.round((args.now - pool.createdAtMs) / 60_000)) : 0,
        metThreshold: quoted.metrics.metThreshold && !blockedByGate && !quiet,
        watched: pool.watched === true,
      };
    });

  for (const open of opens) {
    const row = preview.find((item) => item.poolAddress === open.pool.poolAddress);
    if (!row) continue;
    row.strategy = open.strategy;
    row.side = open.pool.side;
    row.edgeUsd = open.metrics.edgeUsd;
    row.metThreshold = true;
    row.opportunityScore = open.metrics.opportunityScore;
  }
  const quoteReady = (row: FleetPreview) =>
    row.edgeUsd > 0 && row.strategy !== "geometry" && row.strategy !== "tape" ? 1 : 0;
  preview.sort((a, b) => quoteReady(b) - quoteReady(a) || b.feeToTvl - a.feeToTvl || b.fee30m - a.fee30m);
  const watchedRows = preview.filter((row) => row.watched).sort((a, b) => quoteReady(b) - quoteReady(a) || b.feeToTvl - a.feeToTvl || b.fee30m - a.fee30m);
  const rest = preview.filter((row) => !row.watched);
  const cap = Math.max(8, Math.min(24, watchedRows.length || 8));
  preview.splice(0, preview.length, ...[...watchedRows, ...rest].slice(0, cap));

  const names = opens.map((row) => `${row.strategy} ${row.pool.tokenSymbol} ${row.solDeploy.toFixed(3)}`).join(", ");
  const best = preview[0];
  const bestText = `${best?.poolName ?? "none"} $${(best?.edgeUsd ?? 0).toFixed(3)}`;
  let summary = "no pool clears costs";
  if (args.freezeOpens && !closes.length) {
    summary = "shock pause; no new seats";
  } else if (opens.length || closes.length || slides.length) {
    const slideText = slides.length ? ` slide ${slides.length}` : "";
    summary = `open ${opens.length}${names ? ` (${names})` : ""} close ${closes.length}${slideText}`;
  } else if (args.seats.length) {
    summary = `holding ${args.seats.length}`;
  } else if (args.boardDown) {
    summary = `board falling; best ${bestText}`;
  } else if (best?.strategy === "tape") {
    summary = `tape falling; best ${bestText}`;
  } else if (best?.strategy === "geometry") {
    summary = `fee rate too thin; best ${bestText}`;
  } else if (best?.strategy === "travel") {
    summary = `no travel; best ${bestText}`;
  } else if (best?.strategy === "chop") {
    summary = `no chop; best ${bestText}`;
  } else if (best) {
    summary = `no pool clears costs; best ${bestText}`;
  }

  return { closes, opens, holds, slides, preview, summary };
}
