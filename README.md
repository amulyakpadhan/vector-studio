<div align="center">

# Vyn Studio

### The universal studio for vector databases.

Connect, browse, search, and **visualize** any vector database — cloud or self-hosted —
from one fast, modern UI. Think MongoDB Compass / Postman, but for vectors,
with a 3D embedding explorer no other tool has.

<br/>

![Vyn Studio — connections](docs/assets/dashboard.png)

</div>

---

## Why

Every vector database ships its own console, and none of them talk to each other.
If you use Qdrant *and* Pinecone, you juggle two dashboards, two mental models, and
still can't actually *see* your embeddings. Vyn Studio is one interface across all
of them — and the first to render your live vectors as an explorable 3D space.

The trust model is the important part: **your database credentials and data never
touch our servers.** All connectors run in your browser (or the desktop app, later);
the only thing we'd ever host is an optional account for team features. Same posture
as Compass, TablePlus, and Postman.

## What it does

- **Connect any vector DB** — one connection manager for all engines, credentials
  stored locally (never uploaded).
- **Browse & edit** — paginated data grid, record inspector, create/delete
  collections, edit payloads, insert/delete records.
- **Search** — vector similarity search with a capability-aware UI that adapts to
  what each engine supports.
- **Visualize (the differentiator)** — sample a collection's stored vectors, project
  them to 3D with **UMAP**, and explore them as a glowing point cloud. Color by any
  metadata field. **Click any point to light up its nearest neighbors** — a live
  similarity query, visualized, with no embedding API required.
- **Local bridge** — a tiny optional proxy (`npx @vyn/bridge`) that lets the browser
  reach self-hosted DBs on `localhost` and CORS-restricted clouds, without your data
  leaving your machine.

<div align="center">
<br/>

![Vyn Studio — 3D embedding projection](docs/assets/projection.png)

*Live embeddings projected to 3D. Each point is a record; clusters are semantic neighborhoods.*

</div>

## Supported engines

| Engine | Connect | Browse / CRUD | Vector search | Projection |
| --- | :---: | :---: | :---: | :---: |
| **Qdrant** | ✅ | ✅ | ✅ | ✅ |
| **Pinecone** | ✅ | ✅ | ✅ | ✅ |
| **Weaviate** | ✅ | ✅ | ✅ (+ keyword/hybrid) | ✅ |
| Milvus | 🔜 | 🔜 | 🔜 | 🔜 |
| Chroma | 🔜 | 🔜 | 🔜 | 🔜 |

Adding an engine means implementing one `VectorConnector` interface — the entire UI
and the visualization work against it for free.

## Architecture

A TypeScript monorepo. **No Python anywhere** — connectors and the UMAP/Three.js
projection all run client-side, which is what lets credentials stay on your machine
and makes the desktop app (later) a thin wrapper over the same build.

```
apps/
  web/          Next.js studio (this is the app)
packages/
  core/         @vyn/core   — vector-DB connector layer (MIT; runs in the browser)
  viz/          @vyn/viz    — UMAP projection + Three.js point-cloud renderer
  bridge/       @vyn/bridge — localhost proxy for self-hosted / CORS-restricted DBs
```

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full design, including the desktop
and account-server plans.

## Quickstart

Requires Node 20+ and pnpm.

```bash
pnpm install
pnpm --filter @vyn/core build      # connectors are consumed as built output
pnpm --filter @vyn/web dev         # open http://localhost:3000
```

Add a connection (a Qdrant URL, or a Pinecone API key), open it, and browse. Hit the
**Visualize** tab on any collection to project it.

**Self-hosted or Pinecone?** Run the bridge in a second terminal so the browser can
reach it:

```bash
pnpm bridge        # or: npx @vyn/bridge
```

The studio auto-detects it and offers to route the connection through it.

## Deployment

The studio is fully client-side and deploys as a static/SSR Next.js app on
Vercel's free tier — no server or database to provision. See
[`docs/DEPLOY.md`](docs/DEPLOY.md).

## Development

```bash
pnpm test          # all package test suites
pnpm typecheck     # strict TypeScript across the monorepo
pnpm build         # build everything
```

## Roadmap

- [x] Monorepo + connector layer (Qdrant, Pinecone)
- [x] Studio: connections, browse/CRUD, search
- [x] 3D embedding projection + click-to-query overlay
- [x] Local bridge for self-hosted / CORS
- [x] Landing page
- [x] Weaviate connector (REST + GraphQL search)
- [ ] Milvus, Chroma connectors
- [ ] Desktop app (Tauri)
- [ ] Team features (shared connections, cross-DB migration)

## License

Open-core:

- **`packages/core`** is **MIT** — a universal vector-DB client you can use in any
  project.
- The **app and the rest of the packages** are **AGPL-3.0-only**.

Not affiliated with Qdrant, Pinecone, Weaviate, Milvus, or Chroma; all trademarks
belong to their owners.
