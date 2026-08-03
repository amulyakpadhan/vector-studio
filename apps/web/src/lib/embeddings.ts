"use client";

/**
 * Client-side text embedding, called directly from the browser to the
 * provider's API — the key never touches our server, same trust model as
 * database credentials. Currently OpenAI only; the shape leaves room for
 * more providers later.
 */

export type EmbeddingProvider = "openai";

export const EMBEDDING_MODELS: Record<EmbeddingProvider, string> = {
  openai: "text-embedding-3-small",
};

export class EmbeddingError extends Error {}

export async function embedText(
  provider: EmbeddingProvider,
  apiKey: string,
  text: string,
): Promise<number[]> {
  if (provider !== "openai") throw new EmbeddingError(`Unsupported embedding provider: ${provider}`);
  if (!apiKey.trim()) throw new EmbeddingError("An API key is required to embed text.");
  if (!text.trim()) throw new EmbeddingError("Enter some text to embed.");

  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ input: text, model: EMBEDDING_MODELS.openai }),
    });
  } catch (err) {
    throw new EmbeddingError(
      `Couldn't reach the embedding API: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401) throw new EmbeddingError("That API key was rejected — check it and try again.");
    throw new EmbeddingError(`Embedding request failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as { data?: { embedding: number[] }[] };
  const vector = data.data?.[0]?.embedding;
  if (!vector) throw new EmbeddingError("The embedding API returned no vector.");
  return vector;
}
