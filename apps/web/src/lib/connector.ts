"use client";

import { createConnector, type VectorConnector } from "@vyn/core";
import { toConfig, type SavedConnection } from "./store";

/**
 * Connectors are cheap, stateless wrappers around fetch — we memoize by a
 * signature of the connection so identical configs reuse one instance.
 */
const cache = new Map<string, VectorConnector>();

function signature(c: SavedConnection): string {
  return [c.id, c.engine, c.url, c.apiKey ?? "", c.bridgeUrl ?? "", JSON.stringify(c.options ?? {})].join("|");
}

export function connectorFor(c: SavedConnection): VectorConnector {
  const sig = signature(c);
  let conn = cache.get(sig);
  if (!conn) {
    conn = createConnector(toConfig(c));
    cache.set(sig, conn);
  }
  return conn;
}
