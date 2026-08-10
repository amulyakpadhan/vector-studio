/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship as TS source; let Next transpile them.
  transpilePackages: ["@vyn/core", "@vyn/viz"],
  // Static export: every page here is client-rendered (connections live in
  // the browser's own localStorage, never on a server), so there's nothing
  // server-side to lose. This is what lets the Tauri desktop build package
  // apps/web as local files (tauri.conf.json's frontendDist) instead of
  // needing a Node server bundled into the app. Vercel serves a static
  // export just fine, so the deployed site behaves identically.
  output: "export",
  // Without this, /studio exports as studio.html sitting next to studio.txt
  // (the route's RSC flight-data payload) — same basename, different
  // extension. Tauri's static asset resolver, given the bare path /studio
  // with no extension, was resolving that ambiguity to the .txt file instead
  // of the .html one, rendering the raw flight data as plain text instead of
  // the page. trailingSlash exports studio/index.html + studio/index.txt in
  // their own folder instead, so there's no same-basename pair to resolve
  // ambiguously — a bare directory path unambiguously means its index.html.
  trailingSlash: true,
};

export default nextConfig;
