import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url)); // apps/vscode-extension/webview-ui
const repoRoot = resolve(here, "..", "..", "..");
const webSrc = resolve(repoRoot, "apps", "web", "src");
const vizSrc = resolve(repoRoot, "packages", "viz", "src");

/**
 * Builds the webview bundle by reusing the real studio UI from `apps/web`.
 *
 * The trick is three aliases:
 *   • `@`         → apps/web/src   (so the web app's own `@/…` imports resolve)
 *   • `next/link` → a shim that renders <a> and drives a hash router
 *   • `@vyn/core` → a shim that keeps every real export but swaps
 *                   `createConnector`/`embedText` for host-RPC versions
 *
 * Nothing in apps/web is modified. Output is a single, unhashed bundle so the
 * extension host can serve it with a nonce'd <script> tag.
 */
export default defineConfig({
  root: here,
  base: "./",
  plugins: [react()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      { find: "next/link", replacement: resolve(here, "src", "shims", "next-link.tsx") },
      { find: "@vyn/core", replacement: resolve(here, "src", "core-shim.ts") },
      { find: "@vyn/viz/render", replacement: resolve(vizSrc, "render", "index.ts") },
      { find: "@vyn/viz", replacement: resolve(vizSrc, "index.ts") },
      // Keep `@/…` last so the more specific finds above win first.
      { find: /^@\//, replacement: webSrc + "/" },
    ],
  },
  build: {
    outDir: resolve(here, "dist"),
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        entryFileNames: "assets/index.js",
        assetFileNames: "assets/index.[ext]",
      },
    },
  },
});
