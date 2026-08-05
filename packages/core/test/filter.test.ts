import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFilter, opSupported, type FilterSpec } from "../src/filter.ts";

const spec = (conditions: FilterSpec["conditions"], match: "all" | "any" = "all"): FilterSpec => ({ match, conditions });

test("empty / blank-field specs produce no filter", () => {
  assert.equal(buildFilter("qdrant", spec([])), undefined);
  assert.equal(buildFilter("qdrant", spec([{ field: "  ", op: "eq", value: 1 }])), undefined);
});

// ─── Qdrant ──────────────────────────────────────────────────────────────────

test("qdrant: match all → must, with eq/range/in/neq/contains clauses", () => {
  const f = buildFilter("qdrant", spec([
    { field: "brand", op: "eq", value: "nike" },
    { field: "price", op: "lte", value: 100 },
    { field: "size", op: "in", value: [8, 9, 10] },
    { field: "color", op: "neq", value: "red" },
    { field: "title", op: "contains", value: "trail" },
  ]));
  assert.deepEqual(f, {
    must: [
      { key: "brand", match: { value: "nike" } },
      { key: "price", range: { lte: 100 } },
      { key: "size", match: { any: [8, 9, 10] } },
      { key: "color", match: { except: ["red"] } },
      { key: "title", match: { text: "trail" } },
    ],
  });
});

test("qdrant: match any → should", () => {
  const f = buildFilter("qdrant", spec([{ field: "a", op: "eq", value: 1 }], "any")) as { should: unknown[] };
  assert.ok(Array.isArray(f.should));
});

// ─── Pinecone ────────────────────────────────────────────────────────────────

test("pinecone: single condition is bare, multiple wrap in $and/$or", () => {
  assert.deepEqual(buildFilter("pinecone", spec([{ field: "genre", op: "eq", value: "rock" }])), {
    genre: { $eq: "rock" },
  });
  const many = buildFilter("pinecone", spec([
    { field: "year", op: "gte", value: 2000 },
    { field: "genre", op: "in", value: ["rock", "pop"] },
  ]));
  assert.deepEqual(many, { $and: [{ year: { $gte: 2000 } }, { genre: { $in: ["rock", "pop"] } }] });

  const any = buildFilter("pinecone", spec([
    { field: "a", op: "eq", value: 1 },
    { field: "b", op: "eq", value: 2 },
  ], "any"));
  assert.deepEqual(any, { $or: [{ a: { $eq: 1 } }, { b: { $eq: 2 } }] });
});

test("pinecone: contains is rejected and reported via opSupported", () => {
  assert.equal(opSupported("pinecone", "contains"), false);
  assert.equal(opSupported("qdrant", "contains"), true);
  assert.throws(() => buildFilter("pinecone", spec([{ field: "t", op: "contains", value: "x" }])), /contains/);
});

// ─── Weaviate ────────────────────────────────────────────────────────────────

test("weaviate: single operand is unwrapped, typed by value", () => {
  assert.deepEqual(buildFilter("weaviate", spec([{ field: "title", op: "eq", value: "hi" }])), {
    path: ["title"],
    operator: "Equal",
    valueText: "hi",
  });
  assert.deepEqual(buildFilter("weaviate", spec([{ field: "count", op: "gt", value: 5 }])), {
    path: ["count"],
    operator: "GreaterThan",
    valueInt: 5,
  });
  assert.deepEqual(buildFilter("weaviate", spec([{ field: "rate", op: "lte", value: 1.5 }])), {
    path: ["rate"],
    operator: "LessThanEqual",
    valueNumber: 1.5,
  });
  assert.deepEqual(buildFilter("weaviate", spec([{ field: "active", op: "eq", value: true }])), {
    path: ["active"],
    operator: "Equal",
    valueBoolean: true,
  });
});

test("weaviate: contains → Like with wildcards", () => {
  assert.deepEqual(buildFilter("weaviate", spec([{ field: "title", op: "contains", value: "run" }])), {
    path: ["title"],
    operator: "Like",
    valueText: "*run*",
  });
});

// ─── Chroma ──────────────────────────────────────────────────────────────────

test("chroma: uses the Mongo-style dialect and rejects contains", () => {
  assert.deepEqual(buildFilter("chroma", spec([{ field: "brand", op: "eq", value: "nike" }])), {
    brand: { $eq: "nike" },
  });
  assert.deepEqual(
    buildFilter("chroma", spec([
      { field: "a", op: "gt", value: 1 },
      { field: "b", op: "in", value: ["x", "y"] },
    ], "any")),
    { $or: [{ a: { $gt: 1 } }, { b: { $in: ["x", "y"] } }] },
  );
  assert.equal(opSupported("chroma", "contains"), false);
  assert.throws(() => buildFilter("chroma", spec([{ field: "t", op: "contains", value: "x" }])), /chroma/);
});

// ─── Milvus ──────────────────────────────────────────────────────────────────

test("milvus: builds a boolean expression string", () => {
  assert.equal(
    buildFilter("milvus", spec([
      { field: "brand", op: "eq", value: "nike" },
      { field: "price", op: "lte", value: 100 },
    ])),
    '(brand == "nike") && (price <= 100)',
  );
  assert.equal(
    buildFilter("milvus", spec([{ field: "size", op: "in", value: [8, 9] }], "any")),
    "(size in [8, 9])",
  );
  assert.equal(
    buildFilter("milvus", spec([{ field: "title", op: "contains", value: "trail" }])),
    '(title like "%trail%")',
  );
  assert.equal(opSupported("milvus", "contains"), true);
});

test("weaviate: multiple conditions wrap in And/Or; in → Or of Equals", () => {
  const f = buildFilter("weaviate", spec([
    { field: "brand", op: "eq", value: "nike" },
    { field: "size", op: "in", value: [8, 9] },
  ]));
  assert.deepEqual(f, {
    operator: "And",
    operands: [
      { path: ["brand"], operator: "Equal", valueText: "nike" },
      {
        operator: "Or",
        operands: [
          { path: ["size"], operator: "Equal", valueInt: 8 },
          { path: ["size"], operator: "Equal", valueInt: 9 },
        ],
      },
    ],
  });
});
