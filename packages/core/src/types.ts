/**
 * Unified domain model shared by every connector.
 *
 * For Python readers: these `interface`s are the TypeScript equivalent of
 * Pydantic models — they describe shape only and are checked at compile time.
 */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type DbEngine = "qdrant" | "pinecone" | "weaviate" | "milvus" | "chroma";

export type DistanceMetric = "cosine" | "euclidean" | "dot";

/** Everything needed to reach a database. Lives only on the user's machine. */
export interface ConnectionConfig {
  engine: DbEngine;
  /** Full base URL, e.g. "https://xyz.cloud.qdrant.io:6333" or "http://localhost:6333" */
  url: string;
  apiKey?: string;
  /** Extra engine-specific settings (e.g. Pinecone index host, Weaviate gRPC port). */
  options?: Record<string, Json>;
}

export interface TestResult {
  ok: boolean;
  /** Server-reported version, when the engine exposes one. */
  version?: string;
  latencyMs?: number;
  error?: string;
}

export interface ServerMeta {
  engine: DbEngine;
  version?: string;
  /** Raw engine-specific details, shown in an "advanced" panel. */
  raw?: Json;
}

export interface CollectionInfo {
  name: string;
  /** Approximate number of vectors/records. */
  count?: number;
  dimension?: number;
  metric?: DistanceMetric;
  /** Engine-specific status string, e.g. "green" | "ready". */
  status?: string;
}

export interface CollectionSchema {
  name: string;
  dimension?: number;
  metric?: DistanceMetric;
  /** Payload/metadata fields when the engine exposes a schema. */
  fields: SchemaField[];
  /**
   * Name of the server-side vectorizer configured on this collection (e.g.
   * "text2vec-openai"), when the engine embeds text itself and no
   * client-supplied vector is needed. Undefined means bring-your-own-vector —
   * either because the engine has no such concept, or none is configured.
   */
  serverVectorizer?: string;
  raw?: Json;
}

export interface SchemaField {
  name: string;
  /** Normalized type: "text" | "number" | "integer" | "boolean" | "geo" | "unknown" */
  type: string;
  indexed?: boolean;
}

export interface CollectionStats {
  name: string;
  count: number;
  raw?: Json;
}

export interface CreateCollectionSpec {
  name: string;
  dimension: number;
  metric: DistanceMetric;
  /** Engine-specific creation params (e.g. Pinecone serverless cloud/region). */
  options?: Record<string, Json>;
}

/** One record: id + payload + (optionally) its vector. */
export interface VectorRecord {
  id: string | number;
  payload: Record<string, Json>;
  vector?: number[];
}

export interface PageOpts {
  limit: number;
  /** Opaque cursor from the previous page; engines differ (offset vs. cursor). */
  cursor?: string;
  withVectors?: boolean;
  /** Engine-native filter object (from buildFilter). Only applied when the engine can browse-filter. */
  filter?: Json;
}

export interface Page<T> {
  items: T[];
  /** Pass back as `PageOpts.cursor` to fetch the next page; absent on the last page. */
  nextCursor?: string;
  /** Total count when the engine can report it cheaply. */
  total?: number;
}

export interface UpsertResult {
  upserted: number;
  errors?: string[];
}

export interface VectorQuery {
  vector: number[];
  limit: number;
  /** Engine-native filter object, passed through untouched. */
  filter?: Json;
  withVectors?: boolean;
}

export interface TextQuery {
  text: string;
  mode: "keyword" | "hybrid";
  limit: number;
  filter?: Json;
  /** Pre-computed query embedding — lets hybrid genuinely blend keyword +
   * vector relevance even on collections with no server-side vectorizer. */
  vector?: number[];
  /** Hybrid-only: 0 = pure keyword, 1 = pure vector. Engines that don't support tuning ignore it. */
  alpha?: number;
}

export interface SearchResult {
  id: string | number;
  score: number;
  payload: Record<string, Json>;
  vector?: number[];
}

export interface SampleOpts {
  /** Max vectors to fetch for projection. */
  limit: number;
  cursor?: string;
}

export interface VectorSample {
  ids: (string | number)[];
  vectors: number[][];
  payloads: Record<string, Json>[];
  nextCursor?: string;
}

/** What this engine supports — the UI adapts instead of pretending all DBs are equal. */
export interface ConnectorCapabilities {
  engine: DbEngine;
  textSearch: boolean;
  hybridSearch: boolean;
  /** Can filter searches by payload/metadata. */
  payloadFilters: boolean;
  /** Can filter the browse/scroll listing (not just search). */
  filterBrowse: boolean;
  /** Can list records without a query vector (browse/scroll). */
  browse: boolean;
  /** Can fetch stored vectors back out (needed for projection). */
  exportVectors: boolean;
  createCollection: boolean;
  updatePayload: boolean;
}
