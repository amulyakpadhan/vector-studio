/**
 * The webview side of the host<->webview bridge.
 *
 * Exposes drop-in replacements for `@vyn/core`'s `createConnector` and
 * `embedText`. Every method that touches the network is forwarded to the
 * extension host over `postMessage`; the host runs the real connector with
 * Node's native `fetch`. Methods that do no I/O (`capabilities`, `config`) are
 * answered locally and synchronously from a real connector instance, because
 * the UI calls them synchronously.
 */
import {
  createConnector as realCreateConnector,
  type ConnectionConfig,
  type EmbeddingConfig,
  type VectorConnector,
  type CollectionInfo,
  type CollectionSchema,
  type CollectionStats,
  type ConnectorCapabilities,
  type CreateCollectionSpec,
  type Page,
  type PageOpts,
  type SampleOpts,
  type SearchResult,
  type ServerMeta,
  type TestResult,
  type TextQuery,
  type UpsertResult,
  type VectorQuery,
  type VectorRecord,
  type VectorSample,
} from "../../../../packages/core/dist/index";

// ─── VS Code webview handle (acquire exactly once) ───────────────────────────

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscodeApi: VsCodeApi = acquireVsCodeApi();

// ─── RPC transport ───────────────────────────────────────────────────────────

let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

window.addEventListener("message", (e: MessageEvent) => {
  const m = e.data;
  if (!m || m.type !== "rpc-result") return;
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.ok) p.resolve(m.data);
  else p.reject(new Error(m.error ?? "RPC failed"));
});

function call<T>(msg: Record<string, unknown>): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    vscodeApi.postMessage({ ...msg, type: "rpc", id });
  });
}

// ─── connector proxy ─────────────────────────────────────────────────────────

class RpcConnector implements VectorConnector {
  /** A real connector, used only for synchronous, no-network calls. */
  private readonly local: VectorConnector;

  constructor(private readonly cfg: ConnectionConfig) {
    this.local = realCreateConnector(cfg);
  }

  get config(): ConnectionConfig {
    return this.local.config;
  }

  capabilities(): ConnectorCapabilities {
    return this.local.capabilities();
  }

  private fwd<T>(method: string, args: unknown[] = []): Promise<T> {
    return call<T>({ kind: "connector", method, config: this.cfg, args });
  }

  testConnection(): Promise<TestResult> {
    return this.fwd("testConnection");
  }
  getMeta(): Promise<ServerMeta> {
    return this.fwd("getMeta");
  }
  listCollections(): Promise<CollectionInfo[]> {
    return this.fwd("listCollections");
  }
  getSchema(collection: string): Promise<CollectionSchema> {
    return this.fwd("getSchema", [collection]);
  }
  getStats(collection: string): Promise<CollectionStats> {
    return this.fwd("getStats", [collection]);
  }
  createCollection(spec: CreateCollectionSpec): Promise<void> {
    return this.fwd("createCollection", [spec]);
  }
  deleteCollection(collection: string): Promise<void> {
    return this.fwd("deleteCollection", [collection]);
  }
  listRecords(collection: string, opts: PageOpts): Promise<Page<VectorRecord>> {
    return this.fwd("listRecords", [collection, opts]);
  }
  getRecord(collection: string, id: string | number): Promise<VectorRecord> {
    return this.fwd("getRecord", [collection, id]);
  }
  upsertRecords(collection: string, records: VectorRecord[]): Promise<UpsertResult> {
    return this.fwd("upsertRecords", [collection, records]);
  }
  updatePayload(collection: string, id: string | number, payload: Record<string, unknown>): Promise<void> {
    return this.fwd("updatePayload", [collection, id, payload]);
  }
  deleteRecords(collection: string, ids: (string | number)[]): Promise<void> {
    return this.fwd("deleteRecords", [collection, ids]);
  }
  vectorSearch(collection: string, query: VectorQuery): Promise<SearchResult[]> {
    return this.fwd("vectorSearch", [collection, query]);
  }
  textSearch(collection: string, query: TextQuery): Promise<SearchResult[]> {
    return this.fwd("textSearch", [collection, query]);
  }
  fetchVectors(collection: string, opts: SampleOpts): Promise<VectorSample> {
    return this.fwd("fetchVectors", [collection, opts]);
  }
}

// ─── drop-in @vyn/core replacements ──────────────────────────────────────────

export function createConnector(config: ConnectionConfig): VectorConnector {
  return new RpcConnector(config);
}

export function embedText(config: EmbeddingConfig, text: string): Promise<number[]> {
  return call<number[]>({ kind: "embed", config, text });
}
