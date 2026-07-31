import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createBridge } from "../src/server.ts";
import type { AddressInfo } from "node:net";

const STUDIO = "http://localhost:3000"; // a built-in allowed origin
const EVIL = "https://evil.example.com";

let bridge: Server;
let bridgePort: number;
let target: Server;
let targetPort: number;
const targetCalls: { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: string }[] = [];

before(async () => {
  // Stub "database" the bridge will forward to.
  target = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      targetCalls.push({
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify({ pong: true, saw: req.url }));
    });
  });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  targetPort = (target.address() as AddressInfo).port;

  bridge = createBridge({ log: () => {} });
  await new Promise<void>((r) => bridge.listen(0, "127.0.0.1", r));
  bridgePort = (bridge.address() as AddressInfo).port;
});

after(async () => {
  await new Promise<void>((r) => bridge.close(() => r()));
  await new Promise<void>((r) => target.close(() => r()));
});

const bridgeUrl = () => `http://127.0.0.1:${bridgePort}`;
const targetUrl = () => `http://127.0.0.1:${targetPort}`;

test("health check responds without an origin", async () => {
  const res = await fetch(`${bridgeUrl()}/health`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.name, "vyn-bridge");
});

test("proxies a GET to the target, forwarding custom headers", async () => {
  const proxied = `${bridgeUrl()}/proxy?target=${encodeURIComponent(`${targetUrl()}/collections`)}`;
  const res = await fetch(proxied, { headers: { Origin: STUDIO, "api-key": "secret" } });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.pong, true);
  const last = targetCalls.at(-1)!;
  assert.equal(last.path, "/collections");
  assert.equal(last.headers["api-key"], "secret");
  // hop-by-hop / origin headers must not leak upstream
  assert.equal(last.headers["origin"], undefined);
});

test("proxies a POST body through", async () => {
  const proxied = `${bridgeUrl()}/proxy?target=${encodeURIComponent(`${targetUrl()}/points/search`)}`;
  const res = await fetch(proxied, {
    method: "POST",
    headers: { Origin: STUDIO, "Content-Type": "application/json" },
    body: JSON.stringify({ vector: [1, 2, 3] }),
  });
  assert.equal(res.status, 200);
  const last = targetCalls.at(-1)!;
  assert.equal(last.method, "POST");
  assert.deepEqual(JSON.parse(last.body), { vector: [1, 2, 3] });
});

test("reflects an allowed origin in CORS headers", async () => {
  const res = await fetch(`${bridgeUrl()}/proxy?target=${encodeURIComponent(`${targetUrl()}/x`)}`, {
    headers: { Origin: STUDIO },
  });
  assert.equal(res.headers.get("access-control-allow-origin"), STUDIO);
});

test("rejects a proxy request from a disallowed origin", async () => {
  const before = targetCalls.length;
  const res = await fetch(`${bridgeUrl()}/proxy?target=${encodeURIComponent(`${targetUrl()}/x`)}`, {
    headers: { Origin: EVIL },
  });
  assert.equal(res.status, 403);
  assert.equal(targetCalls.length, before, "must not forward disallowed-origin requests");
});

test("preflight grants Private Network Access when asked", async () => {
  const res = await fetch(`${bridgeUrl()}/proxy?target=x`, {
    method: "OPTIONS",
    headers: {
      Origin: STUDIO,
      "Access-Control-Request-Private-Network": "true",
      "Access-Control-Request-Headers": "api-key",
    },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-private-network"), "true");
  assert.equal(res.headers.get("access-control-allow-headers"), "api-key");
});

test("custom allowed origins are honored", async () => {
  const extra = createBridge({ log: () => {}, allowedOrigins: [EVIL] });
  await new Promise<void>((r) => extra.listen(0, "127.0.0.1", r));
  const port = (extra.address() as AddressInfo).port;
  const res = await fetch(`http://127.0.0.1:${port}/proxy?target=${encodeURIComponent(`${targetUrl()}/x`)}`, {
    headers: { Origin: EVIL },
  });
  assert.equal(res.status, 200);
  await new Promise<void>((r) => extra.close(() => r()));
});
