import { buildCandidates, fetchOriginalOpportunityChecks, fetchTopPumpTokens } from "./apis.js";
import { config } from "./config.js";
import { bankableUsd, collectedFeePct, depthReadRank } from "./edge.js";
import { chopFromPrices } from "./chop.js";
import { bidCycle, filledShouldSell, MAX_BID_SLIDES, scratchNow, slideIntoActive } from "./fillwatch.js";
import { binTapeFromIds, feeRateClears, mintShouldSleep, priceBinId } from "./travel.js";
import { deploySolFor, equitySol, paceSol } from "./growth.js";
import { DlmmExecutor, DUST_RAW, enterPositionDryRun } from "./executor.js";
import { loadWalletKeypair, saveWalletSecret } from "./wallet.js";
import { fetchMeteoraCandidates } from "./meteora.js";
import { mergeWatched, watchedMemePools } from "./watched.js";
import { accrueFees, entryCostUsd, markIlUsd, oneBinBidIl, priceBand } from "./pnl.js";
import { hydratePosition } from "./position.js";
import { measureRpcLatency, ProofNetworkTelemetry } from "./proofnetwork.js";
import { chopConfirmed, chopStillPays, planFleet, coolsOff, downwardMove, type FleetOpen, type FleetPlan } from "./fleet.js";
import { decide, planToCheck, type Plan } from "./scorer.js";
import { ensureGrowth, loadState, saveState, type BotState, type GrowthLedger } from "./state.js";
import type { ActivePosition, BotDecision, OpportunityCheck, PoolCandidate } from "./types.js";

export interface ScanRecord {
  at: string;
  check: OpportunityCheck;
  topCandidates: Array<{
    poolName: string;
    tokenSymbol: string;
    venue: string;
    side: string;
    opportunityScore: number;
    edgeUsd: number;
    fee30m: number;
    feeToTvl: number;
    binStep: number;
    baseFeePct: number;
    ageMin: number;
    metThreshold: boolean;
    strategy: string;
  }>;
}

export interface BotSnapshot {
  uptimeSec: number;
  paused: boolean;
  loopRunning: boolean;
  scanCount: number;
  lastScanAt: string | null;
  lastError: string | null;
  lastScan: OpportunityCheck | null;
  scanHistory: ScanRecord[];
  activePosition: ActivePosition | null;
  seats: ActivePosition[];
  closedCount: number;
  recentCloses: Array<{
    poolName: string;
    strategy: string;
    side: string;
    solDeployed: number;
    netUsd: number;
    feesUsd: number;
    ilUsd: number;
    costsUsd: number;
    reason: string;
    at: number;
  }>;
  book: BotState["book"];
  growth: {
    startSol: number;
    targetSol: number;
    equitySol: number;
    realizedSol: number;
    paceSol: number;
    deploySol: number;
    startedAt: number;
  };
  scanMs: number;
  poolCounts: { dlmm: number; damm_v2: number; damm_v1: number };
  config: {
    dryRun: boolean;
    mirrorOriginal: boolean;
    solDeploy: number;
    scanIntervalMs: number;
    fillPollMs: number;
    proofnetworkTelemetry: boolean;
    proofnetworkContract: string;
    walletConfigured: boolean;
    walletPublicKey: string | null;
  };
}

export class DegenLpBot {
  private state: BotState;
  private executor: DlmmExecutor | null = null;
  private telemetry: ProofNetworkTelemetry | null = null;
  private started = false;
  private paused = false;
  private loopRunning = false;
  private startedAt = Date.now();
  private scanCount = 0;
  private lastScanAt: string | null = null;
  private lastError: string | null = null;
  private lastScan: OpportunityCheck | null = null;
  private scanHistory: ScanRecord[] = [];
  private lastTopCandidates: ScanRecord["topCandidates"] = [];
  private lastScanMs = 0;
  private poolCounts = { dlmm: 0, damm_v2: 0, damm_v1: 0 };
  private cooloff = new Map<string, number>();
  private deploySol = config.solDeploy;
  private walletPublicKey: string | null = null;
  private kick = false;
  private announcedKey = false;
  private tapes = new Map<string, { at: number; price: number }[]>();
  private shockAt: number[] = [];
  private freezeUntil = 0;
  private scanFlight: Promise<OpportunityCheck> | null = null;
  private sweepHold = new Map<string, number>();
  private mintSleep = new Map<string, number>();
  private binSolCache = new Map<string, { at: number; sol: number }>();
  private binTapes = new Map<string, { at: number; id: number }[]>();
  private lastActiveId = new Map<string, number>();
  private poolWatch = new Map<string, () => void>();
  private exitFlight = new Map<string, Promise<void>>();
  private slideFlight = new Map<string, Promise<void>>();
  private scaleFlight = new Map<string, Promise<void>>();
  private lastPools: PoolCandidate[] = [];
  private fillTimer: ReturnType<typeof setInterval> | null = null;
  private fillPollFlight: Promise<void> | null = null;

  constructor() {
    this.state = loadState();
    ensureGrowth(this.state);
    this.state.seats = (this.state.seats ?? []).map((seat) => hydratePosition(seat));
    this.syncActive();
    if (!config.dryRun) {
      const kp = loadWalletKeypair();
      if (kp) {
        this.executor = DlmmExecutor.fromKeypair(kp);
        this.walletPublicKey = kp.publicKey.toBase58();
      } else {
        console.log("[live] waiting for wallet key");
      }
    }
    if (config.proofnetworkTelemetry && config.walletPrivateKey) {
      this.telemetry = ProofNetworkTelemetry.fromEnv();
    }
  }

  async scanOnce(): Promise<OpportunityCheck> {
    if (this.scanFlight) return this.scanFlight;
    const flight = this.runScan();
    this.scanFlight = flight;
    try {
      return await flight;
    } finally {
      if (this.scanFlight === flight) this.scanFlight = null;
    }
  }

  private runScan(): Promise<OpportunityCheck> {
    return config.mirrorOriginal ? this.mirrorScan() : this.independentScan();
  }

  private async independentScan(): Promise<OpportunityCheck> {
    const started = Date.now();
    const [catalog, watched] = await Promise.all([fetchMeteoraCandidates(), watchedMemePools()]);
    const candidates = mergeWatched(catalog, watched);
    const now = Date.now();
    const held = new Set(this.state.seats.map((seat) => seat.poolAddress));
    const tradable = candidates.filter((pool) => {
      if (held.has(pool.poolAddress)) return true;
      if ((this.cooloff.get(pool.poolAddress) ?? 0) > now) return false;
      if ((this.mintSleep.get(pool.tokenMint) ?? 0) > now) return false;
      if (!config.dryRun && pool.venue !== "dlmm") return false;
      return true;
    });
    const equity = this.refreshDeploy();
    this.lastScanMs = Date.now() - started;
    this.poolCounts = {
      dlmm: candidates.filter((pool) => pool.venue === "dlmm").length,
      damm_v2: candidates.filter((pool) => pool.venue === "damm_v2").length,
      damm_v1: candidates.filter((pool) => pool.venue === "damm_v1").length,
    };
    for (const seat of this.state.seats) {
      const seen = candidates.some((pool) => pool.poolAddress === seat.poolAddress);
      seat.scanMisses = seen ? 0 : (seat.scanMisses ?? 0) + 1;
      this.markSeat(seat, candidates);
    }
    this.notePrices(candidates, now);
    this.attachChop(tradable);
    await this.attachBinDepth(tradable);
    const travelWatched = await this.attachBinTravel(tradable, now);
    await this.noteFills();
    const plan = planFleet({
      pools: tradable,
      seats: this.state.seats,
      deploySol: this.deploySol,
      now,
      lossCut: config.growthLossCut,
      dlmmOnly: !config.dryRun,
      moves: this.movesFor(candidates, now),
      freezeOpens: now < this.freezeUntil,
      boardDown: this.boardIsDown(candidates, now),
    });
    for (const hold of plan.holds) {
      if (hold.reason !== "waiting for the round trip") continue;
      const seat = this.state.seats.find((row) => row.id === hold.id);
      if (seat) seat.touched = true;
    }
    this.lastTopCandidates = plan.preview.map((row) => ({
      poolName: row.poolName,
      tokenSymbol: row.tokenSymbol,
      venue: row.venue,
      side: row.side,
      opportunityScore: row.opportunityScore,
      edgeUsd: row.edgeUsd,
      fee30m: row.fee30m,
      feeToTvl: row.feeToTvl,
      binStep: row.binStep,
      baseFeePct: row.baseFeePct,
      ageMin: row.ageMin,
      metThreshold: row.metThreshold,
      strategy: row.strategy,
    }));
    saveState(this.state);
    const check = this.fleetCheck(plan, now);

    console.log(
      `[scan] ${check.decision} seats=${this.state.seats.length} deploy=${this.deploySol.toFixed(3)} equity=${equity.toFixed(3)} ${plan.summary} ${this.lastScanMs}ms pools=${candidates.length} dlmm=${this.poolCounts.dlmm} damm2=${this.poolCounts.damm_v2} damm1=${this.poolCounts.damm_v1} travel=${travelWatched} watched=${candidates.filter((pool) => pool.watched).length}`,
    );

    this.lastPools = tradable;
    await this.applyFleet(plan);
    await this.pushTelemetry(check);
    this.recordScan(check);
    this.logBook();
    return check;
  }

  private fleetCheck(plan: FleetPlan, checkedAt: number): OpportunityCheck {
    const open = plan.opens[0];
    const seat = this.state.seats[0];
    const pool = open?.pool;
    const metrics = open?.metrics;
    const decision: OpportunityCheck["decision"] =
      plan.opens.length && plan.closes.length ? "rotate" :
      plan.opens.length ? "enter" :
      plan.closes.length ? "exit" :
      plan.slides.length || plan.adds.length ? "adjust" :
      this.state.seats.length ? "stay" : "wait";
    return {
      poolAddress: pool?.poolAddress ?? seat?.poolAddress ?? "none",
      poolName: pool?.poolName ?? seat?.poolName ?? "No opportunity found",
      tokenSymbol: pool?.tokenSymbol ?? seat?.baseTokenSymbol ?? "",
      tokenMint: pool?.tokenMint ?? seat?.tokenMint ?? "",
      opportunityScore: metrics?.opportunityScore ?? seat?.opportunityScoreAtEntry ?? 0,
      volumeToTvlRatio: metrics?.volumeToTvlRatio ?? 0,
      volumeToMcapRatio: metrics?.volumeToMcapRatio ?? 0,
      feeToTvlRatio: metrics?.feeToTvlRatio ?? 0,
      marketCap: metrics?.marketCap ?? seat?.marketCapAtEntry ?? 0,
      poolTvl: metrics?.poolTvl ?? seat?.liquidityAtEntry ?? 0,
      volume5m: metrics?.volume5m ?? 0,
      jupiterScore: metrics?.jupiterScore ?? seat?.jupiterScoreAtEntry ?? 0,
      decision,
      currentPositionPool: seat?.poolAddress ?? "",
      metThreshold: metrics?.metThreshold ?? false,
      binStep: pool?.binStep ?? seat?.binStep,
      venue: pool?.venue ?? seat?.venue,
      fee30mUsd: pool?.fee30mUsd,
      reason: plan.summary,
      checkedAt,
    };
  }

  private markSeat(pos: ActivePosition, pools: PoolCandidate[]) {
    const pool = pools.find((item) => item.poolAddress === pos.poolAddress);
    const now = Date.now();
    const elapsedMin = Math.min(
      (config.scanIntervalMs / 60_000) * 1.5,
      Math.max(0, (now - pos.lastMarkAt) / 60_000),
    );
    const price = pool?.priceUsd || pos.lastPrice || pos.entryPrice;
    const sol = pool?.solPrice || pos.solPrice || 0;
    const deployUsd = pos.solDeployed * sol;
    const inside = price >= pos.priceLower && price <= pos.priceUpper;
    const oneBinBid = pos.strategy === "skim" && pos.side === "bid" && pos.minBinId === pos.maxBinId;
    const earnedFill = !oneBinBid || pos.touched === true || pos.filled === true;
    if (pool && deployUsd > 0) {
      if (earnedFill) {
        pos.feesAccruedUsd += accrueFees({
          fees30mUsd: pool.fee30mUsd,
          tvlUsd: pool.pairLiquidityUsd,
          deployUsd,
          elapsedMin,
          inRange: pos.side === "full" || inside,
          side: pos.side,
          rangeHalfWidth: pos.rangeHalfWidth,
        });
      }
      pos.ilUsd = oneBinBid
        ? oneBinBidIl({
            deployUsd,
            entryPrice: pos.entryPrice,
            price,
            filled: pos.filled === true,
          })
        : markIlUsd({
            deployUsd,
            entryPrice: pos.entryPrice,
            price,
            lower: pos.priceLower,
            upper: pos.priceUpper,
            side: pos.side,
          });
      pos.solPrice = sol;
    }
    const net = bankableUsd(pos.feesAccruedUsd, pos.ilUsd, pos.costsUsd, config.txCostUsd);
    pos.peakNetUsd = Math.max(pos.peakNetUsd ?? net, net);
    pos.lastPrice = price;
    pos.lastMarkAt = now;
  }

  private logBook() {
    const book = this.state.book;
    const openNet = this.openNetUsd();
    console.log(
      `[book] realized=$${book.realizedUsd.toFixed(4)} fees=$${book.feesUsd.toFixed(4)} il=$${book.ilUsd.toFixed(4)} costs=$${book.costsUsd.toFixed(4)} open=$${openNet.toFixed(4)} seats=${this.state.seats.length} entries=${book.entries} exits=${book.exits} adjusts=${book.adjusts} rotates=${book.rotates}`,
    );
  }

  private openNetUsd(): number {
    return this.state.seats.reduce((sum, seat) => sum + seat.feesAccruedUsd - seat.ilUsd - seat.costsUsd, 0);
  }

  private syncActive() {
    const core = this.state.seats.find((seat) => seat.strategy !== "skim");
    this.state.active = core ?? this.state.seats[0] ?? null;
  }

  private notePrices(pools: PoolCandidate[], now: number): void {
    const keepAfter = now - config.fleetTapeMs * 2;
    const seen = new Set<string>();
    for (const pool of pools) {
      if (!(pool.priceUsd > 0)) continue;
      seen.add(pool.poolAddress);
      let rows = this.tapes.get(pool.poolAddress);
      if (!rows) {
        rows = [];
        this.tapes.set(pool.poolAddress, rows);
      }
      const last = rows[rows.length - 1];
      if (!last || last.price !== pool.priceUsd || now - last.at >= 3_000) {
        rows.push({ at: now, price: pool.priceUsd });
      }
      while (rows.length && rows[0].at < keepAfter) rows.shift();
      if (rows.length > 24) rows.splice(0, rows.length - 24);
    }
    if (this.tapes.size > seen.size + 50) {
      for (const key of this.tapes.keys()) {
        if (!seen.has(key)) this.tapes.delete(key);
      }
    }
  }

  private attachChop(pools: PoolCandidate[]): void {
    for (const pool of pools) {
      if (pool.venue !== "dlmm") continue;
      const read = chopFromPrices(
        (this.tapes.get(pool.poolAddress) ?? []).map((row) => row.price),
        pool.binStep ?? 80,
      );
      pool.chopSamples = read.samples;
      pool.chopCrossings = read.crossings;
      pool.chopNetBins = read.netBins;
    }
  }

  /** Paper has no bin account, so the depth gate sees pool TVL. Live reads the active bin. */
  private async attachBinDepth(pools: PoolCandidate[]): Promise<void> {
    if (!this.executor) {
      for (const pool of pools) {
        if (pool.venue === "dlmm" && !(pool.binSolUsd != null && pool.binSolUsd > 0)) {
          pool.binSolUsd = pool.pairLiquidityUsd * 0.5;
        }
      }
      return;
    }
    const now = Date.now();
    const ranked = pools
      .filter(
        (pool) =>
          pool.venue === "dlmm" &&
          (pool.chopCrossings ?? 0) >= 2 &&
          (pool.chopSamples ?? 0) >= 4 &&
          feeRateClears(pool.baseFeePct ?? 0, pool.binStep ?? 80, this.unwindBps()),
      )
      .sort((a, b) => depthReadRank(b) - depthReadRank(a) || (b.baseFeePct ?? 0) - (a.baseFeePct ?? 0))
      .slice(0, 8);
    await Promise.all(
      ranked.map(async (pool) => {
        const hit = this.binSolCache.get(pool.poolAddress);
        if (hit && now - hit.at < 20_000) {
          pool.binSolUsd = hit.sol * (pool.solPrice || 0);
          return;
        }
        try {
          const sol = await this.executor!.activeBinSol(pool.poolAddress);
          if (sol == null) return;
          this.binSolCache.set(pool.poolAddress, { at: now, sol });
          pool.binSolUsd = sol * (pool.solPrice || 0);
        } catch {
          console.error("[depth] active bin read failed");
        }
      }),
    );
  }

  /** Active-bin steps on pools whose base fee can pay the unwind. Missing ids stay closed. */
  private async attachBinTravel(pools: PoolCandidate[], now: number): Promise<number> {
    const keepAfter = now - 3 * 60_000;
    const unwindBps = this.unwindBps();
    const ranked = pools
      .filter((pool) => pool.venue === "dlmm" && feeRateClears(pool.baseFeePct ?? 0, pool.binStep ?? 80, unwindBps))
      .sort((a, b) => collectedFeePct(b) - collectedFeePct(a) || (b.baseFeePct ?? 0) - (a.baseFeePct ?? 0));
    const seatedAddrs = new Set(this.state.seats.map((seat) => seat.poolAddress));
    const seatedPools = pools.filter((pool) => pool.venue === "dlmm" && seatedAddrs.has(pool.poolAddress));
    const shortlist: PoolCandidate[] = [];
    const seen = new Set<string>();
    for (const pool of [...seatedPools, ...ranked]) {
      if (seen.has(pool.poolAddress)) continue;
      seen.add(pool.poolAddress);
      shortlist.push(pool);
      if (shortlist.length >= 24) break;
    }
    const ids = new Map<string, number>();
    if (this.executor) {
      try {
        const found = await this.executor.poolActiveIds(shortlist.map((pool) => pool.poolAddress));
        for (const [address, id] of found) ids.set(address, id);
      } catch {
        console.error("[travel] active bin read failed");
      }
    } else if (config.dryRun) {
      for (const pool of shortlist) {
        const id = priceBinId(pool.priceUsd, pool.binStep ?? 0);
        if (id == null) continue;
        ids.set(pool.poolAddress, id);
      }
    }
    for (const pool of shortlist) {
      const id = ids.get(pool.poolAddress);
      if (id == null) continue;
      this.rememberBin(pool.poolAddress, now, id);
      const read = binTapeFromIds(this.binTapes.get(pool.poolAddress) ?? [], now, config.fleetTapeMs);
      pool.binTapeSamples = read.samples;
      pool.binTapeSpanMs = read.spanMs;
      pool.binTapeCrossings = read.crossings;
      pool.binTapeNet = read.netBins;
      pool.binTapeMaxStep = read.maxStep;
    }
    const seated = new Set(this.state.seats.map((seat) => seat.poolAddress));
    for (const [key, rows] of this.binTapes) {
      while (rows.length && rows[0].at < keepAfter) rows.shift();
      if (!rows.length) this.binTapes.delete(key);
    }
    for (const key of this.lastActiveId.keys()) {
      if (!this.binTapes.has(key) && !seated.has(key)) this.lastActiveId.delete(key);
    }
    return ids.size;
  }

  private unwindBps(): number {
    return Math.max(config.swapBps, 300);
  }

  private rememberBin(poolAddress: string, at: number, id: number): void {
    this.lastActiveId.set(poolAddress, id);
    let rows = this.binTapes.get(poolAddress);
    if (!rows) {
      rows = [];
      this.binTapes.set(poolAddress, rows);
    }
    rows.push({ at, id });
    if (rows.length > 48) rows.splice(0, rows.length - 48);
  }

  private async noteFills(): Promise<void> {
    if (config.dryRun || !this.executor) return;
    for (const seat of this.state.seats) {
      try {
        const raw = await this.executor.positionMemeRaw(seat.poolAddress, seat.positionAddress, seat.tokenMint);
        // Fee atoms are not a fill. Treating them as one blocks the slide back
        // into the active bin. The same dust line refuses a slide while a real bag remains.
        const filled = raw > DUST_RAW;
        seat.filled = filled;
        if (filled) seat.touched = true;
      } catch {
        console.error("[fill] position read failed");
      }
    }
  }

  /** Half the watched pools stepped down together. One pool's tape is not the whole board. */
  private boardIsDown(pools: PoolCandidate[], now: number): boolean {
    let watched = 0;
    let down = 0;
    for (const pool of pools) {
      if (pool.venue !== "dlmm") continue;
      const tape = this.tapes.get(pool.poolAddress);
      if (!tape || tape.length < 4) continue;
      watched += 1;
      const drop = downwardMove(tape, now, config.fleetTapeMs);
      const step = Math.max(pool.binStep ?? 80, 1) / 10_000;
      if (drop >= Math.max(step, 0.01)) down += 1;
    }
    return watched >= 8 && down / watched >= 0.5;
  }

  private movesFor(pools: PoolCandidate[], now: number): Record<string, number> {
    const moves: Record<string, number> = {};
    for (const pool of pools) {
      const drop = downwardMove(this.tapes.get(pool.poolAddress), now, config.fleetTapeMs);
      if (drop > 0) moves[pool.poolAddress] = drop;
    }
    return moves;
  }

  /** Two risk-budget losses inside the window pause new opens. The 72% fraction stays. */
  private noteShock(now = Date.now()): void {
    this.shockAt = this.shockAt.filter((at) => now - at <= config.fleetShockWindowMs);
    this.shockAt.push(now);
    if (this.shockAt.length < 2 || now < this.freezeUntil) return;
    this.freezeUntil = now + config.fleetShockPauseMs;
    const sec = Math.round(config.fleetShockPauseMs / 1000);
    console.log(`[risk] shock pause ${sec}s after two risk-budget cuts`);
  }

  private liveReady(): boolean {
    if (config.dryRun || this.executor) return true;
    if (!this.announcedKey) {
      console.log("[live] waiting for wallet key");
      this.announcedKey = true;
    }
    return false;
  }

  private recordScan(check: OpportunityCheck) {
    this.scanCount += 1;
    this.lastScanAt = new Date().toISOString();
    this.lastScan = check;
    this.scanHistory.unshift({
      at: this.lastScanAt,
      check,
      topCandidates: this.lastTopCandidates,
    });
    if (this.scanHistory.length > 50) this.scanHistory.length = 50;
  }

  private async mirrorScan(): Promise<OpportunityCheck> {
    const checks = await fetchOriginalOpportunityChecks(3);
    const latest = checks[0];
    if (!latest) {
      const check = decide(null, this.state.active);
      await this.applyDecision(check, null);
      await this.pushTelemetry(check);
      this.recordScan(check);
      return check;
    }

    const decision = String(latest.decision ?? "wait") as OpportunityCheck["decision"];
    console.log(
      `[mirror] original decision=${decision} pool=${latest.pool_name} score=${latest.opportunity_score}`,
    );

    if (decision === "enter" && latest.pool_address && latest.pool_address !== "none") {
      const tokens = await fetchTopPumpTokens(config.topTokensLimit);
      const candidates = await buildCandidates(tokens);
      const target = candidates.find((c) => c.poolAddress === latest.pool_address) ?? null;
      const check = decide(target, this.state.active);
      check.decision = "enter";
      await this.applyDecision(check, target);
      await this.pushTelemetry(check);
      this.recordScan(check);
      return check;
    }

    const check = decide(null, this.state.active);
    check.decision = decision;
    await this.applyDecision(check, null);
    await this.pushTelemetry(check);
    this.recordScan(check);
    return check;
  }

  private async pushTelemetry(check: OpportunityCheck) {
    if (!this.telemetry) return;
    try {
      const rpc = await measureRpcLatency(config.rpcUrl);
      await this.telemetry.recordOpportunityCheck(check);
      await this.telemetry.recordSystemHealth(
        rpc.ms,
        rpc.healthy,
        this.state.seats.length,
      );
    } catch (err) {
      console.error("[telemetry]", err);
    }
  }

  private async applyDecision(check: OpportunityCheck, candidate: PoolCandidate | null) {
    const plan: Plan = {
      action: check.decision,
      pool: candidate,
      metrics: null,
      reason: check.reason ?? check.decision,
    };
    await this.applyPlan(plan, check);
  }

  private async applyPlan(plan: Plan, check: OpportunityCheck) {
    if (!this.liveReady()) return;

    const closes = plan.action === "exit" || plan.action === "adjust" || plan.action === "rotate";
    const opens = plan.action === "enter" || plan.action === "adjust" || plan.action === "rotate";
    const seat = this.state.active;

    if (closes && seat) {
      await this.closeSeat(seat, plan.reason, plan.action);
    }
    if (opens && plan.pool && !this.state.seats.length) {
      await this.openSeat({
        pool: plan.pool,
        metrics: plan.metrics ?? {
          volume5m: 0,
          poolTvl: plan.pool.pairLiquidityUsd,
          marketCap: plan.pool.marketCap,
          jupiterScore: plan.pool.jupiterScore,
          volumeToTvlRatio: 0,
          volumeToMcapRatio: 0,
          feeToTvlRatio: check.feeToTvlRatio,
          opportunityScore: check.opportunityScore,
          edgeUsd: 0,
          metThreshold: true,
        },
        solDeploy: this.deploySol,
        strategy: "core",
        reason: plan.reason,
      });
    }
    if (plan.action === "stay" && this.state.active) {
      const pos = this.state.active;
      const net = pos.feesAccruedUsd - pos.ilUsd - pos.costsUsd;
      console.log(
        `[stay] ${pos.venue} ${pos.poolName} fees=$${pos.feesAccruedUsd.toFixed(4)} il=$${pos.ilUsd.toFixed(4)} net=$${net.toFixed(4)}`,
      );
    }
  }

  private async applyFleet(plan: FleetPlan) {
    if (!this.liveReady()) return;
    for (const slide of plan.slides) {
      const seat = this.state.seats.find((row) => row.id === slide.id);
      if (!seat) continue;
      const pool = this.lastPools.find((row) => row.poolAddress === seat.poolAddress);
      await this.slideSeat(seat, pool);
    }
    for (const close of plan.closes) {
      const seat = this.state.seats.find((row) => row.id === close.id);
      if (!seat) continue;
      await this.closeSeat(seat, close.reason, close.action);
    }
    for (const add of plan.adds) {
      const seat = this.state.seats.find((row) => row.id === add.id);
      if (!seat || seat.filled) continue;
      await this.scaleSeat(seat, add.solDeploy);
    }
    let opened = 0;
    for (const open of plan.opens) {
      if (opened >= config.fleetOpensPerScan) break;
      if (this.state.seats.some((seat) => seat.poolAddress === open.pool.poolAddress)) continue;
      try {
        await this.openSeat(open);
        opened += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("remains in the wallet")) throw err;
        this.lastError = msg;
        console.error("[open]", msg);
        if (msg.includes("fee reserve")) break;
      }
    }
  }

  private closeSeat(
    active: ActivePosition,
    reason: string,
    action: BotDecision,
    alreadyFlat = false,
  ): Promise<void> {
    const existing = this.exitFlight.get(active.id);
    if (existing) return existing;
    const flight = this.finishClose(active, reason, action, alreadyFlat).finally(() => {
      this.exitFlight.delete(active.id);
      this.syncWatches(this.state.seats.filter((seat) => seat.side === "bid" && seat.minBinId === seat.maxBinId));
    });
    this.exitFlight.set(active.id, flight);
    return flight;
  }

  private async finishClose(
    active: ActivePosition,
    reason: string,
    action: BotDecision,
    alreadyFlat = false,
  ) {
    // Sleep only after a run-through or a violent exit. A dust atom still inside the bin can be checked again.
    if (mintShouldSleep(reason, this.lastActiveId.get(active.poolAddress), active.minBinId)) {
      this.mintSleep.set(active.tokenMint, Date.now() + 3 * 60_000);
    }
    let sig = "dry_run_exit";
    if (!config.dryRun && this.executor) {
      if (alreadyFlat) {
        sig = "slide_removed";
      } else {
        const exists = await this.executor.positionExists(active.positionAddress);
        sig = await this.executor.exit(active, exists ? reason : "Position not found on-chain - already closed");
      }
      const settled = await this.executor.settleMeme(active.tokenMint, active.poolAddress);
      if (settled === "swapped") active.costsUsd += config.txCostUsd;
      if (settled === "stuck") this.cooloff.set(active.poolAddress, Date.now() + 15 * 60_000);
    } else {
      console.log(`[dry-run exit] ${active.venue} ${active.poolName} ${reason}`);
    }
    active.costsUsd += config.txCostUsd;

    if (coolsOff(reason)) {
      this.cooloff.set(active.poolAddress, Date.now() + 15 * 60_000);
    }
    const net = active.feesAccruedUsd - active.ilUsd - active.costsUsd;
    if (net < 0 && /risk budget/.test(reason)) this.noteShock();
    const growth = ensureGrowth(this.state);
    if (active.solPrice > 0) growth.realizedSol += net / active.solPrice;
    this.state.book.feesUsd += active.feesAccruedUsd;
    this.state.book.ilUsd += active.ilUsd;
    this.state.book.costsUsd += active.costsUsd;
    this.state.book.realizedUsd += net;
    this.state.book.exits += 1;
    if (action === "adjust") this.state.book.adjusts += 1;
    if (action === "rotate") this.state.book.rotates += 1;

    active.status = "closed";
    active.exitReason = reason;
    active.exitedAt = Date.now();
    active.entrySignature = sig;
    this.state.closed.unshift(active);
    if (this.state.closed.length > 200) this.state.closed.length = 200;
    this.state.seats = this.state.seats.filter((seat) => seat.id !== active.id);
    this.syncActive();
    saveState(this.state);
    console.log(`[closed] ${active.strategy ?? "core"} ${active.poolName} net=$${net.toFixed(4)} book=$${this.state.book.realizedUsd.toFixed(4)}`);
    await this.telemetryExit(active, reason, sig);
  }

  private async openSeat(open: FleetOpen) {
    const pool = open.pool;
    if (!config.dryRun && pool.venue !== "dlmm") {
      throw new Error(`live signing is DLMM-only, skipped ${pool.venue} ${pool.poolName}`);
    }
    const check: OpportunityCheck = {
      poolAddress: pool.poolAddress,
      poolName: pool.poolName,
      tokenSymbol: pool.tokenSymbol,
      tokenMint: pool.tokenMint,
      opportunityScore: open.metrics.opportunityScore,
      volumeToTvlRatio: open.metrics.volumeToTvlRatio,
      volumeToMcapRatio: open.metrics.volumeToMcapRatio,
      feeToTvlRatio: open.metrics.feeToTvlRatio,
      marketCap: open.metrics.marketCap,
      poolTvl: open.metrics.poolTvl,
      volume5m: open.metrics.volume5m,
      jupiterScore: open.metrics.jupiterScore,
      decision: "enter",
      currentPositionPool: "",
      metThreshold: open.metrics.metThreshold,
      binStep: pool.binStep,
      venue: pool.venue,
      fee30mUsd: pool.fee30mUsd,
      reason: open.reason,
      checkedAt: Date.now(),
    };
    const pos = config.dryRun
      ? await enterPositionDryRun(pool, check, open.solDeploy)
      : await this.executor!.enter(pool, check, open.solDeploy);
    this.state.positionSeq += 1;
    pos.id = `pos_${this.state.positionSeq}`;
    pos.strategy = open.strategy;
    const deployUsd = pos.solDeployed * (pool.solPrice || pos.solPrice || 0);
    pos.costsUsd += entryCostUsd({
      side: pool.side,
      deployUsd,
      txCostUsd: config.txCostUsd,
      swapBps: config.dryRun ? config.swapBps : Math.max(config.swapBps, 300),
    });
    this.state.book.entries += 1;
    this.state.seats.push(pos);
    this.syncActive();
    saveState(this.state);
    console.log(`[position] opened ${pos.id} ${pos.strategy} ${pos.venue} ${pos.side} ${pos.poolName} ${pos.solDeployed.toFixed(3)} SOL`);
    await this.telemetryEntry(pos);
    void this.pollFills();
  }

  /** The catalog scan stays on its interval. An open bid is watched on the pair account. */
  private armFillWatch(): void {
    if (this.fillTimer || config.dryRun || !this.executor) return;
    this.fillTimer = setInterval(() => {
      void this.pollFills();
    }, config.fillPollMs);
    void this.pollFills();
  }

  private async pollFills(): Promise<void> {
    if (!this.executor || config.dryRun) return;
    const seats = this.state.seats.filter((seat) => seat.side === "bid" && seat.minBinId === seat.maxBinId);
    if (!seats.length) {
      this.dropWatches();
      return;
    }
    if (this.fillPollFlight) return;
    this.fillPollFlight = this.readOpenPools(seats).finally(() => {
      this.fillPollFlight = null;
    });
    await this.fillPollFlight;
  }

  private async readOpenPools(seats: ActivePosition[]): Promise<void> {
    if (!this.executor) return;
    this.syncWatches(seats);
    const pools = [...new Set(seats.map((seat) => seat.poolAddress))];
    let found: Map<string, number>;
    try {
      found = await this.executor.poolActiveIds(pools);
    } catch {
      console.error("[fill] pool read failed");
      return;
    }
    for (const pool of pools) {
      const activeId = found.get(pool);
      if (activeId == null) continue;
      await this.onActiveBin(pool, activeId);
    }
  }

  private syncWatches(seats: ActivePosition[]): void {
    if (!this.executor) return;
    const wanted = new Set(seats.map((seat) => seat.poolAddress));
    for (const [pool, stop] of this.poolWatch) {
      if (wanted.has(pool)) continue;
      stop();
      this.poolWatch.delete(pool);
    }
    for (const pool of wanted) {
      if (this.poolWatch.has(pool)) continue;
      try {
        const stop = this.executor.watchPool(pool, (activeId) => {
          void this.onActiveBin(pool, activeId);
        });
        this.poolWatch.set(pool, stop);
        const name = seats.find((seat) => seat.poolAddress === pool)?.poolName ?? pool;
        console.log(`[fill] watching ${name}`);
      } catch {
        console.error("[fill] watch failed");
      }
    }
  }

  private dropWatches(): void {
    for (const stop of this.poolWatch.values()) stop();
    this.poolWatch.clear();
  }

  private async onActiveBin(poolAddress: string, activeId: number): Promise<void> {
    this.lastActiveId.set(poolAddress, activeId);
    const seats = this.state.seats.filter(
      (seat) => seat.poolAddress === poolAddress && seat.side === "bid" && seat.minBinId === seat.maxBinId,
    );
    for (const seat of seats) {
      const cycle = bidCycle(activeId, seat.minBinId, seat.maxBinId, seat.filled === true);
      // On the bin and still SOL. The open is not a fill. noteFills owns the meme balance.
      if (cycle === "wait" || cycle === "earn") continue;
      if (cycle === "hold") {
        seat.touched = true;
        console.log(`[fill] ${seat.poolName} holding bin ${seat.maxBinId} active ${activeId}`);
        continue;
      }
      if (cycle === "rest") {
        seat.touched = true;
        console.log(`[fill] ${seat.poolName} meme still in bin ${seat.maxBinId} active ${activeId}`);
        continue;
      }
      if (cycle === "chase") {
        const pool = this.lastPools.find((row) => row.poolAddress === poolAddress);
        const confirmed = pool ? chopConfirmed(pool) : false;
        if (pool && slideIntoActive(activeId, seat.maxBinId, seat.filled === true, seat.slides ?? 0, confirmed)) {
          await this.slideSeat(seat, pool);
        }
        continue;
      }
      if (cycle === "scratch" && seat.filled !== true) {
        if (!scratchNow(activeId, seat.minBinId)) {
          seat.touched = true;
          console.log(`[fill] ${seat.poolName} waits under bin ${seat.maxBinId} active ${activeId}`);
          continue;
        }
        console.log(`[fill] ${seat.poolName} bid left behind bin ${seat.maxBinId} active ${activeId}`);
        await this.closeSeat(seat, "bid left behind", "exit");
        continue;
      }
      if (cycle === "scratch" && seat.filled === true) {
        const binsDown = seat.minBinId - activeId;
        const pool = this.lastPools.find((row) => row.poolAddress === poolAddress);
        const unwind = Math.max(config.swapBps, 300);
        if (
          !filledShouldSell({
            binsUp: binsDown,
            binStep: seat.binStep || 80,
            unwindBps: unwind,
            feePct: pool ? collectedFeePct(pool) : 0,
            chopAlive: pool ? chopStillPays(pool) : true,
          })
        ) {
          seat.touched = true;
          console.log(`[fill] ${seat.poolName} meme waits under bin ${seat.maxBinId} active ${activeId}`);
          continue;
        }
      }
      if (cycle === "leave" && seat.filled === true) {
        const binsUp = activeId - seat.maxBinId;
        const pool = this.lastPools.find((row) => row.poolAddress === poolAddress);
        const unwind = Math.max(config.swapBps, 300);
        if (
          !filledShouldSell({
            binsUp,
            binStep: seat.binStep || 80,
            unwindBps: unwind,
            feePct: pool ? collectedFeePct(pool) : 0,
            chopAlive: pool ? chopStillPays(pool) : true,
          })
        ) {
          seat.touched = true;
          console.log(`[fill] ${seat.poolName} meme waits in bin ${seat.maxBinId} active ${activeId}`);
          continue;
        }
      }
      const reason = cycle === "leave" ? "bid left behind" : "scratched the fill";
      console.log(`[fill] ${seat.poolName} ${reason} bin ${seat.maxBinId} active ${activeId}`);
      await this.closeSeat(seat, reason, "exit");
    }
  }

  /** Add SOL to a one-bin bid that is still in the fee bin. A failed add leaves the seat open. */
  private scaleSeat(seat: ActivePosition, solDeploy: number): Promise<void> {
    const existing = this.scaleFlight.get(seat.id);
    if (existing) return existing;
    const flight = this.finishScale(seat, solDeploy).finally(() => {
      this.scaleFlight.delete(seat.id);
    });
    this.scaleFlight.set(seat.id, flight);
    return flight;
  }

  private async finishScale(seat: ActivePosition, solDeploy: number): Promise<void> {
    if (this.exitFlight.has(seat.id) || this.slideFlight.has(seat.id)) return;
    if (!this.state.seats.some((row) => row.id === seat.id) || seat.filled) return;
    const increment = solDeploy - seat.solDeployed;
    if (!(increment > 0)) return;
    const before = seat.solDeployed;

    let next = solDeploy;
    if (!config.dryRun && this.executor) {
      const result = await this.executor.addSol(seat, increment);
      if (!result.ok) {
        console.error(`[scale] ${seat.poolName} skipped: ${result.reason}`);
        return;
      }
      next = result.solDeployed;
      seat.entrySignature = result.signature;
    }

    seat.solDeployed = next;
    seat.costsUsd += config.txCostUsd;
    this.state.book.adjusts += 1;
    this.syncActive();
    saveState(this.state);
    console.log(`[scale] ${seat.poolName} ${before.toFixed(3)} -> ${seat.solDeployed.toFixed(3)} SOL`);
  }

  /** Step a SOL bid up one bin. A failed redeposit closes the seat without removing it twice. */
  private slideSeat(seat: ActivePosition, pool: PoolCandidate | undefined): Promise<void> {
    const existing = this.slideFlight.get(seat.id);
    if (existing) return existing;
    const flight = this.finishSlide(seat, pool).finally(() => {
      this.slideFlight.delete(seat.id);
    });
    this.slideFlight.set(seat.id, flight);
    return flight;
  }

  private async finishSlide(seat: ActivePosition, pool: PoolCandidate | undefined): Promise<void> {
    if (this.exitFlight.has(seat.id)) return;
    if ((seat.slides ?? 0) >= MAX_BID_SLIDES) {
      await this.closeSeat(seat, "bid left behind", "exit");
      return;
    }
    const now = Date.now();
    if (now - (seat.slidAt ?? 0) < 60_000) return;

    const step = Math.max(seat.binStep || pool?.binStep || 80, 1) / 10_000;
    const price = pool?.priceUsd && pool.priceUsd > 0 ? pool.priceUsd : seat.entryPrice * (1 + step);

    if (!config.dryRun && this.executor) {
      const result = await this.executor.slideSolBid(seat);
      if (!result.ok) {
        if (result.flat) {
          seat.costsUsd += config.txCostUsd;
          await this.closeSeat(seat, "slide failed; bid removed", "exit", true);
        } else if (result.reason === "meme still in the bid" || result.reason === "runner") {
          await this.closeSeat(seat, "bid left behind", "exit");
        } else {
          console.error(`[slide] ${seat.poolName} skipped: ${result.reason}`);
        }
        return;
      }
      seat.positionAddress = result.positionAddress;
      seat.minBinId = result.minBinId;
      seat.maxBinId = result.maxBinId;
      seat.solDeployed = result.solDeployed;
      seat.entrySignature = result.signature;
    } else {
      const next = seat.maxBinId + 1;
      seat.minBinId = next;
      seat.maxBinId = next;
      console.log(`[dry-run slide] ${seat.poolName} bin ${next}`);
    }

    const band = priceBand(price, seat.rangeHalfWidth || 0.06, "bid");
    seat.entryPrice = price;
    seat.lastPrice = price;
    seat.priceLower = band.lower;
    seat.priceUpper = band.upper;
    seat.filled = false;
    seat.touched = false;
    seat.slides = (seat.slides ?? 0) + 1;
    seat.slidAt = now;
    seat.costsUsd += config.txCostUsd * 2;
    this.state.book.adjusts += 1;
    this.syncActive();
    saveState(this.state);
    console.log(`[slide] ${seat.poolName} bin ${seat.maxBinId} slides=${seat.slides}`);
  }

  getSnapshot(): BotSnapshot {
    return {
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      paused: this.paused,
      loopRunning: this.loopRunning,
      scanCount: this.scanCount,
      lastScanAt: this.lastScanAt,
      lastError: this.lastError,
      lastScan: this.lastScan,
      scanHistory: this.scanHistory,
      activePosition: this.state.active,
      seats: this.state.seats,
      closedCount: this.state.closed.length,
      recentCloses: [...this.state.closed]
        .sort((a, b) => (b.exitedAt ?? b.lastMarkAt ?? 0) - (a.exitedAt ?? a.lastMarkAt ?? 0))
        .slice(0, 12)
        .map((seat) => ({
          poolName: seat.poolName,
          strategy: seat.strategy ?? "core",
          side: seat.side,
          solDeployed: seat.solDeployed,
          netUsd: seat.feesAccruedUsd - seat.ilUsd - seat.costsUsd,
          feesUsd: seat.feesAccruedUsd,
          ilUsd: seat.ilUsd,
          costsUsd: seat.costsUsd,
          reason: seat.exitReason ?? "",
          at: seat.exitedAt ?? seat.lastMarkAt ?? 0,
        })),
      book: this.state.book,
      growth: this.growthView(),
      scanMs: this.lastScanMs,
      poolCounts: this.poolCounts,
      config: {
        dryRun: config.dryRun,
        mirrorOriginal: config.mirrorOriginal,
        solDeploy: this.deploySol,
        scanIntervalMs: config.scanIntervalMs,
        fillPollMs: config.fillPollMs,
        proofnetworkTelemetry: config.proofnetworkTelemetry,
        proofnetworkContract: config.proofnetworkContract,
        walletConfigured: Boolean(this.executor),
        walletPublicKey: this.walletPublicKey,
      },
    };
  }

  armWallet(secret: string): { publicKey: string } {
    if (config.dryRun) throw new Error("This desk is in paper mode");
    const kp = saveWalletSecret(secret);
    this.executor = DlmmExecutor.fromKeypair(kp);
    this.walletPublicKey = kp.publicKey.toBase58();
    this.lastError = null;
    this.announcedKey = true;
    this.kick = true;
    this.armFillWatch();
    console.log(`[live] wallet armed ${this.walletPublicKey}`);
    return { publicKey: this.walletPublicKey };
  }

  private refreshDeploy(): number {
    const growth = ensureGrowth(this.state);
    const priced = this.state.seats.find((seat) => seat.solPrice > 0);
    const equity = equitySol({
      startSol: growth.startSol,
      realizedSol: growth.realizedSol,
      openNetUsd: this.openNetUsd(),
      solPrice: priced?.solPrice || 0,
    });
    this.deploySol = deploySolFor(equity, config.growthRisk);
    return equity;
  }

  private growthView(): BotSnapshot["growth"] {
    const growth: GrowthLedger = ensureGrowth(this.state);
    const equity = this.refreshDeploy();
    return {
      startSol: growth.startSol,
      targetSol: growth.targetSol,
      equitySol: equity,
      realizedSol: growth.realizedSol,
      paceSol: paceSol({
        startSol: growth.startSol,
        targetSol: growth.targetSol,
        startedAt: growth.startedAt,
        now: Date.now(),
        weekMs: config.growthWeekMs,
      }),
      deploySol: this.deploySol,
      startedAt: growth.startedAt,
    };
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  async run() {
    await this.startLoop();
  }

  async startLoop() {
    console.log("Degen LP Bot starting");
    console.log(
      `mode=${config.dryRun ? "DRY_RUN" : "LIVE"} venues=${config.venues.join(",")} mirror=${config.mirrorOriginal}`,
    );
    const growth = ensureGrowth(this.state);
    const equity = this.refreshDeploy();
    console.log(
      `telemetry=${!!this.telemetry} bankroll=${growth.startSol} equity=${equity.toFixed(3)} deploy=${this.deploySol.toFixed(3)} every=${config.scanIntervalMs}ms fill=${config.fillPollMs}ms`,
    );
    this.armFillWatch();

    await this.sendStartupAlert();
    this.loopRunning = true;

    while (this.loopRunning) {
      if (!this.paused) {
        try {
          await this.reconcileActive();
          await this.scanOnce();
          if (this.liveReady()) this.lastError = null;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.lastError = msg;
          console.error("[error]", err);
          if (msg.includes("remains in the wallet")) {
            this.paused = true;
            console.error("[live] paused so a second swap does not fire");
          }
        }
      }
      await this.sweepLeftovers();
      await this.waitInterval();
    }
  }

  /** Sell meme tokens that a close left in the wallet. Buys stay on the 3% cap. */
  private async sweepLeftovers(): Promise<void> {
    if (config.dryRun || !this.executor) return;
    let rows: Array<{ mint: string; amount: bigint }> = [];
    try {
      rows = await this.executor.memeBalances();
    } catch {
      console.error("[sweep] balance read failed");
      return;
    }
    const now = Date.now();
    for (const row of rows) {
      if ((this.sweepHold.get(row.mint) ?? 0) > now) continue;
      const settled = await this.executor.settleMeme(row.mint);
      if (settled === "swapped") this.sweepHold.delete(row.mint);
      else if (settled === "stuck") this.sweepHold.set(row.mint, now + 15_000);
    }
  }

  private async waitInterval() {
    let left = config.scanIntervalMs;
    while (left > 0 && this.loopRunning) {
      if (this.kick) {
        this.kick = false;
        return;
      }
      const slice = Math.min(250, left);
      await sleep(slice);
      left -= slice;
    }
  }

  private async sendStartupAlert() {
    if (!this.telemetry || this.started) return;
    this.started = true;
    try {
      await this.telemetry.createAlert(
        "bot_started",
        "info",
        "Bot Started",
        "Degen LP Bot clone started",
        { startTime: new Date().toISOString(), solDeploy: config.solDeploy },
      );
    } catch (err) {
      console.error("[telemetry] startup alert failed:", err);
    }
  }

  private async reconcileActive() {
    if (!this.executor || !this.state.seats.length) return;
    for (const seat of [...this.state.seats]) {
      // A close or a slide already owns this seat. Pushing it again wrote the same loss twice.
      if (this.exitFlight.has(seat.id) || this.slideFlight.has(seat.id)) continue;
      const exists = await this.executor.positionExists(seat.positionAddress);
      if (exists) continue;
      if (this.exitFlight.has(seat.id) || this.slideFlight.has(seat.id)) continue;
      if (!this.state.seats.some((row) => row.id === seat.id)) continue;
      console.log(`[reconcile] ${seat.poolName} gone on-chain, closing once`);
      await this.closeSeat(seat, "Position not found on-chain - already closed", "exit", true);
    }
  }

  private async telemetryEntry(pos: ActivePosition) {
    if (!this.telemetry) return;
    try {
      await this.telemetry.recordPositionEntry(pos);
    } catch (err) {
      console.error("[telemetry] entry:", err);
    }
  }

  private async telemetryExit(pos: ActivePosition, reason: string, sig: string) {
    if (!this.telemetry) return;
    try {
      await this.telemetry.recordPositionExit(pos.id, 0, 0, reason, sig);
    } catch (err) {
      console.error("[telemetry] exit:", err);
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}