import assert from "node:assert/strict";
import { test } from "node:test";
import { deploySolFor, equitySol, paceSol } from "./growth.js";

const week = 7 * 24 * 60 * 60 * 1000;

test("the week pace starts at 1 SOL and finishes at 30", () => {
  const start = 1_000;
  assert.equal(paceSol({ startSol: 1, targetSol: 30, startedAt: start, now: start, weekMs: week }), 1);
  const end = paceSol({ startSol: 1, targetSol: 30, startedAt: start, now: start + week, weekMs: week });
  assert.ok(Math.abs(end - 30) < 1e-9);
  const mid = paceSol({ startSol: 1, targetSol: 30, startedAt: start, now: start + week / 2, weekMs: week });
  assert.ok(mid > 1 && mid < 30);
  assert.ok(Math.abs(mid - Math.sqrt(30)) < 1e-9);
});

test("deploy is a capped fraction of equity and compounds after a win", () => {
  assert.equal(deploySolFor(1, 0.72), 0.72);
  const after = equitySol({ startSol: 1, realizedSol: 0.4, openNetUsd: 0, solPrice: 200 });
  assert.equal(after, 1.4);
  assert.ok(deploySolFor(after, 0.72) > 0.72);
  assert.equal(deploySolFor(0, 0.72), 0);
});

test("open pnl marks the equity in SOL", () => {
  const down = equitySol({ startSol: 1, realizedSol: 0, openNetUsd: -20, solPrice: 200 });
  assert.equal(down, 0.9);
});
