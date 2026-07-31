"use client";

import { useMemo, useState } from "react";
import type { Json, SearchResult, VectorConnector, VectorRecord } from "@vyn/core";
import { RecordDrawer } from "./RecordDrawer";

interface Props {
  connector: VectorConnector;
  collection: string;
  onChanged: () => void;
}

type Mode = "keyword" | "hybrid" | "similar" | "vector";

const MODE_LABELS: Record<Mode, string> = {
  keyword: "Keyword",
  hybrid: "Hybrid",
  similar: "Similar to record",
  vector: "Raw vector",
};

export function SearchView({ connector, collection, onChanged }: Props) {
  const caps = connector.capabilities();

  const modes = useMemo(() => {
    const list: Mode[] = [];
    if (caps.textSearch) list.push("keyword");
    if (caps.hybridSearch) list.push("hybrid");
    list.push("similar", "vector"); // available on any engine with vector search
    return list;
  }, [caps]);

  const [mode, setMode] = useState<Mode>(modes[0]!);
  const [text, setText] = useState("");
  const [recordId, setRecordId] = useState("");
  const [vectorText, setVectorText] = useState("");
  const [limit, setLimit] = useState(10);

  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspect, setInspect] = useState<VectorRecord | null>(null);

  const columns = useMemo(() => {
    const keys = new Set<string>();
    for (const r of results ?? []) for (const k of Object.keys(r.payload)) keys.add(k);
    return [...keys].slice(0, 6);
  }, [results]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      let hits: SearchResult[];
      if (mode === "keyword" || mode === "hybrid") {
        if (!text.trim()) throw new Error("Enter a search query.");
        if (!connector.textSearch) throw new Error("This engine doesn't support text search.");
        hits = await connector.textSearch(collection, { text: text.trim(), mode, limit });
      } else if (mode === "similar") {
        if (!recordId.trim()) throw new Error("Enter a record ID.");
        const rec = await connector.getRecord(collection, recordId.trim());
        if (!rec.vector || rec.vector.length === 0) {
          throw new Error("That record has no stored vector to search by.");
        }
        hits = await connector.vectorSearch(collection, { vector: rec.vector, limit });
      } else {
        const parsed = parseVector(vectorText);
        hits = await connector.vectorSearch(collection, { vector: parsed, limit });
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
        <select className="select" style={{ width: 180 }} value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
          {modes.map((m) => (
            <option key={m} value={m}>
              {MODE_LABELS[m]}
            </option>
          ))}
        </select>

        {(mode === "keyword" || mode === "hybrid") && (
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

      <div style={{ color: "var(--text-faint)", fontSize: 12.5, marginBottom: 14 }}>
        {mode === "keyword" && "Full-text BM25 search over indexed properties."}
        {mode === "hybrid" && "Blends keyword and vector relevance."}
        {mode === "similar" && "Finds the nearest neighbors of an existing record, using its stored vector."}
        {mode === "vector" && "Paste a raw query vector as a JSON array."}
        {!caps.textSearch && (mode === "similar" || mode === "vector") && (
          <> This engine needs a query vector — text search isn’t available here.</>
        )}
      </div>

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
