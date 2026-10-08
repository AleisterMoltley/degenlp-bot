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
  /** Set after a one-time clear of a book that counted failed leftover sells. */
  pnlEpoch?: number;
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

/**
 * Bump this to clear the persisted book once more. A matching epoch is left alone.
 * 1 cleared leftover sells booked as closes.
 * 2 clears a one-bin scratch marked with the wide-bid divergence model.
 */
export const PNL_EPOCH = 2;

const defaultState = (): BotState => ({
  positionSeq: 0,
  active: null,
  seats: [],
  closed: [],
  book: emptyBook(),
});

/**
 * When armed, drop a stale book once. Open seats and the wallet file stay.
 * A later restart keeps whatever the desk earns after the clear.
 */
export function applyPnlEpoch(state: BotState, armed: boolean, epoch = PNL_EPOCH): boolean {
  if (!armed || state.pnlEpoch === epoch) return false;
  state.book = emptyBook();
  state.closed = [];
  if (state.growth) state.growth.realizedSol = 0;
  state.pnlEpoch = epoch;
  return true;
}

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
    const state: BotState = {
      positionSeq: parsed.positionSeq ?? 0,
      active: seats[0] ?? null,
      seats,
      closed: parsed.closed ?? [],
      book: { ...emptyBook(), ...(parsed.book ?? {}) },
      growth: parsed.growth,
      pnlEpoch: parsed.pnlEpoch,
    };
    if (applyPnlEpoch(state, config.resetPnl)) {
      saveState(state);
      console.log("[book] cleared stale pnl");
    }
    return state;
  } catch {
    return defaultState();
  }
}

export function saveState(state: BotState) {
  writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
}