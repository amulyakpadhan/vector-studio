"use client";

import { useState } from "react";
import type { VectorConnector, VectorRecord } from "@vyn/core";
import { useEscape, copyToClipboard } from "@/lib/useEscape";
import { toast } from "@/lib/toast";

interface Props {
  record: VectorRecord;
  collection: string;
  connector: VectorConnector;
  onClose: () => void;
  onChanged: () => void;
}

export function RecordDrawer({ record, collection, connector, onClose, onChanged }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => JSON.stringify(record.payload, null, 2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vectorExpanded, setVectorExpanded] = useState(false);
  useEscape(onClose);

  async function copy(text: string, label: string) {
    if (await copyToClipboard(text)) toast.success(`${label} copied`);
    else toast.error("Copy failed");
  }

  async function save() {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(draft);
    } catch {
      setError("Payload is not valid JSON.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await connector.updatePayload(collection, record.id, parsed);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete record ${record.id}?`)) return;
    setBusy(true);
    setError(null);
    try {
      await connector.deleteRecords(collection, [record.id]);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal" style={{ maxWidth: 560 }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            Record <span className="cell-id">{String(record.id)}</span>
          </div>
          <button className="btn ghost sm" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && <div className="banner err">{error}</div>}

        <div className="toolbar" style={{ marginBottom: 12, gap: 6 }}>
          <button className="btn ghost sm" onClick={() => copy(String(record.id), "ID")}>
            ⧉ Copy ID
          </button>
          <button className="btn ghost sm" onClick={() => copy(JSON.stringify(record, null, 2), "Record JSON")}>
            ⧉ Copy JSON
          </button>
          {record.vector && (
            <button className="btn ghost sm" onClick={() => copy(JSON.stringify(record.vector), "Vector")}>
              ⧉ Copy vector
            </button>
          )}
        </div>

        <div className="field">
          <label>Payload {editing ? "(editing)" : ""}</label>
          {editing ? (
            <textarea
              className="input"
              style={{ minHeight: 220, fontFamily: "var(--mono)", fontSize: 12.5, resize: "vertical" }}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          ) : (
            <pre
              style={{
                background: "var(--bg)",
                border: "1px solid var(--border-bright)",
                borderRadius: "var(--radius)",
                padding: 12,
                fontFamily: "var(--mono)",
                fontSize: 12.5,
                maxHeight: 300,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {JSON.stringify(record.payload, null, 2)}
            </pre>
          )}
        </div>

        {record.vector && (
          <div className="field">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <label style={{ marginBottom: 0 }}>
                Vector ({record.vector.length} dims{!vectorExpanded && record.vector.length > 12 ? " — first 12" : ""})
              </label>
              {record.vector.length > 12 && (
                <button className="btn ghost sm" onClick={() => setVectorExpanded((v) => !v)}>
                  {vectorExpanded ? "Show less" : "Show full vector"}
                </button>
              )}
            </div>
            {vectorExpanded ? (
              <pre
                style={{
                  background: "var(--bg)",
                  border: "1px solid var(--border-bright)",
                  borderRadius: "var(--radius)",
                  padding: 12,
                  fontFamily: "var(--mono)",
                  fontSize: 12,
                  maxHeight: 220,
                  overflow: "auto",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  marginTop: 6,
                }}
              >
                [{record.vector.map((n) => n.toFixed(6)).join(", ")}]
              </pre>
            ) : (
              <div className="cell-mono" style={{ fontSize: 12 }}>
                [{record.vector.slice(0, 12).map((n) => n.toFixed(4)).join(", ")}
                {record.vector.length > 12 ? ", …" : ""}]
              </div>
            )}
          </div>
        )}

        <div className="modal-foot">
          <button className="btn danger" onClick={remove} disabled={busy}>
            Delete
          </button>
          <div className="spacer" />
          {editing ? (
            <>
              <button className="btn ghost" onClick={() => { setEditing(false); setDraft(JSON.stringify(record.payload, null, 2)); setError(null); }} disabled={busy}>
                Cancel
              </button>
              <button className="btn primary" onClick={save} disabled={busy}>
                {busy ? <span className="spinner" /> : "Save payload"}
              </button>
            </>
          ) : (
            <button className="btn" onClick={() => setEditing(true)}>
              Edit payload
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
