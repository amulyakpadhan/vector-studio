"use client";

import { useState } from "react";
import type { VectorConnector, VectorRecord } from "@vyn/core";
import type { SavedConnection } from "@/lib/store";
import { embedText } from "@/lib/embeddings";
import { useEscape } from "@/lib/useEscape";

interface Props {
  connector: VectorConnector;
  conn?: SavedConnection;
  collection: string;
  dimension?: number;
  onClose: () => void;
  onAdded: () => void;
}

type VectorMode = "paste" | "embed";

export function AddRecordModal({ connector, conn, collection, dimension, onClose, onAdded }: Props) {
  const hasEmbedding = !!conn?.embeddingApiKey;
  const [id, setId] = useState("");
  const [payloadText, setPayloadText] = useState("{\n  \n}");
  const [vectorMode, setVectorMode] = useState<VectorMode>(hasEmbedding ? "embed" : "paste");
  const [vectorText, setVectorText] = useState("");
  const [embedSource, setEmbedSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEscape(onClose);

  async function add() {
    setError(null);

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(payloadText);
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw new Error("Payload must be a JSON object.");
      }
    } catch (err) {
      setError(err instanceof Error ? `Payload: ${err.message}` : "Invalid payload JSON.");
      return;
    }

    setBusy(true);
    try {
      let vector: number[] | undefined;
      if (vectorMode === "embed") {
        if (!conn?.embeddingApiKey) throw new Error("Add an OpenAI API key on this connection first.");
        if (!embedSource.trim()) throw new Error("Enter some text to embed.");
        vector = await embedText("openai", conn.embeddingApiKey, embedSource);
      } else if (vectorText.trim()) {
        const parsed = JSON.parse(vectorText) as unknown;
        if (!Array.isArray(parsed) || !parsed.every((n) => typeof n === "number")) {
          throw new Error("Vector must be a JSON array of numbers.");
        }
        vector = parsed as number[];
      }

      if (dimension != null && vector && vector.length !== dimension) {
        throw new Error(`Vector has ${vector.length} dims but this collection expects ${dimension}.`);
      }

      const record: VectorRecord = {
        id: id.trim() !== "" ? coerceId(id.trim()) : crypto.randomUUID(),
        payload: payload as VectorRecord["payload"],
        vector,
      };
      await connector.upsertRecords(collection, [record]);
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal" style={{ maxWidth: 560 }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">Add record to {collection}</div>
          <button className="btn ghost sm" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && <div className="banner err">{error}</div>}

        <div className="field">
          <label>ID (optional — a UUID is generated if blank)</label>
          <input
            className="input"
            placeholder="auto"
            value={id}
            onChange={(e) => setId(e.target.value)}
            style={{ fontFamily: "var(--mono)" }}
          />
        </div>

        <div className="field">
          <label>Payload (JSON object)</label>
          <textarea
            className="input"
            style={{ minHeight: 120, fontFamily: "var(--mono)", fontSize: 12.5, resize: "vertical" }}
            value={payloadText}
            onChange={(e) => setPayloadText(e.target.value)}
          />
        </div>

        <div className="field">
          <label>Vector</label>
          <div className="tabs" style={{ marginBottom: 10 }}>
            <button
              type="button"
              className={`tab ${vectorMode === "embed" ? "active" : ""}`}
              onClick={() => setVectorMode("embed")}
              disabled={!hasEmbedding}
              title={hasEmbedding ? "" : "Add an OpenAI API key on this connection first"}
            >
              Embed text
            </button>
            <button
              type="button"
              className={`tab ${vectorMode === "paste" ? "active" : ""}`}
              onClick={() => setVectorMode("paste")}
            >
              Paste vector
            </button>
          </div>

          {vectorMode === "embed" ? (
            <input
              className="input"
              placeholder="text to embed with OpenAI"
              value={embedSource}
              onChange={(e) => setEmbedSource(e.target.value)}
            />
          ) : (
            <textarea
              className="input"
              style={{ minHeight: 80, fontFamily: "var(--mono)", fontSize: 12.5, resize: "vertical" }}
              placeholder={dimension ? `[${Array(Math.min(dimension, 3)).fill("0.0").join(", ")}, …]` : "[0.12, -0.4, …]"}
              value={vectorText}
              onChange={(e) => setVectorText(e.target.value)}
            />
          )}
          <div style={{ color: "var(--text-faint)", fontSize: 12, marginTop: 6 }}>
            {dimension != null ? `This collection expects ${dimension} dimensions. ` : ""}
            Leave blank only if the engine assigns vectors server-side.
          </div>
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={add} disabled={busy}>
            {busy ? <span className="spinner" /> : "Add record"}
          </button>
        </div>
      </div>
    </div>
  );
}

function coerceId(s: string): string | number {
  if (!Number.isNaN(Number(s)) && String(Number(s)) === s) return Number(s);
  return s;
}
