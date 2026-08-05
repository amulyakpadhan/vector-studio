"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type { CollectionInfo, DbEngine } from "@vyn/core";
import { useConnections } from "@/lib/store";
import { connectorFor } from "@/lib/connector";
import { Brand } from "./Brand";
import { EngineBadge } from "./EngineBadge";
import { CollectionView } from "./CollectionView";
import { CreateCollectionModal } from "./CreateCollectionModal";

export function Studio({ connectionId }: { connectionId: string }) {
  const conn = useConnections((s) => s.get(connectionId));
  const [hydrated, setHydrated] = useState(false);
  // Open collections, tab-strip style — order is the tab order, last opened wins focus.
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [collFilter, setCollFilter] = useState("");

  useEffect(() => setHydrated(true), []);

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
      <Topbar connName={conn?.name} engine={conn?.engine} />
      <div className="studio">
        <aside className="sidebar">
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
                  className={`doctab ${active === name ? "active" : ""}`}
                  onClick={() => setActive(name)}
                  title={name}
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
                collections.refetch();
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

function Topbar({ connName, engine }: { connName?: string; engine?: DbEngine }) {
  return (
    <header className="topbar">
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
