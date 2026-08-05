"use client";

import { useState } from "react";
import type { DistanceMetric, VectorConnector } from "@vyn/core";
import { useEscape } from "@/lib/useEscape";

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

export function CreateCollectionModal({ connector, onClose, onCreated }: Props) {
  const caps = connector.capabilities();
  const [name, setName] = useState("");
  const [dimension, setDimension] = useState(1536);
  const [metric, setMetric] = useState<DistanceMetric>("cosine");
  const [cloud, setCloud] = useState<(typeof PINECONE_CLOUDS)[number]>("aws");
  const [region, setRegion] = useState(PINECONE_REGIONS.aws[0]!);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEscape(onClose);

  const dimensionInferred = DIMENSION_INFERRED.has(caps.engine);
  const canCreate = caps.createCollection && name.trim() !== "" && (dimensionInferred || dimension > 0);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const options = caps.engine === "pinecone" ? { cloud, region } : undefined;
      await connector.createCollection({ name: name.trim(), dimension, metric, options });
      onCreated(name.trim());
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
        </div>

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
          </div>
        </div>

        {caps.engine === "pinecone" && (
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
