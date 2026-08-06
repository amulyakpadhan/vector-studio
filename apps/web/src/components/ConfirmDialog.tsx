"use client";

import { useConfirmState } from "@/lib/confirm";
import { useEscape } from "@/lib/useEscape";

/** Mounted once at the app root — renders whatever confirmDialog() last asked for, if anything. */
export function ConfirmDialog() {
  const request = useConfirmState((s) => s.request);
  const resolve = useConfirmState((s) => s.resolve);
  useEscape(() => request && resolve(false));

  if (!request) return null;

  return (
    <div className="overlay" onMouseDown={() => resolve(false)}>
      <div className="modal" style={{ maxWidth: 420 }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">{request.title ?? "Are you sure?"}</div>
        </div>
        <p style={{ color: "var(--text-dim)", fontSize: 13.5, lineHeight: 1.5, margin: 0 }}>{request.message}</p>
        <div className="modal-foot">
          <button className="btn ghost" onClick={() => resolve(false)}>
            Cancel
          </button>
          <button className={`btn ${request.danger ? "danger" : "primary"}`} onClick={() => resolve(true)} autoFocus>
            {request.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
