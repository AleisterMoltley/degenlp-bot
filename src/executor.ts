import DLMM, { StrategyType } from "@meteora-ag/dlmm";
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  VersionedTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { config } from "./config.js";
import { buildJupiterSwap, SOL_MINT } from "./jupiter.js";
import { buildPosition } from "./position.js";
import type { ActivePosition, OpportunityCheck, PoolCandidate } from "./types.js";
import { capDeploySol, loadWalletKeypair, SOL_RESERVE_LAMPORTS } from "./wallet.js";

const TOKEN_PROGRAMS = [
  new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
];

export class DlmmExecutor {
  private connection: Connection;
  private wallet: Keypair;

  constructor(connection: Connection, wallet: Keypair) {
    this.connection = connection;
    this.wallet = wallet;
  }

  static fromKeypair(wallet: Keypair): DlmmExecutor {
    return new DlmmExecutor(new Connection(config.rpcUrl, "confirmed"), wallet);
  }

  static fromEnv(): DlmmExecutor {
    const wallet = loadWalletKeypair();
    if (!wallet) {
      throw new Error("WALLET_PRIVATE_KEY missing — set it in .env for live mode");
    }
    return DlmmExecutor.fromKeypair(wallet);
  }

  publicKey(): string {
    return this.wallet.publicKey.toBase58();
  }

  async positionExists(positionAddress: string): Promise<boolean> {
    const info = await this.connection.getAccountInfo(new PublicKey(positionAddress));
    return info !== null;
  }

  async enter(candidate: PoolCandidate, check: OpportunityCheck, solDeploy = config.solDeploy): Promise<ActivePosition> {
    const positionKp = Keypair.generate();
    const dlmm = await DLMM.create(this.connection, new PublicKey(candidate.poolAddress));
    const active = await dlmm.getActiveBin();
    const lamports = await this.connection.getBalance(this.wallet.publicKey, "confirmed");
    const solDeployed = capDeploySol(solDeploy, lamports);
    const deployLamports = Math.floor(solDeployed * 1e9);
    const tokenX = dlmm.tokenX.publicKey.toBase58();
    const tokenY = dlmm.tokenY.publicKey.toBase58();
    const solIsY = tokenY === SOL_MINT;
    if (tokenX !== SOL_MINT && !solIsY) {
      throw new Error(`pool has no SOL side: ${candidate.poolName}`);
    }

    const curve = candidate.side === "curve";
    const minBinId = active.binId - config.scalpBins;
    const maxBinId = curve ? active.binId + config.scalpBins : active.binId;
    let totalXAmount = new BN(solIsY ? 0 : deployLamports);
    let totalYAmount = new BN(solIsY ? deployLamports : 0);
    let swapped = false;

    console.log(
      `[enter] ${candidate.poolName} ${curve ? "curve" : "bid"} bins ${minBinId}..${maxBinId} deploy ${solDeployed} SOL`,
    );

    let entrySignature = "dry_run";
    try {
      if (!config.dryRun && curve) {
        const memeMint = solIsY ? tokenX : tokenY;
        const swapLamports = Math.floor(deployLamports / 2);
        const swap = await this.swapSolForMeme(memeMint, swapLamports);
        swapped = true;
        const solAfter = await this.connection.getBalance(this.wallet.publicKey, "confirmed");
        const solForLp = Math.min(
          deployLamports - swapLamports,
          Math.max(0, solAfter - SOL_RESERVE_LAMPORTS),
        );
        if (solForLp < 10_000_000 || swap.gained <= 0n) {
          throw new Error("curve sides were empty after the swap");
        }
        const meme = new BN(swap.gained.toString());
        const sol = new BN(solForLp);
        totalXAmount = solIsY ? meme : sol;
        totalYAmount = solIsY ? sol : meme;
      }

      if (!config.dryRun) {
        const tx = await dlmm.initializePositionAndAddLiquidityByStrategy({
          positionPubKey: positionKp.publicKey,
          user: this.wallet.publicKey,
          totalXAmount,
          totalYAmount,
          strategy: {
            minBinId,
            maxBinId,
            strategyType: curve ? StrategyType.Curve : StrategyType.Spot,
          },
          slippage: curve ? 3 : 1,
        });
        entrySignature = await sendAndConfirmTransaction(this.connection, tx, [this.wallet, positionKp]);
      }
    } catch (err) {
      if (swapped) {
        console.error(`[enter] curve deposit failed after the swap on ${candidate.poolName}; meme token remains in the wallet`);
        throw new Error(`curve deposit failed after the swap on ${candidate.poolName}; meme token remains in the wallet`);
      }
      throw err;
    }

    return buildPosition({
      pool: candidate,
      solDeployed,
      feeToTvl: check.feeToTvlRatio,
      opportunityScore: check.opportunityScore,
      positionAddress: positionKp.publicKey.toBase58(),
      minBinId,
      maxBinId,
      entrySignature,
    });
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

  /** After a bid or curve is removed, sell a leftover meme back to SOL. A failed unwind does not pause the desk. */
  async settleMeme(mint: string): Promise<"flat" | "swapped" | "stuck"> {
    if (!mint || mint === SOL_MINT) return "flat";
    let amount = 0n;
    try {
      amount = await this.rawBalance(mint);
    } catch {
      console.error("[scratch] balance read failed");
      return "stuck";
    }
    if (amount <= 0n) return "flat";
    try {
      await this.swapToSol(mint, amount);
      return "swapped";
    } catch {
      console.error("[scratch] unwind failed; meme token was not swapped");
      return "stuck";
    }
  }

  private async swapToSol(inputMint: string, amount: bigint): Promise<void> {
    const built = await buildJupiterSwap({
      inputMint,
      outputMint: SOL_MINT,
      amount,
      userPublicKey: this.wallet.publicKey.toBase58(),
    });
    const tx = VersionedTransaction.deserialize(Buffer.from(built.swapTransaction, "base64"));
    tx.sign([this.wallet]);
    const signature = await this.connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
    const height = built.lastValidBlockHeight;
    if (height > 0) {
      const result = await this.connection.confirmTransaction(
        { signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: height },
        "confirmed",
      );
      if (result.value.err) throw new Error("swap transaction failed");
    } else {
      const result = await this.connection.confirmTransaction(signature, "confirmed");
      if (result.value.err) throw new Error("swap transaction failed");
    }
    console.log(`[swap] meme back to SOL sig=${signature}`);
  }

  private async rawBalance(mint: string): Promise<bigint> {
    const mintPk = new PublicKey(mint);
    let total = 0n;
    for (const programId of TOKEN_PROGRAMS) {
      const accounts = await this.connection.getParsedTokenAccountsByOwner(this.wallet.publicKey, {
        mint: mintPk,
        programId,
      });
      for (const acc of accounts.value) {
        const parsed = acc.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } };
        const amount = parsed.parsed?.info?.tokenAmount?.amount ?? "0";
        total += BigInt(amount);
      }
    }
    return total;
  }

  private async swapSolForMeme(outputMint: string, lamports: number): Promise<{ gained: bigint }> {
    const before = await this.rawBalance(outputMint);
    const built = await buildJupiterSwap({
      inputMint: SOL_MINT,
      outputMint,
      amount: lamports,
      userPublicKey: this.wallet.publicKey.toBase58(),
    });
    const tx = VersionedTransaction.deserialize(Buffer.from(built.swapTransaction, "base64"));
    tx.sign([this.wallet]);
    const signature = await this.connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
    const height = built.lastValidBlockHeight;
    if (height > 0) {
      const result = await this.connection.confirmTransaction(
        { signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: height },
        "confirmed",
      );
      if (result.value.err) throw new Error("swap transaction failed");
    } else {
      const result = await this.connection.confirmTransaction(signature, "confirmed");
      if (result.value.err) throw new Error("swap transaction failed");
    }
    const gained = (await this.rawBalance(outputMint)) - before;
    if (gained <= 0n) throw new Error("swap landed without the meme token");
    console.log(`[swap] ${outputMint.slice(0, 4)}… gained raw tokens sig=${signature}`);
    return { gained };
  }
}

export async function enterPositionDryRun(
  candidate: PoolCandidate,
  check: OpportunityCheck,
  solDeploy = config.solDeploy,
): Promise<ActivePosition> {
  return buildPosition({
    pool: candidate,
    solDeployed: solDeploy,
    feeToTvl: check.feeToTvlRatio,
    opportunityScore: check.opportunityScore,
    entrySignature: "dry_run",
  });
}
