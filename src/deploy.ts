import { Keypair } from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { config } from "./config.js";
import { deployDatabaseContract } from "./proofnetwork.js";

export async function runDeploy() {
  if (!config.walletPrivateKey) {
    throw new Error("Set WALLET_PRIVATE_KEY in .env before deploying");
  }

  const wallet = Keypair.fromSecretKey(bs58.decode(config.walletPrivateKey));
  const address = wallet.publicKey.toBase58();

  console.log(`Deploying DegenLPDatabase for owner ${address}...`);
  const contractAddress = await deployDatabaseContract(address);

  console.log("\nDeployed successfully!");
  console.log(`PROOFNETWORK_CONTRACT=${contractAddress}`);
  console.log(`Dashboard: https://proofnetwork.lol/address/${contractAddress}`);
  console.log("\nAdd to .env:");
  console.log(`PROOFNETWORK_TELEMETRY=true`);
  console.log(`PROOFNETWORK_CONTRACT=${contractAddress}`);
}