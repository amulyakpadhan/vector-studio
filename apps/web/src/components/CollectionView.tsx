"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Json, VectorConnector, VectorRecord } from "@vyn/core";
import { RecordDrawer } from "./RecordDrawer";
import { ProjectionView } from "./ProjectionView";
import { SearchView } from "./SearchView";

interface Props {
  connector: VectorConnector;
  connectionId: string;
  collection: string;
  onDeleted: () => void;
}

const PAGE_SIZE = 25;

export function CollectionView({ connector, connectionId, collection, onDeleted }: Props) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"data" | "search" | "viz">("data");
  // Cursor stack: cursorStack[i] is the cursor that produced page i. First page = undefined.
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [inspect, setInspect] = useState<VectorRecord | null>(null);

  const cursor = cursorStack[pageIndex];

  const schema = useQuery({
    queryKey: ["schema", connectionId, collection],
    queryFn: () => connector.getSchema(collection),
  });

  const records = useQuery({
    queryKey: ["records", connectionId, collection, cursor ?? "start"],
    queryFn: () => connector.listRecords(collection, { limit: PAGE_SIZE, cursor }),
  });

  // Union of payload keys across the visible page → table columns.
  const columns = useMemo(() => {
    const keys = new Set<string>();
    for (const r of records.data?.items ?? []) {
      for (const k of Object.keys(r.payload)) keys.add(k);
    }
    return [...keys].slice(0, 8);
  }, [records.data]);

  function nextPage() {
    const next = records.data?.nextCursor;
    if (!next) return;
    setCursorStack((s) => {
      const copy = s.slice(0, pageIndex + 1);
      copy.push(next);
      return copy;
    });
    setPageIndex((i) => i + 1);
  }

  function prevPage() {
    if (pageIndex > 0) setPageIndex((i) => i - 1);
  }

  async function deleteCollection() {
    if (!confirm(`Permanently delete collection "${collection}" and all its vectors?`)) return;
    await connector.deleteCollection(collection);
    onDeleted();
  }

  function refresh() {
    qc.invalidateQueries({ queryKey: ["records", connectionId, collection] });
    qc.invalidateQueries({ queryKey: ["schema", connectionId, collection] });
  }

  const dim = schema.data?.dimension;
  const metric = schema.data?.metric;

  return (
    <div>
      <div className="section-head" style={{ marginTop: 0 }}>
        <div>
          <h1 className="page-title">{collection}</h1>
          <p className="page-sub" style={{ fontFamily: "var(--mono)", fontSize: 12.5 }}>
            {dim != null ? `${dim} dims` : "— dims"} · {metric ?? "—"}
            {schema.data?.fields.length ? ` · ${schema.data.fields.length} indexed fields` : ""}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn sm" onClick={refresh}>
            ↻ Refresh
          </button>
          <button className="btn sm danger" onClick={deleteCollection}>
            Delete collection
          </button>
        </div>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === "data" ? "active" : ""}`} onClick={() => setTab("data")}>
          Data
        </button>
        <button className={`tab ${tab === "search" ? "active" : ""}`} onClick={() => setTab("search")}>
          Search
        </button>
        <button className={`tab ${tab === "viz" ? "active" : ""}`} onClick={() => setTab("viz")}>
          Visualize
        </button>
      </div>

      {tab === "viz" ? (
        <ProjectionView connector={connector} collection={collection} />
      ) : tab === "search" ? (
        <SearchView connector={connector} connectionId={connectionId} collection={collection} onChanged={refresh} />
      ) : (
        <>
      {records.isError && <div className="banner err">{(records.error as Error).message}</div>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 140 }}>ID</th>
              {columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
              {columns.length === 0 && <th>payload</th>}
            </tr>
          </thead>
          <tbody>
            {records.isLoading && (
              <tr>
                <td colSpan={columns.length + 2} style={{ padding: 24, textAlign: "center", color: "var(--text-dim)" }}>
                  <span className="spinner" /> Loading records…
                </td>
              </tr>
            )}
            {records.data?.items.map((r) => (
              <tr key={String(r.id)} style={{ cursor: "pointer" }} onClick={() => setInspect(r)}>
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
            {records.data?.items.length === 0 && (
              <tr>
                <td colSpan={columns.length + 2} style={{ padding: 24, textAlign: "center", color: "var(--text-faint)" }}>
                  This collection has no records.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="toolbar" style={{ marginTop: 14, justifyContent: "flex-end" }}>
        <span style={{ color: "var(--text-dim)", fontSize: 12.5 }}>Page {pageIndex + 1}</span>
        <button className="btn sm" onClick={prevPage} disabled={pageIndex === 0 || records.isFetching}>
          ← Prev
        </button>
        <button className="btn sm" onClick={nextPage} disabled={!records.data?.nextCursor || records.isFetching}>
          Next →
        </button>
      </div>
        </>
      )}

      {inspect && (
        <RecordDrawer
          record={inspect}
          collection={collection}
          connector={connector}
          onClose={() => setInspect(null)}
          onChanged={() => {
            setInspect(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function renderCell(v: Json | undefined): string {
  if (v === undefined) return "";
  if (v === null) return "null";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}
