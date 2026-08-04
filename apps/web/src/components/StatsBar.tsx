"use client";

import type { DbEngine, DistanceMetric } from "@vyn/core";

interface Props {
  engine?: DbEngine;
  count?: number;
  dimension?: number;
  metric?: DistanceMetric;
  indexedFields?: number;
  loading?: boolean;
}

const ENGINE_LABEL: Record<DbEngine, string> = {
  qdrant: "Qdrant",
  pinecone: "Pinecone",
  weaviate: "Weaviate",
  chroma: "Chroma",
  milvus: "Milvus",
};

const METRIC_LABEL: Record<DistanceMetric, string> = {
  cosine: "Cosine",
  euclidean: "Euclidean",
  dot: "Dot product",
};

export function StatsBar({ engine, count, dimension, metric, indexedFields, loading }: Props) {
  const cards: { label: string; value: string; hint?: string }[] = [
    { label: "Records", value: count != null ? count.toLocaleString() : "—" },
    { label: "Dimensions", value: dimension != null ? String(dimension) : "—" },
    { label: "Distance", value: metric ? METRIC_LABEL[metric] : "—" },
    { label: "Engine", value: engine ? ENGINE_LABEL[engine] : "—" },
    { label: "Indexed fields", value: indexedFields != null ? String(indexedFields) : "—" },
  ];

  return (
    <div className="stat-grid">
      {cards.map((c) => (
        <div className="stat-card" key={c.label}>
          <div className="stat-label">{c.label}</div>
          <div className={`stat-value ${loading ? "skeleton-text" : ""}`}>{loading ? "" : c.value}</div>
        </div>
      ))}
    </div>
  );
}
