import assert from "node:assert/strict";
import { test } from "node:test";
import { isMajorSymbol } from "./meteora.js";

test("quote assets and large caps are not meme seats", () => {
  for (const symbol of ["SOL", "WETH", "eth", "ZEC", "HYPE", "wNEAR", "NEAR", "PUMP", "BTC"]) {
    assert.equal(isMajorSymbol(symbol), true, symbol);
  }
  assert.equal(isMajorSymbol("CAPYBARA"), false);
  assert.equal(isMajorSymbol("MASK"), false);
  assert.equal(isMajorSymbol(""), false);
});
