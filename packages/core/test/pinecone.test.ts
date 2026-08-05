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
