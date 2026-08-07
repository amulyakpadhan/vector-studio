import { test } from "node:test";
import assert from "node:assert/strict";
import { MilvusConnector } from "../src/connectors/milvus.ts";

/** Milvus always answers HTTP 200; the envelope's `code` carries success. */
function stubFetch(handler: (path: string, body: any) => unknown) {
  const calls: { path: string; body: any }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ path: url.pathname, body });
    const result = handler(url.pathname, body);
    return new Response(JSON.stringify(result ?? { code: 0, data: [] }), { status: 200 });
  }) as typeof fetch;
  return calls;
}

const conn = () => new MilvusConnector({ engine: "milvus", url: "http://localhost:19530", apiKey: "user:pass" });

const DESCRIBE = {
  code: 0,
  data: {
    collectionName: "docs",
    load: "LoadStateLoaded",
    fields: [
      { name: "id", type: "Int64", primaryKey: true },
      { name: "vector", type: "FloatVector", params: [{ key: "dim", value: "4" }] },
      { name: "title", type: "VarChar" },
    ],
    indexes: [{ fieldName: "vector", metricType: "COSINE" }],
  },
};

test("a non-zero envelope code fails even though HTTP is 200", async () => {
  stubFetch(() => ({ code: 1100, message: "collection not loaded" }));
  const res = await conn().testConnection();
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /not loaded/);
});

test("api key is sent as a bearer token", async () => {
  let auth: string | undefined;
  globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
    auth = (init?.headers as Record<string, string>)["Authorization"];
    return new Response(JSON.stringify({ code: 0, data: [] }), { status: 200 });
  }) as typeof fetch;
  await conn().testConnection();
  assert.equal(auth, "Bearer user:pass");
});

test("listCollections reports dimension and metric from the schema", async () => {
  stubFetch((path) => {
    if (path.endsWith("/collections/list")) return { code: 0, data: ["docs"] };
    if (path.endsWith("/collections/describe")) return DESCRIBE;
    if (path.endsWith("/entities/query")) return { code: 0, data: [{ "count(*)": 42 }] };
    return { code: 0, data: [] };
  });
  const cols = await conn().listCollections();
  assert.deepEqual(cols, [
    { name: "docs", count: 42, dimension: 4, metric: "cosine", status: "LoadStateLoaded" },
  ]);
});

test("browsing synthesises a match-all filter from the primary key", async () => {
  const calls = stubFetch((path) => {
    if (path.endsWith("/collections/describe")) return DESCRIBE;
    if (path.endsWith("/entities/query")) {
      return { code: 0, data: [{ id: 1, title: "one", vector: [0.1, 0.2, 0.3, 0.4] }] };
    }
    return { code: 0, data: [] };
  });
  const page = await conn().listRecords("docs", { limit: 1, withVectors: true });
  // Vector and primary key are lifted out; everything else is payload.
  assert.deepEqual(page.items[0], {
    id: 1,
    payload: { title: "one" },
    vector: [0.1, 0.2, 0.3, 0.4],
  });
  const query = calls.find((c) => c.path.endsWith("/entities/query"))!;
  assert.equal(query.body.filter, "id >= 0"); // numeric key
  assert.ok(query.body.outputFields.includes("vector"));
  assert.equal(page.nextCursor, "1"); // full page → next offset
});

test("a string primary key gets a string-shaped match-all filter", async () => {
  const stringPk = {
    code: 0,
    data: {
      ...DESCRIBE.data,
      fields: [
        { name: "doc_id", type: "VarChar", primaryKey: true },
        { name: "vector", type: "FloatVector", params: [{ key: "dim", value: "4" }] },
      ],
    },
  };
  const calls = stubFetch((path) => {
    if (path.endsWith("/collections/describe")) return stringPk;
    return { code: 0, data: [] };
  });
  await conn().listRecords("docs", { limit: 5 });
  const query = calls.find((c) => c.path.endsWith("/entities/query"))!;
  assert.equal(query.body.filter, 'doc_id != ""');
});

test("L2 distances invert to similarity; cosine passes through", async () => {
  const search = (metric: string) =>
    stubFetch((path) => {
      if (path.endsWith("/collections/describe")) {
        return { code: 0, data: { ...DESCRIBE.data, indexes: [{ fieldName: "vector", metricType: metric }] } };
      }
      if (path.endsWith("/entities/search")) {
        return { code: 0, data: [{ id: 1, title: "x", distance: 3 }] };
      }
      return { code: 0, data: [] };
    });

  search("COSINE");
  const cosine = await conn().vectorSearch("docs", { vector: [1, 2, 3, 4], limit: 1 });
  assert.equal(cosine[0]!.score, 3); // already a similarity

  search("L2");
  const l2 = await conn().vectorSearch("docs", { vector: [1, 2, 3, 4], limit: 1 });
  assert.equal(l2[0]!.score, 0.25); // 1 / (1 + 3): closer scores higher
});

test("deleteRecords quotes string ids and leaves numeric ids bare", async () => {
  const calls = stubFetch((path) => {
    if (path.endsWith("/collections/describe")) return DESCRIBE;
    return { code: 0, data: {} };
  });
  await conn().deleteRecords("docs", [1, 2]);
  const del = calls.find((c) => c.path.endsWith("/entities/delete"))!;
  assert.equal(del.body.filter, "id in [1, 2]");
});

test("updatePayload merges into the existing row instead of replacing it", async () => {
  const calls = stubFetch((path) => {
    if (path.endsWith("/collections/describe")) return DESCRIBE;
    if (path.endsWith("/entities/get")) {
      return { code: 0, data: [{ id: 1, title: "old", extra: "keep", vector: [0.1, 0.2, 0.3, 0.4] }] };
    }
    return { code: 0, data: {} };
  });
  await conn().updatePayload("docs", 1, { title: "new" });
  const upsert = calls.find((c) => c.path.endsWith("/entities/upsert"))!;
  // Milvus upserts whole rows, so untouched fields must survive the write.
  assert.deepEqual(upsert.body.data[0], {
    id: 1,
    vector: [0.1, 0.2, 0.3, 0.4],
    title: "new",
    extra: "keep",
  });
});

test("createCollection maps the metric to Milvus's name and defaults to a VarChar id", async () => {
  const calls = stubFetch(() => ({ code: 0, data: {} }));
  await conn().createCollection({ name: "new", dimension: 8, metric: "dot" });
  const create = calls.find((c) => c.path.endsWith("/collections/create"))!;
  assert.equal(create.body.metricType, "IP");
  assert.equal(create.body.dimension, 8);
  // VarChar, not Milvus's own Int64 default — Int64 primary keys reject any
  // non-numeric source id (e.g. a UUID cloned in from Weaviate) outright.
  assert.equal(create.body.idType, "VarChar");
});

test("an Int64-primary-key parse failure gets an explanatory hint appended", async () => {
  stubFetch((path) => {
    if (path.endsWith("/collections/describe")) return DESCRIBE;
    return {
      code: 65535,
      message: 'fail to deal the insert data, error: strconv.ParseInt: parsing "": invalid syntax: invalid parameter[expected=Int64][actual=]',
    };
  });
  await assert.rejects(
    conn().upsertRecords("docs", [{ id: "not-a-number", payload: {}, vector: [0.1, 0.2, 0.3, 0.4] }]),
    /primary key is Int64-typed.*VarChar/s,
  );
});

test("renameCollection posts collectionName/newCollectionName to the rename endpoint", async () => {
  const calls = stubFetch(() => ({ code: 0, data: {} }));
  await conn().renameCollection("docs", "docs_v2");
  const rename = calls.find((c) => c.path.endsWith("/collections/rename"))!;
  assert.deepEqual(rename.body, { collectionName: "docs", newCollectionName: "docs_v2" });
});
