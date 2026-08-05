import { test } from "node:test";
import assert from "node:assert/strict";
import { PineconeConnector } from "../src/connectors/pinecone.ts";

/** Route key is `METHOD pathname` on whichever host is called. */
function stubFetch(routes: Record<string, unknown>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const key = `${init?.method ?? "GET"} ${path}`;
    if (!(key in routes)) {
      return new Response(JSON.stringify({ message: `no route: ${key}` }), { status: 404 });
    }
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;
  return calls;
}

const conn = () => new PineconeConnector({ engine: "pinecone", url: "", apiKey: "pk" });

const INDEX = {
  name: "docs",
  dimension: 1536,
  metric: "cosine",
  host: "docs-abc.svc.pinecone.io",
  status: { ready: true, state: "Ready" },
};

test("testConnection fails fast without an api key", async () => {
  const res = await new PineconeConnector({ engine: "pinecone", url: "" }).testConnection();
  assert.equal(res.ok, false);
});

test("api key is sent as Api-Key header to the control plane", async () => {
  const calls = stubFetch({ "GET /indexes": { indexes: [] } });
  await conn().testConnection();
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers["Api-Key"], "pk");
  assert.ok(calls[0]?.url.startsWith("https://api.pinecone.io"));
});

test("control-plane calls always hit api.pinecone.io, even if a data-plane/index URL was saved on the connection", async () => {
  const calls = stubFetch({ "GET /indexes": { indexes: [] } });
  const c = new PineconeConnector({
    engine: "pinecone",
    url: "https://my-index-abc123.svc.us-east-1-aws.pinecone.io",
    apiKey: "pk",
  });
  await c.testConnection();
  assert.ok(calls[0]?.url.startsWith("https://api.pinecone.io/indexes"));
});

test("listCollections maps indexes and pulls counts from the data plane", async () => {
  stubFetch({
    "GET /indexes": { indexes: [INDEX] },
    "POST /describe_index_stats": { totalVectorCount: 128, dimension: 1536 },
  });
  const cols = await conn().listCollections();
  assert.equal(cols.length, 1);
  assert.deepEqual(cols[0], { name: "docs", count: 128, dimension: 1536, metric: "cosine", status: "Ready" });
});

test("dot metric maps to dotproduct on create", async () => {
  const calls = stubFetch({ "POST /indexes": {} });
  await conn().createCollection({ name: "x", dimension: 8, metric: "dot" });
  const body = JSON.parse((calls[0]?.init?.body as string) ?? "{}");
  assert.equal(body.metric, "dotproduct");
  assert.equal(body.spec.serverless.cloud, "aws");
});

test("createCollection honors a custom cloud/region from options", async () => {
  const calls = stubFetch({ "POST /indexes": {} });
  await conn().createCollection({
    name: "x",
    dimension: 8,
    metric: "cosine",
    options: { cloud: "gcp", region: "us-central1" },
  });
  const body = JSON.parse((calls[0]?.init?.body as string) ?? "{}");
  assert.deepEqual(body.spec.serverless, { cloud: "gcp", region: "us-central1" });
});

test("listRecords lists ids then fetches them from the index host", async () => {
  const calls = stubFetch({
    "GET /indexes/docs": INDEX,
    "GET /vectors/list": { vectors: [{ id: "a" }, { id: "b" }], pagination: { next: "tok2" } },
    "GET /vectors/fetch": {
      vectors: {
        a: { id: "a", values: [0.1], metadata: { t: "hello" } },
        b: { id: "b", values: [0.2], metadata: { t: "world" } },
      },
    },
  });
  const page = await conn().listRecords("docs", { limit: 2 });
  assert.equal(page.items.length, 2);
  assert.equal(page.nextCursor, "tok2");
  assert.deepEqual(page.items[0], { id: "a", payload: { t: "hello" }, vector: [0.1] });
  // data-plane calls must hit the index host, not the control plane
  assert.ok(calls.some((c) => c.url.includes("docs-abc.svc.pinecone.io/vectors/list")));
});

test("vectorSearch maps matches", async () => {
  stubFetch({
    "GET /indexes/docs": INDEX,
    "POST /query": { matches: [{ id: "a", score: 0.88, metadata: { t: "x" } }] },
  });
  const hits = await conn().vectorSearch("docs", { vector: [0.1, 0.2], limit: 3 });
  assert.deepEqual(hits, [{ id: "a", score: 0.88, payload: { t: "x" }, vector: undefined }]);
});

// ─── integrated inference ────────────────────────────────────────────────────

const INTEGRATED_INDEX = {
  name: "docs",
  metric: "cosine",
  host: "docs-abc.svc.pinecone.io",
  status: { ready: true, state: "Ready" },
  embed: { model: "multilingual-e5-large", field_map: { text: "chunk_text" }, dimension: 1024 },
};

test("getSchema exposes serverVectorizer + serverVectorizerField for an integrated index", async () => {
  stubFetch({ "GET /indexes/docs": INTEGRATED_INDEX });
  const schema = await conn().getSchema("docs");
  assert.equal(schema.serverVectorizer, "multilingual-e5-large");
  assert.equal(schema.serverVectorizerField, "chunk_text");
  assert.equal(schema.dimension, 1024); // falls back to embed.dimension
});

test("getSchema reports no serverVectorizer for a classic index", async () => {
  stubFetch({ "GET /indexes/docs": INDEX });
  const schema = await conn().getSchema("docs");
  assert.equal(schema.serverVectorizer, undefined);
  assert.equal(schema.serverVectorizerField, undefined);
});

test("createCollection with an embedModel option hits create-for-model", async () => {
  const calls = stubFetch({ "POST /indexes/create-for-model": {} });
  await conn().createCollection({
    name: "docs",
    dimension: 0,
    metric: "cosine",
    options: { embedModel: "multilingual-e5-large", embedField: "chunk_text", cloud: "gcp", region: "us-central1" },
  });
  const call = calls.find((c) => c.url.includes("/indexes/create-for-model"))!;
  const body = JSON.parse(call.init!.body as string);
  assert.deepEqual(body, {
    name: "docs",
    cloud: "gcp",
    region: "us-central1",
    embed: { model: "multilingual-e5-large", field_map: { text: "chunk_text" } },
  });
});

test("upsertRecords with no vector on an integrated index sends NDJSON to the records upsert endpoint", async () => {
  const calls = stubFetch({
    "GET /indexes/docs": INTEGRATED_INDEX,
    "POST /records/namespaces/default/upsert": {},
  });
  const res = await conn().upsertRecords("docs", [
    { id: "rec1", payload: { chunk_text: "hello world", category: "greeting" } },
    { id: "rec2", payload: { chunk_text: "goodbye world", category: "farewell" } },
  ]);
  assert.equal(res.upserted, 2);
  const call = calls.find((c) => c.url.includes("/records/namespaces/default/upsert"))!;
  assert.equal((call.init!.headers as Record<string, string>)["Content-Type"], "application/x-ndjson");
  const lines = (call.init!.body as string).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines, [
    { _id: "rec1", chunk_text: "hello world", category: "greeting" },
    { _id: "rec2", chunk_text: "goodbye world", category: "farewell" },
  ]);
});

test("upsertRecords splits a mixed batch between /vectors/upsert and the records endpoint", async () => {
  const calls = stubFetch({
    "GET /indexes/docs": INTEGRATED_INDEX,
    "POST /vectors/upsert": { upsertedCount: 1 },
    "POST /records/namespaces/default/upsert": {},
  });
  const res = await conn().upsertRecords("docs", [
    { id: "vec1", vector: [0.1, 0.2], payload: { chunk_text: "has a vector already" } },
    { id: "rec1", payload: { chunk_text: "needs server embedding" } },
  ]);
  assert.equal(res.upserted, 2);
  assert.ok(calls.some((c) => c.url.includes("/vectors/upsert")));
  assert.ok(calls.some((c) => c.url.includes("/records/namespaces/default/upsert")));
});

test("upsertRecords without a vector throws clearly when the index has no server embedding", async () => {
  stubFetch({ "GET /indexes/docs": INDEX });
  await assert.rejects(
    () => conn().upsertRecords("docs", [{ id: "rec1", payload: { text: "no vector, no embed config" } }]),
    (e: Error) => e.name === "ConnectorError" && /no server-side embedding configured/.test(e.message),
  );
});

test("upsertRecords throws when a record is missing the embed field", async () => {
  stubFetch({ "GET /indexes/docs": INTEGRATED_INDEX });
  await assert.rejects(
    () => conn().upsertRecords("docs", [{ id: "rec1", payload: { wrong_field: "oops" } }]),
    (e: Error) => e.name === "ConnectorError" && /no "chunk_text" field/.test(e.message),
  );
});

test("searchByText posts to the records search endpoint and maps hits", async () => {
  const calls = stubFetch({
    "GET /indexes/docs": INTEGRATED_INDEX,
    "POST /records/namespaces/default/search": {
      result: { hits: [{ _id: "rec1", _score: 0.93, fields: { chunk_text: "hello world" } }] },
    },
  });
  const hits = await conn().searchByText("docs", { text: "greeting", limit: 5 });
  assert.deepEqual(hits, [{ id: "rec1", score: 0.93, payload: { chunk_text: "hello world" } }]);
  const call = calls.find((c) => c.url.includes("/records/namespaces/default/search"))!;
  const body = JSON.parse(call.init!.body as string);
  assert.deepEqual(body.query, { top_k: 5, inputs: { text: "greeting" } });
});

test("searchByText uses the configured namespace instead of 'default' when one is set", async () => {
  const calls = stubFetch({
    "GET /indexes/docs": INTEGRATED_INDEX,
    "POST /records/namespaces/prod/search": { result: { hits: [] } },
  });
  const c = new PineconeConnector({ engine: "pinecone", url: "", apiKey: "pk", options: { namespace: "prod" } });
  await c.searchByText("docs", { text: "x", limit: 1 });
  assert.ok(calls.some((call) => call.url.includes("/records/namespaces/prod/search")));
});

// ─── sparse vectors ─────────────────────────────────────────────────────────

test("upsertRecords sends sparseValues alongside dense values", async () => {
  const calls = stubFetch({
    "GET /indexes/docs": INDEX,
    "POST /vectors/upsert": { upsertedCount: 1 },
  });
  await conn().upsertRecords("docs", [
    {
      id: "rec1",
      vector: [0.1, 0.2],
      sparseVector: { indices: [3, 91], values: [0.5, 0.25] },
      payload: { title: "hybrid" },
    },
  ]);
  const call = calls.find((c) => c.url.includes("/vectors/upsert"))!;
  const body = JSON.parse(call.init!.body as string);
  assert.deepEqual(body.vectors[0], {
    id: "rec1",
    values: [0.1, 0.2],
    sparseValues: { indices: [3, 91], values: [0.5, 0.25] },
    metadata: { title: "hybrid" },
  });
});

test("upsertRecords treats a sparse-only record as vector-bearing (no server embedding required)", async () => {
  const calls = stubFetch({
    "GET /indexes/docs": INDEX,
    "POST /vectors/upsert": { upsertedCount: 1 },
  });
  const res = await conn().upsertRecords("docs", [
    { id: "rec1", sparseVector: { indices: [1, 2], values: [0.9, 0.1] }, payload: { title: "sparse only" } },
  ]);
  assert.equal(res.upserted, 1);
  const call = calls.find((c) => c.url.includes("/vectors/upsert"))!;
  const body = JSON.parse(call.init!.body as string);
  assert.deepEqual(body.vectors[0], {
    id: "rec1",
    sparseValues: { indices: [1, 2], values: [0.9, 0.1] },
    metadata: { title: "sparse only" },
  });
  assert.ok(!("values" in body.vectors[0]));
});

test("vectorSearch sends sparseVector for dense+sparse hybrid queries and maps it back on hits", async () => {
  const calls = stubFetch({
    "GET /indexes/docs": INDEX,
    "POST /query": {
      matches: [{ id: "a", score: 0.9, metadata: { t: "x" }, sparseValues: { indices: [4], values: [0.7] } }],
    },
  });
  const hits = await conn().vectorSearch("docs", {
    vector: [0.1, 0.2],
    sparseVector: { indices: [4], values: [0.7] },
    limit: 3,
  });
  assert.deepEqual(hits, [
    { id: "a", score: 0.9, payload: { t: "x" }, vector: undefined, sparseVector: { indices: [4], values: [0.7] } },
  ]);
  const call = calls.find((c) => c.url.includes("/query"))!;
  const body = JSON.parse(call.init!.body as string);
  assert.deepEqual(body.sparseVector, { indices: [4], values: [0.7] });
  assert.deepEqual(body.vector, [0.1, 0.2]);
});

test("vectorSearch omits `vector` entirely for a sparse-only query", async () => {
  const calls = stubFetch({
    "GET /indexes/docs": INDEX,
    "POST /query": { matches: [] },
  });
  await conn().vectorSearch("docs", { vector: [], sparseVector: { indices: [1], values: [1] }, limit: 5 });
  const call = calls.find((c) => c.url.includes("/query"))!;
  const body = JSON.parse(call.init!.body as string);
  assert.ok(!("vector" in body));
  assert.deepEqual(body.sparseVector, { indices: [1], values: [1] });
});
