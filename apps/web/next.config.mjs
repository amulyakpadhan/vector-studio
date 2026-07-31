/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship as TS source; let Next transpile them.
  transpilePackages: ["@vyn/core", "@vyn/viz"],
};

export default nextConfig;
