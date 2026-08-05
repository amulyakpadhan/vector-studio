"use client";

import { useEffect, useState } from "react";
import type { SavedConnection } from "@/lib/store";
import { connectorFor } from "@/lib/connector";

type Health = { kind: "checking" } | { kind: "online"; latencyMs?: number } | { kind: "offline"; error: string };

/**
 * A small status dot that pings the connection once on mount and lets the
 * user re-check on click. Kept opt-in per card (not polled on an interval)
 * so opening the dashboard doesn't hammer every saved database at once.
 */
export function ConnectionHealth({ conn }: { conn: SavedConnection }) {
  const [health, setHealth] = useState<Health>({ kind: "checking" });

  async function check() {
    setHealth({ kind: "checking" });
    try {
      const res = await connectorFor(conn).testConnection();
      if (res.ok) setHealth({ kind: "online", latencyMs: res.latencyMs });
      else setHealth({ kind: "offline", error: res.error ?? "Connection failed" });
    } catch (err) {
      setHealth({ kind: "offline", error: err instanceof Error ? err.message : String(err) });
    }
  }

  useEffect(() => {
    check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.id, conn.url, conn.apiKey, conn.bridgeUrl]);

  const label =
    health.kind === "checking"
      ? "Checking…"
      : health.kind === "online"
        ? `Online${health.latencyMs != null ? ` · ${health.latencyMs}ms` : ""} — click to re-check`
        : `Offline — ${health.error} — click to re-check`;

  const statusClass = health.kind === "online" ? "ok" : health.kind === "offline" ? "err" : "checking";

  return (
    <button
      className={`status ${statusClass} health-btn`}
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        check();
      }}
    >
      <span className="dot" />
    </button>
  );
}
