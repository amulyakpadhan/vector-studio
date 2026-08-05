import { test } from "node:test";
import assert from "node:assert/strict";
import { embedText, embedTexts, defaultModelFor, modelInfo } from "../src/embeddings.ts";

function stubFetch(handler: (url: string, body: unknown) => unknown) {
  const calls: { url: string; init?: RequestInit; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url: String(input), init, body });
    return new Response(JSON.stringify(handler(String(input), body)), { status: 200 });
  }) as typeof fetch;
  return calls;
}

test("defaultModelFor / modelInfo expose the registry", () => {
  assert.equal(defaultModelFor("openai"), "text-embedding-3-small");
  assert.equal(modelInfo("openai", "text-embedding-3-large")!.dim, 3072);
  assert.equal(modelInfo("cohere", "embed-english-light-v3.0")!.dim, 384);
  assert.equal(modelInfo("openai", "nope"), undefined);
});

test("embedText(openai) posts an array input with a Bearer token and default model", async () => {
  const calls = stubFetch(() => ({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }));
  const vector = await embedText({ provider: "openai", apiKey: "sk-test" }, "hello world");
  assert.deepEqual(vector, [0.1, 0.2, 0.3]);
  assert.equal(calls[0]!.url, "https://api.openai.com/v1/embeddings");
  assert.equal((calls[0]!.init!.headers as Record<string, string>)["Authorization"], "Bearer sk-test");
  const body = calls[0]!.body as { model: string; input: string[] };
  assert.equal(body.model, "text-embedding-3-small");
  assert.deepEqual(body.input, ["hello world"]);
});

test("embedText defaults to the query input type; documents override it", async () => {
  const cohere = stubFetch(() => ({ embeddings: [[1]] }));
  await embedText({ provider: "cohere", apiKey: "co" }, "q");
  assert.equal((cohere[0]!.body as { input_type: string }).input_type, "search_query");

  const cohere2 = stubFetch(() => ({ embeddings: [[1]] }));
  await embedText({ provider: "cohere", apiKey: "co" }, "d", { inputType: "document" });
  assert.equal((cohere2[0]!.body as { input_type: string }).input_type, "search_document");

  const voyage = stubFetch(() => ({ data: [{ index: 0, embedding: [1] }] }));
  await embedText({ provider: "voyage", apiKey: "vo" }, "d", { inputType: "document" });
  assert.equal((voyage[0]!.body as { input_type: string }).input_type, "document");
});

test("embedTexts preserves input order even if the provider returns them shuffled", async () => {
  stubFetch(() => ({
    data: [
      { index: 2, embedding: [2] },
      { index: 0, embedding: [0] },
      { index: 1, embedding: [1] },
    ],
  }));
  const vectors = await embedTexts({ provider: "openai", apiKey: "sk" }, ["a", "b", "c"]);
  assert.deepEqual(vectors, [[0], [1], [2]]);
});

test("embedTexts batches beyond the provider limit and concatenates in order", async () => {
  const calls = stubFetch((_url, body) => {
    const input = (body as { input: string[] }).input;
    return { data: input.map((_t, i) => ({ index: i, embedding: [Number(input[i])] })) };
  });
  const texts = Array.from({ length: 200 }, (_v, i) => String(i));
  const vectors = await embedTexts({ provider: "openai", apiKey: "sk" }, texts);
  assert.equal(calls.length, 3);
  assert.equal(vectors.length, 200);
  assert.deepEqual(vectors[0], [0]);
  assert.deepEqual(vectors[199], [199]);
});

test("embedTexts passes the dimensions param through for openai", async () => {
  const calls = stubFetch(() => ({ data: [{ index: 0, embedding: [1, 2] }] }));
  await embedTexts({ provider: "openai", apiKey: "sk" }, ["x"], { dimensions: 512 });
  assert.equal((calls[0]!.body as { dimensions: number }).dimensions, 512);
});

test("embedTexts([]) short-circuits without a request", async () => {
  const calls = stubFetch(() => ({ data: [] }));
  const out = await embedTexts({ provider: "openai", apiKey: "sk" }, []);
  assert.deepEqual(out, []);
  assert.equal(calls.length, 0);
});

test("embedText routes through the bridge when bridgeUrl is set", async () => {
  const calls = stubFetch(() => ({ data: [{ index: 0, embedding: [1] }] }));
  await embedText({ provider: "openai", apiKey: "sk" }, "hi", { bridgeUrl: "http://localhost:5433" });
  assert.ok(calls[0]!.url.startsWith("http://localhost:5433/proxy?target="));
});

test("embedText throws a ConnectorError when the provider returns nothing", async () => {
  stubFetch(() => ({ data: [] }));
  await assert.rejects(
    () => embedText({ provider: "openai", apiKey: "sk" }, "hi"),
    (e: Error) => e.name === "ConnectorError",
  );
});
