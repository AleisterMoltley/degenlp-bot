import { startServer } from "./server.js";
import { startBotLoop } from "./runtime.js";

async function main() {
  startServer();
  await startBotLoop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});