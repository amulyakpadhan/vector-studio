import { ConnectorError } from "./connector.ts";

export interface HttpOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Optional local-bridge prefix; when set, requests go through it to dodge CORS. */
  bridgeUrl?: string;
}

/**
 * Minimal fetch wrapper shared by all connectors.
 * Uses the global fetch (browser, Node 18+, and Tauri all provide it).
 */
export class HttpClient {
  private readonly engine: string;
  private readonly opts: HttpOptions;

  constructor(engine: string, opts: HttpOptions) {
    this.engine = engine;
    this.opts = opts;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.send<T>(method, path, {
      "Content-Type": "application/json",
      ...this.opts.headers,
    }, body === undefined ? undefined : JSON.stringify(body));
  }

  /**
   * Like `request`, but sends a pre-serialized string body with an explicit
   * content type instead of JSON-encoding an object — for APIs that expect
   * something other than `application/json` (e.g. Pinecone's NDJSON record
   * upsert endpoint).
   */
  async requestRaw<T>(method: string, path: string, rawBody: string, contentType: string): Promise<T> {
    return this.send<T>(method, path, {
      "Content-Type": contentType,
      ...this.opts.headers,
    }, rawBody);
  }

  private async send<T>(method: string, path: string, headers: Record<string, string>, body?: BodyInit): Promise<T> {
    const target = this.opts.baseUrl.replace(/\/+$/, "") + path;
    const url = this.opts.bridgeUrl
      ? `${this.opts.bridgeUrl.replace(/\/+$/, "")}/proxy?target=${encodeURIComponent(target)}`
      : target;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 30_000);

    let res: Response;
    try {
      res = await fetch(url, { method, headers, body, signal: controller.signal });
    } catch (err) {
      throw new ConnectorError(
        err instanceof DOMException && err.name === "AbortError"
          ? `Request timed out after ${this.opts.timeoutMs ?? 30_000}ms`
          : `Network error reaching ${target}: ${err instanceof Error ? err.message : String(err)}`,
        this.engine,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!res.ok) {
      const detail =
        typeof data === "object" && data !== null
          ? JSON.stringify(data).slice(0, 500)
          : String(data ?? res.statusText);
      throw new ConnectorError(`${this.engine} ${method} ${path} → ${res.status}: ${detail}`, this.engine, res.status, data);
    }

    return data as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }
  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }
  delete<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("DELETE", path, body);
  }
}
