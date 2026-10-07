import { DegenLpBot } from "./bot.js";
import { fetchMeteoraCandidates } from "./meteora.js";
import { rankPools } from "./scorer.js";
import { runDeploy } from "./deploy.js";

const cmd = process.argv[2] ?? "run";

async function main() {
  if (cmd === "scan") {
    const candidates = await fetchMeteoraCandidates();
    const ranked = rankPools(candidates).slice(0, 12).map((row) => ({
      venue: row.pool.venue,
      pool: row.pool.poolName,
      address: row.pool.poolAddress,
      side: row.pool.side,
      tvl: Math.round(row.pool.pairLiquidityUsd),
      fee30m: Math.round(row.pool.fee30mUsd),
      score: Number(row.metrics.opportunityScore.toFixed(3)),
      edge: Number(row.metrics.edgeUsd.toFixed(3)),
      met: row.metrics.metThreshold,
      holders: row.pool.holders,
      ageMin: row.pool.createdAtMs ? Math.round((Date.now() - row.pool.createdAtMs) / 60_000) : null,
    }));
    const ready = ranked.filter((row) => row.met).length;
    console.log(JSON.stringify({ pools: candidates.length, ready, top: ranked }, null, 2));
    return;
  }

  if (cmd === "run") {
    const bot = new DegenLpBot();
    await bot.run();
    return;
  }

  if (cmd === "once") {
    const bot = new DegenLpBot();
    await bot.scanOnce();
    return;
  }

  if (cmd === "deploy-contract") {
    await runDeploy();
    return;
  }

  console.log("Usage: npm run scan | npm start | npm run once | npm run deploy-contract");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});