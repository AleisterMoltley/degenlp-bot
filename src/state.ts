import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { config } from "./config.js";
import type { ActivePosition, Book } from "./types.js";

export interface GrowthLedger {
  startedAt: number;
  startSol: number;
  targetSol: number;
  realizedSol: number;
}

export interface BotState {
  positionSeq: number;
  active: ActivePosition | null;
  seats: ActivePosition[];
  closed: ActivePosition[];
  book: Book;
  growth?: GrowthLedger;
}

export function emptyBook(): Book {
  return {
    realizedUsd: 0,
    feesUsd: 0,
    ilUsd: 0,
    costsUsd: 0,
    entries: 0,
    exits: 0,
    adjusts: 0,
    rotates: 0,
  };
}

const defaultState = (): BotState => ({
  positionSeq: 0,
  active: null,
  seats: [],
  closed: [],
  book: emptyBook(),
});

export function ensureGrowth(state: BotState): GrowthLedger {
  if (!state.growth) {
    state.growth = {
      startedAt: Date.now(),
      startSol: config.growthStartSol,
      targetSol: config.growthTargetSol,
      realizedSol: 0,
    };
  }
  return state.growth;
}

export function loadState(): BotState {
  if (!existsSync(config.stateFile)) return defaultState();
  try {
    const parsed = JSON.parse(readFileSync(config.stateFile, "utf8")) as Partial<BotState>;
    const active = parsed.active ?? null;
    const listed = Array.isArray(parsed.seats) ? parsed.seats : [];
    const seats = listed.length ? listed : active ? [active] : [];
    return {
      positionSeq: parsed.positionSeq ?? 0,
      active: seats[0] ?? null,
      seats,
      closed: parsed.closed ?? [],
      book: { ...emptyBook(), ...(parsed.book ?? {}) },
      growth: parsed.growth,
    };
  } catch {
    return defaultState();
  }
}

export function saveState(state: BotState) {
  writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
}