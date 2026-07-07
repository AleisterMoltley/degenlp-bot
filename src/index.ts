import { DegenLpBot } from "./bot.js";
import { config } from "./config.js";
import { fetchTopPumpTokens, buildCandidates } from "./apis.js";
import { pickBestCandidate, computeMetrics } from "./scorer.js";
import { runDeploy } from "./deploy.js";

const cmd = process.argv[2] ?? "run";

async function main() {
  if (cmd === "scan") {
    const tokens = await fetchTopPumpTokens(config.topTokensLimit);
    const candidates = await buildCandidates(tokens);
    const ranked = candidates
      .map((c) => ({ candidate: c, metrics: computeMetrics(c) }))
      .sort((a, b) => b.metrics.opportunityScore - a.metrics.opportunityScore)
      .slice(0, 10);

    console.log(JSON.stringify({ top: ranked }, null, 2));

    const best = pickBestCandidate(candidates);
    if (!best) {
      console.log("\nNo pool met threshold right now.");
      return;
    }
    console.log("\nBest qualifying pool:");
    console.log(JSON.stringify({ best, metrics: computeMetrics(best) }, null, 2));
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