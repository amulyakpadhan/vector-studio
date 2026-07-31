import { test } from "node:test";
import assert from "node:assert/strict";
import { WeaviateConnector } from "../src/connectors/weaviate.ts";

function stubFetch(handler: (method: string, path: string, body: unknown) => unknown) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, path: url.pathname + url.search, body });
    const result = handler(method, url.pathname, body);
    return new Response(JSON.stringify(result ?? {}), { status: 200 });
  }) as typeof fetch;
  return calls;
}

const conn = () => new WeaviateConnector({ engine: "weaviate", url: "http://localhost:8080", apiKey: "wk" });

const DOCS_CLASS = {
  class: "Docs",
  vectorizer: "none",
  properties: [{ name: "title", dataType: ["text"] }],
  vectorIndexConfig: { distance: "cosine" },
};

test("testConnection reads version from /v1/meta", async () => {
  const calls = stubFetch((_m, path) => (path === "/v1/meta" ? { version: "1.25.0" } : {}));
  const res = await conn().testConnection();
  assert.equal(res.ok, true);
  assert.equal(res.version, "1.25.0");
  assert.ok(calls[0]!.path.startsWith("/v1/meta"));
});

test("api key is sent as a Bearer token", async () => {
  let auth: string | undefined;
  globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
    auth = (init?.headers as Record<string, string>)["Authorization"];
    return new Response(JSON.stringify({ version: "1" }), { status: 200 });
  }) as typeof fetch;
  await conn().testConnection();
  assert.equal(auth, "Bearer wk");
});

test("listCollections maps classes and pulls Aggregate counts", async () => {
  stubFetch((method, path, body) => {
    if (path === "/v1/schema") return { classes: [DOCS_CLASS] };
    if (path === "/v1/graphql") {
      // aggregate count query
      return { data: { Aggregate: { Docs: [{ meta: { count: 12 } }] } } };
    }
    return {};
  });
  const cols = await conn().listCollections();
  assert.equal(cols.length, 1);
  assert.equal(cols[0]!.name, "Docs");
  assert.equal(cols[0]!.count, 12);
  assert.equal(cols[0]!.metric, "cosine");
});

test("listRecords uses REST cursor (after) and maps objects", async () => {
  const calls = stubFetch((method, path) => {
    if (path === "/v1/objects") {
      return {
        objects: [
          { id: "a", properties: { title: "one" }, vector: [0.1] },
          { id: "b", properties: { title: "two" }, vector: [0.2] },
        ],
      };
    }
    return {};
  });
  const page = await conn().listRecords("Docs", { limit: 2, withVectors: true });
  assert.equal(page.items.length, 2);
  assert.equal(page.items[0]!.id, "a");
  assert.equal(page.nextCursor, "b"); // full page → cursor = last id
  assert.ok(calls[0]!.path.includes("class=Docs"));
  assert.ok(calls[0]!.path.includes("include=vector"));
});

test("createCollection maps euclidean → l2-squared with vectorizer none", async () => {
  const calls = stubFetch(() => ({}));
  await conn().createCollection({ name: "New", dimension: 8, metric: "euclidean" });
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.path, "/v1/schema");
  assert.equal((calls[0]!.body as any).vectorIndexConfig.distance, "l2-squared");
  assert.equal((calls[0]!.body as any).vectorizer, "none");
});

test("vectorSearch builds a GraphQL nearVector query and normalizes distance→similarity", async () => {
  const calls = stubFetch((method, path) => {
    if (path === "/v1/schema/Docs") return DOCS_CLASS;
    if (path === "/v1/graphql") {
      return {
        data: {
          Get: {
            Docs: [{ title: "one", _additional: { id: "a", distance: 0.25 } }],
          },
        },
      };
    }
    return {};
  });
  const hits = await conn().vectorSearch("Docs", { vector: [0.1, 0.2], limit: 5 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.id, "a");
  assert.equal(hits[0]!.payload.title, "one");
  assert.ok(Math.abs(hits[0]!.score - 0.75) < 1e-9); // 1 - distance
  // the GraphQL body should carry the vector as a variable
  const gqlCall = calls.find((c) => c.path === "/v1/graphql")!;
  assert.deepEqual((gqlCall.body as any).variables.vec, [0.1, 0.2]);
});

test("textSearch bm25 reads _additional.score", async () => {
  stubFetch((method, path) => {
    if (path === "/v1/schema/Docs") return DOCS_CLASS;
    if (path === "/v1/graphql") {
      return { data: { Get: { Docs: [{ title: "hi", _additional: { id: "x", score: "1.7" } }] } } };
    }
    return {};
  });
  const hits = await conn().textSearch("Docs", { text: "hello", mode: "keyword", limit: 3 });
  assert.equal(hits[0]!.id, "x");
  assert.ok(Math.abs(hits[0]!.score - 1.7) < 1e-9);
});

test("GraphQL errors surface as ConnectorError", async () => {
  stubFetch((method, path) => {
    if (path === "/v1/schema/Docs") return DOCS_CLASS;
    if (path === "/v1/graphql") return { errors: [{ message: "boom" }] };
    return {};
  });
  await assert.rejects(
    () => conn().vectorSearch("Docs", { vector: [1], limit: 1 }),
    (e: Error) => e.name === "ConnectorError" && /boom/.test(e.message),
  );
});
