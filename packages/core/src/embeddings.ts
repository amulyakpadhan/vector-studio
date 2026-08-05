import { ConnectorError } from "./connector.ts";
import { HttpClient } from "./http.ts";

/** Providers @vyn/core knows how to call directly for text → vector embedding. */
export type EmbeddingProvider = "openai" | "cohere" | "voyage";

/** Client-side embedding setup, stored alongside a connection. Never leaves the machine. */
export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  apiKey: string;
  /** Defaults to a sensible current model per provider when omitted. */
  model?: string;
}

/** A model a provider offers, with the vector size it produces natively. */
export interface EmbeddingModelInfo {
  id: string;
  /** Native output dimension. */
  dim: number;
  /** OpenAI v3 models can be asked for a reduced output dimension. */
  variableDim?: boolean;
}

/**
 * Known models per provider. Not exhaustive — a custom model id can always be
 * typed in — but enough to drive a dropdown and warn about dimension
 * mismatches before anything is written.
 */
export const EMBEDDING_MODELS: Record<EmbeddingProvider, EmbeddingModelInfo[]> = {
  openai: [
    { id: "text-embedding-3-small", dim: 1536, variableDim: true },
    { id: "text-embedding-3-large", dim: 3072, variableDim: true },
    { id: "text-embedding-ada-002", dim: 1536 },
  ],
  cohere: [
    { id: "embed-english-v3.0", dim: 1024 },
    { id: "embed-multilingual-v3.0", dim: 1024 },
    { id: "embed-english-light-v3.0", dim: 384 },
    { id: "embed-multilingual-light-v3.0", dim: 384 },
  ],
  voyage: [
    { id: "voyage-3", dim: 1024 },
    { id: "voyage-3-lite", dim: 512 },
    { id: "voyage-3-large", dim: 1024 },
    { id: "voyage-code-3", dim: 1024 },
  ],
};

export function defaultModelFor(provider: EmbeddingProvider): string {
  return EMBEDDING_MODELS[provider][0]!.id;
}

/** Look up a model's info, if it's one we know. */
export function modelInfo(provider: EmbeddingProvider, model: string): EmbeddingModelInfo | undefined {
  return EMBEDDING_MODELS[provider].find((m) => m.id === model);
}

/** Largest number of texts we send per request, per provider's documented cap. */
const BATCH_LIMIT: Record<EmbeddingProvider, number> = {
  openai: 96,
  cohere: 96,
  voyage: 128,
};

/**
 * Whether the text is a query (search side) or a document (index/write side).
 * Cohere and Voyage embed the two asymmetrically, so getting this right
 * materially changes retrieval quality.
 */
export type EmbedInputType = "query" | "document";

export interface EmbedOptions {
  /** Local bridge base URL, for providers blocked by browser CORS. */
  bridgeUrl?: string;
  /** Defaults to "query" — searches. Inserts/imports should pass "document". */
  inputType?: EmbedInputType;
  /** Request a reduced output dimension (OpenAI v3 only; ignored elsewhere). */
  dimensions?: number;
}

/**
 * Embed many texts at once, batching to each provider's per-request limit.
 * Returns one vector per input, in the same order. Runs entirely
 * client-side — the key only ever reaches the provider (or the local bridge).
 */
export async function embedTexts(config: EmbeddingConfig, texts: string[], opts: EmbedOptions = {}): Promise<number[][]> {
  if (texts.length === 0) return [];
  const model = config.model || defaultModelFor(config.provider);
  const inputType = opts.inputType ?? "query";
  const limit = BATCH_LIMIT[config.provider];

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += limit) {
    const chunk = texts.slice(i, i + limit);
    const vectors = await embedBatch(config.provider, config.apiKey, model, chunk, inputType, opts);
    if (vectors.length !== chunk.length) {
      throw new ConnectorError(
        `${config.provider} returned ${vectors.length} embeddings for ${chunk.length} inputs`,
        "embeddings",
      );
    }
    out.push(...vectors);
  }
  return out;
}

/** Embed a single text. Defaults to the "query" input type used by search. */
export async function embedText(config: EmbeddingConfig, text: string, opts: EmbedOptions = {}): Promise<number[]> {
  const [vector] = await embedTexts(config, [text], opts);
  if (!vector) throw new ConnectorError(`${config.provider} returned no embedding`, "embeddings");
  return vector;
}

// ─── per-provider batch calls ────────────────────────────────────────────────

function embedBatch(
  provider: EmbeddingProvider,
  apiKey: string,
  model: string,
  texts: string[],
  inputType: EmbedInputType,
  opts: EmbedOptions,
): Promise<number[][]> {
  switch (provider) {
    case "openai":
      return openaiBatch(apiKey, model, texts, opts);
    case "cohere":
      return cohereBatch(apiKey, model, texts, inputType, opts.bridgeUrl);
    case "voyage":
      return voyageBatch(apiKey, model, texts, inputType, opts.bridgeUrl);
    default:
      throw new ConnectorError(`Unknown embedding provider "${provider}"`, "embeddings");
  }
}

interface IndexedEmbedding {
  index: number;
  embedding: number[];
}

/** Order a provider's indexed results and return just the vectors. */
function ordered(data: IndexedEmbedding[]): number[][] {
  return [...data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

async function openaiBatch(apiKey: string, model: string, texts: string[], opts: EmbedOptions): Promise<number[][]> {
  const http = new HttpClient("openai-embeddings", {
    baseUrl: "https://api.openai.com",
    headers: { Authorization: `Bearer ${apiKey}` },
    bridgeUrl: opts.bridgeUrl,
  });
  const body: Record<string, unknown> = { model, input: texts };
  if (opts.dimensions) body.dimensions = opts.dimensions;
  const res = await http.post<{ data: IndexedEmbedding[] }>("/v1/embeddings", body);
  if (!res.data?.length) throw new ConnectorError("OpenAI returned no embeddings", "embeddings");
  return ordered(res.data);
}

async function cohereBatch(
  apiKey: string,
  model: string,
  texts: string[],
  inputType: EmbedInputType,
  bridgeUrl?: string,
): Promise<number[][]> {
  const http = new HttpClient("cohere-embeddings", {
    baseUrl: "https://api.cohere.ai",
    headers: { Authorization: `Bearer ${apiKey}` },
    bridgeUrl,
  });
  const res = await http.post<{ embeddings: number[][] }>("/v1/embed", {
    model,
    texts,
    input_type: inputType === "document" ? "search_document" : "search_query",
  });
  if (!res.embeddings?.length) throw new ConnectorError("Cohere returned no embeddings", "embeddings");
  return res.embeddings;
}

async function voyageBatch(
  apiKey: string,
  model: string,
  texts: string[],
  inputType: EmbedInputType,
  bridgeUrl?: string,
): Promise<number[][]> {
  const http = new HttpClient("voyage-embeddings", {
    baseUrl: "https://api.voyageai.com",
    headers: { Authorization: `Bearer ${apiKey}` },
    bridgeUrl,
  });
  const res = await http.post<{ data: IndexedEmbedding[] }>("/v1/embeddings", {
    model,
    input: texts,
    input_type: inputType === "document" ? "document" : "query",
  });
  if (!res.data?.length) throw new ConnectorError("Voyage returned no embeddings", "embeddings");
  return ordered(res.data);
}
