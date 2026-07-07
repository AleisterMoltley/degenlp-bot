import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import nacl from "tweetnacl";
import { config } from "./config.js";
import type { ActivePosition, OpportunityCheck } from "./types.js";

const API = "https://proofnetwork.lol/api/blockchain";
const UA = "degenlp-bot/1.0";

export class ProofNetworkTelemetry {
  private wallet: Keypair;

  constructor(wallet: Keypair) {
    this.wallet = wallet;
  }

  static fromEnv(): ProofNetworkTelemetry {
    if (!config.walletPrivateKey) {
      throw new Error("WALLET_PRIVATE_KEY required for ProofNetwork telemetry");
    }
    return new ProofNetworkTelemetry(Keypair.fromSecretKey(bs58.decode(config.walletPrivateKey)));
  }

  get walletAddress(): string {
    return this.wallet.publicKey.toBase58();
  }

  private challenge(): string {
    return `degenlp-db:write:${this.walletAddress} ${Date.now()}`;
  }

  private sign(message: string): string {
    const bytes = new TextEncoder().encode(message);
    const sig = nacl.sign.detached(bytes, this.wallet.secretKey);
    return bs58.encode(sig);
  }

  private authFields() {
    const message = this.challenge();
    return {
      from: this.walletAddress,
      message,
      signature: this.sign(message),
    };
  }

  async call(functionName: string, inputs: Record<string, unknown>) {
    if (!config.proofnetworkContract) {
      throw new Error("PROOFNETWORK_CONTRACT not set — run npm run deploy-contract first");
    }

    const body = {
      contractAddress: config.proofnetworkContract,
      functionName,
      inputs: { ...inputs, ...this.authFields() },
      from: this.walletAddress,
    };

    const res = await fetch(`${API}/contracts/call`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": UA,
        Referer: "https://proofnetwork.lol/",
      },
      body: JSON.stringify(body),
    });

    const data = (await res.json()) as {
      success?: boolean;
      error?: string;
      transaction?: { outputs?: unknown; status?: string };
    };

    if (!res.ok || data.success === false) {
      throw new Error(data.error ?? `ProofNetwork call failed: ${res.status}`);
    }

    return data;
  }

  async recordOpportunityCheck(check: OpportunityCheck) {
    return this.call("recordOpportunityCheck", {
      check: {
        pool_address: check.poolAddress,
        pool_name: check.poolName,
        token_symbol: check.tokenSymbol,
        token_mint: check.tokenMint,
        opportunity_score: check.opportunityScore,
        volume_to_tvl_ratio: check.volumeToTvlRatio,
        volume_to_mcap_ratio: check.volumeToMcapRatio,
        fee_to_tvl_ratio: check.feeToTvlRatio,
        market_cap: check.marketCap,
        pool_tvl: check.poolTvl,
        volume_5m: check.volume5m,
        jupiter_score: check.jupiterScore,
        decision: check.decision,
        current_position_pool: check.currentPositionPool,
        met_threshold: check.metThreshold,
      },
    });
  }

  async recordSystemHealth(rpcLatencyMs: number, rpcHealthy: boolean, activePositions: number) {
    return this.call("recordSystemHealth", {
      rpcLatencyMs,
      rpcHealthy,
      activePositions,
    });
  }

  async recordPositionEntry(position: ActivePosition) {
    return this.call("recordPositionEntry", {
      position: {
        position_address: position.positionAddress,
        pool_address: position.poolAddress,
        pool_name: position.poolName,
        base_token_symbol: position.baseTokenSymbol,
        quote_token_symbol: position.quoteTokenSymbol,
        bin_step: position.binStep,
        min_bin_id: position.minBinId,
        max_bin_id: position.maxBinId,
        sol_deployed: position.solDeployed,
        entry_price: position.entryPrice,
        fee_tvl_ratio_at_entry: position.feeTvlRatioAtEntry,
        liquidity_at_entry: position.liquidityAtEntry,
        opportunity_score_at_entry: position.opportunityScoreAtEntry,
        market_cap_at_entry: position.marketCapAtEntry,
        jupiter_score_at_entry: position.jupiterScoreAtEntry,
        entry_signature: position.entrySignature,
      },
    });
  }

  async recordPositionExit(
    positionId: string,
    exitPrice: number,
    feesCollected: number,
    exitReason: string,
    txSignature: string,
  ) {
    return this.call("recordPositionExit", {
      positionId,
      exitPrice,
      feesCollected,
      exitReason,
      txSignature,
    });
  }

  async createAlert(alertType: string, severity: string, title: string, body: string, meta?: object) {
    return this.call("createAlert", {
      alertType,
      severity,
      title,
      body,
      meta: meta ?? null,
    });
  }
}

export async function deployDatabaseContract(walletAddress: string): Promise<string> {
  const code = readFileSync(join(process.cwd(), "contracts/DegenLPDatabase.js"), "utf8");

  const body = {
    name: "DegenLPDatabase",
    description: "Position tracking and telemetry store for degen LP bot (clone)",
    code,
    abi: [],
    template: null,
    owner: walletAddress,
    from: walletAddress,
  };

  const res = await fetch(`${API}/contracts/deploy`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": UA,
      Referer: "https://proofnetwork.lol/",
    },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as { success?: boolean; address?: string; error?: string };
  if (!res.ok || !data.address) {
    throw new Error(data.error ?? `Deploy failed: ${res.status}`);
  }

  return data.address;
}

export async function measureRpcLatency(rpcUrl: string): Promise<{ healthy: boolean; ms: number }> {
  const start = Date.now();
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
    });
    const ok = res.ok;
    return { healthy: ok, ms: Date.now() - start };
  } catch {
    return { healthy: false, ms: Date.now() - start };
  }
}