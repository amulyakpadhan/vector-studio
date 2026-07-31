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
  const [selected, setSelected] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => setHydrated(true), []);

  const connector = useMemo(() => (conn ? connectorFor(conn) : null), [conn]);

  const collections = useQuery({
    queryKey: ["collections", connectionId],
    enabled: !!connector,
    queryFn: () => connector!.listCollections(),
  });

  // Auto-select the first collection once loaded.
  useEffect(() => {
    if (selected === null && collections.data && collections.data.length > 0) {
      setSelected(collections.data[0]!.name);
    }
  }, [collections.data, selected]);

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

          {collections.isLoading && (
            <div style={{ padding: 12, color: "var(--text-dim)", display: "flex", gap: 8, alignItems: "center" }}>
              <span className="spinner" /> Loading…
            </div>
          )}
          {collections.isError && (
            <div className="banner err" style={{ margin: 8 }}>
              {(collections.error as Error).message}
            </div>
          )}
          {collections.data?.length === 0 && (
            <div style={{ padding: 12, color: "var(--text-faint)", fontSize: 13 }}>No collections.</div>
          )}

          {collections.data?.map((c: CollectionInfo) => (
            <div
              key={c.name}
              className={`nav-item ${selected === c.name ? "active" : ""}`}
              onClick={() => setSelected(c.name)}
            >
              <span className="truncate">{c.name}</span>
              {c.count != null && <span className="count">{c.count.toLocaleString()}</span>}
            </div>
          ))}
        </aside>

        <section className="main">
          {selected && connector ? (
            <CollectionView
              connector={connector}
              connectionId={connectionId}
              collection={selected}
              onDeleted={() => {
                setSelected(null);
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
            setSelected(name);
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
