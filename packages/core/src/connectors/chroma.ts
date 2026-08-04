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
 * Chroma over its REST API.
 *
 * Two wrinkles shape this connector:
 *
 * 1. Two API generations are in the wild. Chroma 1.x serves
 *    /api/v2/tenants/{tenant}/databases/{db}/collections; older servers serve
 *    a flat /api/v1/collections. We probe once on first use and cache which
 *    one answers, so both work without the user picking.
 *
 * 2. Record endpoints are keyed by the collection's UUID, not its name, so
 *    names are resolved to ids and cached (same shape as Pinecone's host
 *    lookup).
 *
 * Chroma's "documents" are the source text alongside the vector; they're
 * surfaced in the payload under `document` so they show up in the data grid.
 */

const DEFAULT_TENANT = "default_tenant";
const DEFAULT_DATABASE = "default_database";

const METRIC_TO_CHROMA: Record<DistanceMetric, string> = {
  cosine: "cosine",
  euclidean: "l2",
  dot: "ip",
};

const CHROMA_TO_METRIC: Record<string, DistanceMetric> = {
  cosine: "cosine",
  l2: "euclidean",
  ip: "dot",
};

interface ChromaCollection {
  id: string;
  name: string;
  metadata?: Record<string, Json> | null;
  dimension?: number | null;
}

/** Shape of /get — parallel arrays, one entry per record. */
interface ChromaGetResult {
  ids?: string[];
  embeddings?: (number[] | null)[] | null;
  metadatas?: (Record<string, Json> | null)[] | null;
  documents?: (string | null)[] | null;
}

/** Shape of /query — the same arrays, nested one level per query vector. */
interface ChromaQueryResult {
  ids?: string[][];
  distances?: number[][] | null;
  embeddings?: (number[] | null)[][] | null;
  metadatas?: (Record<string, Json> | null)[][] | null;
  documents?: (string | null)[][] | null;
}

export class ChromaConnector implements VectorConnector {
  readonly config: ConnectionConfig;
  private readonly http: HttpClient;
  private readonly tenant: string;
  private readonly database: string;
  /** Resolved once: the collections path prefix for whichever API answers. */
  private basePath?: string;
  /** collection name → uuid, needed by every record endpoint. */
  private readonly idCache = new Map<string, string>();

  constructor(config: ConnectionConfig) {
    this.config = config;
    this.tenant = typeof config.options?.["tenant"] === "string" ? config.options["tenant"] : DEFAULT_TENANT;
    this.database =
      typeof config.options?.["database"] === "string" ? config.options["database"] : DEFAULT_DATABASE;
    this.http = new HttpClient("chroma", {
      baseUrl: config.url,
      // Chroma Cloud and auth-enabled servers take a bearer token; local
      // servers usually need nothing.
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined,
      bridgeUrl: typeof config.options?.["bridgeUrl"] === "string" ? config.options["bridgeUrl"] : undefined,
      timeoutMs: 60_000,
    });
  }

  capabilities(): ConnectorCapabilities {
    return {
      engine: "chroma",
      // `where_document` filters by substring but doesn't rank, so exposing it
      // as text search would misrepresent what comes back.
      textSearch: false,
      hybridSearch: false,
      payloadFilters: true, // `where` on metadata
      filterBrowse: true, // /get accepts a where filter
      browse: true,
      exportVectors: true,
      createCollection: true,
      updatePayload: true,
    };
  }

  async testConnection(): Promise<TestResult> {
    const started = performance.now();
    try {
      await this.resolveBasePath();
      return {
        ok: true,
        version: await this.readVersion(),
        latencyMs: Math.round(performance.now() - started),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async getMeta(): Promise<ServerMeta> {
    await this.resolveBasePath();
    return { engine: "chroma", version: await this.readVersion() };
  }

  async listCollections(): Promise<CollectionInfo[]> {
    const base = await this.resolveBasePath();
    const collections = await this.http.get<ChromaCollection[]>(base);
    return Promise.all(
      collections.map(async (c): Promise<CollectionInfo> => {
        this.idCache.set(c.name, c.id);
        let count: number | undefined;
        try {
          count = await this.http.get<number>(`${base}/${c.id}/count`);
        } catch {
          count = undefined;
        }
        return {
          name: c.name,
          count,
          dimension: c.dimension ?? undefined,
          metric: this.metricOf(c),
        };
      }),
    );
  }

  async getSchema(collection: string): Promise<CollectionSchema> {
    const c = await this.describe(collection);
    // Chroma metadata is schemaless; derive the field list from a sample
    // record so the UI has something meaningful to show.
    let fields: { name: string; type: string }[] = [];
    let dimension = c.dimension ?? undefined;
    try {
      const page = await this.listRecords(collection, { limit: 1, withVectors: true });
      const sample = page.items[0];
      if (sample) {
        dimension ??= sample.vector?.length;
        fields = Object.entries(sample.payload).map(([name, value]) => ({
          name,
          type: typeofPayload(value),
        }));
      }
    } catch {
      // A schema view is still useful without the sample.
    }
    return {
      name: collection,
      dimension,
      metric: this.metricOf(c),
      fields,
      raw: c as unknown as Json,
    };
  }

  async getStats(collection: string): Promise<CollectionStats> {
    const base = await this.resolveBasePath();
    const id = await this.collectionId(collection);
    const count = await this.http.get<number>(`${base}/${id}/count`);
    return { name: collection, count: count ?? 0 };
  }

  async createCollection(spec: CreateCollectionSpec): Promise<void> {
    const base = await this.resolveBasePath();
    // Chroma infers dimension from the first insert, so only the distance
    // space is configurable up front.
    await this.http.post(base, {
      name: spec.name,
      metadata: { "hnsw:space": METRIC_TO_CHROMA[spec.metric] },
    });
  }

  async deleteCollection(collection: string): Promise<void> {
    const base = await this.resolveBasePath();
    // v2 deletes by name; v1 accepts the name too.
    await this.http.delete(`${base}/${encodeURIComponent(collection)}`);
    this.idCache.delete(collection);
  }

  async listRecords(collection: string, opts: PageOpts): Promise<Page<VectorRecord>> {
    const base = await this.resolveBasePath();
    const id = await this.collectionId(collection);
    const offset = opts.cursor ? Number(opts.cursor) : 0;
    const include = ["metadatas", "documents", ...(opts.withVectors ? ["embeddings"] : [])];
    const res = await this.http.post<ChromaGetResult>(`${base}/${id}/get`, {
      limit: opts.limit,
      offset,
      where: opts.filter ?? undefined,
      include,
    });
    const items = this.toRecords(res);
    return {
      items,
      // Offset paging: assume another page exists while this one came back full.
      nextCursor: items.length === opts.limit ? String(offset + items.length) : undefined,
    };
  }

  async getRecord(collection: string, id: string | number): Promise<VectorRecord> {
    const base = await this.resolveBasePath();
    const cid = await this.collectionId(collection);
    const res = await this.http.post<ChromaGetResult>(`${base}/${cid}/get`, {
      ids: [String(id)],
      include: ["metadatas", "documents", "embeddings"],
    });
    const items = this.toRecords(res);
    if (items.length === 0) throw new ConnectorError(`Record ${id} not found`, "chroma", 404);
    return items[0]!;
  }

  async upsertRecords(collection: string, records: VectorRecord[]): Promise<UpsertResult> {
    const base = await this.resolveBasePath();
    const cid = await this.collectionId(collection);
    // `document` is Chroma's own field, not user metadata — split it back out.
    const documents: (string | null)[] = [];
    const metadatas: Record<string, Json>[] = [];
    for (const r of records) {
      const { document, ...rest } = r.payload;
      documents.push(typeof document === "string" ? document : null);
      metadatas.push(rest);
    }
    await this.http.post(`${base}/${cid}/upsert`, {
      ids: records.map((r) => String(r.id)),
      embeddings: records.map((r) => r.vector ?? []),
      metadatas,
      documents,
    });
    return { upserted: records.length };
  }

  async updatePayload(collection: string, id: string | number, payload: Record<string, unknown>): Promise<void> {
    const base = await this.resolveBasePath();
    const cid = await this.collectionId(collection);
    const { document, ...rest } = payload as Record<string, Json>;
    await this.http.post(`${base}/${cid}/update`, {
      ids: [String(id)],
      metadatas: [rest],
      ...(typeof document === "string" ? { documents: [document] } : {}),
    });
  }

  async deleteRecords(collection: string, ids: (string | number)[]): Promise<void> {
    const base = await this.resolveBasePath();
    const cid = await this.collectionId(collection);
    await this.http.post(`${base}/${cid}/delete`, { ids: ids.map(String) });
  }

  async vectorSearch(collection: string, query: VectorQuery): Promise<SearchResult[]> {
    const base = await this.resolveBasePath();
    const cid = await this.collectionId(collection);
    const include = ["metadatas", "documents", "distances", ...(query.withVectors ? ["embeddings"] : [])];
    const res = await this.http.post<ChromaQueryResult>(`${base}/${cid}/query`, {
      query_embeddings: [query.vector],
      n_results: query.limit,
      where: query.filter ?? undefined,
      include,
    });
    // Results nest one level per query vector; we always send exactly one.
    const ids = res.ids?.[0] ?? [];
    const distances = res.distances?.[0] ?? [];
    const metadatas = res.metadatas?.[0] ?? [];
    const documents = res.documents?.[0] ?? [];
    const embeddings = res.embeddings?.[0] ?? [];
    return ids.map((id, i) => ({
      id,
      // Chroma reports distance (lower is closer); flip it so every engine
      // reports higher-is-more-similar.
      score: typeof distances[i] === "number" ? 1 - distances[i]! : 0,
      payload: mergeDocument(metadatas[i] ?? {}, documents[i] ?? null),
      vector: embeddings[i] ?? undefined,
    }));
  }

  async fetchVectors(collection: string, opts: SampleOpts): Promise<VectorSample> {
    const page = await this.listRecords(collection, {
      limit: opts.limit,
      cursor: opts.cursor,
      withVectors: true,
    });
    const withVec = page.items.filter((r) => r.vector !== undefined && r.vector.length > 0);
    return {
      ids: withVec.map((r) => r.id),
      vectors: withVec.map((r) => r.vector as number[]),
      payloads: withVec.map((r) => r.payload),
      nextCursor: page.nextCursor,
    };
  }

  // ─── private ────────────────────────────────────────────────

  /** Probe for the v2 layout, falling back to v1, and remember the winner. */
  private async resolveBasePath(): Promise<string> {
    if (this.basePath) return this.basePath;
    const v2 = `/api/v2/tenants/${encodeURIComponent(this.tenant)}/databases/${encodeURIComponent(
      this.database,
    )}/collections`;
    try {
      await this.http.get<unknown>(v2);
      this.basePath = v2;
      return v2;
    } catch (err) {
      // Only fall back when v2 genuinely isn't there — a 401/403/500 means the
      // server does speak v2 and something else is wrong, so surface that.
      const status = err instanceof ConnectorError ? err.status : undefined;
      if (status !== undefined && status !== 404 && status !== 400 && status !== 410) throw err;
    }
    const v1 = "/api/v1/collections";
    await this.http.get<unknown>(v1);
    this.basePath = v1;
    return v1;
  }

  private async readVersion(): Promise<string | undefined> {
    const path = this.basePath?.startsWith("/api/v2") ? "/api/v2/version" : "/api/v1/version";
    try {
      const raw = await this.http.get<unknown>(path);
      // Older builds return a bare quoted string, newer ones an object.
      if (typeof raw === "string") return raw;
      if (raw && typeof raw === "object" && "version" in raw) return String((raw as { version: unknown }).version);
    } catch {
      // Version is decoration; a working collections call already proved reachability.
    }
    return undefined;
  }

  private async describe(collection: string): Promise<ChromaCollection> {
    const base = await this.resolveBasePath();
    const c = await this.http.get<ChromaCollection>(`${base}/${encodeURIComponent(collection)}`);
    if (c?.id) this.idCache.set(c.name ?? collection, c.id);
    return c;
  }

  private async collectionId(collection: string): Promise<string> {
    const cached = this.idCache.get(collection);
    if (cached) return cached;
    const c = await this.describe(collection);
    if (!c?.id) throw new ConnectorError(`Collection "${collection}" not found`, "chroma", 404);
    return c.id;
  }

  private metricOf(c: ChromaCollection): DistanceMetric | undefined {
    const space = c.metadata?.["hnsw:space"];
    return typeof space === "string" ? CHROMA_TO_METRIC[space] : undefined;
  }

  /** Fold Chroma's parallel arrays back into records. */
  private toRecords(res: ChromaGetResult): VectorRecord[] {
    const ids = res.ids ?? [];
    return ids.map((id, i) => ({
      id,
      payload: mergeDocument(res.metadatas?.[i] ?? {}, res.documents?.[i] ?? null),
      vector: res.embeddings?.[i] ?? undefined,
    }));
  }
}

/** Chroma keeps the source text out of metadata; show it as a payload field. */
function mergeDocument(
  metadata: Record<string, Json> | null,
  document: string | null,
): Record<string, Json> {
  const payload: Record<string, Json> = { ...(metadata ?? {}) };
  if (document !== null && document !== undefined) payload.document = document;
  return payload;
}

function typeofPayload(value: Json): string {
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "text";
  return "unknown";
}
