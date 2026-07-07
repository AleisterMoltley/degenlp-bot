import { buildCandidates, fetchOriginalOpportunityChecks, fetchTopPumpTokens } from "./apis.js";
import { config } from "./config.js";
import { DlmmExecutor, enterPositionDryRun } from "./executor.js";
import { measureRpcLatency, ProofNetworkTelemetry } from "./proofnetwork.js";
import { pickBestCandidate, decide } from "./scorer.js";
import { loadState, saveState, type BotState } from "./state.js";
import { computeMetrics } from "./scorer.js";
import type { ActivePosition, OpportunityCheck, PoolCandidate } from "./types.js";

export interface ScanRecord {
  at: string;
  check: OpportunityCheck;
  topCandidates: Array<{
    poolName: string;
    tokenSymbol: string;
    opportunityScore: number;
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

  constructor() {
    this.state = loadState();
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
    const tokens = await fetchTopPumpTokens(config.topTokensLimit);
    const candidates = await buildCandidates(tokens);
    this.lastTopCandidates = this.rankCandidates(candidates);
    const best = pickBestCandidate(candidates);
    const check = decide(best, this.state.active);

    console.log(
      `[scan] decision=${check.decision} pool=${check.poolName} score=${check.opportunityScore.toFixed(3)} met=${check.metThreshold}`,
    );

    await this.applyDecision(check, best);
    await this.pushTelemetry(check);
    this.recordScan(check);
    return check;
  }

  private rankCandidates(candidates: PoolCandidate[]): ScanRecord["topCandidates"] {
    return candidates
      .map((c) => {
        const m = computeMetrics(c);
        return {
          poolName: c.poolName,
          tokenSymbol: c.tokenSymbol,
          opportunityScore: m.opportunityScore,
          metThreshold: m.metThreshold,
        };
      })
      .sort((a, b) => b.opportunityScore - a.opportunityScore)
      .slice(0, 10);
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

  private async applyDecision(
    check: OpportunityCheck,
    candidate: Awaited<ReturnType<typeof pickBestCandidate>>,
  ) {
    if (!this.executor && !config.dryRun) {
      this.executor = DlmmExecutor.fromEnv();
    }

    const exec = this.executor;

    if (check.decision === "exit" && this.state.active) {
      const active = this.state.active;
      if (exec) {
        const exists = await exec.positionExists(active.positionAddress);
        const reason = exists
          ? "rotation / threshold miss"
          : "Position not found on-chain - already closed";
        const sig = await exec.exit(active, reason);
        active.status = "closed";
        active.entrySignature = sig;
        this.state.closed.push(active);
        this.state.active = null;
        saveState(this.state);
        await this.telemetryExit(active, reason, sig);
      } else if (config.dryRun) {
        console.log(`[dry-run exit] ${active.poolName}`);
        active.status = "closed";
        this.state.closed.push(active);
        this.state.active = null;
        saveState(this.state);
        await this.telemetryExit(active, "dry-run exit", "dry_run_exit");
      }
      return;
    }

    if (check.decision === "enter" && candidate && !this.state.active) {
      if (exec || config.dryRun) {
        const pos = config.dryRun
          ? await enterPositionDryRun(candidate, check)
          : await exec!.enter(candidate, check);
        this.state.positionSeq += 1;
        pos.id = `pos_${this.state.positionSeq}`;
        this.state.active = pos;
        saveState(this.state);
        console.log(`[position] opened ${pos.id} ${pos.poolName}`);
        await this.telemetryEntry(pos);
      }
      return;
    }

    if (check.decision === "stay" && this.state.active) {
      console.log(`[stay] ${this.state.active.poolName}`);
    }
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
      config: {
        dryRun: config.dryRun,
        mirrorOriginal: config.mirrorOriginal,
        solDeploy: config.solDeploy,
        scanIntervalMs: config.scanIntervalMs,
        proofnetworkTelemetry: config.proofnetworkTelemetry,
        proofnetworkContract: config.proofnetworkContract,
        walletConfigured: Boolean(config.walletPrivateKey),
      },
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
    console.log(`mode=${config.dryRun ? "DRY_RUN" : "LIVE"} mirror=${config.mirrorOriginal}`);
    console.log(`telemetry=${!!this.telemetry} solDeploy=${config.solDeploy}`);

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