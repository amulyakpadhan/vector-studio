"use client";

import { useState } from "react";
import { useConnections } from "@/lib/store";
import { useWorkbench } from "@/lib/workbenchStore";
import { colorForConnection } from "@/lib/connectionColor";
import { EngineBadge } from "./EngineBadge";

export function ConnectionTabs() {
  const savedConnections = useConnections((s) => s.connections);
  const openIds = useWorkbench((s) => s.openConnectionIds);
  const activeId = useWorkbench((s) => s.activeConnectionId);
  const setActive = useWorkbench((s) => s.setActiveConnection);
  const openConnection = useWorkbench((s) => s.openConnection);
  const closeConnection = useWorkbench((s) => s.closeConnection);
  const [showPicker, setShowPicker] = useState(false);

  if (openIds.length === 0) return null;

  const openConns = openIds
    .map((id) => savedConnections.find((c) => c.id === id))
    .filter((c): c is NonNullable<typeof c> => !!c);
  const closedConns = savedConnections.filter((c) => !openIds.includes(c.id));

  return (
    <div className="conn-tabs">
      <div className="conn-tabs-scroll">
        {openConns.map((c) => (
          <div key={c.id} className={`conn-tab ${c.id === activeId ? "active" : ""}`} onClick={() => setActive(c.id)}>
            <span className="conn-tab-dot" style={{ background: colorForConnection(c.id) }} />
            <span className="truncate" style={{ maxWidth: 140 }}>
              {c.name}
            </span>
            <EngineBadge engine={c.engine} />
            <button
              className="conn-tab-close"
              title="Close connection"
              onClick={(e) => {
                e.stopPropagation();
                closeConnection(c.id);
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div style={{ position: "relative", flex: "none" }}>
        <button
          className="btn ghost sm"
          title="Open another connection"
          onClick={() => setShowPicker((v) => !v)}
          disabled={closedConns.length === 0}
        >
          +
        </button>
        {showPicker && (
          <div className="export-menu">
            {closedConns.length === 0 ? (
              <div style={{ padding: "8px 12px", color: "var(--text-faint)", fontSize: 12.5 }}>
                All connections are open.
              </div>
            ) : (
              closedConns.map((c) => (
                <button
                  key={c.id}
                  className="export-item"
                  onClick={() => {
                    openConnection(c.id);
                    setShowPicker(false);
                  }}
                >
                  <span className="conn-tab-dot" style={{ background: colorForConnection(c.id), marginRight: 8 }} />
                  {c.name}
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
