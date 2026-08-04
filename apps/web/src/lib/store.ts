"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ConnectionConfig, DbEngine, Json } from "@vyn/core";

/**
 * A saved connection as the user sees it. This is what lives in the browser
 * (localStorage today; WebCrypto-encrypted IndexedDB is the Phase-1 upgrade).
 * Credentials NEVER leave the machine — there is no server call here.
 */
export interface SavedConnection {
  id: string;
  name: string;
  engine: DbEngine;
  url: string;
  apiKey?: string;
  /** Local bridge base URL for self-hosted DBs behind CORS (Phase 1). */
  bridgeUrl?: string;
  /** Optional OpenAI key for client-side query embedding (semantic/hybrid
   * search on collections with no server-side vectorizer). Sent only to
   * the embedding provider's API, never to any server of ours. */
  embeddingApiKey?: string;
  /** Engine-specific settings: namespace (Pinecone), tenant/database (Chroma), dbName/primaryField/vectorField (Milvus). */
  options?: Record<string, Json>;
  createdAt: number;
}

/** Turn a saved connection into the config @vyn/core expects. */
export function toConfig(c: SavedConnection): ConnectionConfig {
  const options: Record<string, Json> = { ...(c.options ?? {}) };
  if (c.bridgeUrl) options.bridgeUrl = c.bridgeUrl;
  return {
    engine: c.engine,
    url: c.url,
    apiKey: c.apiKey || undefined,
    options: Object.keys(options).length ? options : undefined,
  };
}

interface ConnectionsState {
  connections: SavedConnection[];
  add: (c: Omit<SavedConnection, "id" | "createdAt">) => SavedConnection;
  update: (id: string, patch: Partial<SavedConnection>) => void;
  remove: (id: string) => void;
  get: (id: string) => SavedConnection | undefined;
}

function newId(): string {
  return (globalThis.crypto?.randomUUID?.() ?? `c_${Date.now()}_${Math.random().toString(36).slice(2)}`);
}

export const useConnections = create<ConnectionsState>()(
  persist(
    (set, getState) => ({
      connections: [],
      add: (c) => {
        const conn: SavedConnection = { ...c, id: newId(), createdAt: Date.now() };
        set((s) => ({ connections: [conn, ...s.connections] }));
        return conn;
      },
      update: (id, patch) =>
        set((s) => ({
          connections: s.connections.map((c) => (c.id === id ? { ...c, ...patch } : c)),
        })),
      remove: (id) => set((s) => ({ connections: s.connections.filter((c) => c.id !== id) })),
      get: (id) => getState().connections.find((c) => c.id === id),
    }),
    { name: "vyn.connections.v1" },
  ),
);
