"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useConnections, type SavedConnection } from "@/lib/store";
import { ConnectionForm } from "./ConnectionForm";
import { EngineBadge } from "./EngineBadge";

export function Dashboard() {
  const connections = useConnections((s) => s.connections);
  const remove = useConnections((s) => s.remove);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<SavedConnection | undefined>();
  const [hydrated, setHydrated] = useState(false);

  // Zustand persist rehydrates after mount; avoid a server/client mismatch flash.
  useEffect(() => setHydrated(true), []);

  return (
    <main className="container">
      <div className="section-head">
        <div>
          <h1 className="page-title">Connections</h1>
          <p className="page-sub">Your databases live in this browser. Credentials never touch a server.</p>
        </div>
        <button className="btn primary" onClick={() => { setEditing(undefined); setShowForm(true); }}>
          + New connection
        </button>
      </div>

      {!hydrated ? null : connections.length === 0 ? (
        <div className="empty">
          <div className="big">◇</div>
          <p style={{ fontSize: 16, color: "var(--text)" }}>No connections yet</p>
          <p style={{ marginTop: 6 }}>Add a Qdrant instance to start browsing your vectors.</p>
          <button className="btn primary" style={{ marginTop: 18 }} onClick={() => setShowForm(true)}>
            + New connection
          </button>
        </div>
      ) : (
        <div className="grid">
          {connections.map((c, i) => (
            <div key={c.id} className="card link card-in" style={{ "--i": i } as React.CSSProperties}>
              <Link href={`/studio/view?id=${c.id}`}>
                <div className="card-top">
                  <div>
                    <div className="card-name">{c.name}</div>
                    <div className="card-meta">
                      {c.url}
                      {c.bridgeUrl && (
                        <span style={{ color: "var(--accent-bright)", marginLeft: 8 }}>· via bridge</span>
                      )}
                    </div>
                  </div>
                  <EngineBadge engine={c.engine} />
                </div>
              </Link>
              <div className="card-foot">
                <Link href={`/studio/view?id=${c.id}`} className="btn sm">
                  Open →
                </Link>
                <div style={{ display: "flex", gap: 4 }}>
                  <button
                    className="btn ghost sm"
                    onClick={() => { setEditing(c); setShowForm(true); }}
                  >
                    Edit
                  </button>
                  <button
                    className="btn ghost sm danger"
                    onClick={() => {
                      if (confirm(`Delete connection "${c.name}"?`)) remove(c.id);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <ConnectionForm existing={editing} onClose={() => setShowForm(false)} />
      )}
    </main>
  );
}
