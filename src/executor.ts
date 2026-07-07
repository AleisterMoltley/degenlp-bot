import DLMM, { StrategyType } from "@meteora-ag/dlmm";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { config } from "./config.js";
import type { ActivePosition, OpportunityCheck, PoolCandidate } from "./types.js";

export class DlmmExecutor {
  private connection: Connection;
  private wallet: Keypair;

  constructor(connection: Connection, wallet: Keypair) {
    this.connection = connection;
    this.wallet = wallet;
  }

  static fromEnv(): DlmmExecutor {
    if (!config.walletPrivateKey) {
      throw new Error("WALLET_PRIVATE_KEY missing — set it in .env for live mode");
    }
    const secret = Keypair.fromSecretKey(bs58.decode(config.walletPrivateKey));
    const connection = new Connection(config.rpcUrl, "confirmed");
    return new DlmmExecutor(connection, secret);
  }

  async positionExists(positionAddress: string): Promise<boolean> {
    const info = await this.connection.getAccountInfo(new PublicKey(positionAddress));
    return info !== null;
  }

  async enter(candidate: PoolCandidate, check: OpportunityCheck): Promise<ActivePosition> {
    const positionKp = Keypair.generate();
    const poolPk = new PublicKey(candidate.poolAddress);
    const dlmm = await DLMM.create(this.connection, poolPk);

    const active = await dlmm.getActiveBin();
    const maxBinId = active.binId - 1;
    const minBinId = active.binId - config.binRange;
    const solLamports = Math.floor(config.solDeploy * 1e9);

    const tokenX = dlmm.tokenX.publicKey.toBase58();
    const tokenY = dlmm.tokenY.publicKey.toBase58();
    const isSolY = tokenY === "So11111111111111111111111111111111111111112";

    const totalXAmount = new BN(isSolY ? 0 : solLamports);
    const totalYAmount = new BN(isSolY ? solLamports : 0);

    console.log(
      `[enter] ${candidate.poolName} bins ${minBinId}..${maxBinId} deploy ${config.solDeploy} SOL`,
    );

    let entrySignature = "dry_run";
    if (!config.dryRun) {
      const tx = await dlmm.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: positionKp.publicKey,
        user: this.wallet.publicKey,
        totalXAmount,
        totalYAmount,
        strategy: {
          minBinId,
          maxBinId,
          strategyType: StrategyType.Spot,
        },
      });
      entrySignature = await sendAndConfirmTransaction(this.connection, tx, [
        this.wallet,
        positionKp,
      ]);
    }

    return {
      id: "",
      poolAddress: candidate.poolAddress,
      poolName: candidate.poolName,
      baseTokenSymbol: candidate.tokenSymbol,
      quoteTokenSymbol: "SOL",
      binStep: check.binStep ?? 0,
      positionAddress: positionKp.publicKey.toBase58(),
      minBinId,
      maxBinId,
      solDeployed: config.solDeploy,
      entryPrice: candidate.priceUsd,
      feeTvlRatioAtEntry: check.feeToTvlRatio,
      liquidityAtEntry: candidate.pairLiquidityUsd,
      opportunityScoreAtEntry: check.opportunityScore,
      marketCapAtEntry: candidate.marketCap,
      jupiterScoreAtEntry: check.jupiterScore,
      entrySignature,
      tokenMint: candidate.tokenMint,
      status: "active",
      enteredAt: Date.now(),
    };
  }

  async exit(position: ActivePosition, reason: string): Promise<string> {
    console.log(`[exit] ${position.poolName} reason=${reason}`);

    if (config.dryRun) {
      return `dry_run_exit_${position.positionAddress}`;
    }

    const poolPk = new PublicKey(position.poolAddress);
    const dlmm = await DLMM.create(this.connection, poolPk);
    const positionPk = new PublicKey(position.positionAddress);

    const txs = await dlmm.removeLiquidity({
      position: positionPk,
      user: this.wallet.publicKey,
      fromBinId: position.minBinId,
      toBinId: position.maxBinId,
      bps: new BN(10_000),
      shouldClaimAndClose: true,
    });

    let lastSig = "";
    for (const tx of txs) {
      lastSig = await sendAndConfirmTransaction(this.connection, tx, [this.wallet]);
    }
    return lastSig;
  }
}

export async function enterPositionDryRun(
  candidate: PoolCandidate,
  check: OpportunityCheck,
): Promise<ActivePosition> {
  return {
    id: "",
    poolAddress: candidate.poolAddress,
    poolName: candidate.poolName,
    baseTokenSymbol: candidate.tokenSymbol,
    quoteTokenSymbol: "SOL",
    binStep: check.binStep ?? 0,
    positionAddress: Keypair.generate().publicKey.toBase58(),
    minBinId: 0,
    maxBinId: 0,
    solDeployed: config.solDeploy,
    entryPrice: candidate.priceUsd,
    feeTvlRatioAtEntry: check.feeToTvlRatio,
    liquidityAtEntry: candidate.pairLiquidityUsd,
    opportunityScoreAtEntry: check.opportunityScore,
    marketCapAtEntry: candidate.marketCap,
    jupiterScoreAtEntry: check.jupiterScore,
    entrySignature: "dry_run",
    tokenMint: candidate.tokenMint,
    status: "active",
    enteredAt: Date.now(),
  };
}