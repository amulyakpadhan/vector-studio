"use client";

interface NativeFetchResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Hosts we must NEVER route through native http_fetch, even though they're
 * http(s): Tauri's own internal origins. In Tauri v2 the app is served from
 * tauri.localhost and — critically — `invoke` itself rides over an IPC fetch
 * to ipc.localhost. Routing those through http_fetch would send Tauri's own
 * IPC (and every window control, and http_fetch itself) back through invoke →
 * a deadlock that freezes the entire window, OS buttons included. asset.
 * localhost is the asset protocol. Same-origin requests are excluded too.
 */
const TAURI_INTERNAL_HOSTS = new Set(["tauri.localhost", "ipc.localhost", "asset.localhost"]);

function shouldRouteNative(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false; // relative/blob/data URLs — leave them to the real fetch
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (typeof window !== "undefined" && parsed.origin === window.location.origin) return false;
  if (TAURI_INTERNAL_HOSTS.has(parsed.hostname.toLowerCase())) return false;
  return true;
}

/**
 * Inside the Tauri desktop shell, replaces the global fetch with one that
 * routes external http(s) requests (the vector DBs) through the native
 * http_fetch command instead of the webview's own fetch — Rust has no concept
 * of browser CORS, so self-hosted/CORS-restricted DBs are reachable directly,
 * with no local bridge process needed. The app's own origin and Tauri's
 * internal IPC/asset hosts are left on the real fetch (see shouldRouteNative).
 * A no-op outside Tauri (plain browser/Vercel): bails out immediately if the
 * Tauri runtime isn't present, leaving the normal fetch completely untouched.
 */
export function installTauriFetch(): void {
  if (typeof window === "undefined") return;
  if (!("__TAURI_INTERNALS__" in window)) return;

  const originalFetch = window.fetch.bind(window);

  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    // Only genuinely external DB requests take the native path — same-origin,
    // Tauri-internal, and non-http URLs must use the real webview fetch.
    if (!shouldRouteNative(url)) return originalFetch(input, init);

    const headers: Record<string, string> = {};
    if (init?.headers) new Headers(init.headers).forEach((value, key) => (headers[key] = value));
    const body = typeof init?.body === "string" ? init.body : undefined;

    const invoked = (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const res = await invoke<NativeFetchResponse>("http_fetch", {
        req: { url, method: init?.method ?? "GET", headers, body },
      });
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
    })();

    // The Rust call can't be cancelled mid-flight, but the JS side still needs
    // to honor AbortSignal (HttpClient's own timeout relies on it rejecting).
    const signal = init?.signal;
    if (!signal) return invoked;
    if (signal.aborted) return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      invoked.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  };
}
