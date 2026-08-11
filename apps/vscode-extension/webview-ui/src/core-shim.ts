/**
 * Alias target for `@vyn/core` inside the webview build.
 *
 * Re-exports the entire real core (types, connectors, io, filter, embeddings
 * metadata, …) unchanged, then overrides just the two functions that would
 * otherwise hit the network from the browser — `createConnector` and
 * `embedText` — with host-RPC versions. Explicit named exports win over the
 * `export *`, so callers importing from "@vyn/core" transparently get the
 * RPC-backed pair and the genuine article for everything else.
 */
export * from "../../../../packages/core/dist/index";
export { createConnector, embedText } from "./rpc";
