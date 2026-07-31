import { createBridge, DEFAULT_PORT, BRIDGE_VERSION } from "./server.ts";

/**
 * `vyn-bridge` — run the local bridge from a terminal.
 *   vyn-bridge [--port N] [--allow-origin URL ...]
 * Env: VYN_BRIDGE_PORT, VYN_BRIDGE_ORIGINS (comma-separated).
 */
function parseArgs(argv: string[]): { port: number; allowedOrigins: string[] } {
  let port = Number(process.env["VYN_BRIDGE_PORT"]) || DEFAULT_PORT;
  const allowedOrigins = (process.env["VYN_BRIDGE_ORIGINS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port" && argv[i + 1]) {
      port = Number(argv[++i]);
    } else if (argv[i] === "--allow-origin" && argv[i + 1]) {
      allowedOrigins.push(argv[++i]!);
    }
  }
  return { port, allowedOrigins };
}

const { port, allowedOrigins } = parseArgs(process.argv.slice(2));
const server = createBridge({ port, allowedOrigins });

server.listen(port, "127.0.0.1", () => {
  console.log(`\n  ⬡  Vyn bridge v${BRIDGE_VERSION}`);
  console.log(`     listening on http://127.0.0.1:${port}`);
  console.log(`     the studio will auto-detect it; keep this running.`);
  if (allowedOrigins.length) console.log(`     extra origins: ${allowedOrigins.join(", ")}`);
  console.log("");
});

process.on("SIGINT", () => {
  console.log("\n  bridge stopped.");
  server.close(() => process.exit(0));
});
