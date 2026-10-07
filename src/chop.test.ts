import assert from "node:assert/strict";
import { test } from "node:test";
import { chopFromPrices, chopShapeOk, depthOk } from "./chop.js";

test("a tape that reverses beats a one-way print", () => {
  const chop = chopFromPrices([1, 1.002, 0.999, 1.003, 0.998, 1.001], 80);
  const dump = chopFromPrices([1, 0.99, 0.97, 0.94, 0.9], 80);
  assert.equal(chopShapeOk(chop), true);
  assert.equal(chopShapeOk(dump), false);
  assert.ok(dump.netBins > dump.crossings);
});

test("a short tape and a thin bin are not seats", () => {
  assert.equal(chopShapeOk(chopFromPrices([1, 1.01, 1], 80)), false);
  assert.equal(depthOk(1_000, undefined), false);
  assert.equal(depthOk(1_000, 500), false);
  assert.equal(depthOk(400, 500), true);
});
