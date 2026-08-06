import { test } from "node:test";
import assert from "node:assert/strict";
import { ChromaConnector } from "../src/connectors/chroma.ts";

/** Handler returns undefined to signal 404 for an unmatched route. */
function stubFetch(handler: (method: string, path: string, body: unknown) => unknown) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, path: url.pathname, body });
    const result = handler(method, url.pathname, body);
    if (result === undefined) {
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }
    return new Response(JSON.stringify(result), { status: 200 });
  }) as typeof fetch;
  return calls;
}

const conn = () => new ChromaConnector({ engine: "chroma", url: "http://localhost:8000" });

const V2 = "/api/v2/tenants/default_tenant/databases/default_database/collections";
const DOCS = { id: "uuid-1", name: "docs", metadata: { "hnsw:space": "cosine" }, dimension: 3 };

test("prefers the v2 API when the server answers it", async () => {
  const calls = stubFetch((_m, path) => {
    if (path === V2) return [DOCS];
    if (path === "/api/v2/version") return "1.0.0";
    if (path.endsWith("/count")) return 7;
    return undefined;
  });
  const cols = await conn().listCollections();
  assert.deepEqual(cols, [{ name: "docs", count: 7, dimension: 3, metric: "cosine" }]);
  assert.ok(calls.some((c) => c.path === V2));
  assert.ok(!calls.some((c) => c.path.startsWith("/api/v1")));
});

test("falls back to the v1 API when v2 is absent", async () => {
  const calls = stubFetch((_m, path) => {
    if (path === V2) return undefined; // 404 → older server
    if (path === "/api/v1/collections") return [DOCS];
    if (path.endsWith("/count")) return 2;
    return undefined;
  });
  const cols = await conn().listCollections();
  assert.equal(cols[0]!.name, "docs");
  assert.ok(calls.some((c) => c.path === "/api/v1/collections"));
});

test("a non-404 from v2 surfaces instead of silently falling back", async () => {
  // An auth failure means the server does speak v2; retrying on v1 would hide it.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })) as typeof fetch;
  const res = await conn().testConnection();
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /401/);
});

test("listRecords folds parallel arrays into records and pages by offset", async () => {
  const calls = stubFetch((_m, path) => {
    if (path === V2) return [DOCS];
    if (path === `${V2}/docs`) return DOCS;
    if (path === `${V2}/uuid-1/get`) {
      return {
        ids: ["a", "b"],
        metadatas: [{ tag: "x" }, { tag: "y" }],
        documents: ["first", "second"],
        embeddings: [[0.1], [0.2]],
      };
    }
    return undefined;
  });
  const page = await conn().listRecords("docs", { limit: 2, withVectors: true });
  assert.equal(page.items.length, 2);
  // The document is surfaced alongside metadata so it shows in the grid.
  assert.deepEqual(page.items[0], { id: "a", payload: { tag: "x", document: "first" }, vector: [0.1] });
  assert.equal(page.nextCursor, "2"); // full page → next offset
  const getCall = calls.find((c) => c.path.endsWith("/get"))!;
  assert.equal((getCall.body as any).offset, 0);
  assert.ok((getCall.body as any).include.includes("embeddings"));
});

test("vectorSearch un-nests query results and converts distance to similarity", async () => {
  stubFetch((_m, path) => {
    if (path === V2) return [DOCS];
    if (path === `${V2}/docs`) return DOCS;
    if (path === `${V2}/uuid-1/query`) {
      return {
        ids: [["a"]],
        distances: [[0.25]],
        metadatas: [[{ tag: "x" }]],
        documents: [["text"]],
      };
    }
    return undefined;
  });
  const hits = await conn().vectorSearch("docs", { vector: [0.1, 0.2], limit: 5 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.id, "a");
  assert.ok(Math.abs(hits[0]!.score - 0.75) < 1e-9); // 1 - distance
  assert.deepEqual(hits[0]!.payload, { tag: "x", document: "text" });
});

test("upsert splits the document back out of the payload", async () => {
  const calls = stubFetch((_m, path) => {
    if (path === V2) return [DOCS];
    if (path === `${V2}/docs`) return DOCS;
    if (path === `${V2}/uuid-1/upsert`) return {};
    return undefined;
  });
  await conn().upsertRecords("docs", [
    { id: "a", payload: { tag: "x", document: "hello" }, vector: [0.1] },
  ]);
  const body = calls.find((c) => c.path.endsWith("/upsert"))!.body as any;
  assert.deepEqual(body.metadatas, [{ tag: "x" }]); // document not left in metadata
  assert.deepEqual(body.documents, ["hello"]);
  assert.deepEqual(body.ids, ["a"]);
});

test("createCollection maps the metric onto hnsw:space", async () => {
  const calls = stubFetch((method, path) => {
    if (path === V2) return method === "POST" ? {} : [];
    return undefined;
  });
  await conn().createCollection({ name: "new", dimension: 8, metric: "euclidean" });
  const post = calls.find((c) => c.method === "POST")!;
  assert.equal((post.body as any).metadata["hnsw:space"], "l2");
});

test("record endpoints use the collection uuid, not its name", async () => {
  const calls = stubFetch((_m, path) => {
    if (path === V2) return [];
    if (path === `${V2}/docs`) return DOCS;
    if (path === `${V2}/uuid-1/delete`) return {};
    return undefined;
  });
  await conn().deleteRecords("docs", ["a"]);
  assert.ok(calls.some((c) => c.path === `${V2}/uuid-1/delete`));
});

test("renameCollection PUTs new_name to the collection's uuid endpoint", async () => {
  const calls = stubFetch((_m, path) => {
    if (path === V2) return [];
    if (path === `${V2}/docs`) return DOCS;
    if (path === `${V2}/uuid-1`) return {};
    return undefined;
  });
  await conn().renameCollection("docs", "docs_v2");
  const put = calls.find((c) => c.method === "PUT" && c.path === `${V2}/uuid-1`)!;
  assert.deepEqual(put.body, { new_name: "docs_v2" });
});

test("renameCollection refuses on the legacy v1 API instead of 404ing", async () => {
  stubFetch((_m, path) => {
    if (path === V2) return undefined;
    if (path === "/api/v1/collections") return [];
    return undefined;
  });
  await assert.rejects(
    () => conn().renameCollection("docs", "docs_v2"),
    (e: Error) => e.name === "ConnectorError" && /v2 API/.test(e.message),
  );
});
