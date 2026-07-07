import { DegenLpBot } from "./bot.js";

let bot: DegenLpBot | null = null;

export function getBot(): DegenLpBot {
  if (!bot) bot = new DegenLpBot();
  return bot;
}

export async function startBotLoop() {
  const instance = getBot();
  void instance.startLoop();
  return instance;
}