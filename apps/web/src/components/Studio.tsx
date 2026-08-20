"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppLink as Link } from "@/components/AppLink";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CollectionInfo, DbEngine } from "@vyn/core";
import { useConnections } from "@/lib/store";
import { useWorkbench, SIDEBAR_MIN, SIDEBAR_MAX } from "@/lib/workbenchStore";
import { connectorFor } from "@/lib/connector";
import { Brand } from "./Brand";
import { EngineBadge } from "./EngineBadge";
import { CollectionView } from "./CollectionView";
import { CreateCollectionModal } from "./CreateCollectionModal";
import { ConnectionTabs } from "./ConnectionTabs";
import { ThemeToggle } from "./ThemeToggle";

/**
 * `connectionId` is the connection this route wants open + active — the workbench itself may
 * already have other connections open from earlier navigation, tracked in useWorkbench.
 */
export function Studio({ connectionId }: { connectionId: string }) {
  const qc = useQueryClient();
  const [hydrated, setHydrated] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [collFilter, setCollFilter] = useState("");
  const [dragTab, setDragTab] = useState<string | null>(null);
  const [dragOverTab, setDragOverTab] = useState<string | null>(null);

  useEffect(() => setHydrated(true), []);

  const openConnection = useWorkbench((s) => s.openConnection);
  useEffect(() => {
    openConnection(connectionId);
  }, [connectionId, openConnection]);

  // ─── collections rail: collapse + resize ──────────────────────────────
  const sidebarCollapsed = useWorkbench((s) => s.sidebarCollapsed);
  const sidebarWidth = useWorkbench((s) => s.sidebarWidth);
  const toggleSidebar = useWorkbench((s) => s.toggleSidebar);
  const setSidebarWidth = useWorkbench((s) => s.setSidebarWidth);
  const resetSidebarWidth = useWorkbench((s) => s.resetSidebarWidth);
  const [resizing, setResizing] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  /* The store rehydrates from localStorage only on the client, so the collapsed
     state is applied after mount — otherwise the server and client would
     disagree on the first paint. */
  const collapsed = hydrated && sidebarCollapsed;

  // Ctrl/Cmd-B — the shortcut editors use for the same action.
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

  /** Drag the divider. Width is measured from the grid's own left edge so it
   *  stays correct regardless of page scroll or surrounding chrome. */
  const startResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const left = gridRef.current?.getBoundingClientRect().left ?? 0;
      setResizing(true);
      const onMove = (ev: PointerEvent) => setSidebarWidth(ev.clientX - left);
      const onUp = () => {
        setResizing(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [setSidebarWidth],
  );

  const activeConnectionId = useWorkbench((s) => s.activeConnectionId);
  const workspace = useWorkbench((s) => (activeConnectionId ? s.byConnection[activeConnectionId] : undefined));
  const openCollectionAction = useWorkbench((s) => s.openCollection);
  const closeCollectionAction = useWorkbench((s) => s.closeCollection);
  const setActiveCollectionAction = useWorkbench((s) => s.setActiveCollection);
  const renameCollectionAction = useWorkbench((s) => s.renameCollection);
  const reorderCollectionsAction = useWorkbench((s) => s.reorderCollections);

  const conn = useConnections((s) => (activeConnectionId ? s.get(activeConnectionId) : undefined));
  const connector = useMemo(() => (conn ? connectorFor(conn) : null), [conn]);

  const collections = useQuery({
    queryKey: ["collections", activeConnectionId],
    enabled: !!connector && !!activeConnectionId,
    queryFn: () => connector!.listCollections(),
  });

  const openTabs = workspace?.openCollections ?? [];
  const active = workspace?.activeCollection ?? null;

  function openCollection(name: string) {
    if (activeConnectionId) openCollectionAction(activeConnectionId, name);
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
    if (!activeConnectionId) return;
    qc.setQueryData<CollectionInfo[]>(["collections", activeConnectionId], (old) => old?.filter((c) => c.name !== name));
    collections.refetch();
  }

  /** Same immediate-update reasoning as removeCollection — swap the name in place instead
   * of waiting on a full (potentially slow) refetch, and keep the tab open under its new name. */
  function renameCollectionTab(oldName: string, newName: string) {
    if (!activeConnectionId) return;
    qc.setQueryData<CollectionInfo[]>(["collections", activeConnectionId], (old) =>
      old?.map((c) => (c.name === oldName ? { ...c, name: newName } : c)),
    );
    renameCollectionAction(activeConnectionId, oldName, newName);
    collections.refetch();
  }

  function closeTab(name: string) {
    if (activeConnectionId) closeCollectionAction(activeConnectionId, name);
  }

  function setActive(name: string) {
    if (activeConnectionId) setActiveCollectionAction(activeConnectionId, name);
  }

  function reorderTabs(dragged: string, target: string) {
    if (activeConnectionId) reorderCollectionsAction(activeConnectionId, dragged, target);
  }

  // Auto-open the first collection the first time this connection's workbench is empty.
  useEffect(() => {
    if (activeConnectionId && openTabs.length === 0 && collections.data && collections.data.length > 0) {
      openCollection(collections.data[0]!.name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collections.data, activeConnectionId]);

  if (hydrated && activeConnectionId && !conn) {
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

  if (hydrated && !activeConnectionId) {
    return (
      <div className="shell">
        <Topbar />
        <ConnectionTabs />
        <div className="empty">
          <div className="big">◇</div>
          <p>No connection open.</p>
          <Link className="btn primary" href="/studio" style={{ marginTop: 16 }}>
            ← All connections
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
        sidebarCollapsed={collapsed}
        onToggleSidebar={toggleSidebar}
      />
      <ConnectionTabs />
      <div
        ref={gridRef}
        className={`studio${collapsed ? " sidebar-collapsed" : ""}${resizing ? " resizing" : ""}`}
        style={hydrated ? ({ "--sidebar-w": `${sidebarWidth}px` } as React.CSSProperties) : undefined}
      >
        <aside className="sidebar" inert={collapsed || undefined}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 6px" }}>
            <div className="sidebar-label" style={{ padding: "8px 4px 6px" }}>
              Collections
              {collections.data && collections.data.length > 0 && (
                <span className="sidebar-count">{collections.data.length}</span>
              )}
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

        {!collapsed && (
          <div
            className="sidebar-resizer"
            onPointerDown={startResize}
            onDoubleClick={resetSidebarWidth}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize collections rail"
            aria-valuenow={sidebarWidth}
            aria-valuemin={SIDEBAR_MIN}
            aria-valuemax={SIDEBAR_MAX}
            tabIndex={0}
            title="Drag to resize · double-click to reset"
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") {
                e.preventDefault();
                setSidebarWidth(sidebarWidth - (e.shiftKey ? 40 : 10));
              } else if (e.key === "ArrowRight") {
                e.preventDefault();
                setSidebarWidth(sidebarWidth + (e.shiftKey ? 40 : 10));
              }
            }}
          />
        )}

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

          {active && connector && activeConnectionId ? (
            <CollectionView
              key={`${activeConnectionId}:${active}`}
              connector={connector}
              connectionId={activeConnectionId}
              collection={active}
              onDeleted={() => {
                closeTab(active);
                removeCollection(active);
              }}
              onRenamed={renameCollectionTab}
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
          /* Platform-neutral on purpose: choosing ⌘ vs Ctrl from `navigator`
             during render would differ between the server and client passes. */
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
      <ThemeToggle />
      <Link className="btn ghost sm" href="/studio">
        ← All connections
      </Link>
    </header>
  );
}
