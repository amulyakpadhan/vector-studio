"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Json, RecordFormat, VectorConnector, VectorRecord } from "@vyn/core";
import { useConnections } from "@/lib/store";
import { exportCollection } from "@/lib/exportRecords";
import { RecordDrawer } from "./RecordDrawer";
import { ProjectionView } from "./ProjectionView";
import { SearchView } from "./SearchView";
import { FilterBar } from "./FilterBar";
import { AddRecordModal } from "./AddRecordModal";
import { ImportModal } from "./ImportModal";
import { CloneModal } from "./CloneModal";
import { RenameCollectionModal } from "./RenameCollectionModal";
import { StatsBar } from "./StatsBar";
import { toast } from "@/lib/toast";
import { confirmDialog } from "@/lib/confirm";

interface Props {
  connector: VectorConnector;
  connectionId: string;
  collection: string;
  onDeleted: () => void;
  onRenamed: (oldName: string, newName: string) => void;
}

const PAGE_SIZE = 25;

export function CollectionView({ connector, connectionId, collection, onDeleted, onRenamed }: Props) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"data" | "search" | "viz">("data");
  // Cursor stack: cursorStack[i] is the cursor that produced page i. First page = undefined.
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [inspect, setInspect] = useState<VectorRecord | null>(null);
  const [showFilter, setShowFilter] = useState(false);
  const [browseFilter, setBrowseFilter] = useState<Json | undefined>(undefined);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showClone, setShowClone] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const conn = useConnections((s) => s.get(connectionId));
  const caps = connector.capabilities();
  const cursor = cursorStack[pageIndex];

  const schema = useQuery({
    queryKey: ["schema", connectionId, collection],
    queryFn: () => connector.getSchema(collection),
  });

  const stats = useQuery({
    queryKey: ["stats", connectionId, collection],
    queryFn: () => connector.getStats(collection),
  });

  const filterKey = browseFilter ? JSON.stringify(browseFilter) : "none";
  const records = useQuery({
    queryKey: ["records", connectionId, collection, cursor ?? "start", filterKey],
    queryFn: () => connector.listRecords(collection, { limit: PAGE_SIZE, cursor, filter: browseFilter }),
  });

  // Union of payload keys across the visible page → table columns.
  const columns = useMemo(() => {
    const keys = new Set<string>();
    for (const r of records.data?.items ?? []) {
      for (const k of Object.keys(r.payload)) keys.add(k);
    }
    // Show every payload key — the table scrolls horizontally for wide rows.
    return [...keys];
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

  function applyBrowseFilter(f: Json | undefined) {
    setBrowseFilter(f);
    setCursorStack([undefined]);
    setPageIndex(0);
  }

  async function deleteCollection() {
    const ok = await confirmDialog(`Permanently delete collection "${collection}" and all its vectors?`, {
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    await connector.deleteCollection(collection);
    onDeleted();
  }

  function refresh() {
    setSelected(new Set());
    qc.invalidateQueries({ queryKey: ["records", connectionId, collection] });
    qc.invalidateQueries({ queryKey: ["schema", connectionId, collection] });
    qc.invalidateQueries({ queryKey: ["stats", connectionId, collection] });
  }

  /**
   * Open the drawer immediately with the row data we already have (payload
   * shows right away), then fetch the full record in the background to fill
   * in the vector — the browse list never requests vectors (they'd bloat
   * every page load for records nobody inspects), so `r` alone doesn't carry
   * one except on Pinecone, whose fetch-by-id API can't omit it even when
   * asked. The id check guards against a slower fetch for a previously
   * clicked row landing after the user has already moved on to another one.
   */
  function inspectRecord(r: VectorRecord) {
    setInspect(r);
    connector
      .getRecord(collection, r.id)
      .then((full) => setInspect((cur) => (cur && String(cur.id) === String(r.id) ? full : cur)))
      .catch(() => {});
  }

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    const pageIds = (records.data?.items ?? []).map((r) => String(r.id));
    setSelected((prev) => {
      const allSelected = pageIds.length > 0 && pageIds.every((id) => prev.has(id));
      const next = new Set(prev);
      if (allSelected) for (const id of pageIds) next.delete(id);
      else for (const id of pageIds) next.add(id);
      return next;
    });
  }

  async function deleteSelected() {
    const items = records.data?.items ?? [];
    const ids = items.filter((r) => selected.has(String(r.id))).map((r) => r.id);
    if (ids.length === 0) return;
    const ok = await confirmDialog(`Delete ${ids.length} selected record${ids.length === 1 ? "" : "s"}? This can't be undone.`, {
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setBulkBusy(true);
    try {
      await connector.deleteRecords(collection, ids);
      toast.success(`Deleted ${ids.length} record${ids.length === 1 ? "" : "s"}.`);
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkBusy(false);
    }
  }

  async function doExport(format: RecordFormat, withVectors: boolean) {
    setShowExportMenu(false);
    setExporting(true);
    try {
      const n = await exportCollection(connector, collection, format, withVectors);
      toast.success(`Exported ${n} record${n === 1 ? "" : "s"} as ${format.toUpperCase()}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }

  const dim = schema.data?.dimension;
  const metric = schema.data?.metric;
  const pageItems = records.data?.items ?? [];
  const pageAllChecked = pageItems.length > 0 && pageItems.every((r) => selected.has(String(r.id)));

  return (
    <div>
      <div className="section-head" style={{ marginTop: 0 }}>
        <div>
          <h1 className="page-title">{collection}</h1>
          <p className="page-sub" style={{ fontSize: 13 }}>
            Browse, search, and visualize this collection.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn sm" onClick={refresh}>
            ↻ Refresh
          </button>
          <button className="btn sm" onClick={() => setShowClone(true)} disabled={!conn}>
            ⇄ Clone
          </button>
          {caps.renameCollection && (
            <button className="btn sm" onClick={() => setShowRename(true)}>
              ✎ Rename
            </button>
          )}
          <button className="btn sm danger" onClick={deleteCollection}>
            Delete collection
          </button>
        </div>
      </div>

      <StatsBar
        engine={conn?.engine}
        count={stats.data?.count ?? records.data?.total}
        dimension={dim}
        metric={metric}
        indexedFields={schema.data?.fields.length}
        serverVectorizer={schema.data?.serverVectorizer}
        loading={schema.isLoading && stats.isLoading}
      />

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
        <ProjectionView connector={connector} collection={collection} onInspect={inspectRecord} />
      ) : tab === "search" ? (
        <SearchView
          connector={connector}
          conn={conn}
          collection={collection}
          dimension={dim}
          serverVectorizer={schema.data?.serverVectorizer}
          fields={schema.data?.fields}
          onChanged={refresh}
        />
      ) : (
        <>
      {records.isError && <div className="banner err">{(records.error as Error).message}</div>}

      <div className="toolbar" style={{ marginBottom: 12, gap: 8 }}>
        <button className="btn sm primary" onClick={() => setShowAdd(true)}>
          + Add record
        </button>
        <button className="btn sm" onClick={() => setShowImport(true)}>
          ↥ Import
        </button>
        <div style={{ position: "relative" }}>
          <button className="btn sm" onClick={() => setShowExportMenu((v) => !v)} disabled={exporting}>
            {exporting ? <span className="spinner" /> : "↧ Export ▾"}
          </button>
          {showExportMenu && (
            <div className="export-menu">
              <button className="export-item" onClick={() => doExport("json", false)}>JSON (payloads)</button>
              <button className="export-item" onClick={() => doExport("json", true)}>JSON + vectors</button>
              <button className="export-item" onClick={() => doExport("jsonl", true)}>JSONL + vectors</button>
              <button className="export-item" onClick={() => doExport("csv", false)}>CSV (payloads)</button>
            </div>
          )}
        </div>
        {caps.filterBrowse && (
          <button className={`btn sm ${browseFilter ? "primary" : ""}`} onClick={() => setShowFilter((v) => !v)}>
            ⛃ Filter{browseFilter ? " ●" : ""}
          </button>
        )}
        <div style={{ flex: 1 }} />
        {selected.size > 0 && (
          <button className="btn sm danger" onClick={deleteSelected} disabled={bulkBusy}>
            {bulkBusy ? <span className="spinner" /> : `Delete ${selected.size} selected`}
          </button>
        )}
      </div>
      {caps.filterBrowse && showFilter && (
        <FilterBar
          engine={caps.engine}
          fields={schema.data?.fields}
          onApply={applyBrowseFilter}
        />
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 34 }}>
                <input
                  type="checkbox"
                  checked={pageAllChecked}
                  onChange={toggleAll}
                  aria-label="Select all on this page"
                  style={{ width: 15, height: 15, accentColor: "var(--accent)" }}
                />
              </th>
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
                <td colSpan={columns.length + 3} style={{ padding: 24, textAlign: "center", color: "var(--text-dim)" }}>
                  <span className="spinner" /> Loading records…
                </td>
              </tr>
            )}
            {records.data?.items.map((r) => {
              const rid = String(r.id);
              const checked = selected.has(rid);
              return (
                <tr key={rid} className={checked ? "row-selected" : ""} style={{ cursor: "pointer" }}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleRow(rid)}
                      aria-label={`Select ${rid}`}
                      style={{ width: 15, height: 15, accentColor: "var(--accent)" }}
                    />
                  </td>
                  <td className="cell-id" onClick={() => inspectRecord(r)}>
                    <span className="truncate">{rid}</span>
                  </td>
                  {columns.map((c) => (
                    <td key={c} className="cell-mono" onClick={() => inspectRecord(r)}>
                      <span className="truncate">{renderCell(r.payload[c])}</span>
                    </td>
                  ))}
                  {columns.length === 0 && (
                    <td className="cell-mono" onClick={() => inspectRecord(r)}>
                      <span className="truncate">{JSON.stringify(r.payload)}</span>
                    </td>
                  )}
                </tr>
              );
            })}
            {records.data?.items.length === 0 && (
              <tr>
                <td colSpan={columns.length + 3} style={{ padding: 24, textAlign: "center", color: "var(--text-faint)" }}>
                  This collection has no records. Use “Add record” or “Import” to populate it.
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

      {showAdd && (
        <AddRecordModal
          connector={connector}
          conn={conn}
          collection={collection}
          dimension={dim}
          serverVectorizer={schema.data?.serverVectorizer}
          serverVectorizerField={schema.data?.serverVectorizerField}
          onClose={() => setShowAdd(false)}
          onAdded={() => {
            setShowAdd(false);
            toast.success("Record added.");
            refresh();
          }}
        />
      )}

      {showImport && (
        <ImportModal
          connector={connector}
          conn={conn}
          collection={collection}
          dimension={dim}
          serverVectorizer={schema.data?.serverVectorizer}
          serverVectorizerField={schema.data?.serverVectorizerField}
          onClose={() => setShowImport(false)}
          onImported={() => {
            setShowImport(false);
            toast.success("Import complete.");
            refresh();
          }}
        />
      )}

      {showClone && conn && (
        <CloneModal
          sourceConn={conn}
          sourceConnector={connector}
          collection={collection}
          onClose={() => setShowClone(false)}
        />
      )}

      {showRename && (
        <RenameCollectionModal
          connector={connector}
          collection={collection}
          onClose={() => setShowRename(false)}
          onRenamed={onRenamed}
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
