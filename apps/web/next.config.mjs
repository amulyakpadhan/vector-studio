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
};

export default nextConfig;
