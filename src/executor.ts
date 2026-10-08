import DLMM, { StrategyType } from "@meteora-ag/dlmm";
import { createBurnInstruction, createCloseAccountInstruction } from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { config } from "./config.js";
import { activeIdFromPool, activeIdsFromAccounts } from "./fillwatch.js";
import { buildJupiterSwap, sellSlices, SOL_MINT } from "./jupiter.js";
import { buildPosition } from "./position.js";
import type { ActivePosition, OpportunityCheck, PoolCandidate } from "./types.js";

export type SlideResult =
  | {
      ok: true;
      positionAddress: string;
      minBinId: number;
      maxBinId: number;
      signature: string;
      solDeployed: number;
    }
  | { ok: false; flat: boolean; reason: string };

export type AddResult =
  | { ok: true; solDeployed: number; signature: string }
  | { ok: false; reason: string };
import { capDeploySol, loadWalletKeypair, SOL_RESERVE_LAMPORTS } from "./wallet.js";

const TOKEN_PROGRAMS = [
  new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
];

/** Below this raw balance Jupiter has no route. It is closed out of the wallet. A real bag is never burned. */
export const DUST_RAW = 10_000n;

interface TokenBag {
  account: string;
  program: string;
  mint: string;
  amount: bigint;
}

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

  /** Active bin from the pair account. Processed, so it is the latest slot. */
  async poolActiveId(poolAddress: string): Promise<number | null> {
    const found = await this.poolActiveIds([poolAddress]);
    return found.get(poolAddress) ?? null;
  }

  /** Active bins for many pairs. One getMultipleAccounts call per 100 addresses. */
  async poolActiveIds(addresses: string[]): Promise<Map<string, number>> {
    const unique = [...new Set(addresses.filter(Boolean))];
    const out = new Map<string, number>();
    const keys: Array<{ address: string; key: PublicKey }> = [];
    for (const address of unique) {
      try {
        keys.push({ address, key: new PublicKey(address) });
      } catch {
        // A bad address is skipped. The pool stays closed for this scan.
      }
    }
    for (let i = 0; i < keys.length; i += 100) {
      const slice = keys.slice(i, i + 100);
      const infos = await this.connection.getMultipleAccountsInfo(
        slice.map((row) => row.key),
        "processed",
      );
      const found = activeIdsFromAccounts(
        slice.map((row) => row.address),
        infos,
      );
      for (const [address, id] of found) out.set(address, id);
    }
    return out;
  }

  /** Fires when the pair account changes. The id is read from the notification itself. */
  watchPool(poolAddress: string, onActiveId: (activeId: number) => void): () => void {
    const id = this.connection.onAccountChange(
      new PublicKey(poolAddress),
      (account) => {
        const activeId = activeIdFromPool(account.data);
        if (activeId == null) return;
        onActiveId(activeId);
      },
      "processed",
    );
    return () => {
      void this.connection.removeAccountChangeListener(id);
    };
  }

  /** SOL in the active bin, in SOL. The caller prices it. */
  async activeBinSol(poolAddress: string): Promise<number | null> {
    const dlmm = await DLMM.create(this.connection, new PublicKey(poolAddress));
    const bin = await dlmm.getActiveBin();
    const y = dlmm.tokenY.publicKey.toBase58();
    const x = dlmm.tokenX.publicKey.toBase58();
    const raw = y === SOL_MINT ? bin.yAmount : x === SOL_MINT ? bin.xAmount : null;
    if (!raw) return null;
    const sol = Number(raw.toString()) / 1e9;
    return Number.isFinite(sol) && sol > 0 ? sol : null;
  }

  /** Meme principal plus unpaid meme fees. Zero means the bid is still SOL. */
  async positionMemeRaw(poolAddress: string, positionAddress: string, memeMint: string): Promise<bigint> {
    const dlmm = await DLMM.create(this.connection, new PublicKey(poolAddress));
    const position = await dlmm.getPosition(new PublicKey(positionAddress));
    const memeIsX = dlmm.tokenX.publicKey.toBase58() === memeMint;
    const data = position.positionData;
    const principal = BigInt(memeIsX ? data.totalXAmount || "0" : data.totalYAmount || "0");
    const fee = memeIsX ? data.feeX : data.feeY;
    const feeRaw = BigInt(fee?.toString() || "0");
    return principal + feeRaw;
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

    // SOL only, in the active bin. A swap pays the bin it consumes, and bins below
    // earn nothing until a sell walks into them. Spot with the other amount at
    // zero stays SOL until that sell. It does not buy the meme on the way in.
    const minBinId = active.binId;
    const maxBinId = active.binId;
    const totalXAmount = new BN(solIsY ? 0 : deployLamports);
    const totalYAmount = new BN(solIsY ? deployLamports : 0);

    console.log(
      `[enter] ${candidate.poolName} bid bin ${minBinId} deploy ${solDeployed} SOL`,
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
        slippage: 1,
      });
      entrySignature = await sendAndConfirmTransaction(this.connection, tx, [this.wallet, positionKp]);
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

  /**
   * Add SOL to an existing one-bin bid. The position stays on the same bin.
   * Refuses once the meme is in it, or once the active bin has moved.
   * solDeployed on success is the new total, not the increment.
   */
  async addSol(position: ActivePosition, addSolAmount: number): Promise<AddResult> {
    if (config.dryRun) return { ok: false, reason: "paper add stays in the bot" };
    if (!(addSolAmount > 0) || position.minBinId !== position.maxBinId) {
      return { ok: false, reason: "nothing to add" };
    }
    const meme = await this.positionMemeRaw(position.poolAddress, position.positionAddress, position.tokenMint);
    if (meme > DUST_RAW) return { ok: false, reason: "meme still in the bid" };

    const dlmm = await DLMM.create(this.connection, new PublicKey(position.poolAddress));
    const active = await dlmm.getActiveBin();
    if (active.binId !== position.maxBinId) return { ok: false, reason: "bid left the active bin" };

    const tokenX = dlmm.tokenX.publicKey.toBase58();
    const tokenY = dlmm.tokenY.publicKey.toBase58();
    const solIsY = tokenY === SOL_MINT;
    if (tokenX !== SOL_MINT && !solIsY) return { ok: false, reason: "pool has no SOL side" };

    let added = 0;
    try {
      const lamports = await this.connection.getBalance(this.wallet.publicKey, "confirmed");
      added = capDeploySol(addSolAmount, lamports);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "fee reserve";
      return { ok: false, reason };
    }
    if (!(added > 0)) return { ok: false, reason: "nothing to add" };

    try {
      const deployLamports = Math.floor(added * 1e9);
      const tx = await dlmm.addLiquidityByStrategy({
        positionPubKey: new PublicKey(position.positionAddress),
        user: this.wallet.publicKey,
        totalXAmount: new BN(solIsY ? 0 : deployLamports),
        totalYAmount: new BN(solIsY ? deployLamports : 0),
        strategy: {
          minBinId: position.minBinId,
          maxBinId: position.maxBinId,
          strategyType: StrategyType.Spot,
        },
        slippage: 1,
      });
      const signature = await sendAndConfirmTransaction(this.connection, tx, [this.wallet]);
      return { ok: true, solDeployed: position.solDeployed + added, signature };
    } catch (err) {
      const reason = err instanceof Error ? err.message : "add failed";
      return { ok: false, reason };
    }
  }

  /**
   * Move a one-bin SOL bid up one bin. Refuses while the meme is still in the position.
   * If the remove lands and the new deposit does not, the seat is flat and the caller must not exit again.
   */
  async slideSolBid(position: ActivePosition): Promise<SlideResult> {
    if (config.dryRun) return { ok: false, flat: false, reason: "paper slide stays in the bot" };
    const meme = await this.positionMemeRaw(position.poolAddress, position.positionAddress, position.tokenMint);
    if (meme > DUST_RAW) return { ok: false, flat: false, reason: "meme still in the bid" };

    const poolPk = new PublicKey(position.poolAddress);
    const dlmm = await DLMM.create(this.connection, poolPk);
    const active = await dlmm.getActiveBin();
    // One step, and only when that step is the active bin. Landing one short
    // puts the SOL back where intra-bin sells do not pay it. A two-bin jump is a runner.
    const next = active.binId;
    if (next <= position.maxBinId) return { ok: false, flat: false, reason: "price came back" };
    if (next !== position.maxBinId + 1) return { ok: false, flat: false, reason: "runner" };

    const tokenX = dlmm.tokenX.publicKey.toBase58();
    const tokenY = dlmm.tokenY.publicKey.toBase58();
    const solIsY = tokenY === SOL_MINT;
    if (tokenX !== SOL_MINT && !solIsY) return { ok: false, flat: false, reason: "pool has no SOL side" };

    try {
      const txs = await dlmm.removeLiquidity({
        position: new PublicKey(position.positionAddress),
        user: this.wallet.publicKey,
        fromBinId: position.minBinId,
        toBinId: position.maxBinId,
        bps: new BN(10_000),
        shouldClaimAndClose: true,
      });
      for (const tx of txs) {
        await sendAndConfirmTransaction(this.connection, tx, [this.wallet]);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : "remove failed";
      return { ok: false, flat: false, reason };
    }

    const positionKp = Keypair.generate();
    try {
      const lamports = await this.connection.getBalance(this.wallet.publicKey, "confirmed");
      const solDeployed = capDeploySol(position.solDeployed, lamports);
      if (!(solDeployed > 0)) return { ok: false, flat: true, reason: "fee reserve" };
      const deployLamports = Math.floor(solDeployed * 1e9);
      const tx = await dlmm.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: positionKp.publicKey,
        user: this.wallet.publicKey,
        totalXAmount: new BN(solIsY ? 0 : deployLamports),
        totalYAmount: new BN(solIsY ? deployLamports : 0),
        strategy: {
          minBinId: next,
          maxBinId: next,
          strategyType: StrategyType.Spot,
        },
        slippage: 1,
      });
      const signature = await sendAndConfirmTransaction(this.connection, tx, [this.wallet, positionKp]);
      return {
        ok: true,
        positionAddress: positionKp.publicKey.toBase58(),
        minBinId: next,
        maxBinId: next,
        signature,
        solDeployed,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : "redeposit failed";
      return { ok: false, flat: true, reason };
    }
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

  /** Token balances other than native SOL. Wrapped SOL is skipped. */
  async memeBalances(): Promise<Array<{ mint: string; amount: bigint }>> {
    const totals = new Map<string, bigint>();
    for (const bag of await this.tokenBags()) {
      totals.set(bag.mint, (totals.get(bag.mint) ?? 0n) + bag.amount);
    }
    return [...totals.entries()].map(([mint, amount]) => ({ mint, amount }));
  }

  /** After a bid or curve is removed, sell a leftover meme back to SOL. A failed unwind does not pause the desk. */
  async settleMeme(mint: string, poolAddress?: string): Promise<"flat" | "swapped" | "stuck"> {
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
      await this.swapToSol(mint, amount, poolAddress);
      return "swapped";
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unwind failed";
      console.error(`[scratch] unwind failed; meme token was not swapped (${msg})`);
      return "stuck";
    }
  }

  private async swapToSol(inputMint: string, amount: bigint, poolAddress?: string): Promise<void> {
    let last = "unwind failed";
    const soldOnJupiter = await this.sellThroughJupiter(inputMint, amount, (msg) => {
      last = msg;
    });
    if (soldOnJupiter) return;
    let left = await this.rawBalance(inputMint);
    if (left <= 0n) return;
    if (left <= DUST_RAW && /NO_ROUTES|no routes/i.test(last)) {
      await this.burnDust(inputMint);
      return;
    }
    try {
      await this.sellThroughDlmm(inputMint, left, poolAddress);
      left = await this.rawBalance(inputMint);
      if (left <= 0n) return;
    } catch (err) {
      last = err instanceof Error ? err.message : last;
    }
    left = await this.rawBalance(inputMint);
    if (left <= 0n) return;
    if (left <= DUST_RAW) {
      await this.burnDust(inputMint);
      return;
    }
    throw new Error(last);
  }

  /** Try several sizes. A 429 is retried. A send whose confirm expires still counts once the balance drops. */
  private async sellThroughJupiter(
    inputMint: string,
    amount: bigint,
    onError: (msg: string) => void,
  ): Promise<boolean> {
    let left = amount;
    for (const slice of sellSlices(amount)) {
      if (left <= 0n) return true;
      const use = slice > left ? left : slice;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const before = await this.rawBalance(inputMint);
        if (before <= 0n) return true;
        const sized = use > before ? before : use;
        try {
          await this.sendMemeSell(inputMint, sized);
          left = await this.rawBalance(inputMint);
          if (left <= 0n) return true;
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : "unwind failed";
          onError(msg);
          if (await this.balanceDropped(inputMint, before)) {
            left = await this.rawBalance(inputMint);
            if (left <= 0n) return true;
            break;
          }
          if (/429|503|500|rate limit/i.test(msg) && attempt < 2) {
            await sleep(400 * (attempt + 1));
            continue;
          }
          break;
        }
      }
      left = await this.rawBalance(inputMint);
    }
    return (await this.rawBalance(inputMint)) <= 0n;
  }

  /**
   * Helius rejects sendTransaction preflight for this sell with InsufficientFunds
   * after simulateTransaction has accepted the same signed transaction.
   * Simulate first, then send with preflight skipped.
   */
  private async sendMemeSell(inputMint: string, amount: bigint): Promise<void> {
    const built = await buildJupiterSwap({
      inputMint,
      outputMint: SOL_MINT,
      amount,
      userPublicKey: this.wallet.publicKey.toBase58(),
      slippageBps: 5_000,
      maxImpact: 0.95,
    });
    const tx = VersionedTransaction.deserialize(Buffer.from(built.swapTransaction, "base64"));
    tx.sign([this.wallet]);
    const sim = await this.connection.simulateTransaction(tx, {
      commitment: "confirmed",
      sigVerify: true,
    });
    if (sim.value.err) {
      const detail = (sim.value.logs ?? [])
        .filter((line) => /error|failed|insufficient/i.test(line))
        .slice(-3)
        .join(" | ");
      throw new Error(`swap simulation rejected amount=${amount} ${detail || JSON.stringify(sim.value.err)}`);
    }
    const before = await this.rawBalance(inputMint);
    const signature = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });
    try {
      const height = built.lastValidBlockHeight;
      const result =
        height > 0
          ? await this.connection.confirmTransaction(
              { signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: height },
              "confirmed",
            )
          : await this.connection.confirmTransaction(signature, "confirmed");
      if (result.value.err) throw new Error("swap transaction failed");
    } catch (err) {
      if (await this.balanceDropped(inputMint, before)) {
        console.log(`[swap] meme back to SOL sig=${signature}`);
        return;
      }
      throw err;
    }
    console.log(`[swap] meme back to SOL sig=${signature}`);
  }

  private async balanceDropped(mint: string, before: bigint): Promise<boolean> {
    if ((await this.rawBalance(mint)) < before) return true;
    await sleep(800);
    return (await this.rawBalance(mint)) < before;
  }

  /** The pool we just left, then any other SOL pair for this mint. */
  private async sellThroughDlmm(mint: string, amount: bigint, poolAddress?: string): Promise<void> {
    const pools = await this.solPoolsForMint(mint, poolAddress);
    if (!pools.length) throw new Error("no SOL pool to unwind the meme");
    let left = amount;
    let last = "dlmm unwind failed";
    for (const pool of pools) {
      if (left <= 0n) return;
      for (let pass = 0; pass < 4 && left > 0n; pass += 1) {
        const before = left;
        try {
          await this.swapOnDlmm(pool, mint, left);
        } catch (err) {
          last = err instanceof Error ? err.message : last;
          break;
        }
        left = await this.rawBalance(mint);
        if (left >= before) break;
      }
      if (left <= 0n) return;
    }
    if ((await this.rawBalance(mint)) <= 0n) return;
    throw new Error(last);
  }

  private async solPoolsForMint(mint: string, hint?: string): Promise<string[]> {
    const found: string[] = [];
    const push = (address: string) => {
      if (address && !found.includes(address)) found.push(address);
    };
    if (hint) push(hint);
    try {
      const url =
        "https://dlmm.datapi.meteora.ag/pools?" +
        new URLSearchParams({ page: "1", page_size: "10", query: mint, sort_by: "tvl:desc" });
      const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      if (!res.ok) return found;
      const body = (await res.json()) as {
        data?: Array<{ address?: string; token_x?: { address?: string }; token_y?: { address?: string } }>;
      };
      for (const pool of body.data ?? []) {
        const x = pool.token_x?.address ?? "";
        const y = pool.token_y?.address ?? "";
        const sol = x === SOL_MINT || y === SOL_MINT;
        const meme = x === mint || y === mint;
        if (sol && meme && pool.address) push(pool.address);
      }
    } catch {
      /* The hinted pool is still tried. */
    }
    return found.slice(0, 3);
  }

  private async swapOnDlmm(poolAddress: string, mint: string, amount: bigint): Promise<void> {
    const dlmm = await DLMM.create(this.connection, new PublicKey(poolAddress));
    const memeIsX = dlmm.tokenX.publicKey.toBase58() === mint;
    const other = memeIsX ? dlmm.tokenY.publicKey.toBase58() : dlmm.tokenX.publicKey.toBase58();
    if (!memeIsX && dlmm.tokenY.publicKey.toBase58() !== mint) throw new Error("pool does not hold this mint");
    if (other !== SOL_MINT) throw new Error("pool has no SOL side");
    const swapForY = memeIsX;
    const bins = await dlmm.getBinArrayForSwap(swapForY, 4);
    const quote = dlmm.swapQuote(new BN(amount.toString()), swapForY, new BN(5_000), bins, true);
    if (!quote.outAmount || quote.outAmount.lten(0)) throw new Error("dlmm quote was empty");
    const inAmount = quote.consumedInAmount?.gtn(0) ? quote.consumedInAmount : new BN(amount.toString());
    const minOut = quote.minOutAmount?.gtn(0) ? quote.minOutAmount : new BN(1);
    const tx = await dlmm.swap({
      inToken: new PublicKey(mint),
      outToken: new PublicKey(SOL_MINT),
      inAmount,
      minOutAmount: minOut,
      lbPair: dlmm.pubkey,
      user: this.wallet.publicKey,
      binArraysPubkey: quote.binArraysPubkey,
    });
    const signature = await sendAndConfirmTransaction(this.connection, tx, [this.wallet]);
    console.log(`[swap] meme back to SOL via pool sig=${signature}`);
  }

  /** Jupiter has no route for a few raw units. Burn those and close the account. A real bag stays. */
  private async burnDust(mint: string): Promise<void> {
    const bags = (await this.tokenBags()).filter((bag) => bag.mint === mint && bag.amount > 0n && bag.amount <= DUST_RAW);
    if (!bags.length) throw new Error("leftover is above dust and was not swapped");
    for (const bag of bags) {
      const program = new PublicKey(bag.program);
      const account = new PublicKey(bag.account);
      const mintPk = new PublicKey(mint);
      const burn = createBurnInstruction(account, mintPk, this.wallet.publicKey, bag.amount, [], program);
      const close = createCloseAccountInstruction(account, this.wallet.publicKey, this.wallet.publicKey, [], program);
      const tx = new Transaction().add(burn, close);
      try {
        const signature = await sendAndConfirmTransaction(this.connection, tx, [this.wallet]);
        console.log(`[swap] closed unsellable dust raw=${bag.amount} sig=${signature}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "dust close failed";
        throw new Error(`unsellable dust was not closed (${msg})`);
      }
    }
  }

  private async tokenBags(): Promise<TokenBag[]> {
    const bags: TokenBag[] = [];
    const seen = new Set<string>();
    for (const programId of TOKEN_PROGRAMS) {
      const accounts = await this.connection.getParsedTokenAccountsByOwner(this.wallet.publicKey, { programId });
      for (const acc of accounts.value) {
        const key = acc.pubkey.toBase58();
        if (seen.has(key)) continue;
        seen.add(key);
        const info = (acc.account.data as {
          parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } };
        }).parsed?.info;
        const mint = info?.mint ?? "";
        const amount = BigInt(info?.tokenAmount?.amount ?? "0");
        if (!mint || mint === SOL_MINT || amount <= 0n) continue;
        bags.push({
          account: key,
          program: acc.account.owner.toBase58(),
          mint,
          amount,
        });
      }
    }
    return bags;
  }

  private async rawBalance(mint: string): Promise<bigint> {
    const mintPk = new PublicKey(mint);
    let total = 0n;
    const seen = new Set<string>();
    for (const programId of TOKEN_PROGRAMS) {
      const accounts = await this.connection.getParsedTokenAccountsByOwner(this.wallet.publicKey, {
        mint: mintPk,
        programId,
      });
      for (const acc of accounts.value) {
        // Helius returns the same account for both token programs when a mint is set.
        const key = acc.pubkey.toBase58();
        if (seen.has(key)) continue;
        seen.add(key);
        const parsed = acc.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } };
        const amount = parsed.parsed?.info?.tokenAmount?.amount ?? "0";
        total += BigInt(amount);
      }
    }
    return total;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
