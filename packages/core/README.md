# @vyn/core

A universal, dependency-free TypeScript client for vector databases. One
interface — `VectorConnector` — across Qdrant, Pinecone, and more, talking
directly to each engine's HTTP API. Runs in the browser, Node, and desktop
runtimes.

MIT licensed.

```ts
import { createConnector } from "@vyn/core";

const db = createConnector({
  engine: "qdrant",
  url: "http://localhost:6333",
});

const collections = await db.listCollections();
const hits = await db.vectorSearch("docs", { vector: myEmbedding, limit: 10 });
```

## Why

Every vector DB has a different SDK, protocol, and vocabulary. `@vyn/core`
normalizes them behind one small interface (`listCollections`, `listRecords`,
`vectorSearch`, `upsertRecords`, `fetchVectors`, …) plus a `capabilities()`
descriptor so callers can adapt to what each engine actually supports —
instead of pretending they're all identical.

## Engines

| Engine | Transport | Status |
| --- | --- | --- |
| Qdrant | REST | ✅ |
| Pinecone | REST (control + data plane) | ✅ |
| Weaviate | REST + GraphQL | ✅ |
| Milvus | REST v2 | 🔜 |
| Chroma | REST (v2, falls back to v1) | ✅ |

## Notes

- **Zero runtime dependencies** — uses the global `fetch`.
- **Bring your own transport quirks:** pass `options.bridgeUrl` to route
  requests through a local proxy (see `@vyn/bridge`) for self-hosted or
  CORS-restricted databases.
- Credentials live wherever the caller puts them; this library never persists
  or transmits them anywhere except to the database you point it at.

Part of [Vyn Studio](https://github.com/amulyakpadhan/vector-studio).
