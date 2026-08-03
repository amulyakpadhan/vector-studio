# Vyn Studio — Architecture

> **One-liner:** The MongoDB Compass / Postman for vector databases — a universal GUI to connect, browse, search, visualize, and manage any vector DB (cloud or self-hosted), with a stunning embedding-projection engine as the differentiator.

---

## 1. Core Principles

1. **Client-side data path.** The user's database credentials and data NEVER transit our servers. All connector code runs in the user's browser or desktop app and talks directly to the vector DB's HTTP API. This is the trust model of Compass, TablePlus, and Postman — and it is non-negotiable for adoption.
2. **TypeScript end-to-end.** No Python anywhere in the product. Connectors, projection math (UMAP), rendering, UI — all TS/WASM. One language, one toolchain, runs identically in browser and desktop.
3. **Direct HTTP APIs, not vendor SDKs.** Each connector speaks the DB's native REST/GraphQL API over `fetch`. No heavy client libraries, no gRPC dependency at the start.
4. **Web first, desktop-ready by design.** The studio is a static-exportable app; the desktop app (Tauri) wraps the exact same build later with near-zero rework.
5. **Open-core.** The tool is open source (the growth engine); team/cloud features are the paid layer (the business).

---

## 2. Repository Layout (Monorepo)

Managed with **pnpm workspaces + Turborepo**.

```
vector-studio/
├── apps/
│   ├── web/                  # Next.js 15 — landing page + studio UI
│   │   ├── app/(landing)/    # 3D scroll-driven landing (R3F + GSAP)
│   │   └── app/(studio)/     # the actual tool (static-exportable)
│   └── desktop/              # Tauri v2 shell (Phase 3 — wraps apps/web build)
│
├── packages/
│   ├── core/                 # ⭐ connector layer — pure TS, zero UI deps
│   │   ├── src/types.ts      #    unified domain model (Connection, Collection, Record, …)
│   │   ├── src/connector.ts  #    the VectorConnector interface
│   │   └── src/connectors/
│   │       ├── qdrant/       #    REST
│   │       ├── pinecone/     #    REST
│   │       ├── weaviate/     #    REST + GraphQL (search)
│   │       ├── milvus/       #    RESTful API v2
│   │       └── chroma/       #    REST
│   │
│   ├── viz/                  # ⭐ projection engine — UMAP workers + Three.js renderer
│   │   ├── src/projection/   #    umap-js in Web Workers, PCA pre-reduction
│   │   └── src/renderer/     #    instanced WebGL point cloud, GPU picking, lasso
│   │
│   └── ui/                   # shared design system (Tailwind + Radix primitives)
│
├── server/                   # thin account server (Phase 4) — NEVER in the data path
│   └── ...                   # auth, encrypted profile sync, teams, billing
│
├── turbo.json
└── pnpm-workspace.yaml
```

**Why this split matters:**
- `packages/core` is publishable to npm on its own (MIT) — a universal vector-DB client library is a Trojan horse for adoption.
- `apps/desktop` reuses `apps/web`'s static export — building desktop later costs days, not months.
- `server/` is optional to run; the tool is fully functional without it (local-only mode).

---

## 3. The Connector Layer (`packages/core`)

### 3.1 Where it runs

**In the client. Always.** Browser (web app) or webview/Rust-proxied (desktop app). There is no backend service executing queries on behalf of users.

```
┌────────────────────────────┐         direct HTTPS (fetch)
│  Browser / Desktop app     │ ───────────────────────────────▶  Qdrant Cloud
│  ┌──────────────────────┐  │ ───────────────────────────────▶  Pinecone
│  │  packages/core       │  │ ───────────────────────────────▶  Weaviate Cloud
│  │  (TS connectors)     │  │                                   …
│  └──────────────────────┘  │
│            │               │         via local bridge (CORS)
│            └───────────────┼──────▶ ┌─────────────┐ ────────▶  localhost:6333 (self-hosted
│                            │        │ local bridge │            Qdrant/Milvus/Weaviate/…)
└────────────────────────────┘        └─────────────┘
```

### 3.2 The interface (evolves from the current Python `BaseConnector`)

```ts
interface VectorConnector {
  // lifecycle
  testConnection(config: ConnectionConfig): Promise<TestResult>;   // {ok, version, latencyMs}
  connect(config: ConnectionConfig): Promise<void>;
  disconnect(): Promise<void>;
  getMeta(): Promise<ServerMeta>;                                  // version, nodes, health

  // collections / indexes
  listCollections(): Promise<CollectionInfo[]>;
  getSchema(name: string): Promise<CollectionSchema>;
  getStats(name: string): Promise<CollectionStats>;
  createCollection(spec: CreateCollectionSpec): Promise<void>;     // dimension, metric, payload schema
  deleteCollection(name: string): Promise<void>;

  // records
  listRecords(c: string, opts: PageOpts): Promise<Page<VectorRecord>>;
  getRecord(c: string, id: string): Promise<VectorRecord>;
  upsertRecords(c: string, records: VectorRecord[]): Promise<UpsertResult>;
  updatePayload(c: string, id: string, payload: Json): Promise<void>;
  deleteRecords(c: string, ids: string[]): Promise<void>;

  // search
  vectorSearch(c: string, q: VectorQuery): Promise<SearchResult[]>;    // raw vector + filter
  textSearch?(c: string, q: TextQuery): Promise<SearchResult[]>;       // bm25/hybrid where supported
  fetchVectors(c: string, opts: SampleOpts): Promise<Float32Array[]>;  // bulk export for projection

  // capability discovery — UI adapts per engine
  capabilities(): ConnectorCapabilities;   // {hybridSearch, payloadIndexes, namespaces, …}
}
```

`capabilities()` is the key to "one UI, many engines": the UI renders what the engine supports instead of pretending all DBs are identical.

### 3.3 Per-engine transport

| Engine | Transport | Notes |
|---|---|---|
| **Qdrant** | REST | First-class API; scroll API for pagination; excellent fit |
| **Pinecone** | REST | Serverless + pod indexes; namespaces; `list`/`query`/`fetch` |
| **Weaviate** | REST + GraphQL | REST for CRUD/schema; GraphQL for nearVector/hybrid/bm25 |
| **Milvus** | RESTful API v2 | Covers CRUD + search; gRPC-only features deferred to desktop phase |
| **Chroma** | REST | Simple; big local-dev audience |
| **pgvector** | (Phase 3+) | Needs TCP — desktop-only via Tauri Rust side |

### 3.4 CORS & the local bridge

- **Cloud DBs** (Qdrant Cloud, Pinecone, Weaviate Cloud): reachable directly from the browser (they serve CORS headers / are configurable).
- **Self-hosted DBs** (`localhost`, private networks): browsers block cross-origin calls. Solution — a **local bridge**: a tiny single-binary HTTP proxy (Rust, shared with the Tauri app) that runs on the user's machine and forwards `studio → localhost:port`. The web app auto-detects it (`GET http://127.0.0.1:7391/health`) and routes self-hosted traffic through it. This is exactly the Postman Agent model.
- **Desktop app**: no CORS at all — Tauri's Rust side does the HTTP, everything works out of the box.

### 3.5 Credential storage

- **Web:** encrypted at rest in IndexedDB (WebCrypto, key derived from a local passphrase); NEVER sent to our server unless the user opts into profile sync (then E2E-encrypted client-side before upload).
- **Desktop:** OS keychain (macOS Keychain / Windows Credential Manager / libsecret) via Tauri.

---

## 4. The Visualization Engine (`packages/viz`) — the differentiator

**All in the browser. No Python. No server round-trip. Vectors never leave the user's machine.**

### 4.1 Projection pipeline

```
fetchVectors() ──▶ Web Worker ──▶ PCA pre-reduce (WASM, dims→50) ──▶ UMAP (umap-js, incremental)
                                                                          │ progress events
                                                                          ▼
                                                              Float32Array of 2D/3D positions
                                                                          ▼
                                                              Three.js instanced point cloud
```

- **`umap-js`** in a **Web Worker** — UI never blocks; progress streamed to a loading state. Comfortable to ~50k points.
- **PCA pre-reduction** (via WASM linear algebra) from 768/1536/3072 dims → 50 dims before UMAP: massive speedup, standard practice.
- **Large collections:** smart sampling (random or per-filter stratified) with the sample size visible in the UI; "project the full collection" can come later as a paid hosted job.
- t-SNE optional later; UMAP is faster, preserves global structure better, and is the industry default (Nomic Atlas, TF Projector).

### 4.2 Renderer

- Three.js **instanced points with custom shaders** — 100k+ points at 60fps.
- **GPU picking** for hover/click → record inspector panel.
- **Lasso / box select** → bulk view, tag, delete of selected records.
- **Color & size by metadata field** (categorical palette / numeric ramp).
- 2D and 3D modes, smooth camera transitions.

### 4.3 Killer feature: Query Overlay

Run a live search against the DB → the query point and its retrieved neighbors are highlighted **spatially inside the projection**, with rank/score edges. Instantly shows *why* a RAG query retrieved what it did — misclustered chunks, duplicate zones, out-of-distribution queries. **No existing tool does this connected to live DBs. This is the launch demo.**

---

## 5. Landing Page (`apps/web`, `(landing)` route group)

- **React Three Fiber + drei + GSAP ScrollTrigger.**
- Concept: a 3D particle cloud (thematically, *the user's data*) that morphs as you scroll — assembles into the Vyn logo → explodes into labeled clusters (features) → forms a query-neighborhood ring (the killer feature) → settles into a CTA. The "burger deconstruction" pattern, but with a point cloud — one persistent scene with morph targets between scroll-pinned sections (cheaper and smoother than multiple scenes).
- Performance budget: instanced particles only, no per-frame allocations, `prefers-reduced-motion` fallback to static renders.
- Built in **Phase 2**, not first — launch the landing when there's a product to sign up for.

---

## 6. Desktop App (`apps/desktop`, Phase 3)

- **Tauri v2** (not Electron): ~10 MB binaries, low RAM, and the Rust core gives us the local bridge for free.
- Wraps the **same static export** of the studio; UI code is 100% shared.
- Rust side adds: HTTP proxying (no CORS constraints), OS-keychain credential storage, local SQLite for profiles/history, and future TCP/gRPC connectors (pgvector, Milvus gRPC).
- Auto-update via Tauri updater; CI builds for macOS/Windows/Linux.

---

## 7. Account Server (`server/`, Phase 4 — optional to run)

Thin. Never in the data path. Stack: **Hono or Fastify (TS) + Postgres**, deployable anywhere.

Responsibilities:
- OAuth (GitHub/Google) — accounts are optional; local-only mode is fully functional
- E2E-encrypted connection-profile sync (server stores ciphertext only)
- Teams/workspaces, shared query collections
- Billing (Stripe), licensing for paid desktop features
- Anonymous opt-in telemetry

---

## 8. Monetization (open-core, Postman model)

**Free & open source forever** (the growth engine):
- All connectors, CRUD, schema management, search
- Local visualization & query overlay
- Local profiles, single user

**Paid — Pro / Team** (cloud account, later):
- Team workspaces & E2E-encrypted shared connections
- **Cross-DB migration** (Pinecone → Qdrant etc.) — high willingness-to-pay
- Saved/shared query collections (the "Postman collections" analog)
- Scheduled monitoring, drift & duplicate alerts
- Hosted projection jobs for very large collections

**Licensing:**
- App (`apps/*`): **AGPL-3.0** (or Elastic License 2.0 / FSL if stronger cloud-hosting protection is wanted) — prevents a vendor from rehosting it against us
- `packages/core`: **MIT**, published to npm — maximizes spread; every library user is a funnel to the studio
- Paid cloud/team code: private repo (open-core split)

**Open source? Yes — near-mandatory here:** devs won't paste DB API keys into a closed tool from an unknown author, and the build-in-public X/Reddit strategy needs a repo to star. Precedent: Compass, Attu, VectorAdmin, Beekeeper Studio.

---

## 9. Tech Stack Summary

| Layer | Choice |
|---|---|
| Monorepo | pnpm workspaces + Turborepo |
| Web app | Next.js 15, React 19, TypeScript |
| State/data | Zustand + TanStack Query |
| Styling | Tailwind CSS + Radix primitives (`packages/ui`) |
| 3D / viz | Three.js, React Three Fiber, drei; custom shaders |
| Projection | umap-js in Web Workers + WASM PCA pre-reduction |
| Landing animation | GSAP ScrollTrigger + R3F |
| Desktop | Tauri v2 (Rust) |
| Account server | Hono/Fastify + Postgres (Phase 4) |
| CI | GitHub Actions (typecheck, test, build matrix, Tauri bundles) |

**Python is not used anywhere.** The current FastAPI prototype is the reference implementation; its connector semantics port to `packages/core`, then it retires.

---

## 10. Build Phases

| Phase | Deliverable | Share-in-public moment |
|---|---|---|
| **0** | Monorepo scaffold; `core` with Qdrant + Pinecone connectors; studio shell (connections, collections, data grid, record inspector) | "Building a Compass for vector DBs" first screenshots |
| **1** | Search UX (vector/text/hybrid per capability), schema mgmt, Weaviate + Milvus + Chroma connectors, local bridge | Multi-engine demo GIFs |
| **2** | `viz` engine (projection + query overlay) + 3D landing page | 🚀 **Launch: demo video on X / r/vectordatabases / HN** |
| **3** | Tauri desktop app, keychain, auto-update | Desktop release |
| **4** | Account server: teams, sync, migration, billing | Pro launch |

### Migration note (from the current codebase)

The existing FastAPI app (`app/`) keeps running as-is during Phases 0–1 — no need to break the deployed demo. The Python `BaseConnector` interface is the spec for the TS `VectorConnector`; connectors are ported one-to-one (Weaviate/Pinecone/Qdrant/Milvus semantics already proven). Once the studio reaches feature parity, the FastAPI app is retired and the repo is restructured to the monorepo layout above.
