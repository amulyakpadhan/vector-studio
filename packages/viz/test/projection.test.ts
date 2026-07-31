import { test } from "node:test";
import assert from "node:assert/strict";
import { randomProjection } from "../src/projection/reduce.ts";
import { projectVectors } from "../src/projection/project.ts";
import { colorByField } from "../src/color.ts";

test("randomProjection reduces dimensionality and is deterministic", () => {
  const data = Array.from({ length: 20 }, (_, i) => Array.from({ length: 256 }, (_, j) => Math.sin(i * j)));
  const a = randomProjection(data, 32, 7);
  const b = randomProjection(data, 32, 7);
  assert.equal(a.length, 20);
  assert.equal(a[0]!.length, 32);
  assert.deepEqual(a, b); // same seed → same output
});

test("randomProjection passes through when target >= input dim", () => {
  const data = [[1, 2, 3], [4, 5, 6]];
  assert.strictEqual(randomProjection(data, 10), data);
});

test("randomProjection roughly preserves relative distances (JL)", () => {
  // Two clusters far apart should stay far apart after projection.
  const d = 300;
  const near = Array.from({ length: 3 }, () => Array.from({ length: d }, () => 0.01));
  const far = Array.from({ length: 3 }, () => Array.from({ length: d }, () => 5));
  const proj = randomProjection([...near, ...far], 40, 1);
  const dist = (a: number[], b: number[]) => Math.hypot(...a.map((x, i) => x - b[i]!));
  const within = dist(proj[0]!, proj[1]!);
  const across = dist(proj[0]!, proj[3]!);
  assert.ok(across > within * 5, `expected clusters to separate: within=${within} across=${across}`);
});

test("projectVectors returns 3D coordinates for each input", async () => {
  const vectors = Array.from({ length: 60 }, (_, i) =>
    Array.from({ length: 48 }, (_, j) => Math.cos(i) + Math.sin(j) + (i % 2)),
  );
  let lastP = -1;
  const res = await projectVectors(vectors, { dims: 3, seed: 3 }, (p) => {
    lastP = p;
  });
  assert.equal(res.dims, 3);
  assert.equal(res.positions.length, 60);
  assert.equal(res.positions[0]!.length, 3);
  assert.equal(lastP, 1); // progress ends at 1
  for (const row of res.positions) for (const n of row) assert.ok(Number.isFinite(n));
});

test("projectVectors handles tiny inputs without crashing", async () => {
  const res = await projectVectors([[1, 2], [3, 4]], { dims: 2 });
  assert.equal(res.positions.length, 2);
  assert.equal(res.positions[0]!.length, 2);
});

test("colorByField: categorical builds a legend, numeric does not", () => {
  const cat = colorByField(["a", "b", "a", "c"], 4);
  assert.equal(cat.kind, "categorical");
  assert.equal(cat.colors.length, 12);
  assert.equal(cat.legend[0]!.label, "a"); // most frequent first

  const num = colorByField([1, 2, 3, 4], 4);
  assert.equal(num.kind, "numeric");
  assert.equal(num.legend.length, 0);

  const none = colorByField([], 4);
  assert.equal(none.kind, "none");
  assert.equal(none.colors.length, 12);
});
