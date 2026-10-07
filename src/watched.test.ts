import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDexPairAddresses } from "./dexscreen.js";
import { bestSolDlmm } from "./meteora.js";
import { mergeWatched } from "./watched.js";
import type { PoolCandidate } from "./types.js";

function pool(over: Partial<PoolCandidate> = {}): PoolCandidate {
  return {
    tokenMint: "mint",
    tokenSymbol: "MEME",
    poolAddress: "pool-a",
    poolName: "MEME-SOL",
    pairLiquidityUsd: 16_000,
    tokenLiquidityUsd: 16_000,
    marketCap: 100_000,
    volume5m: 4_000,
    priceUsd: 0.001,
    binStep: 100,
    baseFeePct: 0.02,
    jupiterScore: 40,
    venue: "dlmm",
    side: "bid",
    fee30mUsd: 900,
    fee1hUsd: 1_800,
    volume30mUsd: 20_000,
    holders: 500,
    createdAtMs: 0,
    freezeDisabled: true,
    solPrice: 100,
    rangeHalfWidth: 0.01,
    ...over,
  };
}

test("the trending page yields pair addresses in order", () => {
  const text = [
    "Hide pair #1](https://dexscreener.com/solana/ucwmmumv5xncimxxymfw2erlqzjfyfbs47bthptgrz1)",
    "Hide pair #1](https://dexscreener.com/solana/ucwmmumv5xncimxxymfw2erlqzjfyfbs47bthptgrz1)",
    "Hide pair #2](https://dexscreener.com/solana/f2p22sfcg4gkja2upyqzef9bpw3rsec5q2wmvewuibl7)",
    "https://cdn.dexscreener.com/cms/images/not-a-pair",
  ].join("");
  assert.deepEqual(parseDexPairAddresses(text, 30), [
    "ucwmmumv5xncimxxymfw2erlqzjfyfbs47bthptgrz1",
    "f2p22sfcg4gkja2upyqzef9bpw3rsec5q2wmvewuibl7",
  ]);
});

test("the watched pool is the hottest SOL DLMM above dust", () => {
  const dust = pool({ poolAddress: "dust", pairLiquidityUsd: 400, fee30mUsd: 9_000 });
  const quiet = pool({ poolAddress: "quiet", fee30mUsd: 20 });
  const hot = pool({ poolAddress: "hot", fee30mUsd: 600 });
  const damm = pool({ poolAddress: "damm", venue: "damm_v2", fee30mUsd: 9_000 });
  assert.equal(bestSolDlmm([dust, quiet, hot, damm])?.poolAddress, "hot");
  assert.equal(bestSolDlmm([dust]), null);
});

test("a missed trending mint is added and an existing mint is only marked", () => {
  const catalog = [pool({ tokenMint: "already", poolAddress: "old", fee30mUsd: 10 })];
  const extra = [
    pool({ tokenMint: "already", poolAddress: "other", fee30mUsd: 800, pairLiquidityUsd: 2_200_000 }),
    pool({ tokenMint: "new", tokenSymbol: "STONK", poolAddress: "stonk", pairLiquidityUsd: 2_200_000 }),
    pool({ tokenMint: "damm-only", poolAddress: "nope", venue: "damm_v2" }),
  ];
  const merged = mergeWatched(catalog, extra);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].watched, true);
  assert.equal(merged[0].poolAddress, "old");
  assert.equal(merged[1].tokenSymbol, "STONK");
  assert.equal(merged[1].watched, true);
  assert.equal(merged[1].pairLiquidityUsd, 2_200_000);
});
