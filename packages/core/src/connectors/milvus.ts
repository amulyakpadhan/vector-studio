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
  SchemaField,
  SearchResult,
  ServerMeta,
  TestResult,
  UpsertResult,
  VectorQuery,
  VectorRecord,
  VectorSample,
} from "../types.ts";

/**
 * Milvus over its RESTful v2 API (/v2/vectordb/*).
 *
 * Three things shape this connector:
 *
 * 1. Every call returns HTTP 200 with an envelope — {code, data, message}.
 *    A non-zero `code` is a failure, so the transport's ok/not-ok check isn't
 *    enough on its own and every response is unwrapped explicitly.
 *
 * 2. Browsing needs a filter expression; Milvus has no "scan everything"
 *    query. One is synthesised from the primary key, whose name and type come
 *    from the collection schema (cached).
 *
 * 3. `distance` means different things per metric. L2 is a distance (lower is
 *    closer) while COSINE and IP are similarities (higher is closer), so the
 *    metric decides whether the value is inverted to keep every engine in this
 *    codebase reporting higher-is-more-similar.
 */

const METRIC_TO_MILVUS: Record<DistanceMetric, string> = {
  cosine: "COSINE",
  euclidean: "L2",
  dot: "IP",
};

const MILVUS_TO_METRIC: Record<string, DistanceMetric> = {
  COSINE: "cosine",
  L2: "euclidean",
  IP: "dot",
};

/** Milvus field types → the normalized types the schema view shows. */
const MILVUS_TYPE_MAP: Record<string, string> = {
  Bool: "boolean",
  Int8: "integer",
  Int16: "integer",
  Int32: "integer",
  Int64: "integer",
  Float: "number",
  Double: "number",
  VarChar: "text",
  String: "text",
  JSON: "unknown",
  Array: "unknown",
};

const VECTOR_TYPES = new Set([
  "FloatVector",
  "BinaryVector",
  "Float16Vector",
  "BFloat16Vector",
  "SparseFloatVector",
]);

interface MilvusEnvelope<T> {
  code: number;
  data: T;
  message?: string;
}

interface MilvusField {
  name: string;
  type: string;
  primaryKey?: boolean;
  autoId?: boolean;
  params?: { key: string; value: string }[];
}

interface MilvusIndex {
  fieldName: string;
  indexName?: string;
  metricType?: string;
}

interface MilvusDescribe {
  collectionName: string;
  description?: string;
  fields?: MilvusField[];
  indexes?: MilvusIndex[];
  load?: string;
  enableDynamicField?: boolean;
}

/** The per-collection facts every record call needs. */
interface CollectionMeta {
  primaryKey: string;
  primaryIsNumeric: boolean;
  vectorField: string;
  dimension?: number;
  metric?: DistanceMetric;
  /** Non-vector, non-primary fields — what we ask Milvus to return. */
  payloadFields: string[];
  fields: SchemaField[];
  raw: MilvusDescribe;
}

export class MilvusConnector implements VectorConnector {
  readonly config: ConnectionConfig;
  private readonly http: HttpClient;
  private readonly metaCache = new Map<string, CollectionMeta>();

  constructor(config: ConnectionConfig) {
    this.config = config;
    this.http = new HttpClient("milvus", {
      baseUrl: config.url,
      // Milvus takes "user:password" as a bearer token; Zilliz Cloud takes an
      // API key in the same header.
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined,
      bridgeUrl: typeof config.options?.["bridgeUrl"] === "string" ? config.options["bridgeUrl"] : undefined,
      timeoutMs: 60_000,
    });
  }

  capabilities(): ConnectorCapabilities {
    return {
      engine: "milvus",
      textSearch: false, // full-text needs a BM25 function on the collection
      hybridSearch: false,
      payloadFilters: true, // boolean filter expressions
      browse: true,
      exportVectors: true,
      createCollection: true,
      updatePayload: true, // via upsert, which needs the full row
    };
  }

  async testConnection(): Promise<TestResult> {
    const started = performance.now();
    try {
      await this.call<string[]>("/v2/vectordb/collections/list", {});
      return { ok: true, latencyMs: Math.round(performance.now() - started) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async getMeta(): Promise<ServerMeta> {
    const names = await this.call<string[]>("/v2/vectordb/collections/list", {});
    return { engine: "milvus", raw: { collectionCount: names.length } as Json };
  }

  async listCollections(): Promise<CollectionInfo[]> {
    const names = await this.call<string[]>("/v2/vectordb/collections/list", {});
    return Promise.all(
      names.map(async (name): Promise<CollectionInfo> => {
        try {
          const meta = await this.collectionMeta(name);
          let count: number | undefined;
          try {
            count = await this.rowCount(name);
          } catch {
            count = undefined;
          }
          return {
            name,
            count,
            dimension: meta.dimension,
            metric: meta.metric,
            status: meta.raw.load,
          };
        } catch {
          // A collection we can't describe still belongs in the list.
          return { name };
        }
      }),
    );
  }

  async getSchema(collection: string): Promise<CollectionSchema> {
    const meta = await this.collectionMeta(collection);
    return {
      name: collection,
      dimension: meta.dimension,
      metric: meta.metric,
      fields: meta.fields,
      raw: meta.raw as unknown as Json,
    };
  }

  async getStats(collection: string): Promise<CollectionStats> {
    return { name: collection, count: await this.rowCount(collection) };
  }

  async createCollection(spec: CreateCollectionSpec): Promise<void> {
    // The quick-setup form of the create API: Milvus generates an "id" primary
    // key and a "vector" field, and indexes the vector with this metric.
    await this.call("/v2/vectordb/collections/create", {
      collectionName: spec.name,
      dimension: spec.dimension,
      metricType: METRIC_TO_MILVUS[spec.metric],
    });
  }

  async deleteCollection(collection: string): Promise<void> {
    await this.call("/v2/vectordb/collections/drop", { collectionName: collection });
    this.metaCache.delete(collection);
  }

  async listRecords(collection: string, opts: PageOpts): Promise<Page<VectorRecord>> {
    const meta = await this.collectionMeta(collection);
    const offset = opts.cursor ? Number(opts.cursor) : 0;
    const outputFields = [meta.primaryKey, ...meta.payloadFields];
    if (opts.withVectors) outputFields.push(meta.vectorField);

    const rows = await this.call<Record<string, Json>[]>("/v2/vectordb/entities/query", {
      collectionName: collection,
      // Milvus has no "match everything" query, so the primary key stands in
      // for one: every row has a key, so this selects all of them.
      filter: this.matchAllFilter(meta),
      outputFields,
      limit: opts.limit,
      offset,
    });

    const items = rows.map((r) => this.toRecord(r, meta));
    return {
      items,
      nextCursor: items.length === opts.limit ? String(offset + items.length) : undefined,
    };
  }

  async getRecord(collection: string, id: string | number): Promise<VectorRecord> {
    const meta = await this.collectionMeta(collection);
    const rows = await this.call<Record<string, Json>[]>("/v2/vectordb/entities/get", {
      collectionName: collection,
      id: [meta.primaryIsNumeric ? Number(id) : String(id)],
      outputFields: [meta.primaryKey, meta.vectorField, ...meta.payloadFields],
    });
    const row = rows[0];
    if (!row) throw new ConnectorError(`Entity ${id} not found`, "milvus", 404);
    return this.toRecord(row, meta);
  }

  async upsertRecords(collection: string, records: VectorRecord[]): Promise<UpsertResult> {
    const meta = await this.collectionMeta(collection);
    const data = records.map((r) => ({
      [meta.primaryKey]: meta.primaryIsNumeric ? Number(r.id) : String(r.id),
      ...(r.vector ? { [meta.vectorField]: r.vector } : {}),
      ...r.payload,
    }));
    await this.call("/v2/vectordb/entities/upsert", { collectionName: collection, data });
    return { upserted: records.length };
  }

  async updatePayload(collection: string, id: string | number, payload: Record<string, unknown>): Promise<void> {
    // Milvus upserts whole rows, so the existing record is read first and the
    // new fields merged in — otherwise unlisted fields would be wiped.
    const current = await this.getRecord(collection, id);
    await this.upsertRecords(collection, [
      { id, payload: { ...current.payload, ...(payload as Record<string, Json>) }, vector: current.vector },
    ]);
  }

  async deleteRecords(collection: string, ids: (string | number)[]): Promise<void> {
    const meta = await this.collectionMeta(collection);
    await this.call("/v2/vectordb/entities/delete", {
      collectionName: collection,
      filter: `${meta.primaryKey} in [${ids
        .map((id) => (meta.primaryIsNumeric ? Number(id) : JSON.stringify(String(id))))
        .join(", ")}]`,
    });
  }

  async vectorSearch(collection: string, query: VectorQuery): Promise<SearchResult[]> {
    const meta = await this.collectionMeta(collection);
    const outputFields = [meta.primaryKey, ...meta.payloadFields];
    if (query.withVectors) outputFields.push(meta.vectorField);

    const rows = await this.call<Record<string, Json>[]>("/v2/vectordb/entities/search", {
      collectionName: collection,
      data: [query.vector],
      annsField: meta.vectorField,
      limit: query.limit,
      outputFields,
      ...(query.filter ? { filter: query.filter } : {}),
    });

    return rows.map((row) => {
      const record = this.toRecord(row, meta);
      const distance = typeof row.distance === "number" ? row.distance : 0;
      return {
        id: record.id,
        score: this.toSimilarity(distance, meta.metric),
        payload: record.payload,
        vector: record.vector,
      };
    });
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

  /** POST + unwrap. Milvus answers 200 even for failures, so `code` decides. */
  private async call<T>(path: string, body: unknown): Promise<T> {
    const res = await this.http.post<MilvusEnvelope<T>>(path, body);
    if (res.code !== 0 && res.code !== 200) {
      throw new ConnectorError(res.message ?? `Milvus error ${res.code}`, "milvus", res.code);
    }
    return res.data;
  }

  private async collectionMeta(collection: string): Promise<CollectionMeta> {
    const cached = this.metaCache.get(collection);
    if (cached) return cached;

    const d = await this.call<MilvusDescribe>("/v2/vectordb/collections/describe", {
      collectionName: collection,
    });
    const fields = d.fields ?? [];
    const primary = fields.find((f) => f.primaryKey);
    const vector = fields.find((f) => VECTOR_TYPES.has(f.type));
    if (!primary) throw new ConnectorError(`Collection "${collection}" has no primary key`, "milvus");
    if (!vector) throw new ConnectorError(`Collection "${collection}" has no vector field`, "milvus");

    const dimParam = vector.params?.find((p) => p.key === "dim")?.value;
    const metricType = d.indexes?.find((i) => i.fieldName === vector.name)?.metricType;

    const meta: CollectionMeta = {
      primaryKey: primary.name,
      primaryIsNumeric: primary.type !== "VarChar" && primary.type !== "String",
      vectorField: vector.name,
      dimension: dimParam ? Number(dimParam) : undefined,
      metric: metricType ? MILVUS_TO_METRIC[metricType] : undefined,
      payloadFields: fields
        .filter((f) => !f.primaryKey && !VECTOR_TYPES.has(f.type))
        .map((f) => f.name),
      fields: fields.map((f) => ({
        name: f.name,
        type: VECTOR_TYPES.has(f.type) ? "vector" : (MILVUS_TYPE_MAP[f.type] ?? "unknown"),
      })),
      raw: d,
    };
    this.metaCache.set(collection, meta);
    return meta;
  }

  /** A filter every row satisfies, used to browse without a query vector. */
  private matchAllFilter(meta: CollectionMeta): string {
    return meta.primaryIsNumeric ? `${meta.primaryKey} >= 0` : `${meta.primaryKey} != ""`;
  }

  private async rowCount(collection: string): Promise<number> {
    const rows = await this.call<Record<string, Json>[]>("/v2/vectordb/entities/query", {
      collectionName: collection,
      filter: "",
      outputFields: ["count(*)"],
    });
    const value = rows[0]?.["count(*)"];
    return typeof value === "number" ? value : 0;
  }

  /** Milvus reports L2 as a distance but COSINE/IP as similarities. */
  private toSimilarity(distance: number, metric?: DistanceMetric): number {
    return metric === "euclidean" ? 1 / (1 + distance) : distance;
  }

  private toRecord(row: Record<string, Json>, meta: CollectionMeta): VectorRecord {
    const payload: Record<string, Json> = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === meta.primaryKey || key === meta.vectorField || key === "distance") continue;
      payload[key] = value;
    }
    const rawVector = row[meta.vectorField];
    return {
      id: row[meta.primaryKey] as string | number,
      payload,
      vector: Array.isArray(rawVector) ? (rawVector as number[]) : undefined,
    };
  }
}
