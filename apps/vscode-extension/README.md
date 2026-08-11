# Vyn Studio — VS Code Extension

Connect, browse, search, and visualize your vector databases — Qdrant, Pinecone,
Weaviate, Chroma, Milvus — without leaving your editor. Works in VS Code and its
forks (Cursor, Windsurf, VSCodium).

This is the **full studio UI** from `apps/web`, reused verbatim and mounted
inside a VS Code webview. Same connections dashboard, collection browser,
record CRUD, filtering, vector/text search, stats, import/export, and the
3D embedding projection view.

## Architecture

```
┌─ Webview (the real React studio, sandboxed) ─┐
│  Dashboard · Studio · Search · Projection …  │
│  every DB call → a typed postMessage         │
└───────────────────────┬──────────────────────┘
                        │  RPC
                        ▼
┌─ Extension host (Node) ──────────────────────┐
│  @vyn/core connectors · embedText            │
│  native fetch → your vector DB / embedder    │
└──────────────────────────────────────────────┘
```

The webview makes **no network requests of its own** (its CSP is
`connect-src 'none'`). Every database call and every embedding call is a typed
message to the extension host, which runs the shared `@vyn/core` code over
Node's native `fetch`. That means:

- **No CORS** — the host is not a browser origin.
- **No local bridge** — nothing for the user to install or run.
- **No Tauri IPC** — the class of transport problems the web/desktop builds
  fought with does not exist here.

### How the web UI is reused unchanged

The build aliases three module specifiers (see `webview-ui/vite.config.ts`);
**no file under `apps/web` is modified**:

| Specifier | Redirected to | Why |
|-----------|---------------|-----|
| `@/…` | `apps/web/src/…` | resolve the web app's own imports |
| `next/link` | `webview-ui/src/shims/next-link.tsx` | render `<a>` + drive a hash router |
| `@vyn/core` | `webview-ui/src/core-shim.ts` | keep every real export, but swap `createConnector` / `embedText` for host-RPC versions |

Because every component already takes a `VectorConnector` and calls its methods,
the RPC proxy (`webview-ui/src/rpc.ts`) is a drop-in: synchronous, no-network
calls (`capabilities()`, `config`) are answered locally; everything else is
forwarded to the host.

## Isolation

This package lives entirely under `apps/vscode-extension` and only *imports*
`@vyn/core` and `@vyn/viz` (read-only), exactly as the web app does. It adds no
code to and changes no behaviour of `apps/web` or any other package. Merging it
to `main` adds a folder; nothing runs it unless you build it.

## Build & run (development)

From the repo root:

```bash
pnpm install
pnpm --filter vyn-studio-vscode build   # builds the webview (Vite) + host (esbuild)
```

Then open `apps/vscode-extension` in VS Code and press **F5**
("Run Vyn Studio Extension"). In the Extension Development Host window, run the
command **"Vyn Studio: Open"** (Cmd/Ctrl-Shift-P).

Try it against a local Qdrant:

```bash
docker run -p 6333:6333 qdrant/qdrant
# New connection → engine: Qdrant, URL: http://localhost:6333
```

## Package (`.vsix`)

```bash
pnpm --filter vyn-studio-vscode build
npx @vscode/vsce package      # from apps/vscode-extension
```

Publish to the VS Code Marketplace and Open VSX (the latter covers Cursor,
Windsurf, and VSCodium).

## Known limitations (follow-ups)

- **Persistence:** connections are stored in the webview's `localStorage`, which
  is reliable within a session (the panel uses `retainContextWhenHidden`) but
  not guaranteed across full editor restarts. A follow-up should persist
  connections to the extension's `globalState` over RPC.
- **Confirm dialogs:** VS Code webviews don't implement `window.confirm`, so the
  reused UI's destructive-action confirmations are auto-accepted. A follow-up
  should route them through a native `vscode.window.showWarningMessage`.
