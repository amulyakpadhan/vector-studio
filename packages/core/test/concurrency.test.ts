import { test } from "node:test";
import assert from "node:assert/strict";
import { mapPool } from "../src/concurrency.ts";

test("mapPool preserves input order in the results", async () => {
  const out = await mapPool([10, 20, 30, 40], 2, async (n) => {
    // Later items resolve sooner, to prove ordering isn't completion order.
    await new Promise((r) => setTimeout(r, 20 - n / 10));
    return n * 2;
  });
  assert.deepEqual(out, [20, 40, 60, 80]);
});

test("mapPool never runs more than `concurrency` at once", async () => {
  let active = 0;
  let peak = 0;
  await mapPool(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return null;
  });
  assert.equal(peak, 3);
});

test("mapPool passes the index and handles an empty list", async () => {
  const idx = await mapPool(["a", "b", "c"], 2, async (_v, i) => i);
  assert.deepEqual(idx, [0, 1, 2]);
  assert.deepEqual(await mapPool([], 4, async () => 1), []);
});
