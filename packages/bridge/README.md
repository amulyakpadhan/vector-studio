# @vyn/bridge

A tiny localhost proxy that lets the **Vyn Studio** web app reach vector
databases the browser can't call directly — self-hosted instances on
`localhost`/private networks, and cloud DBs that don't send permissive CORS
headers (e.g. Pinecone).

It's the same idea as the Postman Desktop Agent: your credentials and data
never leave your machine, and the browser talks to your DB _through_ a proxy
you run locally. Zero dependencies — just Node.

## Run it

Not yet published to npm — for now, run it from a clone of this repo:

```bash
git clone https://github.com/amulyakpadhan/vector-studio.git
cd vector-studio
pnpm install
pnpm bridge
# ⬡  Vyn bridge v0.1.0  — listening on http://127.0.0.1:7391
```

Requires Node 22.6+ (uses `--experimental-strip-types` to run the TypeScript
source directly — no build step). Once published, this becomes `npx @vyn/bridge`.

The studio auto-detects it (`GET /health`) and shows **“bridge: detected”**
in the connection form. Keep it running while you work.

### Options

| Flag / env | Default | Meaning |
| --- | --- | --- |
| `--port N` / `VYN_BRIDGE_PORT` | `7391` | Port to listen on |
| `--allow-origin URL` / `VYN_BRIDGE_ORIGINS` | — | Extra studio origins allowed to use the bridge (repeatable / comma-separated) |

## How it stays safe

- **Binds to `127.0.0.1` only** — not reachable from your network.
- **Origin allowlist** — only the Vyn studio origins (local dev + the hosted
  app, plus any you add) may use `/proxy`. The browser sets the `Origin`
  header and page scripts can't forge it, so other websites you visit can't
  use the bridge to reach your internal network.
- **Forwards nothing extra** — hop-by-hop and `Origin`/`Referer` headers are
  stripped before the request reaches your database.
- Handles Chrome's Private Network Access preflight so the HTTPS studio can
  reach the local bridge.

## What it does

```
browser (studio)  ──►  GET /proxy?target=<db-url>  ──►  bridge  ──►  your DB
                  ◄──────────── response + CORS headers ◄────────────┘
```

Only `/health` and `/proxy?target=…` exist. Everything else is 404.
