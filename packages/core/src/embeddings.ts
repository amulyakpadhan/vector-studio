import { ConnectorError } from "./connector.ts";
import { HttpClient } from "./http.ts";

/** Providers @vyn/core knows how to call directly for text → vector embedding. */
export type EmbeddingProvider = "openai" | "cohere" | "voyage" | "huggingface" | "ollama";

/** Providers that need no API key at all (self-hosted, no auth). */
export const KEYLESS_PROVIDERS: readonly EmbeddingProvider[] = ["ollama"];

/** Client-side embedding setup, stored alongside a connection. Never leaves the machine. */
export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  /** Required for every provider except the keyless ones (currently just Ollama). */
  apiKey?: string;
  /** Defaults to a sensible current model per provider when omitted. */
  model?: string;
  /** Self-hosted server URL — Ollama only. Defaults to http://localhost:11434. */
  baseUrl?: string;
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
  // Free-tier serverless inference (rate-limited) via a Hugging Face access token —
  // https://huggingface.co/settings/tokens. Open-source models, hosted by HF.
  huggingface: [
    { id: "sentence-transformers/all-MiniLM-L6-v2", dim: 384 },
    { id: "BAAI/bge-small-en-v1.5", dim: 384 },
    { id: "BAAI/bge-base-en-v1.5", dim: 768 },
    { id: "sentence-transformers/all-mpnet-base-v2", dim: 768 },
    { id: "intfloat/multilingual-e5-base", dim: 768 },
  ],
  // Self-hosted, open-source, no API key — runs against a local Ollama server
  // (https://ollama.com). Whatever models the user has pulled with `ollama pull`.
  ollama: [
    { id: "nomic-embed-text", dim: 768 },
    { id: "mxbai-embed-large", dim: 1024 },
    { id: "all-minilm", dim: 384 },
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
  huggingface: 32,
  ollama: 64,
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
    const vectors = await embedBatch(config, model, chunk, inputType, opts);
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
  config: EmbeddingConfig,
  model: string,
  texts: string[],
  inputType: EmbedInputType,
  opts: EmbedOptions,
): Promise<number[][]> {
  const { provider, apiKey, baseUrl } = config;
  if (!apiKey && !KEYLESS_PROVIDERS.includes(provider)) {
    throw new ConnectorError(`${provider} requires an API key`, "embeddings");
  }
  switch (provider) {
    case "openai":
      return openaiBatch(apiKey!, model, texts, opts);
    case "cohere":
      return cohereBatch(apiKey!, model, texts, inputType, opts.bridgeUrl);
    case "voyage":
      return voyageBatch(apiKey!, model, texts, inputType, opts.bridgeUrl);
    case "huggingface":
      return huggingfaceBatch(apiKey!, model, texts, opts.bridgeUrl);
    case "ollama":
      return ollamaBatch(baseUrl, model, texts, opts.bridgeUrl);
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

/**
 * Hugging Face's serverless Inference API — free tier, rate-limited, for
 * any hosted sentence-transformers-style model. Needs the user's own (free)
 * HF access token: https://huggingface.co/settings/tokens.
 */
async function huggingfaceBatch(
  apiKey: string,
  model: string,
  texts: string[],
  bridgeUrl?: string,
): Promise<number[][]> {
  const http = new HttpClient("huggingface-embeddings", {
    baseUrl: "https://router.huggingface.co",
    headers: { Authorization: `Bearer ${apiKey}` },
    bridgeUrl,
  });
  const res = await http.post<unknown>(`/hf-inference/models/${model}/pipeline/feature-extraction`, {
    inputs: texts,
  });
  if (!Array.isArray(res) || res.length !== texts.length || !Array.isArray(res[0])) {
    throw new ConnectorError(
      "Hugging Face returned an unexpected shape — pick a model that outputs one pooled vector per input.",
      "embeddings",
    );
  }
  return res as number[][];
}

/**
 * A local Ollama server (https://ollama.com) — fully self-hosted, open
 * source, no API key at all. The user must have already run
 * `ollama pull <model>` for whichever model they select.
 */
async function ollamaBatch(baseUrl: string | undefined, model: string, texts: string[], bridgeUrl?: string): Promise<number[][]> {
  const http = new HttpClient("ollama-embeddings", {
    baseUrl: (baseUrl?.trim() || "http://localhost:11434").replace(/\/+$/, ""),
    bridgeUrl,
  });
  const res = await http.post<{ embeddings: number[][] }>("/api/embed", { model, input: texts });
  if (!res.embeddings?.length) {
    throw new ConnectorError(`Ollama returned no embeddings — is "${model}" pulled? (ollama pull ${model})`, "embeddings");
  }
  return res.embeddings;
}
