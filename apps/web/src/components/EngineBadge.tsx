import type { DbEngine } from "@vyn/core";

const LABELS: Record<DbEngine, string> = {
  qdrant: "Qdrant",
  pinecone: "Pinecone",
  weaviate: "Weaviate",
  milvus: "Milvus",
  chroma: "Chroma",
};

export function EngineBadge({ engine }: { engine: DbEngine }) {
  return (
    <span className={`badge ${engine}`}>
      <span className="dot" />
      {LABELS[engine]}
    </span>
  );
}
