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
  // nearVector can report `distance` but never `score` — asking for a field
  // the query type can't produce is what triggers Weaviate's server-side
  // "interface conversion" panic on bm25/hybrid queries.
  assert.match((gqlCall.body as any).query, /_additional\s*\{\s*id\s+distance\s*\}/);
});

test("textSearch bm25 reads _additional.score and never requests distance", async () => {
  const calls = stubFetch((method, path) => {
    if (path === "/v1/schema/Docs") return DOCS_CLASS;
    if (path === "/v1/graphql") {
      return { data: { Get: { Docs: [{ title: "hi", _additional: { id: "x", score: "1.7" } }] } } };
    }
    return {};
  });
  const hits = await conn().textSearch("Docs", { text: "hello", mode: "keyword", limit: 3 });
  assert.equal(hits[0]!.id, "x");
  assert.ok(Math.abs(hits[0]!.score - 1.7) < 1e-9);
  const gqlCall = calls.find((c) => c.path === "/v1/graphql")!;
  assert.match((gqlCall.body as any).query, /_additional\s*\{\s*id\s+score\s*\}/);
  assert.doesNotMatch((gqlCall.body as any).query, /distance/);
});

test("textSearch hybrid with a supplied vector blends keyword + vector", async () => {
  const calls = stubFetch((method, path) => {
    if (path === "/v1/schema/Docs") return DOCS_CLASS;
    if (path === "/v1/graphql") {
      return { data: { Get: { Docs: [{ title: "hi", _additional: { id: "x", score: "0.9" } }] } } };
    }
    return {};
  });
  const hits = await conn().textSearch("Docs", {
    text: "hello",
    mode: "hybrid",
    limit: 3,
    vector: [0.1, 0.2],
  });
  assert.equal(hits[0]!.id, "x");
  const gqlCall = calls.find((c) => c.path === "/v1/graphql")!;
  assert.match((gqlCall.body as any).query, /hybrid:\s*\{\s*query:\s*\$q,\s*vector:\s*\$vec,\s*alpha:\s*[\d.]+\s*\}/);
  assert.deepEqual((gqlCall.body as any).variables.vec, [0.1, 0.2]);
});

test("textSearch hybrid without a vector omits the $vec variable entirely", async () => {
  const calls = stubFetch((method, path) => {
    if (path === "/v1/schema/Docs") return DOCS_CLASS;
    if (path === "/v1/graphql") {
      return { data: { Get: { Docs: [{ title: "hi", _additional: { id: "y", score: "0.5" } }] } } };
    }
    return {};
  });
  await conn().textSearch("Docs", { text: "hello", mode: "hybrid", limit: 3 });
  const gqlCall = calls.find((c) => c.path === "/v1/graphql")!;
  assert.doesNotMatch((gqlCall.body as any).query, /\$vec/);
  assert.equal((gqlCall.body as any).variables.vec, undefined);
});

test("searchByText delegates to hybrid with alpha=1 and no client vector", async () => {
  const calls = stubFetch((_m, path) => {
    if (path === "/v1/schema/Docs") return DOCS_CLASS;
    if (path === "/v1/graphql") {
      return { data: { Get: { Docs: [{ title: "hi", _additional: { id: "z", score: "0.9" } }] } } };
    }
    return {};
  });
  const hits = await conn().searchByText("Docs", { text: "hello", limit: 5 });
  assert.equal(hits[0]!.id, "z");
  const gqlCall = calls.find((c) => c.path === "/v1/graphql")!;
  const body = gqlCall.body as { query: string; variables: Record<string, unknown> };
  assert.match(body.query, /hybrid: \{ query: \$q, alpha: 1 \}/);
  assert.equal(body.variables.vec, undefined);
});

test("getSchema exposes serverVectorizer when configured, undefined for vectorizer: none", async () => {
  const calls1 = stubFetch((_m, path) => {
    if (path === "/v1/schema/Docs") return DOCS_CLASS; // vectorizer: "none"
    if (path === "/v1/objects") return { objects: [] };
    return {};
  });
  const noneSchema = await conn().getSchema("Docs");
  assert.equal(noneSchema.serverVectorizer, undefined);
  assert.ok(calls1.length > 0);

  const AUTO_CLASS = { ...DOCS_CLASS, class: "Auto", vectorizer: "text2vec-openai" };
  stubFetch((_m, path) => {
    if (path === "/v1/schema/Auto") return AUTO_CLASS;
    if (path === "/v1/objects") return { objects: [] };
    return {};
  });
  const autoSchema = await conn().getSchema("Auto");
  assert.equal(autoSchema.serverVectorizer, "text2vec-openai");
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

test("a server-side 'interface conversion' panic gets an explanatory hint appended", async () => {
  stubFetch((method, path) => {
    if (path === "/v1/schema/Docs") return DOCS_CLASS;
    if (path === "/v1/graphql") return { errors: [{ message: "interface conversion: interface {} is int64, not int" }] };
    return {};
  });
  await assert.rejects(
    () => conn().textSearch("Docs", { text: "hi", mode: "keyword", limit: 3 }),
    (e: Error) =>
      e.name === "ConnectorError" &&
      /interface conversion/.test(e.message) &&
      /Weaviate server-side crash, not a Vyn bug/.test(e.message),
  );
});

test("createCollection hitting a free-tier collection cap gets an explanatory hint appended", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ errorCode: "USAGE_LIMIT_EXCEEDED", limit: "collections", message: "collections count limit of 1 reached for this instance.", value: 1 }),
      { status: 429 },
    )) as typeof fetch;
  await assert.rejects(
    () => conn().createCollection({ name: "Docs2", dimension: 8, metric: "cosine" }),
    (e: Error) =>
      e.name === "ConnectorError" &&
      /collections count limit/.test(e.message) &&
      /plan's collection limit, not a Vyn error/.test(e.message),
  );
});

test("a 429 unrelated to usage limits is left unmodified", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ errorCode: "SOMETHING_ELSE", message: "rate limited" }), { status: 429 })) as typeof fetch;
  await assert.rejects(
    () => conn().createCollection({ name: "Docs2", dimension: 8, metric: "cosine" }),
    (e: Error) => e.name === "ConnectorError" && !/plan's collection limit/.test(e.message),
  );
});
