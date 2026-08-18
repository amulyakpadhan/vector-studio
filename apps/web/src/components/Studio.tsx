"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CollectionInfo, DbEngine } from "@vyn/core";
import { useConnections } from "@/lib/store";
import { connectorFor } from "@/lib/connector";
import { Brand } from "./Brand";
import { EngineBadge } from "./EngineBadge";
import { CollectionView } from "./CollectionView";
import { CreateCollectionModal } from "./CreateCollectionModal";

/** Remembers whether the collections rail is collapsed, across reloads. */
const SIDEBAR_KEY = "vyn.sidebarCollapsed";

export function Studio({ connectionId }: { connectionId: string }) {
  const conn = useConnections((s) => s.get(connectionId));
  const qc = useQueryClient();
  const [hydrated, setHydrated] = useState(false);
  // Open collections, tab-strip style — order is the tab order, last opened wins focus.
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [collFilter, setCollFilter] = useState("");
  const [dragTab, setDragTab] = useState<string | null>(null);
  const [dragOverTab, setDragOverTab] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => setHydrated(true), []);

  // Restore the collapsed state after mount (never during render — reading
  // localStorage on the server would desync the first paint).
  useEffect(() => {
    setSidebarCollapsed(localStorage.getItem(SIDEBAR_KEY) === "1");
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((v) => {
      const next = !v;
      localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
      return next;
    });
  }, []);

  // Ctrl/Cmd-B — the same shortcut editors use for this.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar]);

  const connector = useMemo(() => (conn ? connectorFor(conn) : null), [conn]);

  const collections = useQuery({
    queryKey: ["collections", connectionId],
    enabled: !!connector,
    queryFn: () => connector!.listCollections(),
  });

  function openCollection(name: string) {
    setOpenTabs((tabs) => (tabs.includes(name) ? tabs : [...tabs, name]));
    setActive(name);
  }

  /**
   * Drop a deleted collection from the sidebar immediately instead of waiting
   * on a full refetch — listCollections() does a per-collection stats/count
   * round-trip for every entry, so with a dozen-plus collections a plain
   * refetch() can take several seconds, during which the just-deleted one
   * would otherwise still be sitting there (stale-while-revalidate keeps
   * showing the old list until the new one resolves).
   */
  function removeCollection(name: string) {
    qc.setQueryData<CollectionInfo[]>(["collections", connectionId], (old) => old?.filter((c) => c.name !== name));
    collections.refetch();
  }

  function closeTab(name: string) {
    setOpenTabs((tabs) => {
      const idx = tabs.indexOf(name);
      const next = tabs.filter((t) => t !== name);
      if (active === name) {
        // Focus the tab that was to its right, or its new left neighbor if it was last.
        setActive(next[idx] ?? next[idx - 1] ?? null);
      }
      return next;
    });
  }

  function reorderTabs(dragged: string, target: string) {
    if (dragged === target) return;
    setOpenTabs((tabs) => {
      const from = tabs.indexOf(dragged);
      const to = tabs.indexOf(target);
      if (from === -1 || to === -1) return tabs;
      const next = [...tabs];
      next.splice(from, 1);
      next.splice(to, 0, dragged);
      return next;
    });
  }

  // Auto-open the first collection once loaded.
  useEffect(() => {
    if (openTabs.length === 0 && collections.data && collections.data.length > 0) {
      openCollection(collections.data[0]!.name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collections.data]);

  if (hydrated && !conn) {
    return (
      <div className="shell">
        <Topbar />
        <div className="empty">
          <div className="big">⚠</div>
          <p>Connection not found.</p>
          <Link className="btn primary" href="/studio" style={{ marginTop: 16 }}>
            ← Back to connections
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <Topbar
        connName={conn?.name}
        engine={conn?.engine}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={toggleSidebar}
      />
      <div className={`studio${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
        <aside className="sidebar" inert={sidebarCollapsed || undefined}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 6px" }}>
            <div className="sidebar-label" style={{ padding: "8px 4px 6px" }}>
              Collections
            </div>
            <button
              className="btn ghost sm"
              title="Create collection"
              onClick={() => setShowCreate(true)}
              disabled={!connector}
            >
              +
            </button>
          </div>

          {(collections.data?.length ?? 0) > 8 && (
            <input
              className="input"
              placeholder="Filter collections…"
              value={collFilter}
              onChange={(e) => setCollFilter(e.target.value)}
              style={{ margin: "0 4px 8px", width: "calc(100% - 8px)", fontSize: 13 }}
            />
          )}

          {collections.isLoading && (
            <div style={{ padding: 6, display: "grid", gap: 6 }}>
              {Array.from({ length: 5 }).map((_v, i) => (
                <div key={i} className="skeleton-row" style={{ height: 30, borderRadius: 8 }} />
              ))}
            </div>
          )}
          {collections.isError && (
            <div className="banner err" style={{ margin: 8 }}>
              {(collections.error as Error).message}
            </div>
          )}
          {collections.data?.length === 0 && (
            <div style={{ padding: 12, color: "var(--text-faint)", fontSize: 13 }}>No collections yet.</div>
          )}

          {collections.data
            ?.filter((c) => c.name.toLowerCase().includes(collFilter.toLowerCase()))
            .map((c: CollectionInfo) => (
              <div
                key={c.name}
                className={`nav-item ${active === c.name ? "active" : openTabs.includes(c.name) ? "open" : ""}`}
                onClick={() => openCollection(c.name)}
              >
                <span className="truncate">{c.name}</span>
                {c.count != null && <span className="count">{c.count.toLocaleString()}</span>}
              </div>
            ))}
        </aside>

        <section className="main">
          {openTabs.length > 0 && (
            <div className="doctabs">
              {openTabs.map((name) => (
                <div
                  key={name}
                  className={`doctab ${active === name ? "active" : ""} ${dragOverTab === name && dragTab !== name ? "drag-over" : ""} ${dragTab === name ? "dragging" : ""}`}
                  onClick={() => setActive(name)}
                  title={name}
                  draggable
                  onDragStart={(e) => {
                    setDragTab(name);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnter={() => {
                    if (dragTab && dragTab !== name) setDragOverTab(name);
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragTab) reorderTabs(dragTab, name);
                    setDragTab(null);
                    setDragOverTab(null);
                  }}
                  onDragEnd={() => {
                    setDragTab(null);
                    setDragOverTab(null);
                  }}
                >
                  <span className="doctab-name">{name}</span>
                  <span
                    className="doctab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(name);
                    }}
                    title="Close tab"
                  >
                    ✕
                  </span>
                </div>
              ))}
            </div>
          )}

          {active && connector ? (
            <CollectionView
              key={active}
              connector={connector}
              connectionId={connectionId}
              collection={active}
              onDeleted={() => {
                closeTab(active);
                removeCollection(active);
              }}
            />
          ) : (
            <div className="empty">
              <div className="big">◇</div>
              <p>Select a collection to browse its vectors.</p>
            </div>
          )}
        </section>
      </div>

      {showCreate && connector && (
        <CreateCollectionModal
          connector={connector}
          onClose={() => setShowCreate(false)}
          onCreated={(name) => {
            setShowCreate(false);
            collections.refetch();
            openCollection(name);
          }}
        />
      )}
    </div>
  );
}

function Topbar({
  connName,
  engine,
  sidebarCollapsed,
  onToggleSidebar,
}: {
  connName?: string;
  engine?: DbEngine;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
}) {
  return (
    <header className="topbar">
      {onToggleSidebar && (
        <button
          className="icon-btn sidebar-toggle"
          onClick={onToggleSidebar}
          aria-label={sidebarCollapsed ? "Show collections" : "Hide collections"}
          aria-expanded={!sidebarCollapsed}
          // Platform-neutral on purpose: picking ⌘ vs Ctrl from `navigator`
          // during render would differ between the server and client passes.
          title={`${sidebarCollapsed ? "Show" : "Hide"} collections (Ctrl/⌘ B)`}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
            <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" strokeWidth="1.3" />
            {!sidebarCollapsed && <rect x="2.5" y="3.5" width="2.5" height="9" rx="1" fill="currentColor" />}
          </svg>
        </button>
      )}
      <Brand />
      {connName && (
        <div className="crumbs">
          <span className="sep">/</span>
          <Link href="/studio">Connections</Link>
          <span className="sep">/</span>
          <span style={{ color: "var(--text)" }}>{connName}</span>
          {engine && <EngineBadge engine={engine} />}
        </div>
      )}
      <div className="spacer" />
      <Link className="btn ghost sm" href="/studio">
        ← All connections
      </Link>
    </header>
  );
}
