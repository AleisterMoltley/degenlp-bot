import { buildCandidates, fetchOriginalOpportunityChecks, fetchTopPumpTokens } from "./apis.js";
import { config } from "./config.js";
import { deploySolFor, equitySol, paceSol } from "./growth.js";
import { DlmmExecutor, enterPositionDryRun } from "./executor.js";
import { loadWalletKeypair, saveWalletSecret } from "./wallet.js";
import { fetchMeteoraCandidates } from "./meteora.js";
import { accrueFees, entryCostUsd, markIlUsd } from "./pnl.js";
import { hydratePosition } from "./position.js";
import { measureRpcLatency, ProofNetworkTelemetry } from "./proofnetwork.js";
import { planFleet, coolsOff, downwardMove, type FleetOpen, type FleetPlan } from "./fleet.js";
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
    if (config.mirrorOriginal) {
      return this.mirrorScan();
    }
    return this.independentScan();
  }

  private async independentScan(): Promise<OpportunityCheck> {
    const started = Date.now();
    const candidates = await fetchMeteoraCandidates();
    const now = Date.now();
    const held = new Set(this.state.seats.map((seat) => seat.poolAddress));
    const tradable = candidates.filter((pool) => {
      if (held.has(pool.poolAddress)) return true;
      if ((this.cooloff.get(pool.poolAddress) ?? 0) > now) return false;
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
    const plan = planFleet({
      pools: tradable,
      seats: this.state.seats,
      deploySol: this.deploySol,
      now,
      lossCut: config.growthLossCut,
      dlmmOnly: !config.dryRun,
      moves: this.movesFor(candidates, now),
      freezeOpens: now < this.freezeUntil,
    });
    this.lastTopCandidates = plan.preview.map((row) => ({
      poolName: row.poolName,
      tokenSymbol: row.tokenSymbol,
      venue: row.venue,
      side: row.side,
      opportunityScore: row.opportunityScore,
      edgeUsd: row.edgeUsd,
      fee30m: row.fee30m,
      metThreshold: row.metThreshold,
      strategy: row.strategy,
    }));
    saveState(this.state);
    const check = this.fleetCheck(plan, now);

    console.log(
      `[scan] ${check.decision} seats=${this.state.seats.length} deploy=${this.deploySol.toFixed(3)} equity=${equity.toFixed(3)} ${plan.summary} ${this.lastScanMs}ms pools=${candidates.length} dlmm=${this.poolCounts.dlmm} damm2=${this.poolCounts.damm_v2} damm1=${this.poolCounts.damm_v1}`,
    );

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
    if (pool && deployUsd > 0) {
      pos.feesAccruedUsd += accrueFees({
        fees30mUsd: pool.fee30mUsd,
        tvlUsd: pool.pairLiquidityUsd,
        deployUsd,
        elapsedMin,
        inRange: pos.side === "full" || inside,
        side: pos.side,
        rangeHalfWidth: pos.rangeHalfWidth,
      });
      pos.ilUsd = markIlUsd({
        deployUsd,
        entryPrice: pos.entryPrice,
        price,
        lower: pos.priceLower,
        upper: pos.priceUpper,
        side: pos.side,
      });
      pos.solPrice = sol;
    } else if (!pool && deployUsd > 0) {
      pos.ilUsd = Math.max(pos.ilUsd, deployUsd * 0.5);
    }
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
    for (const close of plan.closes) {
      const seat = this.state.seats.find((row) => row.id === close.id);
      if (!seat) continue;
      await this.closeSeat(seat, close.reason, close.action);
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

  private async closeSeat(active: ActivePosition, reason: string, action: BotDecision) {
    let sig = "dry_run_exit";
    if (!config.dryRun && this.executor) {
      const exists = await this.executor.positionExists(active.positionAddress);
      sig = await this.executor.exit(active, exists ? reason : "Position not found on-chain - already closed");
      const settled = await this.executor.settleMeme(active.tokenMint);
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
      book: this.state.book,
      growth: this.growthView(),
      scanMs: this.lastScanMs,
      poolCounts: this.poolCounts,
      config: {
        dryRun: config.dryRun,
        mirrorOriginal: config.mirrorOriginal,
        solDeploy: this.deploySol,
        scanIntervalMs: config.scanIntervalMs,
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
      `telemetry=${!!this.telemetry} bankroll=${growth.startSol} equity=${equity.toFixed(3)} deploy=${this.deploySol.toFixed(3)} every=${config.scanIntervalMs}ms`,
    );

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
      await this.waitInterval();
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
    const gone: ActivePosition[] = [];
    for (const seat of this.state.seats) {
      const exists = await this.executor.positionExists(seat.positionAddress);
      if (!exists) gone.push(seat);
    }
    if (!gone.length) return;
    for (const active of gone) {
      console.log(`[reconcile] ${active.poolName} gone on-chain, clearing state`);
      active.status = "closed";
      this.state.closed.push(active);
      this.state.seats = this.state.seats.filter((seat) => seat.id !== active.id);
      await this.telemetryExit(active, "Position not found on-chain - already closed", `reconciliation_${active.positionAddress}_${Date.now()}`);
    }
    this.syncActive();
    saveState(this.state);
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