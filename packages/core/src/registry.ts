import type { VectorConnector } from "./connector.ts";
import { QdrantConnector } from "./connectors/qdrant.ts";
import { PineconeConnector } from "./connectors/pinecone.ts";
import { WeaviateConnector } from "./connectors/weaviate.ts";
import { ChromaConnector } from "./connectors/chroma.ts";
import type { ConnectionConfig, DbEngine } from "./types.ts";

type ConnectorFactory = (config: ConnectionConfig) => VectorConnector;

const REGISTRY: Partial<Record<DbEngine, ConnectorFactory>> = {
  qdrant: (config) => new QdrantConnector(config),
  pinecone: (config) => new PineconeConnector(config),
  weaviate: (config) => new WeaviateConnector(config),
  chroma: (config) => new ChromaConnector(config),
  // milvus → next
};

export function createConnector(config: ConnectionConfig): VectorConnector {
  const factory = REGISTRY[config.engine];
  if (!factory) {
    throw new Error(
      `Engine "${config.engine}" is not supported yet. Available: ${Object.keys(REGISTRY).join(", ")}`,
    );
  }
  return factory(config);
}
