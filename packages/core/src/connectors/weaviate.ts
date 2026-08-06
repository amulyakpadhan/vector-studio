import { ConnectorError, type VectorConnector } from "../connector.ts";
import { HttpClient } from "../http.ts";
import type {
  CollectionInfo,
  CollectionSchema,
  CollectionStats,
  ConnectionConfig,
  ConnectorCapabilities,
  CreateCollectionSpec,
  DistanceMetric,
  Json,
  Page,
  PageOpts,
  SampleOpts,
  SearchResult,
  ServerMeta,
  TestResult,
  TextQuery,
  UpsertResult,
  VectorQuery,
  VectorRecord,
  VectorSample,
} from "../types.ts";

/**
 * Weaviate speaks two APIs and we use both, per its strengths:
 *   • REST  (/v1/*)        — meta, schema, object CRUD, cursor browse
 *   • GraphQL (/v1/graphql) — vector / keyword / hybrid search
 *
 * A Weaviate "class" is our collection; object "properties" are the payload;
 * the object "vector" is the vector — except when the class was created with
 * *named* vectors (Weaviate's newer multi-vector-per-object config), in which
 * case the vector lives under `vectors.<name>` instead of `vector`, both in
 * REST responses and GraphQL's `_additional` block, and `nearVector` search
 * needs an explicit `targetVectors: ["<name>"]`. We support exactly one named
 * vector per class (the first one declared) — multi-named-vector classes are
 * out of scope for now.
 */

const METRIC_TO_WEAVIATE: Record<DistanceMetric, string> = {
  cosine: "cosine",
  euclidean: "l2-squared",
  dot: "dot",
};

const WEAVIATE_TO_METRIC: Record<string, DistanceMetric> = {
  cosine: "cosine",
  "l2-squared": "euclidean",
  dot: "dot",
};

const WEAVIATE_TYPE_MAP: Record<string, string> = {
  text: "text",
  string: "text",
  int: "integer",
  number: "number",
  boolean: "boolean",
  date: "text",
  uuid: "text",
  geoCoordinates: "geo",
};

interface WeaviateProperty {
  name: string;
  dataType: string[];
}

interface WeaviateClass {
  class: string;
  description?: string;
  vectorizer?: string;
  properties?: WeaviateProperty[];
  vectorIndexConfig?: { distance?: string };
  /** Present instead of the top-level vectorizer/vectorIndexConfig when the class uses named vectors. */
  vectorConfig?: Record<string, { vectorIndexConfig?: { distance?: string } }>;
}

interface WeaviateObject {
  id: string;
  class?: string;
  properties?: Record<string, Json>;
  vector?: number[];
  vectors?: Record<string, number[]>;
}

interface GraphQLResponse {
  data?: { Get?: Record<string, GraphQLHit[]>; Aggregate?: Record<string, [{ meta?: { count?: number } }]> };
  errors?: { message: string }[];
}

interface GraphQLHit {
  _additional?: { id?: string; distance?: number; score?: string; vector?: number[]; vectors?: Record<string, number[]> };
  [prop: string]: Json | { id?: string; distance?: number; score?: string; vector?: number[]; vectors?: Record<string, number[]> } | undefined;
}

/** Cached per-class facts we need to build GraphQL queries. */
interface ClassMeta {
  properties: string[];
  distance?: DistanceMetric;
  vectorizer?: string;
  /** Name of this class's named vector, or undefined for the legacy single/unnamed vector. */
  vectorName?: string;
}

/** The class's single named vector, if it uses named (not legacy unnamed) vectors. */
function primaryVectorName(c: WeaviateClass): string | undefined {
  return c.vectorConfig ? Object.keys(c.vectorConfig)[0] : undefined;
}

/** The class's configured distance metric, from whichever of the two shapes it uses. */
function classDistance(c: WeaviateClass): string | undefined {
  const vectorName = primaryVectorName(c);
  return vectorName ? c.vectorConfig?.[vectorName]?.vectorIndexConfig?.distance : c.vectorIndexConfig?.distance;
}

/**
 * Extract a vector from a REST object or GraphQL `_additional` block. Only
 * one of `vector` (legacy unnamed) or `vectors` (named) is ever populated by
 * the server for a given object; when named, we support exactly one vector
 * per class, so the first entry is always the right one.
 */
function extractVector(src: { vector?: number[]; vectors?: Record<string, number[]> }): number[] | undefined {
  return src.vector ?? (src.vectors ? Object.values(src.vectors)[0] : undefined);
}

/** The GraphQL `_additional` sub-selection for the vector: `vector`, or `vectors { <name> }` when named. */
function vectorSelection(vectorName?: string): string {
  return vectorName ? `vectors { ${vectorName} }` : "vector";
}

/** The `, targetVectors: [...]` argument fragment `nearVector`/`hybrid` need for a named-vector class. */
function targetVectorsArg(vectorName?: string): string {
  return vectorName ? `, targetVectors: ["${vectorName}"]` : "";
}

export class WeaviateConnector implements VectorConnector {
  readonly config: ConnectionConfig;
  private readonly http: HttpClient;
  private readonly metaCache = new Map<string, ClassMeta>();

  constructor(config: ConnectionConfig) {
    this.config = config;
    this.http = new HttpClient("weaviate", {
      baseUrl: config.url,
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined,
      bridgeUrl: typeof config.options?.["bridgeUrl"] === "string" ? config.options["bridgeUrl"] : undefined,
      // Vector exports for projection can be large (1500 records × high-dim
      // vectors); the default 30s timeout is too tight for that one request.
      timeoutMs: 60_000,
    });
  }

  capabilities(): ConnectorCapabilities {
    return {
      engine: "weaviate",
      textSearch: true, // bm25 + hybrid via GraphQL
      hybridSearch: true,
      payloadFilters: true, // GraphQL `where`
      filterBrowse: true, // GraphQL Get with where + offset
      browse: true,
      exportVectors: true,
      createCollection: true,
      updatePayload: true,
    };
  }

  async testConnection(): Promise<TestResult> {
    const started = performance.now();
    try {
      const meta = await this.http.get<{ version?: string }>("/v1/meta");
      return { ok: true, version: meta.version, latencyMs: Math.round(performance.now() - started) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async getMeta(): Promise<ServerMeta> {
    const meta = await this.http.get<{ version?: string }>("/v1/meta");
    return { engine: "weaviate", version: meta.version, raw: meta as unknown as Json };
  }

  async listCollections(): Promise<CollectionInfo[]> {
    const schema = await this.http.get<{ classes?: WeaviateClass[] }>("/v1/schema");
    const classes = schema.classes ?? [];
    return Promise.all(
      classes.map(async (c): Promise<CollectionInfo> => {
        this.cacheMeta(c);
        let count: number | undefined;
        try {
          count = await this.aggregateCount(c.class);
        } catch {
          count = undefined;
        }
        const distance = classDistance(c);
        return {
          name: c.class,
          count,
          metric: distance ? WEAVIATE_TO_METRIC[distance] : undefined,
        };
      }),
    );
  }

  async getSchema(collection: string): Promise<CollectionSchema> {
    const c = await this.http.get<WeaviateClass>(`/v1/schema/${encodeURIComponent(collection)}`);
    this.cacheMeta(c);
    // Dimension isn't in the schema; infer it from one stored vector.
    let dimension: number | undefined;
    try {
      const sample = await this.listRecords(collection, { limit: 1, withVectors: true });
      dimension = sample.items[0]?.vector?.length;
    } catch {
      dimension = undefined;
    }
    const distance = classDistance(c);
    return {
      name: collection,
      dimension,
      metric: distance ? WEAVIATE_TO_METRIC[distance] : undefined,
      fields: (c.properties ?? []).map((p) => ({
        name: p.name,
        type: WEAVIATE_TYPE_MAP[p.dataType[0] ?? ""] ?? "unknown",
      })),
      serverVectorizer: c.vectorizer && c.vectorizer !== "none" ? c.vectorizer : undefined,
      raw: c as unknown as Json,
    };
  }

  async getStats(collection: string): Promise<CollectionStats> {
    const count = await this.aggregateCount(collection);
    return { name: collection, count };
  }

  async createCollection(spec: CreateCollectionSpec): Promise<void> {
    // Default to "none" (bring-your-own vectors) unless a specific module name was
    // requested — e.g. Clone passes the source collection's serverVectorizer through
    // so the copy can keep auto-embedding, instead of silently losing it.
    const vectorizer = typeof spec.options?.["vectorizer"] === "string" ? spec.options["vectorizer"] : "none";
    try {
      await this.http.post("/v1/schema", {
        class: spec.name,
        vectorizer,
        vectorIndexConfig: { distance: METRIC_TO_WEAVIATE[spec.metric] },
      });
    } catch (err) {
      throw explainUsageLimit(err);
    }
  }

  async deleteCollection(collection: string): Promise<void> {
    await this.http.delete(`/v1/schema/${encodeURIComponent(collection)}`);
    this.metaCache.delete(collection);
  }

  async listRecords(collection: string, opts: PageOpts): Promise<Page<VectorRecord>> {
    // Filtered browse must go through GraphQL — REST /v1/objects can't filter.
    if (opts.filter) return this.listFiltered(collection, opts);

    const params = new URLSearchParams({ class: collection, limit: String(opts.limit) });
    if (opts.withVectors) params.set("include", "vector");
    if (opts.cursor) params.set("after", opts.cursor);
    const res = await this.http.get<{ objects?: WeaviateObject[] }>(`/v1/objects?${params.toString()}`);
    const objects = res.objects ?? [];
    const items = objects.map((o) => this.toRecord(o));
    // Cursor pagination: `after` = last id; assume more pages while the page is full.
    const last = objects[objects.length - 1];
    const nextCursor = objects.length === opts.limit && last ? last.id : undefined;
    return { items, nextCursor };
  }

  /** GraphQL Get with a where filter, paged by numeric offset (encoded as the cursor). */
  private async listFiltered(collection: string, opts: PageOpts): Promise<Page<VectorRecord>> {
    const meta = await this.classMeta(collection);
    // A plain Get can't compute a distance/score, so select id (+vector) only.
    const extra = ["id", ...(opts.withVectors ? [vectorSelection(meta.vectorName)] : [])].join(" ");
    const fields = `${meta.properties.join(" ")} _additional { ${extra} }`;
    const offset = opts.cursor ? Number(opts.cursor) : 0;
    const where = whereArg(opts.filter);
    const gql = `{ Get { ${collection}(limit: ${opts.limit}, offset: ${offset}${where}) { ${fields} } } }`;
    const hits = await this.runGet(collection, gql, {});
    const items = hits.map((h) => this.hitToRecord(h, meta.properties));
    const nextCursor = hits.length === opts.limit ? String(offset + opts.limit) : undefined;
    return { items, nextCursor };
  }

  async getRecord(collection: string, id: string | number): Promise<VectorRecord> {
    const o = await this.http.get<WeaviateObject>(
      `/v1/objects/${encodeURIComponent(collection)}/${encodeURIComponent(String(id))}?include=vector`,
    );
    return this.toRecord(o);
  }

  async upsertRecords(collection: string, records: VectorRecord[]): Promise<UpsertResult> {
    const meta = await this.classMeta(collection);
    const res = await this.http.post<unknown[]>("/v1/batch/objects", {
      objects: records.map((r) => ({
        class: collection,
        id: r.id !== undefined ? String(r.id) : undefined,
        properties: r.payload,
        ...(meta.vectorName ? { vectors: r.vector ? { [meta.vectorName]: r.vector } : undefined } : { vector: r.vector }),
      })),
    });
    return { upserted: Array.isArray(res) ? res.length : records.length };
  }

  async updatePayload(collection: string, id: string | number, payload: Record<string, unknown>): Promise<void> {
    await this.http.request(
      "PATCH",
      `/v1/objects/${encodeURIComponent(collection)}/${encodeURIComponent(String(id))}`,
      { class: collection, properties: payload },
    );
  }

  async deleteRecords(collection: string, ids: (string | number)[]): Promise<void> {
    for (const id of ids) {
      await this.http.delete(
        `/v1/objects/${encodeURIComponent(collection)}/${encodeURIComponent(String(id))}`,
      );
    }
  }

  async vectorSearch(collection: string, query: VectorQuery): Promise<SearchResult[]> {
    const meta = await this.classMeta(collection);
    // Only nearVector queries can compute `distance` — asking for it on a
    // keyword-only query has no vector to measure and Weaviate errors.
    const fields = this.selectionFields(meta.properties, "distance", query.withVectors ?? false, meta.vectorName);
    const where = whereArg(query.filter);
    const targetVectors = targetVectorsArg(meta.vectorName);
    const gql = `query Search($vec: [Float!], $limit: Int) {
      Get { ${collection}(nearVector: { vector: $vec${targetVectors} }, limit: $limit${where}) { ${fields} } }
    }`;
    const hits = await this.runGet(collection, gql, { vec: query.vector, limit: query.limit });
    return hits.map((h) => this.toSearchResult(h, meta.properties, "distance"));
  }

  async textSearch(collection: string, query: TextQuery): Promise<SearchResult[]> {
    const meta = await this.classMeta(collection);
    // bm25/hybrid report `score`, not `distance` — same reasoning as above.
    const fields = this.selectionFields(meta.properties, "score", false);
    const hasVector = query.mode === "hybrid" && query.vector !== undefined;
    const alpha = query.alpha ?? 0.5;
    // Passing our own query vector lets hybrid genuinely blend keyword +
    // vector relevance even when the collection has no server-side vectorizer.
    // GraphQL rejects a declared-but-unused variable, so $vec only appears
    // in the operation signature when we actually reference it below.
    const args = hasVector
      ? `hybrid: { query: $q, vector: $vec, alpha: ${alpha}${targetVectorsArg(meta.vectorName)} }`
      : query.mode === "hybrid"
        ? `hybrid: { query: $q, alpha: ${alpha} }`
        : `bm25: { query: $q }`;
    const where = whereArg(query.filter);
    const varsDecl = hasVector ? "$q: String!, $vec: [Float!], $limit: Int" : "$q: String!, $limit: Int";
    const gql = `query Search(${varsDecl}) {
      Get { ${collection}(${args}, limit: $limit${where}) { ${fields} } }
    }`;
    const variables: Record<string, unknown> = { q: query.text, limit: query.limit };
    if (hasVector) variables.vec = query.vector;
    const hits = await this.runGet(collection, gql, variables);
    return hits.map((h) => this.toSearchResult(h, meta.properties, "score"));
  }

  /** Pure-vector hybrid (alpha=1) lets the class's own vectorizer embed the query — no client key needed. */
  async searchByText(
    collection: string,
    query: { text: string; limit: number; filter?: Json },
  ): Promise<SearchResult[]> {
    return this.textSearch(collection, { text: query.text, mode: "hybrid", limit: query.limit, filter: query.filter, alpha: 1 });
  }

  async fetchVectors(collection: string, opts: SampleOpts): Promise<VectorSample> {
    const page = await this.listRecords(collection, { limit: opts.limit, cursor: opts.cursor, withVectors: true });
    const withVec = page.items.filter((r) => r.vector !== undefined);
    return {
      ids: withVec.map((r) => r.id),
      vectors: withVec.map((r) => r.vector as number[]),
      payloads: withVec.map((r) => r.payload),
      nextCursor: page.nextCursor,
    };
  }

  // ─── private ────────────────────────────────────────────────

  private cacheMeta(c: WeaviateClass): void {
    const distance = classDistance(c);
    this.metaCache.set(c.class, {
      properties: (c.properties ?? []).map((p) => p.name),
      distance: distance ? WEAVIATE_TO_METRIC[distance] : undefined,
      vectorizer: c.vectorizer,
      vectorName: primaryVectorName(c),
    });
  }

  private async classMeta(collection: string): Promise<ClassMeta> {
    const cached = this.metaCache.get(collection);
    if (cached) return cached;
    const c = await this.http.get<WeaviateClass>(`/v1/schema/${encodeURIComponent(collection)}`);
    this.cacheMeta(c);
    return this.metaCache.get(collection)!;
  }

  /** GraphQL field selection: the payload props + the _additional block.
   * `scoreField` must match what the query type can actually produce —
   * requesting the wrong one causes a server-side error (see callers). */
  private selectionFields(
    properties: string[],
    scoreField: "distance" | "score",
    withVector: boolean,
    vectorName?: string,
  ): string {
    const extra = ["id", scoreField, ...(withVector ? [vectorSelection(vectorName)] : [])].join(" ");
    return `${properties.join(" ")} _additional { ${extra} }`;
  }

  private async runGet(
    collection: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<GraphQLHit[]> {
    const res = await this.http.post<GraphQLResponse>("/v1/graphql", { query, variables });
    if (res.errors && res.errors.length) {
      throw new ConnectorError(explainGraphQLError(res.errors.map((e) => e.message).join("; ")), "weaviate");
    }
    return res.data?.Get?.[collection] ?? [];
  }

  private async aggregateCount(collection: string): Promise<number> {
    const gql = `{ Aggregate { ${collection} { meta { count } } } }`;
    const res = await this.http.post<GraphQLResponse>("/v1/graphql", { query: gql });
    if (res.errors && res.errors.length) {
      throw new ConnectorError(explainGraphQLError(res.errors.map((e) => e.message).join("; ")), "weaviate");
    }
    return res.data?.Aggregate?.[collection]?.[0]?.meta?.count ?? 0;
  }

  private toRecord(o: WeaviateObject): VectorRecord {
    return { id: o.id, payload: o.properties ?? {}, vector: extractVector(o) };
  }

  /** Build a plain record (no score) from a GraphQL Get hit — used by filtered browse. */
  private hitToRecord(hit: GraphQLHit, properties: string[]): VectorRecord {
    const add = hit._additional ?? {};
    const payload: Record<string, Json> = {};
    for (const p of properties) {
      const v = hit[p];
      if (v !== undefined) payload[p] = v as Json;
    }
    return { id: add.id ?? "", payload, vector: extractVector(add) };
  }

  private toSearchResult(hit: GraphQLHit, properties: string[], scoreKey: "distance" | "score"): SearchResult {
    const add = hit._additional ?? {};
    const payload: Record<string, Json> = {};
    for (const p of properties) {
      const v = hit[p];
      if (v !== undefined) payload[p] = v as Json;
    }
    // Normalize toward "higher = more similar": cosine distance → similarity.
    let score = 0;
    if (scoreKey === "distance" && typeof add.distance === "number") score = 1 - add.distance;
    else if (scoreKey === "score" && add.score !== undefined) score = parseFloat(add.score);
    return { id: add.id ?? "", score, payload, vector: extractVector(add) };
  }
}

/**
 * Weaviate occasionally recovers from an internal Go panic and returns its
 * raw message as a GraphQL error (e.g. "interface conversion: interface {}
 * is int64, not int") — this is a server-side crash, not something a client
 * request can cause or fix. It's a documented GraphQL/Weaviate limitation:
 * GraphQL only supports int32, so an indexed `int` property holding a value
 * that doesn't fit int32 can crash the resolver when it's returned. Append a
 * hint so this doesn't read like an opaque client bug.
 */
function explainGraphQLError(message: string): string {
  if (!/interface conversion/i.test(message)) return message;
  return (
    `${message} — this is a Weaviate server-side crash, not a Vyn bug. It usually means one of this class's ` +
    `indexed "int" properties holds a value too large for GraphQL's int32 limit. Check that property's values, ` +
    `consider changing its dataType to "number", or try a newer Weaviate version.`
  );
}

/**
 * Weaviate Cloud's free sandbox tier caps the collection count (usually 1) —
 * creating another one 429s with `{"errorCode":"USAGE_LIMIT_EXCEEDED", ...}`.
 * This is an account/plan limit, not a Vyn bug, so append a hint pointing at
 * the actual fix (delete an existing collection or upgrade the instance)
 * instead of leaving it read like an opaque server error.
 */
function explainUsageLimit(err: unknown): unknown {
  if (!(err instanceof ConnectorError) || err.status !== 429) return err;
  const detail = err.detail as { errorCode?: string; message?: string } | undefined;
  if (detail?.errorCode !== "USAGE_LIMIT_EXCEEDED") return err;
  return new ConnectorError(
    `${err.message} — this Weaviate instance has hit its plan's collection limit, not a Vyn error. ` +
      `Delete an existing collection to free up room, or upgrade the instance's plan, then try again.`,
    err.engine,
    err.status,
    err.detail,
  );
}

/** Render `, where: {literal}` for a GraphQL Get argument list, or "" when absent. */
function whereArg(filter: Json | undefined): string {
  if (filter === undefined || filter === null) return "";
  return `, where: ${whereToLiteral(filter)}`;
}

/**
 * Serialize a Weaviate `where` object (as produced by buildFilter) into GraphQL
 * literal syntax. Weaviate needs enum values unquoted (`operator: Equal`) and
 * object keys unquoted, which JSON.stringify can't produce — hence this walker.
 */
export function whereToLiteral(node: Json): string {
  if (Array.isArray(node)) return `[${node.map((n) => whereToLiteral(n)).join(", ")}]`;
  if (node === null || typeof node !== "object") return JSON.stringify(node);

  const parts: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (value === undefined) continue;
    if (key === "operator" && typeof value === "string") {
      parts.push(`${key}: ${value}`); // enum — unquoted
    } else {
      parts.push(`${key}: ${whereToLiteral(value as Json)}`);
    }
  }
  return `{ ${parts.join(", ")} }`;
}
