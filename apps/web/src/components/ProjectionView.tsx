"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Json, VectorConnector, VectorRecord, VectorSample } from "@vyn/core";
import { colorByField, type ColorResult, type FieldValue } from "@vyn/viz";
import type { ProjectionScene } from "@vyn/viz/render";

interface Props {
  connector: VectorConnector;
  collection: string;
  onInspect?: (record: VectorRecord) => void;
}

const SAMPLE_LIMIT = 1500;
const NEIGHBORS = 15;

type Phase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "projecting"; progress: number }
  | { kind: "ready" }
  | { kind: "error"; message: string }
  | { kind: "unsupported" };

interface HoverInfo {
  id: string | number;
  payload: Record<string, Json>;
}

export function ProjectionView({ connector, collection, onInspect }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<ProjectionScene | null>(null);
  const sampleRef = useRef<VectorSample | null>(null);
  const positionsRef = useRef<number[][]>([]);
  // Ref so the click handler (bound once, inside the load effect below) always
  // sees the latest callback without needing to recreate the WebGL scene.
  const onInspectRef = useRef(onInspect);
  onInspectRef.current = onInspect;

  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [colorField, setColorField] = useState<string>("");
  const [legend, setLegend] = useState<ColorResult["legend"]>([]);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [queryOf, setQueryOf] = useState<string | number | null>(null);

  const caps = connector.capabilities();

  // Fields available for color-by, derived from the sampled payloads.
  const fields = useMemo(() => {
    const keys = new Set<string>();
    for (const p of sampleRef.current?.payloads ?? []) for (const k of Object.keys(p)) keys.add(k);
    return [...keys].sort();
  }, [phase.kind === "ready"]); // recompute once data is ready

  const recolor = useCallback((field: string) => {
    const sample = sampleRef.current;
    const scene = sceneRef.current;
    if (!sample || !scene) return;
    const values: FieldValue[] = field
      ? sample.payloads.map((p) => p[field] as FieldValue)
      : [];
    const result = colorByField(values, sample.ids.length);
    scene.setColors(result.colors);
    setLegend(result.legend);
  }, []);

  const runQuery = useCallback(
    async (pointIndex: number | null) => {
      const sample = sampleRef.current;
      const scene = sceneRef.current;
      if (!sample || !scene || pointIndex === null) return;
      const vector = sample.vectors[pointIndex];
      const id = sample.ids[pointIndex];
      if (!vector || id === undefined) return;
      try {
        const hits = await connector.vectorSearch(collection, { vector, limit: NEIGHBORS });
        scene.setHighlights(hits.map((h) => h.id));
        setQueryOf(id);
      } catch {
        // search may be unsupported on some engines/configs; ignore silently
      }
    },
    [connector, collection],
  );

  // Load + project once per (connection, collection).
  useEffect(() => {
    let cancelled = false;
    let scene: ProjectionScene | null = null;

    async function go() {
      if (!caps.exportVectors) {
        setPhase({ kind: "unsupported" });
        return;
      }
      setPhase({ kind: "loading" });
      setHover(null);
      setQueryOf(null);
      setLegend([]);

      let sample: VectorSample;
      try {
        sample = await connector.fetchVectors(collection, { limit: SAMPLE_LIMIT });
      } catch (err) {
        if (!cancelled) setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
        return;
      }
      if (cancelled) return;
      sampleRef.current = sample;

      if (sample.vectors.length === 0) {
        setPhase({
          kind: "error",
          message: "No stored vectors found in this collection — it may be keyword-only data with no embeddings attached.",
        });
        return;
      }

      const { projectVectors } = await import("@vyn/viz");
      setPhase({ kind: "projecting", progress: 0 });
      const result = await projectVectors(sample.vectors, { dims: 3 }, (p) => {
        if (!cancelled) setPhase({ kind: "projecting", progress: p });
      });
      if (cancelled) return;
      positionsRef.current = result.positions;

      const { ProjectionScene } = await import("@vyn/viz/render");
      const canvas = canvasRef.current;
      if (!canvas || cancelled) return;

      const initial = colorByField([], sample.ids.length);
      scene = new ProjectionScene(canvas, {
        onHover: (idx) => {
          if (idx === null) setHover(null);
          else setHover({ id: sample.ids[idx]!, payload: sample.payloads[idx] ?? {} });
        },
        onClick: (idx) => {
          void runQuery(idx);
          if (idx !== null && onInspectRef.current) {
            const id = sample.ids[idx];
            const vector = sample.vectors[idx];
            if (id !== undefined) onInspectRef.current({ id, vector, payload: sample.payloads[idx] ?? {} });
          }
        },
      });
      scene.setData({ positions: result.positions, colors: initial.colors, ids: sample.ids });
      sceneRef.current = scene;
      setPhase({ kind: "ready" });
    }

    void go();
    return () => {
      cancelled = true;
      scene?.dispose();
      sceneRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connector, collection]);

  function clearQuery() {
    sceneRef.current?.clearHighlights();
    setQueryOf(null);
  }

  const busy = phase.kind === "loading" || phase.kind === "projecting";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label style={{ color: "var(--text-dim)", fontSize: 13 }}>Color by</label>
          <select
            className="select"
            style={{ width: 200 }}
            value={colorField}
            disabled={phase.kind !== "ready"}
            onChange={(e) => {
              setColorField(e.target.value);
              recolor(e.target.value);
            }}
          >
            <option value="">— none —</option>
            {fields.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
        <div className="spacer" style={{ flex: 1 }} />
        {sampleRef.current && phase.kind === "ready" && (
          <span style={{ color: "var(--text-faint)", fontSize: 12.5, fontFamily: "var(--mono)" }}>
            {sampleRef.current.ids.length.toLocaleString()} points
          </span>
        )}
        {queryOf !== null && (
          <button className="btn sm" onClick={clearQuery}>
            Clear neighbors
          </button>
        )}
      </div>

      {caps.exportVectors && phase.kind === "ready" && (
        <div style={{ color: "var(--text-faint)", fontSize: 12.5 }}>
          Tip: click any point to open its full record{caps.textSearch === false ? ` and light up its ${NEIGHBORS} nearest neighbors (coral)` : ""}.
        </div>
      )}

      <div
        style={{
          position: "relative",
          height: "62vh",
          minHeight: 420,
          borderRadius: 14,
          overflow: "hidden",
          border: "1px solid var(--border)",
          background: "radial-gradient(circle at 50% 40%, #0c141c 0%, #070a0e 70%)",
          boxShadow: "0 20px 50px -28px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.02) inset",
        }}
      >
        <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />

        {busy && (
          <div style={overlayStyle}>
            <span className="spinner" />
            <div style={{ marginTop: 12, color: "var(--text-dim)" }}>
              {phase.kind === "loading" && "Fetching vectors…"}
              {phase.kind === "projecting" && `Projecting… ${Math.round(phase.progress * 100)}%`}
            </div>
          </div>
        )}
        {phase.kind === "error" && (
          <div style={overlayStyle}>
            <div className="banner err" style={{ maxWidth: 420 }}>
              {phase.message}
            </div>
          </div>
        )}
        {phase.kind === "unsupported" && (
          <div style={overlayStyle}>
            <div style={{ textAlign: "center", maxWidth: 380 }}>
              <div style={{ fontSize: 36, marginBottom: 10, opacity: 0.6 }}>◈</div>
              <div style={{ color: "var(--text-dim)" }}>
                This engine can’t export stored vectors, so projection isn’t available here yet.
              </div>
            </div>
          </div>
        )}

        {hover && (
          <div style={tooltipStyle}>
            <div className="cell-id" style={{ marginBottom: 4 }}>{String(hover.id)}</div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--text-dim)", maxHeight: 120, overflow: "hidden" }}>
              {previewPayload(hover.payload)}
            </div>
          </div>
        )}

        {legend.length > 0 && (
          <div style={legendStyle}>
            {legend.map((l) => (
              <div key={l.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: l.hex, display: "inline-block" }} />
                <span style={{ fontSize: 11.5, color: "var(--text-dim)" }} className="truncate">
                  {l.label}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "grid",
  placeItems: "center",
  background: "rgba(7, 10, 14, 0.4)",
  backdropFilter: "blur(2px)",
  textAlign: "center",
};

const tooltipStyle: React.CSSProperties = {
  position: "absolute",
  top: 12,
  left: 12,
  maxWidth: 280,
  padding: "10px 12px",
  borderRadius: 10,
  background: "rgba(14, 19, 27, 0.92)",
  border: "1px solid var(--border-bright)",
  pointerEvents: "none",
};

const legendStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 12,
  right: 12,
  padding: "10px 12px",
  borderRadius: 10,
  background: "rgba(14, 19, 27, 0.88)",
  border: "1px solid var(--border)",
  display: "flex",
  flexDirection: "column",
  gap: 5,
  maxWidth: 200,
};

function previewPayload(payload: Record<string, Json>): string {
  const entries = Object.entries(payload).slice(0, 5);
  return entries.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n") || "(empty)";
}
