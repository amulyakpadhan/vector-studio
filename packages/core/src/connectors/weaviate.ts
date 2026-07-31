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
 * the object "vector" is the vector. We target the default (unnamed) vector.
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
}

interface WeaviateObject {
  id: string;
  class?: string;
  properties?: Record<string, Json>;
  vector?: number[];
}

interface GraphQLResponse {
  data?: { Get?: Record<string, GraphQLHit[]>; Aggregate?: Record<string, [{ meta?: { count?: number } }]> };
  errors?: { message: string }[];
}

interface GraphQLHit {
  _additional?: { id?: string; distance?: number; score?: string; vector?: number[] };
  [prop: string]: Json | { id?: string; distance?: number; score?: string; vector?: number[] } | undefined;
}

/** Cached per-class facts we need to build GraphQL queries. */
interface ClassMeta {
  properties: string[];
  distance?: DistanceMetric;
  vectorizer?: string;
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
    });
  }

  capabilities(): ConnectorCapabilities {
    return {
      engine: "weaviate",
      textSearch: true, // bm25 + hybrid via GraphQL
      hybridSearch: true,
      payloadFilters: false, // GraphQL `where` not wired yet
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
        return {
          name: c.class,
          count,
          metric: c.vectorIndexConfig?.distance ? WEAVIATE_TO_METRIC[c.vectorIndexConfig.distance] : undefined,
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
    return {
      name: collection,
      dimension,
      metric: c.vectorIndexConfig?.distance ? WEAVIATE_TO_METRIC[c.vectorIndexConfig.distance] : undefined,
      fields: (c.properties ?? []).map((p) => ({
        name: p.name,
        type: WEAVIATE_TYPE_MAP[p.dataType[0] ?? ""] ?? "unknown",
      })),
      raw: c as unknown as Json,
    };
  }

  async getStats(collection: string): Promise<CollectionStats> {
    const count = await this.aggregateCount(collection);
    return { name: collection, count };
  }

  async createCollection(spec: CreateCollectionSpec): Promise<void> {
    // vectorizer "none" → bring-your-own vectors; Weaviate infers dimension on
    // first insert, so spec.dimension isn't needed up front.
    await this.http.post("/v1/schema", {
      class: spec.name,
      vectorizer: "none",
      vectorIndexConfig: { distance: METRIC_TO_WEAVIATE[spec.metric] },
    });
  }

  async deleteCollection(collection: string): Promise<void> {
    await this.http.delete(`/v1/schema/${encodeURIComponent(collection)}`);
    this.metaCache.delete(collection);
  }

  async listRecords(collection: string, opts: PageOpts): Promise<Page<VectorRecord>> {
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

  async getRecord(collection: string, id: string | number): Promise<VectorRecord> {
    const o = await this.http.get<WeaviateObject>(
      `/v1/objects/${encodeURIComponent(collection)}/${encodeURIComponent(String(id))}?include=vector`,
    );
    return this.toRecord(o);
  }

  async upsertRecords(collection: string, records: VectorRecord[]): Promise<UpsertResult> {
    const res = await this.http.post<unknown[]>("/v1/batch/objects", {
      objects: records.map((r) => ({
        class: collection,
        id: r.id !== undefined ? String(r.id) : undefined,
        properties: r.payload,
        vector: r.vector,
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
    const fields = this.selectionFields(meta.properties, query.withVectors ?? false);
    const gql = `query Search($vec: [Float!], $limit: Int) {
      Get { ${collection}(nearVector: { vector: $vec }, limit: $limit) { ${fields} } }
    }`;
    const hits = await this.runGet(collection, gql, { vec: query.vector, limit: query.limit });
    return hits.map((h) => this.toSearchResult(h, meta.properties, "distance"));
  }

  async textSearch(collection: string, query: TextQuery): Promise<SearchResult[]> {
    const meta = await this.classMeta(collection);
    const fields = this.selectionFields(meta.properties, false);
    const operator = query.mode === "hybrid" ? "hybrid" : "bm25";
    const gql = `query Search($q: String!, $limit: Int) {
      Get { ${collection}(${operator}: { query: $q }, limit: $limit) { ${fields} } }
    }`;
    const hits = await this.runGet(collection, gql, { q: query.text, limit: query.limit });
    return hits.map((h) => this.toSearchResult(h, meta.properties, "score"));
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
    this.metaCache.set(c.class, {
      properties: (c.properties ?? []).map((p) => p.name),
      distance: c.vectorIndexConfig?.distance ? WEAVIATE_TO_METRIC[c.vectorIndexConfig.distance] : undefined,
      vectorizer: c.vectorizer,
    });
  }

  private async classMeta(collection: string): Promise<ClassMeta> {
    const cached = this.metaCache.get(collection);
    if (cached) return cached;
    const c = await this.http.get<WeaviateClass>(`/v1/schema/${encodeURIComponent(collection)}`);
    this.cacheMeta(c);
    return this.metaCache.get(collection)!;
  }

  /** GraphQL field selection: the payload props + the _additional block. */
  private selectionFields(properties: string[], withVector: boolean): string {
    const extra = ["id", "distance", "score", ...(withVector ? ["vector"] : [])].join(" ");
    return `${properties.join(" ")} _additional { ${extra} }`;
  }

  private async runGet(
    collection: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<GraphQLHit[]> {
    const res = await this.http.post<GraphQLResponse>("/v1/graphql", { query, variables });
    if (res.errors && res.errors.length) {
      throw new ConnectorError(res.errors.map((e) => e.message).join("; "), "weaviate");
    }
    return res.data?.Get?.[collection] ?? [];
  }

  private async aggregateCount(collection: string): Promise<number> {
    const gql = `{ Aggregate { ${collection} { meta { count } } } }`;
    const res = await this.http.post<GraphQLResponse>("/v1/graphql", { query: gql });
    if (res.errors && res.errors.length) {
      throw new ConnectorError(res.errors.map((e) => e.message).join("; "), "weaviate");
    }
    return res.data?.Aggregate?.[collection]?.[0]?.meta?.count ?? 0;
  }

  private toRecord(o: WeaviateObject): VectorRecord {
    return { id: o.id, payload: o.properties ?? {}, vector: o.vector };
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
    return { id: add.id ?? "", score, payload, vector: add.vector };
  }
}
