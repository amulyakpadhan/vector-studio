import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface BridgeOptions {
  /** Port to listen on. Default 7391. */
  port?: number;
  /** Extra browser origins allowed to use the bridge (beyond the built-in studio origins). */
  allowedOrigins?: string[];
  /** Called with a one-line message for each notable event. Default: console.log. */
  log?: (msg: string) => void;
}

export const DEFAULT_PORT = 7391;
export const BRIDGE_NAME = "vyn-bridge";
export const BRIDGE_VERSION = "0.1.0";

/** Built-in origins that may use the bridge: local dev + the hosted studio. */
const BUILTIN_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://vector-studio-web.vercel.app",
];

/** Headers we must never forward verbatim to the upstream DB. */
const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "origin",
  "referer",
]);

export function createBridge(opts: BridgeOptions = {}): Server {
  const log = opts.log ?? ((m) => console.log(m));
  const allowed = new Set([...BUILTIN_ORIGINS, ...(opts.allowedOrigins ?? [])]);

  return createServer((req, res) => {
    handle(req, res, allowed, log).catch((err) => {
      log(`error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) res.writeHead(502);
      res.end(JSON.stringify({ error: "bridge_error", detail: String(err) }));
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  allowed: Set<string>,
  log: (m: string) => void,
): Promise<void> {
  const origin = req.headers.origin;
  const url = new URL(req.url ?? "/", "http://localhost");

  // ── CORS: only known studio origins may talk to the bridge ──────────────
  // The Origin header is set by the browser and can't be spoofed by page
  // scripts, so an allowlist here blocks other sites from using the proxy.
  const originOk = origin !== undefined && allowed.has(origin);
  if (origin && originOk) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "false");
  }

  // Preflight
  if (req.method === "OPTIONS") {
    if (!originOk) {
      res.writeHead(403);
      res.end();
      return;
    }
    const reqHeaders = req.headers["access-control-request-headers"];
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", reqHeaders ?? "*");
    res.setHeader("Access-Control-Max-Age", "600");
    // Chrome Private Network Access: a public/secure origin reaching localhost
    // must get explicit consent on the preflight.
    if (req.headers["access-control-request-private-network"] === "true") {
      res.setHeader("Access-Control-Allow-Private-Network", "true");
    }
    res.writeHead(204);
    res.end();
    return;
  }

  // ── health check (open to any origin so the studio can detect us) ───────
  if (url.pathname === "/health") {
    res.setHeader("Content-Type", "application/json");
    if (!origin) res.setHeader("Access-Control-Allow-Origin", "*");
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, name: BRIDGE_NAME, version: BRIDGE_VERSION }));
    return;
  }

  // Everything past here mutates/reads a user DB — require an allowed origin.
  if (!originOk) {
    res.writeHead(403);
    res.end(JSON.stringify({ error: "origin_not_allowed", origin: origin ?? null }));
    return;
  }

  if (url.pathname !== "/proxy") {
    res.writeHead(404);
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }

  const target = url.searchParams.get("target");
  if (!target) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "missing_target" }));
    return;
  }
  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "invalid_target" }));
    return;
  }
  if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "unsupported_protocol" }));
    return;
  }

  // ── forward the request to the target DB ────────────────────────────────
  const method = req.method ?? "GET";
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || HOP_BY_HOP.has(k.toLowerCase())) continue;
    headers[k] = Array.isArray(v) ? v.join(", ") : v;
  }

  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req);

  const upstream = await fetch(targetUrl, { method, headers, body });

  log(`${method} ${targetUrl.host}${targetUrl.pathname} → ${upstream.status}`);

  res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/octet-stream");
  res.writeHead(upstream.status);
  const buf = Buffer.from(await upstream.arrayBuffer());
  res.end(buf);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
