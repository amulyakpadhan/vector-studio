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

// ─── Qdrant REST response shapes (only the fields we read) ───────────────────

interface QdrantEnvelope<T> {
  result: T;
  status: string | { error: string };
  time: number;
}

interface QdrantRoot {
  title: string;
  version: string;
}

interface QdrantCollectionDesc {
  name: string;
}

interface QdrantVectorParams {
  size: number;
  distance: "Cosine" | "Euclid" | "Dot" | "Manhattan";
}

interface QdrantCollectionDetail {
  status: string;
  points_count: number | null;
  config: {
    params: {
      // single unnamed vector or named vectors map
      vectors: QdrantVectorParams | Record<string, QdrantVectorParams>;
    };
  };
  payload_schema: Record<string, { data_type: string; points?: number }>;
}

interface QdrantPoint {
  id: string | number;
  payload?: Record<string, Json>;
  vector?: number[] | Record<string, number[]>;
}

interface QdrantScrollResult {
  points: QdrantPoint[];
  next_page_offset: string | number | null;
}

interface QdrantScoredPoint extends QdrantPoint {
  score: number;
}

interface QdrantQueryResult {
  points: QdrantScoredPoint[];
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const METRIC_TO_QDRANT: Record<DistanceMetric, string> = {
  cosine: "Cosine",
  euclidean: "Euclid",
  dot: "Dot",
};

const QDRANT_TO_METRIC: Record<string, DistanceMetric> = {
  Cosine: "cosine",
  Euclid: "euclidean",
  Dot: "dot",
};

const QDRANT_TYPE_MAP: Record<string, string> = {
  keyword: "text",
  text: "text",
  integer: "integer",
  float: "number",
  bool: "boolean",
  geo: "geo",
  datetime: "text",
};

/** Qdrant supports named vectors; we surface the default (unnamed) one for now. */
function defaultVectorParams(
  vectors: QdrantVectorParams | Record<string, QdrantVectorParams>,
): QdrantVectorParams | undefined {
  if (typeof (vectors as QdrantVectorParams).size === "number") {
    return vectors as QdrantVectorParams;
  }
  const named = vectors as Record<string, QdrantVectorParams>;
  const first = Object.values(named)[0];
  return first;
}

function pointVector(v: QdrantPoint["vector"]): number[] | undefined {
  if (!v) return undefined;
  if (Array.isArray(v)) return v;
  const first = Object.values(v)[0];
  return first;
}

// ─── connector ───────────────────────────────────────────────────────────────

export class QdrantConnector implements VectorConnector {
  readonly config: ConnectionConfig;
  private readonly http: HttpClient;
  /**
   * Qdrant Cloud Inference (https://qdrant.tech/cloud-inference/) has no
   * per-collection config to detect — a Document `{text, model}` can be
   * sent in place of a raw vector on any call, for any model, at any time.
   * So which model to use is a per-connection choice the user makes (like
   * Pinecone's namespace), not something we read off the collection.
   */
  private readonly inferenceModel?: string;
  private readonly inferenceField: string;

  constructor(config: ConnectionConfig) {
    this.config = config;
    this.http = new HttpClient("qdrant", {
      baseUrl: config.url,
      headers: config.apiKey ? { "api-key": config.apiKey } : undefined,
      bridgeUrl: typeof config.options?.["bridgeUrl"] === "string" ? config.options["bridgeUrl"] : undefined,
    });
    this.inferenceModel =
      typeof config.options?.["inferenceModel"] === "string" && config.options["inferenceModel"]
        ? config.options["inferenceModel"]
        : undefined;
    this.inferenceField =
      (typeof config.options?.["inferenceField"] === "string" && config.options["inferenceField"]) || "text";
  }

  capabilities(): ConnectorCapabilities {
    return {
      engine: "qdrant",
      textSearch: false, // full-text needs a payload index; revisit with filter UI
      hybridSearch: false,
      payloadFilters: true,
      filterBrowse: true,
      browse: true,
      exportVectors: true,
      createCollection: true,
      updatePayload: true,
    };
  }

  async testConnection(): Promise<TestResult> {
    const started = performance.now();
    try {
      const root = await this.http.get<QdrantRoot>("/");
      return { ok: true, version: root.version, latencyMs: Math.round(performance.now() - started) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async getMeta(): Promise<ServerMeta> {
    const root = await this.http.get<QdrantRoot>("/");
    return { engine: "qdrant", version: root.version, raw: root as unknown as Json };
  }

  async listCollections(): Promise<CollectionInfo[]> {
    const res = await this.http.get<QdrantEnvelope<{ collections: QdrantCollectionDesc[] }>>("/collections");
    const infos = await Promise.all(
      res.result.collections.map(async (c): Promise<CollectionInfo> => {
        try {
          const detail = await this.describe(c.name);
          const vp = defaultVectorParams(detail.config.params.vectors);
          return {
            name: c.name,
            count: detail.points_count ?? undefined,
            dimension: vp?.size,
            metric: vp ? QDRANT_TO_METRIC[vp.distance] : undefined,
            status: detail.status,
          };
        } catch {
          return { name: c.name };
        }
      }),
    );
    return infos;
  }

  async getSchema(collection: string): Promise<CollectionSchema> {
    const detail = await this.describe(collection);
    const vp = defaultVectorParams(detail.config.params.vectors);
    return {
      name: collection,
      dimension: vp?.size,
      metric: vp ? QDRANT_TO_METRIC[vp.distance] : undefined,
      fields: Object.entries(detail.payload_schema ?? {}).map(([name, spec]) => ({
        name,
        type: QDRANT_TYPE_MAP[spec.data_type] ?? "unknown",
        indexed: true, // presence in payload_schema means an index exists
      })),
      serverVectorizer: this.inferenceModel,
      serverVectorizerField: this.inferenceModel ? this.inferenceField : undefined,
      raw: detail as unknown as Json,
    };
  }

  async getStats(collection: string): Promise<CollectionStats> {
    const detail = await this.describe(collection);
    return { name: collection, count: detail.points_count ?? 0, raw: detail as unknown as Json };
  }

  async createCollection(spec: CreateCollectionSpec): Promise<void> {
    await this.http.put(`/collections/${encodeURIComponent(spec.name)}`, {
      vectors: { size: spec.dimension, distance: METRIC_TO_QDRANT[spec.metric] },
    });
  }

  async deleteCollection(collection: string): Promise<void> {
    await this.http.delete(`/collections/${encodeURIComponent(collection)}`);
  }

  async listRecords(collection: string, opts: PageOpts): Promise<Page<VectorRecord>> {
    const res = await this.http.post<QdrantEnvelope<QdrantScrollResult>>(
      `/collections/${encodeURIComponent(collection)}/points/scroll`,
      {
        limit: opts.limit,
        offset: opts.cursor !== undefined ? decodeCursor(opts.cursor) : undefined,
        filter: opts.filter,
        with_payload: true,
        with_vector: opts.withVectors ?? false,
      },
    );
    const next = res.result.next_page_offset;
    return {
      items: res.result.points.map((p) => this.toRecord(p)),
      nextCursor: next === null || next === undefined ? undefined : encodeCursor(next),
    };
  }

  async getRecord(collection: string, id: string | number): Promise<VectorRecord> {
    // Use the batch-retrieve endpoint so the vector is included (the single-GET
    // form omits it), which "search by example" and the inspector rely on.
    const res = await this.http.post<QdrantEnvelope<QdrantPoint[]>>(
      `/collections/${encodeURIComponent(collection)}/points`,
      { ids: [id], with_payload: true, with_vector: true },
    );
    const point = res.result?.[0];
    if (!point) throw new ConnectorError(`Point ${id} not found`, "qdrant", 404);
    return this.toRecord(point);
  }

  async upsertRecords(collection: string, records: VectorRecord[]): Promise<UpsertResult> {
    await this.http.put(`/collections/${encodeURIComponent(collection)}/points?wait=true`, {
      points: records.map((r) => ({ id: r.id, vector: this.vectorFor(r), payload: r.payload })),
    });
    return { upserted: records.length };
  }

  /** Integrated-inference indexes only: search by raw text via Qdrant Cloud Inference. */
  async searchByText(
    collection: string,
    query: { text: string; limit: number; filter?: Json },
  ): Promise<SearchResult[]> {
    if (!this.inferenceModel) {
      throw new ConnectorError(
        "No Qdrant Cloud Inference model configured on this connection — set one under Advanced settings.",
        "qdrant",
      );
    }
    const res = await this.http.post<QdrantEnvelope<QdrantQueryResult>>(
      `/collections/${encodeURIComponent(collection)}/points/query`,
      {
        query: { text: query.text, model: this.inferenceModel },
        limit: query.limit,
        filter: query.filter,
        with_payload: true,
      },
    );
    return res.result.points.map((p) => ({
      id: p.id,
      score: p.score,
      payload: p.payload ?? {},
      vector: pointVector(p.vector),
    }));
  }

  async updatePayload(collection: string, id: string | number, payload: Record<string, unknown>): Promise<void> {
    await this.http.post(`/collections/${encodeURIComponent(collection)}/points/payload?wait=true`, {
      points: [id],
      payload,
    });
  }

  async deleteRecords(collection: string, ids: (string | number)[]): Promise<void> {
    await this.http.post(`/collections/${encodeURIComponent(collection)}/points/delete?wait=true`, {
      points: ids,
    });
  }

  async vectorSearch(collection: string, query: VectorQuery): Promise<SearchResult[]> {
    const res = await this.http.post<QdrantEnvelope<QdrantScoredPoint[]>>(
      `/collections/${encodeURIComponent(collection)}/points/search`,
      {
        vector: query.vector,
        limit: query.limit,
        filter: query.filter,
        with_payload: true,
        with_vector: query.withVectors ?? false,
      },
    );
    return res.result.map((p) => ({
      id: p.id,
      score: p.score,
      payload: p.payload ?? {},
      vector: pointVector(p.vector),
    }));
  }

  async fetchVectors(collection: string, opts: SampleOpts): Promise<VectorSample> {
    const page = await this.listRecords(collection, {
      limit: opts.limit,
      cursor: opts.cursor,
      withVectors: true,
    });
    const withVec = page.items.filter((r) => r.vector !== undefined);
    return {
      ids: withVec.map((r) => r.id),
      vectors: withVec.map((r) => r.vector as number[]),
      payloads: withVec.map((r) => r.payload),
      nextCursor: page.nextCursor,
    };
  }

  // ─── private ────────────────────────────────────────────────

  private async describe(collection: string): Promise<QdrantCollectionDetail> {
    const res = await this.http.get<QdrantEnvelope<QdrantCollectionDetail>>(
      `/collections/${encodeURIComponent(collection)}`,
    );
    return res.result;
  }

  private toRecord(p: QdrantPoint): VectorRecord {
    return { id: p.id, payload: p.payload ?? {}, vector: pointVector(p.vector) };
  }

  /** A raw vector if the record has one; otherwise a Document for Qdrant to embed server-side. */
  private vectorFor(r: VectorRecord): unknown {
    if (r.vector && r.vector.length > 0) return r.vector;
    if (!this.inferenceModel) {
      throw new ConnectorError(
        `Record ${r.id} has no vector and no Qdrant Cloud Inference model is configured — set one under Advanced settings, or supply a vector for every record.`,
        "qdrant",
      );
    }
    const text = r.payload[this.inferenceField];
    if (typeof text !== "string" || text.trim() === "") {
      throw new ConnectorError(
        `Record ${r.id} has no "${this.inferenceField}" field to embed — this connection embeds from that field.`,
        "qdrant",
      );
    }
    return { text, model: this.inferenceModel };
  }
}

/** Qdrant's scroll offset can be a number or a point-id string; keep it opaque. */
function encodeCursor(offset: string | number): string {
  return JSON.stringify(offset);
}

function decodeCursor(cursor: string): string | number {
  return JSON.parse(cursor) as string | number;
}
