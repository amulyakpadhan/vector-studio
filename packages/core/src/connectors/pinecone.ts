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
  UpsertResult,
  VectorQuery,
  VectorRecord,
  VectorSample,
} from "../types.ts";

/**
 * Pinecone speaks two APIs:
 *   • control plane  → https://api.pinecone.io   (list/describe/create/delete indexes)
 *   • data plane     → https://{index-host}       (query, upsert, fetch, list, delete)
 *
 * A Pinecone "index" is our collection; "metadata" is our payload; "values"
 * is the vector. Namespaces are a sub-partition — for now we operate on the
 * default namespace and will surface namespace selection in the UI later.
 */

const CONTROL_PLANE = "https://api.pinecone.io";
const API_VERSION = "2025-01";

const METRIC_TO_PINECONE: Record<DistanceMetric, string> = {
  cosine: "cosine",
  euclidean: "euclidean",
  dot: "dotproduct",
};

const PINECONE_TO_METRIC: Record<string, DistanceMetric> = {
  cosine: "cosine",
  euclidean: "euclidean",
  dotproduct: "dot",
};

// ─── control-plane shapes ────────────────────────────────────────────────────

interface PineconeIndex {
  name: string;
  dimension: number;
  metric: string;
  host: string;
  status?: { ready: boolean; state: string };
  spec?: Json;
}

interface PineconeIndexList {
  indexes: PineconeIndex[];
}

// ─── data-plane shapes ───────────────────────────────────────────────────────

interface PineconeStats {
  namespaces?: Record<string, { vectorCount: number }>;
  dimension?: number;
  totalVectorCount?: number;
}

interface PineconeVector {
  id: string;
  values?: number[];
  metadata?: Record<string, Json>;
}

interface PineconeListResult {
  vectors: { id: string }[];
  pagination?: { next?: string };
  namespace?: string;
}

interface PineconeFetchResult {
  vectors: Record<string, PineconeVector>;
}

interface PineconeQueryResult {
  matches: { id: string; score: number; values?: number[]; metadata?: Record<string, Json> }[];
}

// ─── connector ───────────────────────────────────────────────────────────────

export class PineconeConnector implements VectorConnector {
  readonly config: ConnectionConfig;
  private readonly control: HttpClient;
  private readonly bridgeUrl?: string;
  private readonly apiKey?: string;
  private readonly namespace?: string;
  /** index name → data-plane client (hosts are discovered from the control plane). */
  private readonly dataClients = new Map<string, HttpClient>();
  /** cached index descriptors from the last list/describe. */
  private readonly indexCache = new Map<string, PineconeIndex>();

  constructor(config: ConnectionConfig) {
    this.config = config;
    this.apiKey = config.apiKey;
    this.bridgeUrl = typeof config.options?.["bridgeUrl"] === "string" ? config.options["bridgeUrl"] : undefined;
    this.namespace = typeof config.options?.["namespace"] === "string" && config.options["namespace"] ? config.options["namespace"] : undefined;
    // config.url is optional for Pinecone; the control plane host is fixed.
    this.control = new HttpClient("pinecone", {
      baseUrl: config.url?.trim() || CONTROL_PLANE,
      headers: this.headers(),
      bridgeUrl: this.bridgeUrl,
    });
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "X-Pinecone-API-Version": API_VERSION };
    if (this.apiKey) h["Api-Key"] = this.apiKey;
    return h;
  }

  capabilities(): ConnectorCapabilities {
    return {
      engine: "pinecone",
      textSearch: false, // sparse/hybrid is advanced; revisit later
      hybridSearch: false,
      payloadFilters: true, // metadata filters on query
      filterBrowse: false, // /vectors/list has no metadata filter — search only
      browse: true, // via list + fetch (serverless indexes)
      exportVectors: true,
      createCollection: true,
      updatePayload: true, // via /update setMetadata
    };
  }

  async testConnection(): Promise<TestResult> {
    if (!this.apiKey) return { ok: false, error: "Pinecone requires an API key." };
    const started = performance.now();
    try {
      await this.control.get<PineconeIndexList>("/indexes");
      return { ok: true, latencyMs: Math.round(performance.now() - started) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async getMeta(): Promise<ServerMeta> {
    const list = await this.control.get<PineconeIndexList>("/indexes");
    return { engine: "pinecone", raw: { indexCount: list.indexes.length } as Json };
  }

  async listCollections(): Promise<CollectionInfo[]> {
    const list = await this.control.get<PineconeIndexList>("/indexes");
    // Counts require a data-plane call per index; fetch them best-effort in parallel.
    return Promise.all(
      list.indexes.map(async (idx): Promise<CollectionInfo> => {
        this.indexCache.set(idx.name, idx);
        let count: number | undefined;
        try {
          const stats = await this.stats(idx.name);
          count = stats.totalVectorCount;
        } catch {
          count = undefined;
        }
        return {
          name: idx.name,
          count,
          dimension: idx.dimension,
          metric: PINECONE_TO_METRIC[idx.metric],
          status: idx.status?.state,
        };
      }),
    );
  }

  async getSchema(collection: string): Promise<CollectionSchema> {
    const idx = await this.describe(collection);
    // Pinecone metadata is schemaless — no field list to report.
    return {
      name: collection,
      dimension: idx.dimension,
      metric: PINECONE_TO_METRIC[idx.metric],
      fields: [],
      raw: idx as unknown as Json,
    };
  }

  async getStats(collection: string): Promise<CollectionStats> {
    const stats = await this.stats(collection);
    return { name: collection, count: stats.totalVectorCount ?? 0, raw: stats as unknown as Json };
  }

  async createCollection(spec: CreateCollectionSpec): Promise<void> {
    const cloud = str(spec.options?.["cloud"]) || "aws";
    const region = str(spec.options?.["region"]) || "us-east-1";
    await this.control.post("/indexes", {
      name: spec.name,
      dimension: spec.dimension,
      metric: METRIC_TO_PINECONE[spec.metric],
      spec: { serverless: { cloud, region } },
    });
  }

  async deleteCollection(collection: string): Promise<void> {
    await this.control.delete(`/indexes/${encodeURIComponent(collection)}`);
    this.dataClients.delete(collection);
    this.indexCache.delete(collection);
  }

  async listRecords(collection: string, opts: PageOpts): Promise<Page<VectorRecord>> {
    const data = await this.dataClient(collection);
    const q = new URLSearchParams({ limit: String(opts.limit) });
    if (opts.cursor) q.set("paginationToken", opts.cursor);
    if (this.namespace) q.set("namespace", this.namespace);
    const listed = await data.get<PineconeListResult>(`/vectors/list?${q.toString()}`);
    const ids = listed.vectors.map((v) => v.id);
    const items = ids.length ? await this.fetchByIds(collection, ids) : [];
    return { items, nextCursor: listed.pagination?.next };
  }

  async getRecord(collection: string, id: string | number): Promise<VectorRecord> {
    const items = await this.fetchByIds(collection, [String(id)]);
    if (items.length === 0) throw new ConnectorError(`Vector ${id} not found`, "pinecone", 404);
    return items[0]!;
  }

  async upsertRecords(collection: string, records: VectorRecord[]): Promise<UpsertResult> {
    const data = await this.dataClient(collection);
    const res = await data.post<{ upsertedCount?: number }>("/vectors/upsert", {
      vectors: records.map((r) => ({
        id: String(r.id),
        values: r.vector ?? [],
        metadata: r.payload,
      })),
      ...this.ns(),
    });
    return { upserted: res.upsertedCount ?? records.length };
  }

  async updatePayload(collection: string, id: string | number, payload: Record<string, unknown>): Promise<void> {
    const data = await this.dataClient(collection);
    await data.post("/update", { id: String(id), setMetadata: payload, ...this.ns() });
  }

  async deleteRecords(collection: string, ids: (string | number)[]): Promise<void> {
    const data = await this.dataClient(collection);
    await data.post("/vectors/delete", { ids: ids.map(String), ...this.ns() });
  }

  async vectorSearch(collection: string, query: VectorQuery): Promise<SearchResult[]> {
    const data = await this.dataClient(collection);
    const res = await data.post<PineconeQueryResult>("/query", {
      vector: query.vector,
      topK: query.limit,
      filter: query.filter,
      includeMetadata: true,
      includeValues: query.withVectors ?? false,
      ...this.ns(),
    });
    return res.matches.map((m) => ({
      id: m.id,
      score: m.score,
      payload: m.metadata ?? {},
      vector: m.values,
    }));
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

  private async describe(collection: string): Promise<PineconeIndex> {
    const cached = this.indexCache.get(collection);
    if (cached) return cached;
    const idx = await this.control.get<PineconeIndex>(`/indexes/${encodeURIComponent(collection)}`);
    this.indexCache.set(collection, idx);
    return idx;
  }

  /** Resolve (and cache) the data-plane client for an index via its host. */
  private async dataClient(collection: string): Promise<HttpClient> {
    let client = this.dataClients.get(collection);
    if (client) return client;
    const idx = await this.describe(collection);
    if (!idx.host) throw new ConnectorError(`Index "${collection}" has no host yet (still initializing?)`, "pinecone");
    const baseUrl = idx.host.startsWith("http") ? idx.host : `https://${idx.host}`;
    client = new HttpClient("pinecone", { baseUrl, headers: this.headers(), bridgeUrl: this.bridgeUrl });
    this.dataClients.set(collection, client);
    return client;
  }

  private async stats(collection: string): Promise<PineconeStats> {
    const data = await this.dataClient(collection);
    return data.post<PineconeStats>("/describe_index_stats", {});
  }

  /** Namespace body fragment, spread into POST payloads when one is configured. */
  private ns(): { namespace?: string } {
    return this.namespace ? { namespace: this.namespace } : {};
  }

  private async fetchByIds(collection: string, ids: string[]): Promise<VectorRecord[]> {
    const data = await this.dataClient(collection);
    const q = new URLSearchParams();
    for (const id of ids) q.append("ids", id);
    if (this.namespace) q.set("namespace", this.namespace);
    const res = await data.get<PineconeFetchResult>(`/vectors/fetch?${q.toString()}`);
    return Object.values(res.vectors).map((v) => ({
      id: v.id,
      payload: v.metadata ?? {},
      vector: v.values,
    }));
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
