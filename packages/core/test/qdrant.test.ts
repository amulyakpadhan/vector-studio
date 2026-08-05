import { test } from "node:test";
import assert from "node:assert/strict";
import { QdrantConnector } from "../src/connectors/qdrant.ts";

/** Swap global fetch for a stub that returns canned Qdrant responses. */
function stubFetch(routes: Record<string, unknown>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const key = `${init?.method ?? "GET"} ${path}`;
    if (!(key in routes)) {
      return new Response(JSON.stringify({ status: { error: `no route: ${key}` } }), { status: 404 });
    }
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;
  return calls;
}

const conn = () => new QdrantConnector({ engine: "qdrant", url: "http://localhost:6333", apiKey: "k" });

test("testConnection reports version and latency", async () => {
  stubFetch({ "GET /": { title: "qdrant - vector search engine", version: "1.9.0" } });
  const res = await conn().testConnection();
  assert.equal(res.ok, true);
  assert.equal(res.version, "1.9.0");
  assert.ok(typeof res.latencyMs === "number");
});

test("api key is sent as api-key header", async () => {
  const calls = stubFetch({ "GET /": { title: "qdrant", version: "1.9.0" } });
  await conn().testConnection();
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers["api-key"], "k");
});

test("listCollections merges per-collection detail", async () => {
  stubFetch({
    "GET /collections": { result: { collections: [{ name: "docs" }] }, status: "ok", time: 0 },
    "GET /collections/docs": {
      result: {
        status: "green",
        points_count: 42,
        config: { params: { vectors: { size: 384, distance: "Cosine" } } },
        payload_schema: { title: { data_type: "keyword" } },
      },
      status: "ok",
      time: 0,
    },
  });
  const cols = await conn().listCollections();
  assert.deepEqual(cols, [{ name: "docs", count: 42, dimension: 384, metric: "cosine", status: "green" }]);
});

test("listRecords paginates via opaque cursor", async () => {
  stubFetch({
    "POST /collections/docs/points/scroll": {
      result: {
        points: [{ id: 1, payload: { t: "a" } }],
        next_page_offset: 17,
      },
      status: "ok",
      time: 0,
    },
  });
  const page = await conn().listRecords("docs", { limit: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.id, 1);
  assert.equal(page.nextCursor, "17");
});

test("vectorSearch maps scored points", async () => {
  stubFetch({
    "POST /collections/docs/points/search": {
      result: [{ id: "a", score: 0.91, payload: { t: "x" } }],
      status: "ok",
      time: 0,
    },
  });
  const hits = await conn().vectorSearch("docs", { vector: [0.1, 0.2], limit: 5 });
  assert.deepEqual(hits, [{ id: "a", score: 0.91, payload: { t: "x" }, vector: undefined }]);
});

test("getRecord retrieves with the vector included", async () => {
  const calls = stubFetch({
    "POST /collections/docs/points": {
      result: [{ id: 7, payload: { t: "x" }, vector: [0.1, 0.2] }],
      status: "ok",
      time: 0,
    },
  });
  const rec = await conn().getRecord("docs", 7);
  assert.deepEqual(rec, { id: 7, payload: { t: "x" }, vector: [0.1, 0.2] });
  const body = JSON.parse((calls[0]?.init?.body as string) ?? "{}");
  assert.equal(body.with_vector, true);
});

test("http errors become ConnectorError with status", async () => {
  stubFetch({});
  await assert.rejects(
    () => conn().getStats("missing"),
    (err: Error & { status?: number }) => err.name === "ConnectorError" && err.status === 404,
  );
});

// ─── Qdrant Cloud Inference ──────────────────────────────────────────────────

const withInference = () =>
  new QdrantConnector({
    engine: "qdrant",
    url: "http://localhost:6333",
    apiKey: "k",
    options: { inferenceModel: "sentence-transformers/all-MiniLM-L6-v2", inferenceField: "chunk_text" },
  });

test("getSchema exposes serverVectorizer/serverVectorizerField only when an inference model is configured", async () => {
  const detail = {
    result: {
      status: "green",
      points_count: 0,
      config: { params: { vectors: { size: 384, distance: "Cosine" } } },
      payload_schema: {},
    },
    status: "ok",
    time: 0,
  };
  stubFetch({ "GET /collections/docs": detail });
  const withIt = await withInference().getSchema("docs");
  assert.equal(withIt.serverVectorizer, "sentence-transformers/all-MiniLM-L6-v2");
  assert.equal(withIt.serverVectorizerField, "chunk_text");

  stubFetch({ "GET /collections/docs": detail });
  const without = await conn().getSchema("docs");
  assert.equal(without.serverVectorizer, undefined);
  assert.equal(without.serverVectorizerField, undefined);
});

test("upsertRecords sends a Document in place of the vector when a record has none", async () => {
  const calls = stubFetch({ "PUT /collections/docs/points": { result: {}, status: "ok", time: 0 } });
  await withInference().upsertRecords("docs", [
    { id: 1, payload: { chunk_text: "hello world" } },
    { id: 2, vector: [0.1, 0.2], payload: { chunk_text: "already embedded" } },
  ]);
  const body = JSON.parse((calls[0]?.init?.body as string) ?? "{}");
  assert.deepEqual(body.points[0].vector, { text: "hello world", model: "sentence-transformers/all-MiniLM-L6-v2" });
  assert.deepEqual(body.points[1].vector, [0.1, 0.2]);
});

test("upsertRecords throws when no inference model is configured and a record has no vector", async () => {
  stubFetch({});
  await assert.rejects(
    () => conn().upsertRecords("docs", [{ id: 1, payload: { text: "x" } }]),
    (e: Error) => e.name === "ConnectorError" && /no Qdrant Cloud Inference model is configured/.test(e.message),
  );
});

test("upsertRecords throws when the configured embed field is missing from the payload", async () => {
  stubFetch({});
  await assert.rejects(
    () => withInference().upsertRecords("docs", [{ id: 1, payload: { wrong_field: "x" } }]),
    (e: Error) => e.name === "ConnectorError" && /no "chunk_text" field/.test(e.message),
  );
});

test("searchByText posts a Document query to /points/query and maps hits", async () => {
  const calls = stubFetch({
    "POST /collections/docs/points/query": {
      result: { points: [{ id: "a", score: 0.8, payload: { chunk_text: "hi" } }] },
      status: "ok",
      time: 0,
    },
  });
  const hits = await withInference().searchByText("docs", { text: "greeting", limit: 5 });
  assert.deepEqual(hits, [{ id: "a", score: 0.8, payload: { chunk_text: "hi" }, vector: undefined }]);
  const body = JSON.parse((calls[0]?.init?.body as string) ?? "{}");
  assert.deepEqual(body.query, { text: "greeting", model: "sentence-transformers/all-MiniLM-L6-v2" });
});

test("searchByText throws when no inference model is configured", async () => {
  stubFetch({});
  await assert.rejects(
    () => conn().searchByText("docs", { text: "x", limit: 1 }),
    (e: Error) => e.name === "ConnectorError" && /No Qdrant Cloud Inference model configured/.test(e.message),
  );
});
