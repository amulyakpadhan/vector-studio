"use client";

import { useMemo, useState } from "react";
import type { VectorConnector } from "@vyn/core";
import { useEscape } from "@/lib/useEscape";
import { checkCollectionName } from "@/lib/collectionName";
import { toast } from "@/lib/toast";

interface Props {
  connector: VectorConnector;
  collection: string;
  onClose: () => void;
  onRenamed: (oldName: string, newName: string) => void;
}

export function RenameCollectionModal({ connector, collection, onClose, onRenamed }: Props) {
  const [name, setName] = useState(collection);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEscape(onClose);

  const engine = connector.capabilities().engine;
  const nameCheck = useMemo(() => checkCollectionName(engine, name), [engine, name]);
  const unchanged = name.trim() === collection;
  const canRename = name.trim() !== "" && !nameCheck.error && !unchanged;

  async function rename() {
    if (!canRename || !connector.renameCollection) return;
    setBusy(true);
    setError(null);
    try {
      await connector.renameCollection(collection, nameCheck.value);
      toast.success(`Renamed to "${nameCheck.value}"`);
      onRenamed(collection, nameCheck.value);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal" style={{ maxWidth: 420 }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">Rename "{collection}"</div>
          <button className="btn ghost sm" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && <div className="banner err">{error}</div>}

        <div className="field">
          <label>New name</label>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && canRename && rename()}
            autoFocus
          />
          {name.trim() !== "" && nameCheck.error && (
            <div style={{ color: "var(--red)", fontSize: 12, marginTop: 6 }}>{nameCheck.error}</div>
          )}
          {name.trim() !== "" && !nameCheck.error && nameCheck.note && (
            <div style={{ color: "var(--text-faint)", fontSize: 12, marginTop: 6 }}>{nameCheck.note}</div>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={rename} disabled={!canRename || busy}>
            {busy ? <span className="spinner" /> : "Rename"}
          </button>
        </div>
      </div>
    </div>
  );
}
