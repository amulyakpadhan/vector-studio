import type {
  CollectionInfo,
  CollectionSchema,
  CollectionStats,
  ConnectionConfig,
  ConnectorCapabilities,
  CreateCollectionSpec,
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
} from "./types.ts";

/**
 * The contract every engine connector implements.
 * Runs entirely client-side (browser or desktop) — direct HTTP to the DB.
 */
export interface VectorConnector {
  readonly config: ConnectionConfig;

  // ─── lifecycle ────────────────────────────────────────────────
  testConnection(): Promise<TestResult>;
  getMeta(): Promise<ServerMeta>;

  // ─── collections ──────────────────────────────────────────────
  listCollections(): Promise<CollectionInfo[]>;
  getSchema(collection: string): Promise<CollectionSchema>;
  getStats(collection: string): Promise<CollectionStats>;
  createCollection(spec: CreateCollectionSpec): Promise<void>;
  deleteCollection(collection: string): Promise<void>;

  // ─── records ──────────────────────────────────────────────────
  listRecords(collection: string, opts: PageOpts): Promise<Page<VectorRecord>>;
  getRecord(collection: string, id: string | number): Promise<VectorRecord>;
  upsertRecords(collection: string, records: VectorRecord[]): Promise<UpsertResult>;
  updatePayload(collection: string, id: string | number, payload: Record<string, unknown>): Promise<void>;
  deleteRecords(collection: string, ids: (string | number)[]): Promise<void>;

  // ─── search ───────────────────────────────────────────────────
  vectorSearch(collection: string, query: VectorQuery): Promise<SearchResult[]>;
  /** Only when capabilities().textSearch is true. */
  textSearch?(collection: string, query: TextQuery): Promise<SearchResult[]>;
  /** Bulk vector export for the projection engine. */
  fetchVectors(collection: string, opts: SampleOpts): Promise<VectorSample>;

  // ─── introspection ────────────────────────────────────────────
  capabilities(): ConnectorCapabilities;
}

/** Raised for any failed engine call, with enough context to show a useful error. */
export class ConnectorError extends Error {
  readonly engine: string;
  readonly status?: number;
  readonly detail?: unknown;

  constructor(message: string, engine: string, status?: number, detail?: unknown) {
    super(message);
    this.name = "ConnectorError";
    this.engine = engine;
    this.status = status;
    this.detail = detail;
  }
}
