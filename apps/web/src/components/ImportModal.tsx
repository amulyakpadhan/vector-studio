"use client";

import { useMemo, useState } from "react";
import {
  parseRecords,
  formatFromFilename,
  embedTexts,
  defaultModelFor,
  EMBEDDING_MODELS,
  type RecordFormat,
  type VectorConnector,
  type VectorRecord,
} from "@vyn/core";
import { resolveEmbedding, boundModelFor, useConnections, type SavedConnection } from "@/lib/store";
import { autoDimensions } from "@/lib/embed";
import { useEscape } from "@/lib/useEscape";

interface Props {
  connector: VectorConnector;
  conn?: SavedConnection;
  collection: string;
  dimension?: number;
  serverVectorizer?: string;
  onClose: () => void;
  onImported: () => void;
}

const UPLOAD_BATCH = 100;
const EMBED_BATCH = 96;
const TEXT_FIELD_HINTS = ["text", "content", "body", "chunk", "document", "passage"];
const CUSTOM_MODEL = "__custom__";

type Phase = { kind: "embedding" | "uploading"; done: number; total: number } | null;

export function ImportModal({ connector, conn, collection, dimension, serverVectorizer, onClose, onImported }: Props) {
  const bindEmbeddingModel = useConnections((s) => s.bindEmbeddingModel);
  const embedding = conn ? resolveEmbedding(conn) : undefined;
  const boundModel = conn ? boundModelFor(conn, collection) : undefined;
  const hasEmbedding = !!embedding;

  const [format, setFormat] = useState<RecordFormat>("json");
  const [fileName, setFileName] = useState("");
  const [rawText, setRawText] = useState("");
  const [records, setRecords] = useState<VectorRecord[] | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>(null);
  const [done, setDone] = useState(false);
  useEscape(onClose);

  const [generate, setGenerate] = useState(false);
  const [sourceField, setSourceField] = useState("");
  const [model, setModel] = useState(
    boundModel ?? embedding?.model ?? (embedding ? defaultModelFor(embedding.provider) : ""),
  );
  const [customModel, setCustomModel] = useState("");

  const effectiveModel = model === CUSTOM_MODEL ? customModel.trim() : model;
  const modelMismatch = !!boundModel && effectiveModel !== "" && effectiveModel !== boundModel;

  const payloadKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const r of records ?? []) for (const k of Object.keys(r.payload)) keys.add(k);
    return [...keys];
  }, [records]);

  const missingVec = useMemo(() => (records ?? []).filter((r) => !r.vector).length, [records]);
  const hasVec = (records?.length ?? 0) - missingVec;

  async function onFile(file: File) {
    setParseError(null);
    setRunError(null);
    setRecords(null);
    setDone(false);
    setGenerate(false);
    const fmt = formatFromFilename(file.name);
    setFormat(fmt);
    setFileName(file.name);
    const text = await file.text();
    setRawText(text);
    parseWith(text, fmt);
  }

  function parseWith(text: string, fmt: RecordFormat) {
    setParseError(null);
    try {
      const parsed = parseRecords(text, fmt);
      if (parsed.length === 0) throw new Error("No records found in this file.");
      setRecords(parsed);
      const keys = new Set<string>();
      for (const r of parsed) for (const k of Object.keys(r.payload)) keys.add(k);
      const guess = TEXT_FIELD_HINTS.find((h) => keys.has(h)) ?? [...keys][0] ?? "";
      setSourceField(guess);
      setGenerate(!serverVectorizer && hasEmbedding && parsed.some((r) => !r.vector) && guess !== "");
    } catch (err) {
      setRecords(null);
      setParseError(err instanceof Error ? err.message : String(err));
    }
  }

  function reparse(fmt: RecordFormat) {
    setFormat(fmt);
    if (rawText) parseWith(rawText, fmt);
  }

  async function run() {
    if (!records) return;
    setRunError(null);
    const out: VectorRecord[] = records.map((r) => ({ ...r }));

    try {
      if (generate && conn && embedding) {
        if (!effectiveModel) throw new Error("Pick a model or enter a custom one.");
        const cfg = { ...embedding, model: effectiveModel };
        const targets: { rec: VectorRecord; text: string }[] = [];
        for (const r of out) {
          if (r.vector) continue;
          const raw = r.payload[sourceField];
          const text = raw == null ? "" : typeof raw === "string" ? raw : JSON.stringify(raw);
          if (text.trim() !== "") targets.push({ rec: r, text });
        }
        if (targets.length === 0) throw new Error(`No records have text in "${sourceField}" to embed.`);

        setPhase({ kind: "embedding", done: 0, total: targets.length });
        const dims = autoDimensions(cfg, dimension);
        for (let i = 0; i < targets.length; i += EMBED_BATCH) {
          const slice = targets.slice(i, i + EMBED_BATCH);
          const vectors = await embedTexts(
            cfg,
            slice.map((t) => t.text),
            { inputType: "document", dimensions: dims, bridgeUrl: conn.bridgeUrl },
          );
          slice.forEach((t, j) => {
            t.rec.vector = vectors[j];
          });
          setPhase({ kind: "embedding", done: Math.min(i + slice.length, targets.length), total: targets.length });
        }
      }

      setPhase({ kind: "uploading", done: 0, total: out.length });
      for (let i = 0; i < out.length; i += UPLOAD_BATCH) {
        const batch = out.slice(i, i + UPLOAD_BATCH);
        await connector.upsertRecords(collection, batch);
        setPhase({ kind: "uploading", done: Math.min(i + batch.length, out.length), total: out.length });
      }
      if (generate && conn && effectiveModel) bindEmbeddingModel(conn.id, collection, effectiveModel);
      setDone(true);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
      setPhase(null);
    }
  }

  const busy = !!phase;

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal" style={{ maxWidth: 560 }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">Import into {collection}</div>
          <button className="btn ghost sm" onClick={onClose}>
            ✕
          </button>
        </div>

        {done ? (
          <>
            <div className="banner ok">✓ Imported {records?.length ?? 0} records.</div>
            <div className="modal-foot">
              <div className="spacer" />
              <button className="btn primary" onClick={onImported}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label>File (JSON array, JSONL/NDJSON, or CSV)</label>
              <input
                className="input"
                type="file"
                accept=".json,.jsonl,.ndjson,.csv"
                onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
              />
            </div>

            {fileName && (
              <div className="field">
                <label>Parsed as</label>
                <select className="select" value={format} onChange={(e) => reparse(e.target.value as RecordFormat)}>
                  <option value="json">JSON array</option>
                  <option value="jsonl">JSONL / NDJSON</option>
                  <option value="csv">CSV</option>
                </select>
                <div style={{ color: "var(--text-faint)", fontSize: 12, marginTop: 6 }}>
                  Auto-detected from <code>{fileName}</code>. Change it if that guess was wrong.
                </div>
              </div>
            )}

            {parseError && <div className="banner err">{parseError}</div>}
            {runError && <div className="banner err">{runError}</div>}

            {records && (
              <div className="banner" style={{ background: "var(--bg)" }}>
                {records.length} records · {hasVec} with vectors · {missingVec} without
              </div>
            )}

            {records && missingVec > 0 && serverVectorizer && (
              <div className="banner" style={{ background: "var(--bg)" }}>
                The {missingVec} record{missingVec === 1 ? "" : "s"} without a vector will be embedded automatically
                by <strong>{serverVectorizer}</strong> on insert — nothing to configure.
              </div>
            )}

            {records && missingVec > 0 && !serverVectorizer && (
              <div className="field">
                {hasEmbedding ? (
                  <>
                    <label style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer", marginBottom: 0 }}>
                      <input
                        type="checkbox"
                        checked={generate}
                        onChange={(e) => setGenerate(e.target.checked)}
                        style={{ width: 15, height: 15, accentColor: "var(--accent)" }}
                        disabled={busy}
                      />
                      <span style={{ color: "var(--text)" }}>
                        Generate vectors for the {missingVec} record{missingVec === 1 ? "" : "s"} without one
                      </span>
                    </label>
                    {generate && (
                      <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                        <div>
                          <label>Embed from field</label>
                          <select
                            className="select"
                            value={sourceField}
                            onChange={(e) => setSourceField(e.target.value)}
                            disabled={busy}
                          >
                            {payloadKeys.map((k) => (
                              <option key={k} value={k}>
                                {k}
                              </option>
                            ))}
                          </select>
                        </div>
                        {embedding && (
                          <div>
                            <label>Model ({embedding.provider})</label>
                            <div style={{ display: "flex", gap: 8 }}>
                              <select
                                className="select"
                                style={{ flex: 1 }}
                                value={model}
                                onChange={(e) => setModel(e.target.value)}
                                disabled={busy}
                              >
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
                                  disabled={busy}
                                />
                              )}
                            </div>
                            {modelMismatch && (
                              <div style={{ color: "var(--red)", fontSize: 12, marginTop: 6 }}>
                                ⚠ This collection was previously embedded with <strong>{boundModel}</strong>. Mixing
                                models makes similarity search meaningless unless that's what you intend.
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ color: "var(--text-faint)", fontSize: 12.5 }}>
                    {missingVec} record{missingVec === 1 ? " has" : "s have"} no vector. To generate vectors from a
                    text field, add an embedding provider to this connection. Otherwise these import without one.
                  </div>
                )}
              </div>
            )}

            {phase && (
              <div className="field">
                <label>
                  {phase.kind === "embedding" ? "Embedding" : "Uploading"}… {phase.done} / {phase.total}
                </label>
                <div style={{ height: 8, background: "var(--bg)", borderRadius: 4, overflow: "hidden" }}>
                  <div
                    style={{
                      height: "100%",
                      width: `${(phase.done / Math.max(phase.total, 1)) * 100}%`,
                      background: "var(--accent)",
                      transition: "width 120ms",
                    }}
                  />
                </div>
              </div>
            )}

            <div className="modal-foot">
              <button className="btn ghost" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button className="btn primary" onClick={run} disabled={!records || busy}>
                {busy ? <span className="spinner" /> : `Import ${records?.length ?? ""} records`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
