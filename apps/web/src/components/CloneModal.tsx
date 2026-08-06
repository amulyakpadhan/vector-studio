"use client";

import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { VectorConnector, VectorRecord } from "@vyn/core";
import { useConnections, type SavedConnection } from "@/lib/store";
import { connectorFor } from "@/lib/connector";
import { useEscape } from "@/lib/useEscape";
import { checkCollectionName } from "@/lib/collectionName";
import { EngineBadge } from "./EngineBadge";
import { ConnectionForm } from "./ConnectionForm";

interface Props {
  sourceConn: SavedConnection;
  sourceConnector: VectorConnector;
  collection: string;
  onClose: () => void;
}

/** Records read from the source per page. Kept well under every engine's write-batch cap. */
const READ_BATCH = 200;
/** Retries for a single read/write step before giving up on the whole clone — a batch of 200
 * records with large vectors can genuinely time out once on a slow/loaded self-hosted instance
 * without the job actually being broken; retrying that one step is far cheaper than restarting. */
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1500;

type Phase =
  | { kind: "form" }
  | { kind: "creating" }
  | { kind: "copying"; copied: number; skipped: number; retrying?: number }
  | { kind: "done"; copied: number; skipped: number }
  | { kind: "error"; message: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CREATE_NEW = "__new__";
const NEW_CONNECTION = "__new_connection__";

export function CloneModal({ sourceConn, sourceConnector, collection, onClose }: Props) {
  const connections = useConnections((s) => s.connections);
  const [destConnId, setDestConnId] = useState(sourceConn.id);
  const [destCollection, setDestCollection] = useState<string>(CREATE_NEW);
  const [newName, setNewName] = useState(`${collection}_copy`);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const [cancelled, setCancelled] = useState(false);
  const [showNewConn, setShowNewConn] = useState(false);
  const cancelRef = useRef(false);
  useEscape(onClose);

  const destConn = connections.find((c) => c.id === destConnId);
  const destConnector = useMemo(() => (destConn ? connectorFor(destConn) : null), [destConn]);
  const sameCollection = destConn?.id === sourceConn.id && destCollection === collection;
  const nameCheck = useMemo(
    () => (destConnector ? checkCollectionName(destConnector.capabilities().engine, newName) : undefined),
    [destConnector, newName],
  );

  const sourceSchema = useQuery({
    queryKey: ["clone-source-schema", sourceConn.id, collection],
    queryFn: () => sourceConnector.getSchema(collection),
  });

  const sourceStats = useQuery({
    queryKey: ["clone-source-stats", sourceConn.id, collection],
    queryFn: () => sourceConnector.getStats(collection),
  });

  const destCollections = useQuery({
    queryKey: ["clone-dest-collections", destConnId],
    enabled: !!destConnector,
    queryFn: () => destConnector!.listCollections(),
  });

  // Reset the destination-collection choice whenever the destination connection changes.
  function selectDestConn(id: string) {
    if (id === NEW_CONNECTION) {
      setShowNewConn(true);
      return;
    }
    setDestConnId(id);
    setDestCollection(CREATE_NEW);
  }

  const busy = phase.kind === "creating" || phase.kind === "copying";
  const canStart =
    !busy &&
    !!destConnector &&
    (destCollection !== CREATE_NEW ? true : newName.trim() !== "" && !nameCheck?.error) &&
    !sameCollection;

  async function start() {
    if (!destConnector) return;
    setCancelled(false);
    cancelRef.current = false;
    setPhase({ kind: "creating" });

    const schema = sourceSchema.data;
    let targetName = destCollection;

    try {
      if (destCollection === CREATE_NEW) {
        targetName = nameCheck?.value ?? newName.trim();
        await destConnector.createCollection({
          name: targetName,
          dimension: schema?.dimension ?? 0,
          metric: schema?.metric ?? "cosine",
          // Engines that don't understand this key (all but Weaviate today) just ignore it.
          options: schema?.serverVectorizer ? { vectorizer: schema.serverVectorizer } : undefined,
        });
      }
    } catch (err) {
      setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      return;
    }

    let copied = 0;
    let skipped = 0;
    let cursor: string | undefined;
    setPhase({ kind: "copying", copied, skipped });

    // One transient failure (a batch timing out on a slow/loaded self-hosted instance) shouldn't
    // sink an otherwise-succeeding multi-batch clone — retry that single step before giving up.
    async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
      for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
        try {
          return await fn();
        } catch (err) {
          if (attempt === RETRY_ATTEMPTS || cancelRef.current) throw err;
          setPhase({ kind: "copying", copied, skipped, retrying: attempt });
          await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
          setPhase({ kind: "copying", copied, skipped });
        }
      }
      throw new Error("unreachable");
    }

    try {
      do {
        if (cancelRef.current) break;
        const page = await withRetry(() =>
          sourceConnector.listRecords(collection, { limit: READ_BATCH, cursor, withVectors: true }),
        );
        const withVec = page.items.filter((r) => r.vector && r.vector.length > 0);
        skipped += page.items.length - withVec.length;
        if (withVec.length > 0) {
          await withRetry(() => destConnector.upsertRecords(targetName, withVec as VectorRecord[]));
          copied += withVec.length;
        }
        setPhase({ kind: "copying", copied, skipped });
        cursor = page.nextCursor;
      } while (cursor);

      setPhase({ kind: "done", copied, skipped });
    } catch (err) {
      setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  function requestCancel() {
    setCancelled(true);
    cancelRef.current = true;
  }

  return (
    <div className="overlay" onMouseDown={busy ? undefined : onClose}>
      <div className="modal" style={{ maxWidth: 520 }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">Clone "{collection}"</div>
          {!busy && (
            <button className="btn ghost sm" onClick={onClose}>
              ✕
            </button>
          )}
        </div>

        {phase.kind === "form" && (
          <>
            <div className="banner" style={{ background: "var(--bg)" }}>
              Copies every record's stored vector <strong>exactly as-is</strong> — nothing is re-embedded. Records
              with no stored vector (e.g. keyword-only data) are skipped.
            </div>

            <div className="field">
              <label>Destination connection</label>
              <select className="select" value={destConnId} onChange={(e) => selectDestConn(e.target.value)}>
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.engine}){c.id === sourceConn.id ? " — same connection" : ""}
                  </option>
                ))}
                <option value={NEW_CONNECTION}>+ New connection… (different DB / URL)</option>
              </select>
              {destConn && (
                <div style={{ marginTop: 8 }}>
                  <EngineBadge engine={destConn.engine} />
                </div>
              )}
            </div>

            <div className="field">
              <label>Destination collection</label>
              <select className="select" value={destCollection} onChange={(e) => setDestCollection(e.target.value)}>
                <option value={CREATE_NEW}>+ Create new collection</option>
                {destCollections.data?.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name} {c.count != null ? `(${c.count.toLocaleString()} records)` : ""}
                  </option>
                ))}
              </select>
            </div>

            {destCollection === CREATE_NEW ? (
              <div className="field">
                <label>New collection name</label>
                <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} />
                {newName.trim() !== "" && nameCheck?.error && (
                  <div style={{ color: "var(--red)", fontSize: 12, marginTop: 6 }}>{nameCheck.error}</div>
                )}
                {newName.trim() !== "" && !nameCheck?.error && nameCheck?.note && (
                  <div style={{ color: "var(--text-faint)", fontSize: 12, marginTop: 6 }}>{nameCheck.note}</div>
                )}
                <div style={{ color: "var(--text-faint)", fontSize: 12, marginTop: 6 }}>
                  Created with the source's dimension
                  {sourceSchema.data?.dimension ? ` (${sourceSchema.data.dimension})` : ""} and metric
                  {sourceSchema.data?.metric ? ` (${sourceSchema.data.metric})` : ""}
                  {sourceSchema.data?.serverVectorizer
                    ? `, and its server-side vectorizer (${sourceSchema.data.serverVectorizer})`
                    : ""}
                  .
                </div>
              </div>
            ) : (
              (() => {
                const target = destCollections.data?.find((c) => c.name === destCollection);
                const mismatch =
                  target?.dimension != null &&
                  sourceSchema.data?.dimension != null &&
                  target.dimension !== sourceSchema.data.dimension;
                return mismatch ? (
                  <div className="banner err">
                    ⚠ "{destCollection}" expects {target!.dimension} dimensions but the source has{" "}
                    {sourceSchema.data!.dimension} — the copy will fail unless these match.
                  </div>
                ) : null;
              })()
            )}

            {sameCollection && (
              <div className="banner err">Pick a different destination — that's the collection you're cloning.</div>
            )}

            <div className="modal-foot">
              <button className="btn ghost" onClick={onClose}>
                Cancel
              </button>
              <button className="btn primary" onClick={start} disabled={!canStart}>
                Start clone
              </button>
            </div>
          </>
        )}

        {phase.kind === "creating" && (
          <div style={{ padding: "24px 0", textAlign: "center" }}>
            <span className="spinner" />
            <div style={{ marginTop: 12, color: "var(--text-dim)" }}>Creating destination collection…</div>
          </div>
        )}

        {phase.kind === "copying" && (
          <div style={{ padding: "12px 0" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <span className="spinner" />
              <span style={{ color: "var(--text)" }}>
                Copied {phase.copied.toLocaleString()} record{phase.copied === 1 ? "" : "s"}
                {phase.skipped > 0 ? ` (${phase.skipped} skipped — no vector)` : ""}
                {sourceStats.data?.count ? ` of ~${sourceStats.data.count.toLocaleString()}` : ""}…
              </span>
            </div>
            {phase.retrying && (
              <div style={{ color: "var(--amber)", fontSize: 12.5, marginBottom: 10 }}>
                ⟳ That batch failed (attempt {phase.retrying}/{RETRY_ATTEMPTS}) — retrying…
              </div>
            )}
            {!!sourceStats.data?.count && (
              <div style={{ marginBottom: 14 }}>
                {(() => {
                  const total = sourceStats.data!.count;
                  const pct = Math.max(2, Math.min(100, ((phase.copied + phase.skipped) / total) * 100));
                  return (
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span
                        style={{
                          flex: 1,
                          height: 6,
                          borderRadius: 3,
                          background: "var(--border)",
                          overflow: "hidden",
                        }}
                      >
                        <span
                          style={{
                            display: "block",
                            height: "100%",
                            width: `${pct}%`,
                            background: "var(--accent)",
                            transition: "width 200ms ease",
                          }}
                        />
                      </span>
                      <span style={{ color: "var(--text-faint)", fontSize: 12, minWidth: 34, textAlign: "right" }}>
                        {Math.round(pct)}%
                      </span>
                    </div>
                  );
                })()}
              </div>
            )}
            <div className="modal-foot" style={{ marginTop: 0 }}>
              <button className="btn ghost" onClick={requestCancel} disabled={cancelled}>
                {cancelled ? "Stopping…" : "Stop"}
              </button>
            </div>
          </div>
        )}

        {phase.kind === "done" && (
          <>
            <div className="banner ok">
              ✓ Copied {phase.copied.toLocaleString()} record{phase.copied === 1 ? "" : "s"}
              {cancelled ? " (stopped early)" : ""}.
              {phase.skipped > 0 && ` ${phase.skipped} record${phase.skipped === 1 ? " was" : "s were"} skipped — no stored vector to copy.`}
            </div>
            <div className="modal-foot">
              <div className="spacer" />
              <button className="btn primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        )}

        {phase.kind === "error" && (
          <>
            <div className="banner err">{phase.message}</div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={onClose}>
                Close
              </button>
              <button className="btn primary" onClick={() => setPhase({ kind: "form" })}>
                Back
              </button>
            </div>
          </>
        )}
      </div>

      {showNewConn && (
        <ConnectionForm
          onClose={() => setShowNewConn(false)}
          onSaved={(created) => {
            setShowNewConn(false);
            setDestConnId(created.id);
            setDestCollection(CREATE_NEW);
          }}
        />
      )}
    </div>
  );
}
