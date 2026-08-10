"use client";

import { useMemo, useState } from "react";
import type { DistanceMetric, Json, VectorConnector } from "@vyn/core";
import { useEscape } from "@/lib/useEscape";
import { checkCollectionName } from "@/lib/collectionName";

interface Props {
  connector: VectorConnector;
  onClose: () => void;
  onCreated: (name: string) => void;
}

const METRICS: DistanceMetric[] = ["cosine", "euclidean", "dot"];
const COMMON_DIMS = [384, 768, 1536, 3072];

const PINECONE_CLOUDS = ["aws", "gcp", "azure"] as const;
const PINECONE_REGIONS: Record<(typeof PINECONE_CLOUDS)[number], string[]> = {
  aws: ["us-east-1", "us-west-2", "eu-west-1"],
  gcp: ["us-central1"],
  azure: ["eastus2"],
};

/** Engines whose connector infers the vector dimension from the first insert. */
const DIMENSION_INFERRED = new Set(["weaviate", "chroma"]);

const PINECONE_EMBED_MODELS = ["multilingual-e5-large"];

const WEAVIATE_VECTORIZERS = ["none", "text2vec-openai", "text2vec-cohere", "text2vec-huggingface", "text2vec-transformers"];

interface WeaviateProperty {
  name: string;
  dataType: "text" | "int" | "number" | "boolean";
  vectorize: boolean;
}
const WEAVIATE_DATA_TYPES: WeaviateProperty["dataType"][] = ["text", "int", "number", "boolean"];

function newWeaviateProperty(): WeaviateProperty {
  return { name: "", dataType: "text", vectorize: true };
}

export function CreateCollectionModal({ connector, onClose, onCreated }: Props) {
  const caps = connector.capabilities();
  const [name, setName] = useState("");
  const [dimension, setDimension] = useState(1536);
  const [metric, setMetric] = useState<DistanceMetric>("cosine");
  const [cloud, setCloud] = useState<(typeof PINECONE_CLOUDS)[number]>("aws");
  const [region, setRegion] = useState(PINECONE_REGIONS.aws[0]!);
  const [integrated, setIntegrated] = useState(false);
  const [embedModel, setEmbedModel] = useState(PINECONE_EMBED_MODELS[0]!);
  const [embedField, setEmbedField] = useState("text");
  const [weaviateVectorizer, setWeaviateVectorizer] = useState("none");
  const [weaviateProps, setWeaviateProps] = useState<WeaviateProperty[]>([{ ...newWeaviateProperty(), name: "text" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEscape(onClose);

  const isPinecone = caps.engine === "pinecone";
  const isWeaviate = caps.engine === "weaviate";
  const useIntegrated = isPinecone && integrated;
  const useWeaviateVectorizer = isWeaviate && weaviateVectorizer !== "none";
  const dimensionInferred = DIMENSION_INFERRED.has(caps.engine) || useIntegrated;
  const nameCheck = useMemo(() => checkCollectionName(caps.engine, name), [caps.engine, name]);
  const namedWeaviateProps = weaviateProps.filter((p) => p.name.trim() !== "");
  const canCreate =
    caps.createCollection &&
    name.trim() !== "" &&
    !nameCheck.error &&
    (dimensionInferred || dimension > 0) &&
    (!useIntegrated || embedField.trim() !== "") &&
    (!useWeaviateVectorizer || namedWeaviateProps.length > 0);

  function updateWeaviateProp(i: number, patch: Partial<WeaviateProperty>) {
    setWeaviateProps((props) => props.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const options: Record<string, Json> | undefined = isPinecone
        ? {
            cloud,
            region,
            ...(useIntegrated ? { embedModel, embedField: embedField.trim() } : {}),
          }
        : isWeaviate
          ? {
              vectorizer: weaviateVectorizer,
              ...(namedWeaviateProps.length > 0
                ? {
                    properties: namedWeaviateProps.map((p) => ({
                      name: p.name.trim(),
                      dataType: p.dataType,
                      vectorize: p.vectorize,
                    })),
                  }
                : {}),
            }
          : undefined;
      await connector.createCollection({ name: nameCheck.value, dimension, metric, options });
      onCreated(nameCheck.value);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">Create collection</div>
          <button className="btn ghost sm" onClick={onClose}>
            ✕
          </button>
        </div>

        {!caps.createCollection && (
          <div className="banner err">This engine does not support creating collections from Vyn yet.</div>
        )}
        {error && <div className="banner err">{error}</div>}

        <div className="field">
          <label>Name</label>
          <input
            className="input"
            placeholder="documents"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          {name.trim() !== "" && nameCheck.error && (
            <div style={{ color: "var(--red)", fontSize: 12, marginTop: 6 }}>{nameCheck.error}</div>
          )}
          {name.trim() !== "" && !nameCheck.error && nameCheck.note && (
            <div style={{ color: "var(--text-faint)", fontSize: 12, marginTop: 6 }}>{nameCheck.note}</div>
          )}
        </div>

        {isPinecone && (
          <div className="field">
            <label style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer", marginBottom: 0 }}>
              <input
                type="checkbox"
                checked={integrated}
                onChange={(e) => setIntegrated(e.target.checked)}
                style={{ width: 15, height: 15, accentColor: "var(--accent)" }}
              />
              <span style={{ color: "var(--text)" }}>Use Pinecone integrated inference</span>
            </label>
            <div style={{ color: "var(--text-faint)", fontSize: 12, marginTop: 6 }}>
              Pinecone embeds text server-side on insert and search — no API key or client-side model needed.
            </div>
          </div>
        )}

        {isWeaviate && (
          <div className="field">
            <label>Vectorizer</label>
            <select className="select" value={weaviateVectorizer} onChange={(e) => setWeaviateVectorizer(e.target.value)}>
              {WEAVIATE_VECTORIZERS.map((v) => (
                <option key={v} value={v}>
                  {v === "none" ? "None — bring your own vectors" : v}
                </option>
              ))}
            </select>
            <div style={{ color: "var(--text-faint)", fontSize: 12, marginTop: 6 }}>
              A module configured on your Weaviate instance. Requires an API key set server-side there — not
              something Vyn sends.
            </div>
          </div>
        )}

        {useWeaviateVectorizer && (
          <div className="field">
            <label>Properties</label>
            <div style={{ display: "grid", gap: 8 }}>
              {weaviateProps.map((p, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    className="input"
                    style={{ flex: 2, fontFamily: "var(--mono)" }}
                    placeholder="field name"
                    value={p.name}
                    onChange={(e) => updateWeaviateProp(i, { name: e.target.value })}
                  />
                  <select
                    className="select"
                    style={{ flex: 1 }}
                    value={p.dataType}
                    onChange={(e) => updateWeaviateProp(i, { dataType: e.target.value as WeaviateProperty["dataType"] })}
                  >
                    {WEAVIATE_DATA_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <label
                    style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--text-dim)", flex: "none" }}
                  >
                    <input
                      type="checkbox"
                      checked={p.vectorize}
                      onChange={(e) => updateWeaviateProp(i, { vectorize: e.target.checked })}
                      style={{ width: 14, height: 14, accentColor: "var(--accent)" }}
                    />
                    vectorize
                  </label>
                  <button
                    className="btn ghost sm"
                    title="Remove field"
                    onClick={() => setWeaviateProps((props) => props.filter((_, idx) => idx !== i))}
                    disabled={weaviateProps.length === 1}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <button
              className="btn ghost sm"
              style={{ marginTop: 8 }}
              onClick={() => setWeaviateProps((props) => [...props, newWeaviateProperty()])}
            >
              + Add field
            </button>
            <div style={{ color: "var(--text-faint)", fontSize: 12, marginTop: 8 }}>
              Only fields declared here can skip vectorization — matches Weaviate's own per-property{" "}
              <code>skip_vectorization</code>. Any other field this collection later picks up (e.g. from an import)
              wasn't declared here, so Weaviate vectorizes it by default.
            </div>
          </div>
        )}

        {!useIntegrated && (
          <div className="row2">
            <div className="field">
              <label>Dimension {dimensionInferred ? "(optional)" : ""}</label>
              <input
                className="input"
                type="number"
                min={1}
                value={dimension}
                onChange={(e) => setDimension(Number(e.target.value))}
                list="common-dims"
              />
              <datalist id="common-dims">
                {COMMON_DIMS.map((d) => (
                  <option key={d} value={d} />
                ))}
              </datalist>
              {dimensionInferred && (
                <div style={{ color: "var(--text-faint)", fontSize: 12, marginTop: 6 }}>
                  {caps.engine === "weaviate" ? "Weaviate" : "Chroma"} infers the dimension from your first insert.
                </div>
              )}
            </div>
            <div className="field">
              <label>Distance metric</label>
              <select className="select" value={metric} onChange={(e) => setMetric(e.target.value as DistanceMetric)}>
                {METRICS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              {isPinecone && caps.sparseVectors && (
                <div style={{ color: "var(--text-faint)", fontSize: 12, marginTop: 6 }}>
                  Planning to use sparse or dense+sparse hybrid vectors? Pick <strong>dot</strong> — Pinecone only
                  supports sparse values on dot-product indexes.
                </div>
              )}
            </div>
          </div>
        )}

        {useIntegrated && (
          <div className="row2">
            <div className="field">
              <label>Embedding model</label>
              <select className="select" value={embedModel} onChange={(e) => setEmbedModel(e.target.value)}>
                {PINECONE_EMBED_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Embed from payload field</label>
              <input
                className="input"
                placeholder="text"
                value={embedField}
                onChange={(e) => setEmbedField(e.target.value)}
                style={{ fontFamily: "var(--mono)" }}
              />
            </div>
          </div>
        )}

        {isPinecone && (
          <div className="row2">
            <div className="field">
              <label>Cloud</label>
              <select
                className="select"
                value={cloud}
                onChange={(e) => {
                  const next = e.target.value as (typeof PINECONE_CLOUDS)[number];
                  setCloud(next);
                  setRegion(PINECONE_REGIONS[next][0]!);
                }}
              >
                {PINECONE_CLOUDS.map((c) => (
                  <option key={c} value={c}>
                    {c.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Region</label>
              <select className="select" value={region} onChange={(e) => setRegion(e.target.value)}>
                {PINECONE_REGIONS[cloud].map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={create} disabled={!canCreate || busy}>
            {busy ? <span className="spinner" /> : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
