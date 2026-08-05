"use client";

import { useMemo, useState } from "react";
import {
  embedText,
  defaultModelFor,
  EMBEDDING_MODELS,
  type Json,
  type SearchResult,
  type VectorConnector,
  type VectorRecord,
} from "@vyn/core";
import { resolveEmbedding, boundModelFor, type SavedConnection } from "@/lib/store";
import { autoDimensions } from "@/lib/embed";
import { RecordDrawer } from "./RecordDrawer";
import { FilterBar } from "./FilterBar";

interface Props {
  connector: VectorConnector;
  conn?: SavedConnection;
  collection: string;
  dimension?: number;
  /** Name of the collection's server-side vectorizer (Weaviate), if any. */
  serverVectorizer?: string;
  onChanged: () => void;
}

type Mode = "keyword" | "hybrid" | "semantic" | "similar" | "vector";

const MODE_LABELS: Record<Mode, string> = {
  keyword: "Keyword",
  hybrid: "Hybrid",
  semantic: "Semantic (auto-embed)",
  similar: "Similar to record",
  vector: "Raw vector",
};

const CUSTOM_MODEL = "__custom__";

export function SearchView({ connector, conn, collection, dimension, serverVectorizer, onChanged }: Props) {
  const caps = connector.capabilities();
  const embedding = conn ? resolveEmbedding(conn) : undefined;
  const boundModel = conn ? boundModelFor(conn, collection) : undefined;

  // "Semantic" works on every engine (client-embed then vectorSearch, or —
  // when the collection has a server-side vectorizer — a pure-vector hybrid
  // query that needs no client embedding at all), so it's always offered.
  const modes = useMemo(() => {
    const list: Mode[] = [];
    if (caps.textSearch) list.push("keyword");
    if (caps.hybridSearch) list.push("hybrid");
    list.push("semantic", "similar", "vector");
    return list;
  }, [caps]);

  const [mode, setMode] = useState<Mode>(modes[0]!);
  const [text, setText] = useState("");
  const [recordId, setRecordId] = useState("");
  const [vectorText, setVectorText] = useState("");
  const [limit, setLimit] = useState(10);
  const [alpha, setAlpha] = useState(0.5);
  const [model, setModel] = useState(
    boundModel ?? embedding?.model ?? (embedding ? defaultModelFor(embedding.provider) : ""),
  );
  const [customModel, setCustomModel] = useState("");
  const [useVectorBlend, setUseVectorBlend] = useState(false);

  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspect, setInspect] = useState<VectorRecord | null>(null);
  const [filter, setFilter] = useState<Json | undefined>(undefined);

  const effectiveModel = model === CUSTOM_MODEL ? customModel.trim() : model;
  const modelMismatch = !!boundModel && effectiveModel !== "" && effectiveModel !== boundModel;

  // Whether this mode needs a client-side embedding call at all.
  const needsClientEmbed =
    (mode === "semantic" && !serverVectorizer) || (mode === "hybrid" && !serverVectorizer && useVectorBlend);

  const columns = useMemo(() => {
    const keys = new Set<string>();
    for (const r of results ?? []) for (const k of Object.keys(r.payload)) keys.add(k);
    return [...keys].slice(0, 6);
  }, [results]);

  async function embedQuery(): Promise<number[]> {
    if (!embedding) throw new Error("Add an embedding provider on this connection first.");
    if (!effectiveModel) throw new Error("Pick a model or enter a custom one.");
    const cfg = { ...embedding, model: effectiveModel };
    return embedText(cfg, text.trim(), {
      dimensions: autoDimensions(cfg, dimension),
      bridgeUrl: conn?.bridgeUrl,
    });
  }

  async function run() {
    setBusy(true);
    setError(null);
    try {
      let hits: SearchResult[];

      if (mode === "keyword") {
        if (!text.trim()) throw new Error("Enter a search query.");
        if (!connector.textSearch) throw new Error("This engine doesn't support text search.");
        hits = await connector.textSearch(collection, { text: text.trim(), mode: "keyword", limit, filter });
      } else if (mode === "hybrid") {
        if (!text.trim()) throw new Error("Enter a search query.");
        if (!connector.textSearch) throw new Error("This engine doesn't support text search.");
        const vector = needsClientEmbed ? await embedQuery() : undefined;
        hits = await connector.textSearch(collection, { text: text.trim(), mode: "hybrid", limit, vector, filter, alpha });
      } else if (mode === "semantic") {
        if (!text.trim()) throw new Error("Enter text to search for.");
        if (serverVectorizer) {
          // Pure-vector hybrid (alpha=1) lets the engine embed the query
          // itself — no client key, no model choice, nothing to keep in sync.
          if (!connector.textSearch) throw new Error("This engine doesn't support server-side search.");
          hits = await connector.textSearch(collection, { text: text.trim(), mode: "hybrid", limit, filter, alpha: 1 });
        } else {
          const vector = await embedQuery();
          hits = await connector.vectorSearch(collection, { vector, limit, filter });
        }
      } else if (mode === "similar") {
        if (!recordId.trim()) throw new Error("Enter a record ID.");
        const rec = await connector.getRecord(collection, recordId.trim());
        if (!rec.vector || rec.vector.length === 0) {
          throw new Error("That record has no stored vector to search by.");
        }
        hits = await connector.vectorSearch(collection, { vector: rec.vector, limit, filter });
      } else {
        const parsed = parseVector(vectorText);
        hits = await connector.vectorSearch(collection, { vector: parsed, limit, filter });
      }
      setResults(hits);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResults(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="toolbar">
        <select className="select" style={{ width: 190 }} value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
          {modes.map((m) => (
            <option key={m} value={m}>
              {MODE_LABELS[m]}
            </option>
          ))}
        </select>

        {(mode === "keyword" || mode === "hybrid" || mode === "semantic") && (
          <input
            className="input"
            style={{ flex: 1, minWidth: 220 }}
            placeholder="Search text…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
          />
        )}
        {mode === "similar" && (
          <input
            className="input"
            style={{ flex: 1, minWidth: 220 }}
            placeholder="Record ID to find neighbors of…"
            value={recordId}
            onChange={(e) => setRecordId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
          />
        )}
        {mode === "vector" && (
          <input
            className="input"
            style={{ flex: 1, minWidth: 220, fontFamily: "var(--mono)", fontSize: 12.5 }}
            placeholder="[0.12, -0.03, …]"
            value={vectorText}
            onChange={(e) => setVectorText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
          />
        )}

        <input
          className="input"
          type="number"
          min={1}
          max={100}
          value={limit}
          onChange={(e) => setLimit(Math.max(1, Math.min(100, Number(e.target.value))))}
          style={{ width: 80 }}
          title="Result limit"
        />
        <button className="btn primary" onClick={run} disabled={busy}>
          {busy ? <span className="spinner" /> : "Search"}
        </button>
      </div>

      {mode === "hybrid" && (
        <div className="field" style={{ maxWidth: 420 }}>
          <label>
            Alpha — {alpha.toFixed(2)} ({alpha === 0 ? "pure keyword" : alpha === 1 ? "pure vector" : "blend"})
          </label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={alpha}
            onChange={(e) => setAlpha(Number(e.target.value))}
            style={{ width: "100%", accentColor: "var(--accent)" }}
          />
        </div>
      )}

      {mode === "hybrid" && serverVectorizer && (
        <div className="banner" style={{ background: "var(--bg)", maxWidth: 480 }}>
          Vector side is embedded automatically by <strong>{serverVectorizer}</strong> — no key needed.
        </div>
      )}

      {mode === "semantic" && serverVectorizer && (
        <div className="banner" style={{ background: "var(--bg)", maxWidth: 480 }}>
          This collection embeds automatically with <strong>{serverVectorizer}</strong> — no key needed.
        </div>
      )}

      {mode === "hybrid" && !serverVectorizer && (
        <div className="field" style={{ maxWidth: 420 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer", marginBottom: 0 }}>
            <input
              type="checkbox"
              checked={useVectorBlend}
              onChange={(e) => setUseVectorBlend(e.target.checked)}
              style={{ width: 15, height: 15, accentColor: "var(--accent)" }}
              disabled={!embedding}
            />
            <span style={{ color: "var(--text)" }}>Blend in true vector relevance (embeds the query text)</span>
          </label>
          {!embedding && (
            <div style={{ color: "var(--text-faint)", fontSize: 12, marginTop: 6 }}>
              Without an embedding provider on this connection, hybrid runs as keyword-only.
            </div>
          )}
        </div>
      )}

      {(mode === "semantic" ? !serverVectorizer : needsClientEmbed) && (
        <div className="field" style={{ maxWidth: 420 }}>
          {embedding ? (
            <>
              <label>Model ({embedding.provider})</label>
              <div style={{ display: "flex", gap: 8 }}>
                <select className="select" style={{ flex: 1 }} value={model} onChange={(e) => setModel(e.target.value)}>
                  {EMBEDDING_MODELS[embedding.provider].map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id} · {m.dim} dims
                    </option>
                  ))}
                  <option value={CUSTOM_MODEL}>Custom…</option>
                </select>
                {model === CUSTOM_MODEL && (
                  <input
                    className="input"
                    style={{ flex: 1 }}
                    placeholder="model id"
                    value={customModel}
                    onChange={(e) => setCustomModel(e.target.value)}
                  />
                )}
              </div>
              {modelMismatch && (
                <div style={{ color: "var(--red)", fontSize: 12, marginTop: 6 }}>
                  ⚠ This collection was embedded with <strong>{boundModel}</strong>. Searching with a different model
                  will return meaningless scores unless that's what you intend.
                </div>
              )}
            </>
          ) : (
            <div className="banner err">
              Add an embedding provider on this connection to use {mode} search — edit the connection and open
              "Embedding provider" under Advanced.
            </div>
          )}
        </div>
      )}

      <div style={{ color: "var(--text-faint)", fontSize: 12.5, margin: "10px 0 14px" }}>
        {mode === "keyword" && "Full-text BM25 search over indexed properties."}
        {mode === "hybrid" && "Blends keyword and vector relevance."}
        {mode === "semantic" && "Runs a nearest-neighbor vector search — works on any engine."}
        {mode === "similar" && "Finds the nearest neighbors of an existing record, using its stored vector."}
        {mode === "vector" && "Paste a raw query vector as a JSON array."}
      </div>

      {caps.payloadFilters && (
        <div className="field">
          <label>Filter (optional)</label>
          <FilterBar engine={caps.engine} onApply={setFilter} />
        </div>
      )}

      {error && <div className="banner err">{error}</div>}

      {results && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 90 }}>Score</th>
                <th style={{ width: 140 }}>ID</th>
                {columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
                {columns.length === 0 && <th>payload</th>}
              </tr>
            </thead>
            <tbody>
              {results.length === 0 && (
                <tr>
                  <td colSpan={columns.length + 2} style={{ padding: 22, textAlign: "center", color: "var(--text-faint)" }}>
                    No matches.
                  </td>
                </tr>
              )}
              {results.map((r) => (
                <tr
                  key={String(r.id)}
                  style={{ cursor: "pointer" }}
                  onClick={() => setInspect({ id: r.id, payload: r.payload, vector: r.vector })}
                >
                  <td className="cell-mono" style={{ color: "var(--accent-bright)" }}>
                    {r.score.toFixed(4)}
                  </td>
                  <td className="cell-id">
                    <span className="truncate">{String(r.id)}</span>
                  </td>
                  {columns.map((c) => (
                    <td key={c} className="cell-mono">
                      <span className="truncate">{renderCell(r.payload[c])}</span>
                    </td>
                  ))}
                  {columns.length === 0 && (
                    <td className="cell-mono">
                      <span className="truncate">{JSON.stringify(r.payload)}</span>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {inspect && (
        <RecordDrawer
          record={inspect}
          collection={collection}
          connector={connector}
          onClose={() => setInspect(null)}
          onChanged={() => {
            setInspect(null);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function parseVector(raw: string): number[] {
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    throw new Error("Vector must be a JSON array, e.g. [0.1, 0.2, 0.3].");
  }
  if (!Array.isArray(arr) || arr.some((n) => typeof n !== "number")) {
    throw new Error("Vector must be an array of numbers.");
  }
  if (arr.length === 0) throw new Error("Vector is empty.");
  return arr as number[];
}

function renderCell(v: Json | undefined): string {
  if (v === undefined) return "";
  if (v === null) return "null";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}
