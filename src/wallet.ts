import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { Keypair } from "@solana/web3.js";
import { config } from "./config.js";

export const SOL_RESERVE_LAMPORTS = 50_000_000;

export function walletFilePath(): string {
  const stateFile = process.env.STATE_FILE || config.stateFile;
  return path.join(path.dirname(path.resolve(stateFile)), ".wallet");
}

export function parseWalletSecret(raw: string): Keypair {
  const text = raw.trim().replace(/^["']|["']$/g, "");
  if (!text) throw new Error("Key was rejected");
  let bytes: Uint8Array;
  try {
    if (text.startsWith("[")) {
      const parsed = JSON.parse(text) as unknown;
      if (!Array.isArray(parsed) || parsed.some((n) => !Number.isInteger(n) || (n as number) < 0 || (n as number) > 255)) {
        throw new Error("bad");
      }
      bytes = Uint8Array.from(parsed as number[]);
    } else {
      bytes = bs58.decode(text);
    }
  } catch {
    throw new Error("Key was rejected");
  }
  if (bytes.length !== 64) throw new Error("Key was rejected");
  try {
    return Keypair.fromSecretKey(bytes);
  } catch {
    throw new Error("Key was rejected");
  }
}

export function saveWalletSecret(raw: string): Keypair {
  const kp = parseWalletSecret(raw);
  const file = walletFilePath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${bs58.encode(kp.secretKey)}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // mode is already set on write
  }
  return kp;
}

export function loadWalletKeypair(): Keypair | null {
  const fromEnv = config.walletPrivateKey.trim();
  if (fromEnv) {
    try {
      return parseWalletSecret(fromEnv);
    } catch {
      return null;
    }
  }
  const file = walletFilePath();
  if (!existsSync(file)) return null;
  try {
    return parseWalletSecret(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Live size is the requested deploy, capped by the wallet minus a fee reserve. */
export function capDeploySol(requestedSol: number, lamports: number, reserveLamports = SOL_RESERVE_LAMPORTS): number {
  const spendable = Math.max(0, lamports - reserveLamports);
  const requested = Math.floor(Math.max(requestedSol, 0) * 1e9);
  const capped = Math.min(requested, spendable);
  if (capped < reserveLamports) {
    throw new Error("wallet SOL is below the fee reserve");
  }
  return capped / 1e9;
}
