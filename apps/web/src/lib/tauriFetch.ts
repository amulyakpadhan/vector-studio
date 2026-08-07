"use client";

interface NativeFetchResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Inside the Tauri desktop shell, replaces the global fetch with one that
 * routes absolute http(s) requests through the native http_fetch command
 * instead of the webview's own fetch — Rust has no concept of browser CORS,
 * so self-hosted/CORS-restricted vector DBs are reachable directly, with no
 * local bridge process needed. A no-op outside Tauri (plain browser/Vercel):
 * bails out immediately if the Tauri runtime isn't present, leaving the
 * normal fetch completely untouched.
 */
export function installTauriFetch(): void {
  if (typeof window === "undefined") return;
  if (!("__TAURI_INTERNALS__" in window)) return;

  const originalFetch = window.fetch.bind(window);

  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    // Only absolute http(s) URLs need the native path — relative asset
    // requests, blob:/data: URLs, etc. behave exactly as they already do.
    if (!/^https?:\/\//i.test(url)) return originalFetch(input, init);

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
