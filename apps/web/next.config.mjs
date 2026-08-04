/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship as TS source; let Next transpile them.
  transpilePackages: ["@vyn/core", "@vyn/viz"],
  // The desktop build (Tauri, no Node server) needs a static export; the
  // Vercel deploy stays on the normal build. Same app, two output shapes,
  // selected by an env var so neither target needs its own config file.
  ...(process.env.BUILD_TARGET === "export" ? { output: "export" } : {}),
};

export default nextConfig;
