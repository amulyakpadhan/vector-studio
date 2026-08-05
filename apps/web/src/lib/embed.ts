import { modelInfo, defaultModelFor, type EmbeddingConfig } from "@vyn/core";

/**
 * For OpenAI v3 models (which accept a `dimensions` param), returns the
 * collection's dimension so the produced vector matches the collection
 * exactly. Returns undefined for every other case — the model's native size
 * is used and any mismatch is surfaced as a warning instead.
 */
export function autoDimensions(embedding: EmbeddingConfig, collectionDim?: number): number | undefined {
  if (!collectionDim || embedding.provider !== "openai") return undefined;
  const model = embedding.model || defaultModelFor("openai");
  const info = modelInfo("openai", model);
  if (info?.variableDim && collectionDim !== info.dim) return collectionDim;
  return undefined;
}

/** The dimension a connection's embedding model produces natively, if known. */
export function nativeDim(embedding: EmbeddingConfig): number | undefined {
  const model = embedding.model || defaultModelFor(embedding.provider);
  return modelInfo(embedding.provider, model)?.dim;
}
