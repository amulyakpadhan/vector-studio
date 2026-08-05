"use client";

import { useEffect, useState } from "react";
import { createConnector, EMBEDDING_MODELS, KEYLESS_PROVIDERS, type DbEngine, type EmbeddingProvider } from "@vyn/core";
import { useConnections, resolveEmbedding, toConfig, type SavedConnection } from "@/lib/store";
import { useBridge, BRIDGE_URL } from "@/lib/bridge";
import { useEscape } from "@/lib/useEscape";

const EMBEDDING_PROVIDERS: { value: EmbeddingProvider; label: string; hint?: string }[] = [
  { value: "openai", label: "OpenAI" },
  { value: "cohere", label: "Cohere" },
  { value: "voyage", label: "Voyage AI" },
  { value: "huggingface", label: "Hugging Face", hint: "Free serverless tier (rate-limited) — needs a free HF access token." },
  { value: "ollama", label: "Ollama (local, free)", hint: "Runs on your own machine, no API key — needs a running local Ollama server." },
];

const CUSTOM_MODEL = "__custom__";

/** Engine-specific connection settings, surfaced under "Advanced". */
const ENGINE_OPTIONS: Partial<Record<DbEngine, { key: string; label: string; placeholder: string }[]>> = {
  pinecone: [{ key: "namespace", label: "Namespace", placeholder: "default (leave blank)" }],
  chroma: [
    { key: "tenant", label: "Tenant", placeholder: "default_tenant" },
    { key: "database", label: "Database", placeholder: "default_database" },
  ],
  milvus: [
    { key: "dbName", label: "Database", placeholder: "default" },
    { key: "primaryField", label: "Primary-key field", placeholder: "id" },
    { key: "vectorField", label: "Vector field", placeholder: "vector" },
  ],
};

/** Heuristic: does this URL point at the user's own machine / a private network? */
function looksLocal(url: string): boolean {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.|10\.|:\d+$/.test(url.trim());
}

/** Qdrant Cloud clusters don't send CORS headers, so the browser can't reach them directly. */
function looksQdrantCloud(engine: DbEngine, url: string): boolean {
  return engine === "qdrant" && /\.cloud\.qdrant\.io/i.test(url.trim());
}

/** Engines/URLs that usually need the bridge because of browser CORS. */
function likelyNeedsBridge(engine: DbEngine, url: string): boolean {
  return engine === "pinecone" || looksLocal(url) || looksQdrantCloud(engine, url);
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
  { value: "milvus", label: "Milvus", ready: true, placeholder: "http://localhost:19530", needsUrl: true, needsKey: false },
  { value: "chroma", label: "Chroma", ready: true, placeholder: "http://localhost:8000", needsUrl: true, needsKey: false },
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
  const [options, setOptions] = useState<Record<string, string>>(() => {
    const o: Record<string, string> = {};
    for (const [k, v] of Object.entries(existing?.options ?? {})) {
      if (k !== "bridgeUrl" && (typeof v === "string" || typeof v === "number")) o[k] = String(v);
    }
    return o;
  });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  useEscape(onClose);

  const existingEmbedding = existing ? resolveEmbedding(existing) : undefined;
  const initModel = existingEmbedding?.model;
  const initKnown = !!(
    existingEmbedding && initModel && EMBEDDING_MODELS[existingEmbedding.provider].some((m) => m.id === initModel)
  );
  const [embedProvider, setEmbedProvider] = useState<EmbeddingProvider | "">(existingEmbedding?.provider ?? "");
  const [embedApiKey, setEmbedApiKey] = useState(existingEmbedding?.apiKey ?? "");
  const [embedBaseUrl, setEmbedBaseUrl] = useState(existingEmbedding?.baseUrl ?? "");
  const embedKeyless = embedProvider !== "" && KEYLESS_PROVIDERS.includes(embedProvider);
  const [embedModel, setEmbedModel] = useState<string>(
    existingEmbedding
      ? initModel
        ? initKnown
          ? initModel
          : CUSTOM_MODEL
        : EMBEDDING_MODELS[existingEmbedding.provider][0]!.id
      : "",
  );
  const [embedCustomModel, setEmbedCustomModel] = useState(initModel && !initKnown ? initModel : "");

  const optionDefs = ENGINE_OPTIONS[engine] ?? [];
  function buildOptions(): Record<string, string> | undefined {
    const out: Record<string, string> = {};
    for (const def of optionDefs) {
      const v = options[def.key]?.trim();
      if (v) out[def.key] = v;
    }
    return Object.keys(out).length ? out : undefined;
  }

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
        toConfig({ id: "test", name, engine, url, apiKey, bridgeUrl, options: buildOptions(), createdAt: 0 }),
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
      options: buildOptions(),
      embedding:
        embedProvider && (embedKeyless || embedApiKey.trim())
          ? {
              provider: embedProvider,
              apiKey: embedApiKey.trim() || undefined,
              model: (embedModel === CUSTOM_MODEL ? embedCustomModel.trim() : embedModel) || undefined,
              baseUrl: embedKeyless ? embedBaseUrl.trim() || undefined : undefined,
            }
          : undefined,
      // Clear the legacy field once the connection is edited under the new model.
      embeddingApiKey: undefined,
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
            {looksLocal(url) || engine === "pinecone" || looksQdrantCloud(engine, url)
              ? "Recommended — self-hosted and CORS-restricted DBs need the bridge to be reachable from the browser."
              : "Only needed for self-hosted or CORS-restricted databases."}
            {bridge.status === "offline" && (
              <>
                {" "}Clone the repo and run <code style={{ color: "var(--accent-bright)" }}>pnpm bridge</code> then{" "}
                <button type="button" className="btn ghost sm" style={{ padding: "1px 6px" }} onClick={bridge.recheck}>
                  re-check
                </button>
              </>
            )}
          </div>
        </div>

        {useBridgeOn && bridge.status === "offline" && (
          <div className="banner err">The bridge isn’t running — start it with `pnpm bridge` from the repo, or this connection won’t reach the database.</div>
        )}

        <div className="field">
          <label>Embedding provider (for text search &amp; text imports) — optional</label>
          <select
            className="select"
            value={embedProvider}
            onChange={(e) => {
              const p = e.target.value as EmbeddingProvider | "";
              setEmbedProvider(p);
              setEmbedModel(p ? EMBEDDING_MODELS[p][0]!.id : "");
              setEmbedCustomModel("");
            }}
          >
            <option value="">None — search by pasting a raw vector only</option>
            {EMBEDDING_PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <div style={{ color: "var(--text-faint)", fontSize: 12, marginTop: 7 }}>
            {engine === "weaviate"
              ? "Weaviate has its own server-side vectorizer when configured — this is only needed for classes that store raw vectors instead."
              : "Lets you search by phrase and import text records — Vyn embeds client-side and the key never leaves your machine."}
          </div>
          {embedProvider && EMBEDDING_PROVIDERS.find((p) => p.value === embedProvider)?.hint && (
            <div style={{ color: "var(--text-faint)", fontSize: 12, marginTop: 4 }}>
              {EMBEDDING_PROVIDERS.find((p) => p.value === embedProvider)!.hint}
            </div>
          )}
        </div>

        {embedProvider && (
          <>
            {embedKeyless ? (
              <div className="field">
                <label>Ollama server URL (optional)</label>
                <input
                  className="input"
                  placeholder="http://localhost:11434 (default)"
                  value={embedBaseUrl}
                  onChange={(e) => setEmbedBaseUrl(e.target.value)}
                />
                {(looksLocal(embedBaseUrl) || embedBaseUrl.trim() === "") && (
                  <div style={{ color: "var(--text-faint)", fontSize: 12, marginTop: 5 }}>
                    Local server — turn on the bridge above if the studio can&apos;t reach it directly.
                  </div>
                )}
              </div>
            ) : (
              <div className="field">
                <label>{EMBEDDING_PROVIDERS.find((p) => p.value === embedProvider)!.label} API key</label>
                <input
                  className="input"
                  type="password"
                  placeholder="••••••••"
                  value={embedApiKey}
                  onChange={(e) => setEmbedApiKey(e.target.value)}
                />
              </div>
            )}
            <div className="field">
              <label>Model</label>
              <select className="select" value={embedModel} onChange={(e) => setEmbedModel(e.target.value)}>
                {EMBEDDING_MODELS[embedProvider].map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id} · {m.dim} dims{m.variableDim ? " (resizable)" : ""}
                  </option>
                ))}
                <option value={CUSTOM_MODEL}>Custom…</option>
              </select>
              {embedModel === CUSTOM_MODEL && (
                <input
                  className="input"
                  style={{ marginTop: 8 }}
                  placeholder="exact model id, e.g. text-embedding-3-large"
                  value={embedCustomModel}
                  onChange={(e) => setEmbedCustomModel(e.target.value)}
                />
              )}
            </div>
          </>
        )}

        {optionDefs.length > 0 && (
          <div className="field">
            <button
              type="button"
              className="btn ghost sm"
              style={{ padding: "2px 0" }}
              onClick={() => setShowAdvanced((v) => !v)}
            >
              {showAdvanced ? "▾" : "▸"} Advanced ({engineDef.label} settings)
            </button>
            {showAdvanced && (
              <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                {optionDefs.map((def) => (
                  <div key={def.key}>
                    <label style={{ fontSize: 12.5, color: "var(--text-dim)" }}>{def.label}</label>
                    <input
                      className="input"
                      placeholder={def.placeholder}
                      value={options[def.key] ?? ""}
                      onChange={(e) => setOptions((o) => ({ ...o, [def.key]: e.target.value }))}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
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
