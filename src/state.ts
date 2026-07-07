import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { config } from "./config.js";
import type { ActivePosition } from "./types.js";

export interface BotState {
  positionSeq: number;
  active: ActivePosition | null;
  closed: ActivePosition[];
}

const defaultState = (): BotState => ({
  positionSeq: 0,
  active: null,
  closed: [],
});

export function loadState(): BotState {
  if (!existsSync(config.stateFile)) return defaultState();
  try {
    return JSON.parse(readFileSync(config.stateFile, "utf8")) as BotState;
  } catch {
    return defaultState();
  }
}

export function saveState(state: BotState) {
  writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
}