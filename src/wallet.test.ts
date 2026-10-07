import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { Keypair } from "@solana/web3.js";
import { assertSwapQuote } from "./jupiter.js";
import { capDeploySol, parseWalletSecret, saveWalletSecret } from "./wallet.js";

test("a base58 secret and a json byte array resolve to the same public key", () => {
  const kp = Keypair.generate();
  const fromBase58 = parseWalletSecret(bs58.encode(kp.secretKey));
  const fromJson = parseWalletSecret(JSON.stringify(Array.from(kp.secretKey)));
  assert.equal(fromBase58.publicKey.toBase58(), kp.publicKey.toBase58());
  assert.equal(fromJson.publicKey.toBase58(), kp.publicKey.toBase58());
});

test("a short secret is rejected without echoing it", () => {
  assert.throws(() => parseWalletSecret("not-a-key"), /Key was rejected/);
  assert.throws(() => parseWalletSecret(""), /Key was rejected/);
});

test("capDeploySol keeps a fee reserve and refuses a dust wallet", () => {
  assert.equal(capDeploySol(0.72, 1_000_000_000), 0.72);
  assert.equal(capDeploySol(0.72, 200_000_000), 0.15);
  assert.throws(() => capDeploySol(0.72, 80_000_000), /fee reserve/);
});

test("a swap quote with no output or a wide impact is refused", () => {
  assert.throws(() => assertSwapQuote({ outAmount: "0", priceImpactPct: "0" }), /empty/);
  assert.throws(() => assertSwapQuote({ outAmount: "10", priceImpactPct: "0.2" }), /impact/);
  assert.doesNotThrow(() => assertSwapQuote({ outAmount: "10", priceImpactPct: "0.01" }));
});

test("saveWalletSecret writes the canonical secret beside the state file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "degenlp-wallet-"));
  const prev = process.env.STATE_FILE;
  process.env.STATE_FILE = path.join(dir, ".degenlp-state.json");
  try {
    const kp = Keypair.generate();
    const saved = saveWalletSecret(JSON.stringify(Array.from(kp.secretKey)));
    const file = path.join(dir, ".wallet");
    const round = parseWalletSecret(readFileSync(file, "utf8"));
    assert.equal(saved.publicKey.toBase58(), kp.publicKey.toBase58());
    assert.equal(round.publicKey.toBase58(), kp.publicKey.toBase58());
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    if (prev === undefined) delete process.env.STATE_FILE;
    else process.env.STATE_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
