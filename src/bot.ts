import { buildCandidates, fetchOriginalOpportunityChecks, fetchTopPumpTokens } from "./apis.js";
import { config } from "./config.js";
import { deploySolFor, equitySol, paceSol } from "./growth.js";
import { DlmmExecutor, enterPositionDryRun } from "./executor.js";
import { fetchMeteoraCandidates } from "./meteora.js";
import { accrueFees, entryCostUsd, markIlUsd } from "./pnl.js";
import { hydratePosition } from "./position.js";
import { measureRpcLatency, ProofNetworkTelemetry } from "./proofnetwork.js";
import { decide, planPosition, planToCheck, rankPools, type Plan, type RankedPool } from "./scorer.js";
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

  constructor() {
    this.state = loadState();
    ensureGrowth(this.state);
    if (this.state.active) this.state.active = hydratePosition(this.state.active);
    if (!config.dryRun) {
      this.executor = DlmmExecutor.fromEnv();
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
    const holding = this.state.active?.poolAddress;
    const tradable = (config.dryRun ? candidates : candidates.filter((pool) => pool.venue === "dlmm")).filter(
      (pool) => pool.poolAddress === holding || (this.cooloff.get(pool.poolAddress) ?? 0) <= now,
    );
    const equity = this.refreshDeploy();
    const ranked = rankPools(tradable, { deploySol: this.deploySol, growth: true });
    this.lastScanMs = Date.now() - started;
    this.poolCounts = {
      dlmm: candidates.filter((pool) => pool.venue === "dlmm").length,
      damm_v2: candidates.filter((pool) => pool.venue === "damm_v2").length,
      damm_v1: candidates.filter((pool) => pool.venue === "damm_v1").length,
    };
    this.lastTopCandidates = ranked.slice(0, 8).map((row) => ({
      poolName: row.pool.poolName,
      tokenSymbol: row.pool.tokenSymbol,
      venue: row.pool.venue,
      side: row.pool.side,
      opportunityScore: row.metrics.opportunityScore,
      edgeUsd: row.metrics.edgeUsd,
      fee30m: row.pool.fee30mUsd,
      metThreshold: row.metrics.metThreshold,
    }));
    if (this.state.active) this.state.active = hydratePosition(this.state.active);
    if (this.state.active) {
      const seen = ranked.some((row) => row.pool.poolAddress === this.state.active?.poolAddress);
      this.state.active.scanMisses = seen ? 0 : (this.state.active.scanMisses ?? 0) + 1;
    }
    this.markActive(ranked);
    saveState(this.state);
    const plan = planPosition({
      ranked,
      active: this.state.active,
      now: Date.now(),
      deploySol: this.deploySol,
      lossCut: config.growthLossCut,
    });
    const check = planToCheck(plan, this.state.active, Date.now());

    console.log(
      `[scan] ${check.decision} ${check.venue ?? "none"} ${plan.pool?.side ?? ""} ${check.poolName} edge=$${((plan.metrics?.edgeUsd) ?? 0).toFixed(3)} deploy=${this.deploySol.toFixed(3)} equity=${equity.toFixed(3)} ${plan.reason} ${this.lastScanMs}ms pools=${candidates.length} dlmm=${this.poolCounts.dlmm} damm2=${this.poolCounts.damm_v2} damm1=${this.poolCounts.damm_v1}`,
    );

    await this.applyPlan(plan, check);
    await this.pushTelemetry(check);
    this.recordScan(check);
    this.logBook();
    return check;
  }

  private markActive(ranked: RankedPool[]) {
    if (!config.dryRun || !this.state.active) return;
    const pos = this.state.active;
    const row = ranked.find((item) => item.pool.poolAddress === pos.poolAddress);
    const now = Date.now();
    const elapsedMin = Math.min(
      (config.scanIntervalMs / 60_000) * 1.5,
      Math.max(0, (now - pos.lastMarkAt) / 60_000),
    );
    const pool = row?.pool;
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
    const open = this.state.active;
    const openNet = open ? open.feesAccruedUsd - open.ilUsd - open.costsUsd : 0;
    console.log(
      `[book] realized=$${book.realizedUsd.toFixed(4)} fees=$${book.feesUsd.toFixed(4)} il=$${book.ilUsd.toFixed(4)} costs=$${book.costsUsd.toFixed(4)} open=$${openNet.toFixed(4)} entries=${book.entries} exits=${book.exits} adjusts=${book.adjusts} rotates=${book.rotates}`,
    );
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
        this.state.active ? 1 : 0,
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
    if (!this.executor && !config.dryRun) {
      this.executor = DlmmExecutor.fromEnv();
    }

    const closes = plan.action === "exit" || plan.action === "adjust" || plan.action === "rotate";
    const opens = plan.action === "enter" || plan.action === "adjust" || plan.action === "rotate";

    if (closes && this.state.active) {
      await this.closeActive(plan.reason, plan.action);
    }
    if (opens && plan.pool && !this.state.active) {
      await this.openActive(plan.pool, check);
    }
    if (plan.action === "stay" && this.state.active) {
      const pos = this.state.active;
      const net = pos.feesAccruedUsd - pos.ilUsd - pos.costsUsd;
      console.log(
        `[stay] ${pos.venue} ${pos.poolName} fees=$${pos.feesAccruedUsd.toFixed(4)} il=$${pos.ilUsd.toFixed(4)} net=$${net.toFixed(4)}`,
      );
    }
  }

  private async closeActive(reason: string, action: BotDecision) {
    const active = this.state.active;
    if (!active) return;

    let sig = "dry_run_exit";
    if (!config.dryRun && this.executor) {
      const exists = await this.executor.positionExists(active.positionAddress);
      sig = await this.executor.exit(active, exists ? reason : "Position not found on-chain - already closed");
    } else {
      console.log(`[dry-run exit] ${active.venue} ${active.poolName} ${reason}`);
      active.costsUsd += config.txCostUsd;
    }

    if (/divergence|edge gone|left the range|left the fee list|risk budget/.test(reason)) {
      this.cooloff.set(active.poolAddress, Date.now() + 15 * 60_000);
    }
    const net = active.feesAccruedUsd - active.ilUsd - active.costsUsd;
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
    if (this.state.closed.length > 40) this.state.closed.length = 40;
    this.state.active = null;
    saveState(this.state);
    console.log(`[closed] ${active.poolName} net=$${net.toFixed(4)} book=$${this.state.book.realizedUsd.toFixed(4)}`);
    await this.telemetryExit(active, reason, sig);
  }

  private async openActive(pool: PoolCandidate, check: OpportunityCheck) {
    if (!config.dryRun && pool.venue !== "dlmm") {
      throw new Error(`live signing is DLMM-only, skipped ${pool.venue} ${pool.poolName}`);
    }
    const solDeploy = this.deploySol;
    const pos = config.dryRun
      ? await enterPositionDryRun(pool, check, solDeploy)
      : await this.executor!.enter(pool, check, solDeploy);
    this.state.positionSeq += 1;
    pos.id = `pos_${this.state.positionSeq}`;
    pos.solDeployed = solDeploy;
    if (config.dryRun) {
      const deployUsd = solDeploy * (pool.solPrice || pos.solPrice || 0);
      pos.costsUsd += entryCostUsd({
        side: pool.side,
        deployUsd,
        txCostUsd: config.txCostUsd,
        swapBps: config.swapBps,
      });
    }
    this.state.book.entries += 1;
    this.state.active = pos;
    saveState(this.state);
    console.log(`[position] opened ${pos.id} ${pos.venue} ${pos.side} ${pos.poolName} ${pos.solDeployed.toFixed(3)} SOL`);
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
        walletConfigured: Boolean(config.walletPrivateKey),
      },
    };
  }

  private refreshDeploy(): number {
    const growth = ensureGrowth(this.state);
    const open = this.state.active;
    const openNet = open ? open.feesAccruedUsd - open.ilUsd - open.costsUsd : 0;
    const equity = equitySol({
      startSol: growth.startSol,
      realizedSol: growth.realizedSol,
      openNetUsd: openNet,
      solPrice: open?.solPrice || 0,
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
      `telemetry=${!!this.telemetry} bankroll=${growth.startSol} equity=${equity.toFixed(3)} target=${growth.targetSol} deploy=${this.deploySol.toFixed(3)} every=${config.scanIntervalMs}ms`,
    );

    await this.sendStartupAlert();
    this.loopRunning = true;

    while (this.loopRunning) {
      if (!this.paused) {
        try {
          await this.reconcileActive();
          await this.scanOnce();
          this.lastError = null;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.lastError = msg;
          console.error("[error]", err);
        }
      }
      await sleep(config.scanIntervalMs);
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
    if (!this.state.active || !this.executor) return;
    const exists = await this.executor.positionExists(this.state.active.positionAddress);
    if (!exists) {
      console.log("[reconcile] active position gone on-chain, clearing state");
      const active = this.state.active;
      active.status = "closed";
      this.state.closed.push(active);
      this.state.active = null;
      saveState(this.state);
      await this.telemetryExit(active, "Position not found on-chain - already closed", `reconciliation_${active.positionAddress}_${Date.now()}`);
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