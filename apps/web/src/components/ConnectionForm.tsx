"use client";

import { useEffect, useState } from "react";
import { createConnector, type DbEngine } from "@vyn/core";
import { useConnections, toConfig, type SavedConnection } from "@/lib/store";
import { useBridge, BRIDGE_URL } from "@/lib/bridge";

/** Heuristic: does this URL point at the user's own machine / a private network? */
function looksLocal(url: string): boolean {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.|10\.|:\d+$/.test(url.trim());
}

/** Engines/URLs that usually need the bridge because of browser CORS. */
function likelyNeedsBridge(engine: DbEngine, url: string): boolean {
  return engine === "pinecone" || looksLocal(url);
}

interface EngineDef {
  value: DbEngine;
  label: string;
  ready: boolean;
  placeholder: string;
  needsUrl: boolean;
  needsKey: boolean;
  urlHint?: string;
}

const ENGINES: EngineDef[] = [
  { value: "qdrant", label: "Qdrant", ready: true, placeholder: "http://localhost:6333", needsUrl: true, needsKey: false },
  {
    value: "pinecone",
    label: "Pinecone",
    ready: true,
    placeholder: "https://api.pinecone.io (default)",
    needsUrl: false,
    needsKey: true,
    urlHint: "Leave blank — Vyn discovers your indexes from the API key.",
  },
  { value: "weaviate", label: "Weaviate", ready: true, placeholder: "https://xxxx.weaviate.network", needsUrl: true, needsKey: false },
  { value: "milvus", label: "Milvus (soon)", ready: false, placeholder: "http://localhost:19530", needsUrl: true, needsKey: false },
  { value: "chroma", label: "Chroma (soon)", ready: false, placeholder: "http://localhost:8000", needsUrl: true, needsKey: false },
];

interface Props {
  existing?: SavedConnection;
  onClose: () => void;
  onSaved?: (c: SavedConnection) => void;
}

type TestState = { kind: "idle" | "testing" } | { kind: "ok"; version?: string; latencyMs?: number } | { kind: "err"; message: string };

export function ConnectionForm({ existing, onClose, onSaved }: Props) {
  const add = useConnections((s) => s.add);
  const update = useConnections((s) => s.update);

  const [name, setName] = useState(existing?.name ?? "");
  const [engine, setEngine] = useState<DbEngine>(existing?.engine ?? "qdrant");
  const [url, setUrl] = useState(existing?.url ?? "");
  const [apiKey, setApiKey] = useState(existing?.apiKey ?? "");
  const [useBridgeOn, setUseBridgeOn] = useState<boolean>(!!existing?.bridgeUrl);
  const [test, setTest] = useState<TestState>({ kind: "idle" });

  const bridge = useBridge();
  // When the bridge comes online for a new connection that likely needs it,
  // default the toggle on (once) — the user can still turn it off.
  const [autoDefaulted, setAutoDefaulted] = useState(false);
  useEffect(() => {
    if (!existing && !autoDefaulted && bridge.status === "online" && likelyNeedsBridge(engine, url)) {
      setUseBridgeOn(true);
      setAutoDefaulted(true);
    }
  }, [bridge.status, engine, url, existing, autoDefaulted]);

  const bridgeUrl = useBridgeOn ? BRIDGE_URL : undefined;
  const engineDef = ENGINES.find((e) => e.value === engine)!;
  const urlOk = engineDef.needsUrl ? url.trim() !== "" : true;
  const keyOk = engineDef.needsKey ? apiKey.trim() !== "" : true;
  const canSave = name.trim() !== "" && urlOk && keyOk && engineDef.ready;
  const canTest = urlOk && keyOk && engineDef.ready;

  async function runTest() {
    setTest({ kind: "testing" });
    try {
      const connector = createConnector(
        toConfig({ id: "test", name, engine, url, apiKey, bridgeUrl, createdAt: 0 }),
      );
      const res = await connector.testConnection();
      if (res.ok) setTest({ kind: "ok", version: res.version, latencyMs: res.latencyMs });
      else setTest({ kind: "err", message: res.error ?? "Connection failed" });
    } catch (err) {
      setTest({ kind: "err", message: err instanceof Error ? err.message : String(err) });
    }
  }

  function save() {
    // Pinecone's URL is optional; store the control-plane default so the card reads cleanly.
    const savedUrl = url.trim() || (engine === "pinecone" ? "https://api.pinecone.io" : "");
    const fields = {
      name: name.trim(),
      engine,
      url: savedUrl,
      apiKey: apiKey.trim() || undefined,
      bridgeUrl,
    };
    if (existing) {
      update(existing.id, fields);
      onSaved?.({ ...existing, ...fields });
    } else {
      const created = add(fields);
      onSaved?.(created);
    }
    onClose();
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">{existing ? "Edit connection" : "New connection"}</div>
          <button className="btn ghost sm" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="field">
          <label>Name</label>
          <input
            className="input"
            placeholder="My Qdrant cluster"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>

        <div className="field">
          <label>Engine</label>
          <select
            className="select"
            value={engine}
            onChange={(e) => {
              setEngine(e.target.value as DbEngine);
              setTest({ kind: "idle" });
            }}
          >
            {ENGINES.map((e) => (
              <option key={e.value} value={e.value} disabled={!e.ready}>
                {e.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>URL {engineDef.needsUrl ? "" : "(optional)"}</label>
          <input
            className="input"
            placeholder={engineDef.placeholder}
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setTest({ kind: "idle" });
            }}
          />
          {engineDef.urlHint && (
            <div style={{ color: "var(--text-faint)", fontSize: 12, marginTop: 5 }}>{engineDef.urlHint}</div>
          )}
        </div>

        <div className="field">
          <label>
            API key {engineDef.needsKey ? "(required)" : engine === "qdrant" ? "(optional for local)" : ""}
          </label>
          <input
            className="input"
            type="password"
            placeholder="••••••••"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setTest({ kind: "idle" });
            }}
          />
        </div>

        <div className="field">
          <label
            style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer", marginBottom: 0 }}
          >
            <input
              type="checkbox"
              checked={useBridgeOn}
              onChange={(e) => {
                setUseBridgeOn(e.target.checked);
                setTest({ kind: "idle" });
              }}
              style={{ width: 15, height: 15, accentColor: "var(--accent)" }}
            />
            <span style={{ color: "var(--text)" }}>Route through local bridge</span>
            <span className={`status ${bridge.status === "online" ? "ok" : bridge.status === "offline" ? "off" : ""}`} style={{ marginLeft: "auto" }}>
              <span className="dot" />
              {bridge.status === "online" ? "detected" : bridge.status === "checking" ? "checking…" : "not running"}
            </span>
          </label>
          <div style={{ color: "var(--text-faint)", fontSize: 12, marginTop: 7 }}>
            {looksLocal(url) || engine === "pinecone"
              ? "Recommended — self-hosted and CORS-restricted DBs need the bridge to be reachable from the browser."
              : "Only needed for self-hosted or CORS-restricted databases."}
            {bridge.status === "offline" && (
              <>
                {" "}Run <code style={{ color: "var(--accent-bright)" }}>npx @vyn/bridge</code> then{" "}
                <button type="button" className="btn ghost sm" style={{ padding: "1px 6px" }} onClick={bridge.recheck}>
                  re-check
                </button>
              </>
            )}
          </div>
        </div>

        {useBridgeOn && bridge.status === "offline" && (
          <div className="banner err">The bridge isn’t running — start it with `npx @vyn/bridge` or this connection won’t reach the database.</div>
        )}

        {test.kind === "ok" && (
          <div className="banner ok">
            ✓ Connected{test.version ? ` — v${test.version}` : ""}
            {test.latencyMs != null ? ` · ${test.latencyMs}ms` : ""}
          </div>
        )}
        {test.kind === "err" && <div className="banner err">✕ {test.message}</div>}

        <div className="modal-foot">
          <button className="btn" onClick={runTest} disabled={!canTest || test.kind === "testing"}>
            {test.kind === "testing" ? <span className="spinner" /> : "Test"}
          </button>
          <button className="btn primary" onClick={save} disabled={!canSave}>
            {existing ? "Save" : "Add connection"}
          </button>
        </div>
      </div>
    </div>
  );
}
