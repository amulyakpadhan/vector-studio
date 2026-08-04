# @vyn/desktop

The desktop shell — Tauri v2 wrapping the studio's static export. Same UI,
same connectors, same everything; this is a thin native window around the
build that already runs at `apps/web`.

## Status

This is early scaffolding, not a shipped app yet:

- [x] Static export of the studio (`next build` with `output: "export"`,
      selected via `BUILD_TARGET=export` so the normal Vercel deploy is
      untouched) — required converting `/studio/[id]` to a query-param route
      (`/studio/view?id=...`) since a dynamic segment can't be pre-rendered
      for ids that only exist at runtime in the browser.
- [x] Tauri window boots and serves that export.
- [x] App icons generated from the studio's favicon.
- [ ] **Local bridge built in.** Right now self-hosted/CORS-restricted DBs
      still need `pnpm bridge` running in a second terminal, same as the web
      app. The point of the desktop app is that this becomes unnecessary —
      either port the bridge's proxy logic to Rust, or run the existing
      Node bridge as a managed sidecar process.
- [ ] **OS keychain for credentials**, replacing localStorage.
- [ ] Auto-updater.
- [ ] Signed release builds via CI for macOS/Windows/Linux (Tauri bundles
      per-OS — there's no cross-compiling a `.dmg` from Linux, so this needs
      a GitHub Actions matrix, not a local build).

## Running it

Requires Rust (`rustup`) and Tauri's platform dependencies — see
[tauri.app/start/prerequisites](https://tauri.app/start/prerequisites/) for
your OS. On Linux that's `webkit2gtk`, `libayatana-appindicator3`, etc.

```bash
pnpm install
pnpm desktop         # exports the web app, then opens the dev window
pnpm desktop:build   # exports, then builds a release bundle for this OS
```

`pnpm desktop` re-runs the static export every time so it always reflects
the current `apps/web` source — there's no separate frontend dev server or
hot reload wired up yet, since the immediate goal was proving the shell
works, not a fast inner loop. Iterate on the UI itself via
`pnpm --filter @vyn/web dev` in a browser as usual; reach for `pnpm desktop`
to check desktop-specific behavior.
