"use client";

import { useState } from "react";
import type { DistanceMetric, VectorConnector } from "@vyn/core";

interface Props {
  connector: VectorConnector;
  onClose: () => void;
  onCreated: (name: string) => void;
}

const METRICS: DistanceMetric[] = ["cosine", "euclidean", "dot"];
const COMMON_DIMS = [384, 768, 1536, 3072];

export function CreateCollectionModal({ connector, onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [dimension, setDimension] = useState(1536);
  const [metric, setMetric] = useState<DistanceMetric>("cosine");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const caps = connector.capabilities();
  const canCreate = caps.createCollection && name.trim() !== "" && dimension > 0;

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await connector.createCollection({ name: name.trim(), dimension, metric });
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
            <label>Dimension</label>
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
