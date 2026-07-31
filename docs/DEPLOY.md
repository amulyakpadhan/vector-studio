# Deploying the studio (Vercel)

The studio is a fully client-side app — no database, no API routes, nothing
server-side to provision. Deploying it is just hosting the static/SSR shell;
all the real work (connectors, UMAP, rendering) runs in the visitor's browser.

## Vercel setup

1. Import the repo at [vercel.com/new](https://vercel.com/new).
2. **Root Directory:** set to `apps/web` (this is a pnpm-workspace monorepo;
   Vercel needs to know the app lives one level down from the repo root).
3. Framework preset: **Next.js** (auto-detected).
4. Leave build/install commands as default — `apps/web/vercel.json` pins them
   explicitly so the build always installs from the monorepo root first:
   ```
   buildCommand: cd ../.. && pnpm install --frozen-lockfile && pnpm --filter @vyn/web build
   outputDirectory: .next
   ```
5. Deploy. Every push to `main` redeploys production; other branches get
   preview URLs automatically.

No environment variables are required — the app has none (no server secrets,
since all DB credentials live in the visitor's own browser).

## Why free tier is enough

- `/` and `/studio` are static.
- `/studio/[id]` is a dynamic route only because of the `[id]` param; it
  renders a client shell with no server-side data fetching, so it costs
  almost nothing per request.
- The expensive work — vector DB calls, UMAP projection, Three.js rendering —
  happens in the browser, never on the host.

So bandwidth for a small static bundle is the only real cost, well within
Vercel's free Hobby tier for a build-in-public launch.

## Custom domain

Once you own a domain, add it under the Vercel project's **Domains** tab —
no code changes needed.
