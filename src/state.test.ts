import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPnlEpoch, emptyBook, PNL_EPOCH, type BotState } from "./state.js";
import type { ActivePosition } from "./types.js";

function dirty(): BotState {
  return {
    positionSeq: 4,
    active: null,
    seats: [{ id: "open" } as ActivePosition],
    closed: [{ id: "old" } as ActivePosition],
    book: { ...emptyBook(), realizedUsd: -40, feesUsd: 1.3, ilUsd: 39, costsUsd: 2, exits: 17 },
    growth: { startedAt: 1, startSol: 1, targetSol: 30, realizedSol: -0.4 },
  };
}

test("an armed epoch clears the stale book and keeps the open seat", () => {
  const state = dirty();
  assert.equal(applyPnlEpoch(state, true), true);
  assert.equal(state.book.realizedUsd, 0);
  assert.equal(state.book.feesUsd, 0);
  assert.equal(state.book.ilUsd, 0);
  assert.equal(state.book.costsUsd, 0);
  assert.equal(state.book.exits, 0);
  assert.equal(state.closed.length, 0);
  assert.equal(state.growth?.realizedSol, 0);
  assert.equal(state.growth?.startSol, 1);
  assert.equal(state.seats.length, 1);
  assert.equal(state.seats[0].id, "open");
  assert.equal(state.pnlEpoch, PNL_EPOCH);
});

test("a second pass and an unarmed boot leave the book", () => {
  const armed = dirty();
  applyPnlEpoch(armed, true);
  armed.book.realizedUsd = 1.25;
  armed.closed = [{ id: "new" } as ActivePosition];
  assert.equal(applyPnlEpoch(armed, true), false);
  assert.equal(armed.book.realizedUsd, 1.25);
  assert.equal(armed.closed.length, 1);

  const parked = dirty();
  assert.equal(applyPnlEpoch(parked, false), false);
  assert.equal(parked.book.realizedUsd, -40);
  assert.equal(parked.closed.length, 1);
  assert.equal(parked.growth?.realizedSol, -0.4);
});
