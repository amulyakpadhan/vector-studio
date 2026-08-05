"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ConnectionConfig, DbEngine, EmbeddingConfig, Json } from "@vyn/core";

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
  /**
   * How to embed text into a vector for engines with no server-side
   * vectorizer — provider, key, and (optionally) a specific model. Sent
   * only to the embedding provider's API (or the local bridge), never to
   * any server of ours.
   */
  embedding?: EmbeddingConfig;
  /**
   * @deprecated superseded by `embedding` (provider: "openai"). Kept only so
   * connections saved before multi-provider support still resolve to a
   * working config — see `resolveEmbedding`. Never written by new code.
   */
  embeddingApiKey?: string;
  /**
   * The exact model last used to embed text INTO each collection (keyed by
   * collection name, under `embedding.provider`). Search and further inserts
   * default to this automatically so a collection's vectors stay comparable
   * — mixing models within one collection silently produces meaningless
   * similarity scores.
   */
  embeddingModelByCollection?: Record<string, string>;
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

/** The connection's embedding config, migrating a legacy OpenAI-only key if that's all it has. */
export function resolveEmbedding(c: SavedConnection): EmbeddingConfig | undefined {
  if (c.embedding) return c.embedding;
  if (c.embeddingApiKey) return { provider: "openai", apiKey: c.embeddingApiKey };
  return undefined;
}

/** The model this collection was last embedded with, if any record has been written yet. */
export function boundModelFor(c: SavedConnection, collection: string): string | undefined {
  return c.embeddingModelByCollection?.[collection];
}

interface ConnectionsState {
  connections: SavedConnection[];
  add: (c: Omit<SavedConnection, "id" | "createdAt">) => SavedConnection;
  update: (id: string, patch: Partial<SavedConnection>) => void;
  remove: (id: string) => void;
  get: (id: string) => SavedConnection | undefined;
  /** Record the model used to embed into a collection, so later inserts/search default to it. */
  bindEmbeddingModel: (id: string, collection: string, model: string) => void;
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
      bindEmbeddingModel: (id, collection, model) =>
        set((s) => ({
          connections: s.connections.map((c) =>
            c.id === id
              ? { ...c, embeddingModelByCollection: { ...c.embeddingModelByCollection, [collection]: model } }
              : c,
          ),
        })),
      get: (id) => getState().connections.find((c) => c.id === id),
    }),
    { name: "vyn.connections.v1" },
  ),
);
