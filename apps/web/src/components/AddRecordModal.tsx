"use client";

import { useState } from "react";
import { embedText, defaultModelFor, EMBEDDING_MODELS, type VectorConnector, type VectorRecord } from "@vyn/core";
import { resolveEmbedding, boundModelFor, useConnections, type SavedConnection } from "@/lib/store";
import { autoDimensions } from "@/lib/embed";
import { useEscape } from "@/lib/useEscape";

interface Props {
  connector: VectorConnector;
  conn?: SavedConnection;
  collection: string;
  dimension?: number;
  serverVectorizer?: string;
  serverVectorizerField?: string;
  onClose: () => void;
  onAdded: () => void;
}

type VectorMode = "paste" | "embed";

const CUSTOM_MODEL = "__custom__";

export function AddRecordModal({
  connector,
  conn,
  collection,
  dimension,
  serverVectorizer,
  serverVectorizerField,
  onClose,
  onAdded,
}: Props) {
  const bindEmbeddingModel = useConnections((s) => s.bindEmbeddingModel);
  const embedding = conn ? resolveEmbedding(conn) : undefined;
  const boundModel = conn ? boundModelFor(conn, collection) : undefined;
  const hasEmbedding = !!embedding;

  const [id, setId] = useState("");
  const [payloadText, setPayloadText] = useState(
    serverVectorizerField ? `{\n  "${serverVectorizerField}": ""\n}` : "{\n  \n}",
  );
  const [vectorMode, setVectorMode] = useState<VectorMode>(hasEmbedding && !serverVectorizer ? "embed" : "paste");
  const [vectorText, setVectorText] = useState("");
  const [embedSource, setEmbedSource] = useState("");
  const [model, setModel] = useState(
    boundModel ?? embedding?.model ?? (embedding ? defaultModelFor(embedding.provider) : ""),
  );
  const [customModel, setCustomModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEscape(onClose);

  const effectiveModel = model === CUSTOM_MODEL ? customModel.trim() : model;
  const modelMismatch = !!boundModel && effectiveModel !== "" && effectiveModel !== boundModel;

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
      let usedModel: string | undefined;

      if (serverVectorizer) {
        // The engine embeds this on insert; nothing for us to send.
      } else if (vectorMode === "embed") {
        if (!conn || !embedding) throw new Error("Add an embedding provider on this connection first.");
        if (!embedSource.trim()) throw new Error("Enter some text to embed.");
        if (!effectiveModel) throw new Error("Pick a model or enter a custom one.");
        const cfg = { ...embedding, model: effectiveModel };
        vector = await embedText(cfg, embedSource, {
          inputType: "document",
          dimensions: autoDimensions(cfg, dimension),
          bridgeUrl: conn.bridgeUrl,
        });
        usedModel = effectiveModel;
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
      if (usedModel && conn) bindEmbeddingModel(conn.id, collection, usedModel);
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

        {serverVectorizer ? (
          <div className="field">
            <label>Vector</label>
            <div className="banner" style={{ background: "var(--bg)" }}>
              {serverVectorizerField ? (
                <>
                  Generated automatically by <strong>{serverVectorizer}</strong> from the payload's{" "}
                  <code>{serverVectorizerField}</code> field — make sure your JSON above includes it.
                </>
              ) : (
                <>
                  Generated automatically by <strong>{serverVectorizer}</strong> when this record is added — nothing
                  to supply here.
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="field">
            <label>Vector</label>
            <div className="tabs" style={{ marginBottom: 10 }}>
              <button
                type="button"
                className={`tab ${vectorMode === "embed" ? "active" : ""}`}
                onClick={() => setVectorMode("embed")}
                disabled={!hasEmbedding}
                title={hasEmbedding ? "" : "Add an embedding provider on this connection first"}
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
              <>
                <input
                  className="input"
                  placeholder={`text to embed with ${embedding?.provider ?? "…"}`}
                  value={embedSource}
                  onChange={(e) => setEmbedSource(e.target.value)}
                />
                {embedding && (
                  <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
                    <select className="select" style={{ flex: 1 }} value={model} onChange={(e) => setModel(e.target.value)}>
                      {EMBEDDING_MODELS[embedding.provider].map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.id} · {m.dim} dims
                        </option>
                      ))}
                      <option value={CUSTOM_MODEL}>Custom…</option>
                    </select>
                    {model === CUSTOM_MODEL && (
                      <input
                        className="input"
                        style={{ flex: 1 }}
                        placeholder="model id"
                        value={customModel}
                        onChange={(e) => setCustomModel(e.target.value)}
                      />
                    )}
                  </div>
                )}
                {modelMismatch && (
                  <div style={{ color: "var(--red)", fontSize: 12, marginTop: 6 }}>
                    ⚠ This collection was previously embedded with <strong>{boundModel}</strong>. Mixing models in one
                    collection makes similarity search meaningless — only change this if you know what you're doing.
                  </div>
                )}
              </>
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
        )}

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
